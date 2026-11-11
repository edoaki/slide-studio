import re
import pytest

from playwright.sync_api import expect

from .conftest import open_deck, open_theme, rendered
from .test_blocks import ready, go, select, frame, saved


def pick(menu, label, color):
    # 色の◯を押して色の編集を開き、カラーコードで決める
    b = menu.get_by_role('button', name=label, exact=True)
    if b.get_attribute('aria-expanded') != 'true':
        b.click()
    code = menu.locator('.decoration-color-editor .tv-color-code input')
    code.fill(color); code.press('Enter')


TOP = '--block-design:top'


def themed(page, var, value):
    # 書いたテーマの CSS をスライドが読み直した
    page.wait_for_function("([k, v]) => { const r = document.querySelector('#slideBox iframe:not(.loading)')?.contentDocument?.documentElement; return r && !r.style.getPropertyValue(k) && getComputedStyle(r).getPropertyValue(k).trim() === v; }", arg=[var, value])


def test_design_is_chosen_per_block_and_colors_are_shared_in_theme(gui, page):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    theme = ws.themes / 'default.css'
    # 以前の版が書いた背景だけのブロックは、開いたときに「枠線」になる
    write_atomic(ws.qmd('talk'), '---\ntopic: test\n---\n\n## A {#a}\n\n::: {#card style="padding:24px;background-color:#eef5faff"}\n本文。\n:::\n\n'
                 f'::: {{#two style="{TOP}"}}\n二つ目。\n:::\n')
    open_deck(page, srv, raw=False); ready(page)
    assert '#card style="padding:24px;--block-design:plain"' in ws.qmd('talk').read_text()
    card, two = frame(page).locator('#card'), frame(page).locator('#two')
    card.click(position={'x': 8, 'y': 12})
    bar = page.locator('#blockTools')
    # 入口は1つ
    expect(bar.locator('.decoration-tool')).to_have_count(1)
    bar.locator('[data-decoration="design"] > button').click()
    menu = bar.locator('[data-decoration="design"] .fmt-menu')
    choices = menu.get_by_role('group', name='ブロックのデザイン').get_by_role('button')
    # 見本は文字を書かず、名前はツールチップ（aria-label）
    assert choices.evaluate_all('bs => bs.map(b => b.getAttribute("aria-label"))') == ['枠線', '上ライン', '左ライン', '引用', '括弧', '折り返し']
    expect(choices).to_have_text(['本文'] * 6)
    expect(menu.get_by_role('button', name='枠線', exact=True)).to_have_attribute('aria-pressed', 'true')
    for gone in ['個別設定を解除', 'スライド全体に適用']:
        expect(menu.get_by_role('button', name=gone)).to_have_count(0)
    # 開いている間は選択の枠を消し、メニューはブロックに重ねない
    expect(card).to_have_css('outline-color', 'rgba(0, 0, 0, 0)')
    m, c = menu.bounding_box(), card.bounding_box()
    assert m['y'] >= c['y'] + c['height'] or m['y'] + m['height'] <= c['y']

    def monitor():
        page.evaluate('''() => {
          window.decorationFrames = []; window.stopDecorationFrames = false;
          const tick = () => {
            const el = document.querySelector('#blockTools [data-decoration="design"] .fmt-menu');
            window.decorationFrames.push({visible: !!el?.matches(':popover-open') && !el.hidden,
              opacity: el && getComputedStyle(el).opacity, expanded: !!el?.querySelector('.decoration-color-editor')});
            if (!window.stopDecorationFrames) requestAnimationFrame(tick);
          }; requestAnimationFrame(tick);
        }''')

    def stable(expanded=False):
        samples = page.evaluate('''async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          window.stopDecorationFrames = true; return window.decorationFrames;
        }''')
        assert samples and all(s['visible'] and s['opacity'] == '1' for s in samples)
        if expanded:
            assert all(s['expanded'] for s in samples)

    monitor()
    menu.get_by_role('button', name='上ライン', exact=True).click()
    saved(page, '--block-design:top'); rendered(page, ws); ready(page)
    stable()
    style = re.search(r'#card style="([^"]*)"', ws.qmd('talk').read_text())[1]
    assert sorted(style.split(';')) == sorted(['padding:24px', *TOP.split(';')])
    expect(card).to_have_css('border-radius', '10px')
    expect(card).to_have_css('padding-top', '24px')
    expect(menu.locator('.decoration-note')).to_have_count(0)
    menu.get_by_role('button', name='色1（上のライン）', exact=True).click()
    expect(menu.get_by_role('slider', name='色1の線の太さ（px）', exact=True)).to_be_visible()
    menu.get_by_role('button', name='背景', exact=True).click()
    # 背景の色には太さを出さない
    expect(menu.get_by_role('slider', name='色2の線の太さ（px）', exact=True)).to_have_count(0)
    expect(menu.get_by_role('slider', name='背景透明度（%）', exact=True)).to_be_visible()
    # 色を決めるとテーマに書き、同じデザインのほかのブロックも変わる。原稿には色を書かない
    text = ws.qmd('talk').read_text()
    monitor()
    pick(menu, '色1（上のライン）', '#226688')
    themed(page, '--block-top-line', '8px solid #226688ff')
    stable(expanded=True)
    assert '--block-top-line: 8px solid #226688ff' in theme.read_text()
    assert ws.qmd('talk').read_text() == text
    for el in [card, two]:
        assert el.evaluate('(el) => getComputedStyle(el).borderTopColor') == 'rgb(34, 102, 136)'
    # 動かしている間はスライドの見た目だけが変わり、離したときにテーマを書く
    width = menu.get_by_role('slider', name='色1の線の太さ（px）', exact=True)
    width.evaluate("el => { el.value = '9'; el.dispatchEvent(new Event('input', {bubbles: true})); }")
    expect(two).to_have_css('border-top-width', '9px')
    assert '8px solid #226688ff' in theme.read_text()
    width.dispatch_event('change')
    themed(page, '--block-top-line', '9px solid #226688ff')
    expect(menu.get_by_role('slider', name='色1の線の太さ（px）')).to_have_value('9')
    page.locator('#undo').click()
    themed(page, '--block-top-line', '8px solid #226688ff')
    expect(card).to_have_css('border-top-width', '8px')
    expect(menu.get_by_role('slider', name='色1の線の太さ（px）')).to_have_value('8')
    page.locator('#redo').click()
    themed(page, '--block-top-line', '9px solid #226688ff')
    expect(card).to_have_css('border-top-width', '9px')
    expect(menu.get_by_role('slider', name='色1の線の太さ（px）')).to_have_value('9')
    page.locator('#undo').click()
    themed(page, '--block-top-line', '8px solid #226688ff')
    expect(menu.get_by_role('slider', name='色1の線の太さ（px）')).to_have_value('8')
    page.screenshot(path='/tmp/slide-studio-block-designs.png', animations='disabled')
    # 小さい画面・暗い配色でも画面内に収まる（置き直しは ResizeObserver の後）
    page.set_viewport_size({'width': 1000, 'height': 650})
    page.emulate_media(color_scheme='dark')
    page.wait_for_function('() => { const r = document.querySelector(\'#blockTools [data-decoration="design"] .fmt-menu\').getBoundingClientRect(); return r.bottom <= innerHeight; }')
    bounds = menu.bounding_box()
    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 1000
    assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= 650
    page.screenshot(path='/tmp/slide-studio-block-designs-dark.png', animations='disabled')
    page.set_viewport_size({'width': 1500, 'height': 900})
    page.emulate_media(color_scheme='light')
    for name, kind, regions in [('左ライン', 'left', 3), ('引用', 'quote', 3), ('括弧', 'bracket', 3), ('折り返し', 'fold', 3)]:
        menu.get_by_role('button', name=name, exact=True).click()
        saved(page, f'--block-design:{kind}'); rendered(page, ws); ready(page)
        expect(menu.locator('.decoration-region')).to_have_count(regions)
        expect(menu.get_by_role('button', name='破線', exact=True)).to_have_count(0)
        if kind == 'shadow':
            assert card.evaluate('(el) => getComputedStyle(el).boxShadow') != 'none'
    # 枠線は線の種類も選べる
    menu.get_by_role('group', name='ブロックのデザイン').get_by_role('button', name='枠線', exact=True).click()
    saved(page, '--block-design:plain'); rendered(page, ws); ready(page)
    menu.get_by_role('button', name='破線', exact=True).click()
    themed(page, '--block-border', '3.5px dashed #7b848fff')
    assert card.evaluate('(el) => getComputedStyle(el).borderLeftStyle') == 'dashed'
    expect(menu.get_by_role('button', name='破線', exact=True)).to_have_attribute('aria-pressed', 'true')
    solid = menu.get_by_role('button', name='実線', exact=True)
    solid.hover()
    tooltip = page.locator('.tip.show')
    expect(tooltip).to_be_visible()
    b, t = solid.bounding_box(), tooltip.bounding_box()
    assert min(abs(t['y'] - b['y'] - b['height']), abs(b['y'] - t['y'] - t['height'])) <= 12
    pick(menu, '背景', '#ffeecc')
    themed(page, '--block-background', '#ffeeccff')
    expect(card).to_have_css('background-color', 'rgb(255, 238, 204)')
    # 枠線なしは装飾をすべて外し、余白は残す
    menu.get_by_role('group', name='ブロックのデザイン').get_by_role('button', name='枠線', exact=True).click()
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('#card style=\"padding:24px;--block-design')")
    saved(page, '#card style="padding:24px"'); rendered(page, ws); ready(page)
    expect(card).to_have_css('border-top-width', '0px')
    expect(card).to_have_css('background-color', 'rgba(0, 0, 0, 0)')
    expect(menu.locator('.decoration-region')).to_have_count(0)
    expect(menu.locator('.decoration-note')).to_have_count(0)
    page.keyboard.press('Escape')
    expect(card).not_to_have_css('outline-color', 'rgba(0, 0, 0, 0)')
    page.reload(); ready(page)
    expect(two).to_have_css('border-top-color', 'rgb(34, 102, 136)')
    assert not page.errors


