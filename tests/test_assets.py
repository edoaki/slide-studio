"""素材の保存・一覧・挿入補助と、その HTTP API（ブラウザ不要）。"""
import base64
import re
from types import SimpleNamespace

import pytest
from bs4 import BeautifulSoup
from starlette.testclient import TestClient

from conftest import add_deck
from slide_studio import assets, figures
from slide_studio.server import build_app
from slide_studio.workspace import StudioError

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=')
DOC = '---\ntopic: test\n---\n\n## A {#a}\n\n本文。\n'
BIB = '''@article{alpha,
 title = {A {Nested} Title},
 author = {Doe, Jane and Roe, Richard},
 year = 2024,
 slide-studio-status = {unverified}
}
@book{beta,
 title = "Second title",
 author = {山田 太郎},
 year = {2025}
}
@misc{empty,
 title = {Only title}
}
@comment{ignored, title = {Not an entry}}
@string{publisher = {Also ignored}}
'''


@pytest.fixture
def deck(ws):
    add_deck(ws, 'talk', DOC, BIB)
    return ws.asset_root('talk')


def test_add_deduplicates_and_numbers_collisions(ws, deck):
    first = assets.add(ws, 'talk', 'plot.png', PNG)
    assert first == dict(kind='images', path='images/plot.png', name='plot.png', reused=False)
    same = assets.add(ws, 'talk', 'another.png', PNG)
    assert same == {**first, 'reused': True}
    for n in (2, 3):
        data = PNG + bytes([n])
        added = assets.add(ws, 'talk', 'plot.png', data)
        assert added['path'] == f'images/plot-{n}.png'
        assert added['reused'] is False
        assert (deck / added['path']).read_bytes() == data
    assert (deck / first['path']).read_bytes() == PNG
    assert len(list((deck / 'images').iterdir())) == 3


def test_add_html_clipboard_and_safe_filename(ws, deck):
    html = assets.add(ws, 'talk', '../My (chart).HTML', b'<h1>chart</h1>')
    assert html['path'] == 'html/My-chart.html'
    assert (deck / html['path']).read_bytes() == b'<h1>chart</h1>'
    pasted = assets.add(ws, 'talk', 'image.png', PNG)
    assert re.fullmatch(r'images/paste-\d{8}-\d{6}\.png', pasted['path'])
    assert (deck / pasted['path']).read_bytes() == PNG
    inferred = assets.add(ws, 'talk', 'vector', b'<svg/>', 'image/svg+xml')
    assert inferred['path'] == 'images/vector.svg'


@pytest.mark.parametrize('name', ['notes.txt', 'script.js', 'file.pdf', ''])
def test_add_rejects_unsupported_files_without_writing(ws, deck, name):
    before = set(deck.rglob('*'))
    with pytest.raises(StudioError, match='画像か HTML'):
        assets.add(ws, 'talk', name, b'not an image')
    assert set(deck.rglob('*')) == before


def test_add_size_boundary(ws, deck):
    data = b'x' * (50 * 1024 * 1024)
    result = assets.add(ws, 'talk', 'limit.png', data)
    assert (deck / result['path']).stat().st_size == len(data)
    with pytest.raises(StudioError, match='50MB'):
        assets.add(ws, 'talk', 'too-large.png', data + b'x')
    assert not (deck / 'images/too-large.png').exists()


def test_figure_status_ok_and_template_warnings(ws, deck):
    fig = figures.new_figure(ws, 'chart', deck / 'html')
    assert assets.figure_status(ws, fig) == ('ok', [])
    (fig / 'index.html').unlink()
    status, reasons = assets.figure_status(ws, fig)
    assert status == 'warn' and any('index.html がありません' in r for r in reasons)
    (fig / 'index.html').write_text('<p>custom</p>')
    status, reasons = assets.figure_status(ws, fig)
    assert status == 'warn' and any('雛形と違います' in r for r in reasons)


@pytest.mark.parametrize(('code', 'reason'), [
    (None, 'figure.mjs がありません'),
    ('const x = 1;', 'export default'),
    ('export default {};', 'renderStep'),
    ('export default {renderStep() { fetch("data.json"); }}', 'fetch'),
    ('export default {renderStep() { import("./dynamic.mjs"); }}', '動的 import'),
    ('import x from "./missing.mjs"; export default {renderStep() {}}', '部品がありません'),
    ('import x from "https://example.com/x.mjs"; export default {renderStep() {}}', '外部'),
])
def test_figure_status_invalid_modules(ws, deck, code, reason):
    fig = deck / 'html/bad'
    fig.mkdir()
    if code is not None:
        (fig / 'figure.mjs').write_text(code)
    status, reasons = assets.figure_status(ws, fig)
    assert status == 'ng'
    assert any(reason in r for r in reasons)


def test_figure_status_checks_css_and_unreadable_module(ws, deck):
    fig = figures.new_figure(ws, 'chart', deck / 'html')
    (fig / 'style.css').write_text('@import "https://example.com/theme.css";')
    status, reasons = assets.figure_status(ws, fig)
    assert status == 'ng' and any('style.css' in r for r in reasons)
    (fig / 'figure.mjs').write_bytes(b'\xff')
    assert assets.figure_status(ws, fig) == ('ng', ['figure.mjs を読めません'])


