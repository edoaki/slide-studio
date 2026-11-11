import pytest
from playwright.sync_api import expect
from e2e.conftest import open_deck

CUR = '#qblocks .page.cur'


@pytest.mark.parametrize('key', ['Delete', 'Backspace'])
@pytest.mark.parametrize('focus', ['rail', 'body', 'input'])
def test_table_text_selection_does_not_delete_block(gui, page, key, focus):
    ws, srv = gui
    row = '| 選択する行 | 123 |\n'
    table = '| 項目 | 値 |\n|---|---|\n' + row + '| 残す行 | 456 |\n'
    before = '---\ntitle: 表\ntopic: test\n---\n\n## 表\n\n' + table + '\n後の段落。\n'
    ws.qmd('talk').write_text(before)
    open_deck(page, srv, raw=False)
    raw_before = page.locator('.raw textarea').input_value()
    rail(page, 'p0/0').click()
    card = page.locator(f'{CUR} .card').filter(has_text='選択する行')
    if focus == 'input':
        card.click()
        field = page.get_by_label('ブロックの原稿')
        field.evaluate('''(el, row) => {
            const start = el.value.indexOf(row);
            el.setSelectionRange(start, start + row.length);
        }''', row)
    else:
        if focus == 'body':
            page.evaluate('document.activeElement.blur()')
        card.locator('.text').evaluate('''el => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let node;
            while (node = walker.nextNode()) {
                const start = node.textContent.indexOf('選択する行');
                if (start < 0) continue;
                const range = document.createRange();
                range.setStart(node, start); range.setEnd(node, start + '選択する行'.length);
                const selection = window.getSelection();
                selection.removeAllRanges(); selection.addRange(range);
                break;
            }
        }''')
        assert page.evaluate('window.getSelection().toString()') == '選択する行'
    page.keyboard.press(key)
    expected = before.replace(row, '') if focus == 'input' else before
    expect(page.locator('.raw textarea')).to_have_value(raw_before.replace(row, '') if focus == 'input' else raw_before)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == expected
    assert not page.errors


def saved(page, ws, text):
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    page.wait_for_function('(t) => document.querySelector(".raw textarea").value.includes(t)', arg=text)
    assert text in ws.qmd('talk').read_text()


def go(page, index):
    page.evaluate('(i) => document.querySelector("#slideBox iframe:not(.loading)").contentWindow.deck.go(i)', index)
    page.wait_for_function('(i) => document.querySelector("#qblocks .page.cur")?.dataset.page == String(i)', arg=index)


def rail(page, key):
    return page.locator(f'{CUR} .rail[data-key="{key}"]')


def test_block_edit_preserves_source_and_undo(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    expect(page.locator('#qblocks .box.col')).to_have_count(2)
    assert ws.qmd('talk').read_text() == before
    page.locator('#qblocks .card').filter(has_text='最初の段落。').click()
    field = page.get_by_label('ブロックの原稿')
    field.fill('変更した段落 🐈。')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '変更した段落 🐈。')
    field.press('Escape')
    page.click('#undo')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before
    expect(page.locator('#qblocks .card').filter(has_text='最初の段落。')).to_be_visible()
    assert not page.errors