def test_design_menu_follows_external_theme_change(gui, page):
    from slide_studio.fsutil import write_atomic

    ws, srv = gui
    write_atomic(ws.qmd('talk'), '---\ntopic: test\n---\n\n## A\n\n::: {#card style="padding:24px;--block-design:plain"}\n本文。\n:::\n')
    open_deck(page, srv, raw=False); ready(page)
    frame(page).locator('#card').click(position={'x': 8, 'y': 12})
    page.locator('#blockTools [data-decoration="design"] > button').click()
    menu = page.locator('#blockTools [data-decoration="design"] .fmt-menu')
    expect(menu.get_by_role('button', name='実線', exact=True)).to_have_attribute('aria-pressed', 'true')

    # 別画面からの保存でも、CSS の差し替え後に開いているメニューを更新する。
    theme = page.request.get(f'{srv.url}/api/themes/default').json()
    response = page.request.put(f'{srv.url}/api/themes/default', data={
        'base': theme['version'], 'vars': {'--block-border': '3.5px dashed #7b848fff'},
    })
    assert response.ok
    themed(page, '--block-border', '3.5px dashed #7b848fff')
    expect(menu.get_by_role('button', name='破線', exact=True)).to_have_attribute('aria-pressed', 'true')
    assert not page.errors


def test_box_padding_selects_box_and_content_selects_child(gui, page):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    write_atomic(ws.qmd('talk'), '''---
topic: test
---

## A {#a}

:::: {.columns}
::: {.column width="50%" style="padding:26px;border-top:4px solid #2b8da3;background-color:#edf6fa;min-height:350px"}
### メリット

- 一つ目
- 二つ目
:::
::: {.column width="50%"}
右の列。
:::
::::
''')
    open_deck(page, srv, raw=False); ready(page)
    box = frame(page).locator('[data-slide-studio="p0/0.0"]')
    for position in [{'x': 4, 'y': 2}, {'x': 8, 'y': 80}, {'x': 12, 'y': box.bounding_box()['height'] - 12}]:
        box.hover(position=position)
        expect(box).to_have_class(re.compile('slide-studio-hover'))
        box.click(position=position)
        expect(box).to_have_class(re.compile('slide-studio-selected'))
    select(page, 'p0/0.0.1')
    page.get_by_role('button', name='外側を選択', exact=True).click()
    expect(box).to_have_class(re.compile('slide-studio-selected'))
    page.get_by_role('button', name='内側を選択', exact=True).click()
    expect(frame(page).locator('[data-slide-studio="p0/0.0.1"]')).to_have_class(re.compile('slide-studio-selected'))
    assert not page.errors


