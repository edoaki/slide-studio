import re

import pytest
from playwright.sync_api import expect

from e2e.conftest import open_deck


def ready(page):
    page.wait_for_function("document.querySelector('#stage')?.dataset.blocks === 'ready'")


def go(page, index):
    page.evaluate('(i) => document.querySelector("#slideBox iframe:not(.loading)").contentWindow.deck.go(i)', index)


def select(page, key):
    """スライドのブロックをクリックして選ぶ。選ぶとブロックの上にツールバーが出る。"""
    frame(page).locator(f'[data-slide-studio="{key}"]').click()
    page.wait_for_function("(key) => document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('.slide-studio-selected')?.dataset.slideStudio === key && !document.querySelector('#blockTools').hidden", arg=key)


def start_edit(page, key):
    """選んでいる文字をもう一度クリックすると、スライド上で直接編集になる（mock と同じ）。"""
    el = frame(page).locator(f'[data-slide-studio="{key}"]')
    point = el.evaluate("""el => {
        const r = el.ownerDocument.createRange(); r.selectNodeContents(el);
        const a = r.getClientRects()[0], b = el.getBoundingClientRect();
        return {x: a.left - b.left + 4, y: a.top - b.top + a.height / 2};
    }""")
    el.click(position=point)
    page.wait_for_function("(key) => document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('.slide-studio-editing')?.dataset.slideStudio === key", arg=key)


def frame(page):
    return page.frame_locator('#slideBox iframe:not(.loading)')


def saved(page, text):
    page.wait_for_function('(text) => document.querySelector(".raw textarea").value.includes(text)', arg=text)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.__slideStudioVersion && !document.querySelector('#slideBox iframe.loading')")


def test_double_click_text_accepts_keyboard_input(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False); ready(page); go(page, 2)
    el = frame(page).locator('[data-slide-studio="p2/0"]')
    point = el.evaluate("""el => {
        const r = el.ownerDocument.createRange(); r.selectNodeContents(el);
        const a = r.getClientRects()[0], b = el.getBoundingClientRect();
        return {x: a.left - b.left + 4, y: a.top - b.top + a.height / 2};
    }""")
    el.dblclick(position=point)
    expect(el).to_have_attribute('contenteditable', 'true')
    expect(el).to_be_focused()
    page.keyboard.insert_text('追記')
    expect(el).to_contain_text('追記')
    page.keyboard.press('Escape')
    saved(page, '追記')
    assert '追記' in ws.qmd('talk').read_text()
    assert not page.errors


def test_direct_edit_other_pages_and_undo(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv); ready(page); go(page, 2)
    select(page, 'p2/0')
    start_edit(page, 'p2/0')
    el = frame(page).locator('[data-slide-studio="p2/0"]')
    # 確定しなくても、打つ手が止まれば原稿に反映される。途中で描画が進んでも続けて反映する
    el.fill('途中の段落。')
    saved(page, '途中の段落。')
    el.fill('編集した段落。')
    saved(page, '編集した段落。')
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '編集した段落。')
    assert frame(page).locator('.slide-studio-editing').count() == 1
    page.keyboard.press('Escape')
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    # 1回の編集は ⌘Z の1回分
    page.click('#undo')
    saved(page, '最初の段落。')
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


@pytest.mark.parametrize('enters', [1, 2])
@pytest.mark.parametrize('at_end', [False, True])
def test_enter_line_break_and_blank_line(gui, page, enters, at_end):
    ws, srv = gui
    open_deck(page, srv); ready(page); go(page, 2)
    select(page, 'p2/0'); start_edit(page, 'p2/0')
    el = frame(page).locator('[data-slide-studio="p2/0"]')
    el.fill('前半。' if at_end else '前半。より詳しく。')
    el.evaluate('''el => {
        const r = document.createRange(); r.setStart(el.firstChild, 3); r.collapse(true);
        const s = el.ownerDocument.getSelection(); s.removeAllRanges(); s.addRange(r);
    }''')
    for _ in range(enters):
        page.keyboard.press('Enter')
    if at_end:
        page.keyboard.insert_text('より詳しく。')
    page.keyboard.press('Escape')
    expected = '前半。' + ('\\\n' if enters == 1 else '\n\n') + 'より詳しく。'
    saved(page, expected)
    assert expected in ws.qmd('talk').read_text()
    if enters == 1:
        expect(frame(page).locator('[data-slide-studio="p2/0"] br')).to_have_count(1)
        expect(frame(page).locator('[data-slide-studio="p2/0"]')).to_contain_text('より詳しく。')
    else:
        expect(frame(page).locator('[data-slide-studio="p2/1"]')).to_have_text('より詳しく。')
    assert not page.errors


