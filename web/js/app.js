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
});

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
  $('sheetSummary').textContent = `${state.city.name} · ${state.layers[state.layer].title}`;
  history.replaceState(null, '', `#city=${state.city.id}&layer=${state.layer}`);
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
  if (state.cell) showCell();
}

function refreshImage() {
  const src = map.getSource('heat');
  if (src) src.updateImage({ url: imageUrl(), coordinates: state.city.corners });
}

// ---------- Вибір точки ----------
async function selectPoint(lon, lat) {
  const c = state.city;
  const cell = cellOf(proj4, c, lon, lat);
  if (!cell) {
    clearSelection();
    $('info').innerHTML = `<p class="out">Ця точка поза зоною аналізу для міста ${c.name}. Оберіть місто в списку або клацніть ближче до центру.</p>`;
    return;
  }
  const data = await loadValues(c);
  const v = valuesAt(c, data, cell);
  if (v.dt_day === null && v.ndvi === null) {
    clearSelection();
    $('info').innerHTML = `<p class="out">Ця точка поза колом аналізу для міста ${c.name}.</p>`;
    return;
  }
  state.cell = { ...cell, lon, lat, v };
  map.getSource('cell')?.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [cellPolygon(proj4, c, cell)] } }]
  });
  showCell();
  if (matchMedia('(max-width: 760px)').matches) {
    toggleSheet(true);
    $('info').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function showCell() {
  const { v, lon, lat } = state.cell;
  const box = $('info');
  box.innerHTML = '';
  const h = el('h3', null, 'Квартал 100 × 100 м');
  h.append(el('span', 'tag', v.urban === 1 ? 'забудова' : 'незабудована територія'));
  box.append(h, el('p', 'meta', `${lat.toFixed(5)}° пн. ш., ${lon.toFixed(5)}° сх. д.`));

  for (const k of state.order) {
    const L = state.layers[k], x = v[k];
    const row = el('div', 'metric' + (k === state.layer ? ' active' : '') + (x === null ? ' empty' : ''));
    const dot = el('span', 'dot');
    const i = classIndex(L, x);
    dot.style.background = i >= 0 ? L.colors[i] : 'transparent';
    let val, txt;
    if (x === null) {
      val = 'немає даних';
      txt = k === 'dt_night' ? 'менше 5 придатних нічних знімків для цього кварталу'
          : k === 'bld_type' ? 'будівель у кварталі немає' : 'немає даних для цього кварталу';
    } else if (L.kind === 'categories') {
      val = ''; txt = L.labels[i] ?? '—';
    } else {
      val = (k.startsWith('dt_') && x > 0 ? '+' : '') + fmt(x, L.decimals) + (L.unit ? ' ' + L.unit : '');
      txt = L.explain[i] + (L.classnames ? ` (клас «${L.classnames[i]}»)` : '');
    }
    row.append(dot, el('span', 'name', L.title), el('span', 'val', val), el('span', 'txt', txt));
    box.append(row);
  }
}

function clearSelection() {
  state.cell = null;
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
