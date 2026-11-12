# Скриншоти текстових сторінок (повна висота) на комп'ютері й телефоні + помилки консолі.
import subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
T = Path(__file__).parent; SH = T / 'shots'; SH.mkdir(exist_ok=True)
pages = sys.argv[1:] or ['compare.html', 'methodology.html']
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8766', '-d', str(T.parent / 'web')],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        for pg_name in pages:
            for dev, vp in [('desktop', {'width': 1200, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
                pg = b.new_page(viewport=vp)
                pg.on('pageerror', lambda e: errs.append(f'{pg_name}: {e}'))
                pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errs.append(m.text))
                pg.route('**/fonts.g*/**', lambda r: r.abort())
                pg.goto(f'http://localhost:8766/{pg_name}'); pg.wait_for_timeout(1200)
                w = pg.evaluate('document.documentElement.scrollWidth')
                print(pg_name, dev, 'ширина документа', w, '(горизонтальний скрол!)' if w > vp['width'] else '')
                pg.screenshot(path=str(SH / f'{pg_name[:-5]}_{dev}.png'), full_page=True)
        b.close()
finally:
    srv.terminate()
print('ПОМИЛКИ:', errs or 'немає')