def test_list_backspace_keeps_break_then_joins(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    original = '- 探索が完了すれば、\n- 許容誤差の範囲で最適性を証明できる\n- 制約を式で追加しやすい'
    broken = '- 探索が完了すれば、\\\n  許容誤差の範囲で最適性を証明できる\n- 制約を式で追加しやすい'
    joined = '- 探索が完了すれば、許容誤差の範囲で最適性を証明できる\n- 制約を式で追加しやすい'
    open_deck(page, srv, raw=False); go(page, 2)
    page.locator(f'{CUR} .card').filter(has_text='最初の段落。').click()
    field = page.get_by_label('ブロックの原稿')
    field.fill(original)
    field.evaluate('(el) => { const at = el.value.indexOf("許容"); el.setSelectionRange(at, at); }')
    field.press('Backspace')
    expect(field).to_have_value(broken)
    saved(page, ws, broken)
    page.wait_for_function('''() => {
      const slide = document.querySelector('#slideBox iframe:not(.loading)')?.contentDocument.querySelector('.slide.active');
      return slide?.querySelectorAll('li').length === 2 && slide.querySelectorAll('li:first-child br').length === 1;
    }''')
    assert field.evaluate('(el) => el.selectionStart') == broken.index('許容')
    field.press('Backspace')
    expect(field).to_have_value(joined)
    saved(page, ws, joined)
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', joined)
    assert field.evaluate('(el) => el.selectionStart') == joined.index('許容')
    field.press('Escape')
    page.click('#undo')
    saved(page, ws, '最初の段落。')
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_block_fold_switch_and_nested_edit(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    page.locator('#qblocks .card').filter(has_text='右の列。').click()
    field = page.get_by_label('ブロックの原稿')
    field.fill('列の変更。')
    field.press('Escape')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before.replace('右の列。', '列の変更。')
    # 開け閉めは1つのボタン：2ページ以上開いていれば今のページ以外を閉じ、1ページならすべて開く
    expect(page.locator('#foldToggle')).to_have_attribute('aria-label', '今のページ以外を閉じる')
    page.click('#foldToggle')
    expect(page.locator('#qblocks .page:not(.folded)')).to_have_count(1)
    expect(page.locator('#foldToggle')).to_have_attribute('aria-label', 'すべてのページを開く')
    page.click('#foldToggle')
    expect(page.locator('#qblocks .box.col')).to_have_count(2)
    page.click('#syntaxToggle')
    expect(page.locator('.raw textarea')).to_be_visible()
    page.click('#foldToggle')  # 本文の無いページ（本編・参考文献・Appendix）は畳めない
    expect(page.locator('.raw-fold .rf-row.folded')).to_have_count(2)  # 表紙は記法表示に出さない
    expect(page.locator('#foldToggle')).to_have_attribute('aria-label', 'すべてのページを開く')
    page.click('#foldToggle')
    expect(page.locator('.raw-fold .rf-row.folded')).to_have_count(0)
    page.click('#blocksMode')
    expect(page.locator('#qblocks')).to_be_visible()
    assert not page.errors


@pytest.mark.parametrize('selection', ['rail', 'source', 'preview'])
def test_selection_tools_close_when_clicking_outside(gui, page, selection):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False); go(page, 2)
    for target in ['.chat-input', '#status']:
        if selection == 'rail':
            rail(page, 'p2/0').click()
        elif selection == 'source':
            page.locator(f'{CUR} .card').filter(has_text='最初の段落。').click()
        else:
            page.frame_locator('#slideBox iframe:not(.loading)').locator('[data-slide-studio="p2/0"]').click()
        expect(page.locator('#qblocks .qtb')).to_have_class('qtb show')
        expect(page.locator('#blockTools')).to_be_visible()
        page.locator(target).click()
        expect(page.locator('#qblocks .qtb')).not_to_have_class('qtb show')
        expect(page.locator('#blockTools')).to_be_hidden()
        expect(page.locator(f'{CUR} .box.selected')).to_have_count(0)
        expect(page.frame_locator('#slideBox iframe:not(.loading)').locator('.slide-studio-selected')).to_have_count(0)
    expect(page.locator('.chat-input')).to_have_value('')
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_select_add_below_split_and_delete(gui, page):
    """線を押して選ぶ → ツールバーの［下に分割］で空のブロック → 書いた時点で原稿に入る。⌘Enter で分割、Delete で削除。"""
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False); go(page, 2)
    rail(page, 'p2/0').click()
    expect(page.locator(f'{CUR} .box.selected')).to_have_attribute('data-key', 'p2/0')
    expect(page.locator('#qblocks .qtb')).to_have_class('qtb show')
    page.get_by_role('button', name='下に分割').click()
    assert ws.qmd('talk').read_text() == before  # 空のブロックは書かない
    page.keyboard.type('追加。')
    saved(page, ws, '最初の段落。\n\n追加。\n\n二番目の段落。')
    page.keyboard.press('Home'); page.keyboard.press('ArrowRight')
    page.keyboard.press('Meta+Enter')
    saved(page, ws, '最初の段落。\n\n追\n\n加。\n\n二番目の段落。')
    page.keyboard.press('Home'); page.keyboard.press('Backspace')
    saved(page, ws, '最初の段落。\n\n追加。\n\n二番目の段落。')
    page.keyboard.press('Escape')
    expect(page.locator(f'{CUR} .box.selected')).to_have_attribute('data-key', 'p2/1')
    page.keyboard.press('Delete')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    page.wait_for_function('() => !document.querySelector(".raw textarea").value.includes("追加。")')
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_split_right_ratio_and_unwrap(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False); go(page, 2)
    rail(page, 'p2/1').click()
    page.get_by_role('button', name='右に分割').click()
    page.wait_for_function("document.activeElement?.getAttribute('aria-label') === 'ブロックの原稿'")
    page.keyboard.type('右。')
    saved(page, ws, ':::: {.columns}\n::: {.column}\n二番目の段落。\n:::\n::: {.column}\n右。\n:::\n::::')
    page.keyboard.press('Escape')
    rail(page, 'p2/1.0').click()
    page.get_by_role('button', name='列の幅').click()
    for _ in range(10):
        page.keyboard.press('ArrowRight')
    saved(page, ws, '::: {.column width="60%"}\n二番目の段落。\n:::\n::: {.column width="40%"}\n右。')
    page.keyboard.press('Escape')
    rail(page, 'p2/1.1').click()
    page.keyboard.press('Delete')
    page.wait_for_function('() => !document.querySelector(".raw textarea").value.includes("右。")')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_drag_column_out(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False); go(page, 2)
    rail(page, 'p2/1').click()
    page.get_by_role('button', name='右に分割').click()
    page.wait_for_function("document.activeElement?.getAttribute('aria-label') === 'ブロックの原稿'")
    page.keyboard.type('右。')
    saved(page, ws, '::: {.column}\n右。\n:::\n::::')
    page.keyboard.press('Escape')
    # 列を列の外（ふつうの段落の上）へ落とすと、中身だけが移り、横並びは外れる
    src, dst = rail(page, 'p2/1.1').bounding_box(), page.locator(f'{CUR} .box[data-key="p2/0"]').bounding_box()
    page.mouse.move(src['x'] + 4, src['y'] + 8); page.mouse.down()
    page.mouse.move(src['x'] + 4, src['y'] - 10, steps=3); page.mouse.move(dst['x'] + 60, dst['y'] + 3, steps=5)
    expect(page.locator('#qblocks .ind-h')).to_have_count(1)
    page.mouse.up()
    saved(page, ws, '{#one}\n\n右。\n\n最初の段落。\n\n二番目の段落。\n\n## 二枚目')
    assert not page.errors


