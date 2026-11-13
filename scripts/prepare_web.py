#!/usr/bin/env python3
"""
Підготовка растрів для сайту «Острови тепла українських міст».

Вхід (для кожного міста <id>), експорт з Earth Engine, float32, nodata -9999, сітка UTM 100 м:
  data/raw/web_<id>.tif        — один файл, 5 смуг: dT_day, dT_night, utfvi, ndvi, urban (uhi_multicity.js)
  або data/raw/web_<id>_day.tif (dT_day, utfvi, ndvi, urban) + web_<id>_night.tif (dT_night, n_night)
                                 (uhi_web_export.js). Смуги читаються за назвами.
  data/osm/<id>_osm_bld.tif    — растр будівель OSM (h_mean, h_tagged, f_built, share_tagged, n_bld)
  data/osm/<id>_osm_cls.tif    — частки класів (share_apt, share_priv, share_nonres, share_aux, share_unk)
  Файли OSM необов'язкові: без них у міста немає шару «Тип забудови». Радіус OSM може відрізнятися від
  радіуса Earth Engine (растри зіставляються цілим зсувом на спільній решітці 100 м); комірки поза
  зоною OSM мають код 0 у смузі bld_type.

Вихід:
  web/data/<id>/<шар>.png      — кольоровий растр у Web Mercator (EPSG:3857), прозорий там, де немає даних
  web/data/<id>/values.bin     — значення для кліку: Int16 little-endian, смуги підряд (BSQ), nodata -32768
  web/data/cities.json         — межі, сітка, масштаби смуг і підсумкові показники по забудові міста

Класи й кольори беруться з web/data/layers.json (той самий файл читає сайт).

Запуск:  python scripts/prepare_web.py            (усі міста, для яких є дані)
         python scripts/prepare_web.py kyiv lviv  (окремі міста)
         python scripts/prepare_web.py --synthetic (тест на синтетиці з make_synthetic.py)
Потрібно: pip install rasterio numpy pillow
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import Resampling, calculate_default_transform, reproject, transform_bounds

ROOT = Path(__file__).resolve().parent.parent
RAW, OSM, OUT = ROOT / "data/raw", ROOT / "data/osm", ROOT / "web/data"

CITIES = {  # порядок = порядок у перемикачі на сайті
    "ivano_frankivsk": "Івано-Франківськ",
    "kyiv": "Київ",
    "lviv": "Львів",
    "chernivtsi": "Чернівці",
    "uzhhorod": "Ужгород",
    "dnipro": "Дніпро",
    "kharkiv": "Харків",
}
# Міста, яких немає в статті (додано пізніше) — сайт позначає їх окремо.
LATER = {"dnipro", "kharkiv"}
# Короткі застереження, які сайт показує в картці кварталу й на сторінці порівняння.
CITY_NOTES = {
    "dnipro": "Удень забудова Дніпра в середньому не тепліша за степові поля довкола (ΔT близько 0 °C), "
              "хоча в еталон узято лише ділянки з живою рослинністю (NDVI ≥ 0,3). Уночі острів тепла є. "
              "Гарячі точки всередині міста найкраще видно на шарі UTFVI. Тип забудови (OpenStreetMap) "
              "розраховано в радіусі 16 км від центру, тож на околицях кола аналізу (18 км) його немає.",
    "kharkiv": "Знімки Landsat 2023–2025 бачать пошкоджену й зруйновану забудову, а OpenStreetMap може її "
               "ще не відображати; окремі квартали можуть виглядати не так, як до 2022 року.",
}
EE_BANDS = ["dt_day", "dt_night", "utfvi", "ndvi", "urban"]        # потрібні смуги з Earth Engine
OUT_BANDS = ["dt_day", "dt_night", "utfvi", "ndvi", "bld_type", "urban"]
NODATA_IN, NODATA_OUT = -9999.0, -32768
DOMINANT_MIN = 0.5      # частка площі забудови, з якої клас вважається домінантним; інакше «змішана»
R_EARTH = 6378137.0


def merc_to_lonlat(x, y):
    lon = math.degrees(x / R_EARTH)
    lat = math.degrees(2 * math.atan(math.exp(y / R_EARTH)) - math.pi / 2)
    return [round(lon, 6), round(lat, 6)]


def classify(v, layer):
    """Номер класу (0..n-1) для кожного пікселя; -1 там, де немає даних."""
    out = np.full(v.shape, -1, dtype=np.int16)
    ok = np.isfinite(v)
    if layer["kind"] == "classes":
        out[ok] = np.digitize(v[ok], layer["breaks"], right=False)
    else:
        for i, val in enumerate(layer["values"]):
            out[ok & (v == val)] = i
    return out


def hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def to_png(v, layer, path):
    cls = classify(v, layer)
    rgba = np.zeros(v.shape + (4,), dtype=np.uint8)
    for i, c in enumerate(layer["colors"]):
        m = cls == i
        rgba[m, :3] = hex_rgb(c)
        rgba[m, 3] = 255
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)


def dominant_type(bld_path, cls_path, prof):
    """Тип забудови в сітці Earth Engine (prof): 1..5 = класи з layers.json (bld_type),
    NaN = у комірці немає будівель, 0 = комірка поза зоною завантаження OSM.
    Растр OSM може мати інший радіус, але має лежати на тій самій решітці 100 м тієї ж зони UTM
    (так будують обидва скрипти); тоді він вставляється в сітку Earth Engine цілим зсувом."""
    with rasterio.open(bld_path) as b, rasterio.open(cls_path) as c:
        assert b.transform == c.transform and b.crs == c.crs, "сітки bld і cls не збігаються"
        if b.crs != prof["crs"]:
            raise SystemExit(f"{bld_path.name}: зона UTM {b.crs} не збігається з Earth Engine {prof['crs']}")
        t, res = prof["transform"], prof["transform"].a
        dc, dr = (b.transform.c - t.c) / res, (t.f - b.transform.f) / res
        if abs(dc - round(dc)) > 1e-6 or abs(dr - round(dr)) > 1e-6 or b.transform.a != res:
            raise SystemExit(f"{bld_path.name}: сітка OSM не лежить на решітці Earth Engine (зсув {dc}, {dr} пікселів)")
        dc, dr = int(round(dc)), int(round(dr))
        n_bld = b.read(5, masked=True).filled(0)
        sh = c.read(masked=True).filled(0).astype("float32")     # (5, h, w)
    idx = sh.argmax(axis=0) + 1                                   # 1 apt, 2 priv, 3 nonres, 4 aux, 5 unk
    small = np.where(sh.max(axis=0) >= DOMINANT_MIN, idx, 5).astype("float32")
    small[n_bld <= 0] = np.nan
    H, W = prof["height"], prof["width"]
    out = np.zeros((H, W), dtype="float32")                       # 0 = поза зоною OSM
    h, w = small.shape
    r0, c0 = max(dr, 0), max(dc, 0)                               # перетин у координатах сітки EE
    r1, c1 = min(dr + h, H), min(dc + w, W)
    if r1 > r0 and c1 > c0:
        out[r0:r1, c0:c1] = small[r0 - dr:r1 - dr, c0 - dc:c1 - dc]
    return out


def raw_files(cid):
    one = RAW / f"web_{cid}.tif"
    two = [RAW / f"web_{cid}_day.tif", RAW / f"web_{cid}_night.tif"]
    if one.exists():
        return [one]
    if all(p.exists() for p in two):
        return two
    return None


def same_grid(a, b):
    return a["crs"] == b["crs"] and a["transform"] == b["transform"] and \
        (a["height"], a["width"]) == (b["height"], b["width"])


def load_city(cid):
    """Усі смуги в сітці UTM. Повертає (dict смуга->масив float32 з NaN, профіль, чи є OSM)."""
    bands, prof = {}, None
    for path in raw_files(cid):
        with rasterio.open(path) as s:
            if prof is None:
                prof = s.profile
            elif not same_grid(prof, s.profile):
                raise SystemExit(f"{path.name}: сітка не збігається з іншим файлом міста {cid}")
            names = [(d or "").lower() for d in s.descriptions]
            for i, name in enumerate(names):
                a = s.read(i + 1).astype("float32")
                a[(a <= NODATA_IN + 1) | ~np.isfinite(a)] = np.nan
                bands[name] = a
    missing = [k for k in EE_BANDS if k not in bands]
    if missing:
        raise SystemExit(f"{cid}: у файлах немає смуг {missing} (є: {sorted(bands)})")
    bld, cls = OSM / f"{cid}_osm_bld.tif", OSM / f"{cid}_osm_cls.tif"
    has_osm = bld.exists() and cls.exists()
    if has_osm:
        bands["bld_type"] = dominant_type(bld, cls, prof)
    else:
        bands["bld_type"] = np.full(bands["dt_day"].shape, np.nan, dtype="float32")
    return {k: bands[k] for k in EE_BANDS + ["bld_type"]}, prof, has_osm


def city_stats(b, layers):
    """Підсумок по комірках забудови (urban = 1) — для сторінки порівняння міст."""
    u = b["urban"] == 1
    st = {"n_urban": int(u.sum())}
    for k in ("dt_day", "dt_night", "utfvi", "ndvi"):
        v = b[k][u]
        v = v[np.isfinite(v)]
        st[f"mean_{k}"] = round(float(v.mean()), 4) if v.size else None
        st[f"n_{k}"] = int(v.size)
    for k in ("utfvi", "bld_type"):
        c = classify(b[k][u], layers[k])
        c = c[c >= 0]
        st[f"share_{k}"] = [round(float((c == i).mean()), 4) if c.size else None
                            for i in range(len(layers[k]["colors"]))]
    # середня ΔT за домінантним типом забудови (лише комірки забудови): 1 багатоповерхова, 2 приватна
    for code, key in ((1, "apt"), (2, "priv")):
        m = u & (b["bld_type"] == code)
        for k in ("dt_day", "dt_night"):
            v = b[k][m]
            v = v[np.isfinite(v)]
            st[f"{k}_{key}"] = round(float(v.mean()), 3) if v.size >= 30 else None
        st[f"n_{key}"] = int(m.sum())
    # кореляція Пірсона NDVI ↔ ΔT вдень по комірках забудови
    ok = u & np.isfinite(b["ndvi"]) & np.isfinite(b["dt_day"])
    st["r_ndvi_dt_day"] = round(float(np.corrcoef(b["ndvi"][ok], b["dt_day"][ok])[0, 1]), 3) if ok.sum() > 30 else None
    return st


def warp_3857(bands, prof):
    """Перепроєкція найближчим сусідом (значення не усереднюються) у сітку ~100 м на місцевості."""
    left, bottom, right, top = rasterio.transform.array_bounds(prof["height"], prof["width"], prof["transform"])
    lat_c = transform_bounds(prof["crs"], "EPSG:4326", left, bottom, right, top)
    lat_c = (lat_c[1] + lat_c[3]) / 2
    res = 100.0 / math.cos(math.radians(lat_c))     # 100 м на місцевості в метрах Меркатора
    dst_t, w, h = calculate_default_transform(prof["crs"], "EPSG:3857", prof["width"], prof["height"],
                                              left, bottom, right, top, resolution=res)
    out = {}
    for k, a in bands.items():
        d = np.full((h, w), np.nan, dtype="float32")
        reproject(a, d, src_transform=prof["transform"], src_crs=prof["crs"], src_nodata=np.nan,
                  dst_transform=dst_t, dst_crs="EPSG:3857", dst_nodata=np.nan,
                  resampling=Resampling.nearest)
        out[k] = d
    return out, dst_t, w, h


def scale_of(k, layers):
    return layers[k]["scale"] if k in layers else 1


def process(cid, layers):
    b_utm, prof, has_osm = load_city(cid)
    stats = city_stats(b_utm, layers)
    b, t, w, h = warp_3857(b_utm, prof)
    d = OUT / cid
    d.mkdir(parents=True, exist_ok=True)
    for k in layers:
        if np.isfinite(b[k]).any():
            to_png(b[k], layers[k], d / f"{k}.png")
    # Значення для кліку — в ОРИГІНАЛЬНІЙ сітці UTM (без перепроєкції), щоб збігалися з Earth Engine;
    # перепроєкція потрібна лише картинкам. Браузер переводить lon/lat у UTM через proj4.
    H0, W0 = prof["height"], prof["width"]
    packed = np.empty((len(OUT_BANDS), H0, W0), dtype="<i2")
    for i, k in enumerate(OUT_BANDS):
        v = b_utm[k] * scale_of(k, layers)
        ok = np.isfinite(v)
        q = np.full(v.shape, NODATA_OUT, dtype="<i2")
        q[ok] = np.clip(np.round(v[ok]), -32767, 32767).astype("<i2")
        packed[i] = q
    packed.tofile(d / "values.bin")
    epsg = prof["crs"].to_epsg()
    assert epsg and 32601 <= epsg <= 32660, f"очікую UTM північної півкулі, отримав {prof['crs']}"
    tu = prof["transform"]
    x0, y0, res = t.c, t.f, t.a          # сітка картинок у Web Mercator
    corners = [merc_to_lonlat(x0, y0), merc_to_lonlat(x0 + w * res, y0),
               merc_to_lonlat(x0 + w * res, y0 - h * res), merc_to_lonlat(x0, y0 - h * res)]
    return {
        "id": cid, "name": CITIES[cid],
        "grid": {"crs": f"EPSG:{epsg}", "proj4": f"+proj=utm +zone={epsg - 32600} +datum=WGS84 +units=m +no_defs",
                 "x0": tu.c, "y0": tu.f, "res": tu.a, "width": W0, "height": H0},
        "corners": corners,               # TL, TR, BR, BL у lon/lat — для image-джерела MapLibre
        "bands": OUT_BANDS, "scales": [scale_of(k, layers) for k in OUT_BANDS],
        "nodata": NODATA_OUT,
        "layers": [k for k in layers if (d / f"{k}.png").exists()],
        "stats": stats,
        "osm": has_osm,
        "later": cid in LATER,
        "note": CITY_NOTES.get(cid),
    }


def main():
    layers = json.loads((OUT / "layers.json").read_text(encoding="utf-8"))["layers"]
    args = sys.argv[1:]
    synthetic = "--synthetic" in args          # тест без Earth Engine: дані з data/raw_synth
    if synthetic:
        global RAW
        RAW = ROOT / "data/raw_synth"
        args.remove("--synthetic")
    ids = args or list(CITIES)
    meta_path = OUT / "cities.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {"cities": []}
    by_id = {c["id"]: c for c in meta["cities"]}
    for cid in ids:
        if not raw_files(cid):
            print(f"⚠ {cid}: немає data/raw/web_{cid}.tif (або _day + _night), пропускаю")
            continue
        by_id[cid] = process(cid, layers)
        by_id[cid]["synthetic"] = synthetic     # сайт показує попередження для синтетичних даних
        c = by_id[cid]
        print(f"✓ {cid}: {c['grid']['width']}×{c['grid']['height']}, шари: {', '.join(c['layers'])}"
              + ("" if c["osm"] else " (без OSM)"))
    meta["cities"] = [by_id[c] for c in CITIES if c in by_id]
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