def test_nested_edit_and_move_delete(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv); ready(page); go(page, 3)
    select(page, 'p3/0.1.0')
    start_edit(page, 'p3/0.1.0')
    frame(page).locator('[data-slide-studio="p3/0.1.0"]').fill('右を編集。')
    # 編集中のブロックの外を押すと編集を終える
    frame(page).locator('[data-slide-studio="p3/0.0.0"]').click()
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    saved(page, '右を編集。')
    assert ws.qmd('talk').read_text() == before.replace('右の列。', '右を編集。')
    # 並べ替えは原稿のブロック表示（⌥↓）。スライドのツールバーは外側を選ぶ・削除だけ
    go(page, 2)
    page.click('#blocksMode')
    page.locator('#qblocks .page.cur .rail[data-key="p2/0"]').click()
    page.keyboard.press('Alt+ArrowDown')
    saved(page, '二番目の段落。\n\n最初の段落。')
    ready(page)
    # ⌥↓ で移したブロックは、スライドでも選んだまま（もう一度クリックすると文字の編集になる）
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('.slide-studio-selected')?.dataset.slideStudio === 'p2/1' && !document.querySelector('#blockTools').hidden")
    page.locator('#blockTools').get_by_role('button', name='削除', exact=True).click()
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('最初の段落。')")
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert '最初の段落。' not in ws.qmd('talk').read_text()
    assert not page.errors


def test_click_does_not_change_slide(gui, page):
    ws, srv = gui
    open_deck(page, srv); ready(page); go(page, 2)
    index = "document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.index"
    # 編集画面では、ブロックの外を押しても、編集を終えるクリックでも、スライドを送らない
    box = page.locator('#slideBox iframe:not(.loading)').bounding_box()
    page.mouse.click(box['x'] + box['width'] - 8, box['y'] + box['height'] - 8)
    select(page, 'p2/0'); start_edit(page, 'p2/0')
    page.mouse.click(box['x'] + box['width'] - 8, box['y'] + box['height'] - 8)
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    page.wait_for_timeout(300)
    assert page.evaluate(index) == 2
    assert not page.errors


def test_custom_format_and_raw_page(gui, page):
    ws, srv = gui
    text = '---\ntopic: test\n---\n\n## A {#a}\n\n[残す]{style="letter-spacing: .1em"}\n\n編集可能。\n\n## B {#b}\n\n::: {.row}\n\n閉じ忘れ。\n\n## C {#c}\n\n後続。\n'
    ws.qmd('talk').write_text(text)
    open_deck(page, srv); ready(page)
    select(page, 'p0/0')
    frame(page).locator('[data-slide-studio="p0/0"]').click()
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(1)
    page.keyboard.press('Escape')
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    assert ws.qmd('talk').read_text() == text
    select(page, 'p0/1'); start_edit(page, 'p0/1')
    frame(page).locator('[data-slide-studio="p0/1"]').fill('編集済み。')
    saved(page, '編集済み。')
    assert ws.qmd('talk').read_text() == text.replace('編集可能。', '編集済み。')
    go(page, 1)
    expect(page.locator('#hintMsg')).to_have_text('このページは原稿で編集')
    expect(page.locator('#blockTools')).to_be_hidden()
    assert not page.errors


def test_image_alignment_and_click_selection(gui, page):
    ws, srv = gui
    text = '## A {#a}\n\n![画像](images/a.svg){width=200}\n\n後ろの段落。\n'
    images = ws.asset_root('talk') / 'images'
    ws.qmd('talk').write_text(text)
    (images / 'a.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>')
    open_deck(page, srv); ready(page)
    select(page, 'p0/0')
    page.get_by_role('button', name='画像の揃え', exact=True).click()
    saved(page, 'fig-align="right"')
    page.wait_for_function('''() => document.querySelector('#slideBox iframe:not(.loading)')?.contentDocument.querySelector('img[data-fig-align="right"][width="200"]')''')
    metrics = frame(page).locator('img').evaluate('''el => ({width: el.offsetWidth, right: el.getBoundingClientRect().right, parentRight: el.parentElement.getBoundingClientRect().right})''')
    assert metrics['width'] == 200
    assert abs(metrics['right'] - metrics['parentRight']) < 1
    assert 'fig-align="right"' in ws.qmd('talk').read_text()
    assert ws.qmd('talk').read_text().endswith('\n\n後ろの段落。\n')
    for value in ['left', 'center']:
        page.get_by_role('button', name='画像の揃え', exact=True).click()
        saved(page, f'fig-align="{value}"'); ready(page)
        expect(page.get_by_role('button', name='画像の揃え', exact=True)).to_have_attribute('data-align', value)

    assert not page.errors