def test_designed_text_stays_editable_in_one_wrapper(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False); ready(page); go(page, 2)
    select(page, 'p2/0')
    page.locator('#blockTools').locator('[data-decoration="design"] > button').click()
    page.locator('#blockTools').get_by_role('button', name='上ライン', exact=True).click()
    saved(page, '--block-design:top'); rendered(page, ws); ready(page)
    page.locator('#blockTools').locator('[data-decoration="design"] > button').click()
    frame(page).locator('[data-slide-studio="p2/0.0"]').click()
    page.keyboard.press('Enter')
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(1)
    frame(page).locator('.slide-studio-editing').fill('デザインを保ったまま編集。')
    saved(page, 'デザインを保ったまま編集。')
    page.keyboard.press('Escape'); rendered(page, ws); ready(page)
    assert ws.qmd('talk').read_text().count('--block-design:top') == 1
    wrapper = frame(page).locator('[style*="--block-design:top"]')
    expect(wrapper).to_have_count(1)
    assert wrapper.evaluate('(el) => getComputedStyle(el).borderTopWidth') == '8px'
    assert not page.errors


def test_add_description_after_framing_name(gui, page):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    write_atomic(ws.qmd('talk'), '---\ntopic: test\n---\n\n## A\n\n名前。\n')
    open_deck(page, srv, raw=False); ready(page)
    select(page, 'p0/0')
    page.locator('#blockTools [data-decoration="design"] > button').click()
    page.locator('#blockTools').get_by_role('button', name='枠線', exact=True).click()
    saved(page, '--block-design:plain'); rendered(page, ws); ready(page)
    expect(frame(page).locator('[data-slide-studio="p0/0"]')).to_have_class(re.compile('slide-studio-selected'))
    page.locator('#blockTools [data-decoration="design"] > button').click()
    page.locator('#qblocks .rail[data-key="p0/0"]').click()
    page.get_by_role('button', name='下に分割', exact=True).click()
    page.get_by_label('ブロックの原稿').fill('説明。')
    saved(page, '名前。\n\n説明。\n:::')
    page.keyboard.press('Escape'); rendered(page, ws); ready(page)
    box = frame(page).locator('[data-slide-studio="p0/0"]')
    expect(box.locator(':scope > p')).to_have_count(2)
    page.screenshot(path='/tmp/slide-studio-framed-container.png', animations='disabled')
    open_deck(page, srv, raw=False); ready(page)
    expect(frame(page).locator('[data-slide-studio="p0/0"] > p')).to_have_count(2)
    assert ws.qmd('talk').read_text().count('--block-design:plain') == 1
    assert not page.errors


