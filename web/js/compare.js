import { fmt } from './grid.js';

const [meta, cfg] = await Promise.all([
  fetch('data/cities.json').then(r => r.json()),
  fetch('data/layers.json').then(r => r.json())
]);
const L = cfg.layers;
const NS = 'http://www.w3.org/2000/svg';
// кольори перевірено на розрізнення при порушеннях колірного зору (dataviz validate_palette)
const C = { day: '#e0763a', night: '#6a4fa3', apt: L.bld_type.colors[0], priv: L.bld_type.colors[1] };
// note — застереження для міста
// dayOk = false: денну ΔT міста не можна порівнювати з іншими (еталон гарячий) — сортується в кінець
const cities = meta.cities.map(c => {
  const a = c.article || {}, s = c.stats, ap = a.apt_minus_priv;
  return { id: c.id, name: c.name, plain: c.name, note: c.note, dayOk: c.dt_day_comparable !== false, ...s,
    mean_dt_day: a.dT_day ?? s.mean_dt_day, mean_dt_night: a.dT_night_ecostress ?? s.mean_dt_night,
    mean_ndvi: a.mean_ndvi ?? s.mean_ndvi, r_ndvi: a.r_ndvi_lst ?? s.r_ndvi_dt_day,
    utfvi_bad: a.share_utfvi_bad_pct ?? 100 * s.share_utfvi.slice(3).reduce((x, y) => x + y, 0),
    ref: a.rural_ref_lst_c, scenes: a.landsat_scenes, frames: a.ecostress_frames_median,
    diff: ap ? { day: ap.day, dayCI: ap.day_ci, night: ap.night, nightCI: ap.night_ci, nA: ap.n_apt, nP: ap.n_priv }
             : (s.dt_day_apt != null ? { day: s.dt_day_apt - s.dt_day_priv, night: s.dt_night_apt - s.dt_night_priv } : null) };
})
  .sort((a, b) => (b.dayOk - a.dayOk) || (b.mean_dt_day - a.mean_dt_day));
const withType = cities.filter(c => c.diff);

const tip = document.getElementById('tip');
const signed = (v, d = 1) => v == null ? '—' : (v > 0 ? '+' : '') + fmt(v, d);
const pct = v => fmt(v * 100, 0) + ' %';

// ---------- Підказка ----------
function hover(node, html) {
  node.addEventListener('mouseenter', () => { tip.innerHTML = html; tip.classList.add('on'); });
  node.addEventListener('mousemove', e => {
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
    tip.style.left = x + 'px'; tip.style.top = (e.clientY + 14) + 'px';
  });
  node.addEventListener('mouseleave', () => tip.classList.remove('on'));
}

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}
function text(parent, x, y, s, attrs = {}) {
  const t = svgEl('text', { x, y, ...attrs }, parent);
  t.textContent = s;
  return t;
}
// смуга з округленим кінцем 4px і прямим кутом біля базової лінії
function bar(parent, x0, x1, y, h, fill) {
  const w = Math.max(x1 - x0, 0), r = Math.min(4, w / 2, h / 2);
  const d = `M${x0},${y}H${x0 + w - r}a${r},${r} 0 0 1 ${r},${r}V${y + h - r}a${r},${r} 0 0 1 ${-r},${r}H${x0}Z`;
  return svgEl('path', { d, fill, class: 'mark' }, parent);
}
// смуга вліво від нуля (від'ємне значення): округлений лівий кінець
function barLeft(parent, x0, x1, y, h, fill) {
  const w = Math.max(x1 - x0, 0), r = Math.min(4, w / 2, h / 2);
  const d = `M${x1},${y}H${x0 + r}a${r},${r} 0 0 0 ${-r},${r}V${y + h - r}a${r},${r} 0 0 0 ${r},${r}H${x1}Z`;
  return svgEl('path', { d, fill, class: 'mark' }, parent);
}
function niceMax(v) { return Math.ceil(v + 0.25); }
function niceMin(v) { return Math.min(0, Math.floor(v - 0.25)); }
const num = (v, d) => v == null ? '—' : fmt(v, d);
function legend(id, items) {
  document.getElementById(id).innerHTML = items.map(([c, t, dot]) =>
    `<span class="k"><span class="${dot ? 'dot' : 'sw'}" style="background:${c}"></span>${t}</span>`).join('');
}