def test_undo_edit_and_stale_conversion_preserve_input(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv); ready(page); go(page, 2)
    select(page, 'p2/0'); start_edit(page, 'p2/0')
    frame(page).locator('[data-slide-studio="p2/0"]').fill('保存しない文章。')
    saved(page, '保存しない文章。')
    # 編集中はブロックのツールバーの代わりに書式バー（§10.5）。終えたあと ⌘Z の1回で編集前に戻す
    expect(page.locator('#blockTools')).to_have_attribute('data-mode', 'format')
    page.keyboard.press('Escape')
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    page.click('#undo')
    saved(page, '最初の段落。')
    assert ws.qmd('talk').read_text() == before
    expect(frame(page).locator('[data-slide-studio="p2/0"]')).to_have_text('最初の段落。')  # 描き直すまで待つ
    # 原稿に未保存の入力がある間は、古い data-slide-studio で上書きしない。
    response = page.request.post(srv.url + '/api/deck/talk/chunks', data={'base': 'old', 'text': before, 'key': 'p2/0', 'action': 'delete'})
    assert response.status == 409
    assert ws.qmd('talk').read_text() == before


def test_text_click_places_caret_and_keeps_editing_in_padding(gui, page):
    ws, srv = gui
    ws.qmd('talk').write_text('## 問い\n\n説明を書く。\n')
    open_deck(page, srv); ready(page)
    el = frame(page).locator('[data-slide-studio="p0/0"]')
    # 未選択ならまず段落を選び、2回目は押した文字の手前から編集する。
    position = el.evaluate("""el => {
        const r = el.ownerDocument.createRange();
        r.setStart(el.firstChild, 3); r.setEnd(el.firstChild, 4);
        const a = r.getBoundingClientRect(), b = el.getBoundingClientRect();
        return {x: a.left - b.left + a.width * .1, y: a.top - b.top + a.height / 2};
    }""")
    el.click(position=position)
    expect(el).not_to_have_attribute('contenteditable', 'true')
    el.click(position=position)
    expect(el).to_have_attribute('contenteditable', 'true')
    assert el.evaluate("el => { const s = el.ownerDocument.getSelection(); return s.isCollapsed && s.anchorOffset === 3; }")
    page.keyboard.insert_text('ここ')
    expect(el).to_have_text('説明をここ書く。')
    # 同じ段落の右の余白を押しても、編集を終えてブロック選択に戻さない。
    el.click(position={'x': el.bounding_box()['width'] - 12, 'y': position['y']})
    expect(el).to_have_attribute('contenteditable', 'true')
    page.keyboard.insert_text('末尾')
    expect(el).to_have_text('説明をここ書く。末尾')
    page.keyboard.press('Escape')
    saved(page, '説明をここ書く。末尾')
    assert not page.errors


