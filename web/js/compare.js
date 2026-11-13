import { fmt } from './grid.js';

const [meta, cfg] = await Promise.all([
  fetch('data/cities.json').then(r => r.json()),
  fetch('data/layers.json').then(r => r.json())
]);
const L = cfg.layers;
const NS = 'http://www.w3.org/2000/svg';
// кольори перевірено на розрізнення при порушеннях колірного зору (dataviz validate_palette)
const C = { day: '#e0763a', night: '#6a4fa3', apt: L.bld_type.colors[0], priv: L.bld_type.colors[1] };
// later — міста, додані після статті: позначаються зірочкою; note — застереження для міста
const cities = meta.cities.map(c => ({ id: c.id, name: c.name + (c.later ? '*' : ''), plain: c.name,
                                       later: c.later, note: c.note, ...c.stats }))
  .sort((a, b) => b.mean_dt_day - a.mean_dt_day);
const withType = cities.filter(c => c.dt_day_apt != null && c.dt_day_priv != null);

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
  const byDay = cities[0];
  const byNight = [...cities].sort((a, b) => b.mean_dt_night - a.mean_dt_night)[0];
  const diffs = withType.map(c => c.dt_day_apt - c.dt_day_priv);
  const allWarmer = diffs.every(d => d > 0);
  const tiles = [
    ['Найсильніший денний острів', `${signed(byDay.mean_dt_day)} °C`, byDay.plain],
    ['Найменше охолодження вночі', `${signed(byNight.mean_dt_night)} °C`, byNight.plain],
    ['Багатоповерхівки тепліші за приватний сектор', `${fmt(Math.min(...diffs), 1)}–${fmt(Math.max(...diffs), 1)} °C`,
     `удень, ${allWarmer ? 'у всіх' : 'у'} ${withType.length} містах з даними про тип забудови`]
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
      const m = v >= 0 ? bar(svg, x(0), x(v), yy, bh, C[k]) : barLeft(svg, x(v), x(0), yy, bh, C[k]);
      text(svg, v >= 0 ? x(v) + 6 : x(v) - 6, yy + bh / 2 + 1, signed(v),
           { 'dominant-baseline': 'middle', class: 'val', 'text-anchor': v >= 0 ? 'start' : 'end' });
      hover(m, `<b>${c.name}</b>, ${lab}<br>ΔT ${signed(v, 2)} °C`);
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

// ---------- 3. Багатоповерхівки vs приватний сектор (гантелі, дві панелі) ----------
function chartType() {
  const svg = document.getElementById('ch-type');
  svg.innerHTML = svg.querySelector('title').outerHTML;
  const W = svg.clientWidth || 800, narrow = W < 620;
  const labW = narrow ? 122 : 136, rowH = 30, top = 26;
  const facets = [['dt_day', 'Удень'], ['dt_night', 'Уночі']];
  const panelH = top + withType.length * rowH + 24;
  const H = narrow ? panelH * 2 + 12 : panelH;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
  const max = niceMax(Math.max(...withType.flatMap(c => [c.dt_day_apt, c.dt_night_apt])));
  const panelW = narrow ? W - labW : (W - labW - 24) / 2;
  facets.forEach(([k, title], f) => {
    const ox = narrow ? labW : labW + f * (panelW + 24), oy = narrow ? f * (panelH + 12) : 0;
    const x = v => ox + (panelW - 40) * v / max;
    const g = svgEl('g', { class: 'grid' }, svg), ax = svgEl('g', { class: 'axis' }, svg);
    text(svg, ox, oy + 12, title, { 'font-weight': 600 });
    for (let t = 0; t <= max; t++) {
      svgEl('line', { x1: x(t), x2: x(t), y1: oy + top - 6, y2: oy + panelH - 20 }, g);
      text(ax, x(t), oy + panelH - 6, fmt(t, 0), { 'text-anchor': 'middle', class: 'tick' });
    }
    withType.forEach((c, i) => {
      const y = oy + top + i * rowH + rowH / 2 - 4;
      if (f === 0 || narrow) text(svg, 0, y, c.name, { 'dominant-baseline': 'middle', 'font-weight': 600 });
      const a = c[`${k}_apt`], p = c[`${k}_priv`];
      if (a == null || p == null) return;
      svgEl('line', { x1: x(p), x2: x(a), y1: y, y2: y, stroke: '#c9c0b3', 'stroke-width': 2, 'stroke-linecap': 'round' }, svg);
      for (const [v, col, nm, n] of [[p, C.priv, 'приватна садибна', c.n_priv], [a, C.apt, 'багатоповерхова', c.n_apt]]) {
        const dot = svgEl('circle', { cx: x(v), cy: y, r: 5.5, fill: col, stroke: '#fffdf9', 'stroke-width': 2, class: 'mark' }, svg);
        const hit = svgEl('circle', { cx: x(v), cy: y, r: 11, fill: 'transparent' }, svg);
        hover(hit, `<b>${c.name}</b>, ${title.toLowerCase()}<br>${nm} забудова: ΔT ${signed(v, 2)} °C<br>${n} кварталів`);
        dot.style.pointerEvents = 'none';
      }
      text(svg, x(a) + 10, y + 1, `+${fmt(a - p, 1)}`, { 'dominant-baseline': 'middle', class: 'val', fill: '#6b655c' });
    });
  });
}

// ---------- 4. NDVI ----------
function ndvi() {
  document.getElementById('ndvi').innerHTML = cities.map(c =>
    `<div class="stat"><div class="l">${c.name}</div><div class="v">r = ${fmt(c.r_ndvi_dt_day, 2)}</div><div class="s">NDVI сер. ${fmt(c.mean_ndvi, 2)}</div></div>`).join('');
}

// ---------- Таблиця ----------
function table() {
  document.querySelector('#tbl tbody').innerHTML = cities.map(c => `<tr>
    <td>${c.name}</td><td>${signed(c.mean_dt_day, 2)}</td><td>${signed(c.mean_dt_night, 2)}</td>
    <td>${c.n_urban.toLocaleString('uk-UA')}</td><td>${fmt(100 * c.share_utfvi.slice(3).reduce((a, b) => a + b, 0), 1)}</td>
    <td>${num(c.mean_ndvi, 2)}</td>
    <td>${c.dt_day_apt == null ? '—' : `${signed(c.dt_day_apt, 1)} / ${signed(c.dt_night_apt, 1)}`}</td>
    <td>${c.dt_day_priv == null ? '—' : `${signed(c.dt_day_priv, 1)} / ${signed(c.dt_night_priv, 1)}`}</td>
    <td>${num(c.r_ndvi_dt_day, 2)}</td></tr>`).join('');
}

// ---------- Застереження по містах ----------
function notes() {
  const later = cities.filter(c => c.later).map(c => c.plain);
  const items = [];
  if (later.length) items.push(`<li><b>*</b> ${later.join(' і ')} додано після основного дослідження; ці міста не входять до наукової статті${
    cities.some(c => c.later && c.dt_day_apt == null) ? ', а тип забудови для них ще не розраховано' : ''}.</li>`);
  for (const c of cities.filter(c => c.note)) items.push(`<li><b>${c.plain}.</b> ${c.note}</li>`);
  const box = document.getElementById('notes');
  box.innerHTML = items.join('');
  box.hidden = !items.length;
}

legend('lg-dt', [[C.day, 'Удень'], [C.night, 'Уночі']]);
legend('lg-utfvi', L.utfvi.colors.map((c, i) => [c, `${L.utfvi.classnames[i]} (${L.utfvi.labels[i]})`]));
legend('lg-type', [[C.apt, 'Багатоповерхова житлова', true], [C.priv, 'Приватна садибна', true]]);
headline(); ndvi(); table(); notes();
const draw = () => { chartDT(); chartUTFVI(); chartType(); };
draw();
let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(draw, 150); });
