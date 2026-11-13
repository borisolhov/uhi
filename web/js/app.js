import { cellOf, cellPolygon, valuesAt, classIndex, fmt } from './grid.js';

const BASEMAP = 'https://tiles.openfreemap.org/styles/positron';
const GEOCODER = 'https://nominatim.openstreetmap.org/search';
const ATTRIBUTION = [
  'Дані: Landsat 8/9 (USGS/NASA)', 'ECOSTRESS (NASA)', 'ESA WorldCover', 'GHSL (JRC)',
  'Dynamic World (Google, WRI)', 'будівлі © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> (ODbL)',
  'пошук адреси: Nominatim'
].join(' · ');

const $ = id => document.getElementById(id);
const state = { city: null, layer: 'dt_day', cell: null, data: {}, meta: null, layers: null, order: null };

// ---------- Завантаження ----------
const [meta, layersCfg] = await Promise.all([
  fetch('data/cities.json').then(r => r.json()),
  fetch('data/layers.json').then(r => r.json())
]);
state.meta = meta;
state.layers = layersCfg.layers;
state.order = layersCfg.order;

if (meta.cities.some(c => c.synthetic)) {
  const b = $('banner');
  b.textContent = 'Демонстраційна версія: ΔT, UTFVI і NDVI тут синтетичні, лише для перевірки сайту. Тип забудови — справжні дані OSM.';
  b.hidden = false;
}

// стан з адресного рядка: #city=kyiv&layer=dt_night
const hash = new URLSearchParams(location.hash.slice(1));
state.city = meta.cities.find(c => c.id === hash.get('city')) || meta.cities[0];
if (state.order.includes(hash.get('layer'))) state.layer = hash.get('layer');
const startPt = (hash.get('pt') || '').split(',').map(Number);   // поширене посилання на точку
const MOBILE = matchMedia('(max-width: 760px)');

// ---------- Карта ----------
const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP,
  bounds: boundsOf(state.city),
  fitBoundsOptions: { padding: 20 },
  attributionControl: false,
  maxZoom: 17,
  minZoom: 5
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIBUTION }));

map.on('load', () => {
  const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  map.addSource('heat', { type: 'image', url: imageUrl(), coordinates: state.city.corners });
  map.addLayer({
    id: 'heat', type: 'raster', source: 'heat',
    paint: { 'raster-opacity': +$('opacity').value, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 }
  }, firstSymbol);
  map.addSource('cell', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'cell-halo', type: 'line', source: 'cell', paint: { 'line-color': '#fff', 'line-width': 5 } });
  map.addLayer({ id: 'cell', type: 'line', source: 'cell', paint: { 'line-color': '#1f1d1a', 'line-width': 2 } });
  if (startPt.length === 2 && startPt.every(Number.isFinite)) {
    map.jumpTo({ center: [startPt[1], startPt[0]], zoom: 14 });
    selectPoint(startPt[1], startPt[0], { quiet: true });
  }
});

// Коротке повідомлення внизу екрана (телефон)
let toastTimer;
function toast(msg) {
  let t = $('toast');
  if (!t) { t = el('div', 'toast'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3200);
}

// Спливна підказка біля точки кліку: значення поточного шару + перехід до повної картки
const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: '260px', offset: 10, className: 'pt-popup' });

map.on('click', e => selectPoint(e.lngLat.lng, e.lngLat.lat));
map.getCanvas().style.cursor = 'crosshair';

// ---------- Інтерфейс ----------
renderCities();
renderLayers();
renderLegend();
updateSummary();

$('opacity').addEventListener('input', e => {
  if (map.getLayer('heat')) map.setPaintProperty('heat', 'raster-opacity', +e.target.value);
});

$('sheetHandle').addEventListener('click', () => toggleSheet());

function toggleSheet(open) {
  const p = $('panel');
  const v = open ?? !p.classList.contains('open');
  p.classList.toggle('open', v);
  $('sheetHandle').setAttribute('aria-expanded', String(v));
}

function renderCities() {
  $('cities').innerHTML = '';
  for (const c of meta.cities) {
    const b = el('button', 'chip', c.name);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c.id === state.city.id));
    b.onclick = () => setCity(c);
    $('cities').append(b);
  }
}

function renderLayers() {
  $('layers').innerHTML = '';
  for (const k of state.order) {
    const L = state.layers[k];
    const b = el('button', 'layer');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === state.layer));
    b.disabled = !state.city.layers.includes(k);
    b.append(el('span', 't', L.title), el('span', 'u', L.unit), el('span', 'd', L.short));
    b.onclick = () => setLayer(k);
    $('layers').append(b);
  }
}

function renderLegend() {
  const L = state.layers[state.layer];
  const box = $('legend');
  box.innerHTML = '';
  if (L.unit) box.append(el('div', 'unit', `${L.title}, ${L.unit}`));
  L.colors.forEach((c, i) => {
    const row = el('div', 'row');
    const sw = el('span', 'sw'); sw.style.background = c;
    row.append(sw, el('span', 'lab', L.labels[i]));
    if (L.classnames) row.append(el('span', 'cls', L.classnames[i]));
    box.append(row);
  });
}

