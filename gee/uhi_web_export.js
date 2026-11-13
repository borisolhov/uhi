// =====================================================================
// ЕКСПОРТ РАСТРІВ ДЛЯ САЙТУ «Острови тепла українських міст» (borisolhov.github.io/uhi)
// Google Earth Engine (code.earthengine.google.com)
// Лише вивантаження файлів: без карти, таблиць і вибірок (на відміну від uhi_multicity.js).
// Методика та сама, що в uhi_multicity.js (стаття), — змінено лише організацію розрахунку.
//
// На кожне місто дві окремі задачі в Tasks (папка uhi_web на Google Drive):
//   web_<id>_day.tif   — 4 смуги: dT_day, utfvi, ndvi, urban        (легка, кілька хвилин)
//   web_<id>_night.tif — 2 смуги: dT_night, n_night (ECOSTRESS)    (важка, до години)
// Порядок: спершу запустіть ДЕННІ задачі й надішліть файли на перевірку еталона;
// нічні — після перевірки (нічна ΔT залежить від того самого еталона).
// Версія 13.11.2026 (параметри статті: Дніпро r 16 км, Харків r 17 км).
// =====================================================================

// ---------- 1. ПАРАМЕТРИ ----------
var START = '2023-05-01', END = '2025-09-30';  // літні сезони Landsat
var M1 = 5, M2 = 9;                             // травень–вересень
var SCALE = 100;                                // м, крок аналізу
var ECO_START = '2018-07-01', ECO_END = '2026-11-03';
var ECO_MIN_COVER = 0.5;   // частка кола, покрита чистими пікселями нічного кадру
var MIN_NIGHT_N = 5;       // мінімум придатних нічних кадрів у пікселі

var EXPORT_DAY = true;     // задачі web_<id>_day
var EXPORT_NIGHT = true;   // задачі web_<id>_night

// Захист від «out of memory»: обчислення ділиться на дрібніші шматки (на результат не впливає).
var TILE_SCALE = 16;
// Крок, з яким для кожного нічного кадру рахуються середня температура еталона й покриття кадру.
// 100 — як у статті. Якщо нічна задача знову впаде з «out of memory», поставте 300:
// середнє по тисячах пікселів еталона при цьому майже не зміниться (менше ніж на 0,05 °C).
var NIGHT_REF_SCALE = 100;

// id — для імен файлів; r — радіус кола аналізу, км. Параметри — як у статті (7 міст, 13.11.2026):
// радіуси Дніпра й Харкова = радіуси OSM (osm_buildings.py), еталон без додаткових фільтрів.
// Дніпро: еталон (≈35,5 °C) дорівнює середній LST забудови, тож денна ΔT ≈ 0 — так і в статті;
// сайт позначає її як непорівнянну з іншими містами.
// ruralNdviMin (необов'язково): у еталон лише ділянки з NDVI не нижче цього значення.
var CITIES = [
  {id: 'dnipro',  lon: 35.0462, lat: 48.4647, r: 16},
  {id: 'kharkiv', lon: 36.2304, lat: 49.9935, r: 17}
];

