// =====================================================================
// UHI + МІСЬКІ КАНЬЙОНИ: ПОРІВНЯННЯ КІЛЬКОХ МІСТ УКРАЇНИ
// Google Earth Engine (code.earthengine.google.com)
// Міста: Івано-Франківськ, Київ, Львів, Чернівці, Ужгород
// Результат: (1) інтерактивна карта з вибором міста,
//            (2) CSV-таблиця показників по містах,
//            (3) CSV-вибірка пікселів для статистики в Python (регресія, GWR).
// =====================================================================

// ---------- 1. ПАРАМЕТРИ ----------
var START = '2023-05-01', END = '2025-09-30';  // літні сезони
var M1 = 5, M2 = 9;                             // травень–вересень
var SCALE = 100;                                // м, крок аналізу
var N_SAMPLE = 5000;                            // пікселів у вибірці на місто
var RUN_EXPORTS = true;                         // false — лише карта
var RUN_WEB_EXPORTS = true;                     // растри для сайту (розділ 3а); false — пропустити

// Сітки растрів для сайту: ті самі, що в <id>_osm_bld (UTM, 100 м), щоб комірки збігалися
// з даними OSM піксель у піксель. x0, y0 — верхній лівий кут; w, h — розмір у пікселях.
var WEB_GRID = {
  ivano_frankivsk: {crs: 'EPSG:32635', x0: 322300, y0: 5431300, w: 201, h: 201},
  kyiv:            {crs: 'EPSG:32636', x0: 302100, y0: 5613700, w: 441, h: 441},
  lviv:            {crs: 'EPSG:32635', x0: 273500, y0: 5538100, w: 261, h: 261},
  chernivtsi:      {crs: 'EPSG:32635', x0: 412000, y0: 5358400, w: 181, h: 181},
  uzhhorod:        {crs: 'EPSG:32634', x0: 586900, y0: 5394200, w: 161, h: 161}
};

// ECOSTRESS (70 м): нічна LST. Нічні кадри: літо, 19:00–02:00 UTC (≈ 22:00–05:00 за київським часом).
var USE_ECO = true;                              // false — швидше, без нічної ΔT 70 м
var ECO_START = '2018-07-01', ECO_END = '2026-11-03';
var ECO_MIN_COVER = 0.5;                         // частка кола аналізу, покрита чистими пікселями кадру

// id — для імен файлів (латиницею); r — радіус аналізу, км;
// osm — шлях до растру будівель OSM (після завантаження з osm_buildings.py), або null.
var CITIES = {
  'Івано-Франківськ': {id: 'ivano_frankivsk', lon: 24.7111, lat: 48.9215, r: 10,
                       osm: 'projects/eng-archery-426318-m5/assets/ivano_frankivsk_osm_bld'},
  'Київ':             {id: 'kyiv',            lon: 30.5234, lat: 50.4501, r: 22,
                       osm: 'projects/eng-archery-426318-m5/assets/kyiv_osm_bld'},
  'Львів':            {id: 'lviv',            lon: 24.0316, lat: 49.8397, r: 13,
                       osm: 'projects/eng-archery-426318-m5/assets/lviv_osm_bld'},
  'Чернівці':         {id: 'chernivtsi',      lon: 25.9358, lat: 48.2921, r: 9,
                       osm: 'projects/eng-archery-426318-m5/assets/chernivtsi_osm_bld'},
  'Ужгород':          {id: 'uzhhorod',        lon: 22.2879, lat: 48.6208, r: 8,
                       osm: 'projects/eng-archery-426318-m5/assets/uzhhorod_osm_bld'}
};
// Частки класів будівель (багатоповерхівки, приватний сектор, нежитлові, допоміжні, невизначені):
// другий растр <id>_osm_cls (його створює osm_buildings.py). Немає активу — постав null.
var CLS_BANDS = ['share_apt', 'share_priv', 'share_nonres', 'share_aux', 'share_unk'];
// CLS_READY — id міст, для яких `<id>_osm_cls` уже завантажено в Assets (додавайте міста по мірі завантаження).
var CLS_READY = ['ivano_frankivsk'];
Object.keys(CITIES).forEach(function (k) {
  CITIES[k].cls = CLS_READY.indexOf(CITIES[k].id) >= 0
    ? 'projects/eng-archery-426318-m5/assets/' + CITIES[k].id + '_osm_cls' : null;
});
// Одеса виключена: сільський еталон (випалений степ) гарячіший за приморське місто, ΔT втрачає зміст.
// Щоб повернути, додайте запис нижче; код маски суші й ruralNdviMin у analyse() збережено:
//   'Одеса': {id: 'odesa', lon: 30.7233, lat: 46.4825, r: 16, osm: null,
//             coast: {buf: 150, bufNight: 1000}, ruralNdviMin: 0.3},
// Приклад підключення OSM-шару:
// CITIES['Львів'].osm = 'projects/YOUR_PROJECT/assets/osm_bld_lviv';
// (растр має мати смуги: h_mean, h_tagged, f_built, share_tagged)