function updateSummary() {
  let sum = `${state.city.name} · ${state.layers[state.layer].title}`;
  if (state.cell) {                       // у згорнутій шторці видно значення вибраної точки
    const [val, txt] = describe(state.layer, state.cell.v[state.layer]);
    sum += ': ' + (val || txt);
  }
  $('sheetSummary').textContent = sum;
  const pt = state.cell ? `&pt=${state.cell.lat.toFixed(5)},${state.cell.lon.toFixed(5)}` : '';
  history.replaceState(null, '', `#city=${state.city.id}&layer=${state.layer}${pt}`);
}

function setCity(c) {
  if (c.id === state.city.id) return;
  state.city = c;
  if (!c.layers.includes(state.layer)) state.layer = c.layers[0];
  clearSelection();
  renderCities(); renderLayers(); renderLegend(); updateSummary(); refreshImage();
  map.fitBounds(boundsOf(c), { padding: 20, duration: 600 });
  $('results').hidden = true;
}

function setLayer(k) {
  state.layer = k;
  renderLayers(); renderLegend(); updateSummary(); refreshImage();
  if (state.cell) { showCell(); showPopup(); }
}

function refreshImage() {
  const src = map.getSource('heat');
  if (src) src.updateImage({ url: imageUrl(), coordinates: state.city.corners });
}

// ---------- Вибір точки ----------
async function selectPoint(lon, lat, opts = {}) {
  const c = state.city;
  const cell = cellOf(proj4, c, lon, lat);
  const v = cell ? valuesAt(c, await loadValues(c), cell) : null;
  if (!cell || (v.dt_day === null && v.ndvi === null)) {
    clearSelection();
    const msg = `Ця точка поза зоною аналізу для міста ${c.name}. Клацніть ближче до центру або оберіть інше місто.`;
    $('info').innerHTML = `<p class="out">${msg}</p>`;
    if (MOBILE.matches) toast(msg);
    else popup.setLngLat([lon, lat]).setDOMContent(el('p', 'pp-out', msg)).addTo(map);
    updateSummary();
    return;
  }
  state.cell = { ...cell, lon, lat, v };
  map.getSource('cell')?.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [cellPolygon(proj4, c, cell)] } }]
  });
  showCell();
  updateSummary();
  if (MOBILE.matches) {
    // на телефоні картка відкривається в шторці, а карта зсувається, щоб точка лишилась видимою над нею
    popup.remove();
    toggleSheet(true);
    requestAnimationFrame(() => {
      scrollToCard($('panelBody'), opts.quiet);
      const sheetH = $('panel').getBoundingClientRect().height;
      map.easeTo({ center: [lon, lat], padding: { top: 0, bottom: sheetH, left: 0, right: 0 }, duration: 400 });
    });
  } else {
    showPopup();
    revealCard(opts.quiet);
  }
}

// Підказка біля точки: поточний шар великим числом + кнопка до повної картки
function showPopup() {
  if (!state.cell || MOBILE.matches) return;
  const { v, lon, lat } = state.cell, k = state.layer, L = state.layers[k];
  const [val, txt, color] = describe(k, v[k]);
  const box = el('div', 'pp');
  const head = el('div', 'pp-head');
  const dot = el('span', 'pp-dot'); dot.style.background = color;
  head.append(dot, el('span', 'pp-name', L.title));
  box.append(head, el('div', 'pp-val', val || txt), el('div', 'pp-txt', val ? txt : ''));
  const more = el('button', 'pp-more', 'Усі показники кварталу →');
  more.onclick = () => revealCard(false, true);
  box.append(more);
  popup.setLngLat([lon, lat]).setDOMContent(box).addTo(map);
}

function scrollToCard(scroller, quiet) {
  const top = scroller.scrollTop + $('info').getBoundingClientRect().top - scroller.getBoundingClientRect().top - 10;
  scroller.scrollTo({ top, behavior: quiet ? 'auto' : 'smooth' });
}

// Прокрутити панель до картки кварталу й коротко підсвітити її
function revealCard(quiet, force) {
  const info = $('info'), panel = $('panel');
  const r = info.getBoundingClientRect(), pr = panel.getBoundingClientRect();
  const visible = r.top >= pr.top && r.top < pr.bottom - 120;
  if (!visible || force) scrollToCard(panel, quiet);
  if (!quiet) { info.classList.remove('flash'); void info.offsetWidth; info.classList.add('flash'); }
}