// ---------- 2. СІТКА 100 м ДЛЯ МІСТА ----------
// Правило osm_buildings.py (перевірено на п'яти містах): зона UTM за довготою центру,
//   x0 = floor((x − R)/100)·100,  y0 = ceil((y + R)/100)·100,  w = h = 2R/100 + 1.
// UTM рахується тут (ряд Крюгера, точність ~1 мм); у редакторі GEE немає Math.sinh/cosh — свої.
function utmGrid(c) {
  var zone = Math.floor((c.lon + 180) / 6) + 1;
  var xy = toUTM(c.lon, c.lat, zone), R = c.r * 1000, n = 2 * c.r * 1000 / SCALE + 1;
  return {crs: 'EPSG:' + (32600 + zone),
          x0: Math.floor((xy[0] - R) / SCALE) * SCALE,
          y0: Math.ceil((xy[1] + R) / SCALE) * SCALE, w: n, h: n};
}
function toUTM(lon, lat, zone) {
  var a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  var n = f / (2 - f), A = a / (1 + n) * (1 + n * n / 4 + Math.pow(n, 4) / 64);
  var al = [n / 2 - 2 * n * n / 3 + 5 * Math.pow(n, 3) / 16,
            13 * n * n / 48 - 3 * Math.pow(n, 3) / 5,
            61 * Math.pow(n, 3) / 240];
  var rad = Math.PI / 180, phi = lat * rad, dl = (lon - (zone * 6 - 183)) * rad;
  var e = 2 * Math.sqrt(n) / (1 + n);
  var t = sinh(atanh(Math.sin(phi)) - e * atanh(e * Math.sin(phi)));
  var xi = Math.atan2(t, Math.cos(dl)), eta = atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  var x = eta, y = xi;
  for (var j = 1; j <= 3; j++) {
    x += al[j - 1] * Math.cos(2 * j * xi) * sinh(2 * j * eta);
    y += al[j - 1] * Math.sin(2 * j * xi) * cosh(2 * j * eta);
  }
  return [500000 + k0 * A * x, k0 * A * y];
}
function atanh(v) { return 0.5 * Math.log((1 + v) / (1 - v)); }
function sinh(v) { return (Math.exp(v) - Math.exp(-v)) / 2; }
function cosh(v) { return (Math.exp(v) + Math.exp(-v)) / 2; }

// ---------- 3. ЗАГАЛЬНІ ШАРИ ----------
var wc = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
var ghslF = ee.Image('JRC/GHSL/P2023A/GHS_BUILT_S/2020').select('built_surface').divide(10000);

function prepLandsat(img) {
  var clear = img.select('QA_PIXEL').bitwiseAnd(30).eq(0);   // хмари, тіні, перисті
  var sr = img.select(['SR_B4', 'SR_B5']).multiply(0.0000275).add(-0.2);
  var lst = img.select('ST_B10').multiply(0.00341802).add(149.0).subtract(273.15).rename('LST');
  var ndvi = sr.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');
  return ee.Image.cat([lst, ndvi]).updateMask(clear).copyProperties(img, ['system:time_start']);
}

function meanIn(img, geom, scale) {
  return img.reduceRegion({reducer: ee.Reducer.mean(), geometry: geom, scale: scale,
                           maxPixels: 1e10, bestEffort: true, tileScale: TILE_SCALE});
}

