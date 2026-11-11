from playwright.sync_api import expect

from .conftest import open_deck, open_theme


def settled(page, key, color):
    page.wait_for_function("""([key, color]) => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        return !doc.documentElement.style.getPropertyValue(key) &&
            getComputedStyle(doc.documentElement).getPropertyValue(key).trim() === color;
    }""", arg=[key, color])


def test_color_picker_palette_drag_keyboard_and_undo(page, gui):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    before = (ws.themes / 'default.css').read_text()
    ink = page.locator('input[name="--ink"]')
    original = ink.input_value()
    ink.click()
    picker = page.locator('.tv-inline-color')
    expect(picker).to_be_visible()
    assert (ws.themes / 'default.css').read_text() == before
    picker.get_by_role('button', name='#3b82f6 を使う', exact=True).click()
    settled(page, '--ink', '#3b82f6')
    expect(picker.get_by_label('カラーコード')).to_have_value('#3b82f6')
    page.locator('#undo').click()
    settled(page, '--ink', original)
    expect(picker.get_by_label('カラーコード')).to_have_value(original)
    page.locator('#redo').click()
    settled(page, '--ink', '#3b82f6')

    code = picker.get_by_label('カラーコード')
    code.fill('abc')
    code.press('Enter')
    settled(page, '--ink', '#aabbcc')
    expect(code).to_have_value('#aabbcc')
    code.press('ControlOrMeta+z')
    settled(page, '--ink', '#3b82f6')
    expect(code).to_have_value('#3b82f6')
    code.press('ControlOrMeta+Shift+z')
    settled(page, '--ink', '#aabbcc')
    expect(code).to_have_value('#aabbcc')
    code.fill('oops')
    code.press('Enter')
    assert not code.evaluate('e => e.validity.valid')
    assert ink.input_value() == '#aabbcc'
    code.fill('#aabbcc')
    code.press('Tab')

    hue = picker.get_by_label('色相', exact=True)
    hue.focus()
    hue.press('ArrowRight')
    changed = ink.input_value()
    assert changed != '#aabbcc'
    settled(page, '--ink', changed)
    plane = picker.locator('.tv-color-plane')
    r = plane.bounding_box()
    page.mouse.move(r['x'] + r['width'] * .2, r['y'] + r['height'] * .2)
    page.mouse.down()
    page.mouse.move(r['x'] + r['width'] * .7, r['y'] + r['height'] * .4, steps=6)
    page.mouse.up()
    dragged = ink.input_value()
    assert dragged != changed
    settled(page, '--ink', dragged)
    page.locator('#undo').click()
    settled(page, '--ink', changed)
    expect(code).to_have_value(changed)
    plane.focus()
    plane.press('ArrowDown')
    keyed = ink.input_value()
    assert keyed != changed
    settled(page, '--ink', keyed)
    plane.press('Escape')
    expect(picker).to_have_count(0)
    expect(ink).to_be_focused()
    page.reload()
    open_theme(page)
    expect(ink).to_have_value(keyed)
    assert not page.errors


def test_visual_heading_choices_and_compact_color_editor(page, gui):
    _, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    modes = page.get_by_role('group', name='見出しの装飾', exact=True)
    modes.get_by_role('button', name='罫線', exact=True).click()
    expect(page.locator('.tv-heading-rule')).to_be_visible()
    expect(page.locator('input[name="--header"]')).to_be_hidden()
    with page.expect_response(lambda r: '/api/themes/default' in r.url and r.request.method == 'PUT' and '3px' in (r.request.post_data or '')):
        page.get_by_label('線の太さ', exact=True).select_option('3px')
    page.reload()
    open_theme(page)
    expect(modes.get_by_role('button', name='罫線', exact=True)).to_have_attribute('aria-pressed', 'true')
    expect(page.get_by_label('線の太さ', exact=True)).to_have_value('3px')
    page.screenshot(path='/tmp/slide-studio-theme-redesign-rule.png')
    modes.get_by_role('button', name='色の帯', exact=True).click()
    expect(page.locator('.tv-heading-rule')).to_be_hidden()
    page.locator('input[name="--ink"]').click()
    page.locator('input[name="--header-ink"]').click()
    expect(page.locator('.tv-inline-color')).to_have_count(1)
    expect(page.locator('.tv-inline-color')).to_have_attribute('data-key', '--header-ink')
    page.keyboard.press('Escape')
    page.locator('input[name="--ink"]').click()
    for width in [1500, 1000]:
        page.set_viewport_size({'width': width, 'height': 900})
        for scheme in ['light', 'dark']:
            page.emulate_media(color_scheme=scheme)
            page.locator('.theme-view').evaluate('e => e.scrollTop = 0')
            picker = page.locator('.tv-inline-color').bounding_box()
            preview = page.locator('#slideBox').bounding_box()
            assert picker['x'] >= 0
            assert picker['x'] + picker['width'] <= preview['x']
            assert page.locator('.theme-view').evaluate('e => e.scrollWidth <= e.clientWidth')
            page.screenshot(path=f'/tmp/slide-studio-theme-redesign-{width}-{scheme}.png')
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    expect(page.locator('.tv-inline-color')).to_have_count(0)
    expect(page.locator('.gradient-editor')).to_be_visible()
    assert not page.errors


def test_heading_colors_follow_rendered_theme_and_mark_background(page, gui):
    _, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='「solarized」を選ぶ', exact=True).click()
    background = page.get_by_label('見出しの背景', exact=True)
    ink = page.get_by_label('見出しの文字', exact=True)
    expect(ink).to_have_value('#0b4a57')
    background.click()
    page.wait_for_function("""() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        const h = doc.querySelector('.slide.active h2');
        const mark = doc.querySelector('#slide-studio-theme-marks > i');
        return h && mark && Math.abs(mark.getBoundingClientRect().width - h.getBoundingClientRect().width - 6) < 2;
    }""")
    actual = page.locator('#slideBox iframe:not(.loading)').evaluate("""f => {
        const doc = f.contentDocument, h = doc.querySelector('.slide.active h2');
        const canvas = doc.createElement('canvas'), c = canvas.getContext('2d');
        c.fillStyle = getComputedStyle(h).backgroundColor; c.fillRect(0, 0, 1, 1);
        return '#' + [...c.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
    }""")
    expect(background).to_have_value(actual)
    ink.click()
    # 保存変数の初期値と同じ白でも、実際の文字色からの変更を保存する。
    page.locator('.tv-inline-color').get_by_label('カラーコード').fill('#ffffff')
    page.locator('.tv-inline-color').get_by_label('カラーコード').press('Enter')
    settled(page, '--header-ink', '#ffffff')
    page.reload()
    open_theme(page)
    expect(ink).to_have_value('#ffffff')
    background.click()
    page.screenshot(path='/tmp/slide-studio-heading-colors.png')
    assert not page.errors
