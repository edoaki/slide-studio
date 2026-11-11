"""トピック画面の一覧・形式・割り当てと削除 API。"""
import pytest
from starlette.testclient import TestClient

from conftest import add_deck
from slide_studio import figures, library
from slide_studio.fsutil import write_atomic
from slide_studio.server import build_app
from slide_studio.workspace import StudioError


def test_topic_listing(ws):
    base = ws.shelf_dir('nco')
    figures.new_figure(ws, 'chart', base)
    write_atomic(base / 'plain/index.html', '<h1>Plain</h1>')
    write_atomic(base / 'notes.html', '<p>Notes</p>')
    write_atomic(base / '_lib/helper.html', '<p>Helper</p>')
    write_atomic(base / '_lib/nested/helper.js', 'export const x = 1;')
    add_deck(ws, 'assigned', '---\ntitle: Assigned\ntopic: nco\n---\n\n## One\n\n{{< fig nco/chart >}}\n')
    add_deck(ws, 'unused', '---\ntopic: nco\n---\n\n## Two\n')
    add_deck(ws, 'other', '---\ntopic: other\n---\n\n## Three\n\n{{< fig nco/chart >}}\n')
    out = library.topic_listing(ws, 'nco')
    assert {d['deck'] for d in out['recent']} == {'assigned', 'unused'}
    assert all(d['shots'] == [] and d['thumb'] is None for d in out['recent'])
    items = {i['path']: i for i in out['html']}
    assert set(items) == {'chart/index.html', 'plain/index.html', 'notes.html'}
    assert items['chart/index.html']['kind'] == 'figure'
    assert items['chart/index.html']['steps'] > 0
    assert set(items['chart/index.html']['decks']) == {'assigned', 'other'}
    assert items['plain/index.html']['status'] == 'ng'
    assert items['notes.html']['kind'] == 'html'
    assert out['shared_count'] == 2
    with TestClient(build_app(ws)) as client:
        assert client.get('/topic/nco').status_code == 200
        assert client.get('/api/topic/nco').json() == out
        assert client.get('/api/topic/missing').status_code == 404


def test_empty_and_unsafe_topics(ws):
    ws.shelf_dir('empty').mkdir(parents=True)
    assert library.topic_listing(ws, 'empty') == {'name': 'empty', 'recent': [], 'html': [], 'shared_count': 0, 'bib': [], 'bib_error': False}
    for name in ('../outside', 'missing'):
        with pytest.raises(StudioError):
            library.topic_listing(ws, name)
    write_atomic(ws.root / 'outside.html', 'private')
    (ws.shelf_dir('empty') / 'escape.html').symlink_to(ws.root / 'outside.html')
    assert library.topic_listing(ws, 'empty')['html'] == []


def test_topic_bib(ws):
    ws.shelf_dir('nco').mkdir(parents=True)
    write_atomic(ws.topic_dir('nco') / 'reference.bib', """@string{nips = "NeurIPS"}
@article{smith2020,
  author = {Smith, Jane and Doe, John and Roe, Ann},
  title = {{POMO}: Routing \\& Search},
  journal = {Journal of Tests},
  pages = {1--10},
  year = 2020,
  doi = {10.1/abc},
  slide-studio-status = {unverified}
}
@misc{lee, title = "Plain", author = {Kim Lee and {Acme Research and Development}}}
""")
    add_deck(ws, 'cites', '---\ntopic: nco\n---\n\n## One\n\nSee [@smith2020; @other]. Also @lee.\n')
    add_deck(ws, 'near', '---\ntopic: nco\n---\n\n## Two\n\n[@smith2020a] mail@lee.com\n')
    add_deck(ws, 'elsewhere', '---\ntopic: other\n---\n\n## Three\n\n[@lee]\n')
    out = library.topic_listing(ws, 'nco')
    assert out['bib_error'] is False
    smith, lee = out['bib']
    assert smith['key'] == 'smith2020' and smith['type'] == 'article' and smith['unverified']
    assert [a['family'] for a in smith['authors']] == ['Smith', 'Doe', 'Roe']
    assert smith['authors'][0]['name'] == 'Smith, Jane'
    assert smith['fields']['title'] == 'POMO: Routing & Search'
    assert smith['fields']['pages'] == '1–10' and smith['fields']['year'] == '2020'
    assert smith['decks'] == ['cites'] and lee['decks'] == ['cites']
    assert lee['authors'] == [{'name': 'Kim Lee', 'family': 'Lee'}, {'name': 'Acme Research and Development', 'family': 'Acme Research and Development'}]
    assert lee['fields']['title'] == 'Plain' and not lee['unverified']
    write_atomic(ws.topic_dir('nco') / 'reference.bib', '@article{broken, title = {x}\n')
    assert library.topic_listing(ws, 'nco')['bib_error'] is True


