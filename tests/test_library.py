"""トピック（同じ topic: の発表）から前に使った数式・画像・図を集め、他の発表から入れる（ブラウザ不要）。"""
import pytest
from bs4 import BeautifulSoup
from starlette.testclient import TestClient

from conftest import add_deck
from slide_studio import figures, library
from slide_studio.server import build_app
from slide_studio.workspace import StudioError

PNG = b'\x89PNG\r\n\x1a\nfake'
TALK = '''---
topic: test
---

## A {#a}

$$
\\frac{a}{b}
$$

文の中の $x_i$ と `$code$` と 5$ と $10 の値段。

| 名前 | 値 |
|---|---|
| 項目 | 42 |

![](images/mine.png)

```python
y = "$$\\notmath$$"
```
'''
OLD = '''---
topic: test
---

## B {#b}

$$\\frac{a}{b}$$

::: {.columns}
::: {.column}
$$
\\frac{a}{b} + c
$$
:::
:::

$$
\\frac{ a }{ b }
$$

![](images/plot.png){width=300}

![](../talk/images/mine.png)

{{< fig test/chart >}}

{{< fig test/shared >}}
'''
OTHER = '---\ntopic: elsewhere\n---\n\n## C {#c}\n\n$$\nzzz\n$$\n\n![](images/no.png)\n'


@pytest.fixture
def decks(ws):
    talk = add_deck(ws, 'talk', TALK)
    old = add_deck(ws, 'old', OLD)
    other = add_deck(ws, 'other', OTHER)
    (ws.asset_root('talk') / 'images' / 'mine.png').write_bytes(PNG)
    (ws.asset_root('old') / 'images' / 'plot.png').write_bytes(PNG + b'2')
    (ws.asset_root('other') / 'images' / 'no.png').write_bytes(PNG)
    figures.new_figure(ws, 'chart', ws.shelf_dir('test'))
    figures.new_figure(ws, 'shared', ws.shelf_dir('test'))
    return talk, old


def test_collect_from_decks_of_the_same_library(ws, decks):
    out = library.collect(ws, 'talk')
    assert out['shelf'] == 'test' and out['decks'] == ['talk', 'old']
    # 空白だけ違う数式は1つにまとめ、使った数の多い順。コード・値段の $ は数式にしない
    assert [(m['tex'], m['count'], m['decks'], m['display']) for m in out['math']] == [
        ('\\frac{a}{b}', 3, ['talk', 'old'], True),
        ('x_i', 1, ['talk'], False),
        ('\\frac{a}{b} + c', 1, ['old'], True),
    ]
    assert 'tables' not in out
    # 画像と図は他の発表のものだけ（この発表のものは素材の一覧にある）。発表の外を指す画像は出さない
    assert out['images'] == []
    assert out['figures'] == []


def test_collect_without_library_uses_only_this_deck(ws):
    add_deck(ws, 'solo', '## A {#a}\n\n$$\ny\n$$\n')
    out = library.collect(ws, 'solo')
    assert out['shelf'] is None and out['decks'] == ['solo']
    assert [m['tex'] for m in out['math']] == ['y']


def test_same_topic_reuses_and_other_topic_copies(ws, decks):
    before = sorted(ws.root.rglob('*'))
    assert library.take(ws, 'talk', 'image', 'old', 'images/plot.png')['reused'] is True
    assert library.take(ws, 'talk', 'figure', 'old', 'chart') == {'ref': 'test/chart', 'reused': True}
    assert sorted(ws.root.rglob('*')) == before
    figures.new_figure(ws, 'chart', ws.shelf_dir('elsewhere'))
    (ws.shelf_dir('elsewhere') / 'chart/figure.mjs').write_text('export default {renderStep() { return "<svg/>"; }}')
    assert library.take(ws, 'talk', 'figure', 'other', 'chart') == {'ref': 'test/chart-2', 'reused': False}
    assert library.take(ws, 'talk', 'image', 'other', 'images/no.png')['reused'] is True


@pytest.mark.parametrize('kind, src, path, message', [
    ('image', 'old', '../talk/images/mine.png', '画像がありません'),
    ('image', 'old', 'images/missing.png', '画像がありません'),
    ('figure', 'old', '../../talk', '図がありません'),
    ('figure', 'old', 'missing', '図がありません'),
    ('code', 'old', 'x', '種類'),
])
def test_take_rejects(ws, decks, kind, src, path, message):
    with pytest.raises(StudioError, match=message):
        library.take(ws, 'talk', kind, src, path)


def test_math_many_renders_in_one_batch(monkeypatch):
    library._mathml.clear()
    html = library.math_many(['\\sqrt{x}', 'a^2', '\\sqrt{x}'])
    assert BeautifulSoup(html[0], 'html.parser').find('msqrt') is not None
    assert BeautifulSoup(html[1], 'html.parser').find('msup') is not None
    assert html[2] == html[0]
    # 覚えた結果を使い、Pandoc を呼ばない
    monkeypatch.setattr(library.pandoc_worker, 'run', lambda *a, **kw: pytest.fail('pandoc called'))
    assert library.math_many(['a^2']) == [html[1]]


def test_library_api(ws, decks):
    with TestClient(build_app(ws)) as client:
        r = client.get('/api/deck/talk/library')
        assert r.status_code == 200
        body = r.json()
        assert [m['tex'] for m in body['math']][:1] == ['\\frac{a}{b}']
        assert BeautifulSoup(body['math'][0]['html'], 'html.parser').find('mfrac') is not None
        r = client.post('/api/deck/talk/library', json={'kind': 'image', 'deck': 'old', 'path': 'images/plot.png'})
        assert r.status_code == 200 and r.json()['path'] == 'images/plot.png'
        r = client.post('/api/deck/talk/library', json={'kind': 'image', 'deck': 'other', 'path': 'images/no.png'})
        assert r.status_code == 200 and r.json()['reused'] is True
        assert client.get('/api/deck/missing/library').status_code == 404


def test_preview_shows_line_breaks():
    from slide_studio import assets
    assert BeautifulSoup(assets.math_html('a = b\nc = d'), 'html.parser').find('mtable') is not None
    library._mathml.clear()
    assert BeautifulSoup(library.math_many(['a = b\nc = d'])[0], 'html.parser').find('mtable') is not None
