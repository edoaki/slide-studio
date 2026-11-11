"""テーマの4ページ見本。検査・書き出し用 Chromium で CSS の版ごとに撮る。"""
import asyncio
import json

from bs4 import BeautifulSoup

from . import shots, source
from .fsutil import sha256_text, write_atomic
from .httpd import StaticServer
from .render import _assemble, run_pandoc, LUA
from .workspace import TEMPLATES

ENABLED = True


def folder(ws, name):
    return ws.state / 'themes' / name


def version(css):
    # 見本の原稿を変えたときも撮り直す
    return sha256_text(css + (TEMPLATES / 'theme-sample.qmd').read_text())


def current(ws, name):
    return version((ws.themes / f'{name}.css').read_bytes().decode('utf-8'))


def cached(ws, name):
    try:
        d = folder(ws, name)
        return json.loads((d / 'index.json').read_text())['hash'] == current(ws, name) and all(
            (d / f'{i}.png').is_file() for i in range(4))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def listing(ws, name):
    if not cached(ws, name):
        return []
    stamp = current(ws, name)
    return [f'/files/.slide-studio/themes/{name}/{i}.png?v={stamp}' for i in range(4)]


def render_sample(ws, name='theme-sample.qmd', pages=4):
    """アプリが持つ見本の原稿を描く（縮小画像は4ページ、テーマのタブの見本は3ページ）。"""
    doc = source.parse((TEMPLATES / name).read_text())
    wrapped, origin = source.wrapped_source(doc)
    body, _ = run_pandoc(wrapped, ws.state, ['--lua-filter', str(LUA)], origin)
    rendered = _assemble(ws, 'theme-sample', doc, body, [])
    # 通常の発表に自動追加される文献・Appendix は、この見本には出さない。
    html = BeautifulSoup(rendered.html, 'html.parser')
    for link in html.select('#slide-studio-deck-style'):
        link.decompose()  # 同名の利用者発表があっても、専用 CSS を見本に混ぜない
    for slide in html.select('#stage > .slide')[pages:]:
        slide.decompose()
    for i, number in enumerate(html.select('.page-number')):
        number.string = f'{i + 1} / {pages}'
    rendered.html = str(html)
    rendered.slides = rendered.slides[:pages]
    return rendered


def shoot(ws, name, browser):
    css = (ws.themes / f'{name}.css').read_bytes().decode('utf-8')
    rendered = render_sample(ws)
    if len(rendered.slides) != 4:
        raise ValueError('テーマの見本は4ページ必要です')
    server = StaticServer(ws.root)
    ctx = browser.browser.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=1)
    try:
        server.overrides['/themes/default.css'] = css.encode()
        server.overrides['/decks/theme-sample/sample.html'] = rendered.html.encode()
        ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith((server.origin, 'data:', 'about:', 'blob:')) else r.abort())
        page = ctx.new_page()
        page.goto(server.url('/decks/theme-sample/sample.html'))
        page.wait_for_function('window.deckReady === true')
        page.evaluate("document.body.classList.add('export')")
        for i in range(4):
            page.evaluate('(i) => deck.go(i, 0)', i)
            write_atomic(folder(ws, name) / f'{i}.png', page.screenshot())
        write_atomic(folder(ws, name) / 'index.json', json.dumps({'hash': version(css)}))
    finally:
        ctx.close()
        server.close()


def install(app, srv, routes):
    pending = set()
    loop = None

    def request():
        if not ENABLED or not shots.ENABLED or app.state.shots.stopping:
            return
        for name in srv.ws.themes_list():
            if name in pending or cached(srv.ws, name):
                continue
            pending.add(name)
            future = app.state.shots.submit(lambda browser, name=name: shoot(srv.ws, name, browser), background=True)

            def done(f, name=name):
                def finish():
                    pending.discard(name)
                    if f.cancelled() or app.state.shots.stopping:
                        return
                    if f.exception():
                        print(f'テーマの縮小画像を作れません（{name}）: {f.exception()}')
                        return
                    srv.broadcast({'type': 'theme-shots', 'theme': name})
                    request()  # 撮影中の変更も取りこぼさない
                if loop and not loop.is_closed():
                    loop.call_soon_threadsafe(finish)
            future.add_done_callback(done)

    def start():
        nonlocal loop
        loop = asyncio.get_running_loop()
        request()

    srv.starters.append(start)
    srv.hooks.append(lambda kind, paths: request() if kind == 'files' and any(p.startswith('themes/') for p in paths) else None)