@pytest.mark.parametrize('design_first', [True, False])
def test_split_and_frame_use_columns_without_inner_boxes(gui, page, design_first):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    write_atomic(ws.qmd('talk'), '---\ntopic: test\n---\n\n## A\n\n名前。\n')
    open_deck(page, srv, raw=False); ready(page)

    def design(key):
        page.locator(f'#qblocks .rail[data-key="{key}"]').click()
        page.locator('#blockTools [data-decoration="design"] > button').click()
        page.locator('#blockTools').get_by_role('button', name='枠線', exact=True).click()
        saved(page, '--block-design:plain'); rendered(page, ws); ready(page)
        page.locator('#blockTools [data-decoration="design"] > button').click()

    if design_first:
        design('p0/0')
    page.locator('#qblocks .rail[data-key="p0/0"]').click()
    page.get_by_role('button', name='右に分割', exact=True).click()
    page.get_by_label('ブロックの原稿').fill('右の名前。')
    saved(page, '右の名前。'); page.keyboard.press('Escape'); rendered(page, ws); ready(page)
    if not design_first:
        design('p0/0.0')
    design('p0/0.1')
    for key in ['p0/0.0', 'p0/0.1']:
        page.locator(f'#qblocks .rail[data-key="{key}"]').click()
        page.get_by_role('button', name='下に分割', exact=True).click()
        page.get_by_label('ブロックの原稿').fill('説明。')
        page.keyboard.press('Escape')
        rendered(page, ws); ready(page)
    for key in ['p0/0.0', 'p0/0.1']:
        col = frame(page).locator(f'[data-slide-studio="{key}"]')
        expect(col).to_have_class(re.compile('column'))
        expect(col).to_have_attribute('style', re.compile('--block-design:plain'))
        expect(col.locator(':scope > p')).to_have_count(2)
        expect(col.locator(':scope > div')).to_have_count(0)
    page.keyboard.press('Escape')
    page.screenshot(path=f'/tmp/slide-studio-canonical-columns-{design_first}.png', animations='disabled')
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False); ready(page)
    assert ws.qmd('talk').read_text() == before
    page.locator('#qblocks .rail[data-key="p0/0.1"]').click()
    page.get_by_role('button', name='下に分割', exact=True).click()
    page.get_by_label('ブロックの原稿').fill('追加。')
    saved(page, '追加。'); page.keyboard.press('Escape')
    page.click('#undo')
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('追加。')")
    expect(page.locator('#status')).to_have_text('保存済み')
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_open_merges_legacy_column_box(gui, page):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    write_atomic(ws.qmd('talk'), '---\ntopic: test\n---\n\n## A\n\n:::: {.columns}\n::: {.column width="45%" style="--block-design:plain"}\n左。\n\n説明。\n:::\n::: {.column width="55%"}\n::: {style="--block-design:plain"}\n右。\n\n説明。\n:::\n:::\n::::\n')
    open_deck(page, srv, raw=False); ready(page)
    for key in ['p0/0.0', 'p0/0.1']:
        col = frame(page).locator(f'[data-slide-studio="{key}"]')
        expect(col.locator(':scope > p')).to_have_count(2)
        expect(col.locator(':scope > div')).to_have_count(0)
        expect(col).to_have_attribute('style', re.compile('--block-design:plain'))
    assert '::: {.column width="55%" style="--block-design:plain"}' in ws.qmd('talk').read_text()
    assert not page.errors


