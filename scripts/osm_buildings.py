#!/usr/bin/env python3
"""
Актуальні будівлі OpenStreetMap -> растр для Google Earth Engine.

Для кожного міста:
  1. завантажує будівлі з Overpass API тайлами (актуальний стан OSM на момент запуску);
  2. визначає висоту: тег height -> building:levels x 3 м -> типове значення за видом будівлі;
  3. розраховує на сітці 100 м (UTM) шари, сумісні з індексом K = H * f з GEE-скрипту:
       h_mean        середня висота будівель у комірці (зважена за площею), м
       h_tagged      те саме, але лише за будівлями з явною висотою/поверховістю (-9999, якщо таких немає)
       f_built       частка площі комірки, зайнята контурами будівель (0..1)
       share_tagged  частка площі будівель, для яких висота відома з тегів (0..1)
       n_bld         кількість будівель (за центроїдом)
  4. зберігає GeoTIFF + JSON із датою знімка OSM, кількістю будівель і часткою тегів.

Запуск (потрібен інтернет, Python 3.9+):
  pip install requests numpy shapely pyproj rasterio
  python osm_buildings.py --city lviv --out out/
  python osm_buildings.py --city all  --out out/
  python osm_buildings.py --demo      --out demo/      # офлайн-перевірка логіки

Увага: це оцінка. Повнота OSM різна по містах; висоти відомі не для всіх будівель.
Завжди дивіться share_tagged і метадані (JSON) і наводьте їх у статті.
"""
import argparse
import json
import math
import re
import sys
import time
import datetime
from pathlib import Path

import numpy as np
import requests
from pyproj import Transformer
from shapely.geometry import LineString, Polygon, box
from shapely.ops import polygonize, unary_union

# ---------------------------------------------------------------- міста
CITIES = {  # id: (назва, lon, lat, радіус км) -- як у uhi_multicity.js
    "ivano_frankivsk": ("Івано-Франківськ", 24.7111, 48.9215, 10),
    "kyiv": ("Київ", 30.5234, 50.4501, 22),
    "lviv": ("Львів", 24.0316, 49.8397, 13),
    "odesa": ("Одеса", 30.7233, 46.4825, 16),
    "chernivtsi": ("Чернівці", 25.9358, 48.2921, 9),
    "uzhhorod": ("Ужгород", 22.2879, 48.6208, 8),
    "dnipro": ("Дніпро", 35.0462, 48.4647, 16),
    "kharkiv": ("Харків", 36.2304, 49.9935, 17),
}

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# ----------------------------------------------- припущення щодо висот
M_PER_LEVEL = 3.0
# Типова висота (м) для будівель без тегів висоти/поверховості. Це ПРИПУЩЕННЯ:
# змінюйте й проводьте аналіз чутливості (див. share_tagged та шар h_tagged).
DEFAULT_H = {
    "house": 5, "detached": 5, "semidetached_house": 5, "terrace": 6, "bungalow": 4,
    "cabin": 4, "farm": 5, "residential": 6, "static_caravan": 3,
    "apartments": 15, "dormitory": 15, "hotel": 12,
    "garage": 3, "garages": 3, "shed": 3, "carport": 3, "roof": 3, "kiosk": 3,
    "hut": 3, "greenhouse": 3, "service": 3, "barn": 5, "stable": 4,
    "industrial": 8, "warehouse": 8, "commercial": 9, "retail": 8, "office": 15,
    "school": 12, "kindergarten": 8, "university": 15, "hospital": 15, "church": 10,
    "yes": 6,
}
FALLBACK_H = 6.0
NODATA = -9999.0


def parse_height(tags):
    """Повертає (висота_м, явна?) для будівлі."""
    h = tags.get("height") or tags.get("building:height")
    if h:
        m = re.match(r"^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m|м|ft|')?\s*$", h.strip().lower())
        if m:
            v = float(m.group(1).replace(",", "."))
            if m.group(2) in ("ft", "'"):
                v *= 0.3048
            if 1.0 <= v <= 500:
                return v, True
    lv = tags.get("building:levels")
    if lv:
        m = re.match(r"^\s*([0-9]+(?:[.,][0-9]+)?)", lv)
        if m:
            n = float(m.group(1).replace(",", "."))
            if 0.5 <= n <= 150:
                return max(n, 1.0) * M_PER_LEVEL, True
    return float(DEFAULT_H.get(tags.get("building", "yes"), FALLBACK_H)), False


