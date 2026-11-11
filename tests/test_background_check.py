"""保存後の検査の範囲・版・GUI の書き出し続行。ブラウザは偽物で検証する。"""
import asyncio
import json
from concurrent.futures import Future
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from conftest import add_deck
from slide_studio import background_check as bg, check, export, shots, source
from slide_studio.fsutil import sha256_text
from slide_studio.server import StudioServer, build_app
from slide_studio.workspace import StudioError

TEXT = '---\ntopic: test\ntitle: Talk\n---\n\n## A {#a}\n\n本文。\n\n## B {#b}\n\n別の本文。\n'


def rendered(text, cited=()):
    doc = source.parse(text)
    return SimpleNamespace(doc=doc, cited=list(cited), slides=[{'index': p.index, 'page': p.index, 'id': p.id} for p in doc.pages])


def snap(ws, text=TEXT, cited=()):
    return bg.snapshot(ws, 'talk', rendered(text, cited))


def test_scope_body_citations_pages_and_unknown(ws):
    add_deck(ws, 'talk', TEXT)
    before = snap(ws)
    after = snap(ws, TEXT.replace('本文。', '更新。', 1))
    assert bg.affected(ws, 'talk', before, after) == [0]
    assert bg.affected(ws, 'talk', None, after) is None
    assert bg.affected(ws, 'talk', before, snap(ws, TEXT + '\n## C {#c}\n\n本文。')) is None
    assert bg.affected(ws, 'talk', before, snap(ws, TEXT.replace('本文。', '[@new]。', 1), ['new'])) is None
    assert bg.affected(ws, 'talk', before, snap(ws, TEXT.replace('本文。', '更新。'))) is None
    assert bg.affected(ws, 'talk', before, snap(ws, TEXT.replace('title: Talk', 'title: New'))) is None


def test_scope_figure_only_and_shared_dependencies(ws):
    text = TEXT.replace('本文。', '{{< fig test/box >}}', 1)
    add_deck(ws, 'talk', text)
    fig = ws.figure_dir('test/box', 'talk')
    fig.mkdir(parents=True)
    f = fig / 'figure.mjs'
    f.write_text('old')
    before = snap(ws, text)
    f.write_text('new')
    assert bg.affected(ws, 'talk', before, snap(ws, text)) == [0]
    before = snap(ws, text)
    (ws.deck_dir('talk') / 'styles/slides.css').write_text('p {color:red}')
    assert bg.affected(ws, 'talk', before, snap(ws, text)) is None


def test_image_change_invalidates_version(ws):
    add_deck(ws, 'talk', TEXT)
    before = snap(ws)
    (ws.asset_root('talk') / 'images/a.png').write_bytes(b'new')
    after = snap(ws)
    assert before.version != after.version
    assert bg.affected(ws, 'talk', before, after) is None


def test_cached_result_stale_when_dependency_changes(ws):
    add_deck(ws, 'talk', TEXT)
    srv = StudioServer(ws)
    checker = bg.BackgroundChecks(srv, None)
    path = ws.build_dir('talk') / 'checks.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({'version': check.deck_version(ws, 'talk'), 'errors': [], 'warnings': []}))
    assert checker.state('talk')['stale'] is False
    (ws.bib('talk')).write_text('changed')
    assert checker.state('talk')['stale'] is True


def test_disabled_background_check(ws):
    checker = bg.BackgroundChecks(StudioServer(ws), None)
    checker('rendered', 'talk')
    assert not checker.tasks


def test_browser_worker_reuses_browser_and_serializes(monkeypatch, ws):
    opened, calls = [], []
    class Browser:
        def __init__(self):
            opened.append(self)
        def close(self):
            calls.append('closed')
    monkeypatch.setattr(check, 'Browser', Browser)
    worker = shots.Shooter(StudioServer(ws))
    try:
        a = worker.submit(lambda b: (calls.append('a'), b)[1])
        b = worker.submit(lambda b: (calls.append('b'), b)[1])
        assert a.result(timeout=2) is b.result(timeout=2)
        assert len(opened) == 1 and calls == ['a', 'b']
    finally:
        worker.stop()
    assert calls[-1] == 'closed'


