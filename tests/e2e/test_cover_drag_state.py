import pytest
from playwright.sync_api import expect

from .conftest import open_deck, open_theme, rendered
from .test_blocks import ready, frame


@pytest.mark.parametrize('from_text', [False, True])
def test_cover_drag_survives_theme_and_manuscript_tabs(page, gui, from_text):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    ready(page)
    title = frame(page).locator('.cover-title')
    for mode in ['theme', 'qmd']:
        if mode == 'theme':
            open_theme(page)
        else:
            page.get_by_role('tab', name='スライド', exact=True).click()
        ready(page)
        before = ws.qmd('talk').read_text()
        box = title.bounding_box()
        x, y = box['x'] + 15, box['y'] + box['height'] / 2
        if from_text:
            text = title.locator('p').evaluate('''e => {
                const r = document.createRange(); r.selectNodeContents(e);
                const b = r.getBoundingClientRect(); return {x:b.x + 10, y:b.y + b.height / 2};
            }''')
            iframe = page.locator('#slideBox iframe:not(.loading)').bounding_box()
            x, y = iframe['x'] + text['x'], iframe['y'] + text['y']
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + 30, y + 15, steps=5)
        page.mouse.up()
        expect(page.locator('#status')).to_have_text('保存済み')
        rendered(page, ws)
        ready(page)
        assert ws.qmd('talk').read_text() != before
        after = title.bounding_box()
        assert abs(after['x'] - box['x'] - 30) < 2
        assert abs(after['y'] - box['y'] - 15) < 2
    assert not page.errors


@pytest.mark.parametrize('switch_theme', [False, True])
def test_cover_preview_matches_export_with_outer_spacing(page, gui, switch_theme):
    from slide_studio.fsutil import write_atomic

    ws, srv = gui
    text = ws.qmd('talk').read_text()
    if not switch_theme:
        text = text.replace('theme: default', 'theme: terracotta')
    text = text.replace('::: {.cover-title}', '::: {.cover-title style="--block-space:0px;padding:24px"}')
    write_atomic(ws.qmd('talk'), text)
    open_deck(page, srv, raw=False)
    ready(page)
    if switch_theme:
        open_theme(page)
        page.locator('.theme-thumb[data-theme="terracotta"]').click()
        page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('#slide-studio-theme').href.includes('terracotta.css')")
        expect(page.locator('#status')).to_have_text('保存済み')
    measure = '''() => {
        const s = document.querySelector('#stage').getBoundingClientRect();
        const t = document.querySelector('.cover-title').getBoundingClientRect();
        return {x:(t.x-s.x)*1280/s.width, y:(t.y-s.y)*1280/s.width};
    }'''
    preview = page.locator('#slideBox iframe:not(.loading)').evaluate('(f, script) => f.contentWindow.eval(`(${script})()`)', measure)
    from conftest import shared_browser
    exported = shared_browser().new_page()
    exported.goto(srv.url + '/files/decks/talk/__slide-studio_preview__.html?edit=0')
    exported.wait_for_function('window.deckReady')
    assert preview == pytest.approx(exported.evaluate(measure), abs=0.1)
    exported.close()