// ---------- 4. МІСТО: ДЕННІ Й НІЧНІ ШАРИ ----------
function cityLayers(c) {
  var roi = ee.Geometry.Point([c.lon, c.lat]).buffer(c.r * 1000);

  var med = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
    .filterBounds(roi).filterDate(START, END)
    .filter(ee.Filter.calendarRange(M1, M2, 'month'))
    .filter(ee.Filter.lt('CLOUD_COVER', 30))
    .map(prepLandsat).median();
  var lst = med.select('LST'), ndvi = med.select('NDVI');

  var urban = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').select('label')
    .filterDate(START, END).filterBounds(roi)
    .filter(ee.Filter.calendarRange(M1, M2, 'month')).mode().eq(6);

  // заміський еталон: трави/поля, без забудови (GHSL і Dynamic World), за потреби — лише жива рослинність
  var rural = wc.eq(30).or(wc.eq(40)).and(ghslF.lt(0.02)).and(urban.unmask(0).not())
                .and(ndvi.gte(c.ruralNdviMin === undefined ? -1 : c.ruralNdviMin));
  var ruralLST = ee.Number(meanIn(lst.updateMask(rural), roi, SCALE).get('LST'));

  var dT = lst.subtract(ee.Image.constant(ruralLST)).rename('dT_day');
  var lstK = lst.add(273.15);
  var meanK = ee.Number(meanIn(lstK.updateMask(urban), roi, SCALE).get('LST'));
  var utfvi = lstK.subtract(meanK).divide(meanK).rename('utfvi');

  var day = ee.Image.cat([dT, utfvi, ndvi.rename('ndvi'), urban.unmask(0).rename('urban')]);

  // Нічна ΔT (ECOSTRESS): ΔT у кожному кадрі відносно еталона цього ж кадру, потім середнє.
  // Середнє й кількість кадрів рахуються за один прохід (один комбінований редуктор).
  var night = null;
  if (EXPORT_NIGHT) {
    var eco = ee.ImageCollection('NASA/ECOSTRESS/L2T_LSTE/V2')
      .filterBounds(roi).filterDate(ECO_START, ECO_END)
      .filter(ee.Filter.calendarRange(M1, M2, 'month'))
      .filter(ee.Filter.or(ee.Filter.calendarRange(19, 23, 'hour'),
                           ee.Filter.calendarRange(0, 2, 'hour')))
      .map(function (img) {
        img = img.select(['LST', 'LST_err', 'cloud']).clip(roi);
        var clear = img.select('cloud').bitwiseAnd(1).eq(0).and(img.select('LST_err').lte(2));
        var t = img.select('LST').subtract(273.15).updateMask(clear).rename('t');
        var cover = meanIn(clear.unmask(0).rename('c'), roi, NIGHT_REF_SCALE).get('c');
        var ref = meanIn(t.updateMask(rural), roi, NIGHT_REF_SCALE).get('t');
        return t.set({cover: cover, ref: ref});
      })
      .filter(ee.Filter.gte('cover', ECO_MIN_COVER))
      .filter(ee.Filter.notNull(['ref']));
    var dtn = eco.map(function (img) {
      return img.subtract(ee.Number(img.get('ref'))).rename('dT_night');
    }).reduce(ee.Reducer.mean().combine(ee.Reducer.count(), null, true));
    var n = dtn.select('dT_night_count').unmask(0);
    night = ee.Image.cat([
      dtn.select('dT_night_mean').updateMask(n.gte(MIN_NIGHT_N)).rename('dT_night'),
      n.rename('n_night')
    ]);
  }
  return {roi: roi, day: day, night: night};
}

// ---------- 5. ЗАДАЧІ ЕКСПОРТУ ----------
function exportTo(img, name, g, roi) {
  var region = ee.Geometry.Rectangle(
    [g.x0, g.y0 - g.h * SCALE, g.x0 + g.w * SCALE, g.y0], ee.Projection(g.crs), false);
  Export.image.toDrive({
    image: img.clip(roi).toFloat().unmask(-9999, false),
    description: name, fileNamePrefix: name, folder: 'uhi_web',
    region: region, crs: g.crs, crsTransform: [SCALE, 0, g.x0, 0, -SCALE, g.y0],
    maxPixels: 1e9, fileFormat: 'GeoTIFF', formatOptions: {noData: -9999}
  });
}

CITIES.forEach(function (c) {
  var g = utmGrid(c), L = cityLayers(c);
  print('web_' + c.id + ': ' + g.crs + ', x0 ' + g.x0 + ', y0 ' + g.y0 + ', ' + g.w + '×' + g.h +
        (c.ruralNdviMin !== undefined ? ', еталон NDVI ≥ ' + c.ruralNdviMin : ''));
  if (EXPORT_DAY) exportTo(L.day, 'web_' + c.id + '_day', g, L.roi);
  if (EXPORT_NIGHT) exportTo(L.night, 'web_' + c.id + '_night', g, L.roi);
});

// ПРИМІТКИ:
// • Відкрийте вкладку Tasks і натисніть Run біля потрібних задач. Карти й обчислень у консолі немає,
//   тож скрипт запускається за секунди; уся робота йде в задачах.
// • Якщо web_<id>_night падає з «out of memory»: NIGHT_REF_SCALE = 300, EXPORT_DAY = false, запустити знову.
// • Нове місто: додайте запис у CITIES; ті самі центр і радіус задайте в osm_buildings.py.
