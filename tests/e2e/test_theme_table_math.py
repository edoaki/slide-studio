from playwright.sync_api import expect

from slide_studio.fsutil import write_atomic
from .conftest import open_deck, open_theme


def test_table_math_colors_are_independent_and_persist(page, gui):
    ws, srv = gui
    path = ws.qmd('talk')
    write_atomic(path, path.read_text() + '\n## 表と数式 {#colors}\n\n| 項目 | 値 |\n|---|---|\n| 本文 | $x^2$ |\n\n数式 $E=mc^2$\n')
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='「mist」を選ぶ', exact=True).click()
    colors = '''() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        return ['#colors th', '#colors td', '#colors math'].map(s => {
            const c = getComputedStyle(doc.querySelector(s)); return [c.color, c.backgroundColor];
        });
    }'''
    page.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--header').trim() === '#1b4a7c'")
    before = page.evaluate(colors)
    page.get_by_label('見出しの背景', exact=True).fill('#abcdef')
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    assert page.evaluate(colors) == before
    fields = [('表の見出しの背景', '--table-header-bg', '#112233'),
              ('表の見出しの文字', '--table-header-ink', '#ffffff'),
              ('表の本文', '--table-ink', '#445566'), ('数式', '--math-ink', '#778899')]
    for label, key, value in fields:
        field = page.get_by_label(label, exact=True)
        expect(page.locator('.tv-section').filter(has=field).locator('h3')).to_have_text('色分け')
        field.fill(value)
        page.wait_for_function("key => !document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live' + key)", arg=key)
    expected = [['rgb(255, 255, 255)', 'rgb(17, 34, 51)'],
                ['rgb(68, 85, 102)', 'rgba(0, 0, 0, 0)'],
                ['rgb(119, 136, 153)', 'rgba(0, 0, 0, 0)']]
    page.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('#colors math')).color === 'rgb(119, 136, 153)'")
    assert page.evaluate(colors) == expected
    page.locator('#undo').click()
    page.wait_for_function("""() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        return getComputedStyle(doc.querySelector('#colors math')).color !== 'rgb(119, 136, 153)';
    }""")
    page.get_by_label('数式', exact=True).fill('#778899')
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live--math-ink')")
    page.reload()
    open_theme(page)
    assert page.evaluate(colors) == expected
    for label, key, value in fields:
        expect(page.get_by_label(label, exact=True)).to_have_value(value)
    page.get_by_label('数式', exact=True).focus()
    expect(page.frame_locator('#slideBox iframe:not(.loading)').locator('#colors')).to_have_class('slide active')
    page.screenshot(path='/tmp/slide-studio-table-math-colors.png')
    assert not page.errors