def test_background_checks_latest_save_after_running_check(ws, monkeypatch):
    add_deck(ws, 'talk', TEXT)
    srv = StudioServer(ws)
    srv.state('talk').rendered = rendered(TEXT)
    futures, works = [], []
    monkeypatch.setattr(check, 'check_deck', lambda *a, **kw: {'errors': [], 'warnings': [], 'checked_at': 1})
    class Worker:
        def submit(self, work, **kw):
            f = Future()
            futures.append(f)
            works.append(work)
            return f
    checker = bg.BackgroundChecks(srv, Worker())
    monkeypatch.setattr(bg, 'ENABLED', True)
    async def run():
        checker('rendered', 'talk')
        await asyncio.sleep(0)
        newer = TEXT.replace('本文。', '更新。', 1)
        ws.qmd('talk').write_text(newer)
        srv.state('talk').rendered = rendered(newer)
        checker('rendered', 'talk')
        futures[0].set_result(works[0](None))
        for _ in range(20):
            await asyncio.sleep(0)
            if len(futures) > 1:
                break
        assert len(futures) == 2
        futures[1].set_result(works[1](None))
        await checker.tasks['talk']
        assert checker.state('talk')['stale'] is False
        assert checker.state('talk')['result']['version']['qmd'] == sha256_text(newer)
    asyncio.run(run())


def test_gui_build_blocks_then_rechecks_and_forces(ws, monkeypatch):
    add_deck(ws, 'talk', TEXT)
    browser = object()
    calls = []
    def submit(self, work, **kw):
        f = Future()
        try:
            f.set_result(work(browser))
        except Exception as e:
            f.set_exception(e)
        return f
    result = {'version': check.deck_version(ws, 'talk'), 'errors': [{'kind': 'overflow', 'message': 'はみ出し'}], 'warnings': []}
    def checked(*args, **kw):
        assert kw['browser'] is browser
        calls.append('check')
        return result
    def built(*args, **kw):
        assert kw['force'] and kw['browser'] is browser and kw['result'] is result
        calls.append('build')
        return [ws.deck_dir('talk') / 'talk.html', ws.deck_dir('talk') / 'talk.pdf']
    monkeypatch.setattr(shots.Shooter, 'submit', submit)
    monkeypatch.setattr(check, 'check_deck', checked)
    monkeypatch.setattr(export, 'build', built)
    client = TestClient(build_app(ws))
    body = {'base': sha256_text(TEXT)}
    response = client.post('/api/deck/talk/build', json=body)
    assert response.json()['blocked'] is True and calls == ['check']
    response = client.post('/api/deck/talk/build', json={**body, 'force': True})
    assert len(response.json()['files']) == 2 and calls == ['check', 'check', 'build']
    assert client.post('/api/deck/talk/build', json={'base': 'old', 'force': True}).status_code == 409


def test_cli_build_still_rejects_errors(ws, monkeypatch):
    from contextlib import nullcontext
    add_deck(ws, 'talk', TEXT)
    monkeypatch.setattr(check, '_browser', lambda b: nullcontext(object()))
    monkeypatch.setattr(check, 'check_deck', lambda *a, **kw: {'deck': 'talk', 'errors': [{'message': 'はみ出し', 'level': 'error'}], 'warnings': []})
    with pytest.raises(StudioError, match='検査にエラー'):
        export.build(ws, 'talk')