def test_listing_groups_status_and_page_usage(ws, deck):
    assets.add(ws, 'talk', 'plot.png', PNG)
    assets.add(ws, 'talk', 'loose.htm', b'<script src="https://example.com/x.js"></script><script>fetch("x")</script>')
    figures.new_figure(ws, 'shared', ws.shelf_dir('test'))
    local = figures.new_figure(ws, 'local', deck / 'html')
    (local / 'index.html').unlink()
    (deck / 'images/ignored.txt').write_text('ignore')
    (deck / 'images/.hidden.png').write_bytes(PNG)
    ws.qmd('talk').write_text(DOC + '\n![](images/plot.png)\n\n![](images/plot.png)\n\n{{< fig test/shared >}}\n\n## B {#b}\n\n![](images/plot.png)\n')
    result = assets.listing(ws, 'talk')
    assert result['shelf'] == 'test'
    assert len(result['images']) == 1
    img = result['images'][0]
    assert (img['path'], img['used'], img['size']) == ('images/plot.png', 2, len(PNG))
    assert img['url'].startswith('/files/topics/test/images/plot.png')
    html = {item['name']: item for item in result['html']}
    assert set(html) == {'shared', 'local', 'loose.htm'}
    assert (html['shared']['ref'], html['shared']['status'], html['shared']['used']) == ('test/shared', 'ok', 1)
    assert html['shared']['reasons'] == []
    assert (html['local']['ref'], html['local']['status']) == ('test/local', 'warn')
    assert html['local']['reasons'] and html['local']['url'] is None
    assert html['loose.htm']['status'] == 'ng'
    assert len(html['loose.htm']['reasons']) == 3
    assert html['loose.htm']['path'] == 'html/loose.htm'


def test_bib_entries_and_missing_bibliography(ws, deck):
    assert assets.bib_entries(ws, 'talk') == [
        dict(key='alpha', title='A Nested Title', author='Doe ほか', year='2024', unverified=True),
        dict(key='beta', title='Second title', author='山田 太郎', year='2025', unverified=False),
        dict(key='empty', title='Only title', author='', year='', unverified=False),
    ]
    (ws.bib('talk')).unlink()
    assert assets.bib_entries(ws, 'talk') == []


def test_math_html_real_conversion():
    assert assets.math_html(' \n ') == ''
    soup = BeautifulSoup(assets.math_html(r'\frac{x}{2}'), 'html.parser')
    assert soup.find('math') is not None
    assert soup.find('mfrac') is not None
    assert soup.find('mi').text == 'x'


@pytest.mark.parametrize(('returncode', 'stdout', 'stderr', 'message'), [
    (1, '', 'conversion failed', 'conversion failed'),
    (0, '<p>not math</p>', '', '数式として読めません'),
])
def test_math_html_conversion_errors(monkeypatch, returncode, stdout, stderr, message):
    monkeypatch.setattr(assets.pandoc_worker, 'run', lambda *a, **kw: SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))
    with pytest.raises(StudioError, match=message):
        assets.math_html('x')


def test_assets_api_raw_upload_listing_and_errors(ws, deck):
    with TestClient(build_app(ws)) as client:
        response = client.post('/api/deck/talk/assets', params={'name': '日本語.png'}, content=PNG, headers={'Content-Type': 'image/png'})
        assert response.status_code == 200
        item = response.json()
        assert item['path'] == 'images/日本語.png' and item['reused'] is False
        assert (deck / item['path']).read_bytes() == PNG
        response = client.post('/api/deck/talk/assets?name=again.png', content=PNG)
        assert response.status_code == 200 and response.json()['reused'] is True
        response = client.post('/api/deck/talk/assets?name=chart.html', content=b'<p>chart</p>')
        assert response.status_code == 200 and response.json()['path'] == 'html/chart.html'
        response = client.get('/api/deck/talk/assets')
        assert response.status_code == 200
        assert [x['path'] for x in response.json()['images']] == ['images/日本語.png']
        assert response.json()['html'][0]['status'] == 'ng'
        response = client.post('/api/deck/talk/assets?name=no.txt', content=b'no')
        assert response.status_code == 400 and '画像か HTML' in response.json()['error']
        for method in ('get', 'post'):
            assert getattr(client, method)('/api/deck/missing/assets').status_code == 404


def test_bib_and_math_api(ws, deck, monkeypatch):
    with TestClient(build_app(ws)) as client:
        response = client.get('/api/deck/talk/bib')
        assert response.status_code == 200
        assert response.json() == {'entries': assets.bib_entries(ws, 'talk')}
        assert client.get('/api/deck/missing/bib').status_code == 404
        response = client.post('/api/math', json={'tex': r'\sqrt{x}'})
        assert response.status_code == 200
        assert BeautifulSoup(response.json()['html'], 'html.parser').find('msqrt') is not None
        assert client.post('/api/math', json={'tex': ''}).json() == {'html': ''}
        def fail(tex):
            raise StudioError('数式を変換できません')
        monkeypatch.setattr(assets, 'math_html', fail)
        response = client.post('/api/math', json={'tex': 'invalid'})
        assert response.status_code == 400 and response.json()['error'] == '数式を変換できません'


