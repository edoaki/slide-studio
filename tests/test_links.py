"""リンクの描画・書き出し・直接編集の往復（§7.1・§10.5）。"""
import pytest
from bs4 import BeautifulSoup

from conftest import add_deck
from slide_studio.edit import chunk_info, to_markdown
from slide_studio.export import bundle_deck
from slide_studio.render import render_text


@pytest.mark.parametrize('raw', [
    '前[資料](https://example.com/path?q=1&lang=ja)後。',
    '[**太字**と*斜体*](https://example.com/)。',
    '[日本語](https://example.com/a%20b)。',
    '[メール](mailto:test@example.com)。',
    '[節](#next)。',
])
def test_link_roundtrip(ws, raw):
    add_deck(ws, 'links', '')
    text = f'## リンク\n\n{raw}\n'
    rendered = render_text(ws, 'links', text)
    a = BeautifulSoup(rendered.html, 'html.parser').select_one('#stage a[href]')
    if a['href'].startswith('#'):
        assert not a.get('target') and not a.get('rel')
    else:
        assert a['target'] == '_blank'
        assert a['rel'] == ['noopener']
    info = chunk_info(rendered)['p0/0']
    assert info['direct']
    assert to_markdown(info['html'], raw) == raw
    assert to_markdown(info['html'].replace('資料', '文献'), raw) == raw.replace('資料', '文献')
    changed = info['html'].replace('https://example.com/', 'https://other.example/')
    assert to_markdown(changed, raw) == raw.replace('https://example.com/', 'https://other.example/')
    assert to_markdown(info['html'], raw) == raw


def test_exported_link(ws):
    add_deck(ws, 'links', '## リンク\n\n[資料](https://example.com/)\n')
    a = BeautifulSoup(bundle_deck(ws, 'links').read_text(), 'html.parser').select_one('#stage a')
    assert a['href'] == 'https://example.com/'
    assert a['target'] == '_blank'
    assert a['rel'] == ['noopener']


def test_render_attributes_do_not_enter_manuscript():
    assert to_markdown('<p><a href="https://example.com/" target="_blank" rel="noopener">資料</a></p>') == '[資料](https://example.com/)'