def test_drag_shows_no_mark_where_nothing_changes(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False); go(page, 2)
    src, own, nxt = (page.locator(f'{CUR} .box[data-key="{k}"]').bounding_box() for k in ('p2/0', 'p2/0', 'p2/1'))
    r = rail(page, 'p2/0').bounding_box()
    page.mouse.move(r['x'] + 4, r['y'] + 8); page.mouse.down()
    page.mouse.move(r['x'] + 4, r['y'] + 20, steps=3)
    # 自分の上・次のブロックの上半分（どちらも今と同じ位置）には線を出さない
    for x, y in ((own['x'] + 60, own['y'] + 3), (own['x'] + 60, own['y'] + own['height'] - 3), (nxt['x'] + 60, nxt['y'] + 3)):
        page.mouse.move(x, y, steps=3)
        expect(page.locator('#qblocks .ind-h, #qblocks .ind-face')).to_have_count(0)
    page.mouse.move(nxt['x'] + 60, nxt['y'] + nxt['height'] - 3, steps=3)
    expect(page.locator('#qblocks .ind-h')).to_have_count(1)
    page.keyboard.press('Escape'); page.mouse.up()
    assert not page.errors


@pytest.mark.parametrize('surface', ['source', 'slide'])
def test_move_description_into_and_out_of_designed_box(gui, page, surface):
    from slide_studio.fsutil import write_atomic
    from .test_blocks import ready, frame
    ws, srv = gui
    original = '---\ntopic: test\n---\n\n## A\n\n::: {style="--block-design:plain;padding:24px"}\n名前。\n:::\n\n説明。\n'
    write_atomic(ws.qmd('talk'), original)
    open_deck(page, srv, raw=False); ready(page)
    expect(rail(page, 'p0/0')).to_have_count(1)
    expect(rail(page, 'p0/0.0')).to_have_count(1)
    for into in [True, False]:
        src_key = 'p0/1' if into else 'p0/0.1'
        dst_key = 'p0/0.0' if into else 'p0/0'
        if surface == 'source':
            src = rail(page, src_key).bounding_box()
            dst = rail(page, dst_key).bounding_box()
            x, y = src['x'] + 4, src['y'] + 8
            tx, ty = dst['x'] + 4, dst['y'] + dst['height'] - 3
            marker = '#qblocks .ind-h'
        else:
            rail(page, src_key).click()
            src = frame(page).locator(f'[data-slide-studio="{src_key}"]').bounding_box()
            dst = frame(page).locator(f'[data-slide-studio="{dst_key}"]').bounding_box()
            x, y = src['x'] + src['width'] - 30, src['y'] + src['height'] / 2
            tx, ty = dst['x'] + dst['width'] / 2, dst['y'] + dst['height'] - 2
            marker = '#viewport .bd-line'
        page.mouse.move(x, y); page.mouse.down()
        page.mouse.move(x, y + 12, steps=3); page.mouse.move(tx, ty, steps=5)
        expect(page.locator(marker)).to_have_count(1)
        page.mouse.up()
        saved(page, ws, '名前。\n\n説明。\n:::' if into else '名前。\n\n:::\n\n説明。')
        ready(page)
    assert ws.qmd('talk').read_text() == original.replace('名前。\n:::', '名前。\n\n:::')
    assert not page.errors