// [значення, пояснення, колір класу] для показника k
function describe(k, x) {
  const L = state.layers[k];
  const i = classIndex(L, x), color = i >= 0 ? L.colors[i] : 'transparent';
  if (k === 'bld_type' && x === 0) return ['', 'квартал поза зоною, для якої завантажено дані OpenStreetMap', 'transparent'];
  if (x === null) {
    return ['', k === 'dt_night' ? 'менше 5 придатних нічних знімків для цього кварталу'
          : k === 'bld_type' ? (state.city.osm === false ? 'дані OpenStreetMap для цього міста ще не оброблено'
                                                          : 'будівель у кварталі немає')
          : 'немає даних для цього кварталу', 'transparent'];
  }
  if (L.kind === 'categories') return ['', L.labels[i] ?? '—', color];
  let txt = L.explain[i] + (L.classnames ? ` (клас «${L.classnames[i]}»)` : '');
  if (k === 'dt_day' && state.city.dt_day_comparable === false) txt += '; для цього міста денна ΔT не порівнюється з іншими містами';
  return [(k.startsWith('dt_') && x > 0 ? '+' : '') + fmt(x, L.decimals) + (L.unit ? ' ' + L.unit : ''), txt, color];
}

function showCell() {
  const { v, lon, lat } = state.cell;
  const box = $('info');
  box.innerHTML = '';
  const h = el('h3', null, 'Квартал 100 × 100 м');
  h.append(el('span', 'tag', v.urban === 1 ? 'забудова' : 'незабудована територія'));
  box.append(h, el('p', 'meta', `${lat.toFixed(5)}° пн. ш., ${lon.toFixed(5)}° сх. д.`));

  for (const k of state.order) {
    const L = state.layers[k];
    const [val, txt, color] = describe(k, v[k]);
    const empty = !val && (v[k] === null || (k === 'bld_type' && v[k] === 0));
    const row = el('button', 'metric' + (k === state.layer ? ' active' : '') + (empty ? ' empty' : ''));
    row.type = 'button';
    row.disabled = !state.city.layers.includes(k);
    row.title = row.disabled ? '' : `Показати шар «${L.title}» на карті`;
    const dot = el('span', 'dot'); dot.style.background = color;
    row.append(dot, el('span', 'name', L.title), el('span', 'val', val || (empty ? 'немає даних' : '')), el('span', 'txt', txt));
    if (!row.disabled) row.onclick = () => setLayer(k);
    box.append(row);
  }
  const share = el('button', 'share', 'Скопіювати посилання на цю точку');
  share.type = 'button';
  share.onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); share.textContent = 'Посилання скопійовано ✓'; }
    catch { share.textContent = 'Скопіюйте адресу з рядка браузера'; }
    setTimeout(() => { share.textContent = 'Скопіювати посилання на цю точку'; }, 2500);
  };
  box.append(share);
  if (state.city.note) box.append(el('p', 'city-note', state.city.note));
}

function clearSelection() {
  state.cell = null;
  popup.remove();
  map.getSource('cell')?.setData(emptyFC());
  $('info').innerHTML = '<p class="placeholder">Оберіть точку на карті, щоб побачити показники кварталу.</p>';
}

async function loadValues(c) {
  if (!state.data[c.id]) {
    state.data[c.id] = fetch(`data/${c.id}/values.bin`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(b => new Int16Array(b));
  }
  return state.data[c.id];
}

// ---------- Пошук адреси (Nominatim, лише за натисканням «Знайти») ----------
let lastSearch = 0;
$('search').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  const wait = 1100 - (Date.now() - lastSearch);         // правила Nominatim: не частіше 1 запиту/с
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSearch = Date.now();
  const [[w, s], [e2, n]] = boundsOf(state.city);
  const url = `${GEOCODER}?` + new URLSearchParams({
    q, format: 'jsonv2', limit: '5', countrycodes: 'ua', 'accept-language': 'uk',
    viewbox: `${w},${n},${e2},${s}`, bounded: '1'
  });
  const list = $('results');
  list.hidden = false;
  list.innerHTML = '<li class="msg">Шукаю…</li>';
  try {
    const res = await fetch(url).then(r => r.json());
    list.innerHTML = '';
    if (!res.length) {
      list.innerHTML = `<li class="msg">У межах міста ${state.city.name} нічого не знайдено. Спробуйте інакше або клацніть по карті.</li>`;
      return;
    }
    for (const r of res) {
      const li = el('li', null, r.display_name.split(', ').slice(0, 4).join(', '));
      li.tabIndex = 0;
      const go = () => {
        list.hidden = true;
        map.flyTo({ center: [+r.lon, +r.lat], zoom: 15 });
        selectPoint(+r.lon, +r.lat);
      };
      li.onclick = go;
      li.onkeydown = ev => { if (ev.key === 'Enter') go(); };
      list.append(li);
    }
  } catch {
    list.innerHTML = '<li class="msg">Пошук зараз недоступний. Клацніть по карті.</li>';
  }
});

// ---------- Допоміжне ----------
function imageUrl() { return `data/${state.city.id}/${state.layer}.png`; }
function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
function boundsOf(c) {
  const xs = c.corners.map(p => p[0]), ys = c.corners.map(p => p[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
