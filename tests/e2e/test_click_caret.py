"""文字を押して編集に入ったとき、押した文字のあたりにカーソルが来る。"""
import pytest
from playwright.sync_api import expect

from e2e.conftest import open_deck

QMD = '## 見出しの文字をここで押す\n\n説明の文章をここで押して直す。\n\n## 次のページの見出し\n\n次のページの文章をここで押す。\n'
# 文字の真ん中あたりを押す（i 番目の文字の中央）
AT = """(el, i) => {
    const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const n = w.nextNode(), r = el.ownerDocument.createRange();
    r.setStart(n, i); r.setEnd(n, i + 1);
    const a = r.getBoundingClientRect(), b = el.getBoundingClientRect();
    return {x: a.left - b.left + a.width * .1, y: a.top - b.top + a.height / 2};
}"""


def frame(page):
    return page.frame_locator('#slideBox iframe:not(.loading)')


def ready(page):
    page.wait_for_function("document.querySelector('#stage')?.dataset.blocks === 'ready'")


def field_caret(page):
    return page.evaluate('document.activeElement.tagName === "TEXTAREA" ? document.activeElement.selectionStart : null')


def test_slide_text(gui, page):
    ws, srv = gui
    ws.qmd('talk').write_text(QMD)
    open_deck(page, srv); ready(page)
    el = frame(page).locator('[data-slide-studio="p0/0"]')
    at = el.evaluate(AT, 5)
    el.click(position=at)
    el.click(position=at)
    expect(el).to_have_attribute('contenteditable', 'true')
    assert el.evaluate('el => el.ownerDocument.getSelection().anchorOffset') == 5


@pytest.mark.parametrize('row', [0, 1, 2])
@pytest.mark.parametrize('side', ['left', 'right'])
def test_selected_list_whitespace_edits_clicked_row_end(gui, page, row, side):
    ws, srv = gui
    ws.qmd('talk').write_text('## 見出し\n\n- 最初の項目\n- 二つ目の**太字**\n- 最後の項目\n')
    open_deck(page, srv); ready(page)
    el = frame(page).locator('[data-slide-studio="p0/0"]')
    point = el.evaluate("""(el, {row, side}) => {
        const b = el.getBoundingClientRect(), li = el.querySelectorAll('li')[row];
        const r = el.ownerDocument.createRange(); r.selectNodeContents(li);
        const q = r.getBoundingClientRect();
        return {x: side === 'right' ? b.width - 8 : 8, y: (q.top + q.bottom) / 2 - b.top};
    }""", {'row': row, 'side': side})
    el.click(position=point)
    expect(el).not_to_have_attribute('contenteditable', 'true')
    el.click(position=point)
    expect(el).to_have_attribute('contenteditable', 'true')
    assert el.evaluate("""(el, row) => {
        const s = el.ownerDocument.getSelection(), li = el.querySelectorAll('li')[row];
        if (!s.isCollapsed || !li.contains(s.anchorNode)) return false;
        const r = el.ownerDocument.createRange(); r.selectNodeContents(li);
        r.setStart(s.anchorNode, s.anchorOffset);
        return r.toString() === '';
    }""", row)
    page.keyboard.type('X')
    expect(el.locator('li').nth(row)).to_contain_text('X')


def test_manuscript_card(gui, page):
    ws, srv = gui
    ws.qmd('talk').write_text(QMD)
    open_deck(page, srv, raw=False)
    card = page.locator('#qblocks .page.cur .card .text').first
    card.click(position=card.evaluate(AT, 5))
    page.get_by_label('ブロックの原稿').wait_for()
    assert field_caret(page) == 5


def test_manuscript_heading(gui, page):
    ws, srv = gui
    ws.qmd('talk').write_text(QMD)
    open_deck(page, srv, raw=False)
    head = page.locator('#qblocks .page.cur > .heading')
    head.click(position=head.evaluate(AT, 4))
    page.wait_for_selector('#qblocks textarea.heading-input')
    assert field_caret(page) == 4


def test_slide_heading(gui, page):
    ws, srv = gui
    ws.qmd('talk').write_text(QMD)
    open_deck(page, srv, raw=False); ready(page)
    head = frame(page).locator('.slide.active > h2')
    head.click(position=head.evaluate(AT, 4))
    expect(head).to_be_focused()
    assert head.evaluate('el => el.ownerDocument.getSelection().anchorOffset') == 4
    expect(page.locator('#qblocks textarea.heading-input')).to_have_count(0)


def test_slide_heading_skips_markup(gui, page):
    ws, srv = gui
    ws.qmd('talk').write_text('## **太字**の見出しを押す\n\n本文。\n')
    open_deck(page, srv, raw=False); ready(page)
    head = frame(page).locator('.slide.active > h2')
    # 記号を含む原稿でも、表示の「の」の後ろにカーソルを置く
    point = head.evaluate("""el => {
        const n = el.querySelector('strong').nextSibling, r = el.ownerDocument.createRange();
        r.setStart(n, 1); r.setEnd(n, 2);
        const a = r.getBoundingClientRect(), b = el.getBoundingClientRect();
        return {x: a.left - b.left + a.width * .1, y: a.top - b.top + a.height / 2};
    }""")
    head.click(position=point)
    expect(head).to_be_focused()
    assert head.evaluate('el => el.ownerDocument.getSelection().anchorNode === el.querySelector("strong").nextSibling')
    assert head.evaluate('el => el.ownerDocument.getSelection().anchorOffset') == 1


def test_card_on_other_page(gui, page):
    ws, srv = gui
    ws.qmd('talk').write_text(QMD)
    open_deck(page, srv, raw=False)
    card = page.locator('#qblocks .page:not(.cur) .card .text').first
    card.click(position=card.evaluate(AT, 5))
    page.get_by_label('ブロックの原稿').wait_for()
    assert field_caret(page) == 5