def test_nudge_drag_and_pages(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False); go(page, 2)
    rail(page, 'p2/0').click(); page.keyboard.press('Alt+ArrowDown')
    saved(page, ws, '二番目の段落。\n\n最初の段落。')
    page.wait_for_function('() => document.activeElement?.dataset.key === "p2/1"')
    src, dst = rail(page, 'p2/1').bounding_box(), page.locator(f'{CUR} .box[data-key="p2/0"]').bounding_box()
    page.mouse.move(src['x'] + 10, src['y'] + 8); page.mouse.down()
    page.mouse.move(src['x'] + 10, src['y'] - 10, steps=3); page.mouse.move(dst['x'] + 60, dst['y'] + 3, steps=5)
    expect(page.locator('#qblocks .ind-h')).to_have_count(1)
    page.mouse.up()
    saved(page, ws, '{#one}\n\n最初の段落。\n\n二番目の段落。')
    assert ws.qmd('talk').read_text() == before
    # ページの追加：間の ＋ → 見出しを書く → 本文を書く → ページを削除
    page.locator('#qblocks .page-add .end-btn').nth(3).click()
    page.get_by_role('button', name='白紙', exact=True).click()
    page.wait_for_function("document.activeElement?.getAttribute('aria-label') === '見出し'")
    page.keyboard.type('新しいページ'); page.keyboard.press('Enter')
    saved(page, ws, '二番目の段落。\n\n## 新しいページ {#page-1}\n\n## 二枚目')
    page.wait_for_function('() => document.querySelector("#qblocks .page.cur > .heading")?.textContent === "新しいページ"')
    page.locator(f'{CUR} .card.empty').click(); page.keyboard.type('本文。'); page.keyboard.press('Escape')
    saved(page, ws, '## 新しいページ {#page-1}\n\n本文。\n\n## 二枚目')
    expect(page.locator(f'{CUR} > .page-delete')).to_be_hidden()
    page.locator(f'{CUR} > .heading').click()
    page.locator(f'{CUR} > .page-delete').click()
    page.wait_for_function('() => !document.querySelector(".raw textarea").value.includes("新しいページ")')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_click_other_card_while_editing(gui, page):
    """入力中に別のカード・見出しを押すと、そちらの入力に移る（打った直後で構造が古くても）。"""
    ws, srv = gui
    open_deck(page, srv, raw=False); go(page, 2)
    page.locator(f'{CUR} .card').filter(has_text='最初の段落。').click()
    page.keyboard.type('追加\n\n分けた')
    page.locator(f'{CUR} .card').filter(has_text='二番目の段落。').click()
    page.wait_for_function("document.activeElement?.value === '二番目の段落。'")
    page.locator(f'{CUR} > .heading').click()
    page.wait_for_function("document.activeElement?.value === '一枚目'")
    page.locator(f'{CUR} .card').filter(has_text='分けた').click()
    page.wait_for_function("document.activeElement?.value === '分けた'")
    saved(page, ws, '最初の段落。追加\n\n分けた\n\n二番目の段落。')
    assert not page.errors


def test_click_other_page_card_while_editing_heading(gui, page):
    """見出しの入力中にほかのページのカードを押すと、そのページへ移ってカードの入力になる（後ろのページ・前のページ）。"""
    ws, srv = gui
    open_deck(page, srv, raw=False); go(page, 2)
    page.locator(f'{CUR} > .heading').click()
    page.wait_for_function("document.activeElement?.value === '一枚目'")
    page.keyboard.type('X')
    page.locator('#qblocks .page.dormant .card').filter(has_text='左の列。').click()
    page.wait_for_function("document.activeElement?.value === '左の列。'")
    expect(page.locator(CUR)).to_have_attribute('data-page', '3')
    saved(page, ws, '## 一枚目X {#one}')
    page.locator(f'{CUR} > .heading').click()
    page.wait_for_function("document.activeElement?.value === '二枚目'")
    page.keyboard.type('Y')
    page.locator('#qblocks .page.dormant .card').filter(has_text='最初の段落。').click()
    page.wait_for_function("document.activeElement?.value === '最初の段落。'")
    expect(page.locator(CUR)).to_have_attribute('data-page', '2')
    saved(page, ws, '## 二枚目Y {#two}')
    assert not page.errors