# ------------------------------------------- клас будівлі (для стратифікації)
# Класи: apt (багатоповерхівки), priv (приватний сектор), nonres (нежитлові: промисловість,
# комерція, громадські), aux (гаражі, сараї, навіси), unk (building=yes без ознак).
# Це ЕВРИСТИКА за тегами й розміром контуру, а не офіційна класифікація:
# для building=yes клас визначається лише за поверховістю/висотою та площею.
CLS_NAMES = ["apt", "priv", "nonres", "aux", "unk"]
CLS_APT = {"apartments", "dormitory"}
CLS_PRIV = {"house", "detached", "semidetached_house", "terrace", "bungalow", "cabin",
            "farm", "residential"}
CLS_NONRES = {"industrial", "warehouse", "commercial", "retail", "office", "school",
              "kindergarten", "university", "college", "hospital", "church", "cathedral",
              "chapel", "religious", "hotel", "public", "civic", "government", "supermarket",
              "manufacture", "train_station", "transportation", "fire_station", "hangar",
              "museum", "sports_hall", "stadium"}
CLS_AUX = {"garage", "garages", "shed", "carport", "roof", "kiosk", "hut", "greenhouse",
           "service", "barn", "stable", "static_caravan", "outbuilding"}


def _levels(tags):
    lv = tags.get("building:levels")
    if lv:
        m = re.match(r"^\s*([0-9]+(?:[.,][0-9]+)?)", lv)
        if m:
            return float(m.group(1).replace(",", "."))
    return None


def classify(tags, area):
    """Повертає клас будівлі з CLS_NAMES (area — площа контуру, м2)."""
    b = tags.get("building", "yes")
    if b in CLS_AUX:
        return "aux"
    if b in CLS_NONRES:
        return "nonres"
    h, tagged = parse_height(tags)
    lv = _levels(tags)
    if b in CLS_APT or (lv is not None and lv >= 5) or (tagged and h >= 15):
        return "apt"
    if b in CLS_PRIV:
        return "priv"
    if b == "yes":
        if area < 40:
            return "aux"
        if area < 300 and (not tagged or h < 9):
            return "priv"
    return "unk"


