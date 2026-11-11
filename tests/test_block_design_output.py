"""ブロック装飾の入れ子と単一 HTML・PDF の表示契約。"""
from playwright.sync_api import sync_playwright
from pypdf import PdfReader

from conftest import add_deck
from slide_studio import export, theme_edit
from slide_studio.fsutil import write_atomic


def test_framed_block_default_padding(ws):
    text = ('---\ntitle: P\ntopic: test\ntheme: default\n---\n\n## P\n\n'
            '::: {#auto style="--block-design:top"}\n一段落目\n\n二段落目\n:::\n\n'
            '::: {#set style="padding:4px 6px;--block-space:3px;--block-design:top"}\n指定あり\n:::\n')
    add_deck(ws, 'pad', text)
    html = export.bundle_deck(ws, 'pad')
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        page.goto(html.as_uri())
        page.wait_for_function('window.deckReady === true')
        box = lambda s: page.locator(s).evaluate('(e) => getComputedStyle(e).padding')
        assert box('#auto') == '20px 25px' and box('#set') == '4px 6px'
        assert page.locator('#auto').evaluate('(e) => getComputedStyle(e).margin') == '20px 10px'
        assert page.locator('#set').evaluate('(e) => getComputedStyle(e).marginLeft') == '0px'
        ps = page.locator('#auto > p')
        assert ps.nth(0).evaluate('(e) => getComputedStyle(e).paddingLeft') == '0px'
        assert ps.nth(0).evaluate('(e) => getComputedStyle(e).marginTop') == '0px'
        assert ps.nth(1).evaluate('(e) => getComputedStyle(e).marginBottom') == '0px'
        browser.close()


def test_list_markers_stay_inside_block_box(ws):
    text = '---\ntitle: P\ntopic: test\ntheme: default\n---\n\n## P\n\n- 一つ目\n  - 入れ子\n- 二つ目\n'
    add_deck(ws, 'list', text)
    html = export.bundle_deck(ws, 'list')
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        page.goto(html.as_uri())
        page.wait_for_function('window.deckReady === true')
        page.evaluate("deck.go([...document.querySelectorAll('.slide')].findIndex(s => s.querySelector('ul:not(.toc-list)')))")
        got = page.evaluate("""() => {
          const ul = document.querySelector('.slide.active ul'), cs = getComputedStyle(ul), li = ul.querySelector(':scope > li');
          const nested = getComputedStyle(ul.querySelector('li ul'));
          return { margin: parseFloat(cs.marginLeft), pad: parseFloat(cs.paddingLeft), font: parseFloat(cs.fontSize),
                   gutter: parseFloat(getComputedStyle(li).marginLeft), nested: parseFloat(nested.marginLeft), nestedFont: parseFloat(nested.fontSize) };
        }""")
        assert got['margin'] == 0 and got['pad'] == 12
        assert got['gutter'] == got['font']
        assert got['nested'] == got['nestedFont']
        browser.close()


def test_nested_shadow_settings_and_standalone_exports(ws):
    kinds = ('plain', 'top', 'left', 'quote', 'bracket', 'fold')
    themes = ('default', 'terracotta', 'solarized', 'mist', 'night', 'graphite')
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        for theme in themes:
            path = ws.themes / f'{theme}.css'
            write_atomic(path, theme_edit.set_vars(path.read_text(), {
                '--block-top-radius': '20px', '--block-top-shadow': '0.7',
                '--block-unframed-radius': '9px', '--block-unframed-shadow': '0.12',
            }))
            text = f'---\ntitle: Blocks\ntopic: test\ntheme: {theme}\n---\n'
            for kind in kinds:
                text += f'\n## {kind}\n\n::: {{#card-{kind} style="--block-design:{kind}"}}\n'
                text += '標準の本文。[個別指定]{style="color:#ff8844"}\n:::\n'
            text += '\n## Nested\n\n:::: {#outer style="--block-design:top;--block-shadow:on"}\n'
            text += '::: {#inner style="--block-shadow:on"}\n内側の本文。\n:::\n::::\n'
            add_deck(ws, theme, text)
            html = export.bundle_deck(ws, theme)
            page.goto(html.as_uri())
            page.wait_for_function('window.deckReady === true')
            for i, kind in enumerate(kinds):
                page.evaluate('(i) => deck.go(i, Infinity)', i)
                card = page.locator(f'#card-{kind}')
                assert card.evaluate('(e) => getComputedStyle(e).color') == page.evaluate(
                    '(k) => { const e = document.createElement("span"); e.style.color = `var(--block-${k}-ink)`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; }', kind)
                assert card.locator('span').evaluate('(e) => getComputedStyle(e).color') == 'rgb(255, 136, 68)'
            page.evaluate('deck.go(6, Infinity)')
            assert page.locator('#outer').evaluate('(e) => getComputedStyle(e).borderRadius') == '20px'
            assert page.locator('#inner').evaluate('(e) => getComputedStyle(e).borderRadius') == '9px'
            assert '0.12' in page.locator('#inner').evaluate('(e) => getComputedStyle(e).boxShadow')
            # 影を外しても装飾なしの角丸は有効。
            page.locator('#inner').evaluate('(e) => e.style.removeProperty("--block-shadow")')
            assert page.locator('#inner').evaluate('(e) => getComputedStyle(e).borderRadius') == '9px'
            assert page.locator('#inner').evaluate('(e) => getComputedStyle(e).boxShadow') == 'none'
        browser.close()
    pdf = html.with_suffix('.pdf')
    # 6種類 + 入れ子。原稿にない参考文献ページは追加しない。
    assert export.pdf_from_html(html, pdf)['pdf_pages'] == 7
    assert all('個別指定' in page.extract_text() for page in PdfReader(pdf).pages[:6])
