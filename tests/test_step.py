"""本文の段階表示・揃え：構造、描画、直接編集の往復。"""
import pytest
from bs4 import BeautifulSoup

from slide_studio import source, edit
from slide_studio.render import render_text
from conftest import add_deck


@pytest.mark.parametrize('attrs,start', [('.incremental', 1), ('.incremental data-step="0"', 0), ('.incremental data-step="3"', 3)])
@pytest.mark.parametrize('wrap', [True, False])
def test_incremental_render(ws, attrs, start, wrap):
    text = f'## A {{#a}}\n\n::: {{{attrs}}}\n- A\n- B\n  - nested\n- C\n:::\n'
    add_deck(ws, 'talk', text)
    rendered = render_text(ws, 'talk', text, wrap=wrap)
    soup = BeautifulSoup(rendered.html, 'html.parser')
    items = soup.select('.incremental > ul > li')
    assert [int(li['data-step']) for li in items] == list(range(start, start + 3))
    assert not soup.select_one('.incremental li li').has_attr('data-step')
    assert rendered.doc.pages[0].chunks[0].kind == 'box'
    assert not rendered.unsupported
    assert '[data-slide-studio-step-label]' not in rendered.html
    assert '[data-step].pending { visibility: visible' not in rendered.html
    if wrap:
        info = edit.chunk_info(rendered)
        assert info['p0/0.0']['direct']
        assert edit.to_markdown(info['p0/0.0']['html']) == '- A\n- B\n  - nested\n- C'


def test_combined_wrapper_preserves_source(ws):
    text = '## A {#a}\n\n::: {style="padding:4px;text-align:center" data-step="2"}\n日本語。\n:::\n'
    add_deck(ws, 'talk', text)
    rendered = render_text(ws, 'talk', text)
    chunk = rendered.doc.pages[0].chunks[0]
    assert chunk.kind == 'box' and chunk.children[0].kind == 'text'
    assert source.rewrite(rendered.doc, {}) == text
    soup = BeautifulSoup(rendered.html, 'html.parser')
    wrapper = soup.select_one('[data-step="2"]')
    assert wrapper['style'] == 'padding:4px;text-align:center'
    assert wrapper.select_one('p').text == '日本語。'
    assert edit.chunk_info(rendered)['p0/0.0']['direct']


def test_pending_items_are_not_written_back():
    html = '<ul class="incremental"><li class="pending" data-step="3" data-slide-studio-step-generated="true">A</li><li>B</li></ul>'
    assert edit.to_markdown(html) == '- A\n- B'


def test_figure_and_image_steps_render(ws):
    text = ('## A {#a}\n\n{{< fig t/x step="2" >}}\n\n![説明](a.png){data-step="1" width="300"}\n\n'
            '![](b.png){data-step="3"}\n\n文の中の ![](c.png){data-step="4"} 画像。\n')
    add_deck(ws, 'talk', text)
    soup = BeautifulSoup(render_text(ws, 'talk', text).html, 'html.parser')
    assert soup.select_one('.animation')['data-step'] == '2'
    # 画像だけの段落・説明つきの図は、外側ごと隠す（説明も一緒に出す）
    assert soup.select_one('figure')['data-step'] == '1' and not soup.select_one('figure img').has_attr('data-step')
    assert soup.select_one('img[src$="b.png"]').parent['data-step'] == '3'
    # 文の中の画像は画像だけ
    assert soup.select_one('img[src$="c.png"]')['data-step'] == '4'