// ---------- 2. ЗАГАЛЬНІ ШАРИ ----------
var wc = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
var ghslH = ee.Image('JRC/GHSL/P2023A/GHS_BUILT_H/2018').select('built_height');
var ghslF = ee.Image('JRC/GHSL/P2023A/GHS_BUILT_S/2020').select('built_surface').divide(10000);
var modisNight = ee.ImageCollection('MODIS/061/MOD11A1')
  .filterDate(START, END).filter(ee.Filter.calendarRange(6, 8, 'month'))
  .select('LST_Night_1km').mean().multiply(0.02).subtract(273.15).rename('modis_night');

function prepLandsat(img) {
  var clear = img.select('QA_PIXEL').bitwiseAnd(30).eq(0);   // хмари, тіні, перисті
  var sr = img.select(['SR_B2', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7']).multiply(0.0000275).add(-0.2);
  var lst = img.select('ST_B10').multiply(0.00341802).add(149.0).subtract(273.15).rename('LST');
  var ndvi = sr.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');
  var ndbi = sr.normalizedDifference(['SR_B6', 'SR_B5']).rename('NDBI');
  var alb = sr.expression(
    '(0.356*B2 + 0.130*B4 + 0.373*B5 + 0.085*B6 + 0.072*B7 - 0.0018)/1.016', {
      B2: sr.select('SR_B2'), B4: sr.select('SR_B4'), B5: sr.select('SR_B5'),
      B6: sr.select('SR_B6'), B7: sr.select('SR_B7')}).rename('albedo');
  return ee.Image.cat([lst, ndvi, ndbi, alb]).updateMask(clear)
    .copyProperties(img, ['system:time_start']);
}

function mean(img, geom, scale) {
  return img.reduceRegion({reducer: ee.Reducer.mean(), geometry: geom, scale: scale,
                           maxPixels: 1e10, bestEffort: true});
}
function corr(a, b, mask, geom) {
  var r = ee.Image.cat([a, b]).updateMask(mask).reduceRegion({
    reducer: ee.Reducer.pearsonsCorrelation(), geometry: geom, scale: SCALE,
    maxPixels: 1e10, bestEffort: true});
  return r.get('correlation');
}

// ---------- 3. АНАЛІЗ ОДНОГО МІСТА ----------
var RES = {};   // зберігаємо зображення для карти
function analyse(name, c) {
  var roi = ee.Geometry.Point([c.lon, c.lat]).buffer(c.r * 1000);

  var col = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
    .filterBounds(roi).filterDate(START, END)
    .filter(ee.Filter.calendarRange(M1, M2, 'month'))
    .filter(ee.Filter.lt('CLOUD_COVER', 30))
    .map(prepLandsat);
  var med = col.median();

  // маска суші (лише для міст із c.coast): море й лимани виключаються,
  // прибережна смуга відступає від берега, щоб змішані піксель «суша+вода» не занижували LST
  var landM = ee.Image(1), landNight = ee.Image(1);
  if (c.coast) {
    var water = wc.eq(80).or(ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
                               .select('occurrence').unmask(0).gte(50));
    var land = water.not();
    landM = land.focalMin({radius: c.coast.buf, units: 'meters'});
    landNight = land.focalMin({radius: c.coast.bufNight, units: 'meters'});
  }
  var lst = med.select('LST').updateMask(landM), ndvi = med.select('NDVI').updateMask(landM),
      ndbi = med.select('NDBI').updateMask(landM), alb = med.select('albedo').updateMask(landM);

  // забудова: Dynamic World
  var urban = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').select('label')
    .filterDate(START, END).filterBounds(roi)
    .filter(ee.Filter.calendarRange(M1, M2, 'month')).mode().eq(6).updateMask(landM);

  // геометрія забудови: OSM (якщо є) або GHSL
  var H, F, HT, ST, src;
  if (c.osm) {
    // назви смуг задаємо тут, щоб не залежати від того, як їх прочитав завантажувач
    var o = ee.Image(c.osm).rename(['h_mean', 'h_tagged', 'f_built', 'share_tagged', 'n_bld']);
    H = o.select('h_mean').unmask(0).rename('H');
    F = o.select('f_built').unmask(0).rename('f');
    // h_tagged: середня висота лише будівель з явною висотою; -1 = у комірці таких немає.
    // unmask потрібен, бо sample(dropNulls) інакше викинув би всі комірки без тегів.
    HT = o.select('h_tagged').unmask(-1).max(-1).rename('H_tagged');   // max: страховка від -9999
    ST = o.select('share_tagged').unmask(0).rename('share_tagged');
    src = 'OSM';
  } else {
    H = ghslH.unmask(0).rename('H');
    F = ghslF.unmask(0).rename('f');
    HT = ee.Image.constant(-1).rename('H_tagged');
    ST = ee.Image.constant(0).rename('share_tagged');
    src = 'GHSL';
  }
  // класи будівель: частки площі забудови комірки; -1 = немає даних про класи
  var CL = c.cls ? ee.Image(c.cls).rename(CLS_BANDS).unmask(0)
                 : ee.Image.constant([-1, -1, -1, -1, -1]).rename(CLS_BANDS);
  H = H.updateMask(landM); F = F.updateMask(landM);
  var K = H.multiply(F).rename('K');

  // сільський еталон: трави/поля, без забудови (GHSL і Dynamic World)
  var rural = wc.eq(30).or(wc.eq(40)).and(ghslF.lt(0.02)).and(urban.unmask(0).not())
               .and(ndvi.gte(c.ruralNdviMin === undefined ? -1 : c.ruralNdviMin))
               .updateMask(landM);   // ruralNdviMin: брати лише «живу» рослинність, а не випалений степ
  var ruralLST = ee.Number(mean(lst.updateMask(rural), roi, SCALE).get('LST'));
  var ruralN = ee.Number(rural.selfMask().reduceRegion({
    reducer: ee.Reducer.count(), geometry: roi, scale: SCALE, maxPixels: 1e10, bestEffort: true}).values().get(0));
  var ruralNight = ee.Number(mean(modisNight.updateMask(rural), roi, 1000).get('modis_night'));

  var dT = lst.subtract(ee.Image.constant(ruralLST)).rename('dT');
  var dTn = modisNight.subtract(ee.Image.constant(ruralNight)).updateMask(landNight)
              .rename('dT_night');

  // нічна ΔT за ECOSTRESS (70 м): ΔT рахуємо в кожному кадрі окремо (відносно еталона
  // цього ж кадру), потім усереднюємо кадри; так прибирається вплив погоди тієї ночі.
  // -999 / 0 = у пікселі немає придатних кадрів (unmask, щоб sample(dropNulls) їх не викинув).
  var ecoLst, ecoDT, ecoN;
  if (USE_ECO) {
    var ecoCol = ee.ImageCollection('NASA/ECOSTRESS/L2T_LSTE/V2')
      .filterBounds(roi).filterDate(ECO_START, ECO_END)
      .filter(ee.Filter.calendarRange(M1, M2, 'month'))
      .filter(ee.Filter.or(ee.Filter.calendarRange(19, 23, 'hour'),
                           ee.Filter.calendarRange(0, 2, 'hour')))
      .map(function (img) {
        var clear = img.select('cloud').bitwiseAnd(1).eq(0).and(img.select('LST_err').lte(2));
        var t = img.select('LST').subtract(273.15).updateMask(clear).updateMask(landM).rename('t');
        var cover = clear.unmask(0).reduceRegion({reducer: ee.Reducer.mean(), geometry: roi,
                                                  scale: 100, maxPixels: 1e9}).values().get(0);
        var ref = t.updateMask(rural).reduceRegion({reducer: ee.Reducer.mean(), geometry: roi,
                                                    scale: 100, maxPixels: 1e9}).get('t');
        return t.set({cover: cover, ref: ref, 'system:time_start': img.get('system:time_start')});
      })
      .filter(ee.Filter.gte('cover', ECO_MIN_COVER))
      .filter(ee.Filter.notNull(['ref']));
    var ecoDtCol = ecoCol.map(function (img) {
      return img.subtract(ee.Number(img.get('ref'))).rename('dT_night70');
    });
    ecoLst = ecoCol.mean().rename('LST_night70').unmask(-999);
    ecoDT = ecoDtCol.mean().rename('dT_night70').unmask(-999);
    ecoN = ecoDtCol.count().rename('n_night70').unmask(0);
  } else {
    ecoLst = ee.Image.constant(-999).rename('LST_night70');
    ecoDT = ee.Image.constant(-999).rename('dT_night70');
    ecoN = ee.Image.constant(0).rename('n_night70');
  }

  // UTFVI (відносно середньої LST забудови, у кельвінах)
  var lstK = lst.add(273.15);
  var meanK = ee.Number(mean(lstK.updateMask(urban), roi, SCALE).get('LST'));
  var utfvi = lstK.subtract(meanK).divide(meanK).rename('UTFVI');

  var HG = ghslH.unmask(0).rename('H_ghsl');   // GHSL завжди додаємо у вибірку для порівняння з OSM
  var stack = ee.Image.cat([lst, dT, ndvi, ndbi, alb, H, F, K, utfvi, dTn, HG, HT, ST,
                              ecoLst, ecoDT, ecoN, CL]);
  var m = mean(stack.updateMask(urban), roi, SCALE);
  var share = function (img) {
    return mean(img.updateMask(urban), roi, SCALE).values().get(0);
  };

  var feat = ee.Feature(null, {
    city: name, id: c.id, buildings_source: src, coast_masked: !!c.coast,
    n_scenes: col.size(), rural_lst_c: ruralLST, rural_pixels: ruralN,
    rural_ndvi: mean(ndvi.updateMask(rural), roi, SCALE).get('NDVI'),
    mean_lst_c: m.get('LST'), mean_dT: m.get('dT'), mean_dT_night: m.get('dT_night'),
    share_dT_ge6: share(dT.gte(6)), share_dT_ge8: share(dT.gte(8)),
    share_utfvi_gt_0_010: share(utfvi.gt(0.010)),
    mean_ndvi: m.get('NDVI'), mean_ndbi: m.get('NDBI'), mean_albedo: m.get('albedo'),
    mean_H: m.get('H'), mean_f: m.get('f'), mean_K: m.get('K'),
    r_H_LST: corr(H, lst, urban, roi), r_K_LST: corr(K, lst, urban, roi),
    r_NDVI_LST: corr(ndvi, lst, urban, roi),
    mean_H_ghsl: m.get('H_ghsl'),
    r_H_osm_vs_ghsl: c.osm ? corr(H, HG, urban, roi) : null   // без OSM-шару порівнювати нема з чим
  });

  var sample = stack.addBands(ee.Image.pixelLonLat())
    .updateMask(urban).sample({region: roi, scale: SCALE, numPixels: N_SAMPLE,
                               seed: 42, dropNulls: true})
    .map(function (f) { return f.set({city: name, id: c.id}); });

  RES[name] = {roi: roi, dT: dT, K: K, ndvi: ndvi, lst: lst, urban: urban, H: H,
               rural: rural, dTn: dTn, utfvi: utfvi, c: c, ecoDT: ecoDT, ecoN: ecoN};
  return {feat: feat, sample: sample};
}

var feats = [], samples = [];
Object.keys(CITIES).forEach(function (n) {
  var r = analyse(n, CITIES[n]); feats.push(r.feat); samples.push(r.sample);
});
var table = ee.FeatureCollection(feats);
// діагностика: якщо mean_dT < 0, сільський еталон гарячіший за місто — перевірте rural_lst_c, rural_ndvi
print('Підсумок по містах', table.select(['city', 'n_scenes', 'rural_lst_c', 'rural_ndvi',
                                           'rural_pixels', 'mean_lst_c', 'mean_dT'], null, false));
var sampleAll = ee.FeatureCollection(samples).flatten();

if (RUN_EXPORTS) {
  Export.table.toDrive({collection: table, description: 'uhi_cities_summary',
                        fileFormat: 'CSV'});
  Export.table.toDrive({collection: sampleAll, description: 'uhi_cities_samples',
                        fileFormat: 'CSV'});
}

// ---------- 3а. РАСТРИ ДЛЯ САЙТУ ----------
// Один GeoTIFF на місто, 5 смуг (float32, nodata -9999), у сітці WEB_GRID:
//   1 dT_day   — ΔT вдень, °C (Landsat, уся суша в колі аналізу, не лише забудова)
//   2 dT_night — ΔT вночі, °C (ECOSTRESS; лише пікселі з n_night70 ≥ 5, як у статті)
//   3 utfvi    — UTFVI (безрозмірний)
//   4 ndvi     — NDVI (літня медіана Landsat)
//   5 urban    — 1 = забудова за Dynamic World, 0 = ні (для підпису у спливному вікні)
// Тип забудови в експорт не входить: його рахує prepare_web.py з <id>_osm_cls.tif.
// Файли падають у папку uhi_web на Google Drive під іменами web_<id>.tif.
var MIN_NIGHT_N = 5;
if (RUN_WEB_EXPORTS) {
  Object.keys(CITIES).forEach(function (n) {
    var R = RES[n], g = WEB_GRID[R.c.id];
    if (!g) { print('Немає WEB_GRID для ' + R.c.id + ', пропускаю'); return; }
    var web = ee.Image.cat([
      R.dT.rename('dT_day'),
      R.ecoDT.updateMask(R.ecoN.gte(MIN_NIGHT_N)).rename('dT_night'),
      R.utfvi.rename('utfvi'),
      R.ndvi.rename('ndvi'),
      R.urban.unmask(0).rename('urban')
    ]).clip(R.roi).toFloat().unmask(-9999, false);
    var region = ee.Geometry.Rectangle(
      [g.x0, g.y0 - g.h * SCALE, g.x0 + g.w * SCALE, g.y0], ee.Projection(g.crs), false);
    Export.image.toDrive({
      image: web, description: 'web_' + R.c.id, fileNamePrefix: 'web_' + R.c.id,
      folder: 'uhi_web', region: region, crs: g.crs,
      crsTransform: [SCALE, 0, g.x0, 0, -SCALE, g.y0],
      maxPixels: 1e9, fileFormat: 'GeoTIFF', formatOptions: {noData: -9999}
    });
  });
}

// ---------- 4. КАРТА З ВИБОРОМ МІСТА ----------
function show(name) {
  var R = RES[name];
  Map.layers().reset();
  Map.centerObject(R.roi, R.c.r > 15 ? 11 : 12);
  Map.addLayer(R.dT.updateMask(R.urban).clip(R.roi),
    {min: -2, max: 10, palette: ['#2c7bb6', 'white', 'yellow', 'orange', 'red', 'purple']},
    'ΔT: перегрів над сільським фоном, °C (синє — прохолодніше за еталон)', true);
  Map.addLayer(R.lst.clip(R.roi),
    {min: 25, max: 50, palette: ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c']},
    'LST, °C (абсолютна, без еталона)', false);
  Map.addLayer(R.K.clip(R.roi),
    {min: 0, max: 8, palette: ['white', '#e3b04b', '#8c3b12']},
    'K: зони вірогідного утворення каньйонів (H·f)', false);
  Map.addLayer(R.H.clip(R.roi),
    {min: 0, max: 30, palette: ['white', 'yellow', 'orange', 'red', 'purple']},
    'Висота будівель, м (' + (R.c.osm ? 'OSM' : 'GHSL') + ')', false);
  Map.addLayer(R.ndvi.updateMask(R.urban).clip(R.roi),
    {min: 0, max: 0.8, palette: ['#8a5a2b', '#d6a84a', '#8dba5a', '#1b7a3a']},
    'NDVI (лише забудова)', false);
  Map.addLayer(R.dTn.clip(R.roi),
    {min: -2, max: 6, palette: ['blue', 'white', 'orange', 'red']},
    'ΔT вночі, MODIS (1 км)', false);
  // UTFVI за класами: 0 <0 (відмінна), 1 0–0.005, 2 0.005–0.010, 3 0.010–0.015,
  // 4 0.015–0.020, 5 >0.020 (найгірша)
  var u = R.utfvi;
  var uCls = u.gte(0).add(u.gte(0.005)).add(u.gte(0.010))
              .add(u.gte(0.015)).add(u.gte(0.020));
  Map.addLayer(uCls.updateMask(R.urban).clip(R.roi),
    {min: 0, max: 5, palette: ['#1a9850', '#91cf60', '#d9ef8b', '#fee08b', '#f46d43', '#a50026']},
    'UTFVI: екологічна оцінка (0 відмінна … 5 найгірша)', false);
  Map.addLayer(R.rural.selfMask().clip(R.roi), {palette: ['#00aa00']},
    'Сільський еталон (контроль)', false);
}

var select = ui.Select({items: Object.keys(CITIES), value: 'Івано-Франківськ',
                        onChange: show, style: {stretch: 'horizontal'}});
Map.add(ui.Panel([ui.Label('Місто:', {fontWeight: 'bold'}), select],
                 ui.Panel.Layout.flow('vertical'), {position: 'top-left', width: '220px'}));
Map.setOptions('HYBRID');
show('Івано-Франківськ');

// ПРИМІТКИ:
// • Після запуску відкрийте вкладку Tasks і натисніть Run для двох експортів.
// • Таблиця uhi_cities_summary — основа порівняння міст; uhi_cities_samples — для регресії/GWR у Python.
// • Київ: за потреби зменшіть N_SAMPLE або r, якщо Earth Engine повідомляє про перевищення пам'яті.
