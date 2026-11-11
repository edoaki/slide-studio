"""ページ移動：3か所のドラッグ、保存、取り消し、原文の保持。"""
import pytest
from playwright.sync_api import expect

from e2e.conftest import open_deck, rendered
from e2e.test_block_ops_js import run


@pytest.mark.parametrize('surface', ['strip', 'overview', 'qmd'])
def test_drag_page_and_undo(gui, page, surface):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    if surface == 'overview':
        page.get_by_role('button', name='一覧を表示').click()
    if surface == 'qmd':
        source = page.locator('#qblocks .page[data-page="3"] .page-num')
        target = page.locator('#qblocks .page[data-page="2"]')
        position = {'x': 30, 'y': 4}
    else:
        prefix = '#pagestrip' if surface == 'strip' else '.overview-screen'
        source = page.locator(f'{prefix} button[data-index]').filter(has_text='二枚目')
        target = page.locator(f'{prefix} button[data-index]').filter(has_text='一枚目')
        position = {'x': 4, 'y': 25}
    source.drag_to(target, target_position=position)
    expect(page.locator('#pagestrip button[data-index="2"]')).to_contain_text('二枚目')
    expect(page.locator('#status')).to_have_text('保存済み')
    rendered(page, ws)
    after = ws.qmd('talk').read_text()
    one = before.index('## 一枚目')
    two = before.index('## 二枚目')
    summary = before.index('## まとめ')
    assert after == before[:one] + before[two:summary] + before[one:two] + before[summary:]
    expect(page.locator('#pagestrip button[aria-current="true"]')).to_contain_text('二枚目')
    if surface == 'overview':
        expect(page.locator('.overview-screen')).to_be_visible()
        page.keyboard.press('Escape')
    page.locator('#undo').click()
    expect(page.locator('#status')).to_have_text('保存済み')
    expect(page.locator('#pagestrip button[data-index="2"]')).to_contain_text('一枚目')
    expect(page.locator('#status')).to_have_text('保存済み')
    rendered(page, ws)
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_move_page_preserves_source_and_boundaries(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = '---\ntitle: 😀\n---\n\n## A {#a}\n\n本文😀。\n\n# B {#b}\n\n## C {#c}\n\n末尾'
    result = run(page, '''
      const s = await st(text);
      const r = op.movePage(text, s, 2, 0);
      return [r.text, (await st(r.text)).pages.map(p => p.id),
        op.movePage(text, s, 0, 3).text,
        op.movePage(text, s, 1, 1), op.movePage(text, s, 1, 2)];
    ''', text)
    prefix, a, b, c = '---\ntitle: 😀\n---\n\n', '## A {#a}\n\n本文😀。\n\n', '# B {#b}\n\n', '## C {#c}\n\n末尾'
    assert result == [prefix + c + '\n\n' + a + b, ['c', 'a', 'b'], prefix + b + c + '\n\n' + a, None, None]


def test_drag_to_end_and_cancel(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    source = page.locator('#pagestrip button').filter(has_text='一枚目')
    target = page.locator('#pagestrip button').filter(has_text='Appendix')
    source.hover()
    start = source.bounding_box()
    page.mouse.down()
    page.mouse.move(start['x'] + start['width'] / 2 + 12, start['y'] + 25, steps=4)
    target.scroll_into_view_if_needed()
    width = target.bounding_box()['width']
    target.hover(position={'x': width - 4, 'y': 25})
    target.hover(position={'x': width - 4, 'y': 25})
    page.mouse.up()
    expect(page.locator('#pagestrip button').last).to_contain_text('一枚目')
    expect(page.locator('#status')).to_have_text('保存済み')
    rendered(page, ws)
    one, two = before.index('## 一枚目'), before.index('## 二枚目')
    after = before[:one] + before[two:] + '\n' + before[one:two]
    assert ws.qmd('talk').read_text() == after
    # 自分の場所へのドロップは履歴を増やさない。
    source.drag_to(source, target_position={'x': 4, 'y': 25})
    # 移動中の Escape は原稿を変えず、挿入線も消す。
    source.hover()
    start = source.bounding_box()
    page.mouse.down()
    page.mouse.move(start['x'] + start['width'] / 2 - 12, start['y'] + 25, steps=4)
    target.hover(position={'x': 30, 'y': 25})
    target.hover(position={'x': 30, 'y': 25})
    expect(page.locator('[data-page-drop]')).to_have_count(1)
    page.keyboard.press('Escape')
    page.mouse.up()
    expect(page.locator('[data-page-drop]')).to_have_count(0)
    assert ws.qmd('talk').read_text() == after
    page.locator('#undo').click()
    expect(page.locator('#pagestrip button[data-index="2"]')).to_contain_text('一枚目')
    expect(page.locator('#status')).to_have_text('保存済み')
    rendered(page, ws)
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


@pytest.mark.parametrize('direction', [-1, 1])
def test_qmd_drag_scrolls_before_edge_and_stops(gui, page, direction):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    # 長いページ自身の上でも、端の100px手前から静止したままスクロールする。
    initial = page.evaluate('''direction => {
      const scroll = document.querySelector('#qscroll');
      const source = document.querySelector('#qblocks .page[data-page="2"]');
      source.style.minHeight = '2400px';
      scroll.scrollTop += source.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 700;
      const box = scroll.getBoundingClientRect();
      window.dragData = new DataTransfer();
      window.dragPoint = {clientX: box.left + 50,
        clientY: direction > 0 ? box.bottom - 100 : box.top + 100};
      source.querySelector('.page-num').dispatchEvent(new DragEvent('dragstart', {
        bubbles: true, dataTransfer: dragData
      }));
      source.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dragData, ...dragPoint
      }));
      return scroll.scrollTop;
    }''', direction)
    page.wait_for_function('''({initial, direction}) =>
      (document.querySelector('#qscroll').scrollTop - initial) * direction > 60
    ''', arg={'initial': initial, 'direction': direction})
    # 中央へ戻したら停止し、端へ戻すと再開する。
    page.evaluate('''() => {
      const scroll = document.querySelector('#qscroll'), box = scroll.getBoundingClientRect();
      document.querySelector('#qblocks .page[data-page="2"]').dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dragData,
        clientX: dragPoint.clientX, clientY: box.top + box.height / 2
      }));
    }''')
    stopped = page.locator('#qscroll').evaluate('el => el.scrollTop')
    page.wait_for_timeout(200)
    assert page.locator('#qscroll').evaluate('el => el.scrollTop') == stopped
    page.evaluate('''() => {
      const source = document.querySelector('#qblocks .page[data-page="2"]');
      source.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dragData, ...dragPoint
      }));
    }''')
    page.wait_for_function('''previous => document.querySelector('#qscroll').scrollTop !== previous''', arg=stopped)
    page.locator('#qblocks .page[data-page="2"] .page-num').dispatch_event('dragend')
    stopped = page.locator('#qscroll').evaluate('el => el.scrollTop')
    page.wait_for_timeout(200)
    assert page.locator('#qscroll').evaluate('el => el.scrollTop') == stopped
    expect(page.locator('[data-page-drop]')).to_have_count(0)
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


@pytest.mark.parametrize('surface', ['strip', 'overview'])
def test_drop_updates_before_save(gui, page, surface):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    pending = []
    page.route('**/api/deck/talk/source', lambda route: pending.append(route) if route.request.method == 'PUT' else route.continue_())
    if surface == 'overview':
        page.keyboard.press('o')
    prefix = '#pagestrip' if surface == 'strip' else '.overview-screen'
    # イベントを分け、ドラッグ中の案内とドロップ直後の表示をそれぞれ確認する。
    page.evaluate("""prefix => {
      const buttons = [...document.querySelectorAll(prefix + ' button[data-index]')];
      const source = buttons.find(b => b.querySelector('.t').textContent === '二枚目');
      const target = buttons.find(b => b.querySelector('.t').textContent === '一枚目');
      target.scrollIntoView();
      window.pageDrag = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: pageDrag}));
      const r = target.getBoundingClientRect();
      window.pageDropTarget = target;
      window.pageDropOptions = {bubbles: true, cancelable: true, dataTransfer: pageDrag, clientX: r.left + 4, clientY: r.top + 25};
      target.dispatchEvent(new DragEvent('dragover', pageDropOptions));
    }""", prefix)
    expect(page.locator('.page-drop-hint')).to_have_text('3ページの前に移動')
    expect(page.locator('[data-page-drop="left"]')).to_have_count(1)
    page.evaluate("pageDropTarget.dispatchEvent(new DragEvent('drop', pageDropOptions))")
    expect(page.locator(f'{prefix} button[data-index]').nth(2)).to_contain_text('二枚目')
    expect(page.locator(f'{prefix} button[data-index]').nth(2).locator('.num')).to_have_text('3')
    expect(page.locator('#pagestrip button[data-index]').nth(2)).to_contain_text('二枚目')
    expect(page.locator('.page-drop-hint')).to_have_count(0)
    expect(page.locator('#status')).to_have_text('保存中')
    assert ws.qmd('talk').read_text() == before
    assert pending
    pending.pop().continue_()
    expect(page.locator('#status')).to_have_text('保存済み')
    rendered(page, ws)
    expect(page.locator('#pagestrip button[data-index="2"]')).to_contain_text('二枚目')
    assert not page.errors