@pytest.mark.parametrize('wrapped', [False, True])
def test_selected_text_drag_enters_editing_and_replaces_selection(gui, page, wrapped):
    ws, srv = gui
    body = '説明を書く。'
    if wrapped:
        body = f'::: {{style="padding: 20px"}}\n{body}\n:::'
    before = f'---\ntopic: test\n---\n\n## 問い\n\n{body}\n'
    ws.qmd('talk').write_text(before)
    open_deck(page, srv); ready(page)
    key = 'p0/0.0' if wrapped else 'p0/0'
    el = frame(page).locator(f'p[data-slide-studio="{key}"]')
    el.click()
    expect(el).not_to_have_attribute('contenteditable', 'true')
    points = el.evaluate("""el => {
        const r = el.ownerDocument.createRange();
        r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 2);
        const b = r.getBoundingClientRect();
        return {left: b.left + 1, right: b.right - 1, y: b.top + b.height / 2};
    }""")
    box = page.locator('#slideBox iframe:not(.loading)').bounding_box()
    page.mouse.move(box['x'] + points['left'], box['y'] + points['y'])
    page.mouse.down()
    expect(el).to_have_attribute('contenteditable', 'true')
    page.mouse.move(box['x'] + points['right'], box['y'] + points['y'], steps=8)
    page.mouse.up()
    assert el.evaluate('el => el.ownerDocument.getSelection().toString()') == '説明'
    expect(page.locator('#viewport .bd-line')).to_have_count(0)
    expect(page.locator('#blockTools')).to_have_attribute('data-mode', 'format')
    page.keyboard.insert_text('本文')
    expect(el).to_have_text('本文を書く。')
    page.keyboard.press('Escape')
    saved(page, '本文を書く。')
    assert ws.qmd('talk').read_text() == before.replace('説明', '本文')
    page.click('#undo')
    saved(page, '説明を書く。')
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_selected_whitespace_enters_editing_at_nearest_line_end(gui, page):
    ws, srv = gui
    ws.qmd('talk').write_text('## 問い\n\n文字の近くではその位置から編集し、行間や余白では行末から編集する。\n')
    open_deck(page, srv); ready(page)
    el = frame(page).locator('[data-slide-studio="p0/0"]')
    points = el.evaluate("""el => {
        Object.assign(el.style, {width: '520px', padding: '32px', lineHeight: '2.4'});
        const r = el.ownerDocument.createRange(); r.selectNodeContents(el);
        const lines = [...r.getClientRects()], b = el.getBoundingClientRect();
        const first = lines[0], last = lines.at(-1);
        const ends = [];
        for (let i = 0; i < el.firstChild.length; i++) {
            r.setStart(el.firstChild, i); r.setEnd(el.firstChild, i + 1);
            const q = r.getBoundingClientRect();
            const line = lines.findIndex(l => Math.abs(l.top - q.top) < 1);
            ends[line] = i + 1;
        }
        return {
            ends,
            lines: lines.length,
            padding: {x: b.width / 2, y: 10},
            gap: {x: first.left - b.left + 10, y: (first.bottom + lines[1].top) / 2 - b.top},
            right: {x: b.width - 10, y: last.top - b.top + last.height / 2},
            text: {x: last.left - b.left + 8, y: last.top - b.top + last.height / 2}
        };
    }""")
    assert points['lines'] >= 2
    el.click(position=points['padding'])
    expect(el).not_to_have_attribute('contenteditable', 'true')
    for name in ['padding', 'gap', 'right']:
        el.click(position=points[name])
        expect(el).to_have_attribute('contenteditable', 'true')
        offset = el.evaluate('el => el.ownerDocument.getSelection().anchorOffset')
        if name == 'padding':
            assert offset == points['ends'][0]
        elif name == 'right':
            assert offset == points['ends'][-1]
        else:
            assert offset in points['ends'][:2]
        page.keyboard.press('Escape')
    el.click(position=points['text'])
    expect(el).to_have_attribute('contenteditable', 'true')
    # 外側への移動は書式バーの先頭。段落の選択へ戻る。
    outside = page.locator('#blockTools button').first
    expect(outside).to_have_attribute('aria-label', '外側を選択')
    outside.click()
    expect(el).not_to_have_attribute('contenteditable', 'true')
    expect(page.locator('#blockTools')).not_to_have_attribute('data-mode', 'format')
    assert not page.errors


def test_text_with_non_roundtripping_spacing_can_be_edited(gui, page):
    ws, srv = gui
    raw = ('## 用語\n\n::: {style="padding:0px 12px;text-box:trim-both text"}\n'
           '**Open**：拠点に戻らなくてよい　**Multi-Depot**：拠点が複数ある\\\n'
           '**Skill**：能力による適合制約　　   **Time Window**：時間窓制約\n:::\n')
    ws.qmd('talk').write_text(raw)
    open_deck(page, srv, raw=False); ready(page)
    select(page, 'p0/0.0')
    page.keyboard.press('Enter')
    el = frame(page).locator('[data-slide-studio="p0/0.0"]')
    expect(el).to_have_attribute('contenteditable', 'true')
    # 開いて閉じるだけでは、原文の空白も変えない。
    page.keyboard.press('Escape')
    assert ws.qmd('talk').read_text() == raw
    page.keyboard.press('Enter')
    el.evaluate("""el => {
        const r = el.ownerDocument.createRange(); r.selectNodeContents(el); r.collapse(false);
        const s = el.ownerDocument.getSelection(); s.removeAllRanges(); s.addRange(r);
    }""")
    page.keyboard.insert_text('を確認')
    page.keyboard.press('Escape')
    saved(page, 'を確認')
    changed = ws.qmd('talk').read_text()
    assert '**Open**' in changed and '**Time Window**' in changed
    assert 'padding:0px 12px;text-box:trim-both text' in changed
    assert '時間窓制約を確認' in changed
    page.click('#undo')
    saved(page, '時間窓制約')
    assert ws.qmd('talk').read_text() == raw
    assert not page.errors
