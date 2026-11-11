import asyncio
import json
from types import SimpleNamespace
from concurrent.futures import Future
from unittest.mock import Mock

import pytest

from slide_studio import shots, theme_shots
from slide_studio.fsutil import write_atomic


def fill_cache(ws, name):
    d = theme_shots.folder(ws, name)
    for i in range(4):
        write_atomic(d / f'{i}.png', b'png')
    write_atomic(d / 'index.json', json.dumps({'hash': theme_shots.current(ws, name)}))


def test_cache_css_hash_and_missing_images(ws):
    assert not theme_shots.cached(ws, 'default')
    fill_cache(ws, 'default')
    assert theme_shots.cached(ws, 'default')
    assert len(theme_shots.listing(ws, 'default')) == 4
    p = ws.themes / 'default.css'
    p.touch()
    assert theme_shots.cached(ws, 'default')
    write_atomic(p, p.read_text() + '\n/* changed */')
    assert not theme_shots.cached(ws, 'default')
    assert theme_shots.listing(ws, 'default') == []
    fill_cache(ws, 'default')
    (theme_shots.folder(ws, 'default') / '2.png').unlink()
    assert not theme_shots.cached(ws, 'default')


def test_cache_follows_sample(ws, tmp_path, monkeypatch):
    fill_cache(ws, 'default')
    (tmp_path / 'theme-sample.qmd').write_text((theme_shots.TEMPLATES / 'theme-sample.qmd').read_text() + '\n')
    monkeypatch.setattr(theme_shots, 'TEMPLATES', tmp_path)
    assert not theme_shots.cached(ws, 'default')


def test_file_hook_reuses_shooter_and_deduplicates(ws, monkeypatch):
    for name in ws.themes_list():
        fill_cache(ws, name)
    jobs = []
    def submit(work, *, background=False):
        assert background
        jobs.append(work)
        return Future()
    app = SimpleNamespace(state=SimpleNamespace(shots=SimpleNamespace(submit=submit, stopping=False)))
    srv = SimpleNamespace(ws=ws, starters=[], hooks=[])
    theme_shots.install(app, srv, [])
    hook = srv.hooks[0]
    p = ws.themes / 'default.css'
    write_atomic(p, p.read_text() + '\n')
    hook('files', ['themes/default.css'])
    assert not jobs  # conftest の shots.ENABLED で止まる
    monkeypatch.setattr(shots, 'ENABLED', True)
    hook('files', ['decks/one/slides.qmd'])
    assert not jobs
    hook('files', ['themes/default.css'])
    hook('files', ['themes/default.css'])
    assert len(jobs) == 1


@pytest.mark.parametrize('cancelled', [True, False])
def test_shutdown_does_not_report_cancelled_shots_or_schedule_more(ws, monkeypatch, cancelled):
    monkeypatch.setattr(shots, 'ENABLED', True)
    monkeypatch.setattr(ws, 'themes_list', lambda: ['default'])
    future = Future()
    shooter = SimpleNamespace(stopping=False, submit=Mock(return_value=future))
    app = SimpleNamespace(state=SimpleNamespace(shots=shooter))
    srv = SimpleNamespace(ws=ws, starters=[], hooks=[], broadcast=Mock())
    theme_shots.install(app, srv, [])

    async def main():
        errors = []
        asyncio.get_running_loop().set_exception_handler(lambda loop, ctx: errors.append(ctx))
        srv.starters[0]()
        shooter.stopping = True
        if cancelled:
            future.cancel()
        else:
            future.set_result(None)
        await asyncio.sleep(0)
        srv.hooks[0]('files', ['themes/default.css'])
        assert not errors
        assert shooter.submit.call_count == 1
        srv.broadcast.assert_not_called()

    asyncio.run(main())


def test_real_sample_has_four_pages(ws):
    # Chromium を使う実撮影。画像数・キャッシュを確認する。
    from slide_studio.check import Browser
    b = Browser()
    try:
        theme_shots.shoot(ws, 'night', b)
        assert theme_shots.cached(ws, 'night')
        assert len(theme_shots.listing(ws, 'night')) == 4
    finally:
        b.close()


def test_sample_render_without_browser(ws):
    from conftest import add_deck
    deck = add_deck(ws, 'theme-sample', '## User deck\n')
    write_atomic(deck / 'styles/slides.css', 'body { color: red }')
    rendered = theme_shots.render_sample(ws)
    assert len(rendered.slides) == 4
    assert [s['id'] for s in rendered.slides] == ['cover', 'chapter', 'body', 'table']
    assert '<svg' in rendered.html and '<table' in rendered.html
    assert 'slide-studio-deck-style' not in rendered.html


def test_override_is_served_with_its_own_type(tmp_path):
    # 見本はテーマの CSS を差し替えて撮る。text/html で返すとブラウザが CSS を無視する。
    from urllib.request import urlopen

    from slide_studio.httpd import StaticServer
    server = StaticServer(tmp_path)
    try:
        server.overrides['/themes/default.css'] = b':root { --ink: #000; }'
        server.overrides['/decks/x/sample.html'] = b'<html></html>'
        assert urlopen(server.url('/themes/default.css')).headers['Content-Type'].startswith('text/css')
        assert urlopen(server.url('/decks/x/sample.html')).headers['Content-Type'].startswith('text/html')
    finally:
        server.close()
