"""発表の共通履歴：原稿、CSS、参考資料、未送信指示。"""
from playwright.sync_api import expect

from slide_studio.fsutil import write_atomic


def open_deck(page, srv, raw=True):
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    page.wait_for_selector('.ptabs [data-tab=materials]')
    if raw:
        page.get_by_role('button', name='すべての記法を表示', exact=True).click()


def settled(page):
    busy = page.evaluate("""async () => {
      const { S } = await import('/web/strings.js');
      return [S.status.pending, S.status.saving, S.status.rendering];
    }""")
    page.wait_for_function("busy => !busy.includes(document.querySelector('#status').textContent)", arg=busy)
    page.wait_for_function("!document.querySelector('#undo').disabled || !document.querySelector('#redo').disabled")


def test_material_actions_share_source_history(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    original = page.locator('#qhost textarea').input_value()
    page.get_by_role('tab', name='参考資料', exact=True).click()
    page.get_by_role('button', name='新しいフォルダ', exact=True).click()
    page.get_by_label('名前', exact=True).fill('results')
    page.get_by_label('名前', exact=True).press('Enter')
    row = page.locator('.mt-row[data-path="results"]')
    expect(row).to_have_count(1)
    page.get_by_role('tab', name='スライド', exact=True).click()
    ta = page.locator('#qhost textarea')
    ta.fill(original + '\n履歴の本文。\n')
    settled(page)
    page.locator('#undo').click()
    expect(ta).to_have_value(original)
    page.locator('#undo').click()
    page.wait_for_function("document.querySelector('#undo').disabled && !document.querySelector('#redo').disabled")
    assert not (ws.deck_dir('talk') / 'materials/results').exists()
    page.locator('#redo').click()
    page.wait_for_function("!document.querySelector('#undo').disabled")
    assert (ws.deck_dir('talk') / 'materials/results').is_dir()
    page.locator('#redo').click()
    expect(ta).to_have_value(original + '\n履歴の本文。\n')
    assert not page.errors


def test_rename_move_delete_and_restore(gui, page):
    ws, srv = gui
    base = ws.deck_dir('talk') / 'materials'
    write_atomic(base / 'a.txt', '資料の本文')
    (base / 'folder').mkdir()
    open_deck(page, srv, raw=False)
    page.get_by_role('tab', name='参考資料', exact=True).click()
    page.locator('.mt-row[data-path="a.txt"]').click()
    page.keyboard.press('F2')
    name = page.get_by_label('名前', exact=True)
    name.fill('b.txt'); name.press('Enter')
    row = page.locator('.mt-row[data-path="b.txt"]')
    expect(row).to_have_count(1)
    row.drag_to(page.locator('.mt-row[data-path="folder"]'))
    page.wait_for_function("document.querySelector('.mt-row[data-path=\"folder/b.txt\"]')")
    row = page.locator('.mt-row[data-path="folder/b.txt"]')
    row.locator('[data-act=delete]').click()
    page.locator('.dialog [data-a=yes]').click()
    expect(row).to_have_count(0)
    for expected in ('folder/b.txt', 'b.txt', 'a.txt'):
        page.locator('#undo').click()
        expect(page.locator(f'.mt-row[data-path="{expected}"]')).to_have_count(1)
        assert (base / expected).read_text() == '資料の本文'
    assert not page.errors


def test_draft_history_is_independent_from_source(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    page.wait_for_selector('.chat-input:not([disabled])')
    page.fill('.chat-input', '未送信の指示')
    page.locator('[data-act=clear]').click()
    expect(page.locator('.chat-draft')).to_have_count(0)
    ta = page.locator('#qhost textarea')
    original = ta.input_value()
    ta.fill(original + '\n後の編集。\n')
    ta.press('Meta+z')
    expect(ta).to_have_value(original)
    expect(page.locator('.chat-draft')).to_have_count(0)
    expect(page.locator('#undo')).to_be_disabled()
    # 指示の削除はチャット内の履歴にだけ入る。
    page.locator('.chat-input').press('Meta+z')
    expect(page.locator('.chat-draft')).to_have_count(1)
    expect(ta).to_have_value(original)
    page.locator('.chat-input').press('Meta+Shift+z')
    expect(page.locator('.chat-draft')).to_have_count(0)
    page.locator('#redo').click()
    expect(ta).to_have_value(original + '\n後の編集。\n')
    assert not page.errors


def test_common_history_failure_and_order(page, gui):
    _, srv = gui
    page.goto(srv.url)
    result = page.evaluate("""async () => {
      const { makeHistory } = await import('/web/history.js');
      let text = 'a', side = 1, fail = true;
      const ctx = {history: [], future: [], showStatus() {}, flush: async () => true};
      const h = makeHistory(ctx, () => ({text}), e => { text = e.text; });
      ctx.recordHistory({text: 'before'});
      ctx.recordHistory({undo: () => { if (fail) throw Error('競合'); side--; }, redo: () => side++});
      await h.undo();
      const failed = ctx.history.length === 2 && side === 1 && !ctx.future.length;
      fail = false; await h.undo(); await h.undo();
      const undone = side === 0 && text === 'before';
      await h.redo(); await h.redo();
      const redone = side === 1 && text === 'a';
      await h.undo(); ctx.recordHistory({text: 'a'});
      return {failed, undone, redone, branched: !ctx.future.length};
    }""")
    assert all(result.values()), result


def test_external_source_is_not_an_undo_step(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    page.get_by_role('tab', name='参考資料', exact=True).click()
    page.get_by_role('button', name='新しいフォルダ', exact=True).click()
    name = page.get_by_label('名前', exact=True)
    name.fill('created'); name.press('Enter')
    expect(page.locator('.mt-row[data-path="created"]')).to_have_count(1)
    page.get_by_role('tab', name='スライド', exact=True).click()
    ta = page.locator('#qhost textarea')
    ta.fill(ta.input_value() + '\nGUIの編集。\n')
    settled(page)
    external = '## 外の変更 {#external}\n\n外の本文。\n'
    write_atomic(ws.qmd('talk'), external)
    expect(ta).to_have_value(external)
    page.locator('#undo').click()
    page.wait_for_function("document.querySelector('#undo').disabled && !document.querySelector('#redo').disabled")
    assert not (ws.deck_dir('talk') / 'materials/created').exists()
    assert ws.qmd('talk').read_text() == external
    assert not page.errors


def test_chat_attachment_is_saved_only_when_sent(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    page.wait_for_selector('.chat-input:not([disabled])')
    page.locator('.chat-file').set_input_files({'name': 'notes.txt', 'mimeType': 'text/plain', 'buffer': b'notes'})
    expect(page.locator('.chat-attach .chat-att')).to_have_count(1)
    path = ws.deck_dir('talk') / 'materials/notes.txt'
    assert not path.exists()
    # 送らずに外した添付は保存しない。添付は編集の履歴にも入らない
    page.locator('.chat-attach [data-act=unattach]').click()
    expect(page.locator('.chat-attach .chat-att')).to_have_count(0)
    assert page.locator('#undo').is_disabled()
    assert not path.exists()
    assert not page.errors


def test_pasted_image_remains_after_source_undo(gui, page):
    from e2e.test_block_ops import frame, go, ready, click
    from e2e.test_insert import PNG64

    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv)
    before_visible = page.locator('#qhost textarea').input_value()
    go(page, 2); ready(page); click(page, 'p2/0')
    frame(page).locator('[data-slide-studio="p2/0"]').evaluate('''(el, png) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'image.png', {type: 'image/png'}));
      el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
    }''', PNG64)
    page.wait_for_function("document.querySelector('#qhost textarea').value.includes('![](images/')")
    settled(page)
    images = list((ws.asset_root('talk') / 'images').iterdir())
    assert len(images) == 1
    page.locator('#undo').click()
    expect(page.locator('#qhost textarea')).to_have_value(before_visible)
    settled(page)
    assert ws.qmd('talk').read_text() == before
    assert images[0].is_file()
    assert not page.errors


def test_all_padding_restores_css_and_source_in_one_step(gui, page):
    from e2e.test_block_ops import DECK, go, ready, click, drag
    from slide_studio import figures

    ws, srv = gui
    write_atomic(ws.qmd('talk'), DECK)
    write_atomic(ws.deck_dir('talk') / 'images/a.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>')
    figures.new_figure(ws, 'box', ws.shelf_dir('test'))
    open_deck(page, srv)
    css = ws.deck_dir('talk') / 'styles/slides.css'
    before_css = css.read_text() if css.exists() else None
    go(page, 2); ready(page); click(page, 'p2/1')
    page.get_by_role('button', name='内側の余白', exact=True).click()
    drag(page, page.get_by_role('slider', name='上の余白'), 0, 15)
    page.wait_for_function("document.querySelector('.raw textarea').value.includes('height=200 pad=')")
    settled(page)
    before_text = ws.qmd('talk').read_text()
    before_visible = page.locator('.raw textarea').input_value()
    assert 'pad=' in before_text
    page.keyboard.press('Escape')
    page.get_by_role('button', name='図すべてに').click()
    expect(page.locator('.raw textarea')).not_to_have_value(before_visible)
    settled(page)
    after_text, after_css = ws.qmd('talk').read_text(), css.read_text()
    after_visible = page.locator('.raw textarea').input_value()
    assert '--fig-pad:' in after_css
    assert 'pad=' not in after_text
    page.locator('#undo').click()
    expect(page.locator('.raw textarea')).to_have_value(before_visible)
    page.wait_for_function("!document.querySelector('#redo').disabled")
    assert (css.read_text() if css.exists() else None) == before_css
    page.locator('#redo').click()
    expect(page.locator('.raw textarea')).to_have_value(after_visible)
    assert css.read_text() == after_css
    assert not page.errors