def test_force_build_keeps_error_report_and_writes_both_formats(ws, monkeypatch):
    from contextlib import nullcontext
    from slide_studio.fsutil import write_atomic
    add_deck(ws, 'talk', TEXT)
    report = {'deck': 'talk', 'errors': [{'message': 'はみ出し', 'level': 'error'}], 'warnings': []}
    def checked(*args, **kw):
        write_atomic(ws.build_dir('talk') / 'checks.json', json.dumps(report))
        return report
    def bundled(ws, deck):
        p = ws.deck_dir(deck) / f'{deck}.html'
        write_atomic(p, '<html></html>')
        return p
    def pdf(html, out, browser=None):
        write_atomic(out, b'pdf')
    monkeypatch.setattr(check, '_browser', lambda b: nullcontext(object()))
    monkeypatch.setattr(check, 'check_deck', checked)
    monkeypatch.setattr(export, 'bundle_deck', bundled)
    monkeypatch.setattr(export, 'pdf_from_html', pdf)
    paths = export.build(ws, 'talk', force=True)
    assert len(paths) == 2 and all(p.exists() for p in paths)
    assert check.load(ws, 'talk')['errors'] == report['errors']


def test_force_build_still_fails_when_rendering_fails(ws, monkeypatch):
    from contextlib import nullcontext
    from slide_studio.render import RenderError
    add_deck(ws, 'talk', TEXT)
    monkeypatch.setattr(check, '_browser', lambda b: nullcontext(object()))
    monkeypatch.setattr(check, 'check_deck', lambda *a, **kw: {'errors': [{'kind': 'pandoc'}]})
    def fail(*a):
        raise RenderError('描画できません')
    monkeypatch.setattr(export, 'render_deck', fail)
    with pytest.raises(RenderError):
        export.build(ws, 'talk', force=True)
    assert not (ws.deck_dir('talk') / 'talk.html').exists()


def test_partial_check_keeps_other_pages_without_duplicate_static_issues(ws, monkeypatch):
    add_deck(ws, 'talk', TEXT)
    r = rendered(TEXT)
    monkeypatch.setattr(check, 'render_deck', lambda *a: r)
    old = {'level': 'error', 'kind': 'overflow', 'slide': 1, 'step': 0, 'message': '古いページの問題'}
    fixed = {'level': 'error', 'kind': 'overflow', 'slide': 0, 'step': 0, 'message': '修正済み'}
    static = {'level': 'warning', 'kind': 'small', 'page': 1, 'message': '小さい文字'}
    monkeypatch.setattr(check, 'static_issues', lambda *a: [static.copy()])
    monkeypatch.setattr(check, 'browser_issues', lambda *a, **kw: ([], [{'steps': 1}, None], []))
    from slide_studio.fsutil import write_atomic
    write_atomic(ws.build_dir('talk') / 'checks.json', json.dumps({'errors': [old, fixed], 'warnings': [{**static, 'slide': 1, 'page_id': 'b'}], 'slides': []}))
    result = check.check_deck(ws, 'talk', slides=[0])
    assert result['errors'] == [old]
    assert len(result['warnings']) == 1


def test_shared_library_change_checks_all_pages(ws):
    text = TEXT.replace('本文。', '{{< fig test/box >}}', 1)
    add_deck(ws, 'talk', text)
    fig = ws.figure_dir('test/box', 'talk')
    shared = fig / '_lib' / 'shared.mjs'
    shared.parent.mkdir(parents=True)
    shared.write_text('old')
    (fig / 'figure.mjs').write_text("import './_lib/shared.mjs';")
    before = snap(ws, text)
    assert before.version == check.deck_version(ws, 'talk', text)
    shared.write_text('new')
    assert bg.affected(ws, 'talk', before, snap(ws, text)) is None


def test_html_export_skips_pdf_and_reports_progress(ws, monkeypatch):
    from contextlib import nullcontext
    add_deck(ws, 'talk', TEXT)
    monkeypatch.setattr(check, '_browser', lambda b: nullcontext(object()))
    html = ws.deck_dir('talk') / 'talk.html'
    monkeypatch.setattr(export, 'bundle_deck', lambda *a: html)
    def unexpected_pdf(*a, **kw):
        pytest.fail('HTML export must not generate PDF')
    monkeypatch.setattr(export, 'pdf_from_html', unexpected_pdf)
    values = []
    assert export.build(ws, 'talk', result={'errors': []}, format='html', progress=values.append) == [html]
    assert values == [45, 60, 100]
    with pytest.raises(StudioError, match='形式'):
        export.build(ws, 'talk', format='invalid')