# ------------------------------------------------------- завантаження
def utm_epsg(lon, lat):
    return (32600 if lat >= 0 else 32700) + int((lon + 180) // 6) + 1


def tiles_for(lon, lat, r_km, tile_km):
    """Розбиває квадрат навколо міста на тайли (bbox у градусах)."""
    dlat = r_km / 111.32
    dlon = r_km / (111.32 * math.cos(math.radians(lat)))
    s, n, w, e = lat - dlat, lat + dlat, lon - dlon, lon + dlon
    k = max(1, math.ceil(2 * r_km / tile_km))
    out = []
    for i in range(k):
        for j in range(k):
            out.append((s + (n - s) * i / k, w + (e - w) * j / k,
                        s + (n - s) * (i + 1) / k, w + (e - w) * (j + 1) / k))
    return out


def overpass(query, mirrors, retries=4, timeout=900, max_age_days=3):
    last = None
    for attempt in range(retries):
        for url in mirrors:
            try:
                r = requests.post(url, data={"data": query}, timeout=timeout,
                                  headers={"User-Agent": "uhi-ukraine-research/0.1 (student project)"})
                if r.status_code == 200:
                    data = r.json()
                    ts = data.get("osm3s", {}).get("timestamp_osm_base")
                    if ts and max_age_days is not None:
                        age = (datetime.datetime.now(datetime.timezone.utc) -
                               datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(
                                   tzinfo=datetime.timezone.utc)).days
                        if age > max_age_days:  # дзеркало відстає — пробуємо наступне
                            last = f"{url}: застарілий знімок OSM ({ts}, {age} дн.)"
                            print("  ! " + last)
                            time.sleep(2)
                            continue
                    return data
                last = f"{url}: HTTP {r.status_code}"
            except Exception as ex:  # мережеві помилки, таймаути
                last = f"{url}: {ex}"
            time.sleep(5)
        time.sleep(20 * (attempt + 1))
    raise RuntimeError(f"Overpass недоступний: {last}")


def fetch_buildings(lon, lat, r_km, tile_km=8.0, mirrors=MIRRORS):
    """Повертає (dict id -> element, мітка часу OSM)."""
    elements, stamp = {}, None
    tl = tiles_for(lon, lat, r_km, tile_km)
    for k, (s, w, n, e) in enumerate(tl, 1):
        q = (f'[out:json][timeout:600];'
             f'(way["building"]["building"!="no"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});'
             f'relation["building"]["building"!="no"]({s:.6f},{w:.6f},{n:.6f},{e:.6f}););'
             f'out geom tags;')
        data = overpass(q, mirrors)
        stamp = stamp or data.get("osm3s", {}).get("timestamp_osm_base")
        for el in data.get("elements", []):
            elements[(el["type"], el["id"])] = el
        print(f"  тайл {k}/{len(tl)}: {len(elements)} об'єктів", flush=True)
        time.sleep(2)  # ввічливість до публічного сервера
    return elements, stamp


# ---------------------------------------------------------- геометрія
def element_polygon(el):
    """Контур будівлі в lon/lat як shapely-геометрія (або None)."""
    if el["type"] == "way":
        g = el.get("geometry") or []
        if len(g) < 4:
            return None
        poly = Polygon([(p["lon"], p["lat"]) for p in g])
        return poly if poly.is_valid and poly.area > 0 else poly.buffer(0)
    outer, inner = [], []
    for m in el.get("members", []):
        g = m.get("geometry") or []
        if len(g) < 2:
            continue
        (outer if m.get("role") == "outer" else inner if m.get("role") == "inner" else []).append(
            LineString([(p["lon"], p["lat"]) for p in g]))
    if not outer:
        return None
    shell = unary_union(list(polygonize(unary_union(outer))))
    if shell.is_empty:
        return None
    if inner:
        holes = unary_union(list(polygonize(unary_union(inner))))
        if not holes.is_empty:
            shell = shell.difference(holes)
    return shell


def rasterize(elements, lon, lat, r_km, cell=100.0):
    """Будує шари на сітці cell м у UTM. Повертає (масиви, transform-параметри, epsg, статистика)."""
    epsg = utm_epsg(lon, lat)
    to_utm = Transformer.from_crs(4326, epsg, always_xy=True)
    cx, cy = to_utm.transform(lon, lat)
    half = r_km * 1000.0
    x0 = math.floor((cx - half) / cell) * cell
    y1 = math.ceil((cy + half) / cell) * cell
    nx = int(round(2 * half / cell)) + 1
    ny = nx
    area_all = np.zeros((ny, nx))
    area_hw = np.zeros((ny, nx))       # sum(area * h) для всіх
    area_tag = np.zeros((ny, nx))      # площа будівель із явною висотою
    area_tag_hw = np.zeros((ny, nx))   # sum(area * h) лише для явних
    nb = np.zeros((ny, nx))
    area_cls = {k: np.zeros((ny, nx)) for k in CLS_NAMES}
    n_cls = {k: 0 for k in CLS_NAMES}
    area_cls_total = {k: 0.0 for k in CLS_NAMES}
    n_total = n_tag = 0
    area_total = area_tagged_total = 0.0

    for el in elements.values():
        poly = element_polygon(el)
        if poly is None or poly.is_empty:
            continue
        # проєкція координат у UTM
        from shapely.ops import transform as shp_transform
        pu = shp_transform(lambda x, y, z=None: to_utm.transform(x, y), poly)
        if not pu.is_valid:
            pu = pu.buffer(0)
        a = pu.area
        if a < 5 or a > 5e6:   # відсікаємо сміття і помилкові гігантські контури
            continue
        h, tagged = parse_height(el.get("tags", {}))
        cls = classify(el.get("tags", {}), a)
        n_cls[cls] += 1
        area_cls_total[cls] += a
        n_total += 1
        area_total += a
        if tagged:
            n_tag += 1
            area_tagged_total += a
        minx, miny, maxx, maxy = pu.bounds
        c0, c1 = int((minx - x0) // cell), int((maxx - x0) // cell)
        r0, r1 = int((y1 - maxy) // cell), int((y1 - miny) // cell)
        parts = []
        if c0 == c1 and r0 == r1:
            parts.append((r0, c0, a))
        else:
            for rr in range(r0, r1 + 1):
                for cc in range(c0, c1 + 1):
                    cellbox = box(x0 + cc * cell, y1 - (rr + 1) * cell,
                                  x0 + (cc + 1) * cell, y1 - rr * cell)
                    ia = pu.intersection(cellbox).area
                    if ia > 0:
                        parts.append((rr, cc, ia))
        for rr, cc, ia in parts:
            if 0 <= rr < ny and 0 <= cc < nx:
                area_all[rr, cc] += ia
                area_hw[rr, cc] += ia * h
                area_cls[cls][rr, cc] += ia
                if tagged:
                    area_tag[rr, cc] += ia
                    area_tag_hw[rr, cc] += ia * h
        ccx, ccy = pu.centroid.x, pu.centroid.y
        rc, cc2 = int((y1 - ccy) // cell), int((ccx - x0) // cell)
        if 0 <= rc < ny and 0 <= cc2 < nx:
            nb[rc, cc2] += 1

    with np.errstate(invalid="ignore", divide="ignore"):
        h_mean = np.where(area_all > 0, area_hw / area_all, 0.0)
        h_tagged = np.where(area_tag > 0, area_tag_hw / area_tag, NODATA)
        share_tag = np.where(area_all > 0, area_tag / area_all, 0.0)
    f_built = np.clip(area_all / (cell * cell), 0, 1)
    bands = {"h_mean": h_mean, "h_tagged": h_tagged, "f_built": f_built,
             "share_tagged": share_tag, "n_bld": nb}
    with np.errstate(invalid="ignore", divide="ignore"):
        cls_bands = {f"share_{k}": np.where(area_all > 0, area_cls[k] / area_all, 0.0)
                     for k in CLS_NAMES}
    stats = {"n_buildings": n_total, "n_with_height_tags": n_tag,
             "share_buildings_tagged": round(n_tag / n_total, 4) if n_total else 0,
             "share_area_tagged": round(area_tagged_total / area_total, 4) if area_total else 0,
             "total_footprint_km2": round(area_total / 1e6, 3),
             "classes_n_buildings": n_cls,
             "classes_share_area": {k: round(area_cls_total[k] / area_total, 4) if area_total else 0
                                    for k in CLS_NAMES}}
    return bands, (x0, y1, cell, nx, ny), epsg, stats, cls_bands


def write_tif(path, bands, grid, epsg):
    import rasterio
    from rasterio.transform import from_origin
    x0, y1, cell, nx, ny = grid
    names = list(bands)
    with rasterio.open(path, "w", driver="GTiff", height=ny, width=nx, count=len(names),
                       dtype="float32", crs=f"EPSG:{epsg}", transform=from_origin(x0, y1, cell, cell),
                       nodata=NODATA, compress="deflate") as dst:
        for i, n in enumerate(names, 1):
            dst.write(bands[n].astype("float32"), i)
            dst.set_band_description(i, n)


# --------------------------------------------------------------- demo
def demo_elements(lon, lat):
    """Синтетичні будівлі в Overpass-форматі для офлайн-перевірки."""
    dx = 1 / (111320 * math.cos(math.radians(lat)))
    dy = 1 / 110540

    def rect(x, y, w, h):  # метри від центру
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
        return [{"lon": lon + px * dx, "lat": lat + py * dy} for px, py in pts]

    els, i = {}, 0
    for gx in range(-400, 400, 40):
        for gy in range(-400, 400, 40):
            i += 1
            tags = {"building": "apartments", "building:levels": "9"} if abs(gx) < 150 else {"building": "house"}
            els[("way", i)] = {"type": "way", "id": i, "tags": tags, "geometry": rect(gx, gy, 20, 15)}
    els[("way", 9001)] = {"type": "way", "id": 9001, "tags": {"building": "commercial", "height": "12 m"},
                           "geometry": rect(-50, -50, 180, 60)}      # велика споруда, перетинає кілька комірок
    return els


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--city", default="all", help="id міста (напр. lviv) або all")
    ap.add_argument("--out", default="out", help="папка для результатів")
    ap.add_argument("--cell", type=float, default=100.0, help="розмір комірки, м")
    ap.add_argument("--tile-km", type=float, default=8.0, help="розмір тайла Overpass, км")
    ap.add_argument("--demo", action="store_true", help="офлайн-тест на синтетичних даних")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    ids = list(CITIES) if a.city == "all" else [a.city]
    if a.demo:
        ids = ["ivano_frankivsk"]
    for cid in ids:
        if cid not in CITIES:
            sys.exit(f"Невідоме місто: {cid}. Доступні: {', '.join(CITIES)}")
        name, lon, lat, r = CITIES[cid]
        if a.demo:
            print(f"[DEMO] {name}")
            els, stamp, r = demo_elements(lon, lat), "demo", 1.0
        else:
            print(f"{name}: завантаження OSM...")
            els, stamp = fetch_buildings(lon, lat, r, a.tile_km)
        bands, grid, epsg, stats, cls_bands = rasterize(els, lon, lat, r, a.cell)
        tif = out / f"{cid}_osm_bld.tif"
        write_tif(tif, bands, grid, epsg)
        write_tif(out / f"{cid}_osm_cls.tif", cls_bands, grid, epsg)   # частки класів будівель
        meta = {"city": name, "id": cid, "osm_snapshot_utc": stamp,
                "downloaded_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "cell_m": a.cell, "crs": f"EPSG:{epsg}", "radius_km": r,
                "m_per_level": M_PER_LEVEL, "default_heights_m": DEFAULT_H,
                "fallback_height_m": FALLBACK_H, **stats}
        (out / f"{cid}_osm_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
        print(f"  -> {tif.name}; будівель: {stats['n_buildings']}, "
              f"із тегами висоти: {stats['share_buildings_tagged']:.1%}")


if __name__ == "__main__":
    main()
