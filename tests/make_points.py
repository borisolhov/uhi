# Випадкові точки в межах кожного міста + «еталонні» значення з вихідних растрів у сітці UTM.
import json, sys, numpy as np, rasterio
from rasterio.warp import transform
sys.path.insert(0, 'scripts'); import prepare_web as pw
pw.RAW = pw.ROOT / ('data/raw_synth' if 'synth' in sys.argv else 'data/raw')
if 'synth' in sys.argv: pw.CITIES = {k: v for k, v in pw.CITIES.items() if k not in ('dnipro', 'kharkiv')}
rng = np.random.default_rng(7); out = []
for cid in pw.CITIES:
    b, prof, _ = pw.load_city(cid); t = prof['transform']; H, W = prof['height'], prof['width']
    xs = t.c + rng.uniform(0, W, 400) * t.a; ys = t.f + rng.uniform(0, H, 400) * t.e
    lon, lat = transform(prof['crs'], 'EPSG:4326', xs, ys)
    for x, y, lo, la in zip(xs, ys, lon, lat):
        r, c = int((y - t.f) / t.e), int((x - t.c) / t.a)
        v = {k: (None if not np.isfinite(b[k][r, c]) else float(b[k][r, c])) for k in pw.OUT_BANDS}
        out.append({'city': cid, 'lon': lo, 'lat': la, 'ref': v})
json.dump(out, open('tests/points.json', 'w'))
print(len(out), 'точок')
