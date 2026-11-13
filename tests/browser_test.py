# Тест у безголовому Chromium: сайт із локального сервера, CDN-бібліотеки — з node_modules,
# підложка — порожній стиль (OpenFreeMap із пісочниці недоступний). Скриншоти — у tests/shots/.
import json, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
T = Path(__file__).parent; NM = T / 'node_modules'
SHOTS = T / 'shots'; SHOTS.mkdir(exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', str(T.parent / 'web')],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
BLANK = json.dumps({'version': 8, 'sources': {}, 'layers': [{'id': 'bg', 'type': 'background', 'paint': {'background-color': '#ece8e1'}}]})
LOCAL = {'maplibre-gl.js': NM / 'maplibre-gl/dist/maplibre-gl.js', 'maplibre-gl.css': NM / 'maplibre-gl/dist/maplibre-gl.css',
         'proj4.js': NM / 'proj4/dist/proj4.js'}
def route(r):
    u = r.request.url
    if 'openfreemap' in u: return r.fulfill(body=BLANK, content_type='application/json')
    for k, f in LOCAL.items():
        if u.endswith(k): return r.fulfill(path=str(f))
    if 'fonts.g' in u: return r.abort()
    return r.continue_()
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader'])
        for name, vp in [('desktop', {'width': 1280, 'height': 800}), ('mobile', {'width': 390, 'height': 844})]:
            pg = b.new_page(viewport=vp)
            pg.on('pageerror', lambda e: errors.append(str(e)))
            pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
            pg.route('**/*', route)
            pg.goto('http://localhost:8765/map.html#city=ivano_frankivsk&layer=dt_day')
            pg.wait_for_function("document.querySelectorAll('#cities .chip').length >= 5", timeout=15000)
            pg.wait_for_timeout(2500)
            box = pg.locator('#map').bounding_box()
            pg.mouse.click(box['x'] + box['width'] * .5, box['y'] + box['height'] * (.45 if name == 'desktop' else .3))
            pg.wait_for_timeout(1200)
            print(name, '→', pg.locator('#info').inner_text().replace('\n', ' | ')[:400])
            pg.screenshot(path=str(SHOTS / f'{name}_clicked.png'))
            if name == 'desktop':
                pg.locator('#layers .layer').nth(2).click(); pg.wait_for_timeout(800)
                pg.screenshot(path=str(SHOTS / 'desktop_utfvi.png'))
                pg.locator('#cities .chip').nth(1).click(); pg.wait_for_timeout(2000)
                pg.screenshot(path=str(SHOTS / 'desktop_kyiv.png'))
                print('url після перемикань:', pg.url)
        b.close()
finally:
    srv.terminate()
print('ПОМИЛКИ:', errors or 'немає')