@pytest.mark.parametrize('outer_style', ['--block-design:plain', '--block-shadow:on'])
def test_open_keeps_framed_box_inside_decorated_column(gui, page, outer_style):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    text = ('---\ntopic: test\n---\n\n## A\n\n:::: {.columns}\n'
            f'::: {{.column width="50%" style="{outer_style}"}}\n'
            '::: {style="--block-design:plain"}\n内側の本文。\n:::\n:::\n'
            '::: {.column width="50%"}\n右の本文。\n:::\n::::\n')
    write_atomic(ws.qmd('talk'), text)
    open_deck(page, srv, raw=False); ready(page)

    column = frame(page).locator('[data-slide-studio="p0/0.0"]')
    box = column.locator(':scope > [data-slide-studio="p0/0.0.0"]')
    expect(box).to_have_count(1)
    expect(box).to_have_attribute('style', re.compile('--block-design:plain'))
    expect(box).to_have_css('border-top-style', 'solid')
    assert box.evaluate('(el) => parseFloat(getComputedStyle(el).borderTopWidth)') > 0
    expect(column).to_have_attribute('style', re.compile(outer_style))
    if outer_style == '--block-design:plain':
        assert column.evaluate('(el) => parseFloat(getComputedStyle(el).borderTopWidth)') > 0
    else:
        assert column.evaluate('(el) => getComputedStyle(el).boxShadow') != 'none'
    assert ws.qmd('talk').read_text() == text
    page.reload(); ready(page)
    expect(box).to_have_count(1)
    assert ws.qmd('talk').read_text() == text
    assert not page.errors