def test_delete_moves_to_trash_and_restore_puts_back(ws, deck):
    (deck / 'images/a.png').write_bytes(PNG)
    (deck / 'images/b.png').write_bytes(PNG + b'b')
    figures.new_figure(ws, 'chart', ws.shelf_dir('test'))
    add_deck(ws, 'other', '---\ntopic: test\n---\n\n## A\n\n![](images/a.png)\n\n{{< fig test/chart >}}\n')
    listed = assets.listing(ws, 'talk')
    assert {x['path']: x['others'] for x in listed['images']} == {'images/a.png': ['other'], 'images/b.png': []}
    assert [(x['path'], x['others']) for x in listed['html']] == [('html/chart', ['other'])]
    out = assets.delete(ws, 'talk', ['images/a.png', 'html/chart'])
    assert [x['path'] for x in out] == ['images/a.png', 'html/chart']
    assert not (deck / 'images/a.png').exists() and not (deck / 'html/chart').exists()
    assert (ws.root / out[0]['trash']).read_bytes() == PNG and (ws.root / out[1]['trash'] / 'figure.mjs').is_file()
    assert [x['path'] for x in assets.listing(ws, 'talk')['images']] == ['images/b.png']
    # 1つでも見つからなければ何も消さない
    with pytest.raises(StudioError, match='見つかりません'):
        assets.delete(ws, 'talk', ['images/b.png', 'images/a.png'])
    assert (deck / 'images/b.png').exists()
    assets.restore(ws, 'talk', out)
    assert (deck / 'images/a.png').read_bytes() == PNG and (deck / 'html/chart/figure.mjs').is_file()
    # 戻す先に同じ名前があれば上書きしない
    again = assets.delete(ws, 'talk', ['images/a.png'])
    (deck / 'images/a.png').write_bytes(b'new')
    with pytest.raises(StudioError, match='同じ名前'):
        assets.restore(ws, 'talk', again)
    assert (deck / 'images/a.png').read_bytes() == b'new'


@pytest.mark.parametrize('paths', [
    ['html/chart', 'html/chart/extra.html'],
    ['html/chart/extra.html', 'html/chart'],
])
def test_delete_parent_and_child_assets_together_can_be_restored(ws, deck, paths):
    figures.new_figure(ws, 'chart', deck / 'html')
    extra = deck / 'html/chart/extra.html'
    extra.write_text('<p>追加の HTML</p>')
    listed = assets.listing(ws, 'talk')
    assert set(paths) <= {item['path'] for item in listed['html']}

    removed = assets.delete(ws, 'talk', paths)

    assert [item['path'] for item in removed] == ['html/chart']
    assert not (deck / 'html/chart').exists()
    saved = ws.root / removed[0]['trash']
    assert (saved / 'figure.mjs').is_file()
    assert (saved / 'extra.html').read_text() == '<p>追加の HTML</p>'
    assets.restore(ws, 'talk', removed)
    assert (deck / 'html/chart/figure.mjs').is_file()
    assert extra.read_text() == '<p>追加の HTML</p>'


@pytest.mark.parametrize('path', ['slides.qmd', 'images', '../x/images/a.png', 'images/../../a.png', 'images/.hidden', 'reference.bib'])
def test_delete_refuses_outside_assets(ws, deck, path):
    with pytest.raises(StudioError, match='場所が正しくありません'):
        assets.delete(ws, 'talk', [path])


def test_restore_refuses_outside_trash(ws, deck):
    (deck / 'images/a.png').write_bytes(PNG)
    for trash in ['decks/talk/slides.qmd', '.slide-studio/trash/_assets/test/../../../decks/talk/slides.qmd', '.slide-studio/trash/_assets/test']:
        with pytest.raises(StudioError, match='ごみ箱の場所'):
            assets.restore(ws, 'talk', [{'path': 'images/x.png', 'trash': trash}])


def test_assets_delete_api(ws, deck):
    (deck / 'images/a.png').write_bytes(PNG)
    with TestClient(build_app(ws)) as client:
        response = client.post('/api/deck/talk/assets/delete', json={'paths': ['images/a.png']})
        assert response.status_code == 200
        items = response.json()['items']
        assert items[0]['path'] == 'images/a.png' and not (deck / 'images/a.png').exists()
        response = client.post('/api/deck/talk/assets/restore', json={'items': items})
        assert response.status_code == 200 and (deck / 'images/a.png').exists()
        assert client.post('/api/deck/talk/assets/delete', json={'paths': ['slides.qmd']}).status_code == 400
        assert client.post('/api/deck/talk/assets/nope', json={}).status_code == 404
        assert client.post('/api/deck/missing/assets/delete', json={}).status_code == 404