def test_delete_topic_moves_assets_to_trash(ws):
    ws.new_topic('unused')
    write_atomic(ws.topic_dir('unused') / 'images/example.svg', '<svg/>')
    with TestClient(build_app(ws)) as client:
        response = client.delete('/api/topic/unused')
        assert response.status_code == 200
        assert (ws.root / response.json()['trash'] / 'images/example.svg').read_text() == '<svg/>'
        assert client.get('/api/topic/unused').status_code == 404
        assert 'unused' not in {s['name'] for s in client.get('/api/home').json()['shelves']}
        assert client.delete('/api/topic/unused').status_code == 409
    ws.new_topic('unused')
    ws.remove_topic('unused')


@pytest.mark.parametrize('text', [
    '---\ntopic: used\n---\n',
    '---\ntopic: other\n---\n\n{{< fig used/chart >}}',
    '---\ntopic: other\n---\n\n![](../../topics/used/images/photo.png)',
])
def test_delete_topic_rejects_in_use(ws, text):
    ws.new_topic('used')
    add_deck(ws, 'talk', text)
    with TestClient(build_app(ws)) as client:
        response = client.delete('/api/topic/used')
        assert response.status_code == 409
        assert response.json()['error'] == 'topicInUse'
    assert ws.topic_dir('used').is_dir()
    assert ws.qmd('talk').read_text() == text


def test_delete_topic_rejects_unsafe_paths(ws, tmp_path):
    outside = tmp_path / 'outside'
    outside.mkdir()
    ws.topic_dir('linked').symlink_to(outside, target_is_directory=True)
    for name in ('../outside', 'linked', 'missing'):
        with pytest.raises(StudioError):
            ws.remove_topic(name)
    assert outside.is_dir()


def test_delete_selected_html(ws):
    base = ws.shelf_dir('test')
    figures.new_figure(ws, 'used', base)
    write_atomic(base / 'unused.html', '<p>Unused</p>')
    add_deck(ws, 'talk', '---\ntopic: test\n---\n\n## One\n\n{{< fig test/used >}}\n')
    with TestClient(build_app(ws)) as client:
        url = '/api/topic/test/html/delete'
        for paths, error in [(['unused.html', 'used/index.html'], 'htmlInUse'),
                             (['unused.html', '../outside.html'], 'htmlMissing'),
                             (['missing.html'], 'htmlMissing'), ([], 'htmlMissing'), (None, 'htmlMissing')]:
            response = client.post(url, json={'paths': paths})
            assert response.status_code == 409
            assert response.json()['error'] == error
            assert (base / 'unused.html').exists()
        response = client.post(url, json={'paths': ['unused.html', 'unused.html']})
        assert response.status_code == 200
        assert len(response.json()['items']) == 1
        assert (ws.root / response.json()['items'][0]['trash']).read_text() == '<p>Unused</p>'
        assert not (base / 'unused.html').exists()
        assert (base / 'used/index.html').exists()