def test_slide_background_does_not_offer_gradient_editor(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    ready(page); go(page, 2)
    open_theme(page)
    frame(page).locator('#one > p').first.click()
    expect(page.locator('.gradient-editor')).to_be_hidden()
    frame(page).locator('#one').dispatch_event('click')
    expect(page.locator('.gradient-editor')).to_be_hidden()
    # スライド全体の背景はテーマの設定を使い、個別の編集欄は表示しない。
    expect(page.locator('label[data-key="--paper"]')).to_have_count(0)
    page.get_by_role('tab', name='スライド', exact=True).click()
    expect(page.locator('.gradient-editor')).to_be_hidden()
    select(page, 'p2/0')
    expect(page.locator('#blockTools')).to_be_visible()
    expect(page.locator('.gradient-editor')).to_be_hidden()
    assert not page.errors


def test_text_shadow_radius_and_new_designs(gui, page):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    write_atomic(ws.qmd('talk'), '''---
topic: test
theme: night
---

## Test

::: {#card style="--block-design:quote"}
標準の文字と[個別指定]{style="color:#ff8844"}。
:::

::: {#two style="--block-design:quote"}
二つ目。
:::
''')
    open_deck(page, srv, raw=False); ready(page)
    card = frame(page).locator('#card')
    card.click(position={'x': 6, 'y': 8})
    page.locator('#blockTools [data-decoration="design"] > button').click()
    menu = page.locator('#blockTools [data-decoration="design"] .fmt-menu')
    pick(menu, '文字', '#aabbcc')
    themed(page, '--block-quote-ink', '#aabbccff')
    expect(card).to_have_css('color', 'rgb(170, 187, 204)')
    expect(frame(page).locator('#two')).to_have_css('color', 'rgb(170, 187, 204)')
    expect(card.locator('span')).to_have_css('color', 'rgb(255, 136, 68)')
    menu.get_by_role('checkbox', name='影付き').check()
    saved(page, '--block-shadow:on'); rendered(page, ws); ready(page)
    assert card.evaluate('(e) => getComputedStyle(e).boxShadow') != 'none'
    assert frame(page).locator('#two').evaluate('(e) => getComputedStyle(e).boxShadow') == 'none'
    for label, value, variable, expected in [('影の強さ','35','--block-quote-shadow','0.35'), ('角丸','16','--block-quote-radius','16px')]:
        slider = menu.get_by_role('slider', name=label, exact=True)
        slider.evaluate('(e,v) => { e.value=v; e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); }', value)
        themed(page, variable, expected)
    expect(card).to_have_css('border-radius', '16px')
    expect(frame(page).locator('#two')).to_have_css('border-radius', '16px')
    menu.get_by_role('checkbox', name='影付き').uncheck()
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('--block-shadow:on')")
    expect(card).to_have_css('box-shadow', 'none')
    pick(menu, '色1（装飾）', '#88aa77')
    themed(page, '--block-quote-accent', '#88aa77ff')
    assert card.evaluate('(e) => getComputedStyle(e,"::before").color') == 'rgb(136, 170, 119)'
    page.screenshot(path='/tmp/slide-studio-new-block-controls.png')
    page.reload(); ready(page)
    expect(card).to_have_css('color', 'rgb(170, 187, 204)')
    expect(card.locator('span')).to_have_css('color', 'rgb(255, 136, 68)')
    assert not page.errors
