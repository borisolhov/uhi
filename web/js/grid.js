// Чисті функції роботи з сіткою міста (без DOM): їх використовують і сайт, і тест у Node.
// Значення зберігаються в оригінальній сітці UTM 100 м (як в Earth Engine), тому для кліку
// lon/lat переводяться в UTM. proj4 передається параметром: у браузері це глобальний proj4
// з CDN, у тесті — пакет npm.

// Номер комірки (рядок, стовпець) або null, якщо точка поза сіткою міста.
export function cellOf(proj4, city, lon, lat) {
  const g = city.grid;
  const [x, y] = proj4('EPSG:4326', g.proj4, [lon, lat]);
  const col = Math.floor((x - g.x0) / g.res);
  const row = Math.floor((g.y0 - y) / g.res);
  if (col < 0 || row < 0 || col >= g.width || row >= g.height) return null;
  return { row, col };
}

// Межі комірки як замкнений полігон у lon/lat (для підсвічування на карті).
export function cellPolygon(proj4, city, cell) {
  const g = city.grid;
  const x0 = g.x0 + cell.col * g.res, y0 = g.y0 - cell.row * g.res;
  const pts = [[x0, y0], [x0 + g.res, y0], [x0 + g.res, y0 - g.res], [x0, y0 - g.res], [x0, y0]];
  return pts.map(p => proj4(g.proj4, 'EPSG:4326', p));
}

// Значення всіх смуг у комірці: {dt_day: 3.12, dt_night: null, ...}
export function valuesAt(city, data, cell) {
  const g = city.grid, n = g.width * g.height, i = cell.row * g.width + cell.col;
  const out = {};
  city.bands.forEach((b, k) => {
    const v = data[k * n + i];
    out[b] = v === city.nodata ? null : v / city.scales[k];
  });
  return out;
}

// Номер класу значення за описом шару з layers.json (той самий принцип, що в prepare_web.py).
export function classIndex(layer, v) {
  if (v === null || v === undefined) return -1;
  if (layer.kind === 'categories') return layer.values.indexOf(Math.round(v));
  let i = 0;
  while (i < layer.breaks.length && v >= layer.breaks[i]) i++;
  return i;
}

// Число українською: кома як десятковий роздільник, справжній мінус.
export function fmt(v, decimals) {
  const s = Math.abs(v).toFixed(decimals).replace('.', ',');
  return (v < 0 && Number(s.replace(',', '.')) !== 0 ? '−' : '') + s;
}