// ---------- Головні цифри ----------
function headline() {
  const byDay = cities.filter(c => c.dayOk)[0];
  const byNight = [...cities].sort((a, b) => b.mean_dt_night - a.mean_dt_night)[0];
  const diffs = withType.map(c => c.diff.day);
  const allSig = withType.every(c => c.diff.dayCI && c.diff.dayCI[0] > 0);
  const tiles = [
    ['Найсильніший денний острів', `${signed(byDay.mean_dt_day)} °C`, byDay.plain],
    ['Найменше охолодження вночі', `${signed(byNight.mean_dt_night)} °C`, byNight.plain],
    ['Багатоповерхівки тепліші за приватний сектор', `${fmt(Math.min(...diffs), 1)}–${fmt(Math.max(...diffs), 1)} °C`,
     `удень, у ${withType.length} містах${allSig ? '; 95 % довірчий інтервал скрізь вищий за нуль' : ''}`]
  ];
  document.getElementById('headline').innerHTML = tiles.map(([l, v, s]) =>
    `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
}

// ---------- 1. ΔT удень і вночі ----------
function chartDT() {
  const svg = document.getElementById('ch-dt');
  svg.innerHTML = svg.querySelector('title').outerHTML;
  const W = svg.clientWidth || 800, labW = W < 480 ? 122 : 136, padR = 44;
  const bh = 12, gap = 4, rowH = bh * 2 + gap + 18, top = 6, H = top + cities.length * rowH + 22;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
  const defs = svgEl('defs', {}, svg), pat = svgEl('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  svgEl('rect', { width: 6, height: 6, fill: '#e8e2d8' }, pat);
  svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#b9b0a3', 'stroke-width': 2 }, pat);
  const max = niceMax(Math.max(...cities.map(c => Math.max(c.mean_dt_day, c.mean_dt_night))));
  const min = niceMin(Math.min(...cities.map(c => Math.min(c.mean_dt_day, c.mean_dt_night))));
  const x = v => labW + (W - labW - padR) * (v - min) / (max - min);
  const g = svgEl('g', { class: 'grid' }, svg), ax = svgEl('g', { class: 'axis' }, svg);
  for (let t = min; t <= max; t++) {
    svgEl('line', { x1: x(t), x2: x(t), y1: top, y2: H - 20 }, g);
    text(ax, x(t), H - 6, fmt(t, 0), { 'text-anchor': 'middle', class: 'tick' });
  }
  cities.forEach((c, i) => {
    const y = top + i * rowH + 4;
    text(svg, 0, y + bh + 4, c.name, { 'dominant-baseline': 'middle', 'font-weight': 600 });
    [['day', c.mean_dt_day, 'удень'], ['night', c.mean_dt_night, 'уночі']].forEach(([k, v, lab], j) => {
      const yy = y + j * (bh + gap);
      const off = k === 'day' && !c.dayOk;          // непорівнянна денна ΔT: сіра смуга з поясненням
      const fill = off ? 'url(#hatch)' : C[k];
      const m = v >= 0 ? bar(svg, x(0), x(v), yy, bh, fill) : barLeft(svg, x(v), x(0), yy, bh, fill);
      const lbl = signed(v) + (off ? '  не порівнюється' : '');
      text(svg, v >= 0 ? x(v) + 6 : x(v) - 6, yy + bh / 2 + 1, lbl,
           { 'dominant-baseline': 'middle', class: 'val', 'text-anchor': v >= 0 ? 'start' : 'end', ...(off ? { fill: '#6b655c' } : {}) });
      hover(m, `<b>${c.plain}</b>, ${lab}<br>ΔT ${signed(v, 2)} °C` +
               (off ? '<br>Заміський еталон такий самий гарячий, як забудова, — з іншими містами не порівнювати.' : ''));
    });
  });
  svgEl('line', { x1: x(0), x2: x(0), y1: top, y2: H - 20, class: 'base' }, svg);
}

// ---------- 2. Класи UTFVI (сегментовані смуги) ----------
function lum(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function chartUTFVI() {
  const U = L.utfvi, box = document.getElementById('ch-utfvi');
  box.innerHTML = '';
  for (const c of cities) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:var(--lw,136px) 1fr;align-items:center;gap:0;margin:8px 0';
    row.innerHTML = `<span style="font-weight:600">${c.name}</span>`;
    const barEl = document.createElement('div');
    barEl.style.cssText = 'display:flex;gap:2px;height:28px';
    barEl.setAttribute('role', 'img');
    barEl.setAttribute('aria-label', `${c.name}: ` + U.classnames.map((n, i) => `${n} ${pct(c.share_utfvi[i])}`).join(', '));
    c.share_utfvi.forEach((s, i) => {
      if (!s) return;
      const seg = document.createElement('div');
      const fill = U.colors[i];
      seg.style.cssText = `flex:${s} 1 0;min-width:0;background:${fill};border-radius:4px;display:flex;align-items:center;padding-left:6px;font-size:11.5px;color:${lum(fill) > 0.35 ? '#1f1d1a' : '#fff'};white-space:nowrap;overflow:visible`;
      seg.dataset.share = s;
      hover(seg, `<b>${c.name}</b><br>клас «${U.classnames[i]}» (UTFVI ${U.labels[i]})<br>${pct(s)} кварталів забудови`);
      barEl.append(seg);
    });
    row.append(barEl);
    box.append(row);
  }
  // підпис усередині лише там, де він вміщується з запасом
  requestAnimationFrame(() => box.querySelectorAll('[data-share]').forEach(seg => {
    const label = pct(+seg.dataset.share);
    if (seg.clientWidth >= label.length * 7 + 12) seg.textContent = label;
  }));
  box.style.setProperty('--lw', innerWidth < 480 ? '104px' : '136px');
}

// ---------- 3. Різниця «багатоповерхівки − приватний сектор» з 95 % ДІ ----------
function chartType() {
  const svg = document.getElementById('ch-type');
  svg.innerHTML = svg.querySelector('title').outerHTML;
  const W = svg.clientWidth || 800, labW = W < 480 ? 122 : 136, padR = 56;
  const gap = 14, rowH = 2 * gap + 18, top = 6, rows = withType, H = top + rows.length * rowH + 22;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
  const hi = Math.max(...rows.flatMap(c => [c.diff.dayCI?.[1] ?? c.diff.day, c.diff.nightCI?.[1] ?? c.diff.night]));
  const lo = Math.min(0, ...rows.flatMap(c => [c.diff.dayCI?.[0] ?? c.diff.day, c.diff.nightCI?.[0] ?? c.diff.night]));
  const max = niceMax(hi), min = lo < 0 ? niceMin(lo) : 0;
  const x = v => labW + (W - labW - padR) * (v - min) / (max - min);
  const g = svgEl('g', { class: 'grid' }, svg), ax = svgEl('g', { class: 'axis' }, svg);
  for (let t = min; t <= max; t++) {
    svgEl('line', { x1: x(t), x2: x(t), y1: top, y2: H - 20 }, g);
    text(ax, x(t), H - 6, fmt(t, 0), { 'text-anchor': 'middle', class: 'tick' });
  }
  svgEl('line', { x1: x(0), x2: x(0), y1: top, y2: H - 20, class: 'base' }, svg);
  rows.forEach((c, i) => {
    const y = top + i * rowH + 8;
    text(svg, 0, y + gap / 2, c.name, { 'dominant-baseline': 'middle', 'font-weight': 600 });
    [['day', 'удень'], ['night', 'уночі']].forEach(([k, lab], j) => {
      const yy = y + j * gap, v = c.diff[k], ci = c.diff[k + 'CI'];
      if (ci) svgEl('line', { x1: x(ci[0]), x2: x(ci[1]), y1: yy, y2: yy, stroke: C[k], 'stroke-width': 2, 'stroke-linecap': 'round', opacity: .55 }, svg);
      svgEl('circle', { cx: x(v), cy: yy, r: 5, fill: C[k], stroke: '#fffdf9', 'stroke-width': 2 }, svg);
      text(svg, x(ci ? ci[1] : v) + 8, yy + 1, `+${fmt(v, 1)}`, { 'dominant-baseline': 'middle', class: 'val' });
      const hit = svgEl('rect', { x: x(ci ? ci[0] : v) - 8, y: yy - 7, width: Math.max(16, x(ci ? ci[1] : v) - x(ci ? ci[0] : v) + 16), height: 14, fill: 'transparent' }, svg);
      hover(hit, `<b>${c.plain}</b>, ${lab}<br>багатоповерхівки тепліші на ${fmt(v, 2)} °C` +
                 (ci ? `<br>95 % ДІ: ${fmt(ci[0], 2)}…${fmt(ci[1], 2)} °C` : '') +
                 (c.diff.nA ? `<br>${c.diff.nA} і ${c.diff.nP} кварталів у вибірці` : ''));
    });
  });
}

// ---------- 4. NDVI ----------
function ndvi() {
  document.getElementById('ndvi').innerHTML = cities.map(c =>
    `<div class="stat"><div class="l">${c.name}</div><div class="v">r = ${fmt(c.r_ndvi, 2)}</div><div class="s">NDVI сер. ${fmt(c.mean_ndvi, 2)}</div></div>`).join('');
}

// ---------- Таблиця ----------
function table() {
  const ci = v => v ? ` <span class="ci">[${fmt(v[0], 2)}; ${fmt(v[1], 2)}]</span>` : '';
  document.querySelector('#tbl tbody').innerHTML = cities.map(c => `<tr>
    <td>${c.name}</td>
    <td>${signed(c.mean_dt_day, 2)}${c.dayOk ? '' : ' <span class="ci">не порівн.</span>'}</td><td>${signed(c.mean_dt_night, 2)}</td>
    <td>${num(c.ref, 1)}</td><td>${c.scenes ?? '—'}</td><td>${c.frames ?? '—'}</td>
    <td>${fmt(c.utfvi_bad, 1)}</td><td>${num(c.mean_ndvi, 2)}</td>
    <td>${c.diff ? '+' + fmt(c.diff.day, 2) + ci(c.diff.dayCI) : '—'}</td>
    <td>${c.diff ? '+' + fmt(c.diff.night, 2) + ci(c.diff.nightCI) : '—'}</td>
    <td>${num(c.r_ndvi, 2)}</td></tr>`).join('');
}

// ---------- Застереження по містах ----------
function notes() {
  const items = [];
  for (const c of cities.filter(c => c.note)) items.push(`<li><b>${c.plain}.</b> ${c.note}</li>`);
  const box = document.getElementById('notes');
  box.innerHTML = items.join('');
  box.hidden = !items.length;
}

legend('lg-dt', [[C.day, 'Удень'], [C.night, 'Уночі']]);
legend('lg-utfvi', L.utfvi.colors.map((c, i) => [c, `${L.utfvi.classnames[i]} (${L.utfvi.labels[i]})`]));
legend('lg-type', [[C.day, 'Удень', true], [C.night, 'Уночі', true]]);
headline(); ndvi(); table(); notes();
const draw = () => { chartDT(); chartUTFVI(); chartType(); };
draw();
let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(draw, 150); });
