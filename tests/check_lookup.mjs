import fs from 'fs';
import { cellOf, valuesAt } from '../web/js/grid.js';
import proj4 from './node_modules/proj4/dist/proj4-src.js';
const meta = JSON.parse(fs.readFileSync('web/data/cities.json'));
const pts = JSON.parse(fs.readFileSync('tests/points.json'));
const tol = { dt_day: 0.006, dt_night: 0.006, utfvi: 0.00006, ndvi: 0.0006, bld_type: 0, urban: 0 };
const stat = {};
for (const p of pts) {
  const city = meta.cities.find(c => c.id === p.city);
  const buf = fs.readFileSync(`web/data/${p.city}/values.bin`);
  const data = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const cell = cellOf(proj4, city, p.lon, p.lat);
  const got = cell ? valuesAt(city, data, cell) : null;
  const s = stat[p.city] ??= { n: 0, bad: 0 };
  s.n++;
  const ok = got && Object.keys(tol).every(k => (p.ref[k] === null) === (got[k] === null) &&
                                               (p.ref[k] === null || Math.abs(p.ref[k] - got[k]) <= tol[k]));
  if (!ok) s.bad++;
}
for (const [c, s] of Object.entries(stat)) console.log(c, `розбіжностей ${s.bad} з ${s.n} (${(100*s.bad/s.n).toFixed(1)} %)`);
