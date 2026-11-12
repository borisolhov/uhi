#!/usr/bin/env python3
"""
СИНТЕТИЧНІ дані для тесту сайту, поки немає експорту з Earth Engine.
Бере справжні сітки й забудову OSM (data/osm/<id>_osm_bld.tif) і вигадує правдоподібні
ΔT, UTFVI, NDVI: що щільніша забудова — то тепліше й менше зелені, плюс шум.
Це НЕ результати дослідження. Пише data/raw_synth/web_<id>.tif у форматі експорту з Earth Engine.
"""
from pathlib import Path

import numpy as np
import rasterio
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parent.parent
OSM, OUT = ROOT / "data/osm", ROOT / "data/raw_synth"
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(1)

for bld in sorted(OSM.glob("*_osm_bld.tif")):
    cid = bld.name.replace("_osm_bld.tif", "")
    with rasterio.open(bld) as s:
        prof = s.profile
        f = s.read(3, masked=True).filled(0).astype("float32")
        h = s.read(1, masked=True).filled(0).astype("float32")
    H, W = f.shape
    yy, xx = np.mgrid[0:H, 0:W]
    inside = (xx - W / 2 + 0.5) ** 2 + (yy - H / 2 + 0.5) ** 2 <= (W / 2) ** 2   # коло аналізу
    dens = gaussian_filter(f, 2)                                   # «щільність забудови» кварталу
    ndvi = np.clip(0.72 - 1.6 * dens - 0.4 * f + rng.normal(0, 0.05, f.shape), -0.1, 0.85)
    dt_day = -1.0 + 14 * dens + 3 * f - 4 * (ndvi - 0.4) + rng.normal(0, 0.5, f.shape)
    dt_night = 0.2 + 5 * dens + 0.02 * h + rng.normal(0, 0.25, f.shape)
    gaps = gaussian_filter(rng.random(f.shape), 4) < 0.47            # плями «мало нічних кадрів»
    dt_night[gaps] = np.nan
    lst_k = 300.0 + dt_day
    urban = (dens > 0.06).astype("float32")
    utfvi = (lst_k - lst_k[urban == 1].mean()) / lst_k[urban == 1].mean()
    stack = np.stack([dt_day, dt_night, utfvi, ndvi, urban]).astype("float32")
    stack[:, ~inside] = np.nan
    stack[~np.isfinite(stack)] = -9999
    prof.update(count=5, dtype="float32", nodata=-9999, compress="deflate")
    with rasterio.open(OUT / f"web_{cid}.tif", "w", **prof) as d:
        d.write(stack)
        d.descriptions = ("dT_day", "dT_night", "utfvi", "ndvi", "urban")
    print(f"синтетика {cid}: {W}×{H}")
