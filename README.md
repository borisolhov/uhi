# Острови тепла українських міст

Статичний сайт-карта: обираєте місто, перемикаєте шари (ΔT вдень, ΔT вночі, UTFVI, NDVI, тип забудови), клацаєте по карті або шукаєте адресу й бачите показники кварталу 100 × 100 м з коротким поясненням. Лише діагностика, без порад.

Пілотні міста: Івано-Франківськ, Київ, Львів, Чернівці, Ужгород.

> **Стан:** прототип. Поки в `web/data/` лежать **синтетичні** ΔT, UTFVI і NDVI (сайт показує попередження). Тип забудови вже справжній, з OpenStreetMap.

## Структура

```
gee/uhi_multicity.js      скрипт Earth Engine: аналіз + експорт растрів для сайту (розділ 3а)
data/osm/                 растри будівель OSM, сітка UTM 100 м (<id>_osm_bld, <id>_osm_cls)
data/raw/                 сюди кладуться web_<id>.tif з Google Drive (папка uhi_web)
scripts/prepare_web.py    GeoTIFF → PNG-шари (Web Mercator) + values.bin (UTM) + cities.json
scripts/make_synthetic.py синтетичні дані для тесту без Earth Engine
web/                      сам сайт (те, що публікується)
  data/layers.json        класи, кольори й пояснення шарів — спільні для скрипту й сайту
tests/                    перевірка кліку проти вихідних растрів, тест у браузері
```

## Як оновити дані

1. У Earth Engine запустити `gee/uhi_multicity.js`, у вкладці Tasks — задачі `web_<id>` (5 штук).
2. Завантажити `web_<id>.tif` з Google Drive (папка `uhi_web`) у `data/raw/`.
3. `pip install rasterio numpy pillow`, потім `python scripts/prepare_web.py`.
4. Перевірити локально: `python -m http.server -d web 8000` → http://localhost:8000.

## Як влаштовано

- **Картинки** шарів перепроєктовано в Web Mercator найближчим сусідом (значення не усереднюються).
- **Значення для кліку** зберігаються в оригінальній сітці UTM 100 м, тієї ж, що в Earth Engine і OSM. Браузер переводить координати кліку в UTM (proj4), тому число на сайті збігається з растром.
- `values.bin`: Int16, смуги підряд (`dt_day, dt_night, utfvi, ndvi, bld_type, urban`), масштаби й nodata в `cities.json`.
- Підложка: OpenFreeMap (Positron). Пошук адреси: Nominatim, лише за кнопкою «Знайти», не частіше 1 запиту на секунду, у межах обраного міста.

## Перевірки

```
cd tests && npm install proj4@2 maplibre-gl@4.7.1 && cd ..
python scripts/make_synthetic.py && python scripts/prepare_web.py --synthetic
python tests/make_points.py && node tests/check_lookup.mjs   # клік = вихідний растр (2000 точок)
python tests/browser_test.py                                 # безголовий Chromium, скриншоти в tests/shots/
```

## Атрибуція

Landsat 8/9 (USGS/NASA), ECOSTRESS (NASA), ESA WorldCover, GHSL (JRC), Dynamic World (Google, WRI). Будівлі © учасники OpenStreetMap, ліцензія ODbL. Підложка © OpenFreeMap, OpenMapTiles, OpenStreetMap.

Автор: Ольхов Борис, кафедра екології ІФНТУНГ.
