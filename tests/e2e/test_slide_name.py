"""番号の隣にある表紙のスライド名を直接編集する。"""
from playwright.sync_api import expect
from e2e.conftest import open_deck, rendered
from e2e.test_blocks import ready, saved


def test_preview_heading_edits_in_place(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=True)
    ready(page)
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(2)")
    heading = page.frame_locator('#slideBox iframe:not(.loading)').locator('.slide.active > h2')
    expect(heading).to_have_text('一枚目')
    page.click('#editorToggle')
    heading.click()
    expect(heading).to_be_focused()
    expect(heading).to_have_attribute('contenteditable', 'true')
    assert page.evaluate('document.body.classList.contains("editor-off")')
    # 全選択してもフォーカスと選択範囲を見出し内に保つ（灰色の非アクティブ選択にしない）
    heading.press('ControlOrMeta+a')
    assert heading.evaluate('el => el.ownerDocument.hasFocus() && el.ownerDocument.getSelection().toString() === el.textContent')
    page.keyboard.insert_text('新しい問い')
    heading.dispatch_event('keydown', {'key': 'Enter', 'isComposing': True})
    expect(heading).to_have_attribute('contenteditable', 'true')
    heading.press('Enter')
    saved(page, '## 新しい問い {#one}')
    rendered(page, ws)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before.replace('## 一枚目 {#one}', '## 新しい問い {#one}')
    expect(heading).to_have_text('新しい問い')
    page.click('#undo')
    expect(heading).to_have_text('一枚目')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before
    ready(page)
    heading.click()
    heading.press('ControlOrMeta+a')
    heading.evaluate(r"""el => {
        const data = new DataTransfer(); data.setData('text/plain', '保存した\nタイトル');
        el.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data}));
    }""")
    heading.press('Enter')
    saved(page, '## 保存した タイトル {#one}')
    rendered(page, ws)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    page.reload()
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(2)")
    expect(heading).to_have_text('保存した タイトル')
    assert not page.errors


def test_preview_heading_preserves_markup_attributes_and_session(gui, page):
    ws, srv = gui
    before = '---\ntitle: テスト\ntopic: test\ntheme: default\n---\n\n## 前のページ😀 {#before}\n\n本文。\n\n## **太字**と$x$の見出し {#title .custom data-test="keep"}\n\n変更しない本文。\n'
    ws.qmd('talk').write_text(before)
    open_deck(page, srv, raw=False); ready(page)
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(1)")
    heading = page.frame_locator('#slideBox iframe:not(.loading)').locator('.slide.active > h2')
    heading.click()
    # 編集を始めただけでは原稿を正規化しない
    heading.press('Escape')
    assert ws.qmd('talk').read_text() == before
    heading.click()
    heading.press('End')
    page.keyboard.insert_text('追記')
    page.wait_for_function("document.querySelector('.raw textarea').value.includes('の見出し追記')")
    expect(heading).to_be_focused()
    expect(heading).to_have_attribute('contenteditable', 'true')
    page.keyboard.insert_text('続き')
    # 外を押した場合も最後の入力まで保存する
    page.locator('#editorToggle').click()
    saved(page, 'の見出し追記続き')
    rendered(page, ws)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before.replace('の見出し {#title', 'の見出し追記続き {#title')
    page.click('#undo')
    rendered(page, ws)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_cover_title_appears_once_and_saves(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    heading = page.locator('#qblocks .page.cur > .heading')
    expect(heading).to_have_text('表紙')
    field = page.locator('#qblocks .page.cur .cf-title')
    expect(field).to_have_value('テスト発表')
    heading.click()
    expect(field).to_be_focused()
    field.fill('保存するスライド名')
    field.blur()
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert 'title: "保存するスライド名"' in ws.qmd('talk').read_text()
    assert '## 保存するスライド名 {#cover .cover}' in ws.qmd('talk').read_text()
    expect(heading).to_have_text('表紙')
    page.click('#undo')
    expect(field).to_have_value('テスト発表')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before
    field.fill('保存するスライド名')
    field.blur()
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    page.reload()
    expect(heading).to_have_text('表紙')
    expect(field).to_have_value('保存するスライド名')
    assert not page.errors
