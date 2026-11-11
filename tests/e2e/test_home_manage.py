"""ホームの発表カードの「…」メニュー：名前・フォルダ名の変更、削除、取り消し。"""
from playwright.sync_api import expect


def card(page, name='talk'):
    return page.locator(f'.deck-card-wrap[data-deck="{name}"]')


def choose(page, item, name='talk'):
    card(page, name).get_by_role('button', name='その他の操作（名前・フォルダ名の変更、削除）', exact=True).click()
    page.get_by_role('menu').get_by_role('menuitem', name=item, exact=True).click()


def test_rename_and_undo_by_notification(page, gui):
    ws, srv = gui
    original = ws.qmd('talk').read_text()
    page.goto(srv.url)
    choose(page, '名前を変更')
    dialog = page.get_by_role('dialog', name='名前を変更', exact=True)
    expect(dialog.get_by_label('タイトル', exact=True)).to_have_value('テスト発表')
    dialog.get_by_label('タイトル', exact=True).fill('変更した題')
    dialog.get_by_role('button', name='変更を保存', exact=True).click()
    expect(card(page)).to_contain_text('変更した題')
    assert ws.deck_meta('talk')['title'] == '変更した題'
    page.locator('.deck-notice').get_by_role('button', name='元に戻す', exact=True).click()
    expect(card(page)).to_contain_text('テスト発表')
    assert ws.qmd('talk').read_text() == original
    assert not page.errors


def test_folder_rename_keeps_title(page, gui):
    ws, srv = gui
    original = ws.qmd('talk').read_text()
    page.goto(srv.url)
    choose(page, 'フォルダ名を変更')
    dialog = page.get_by_role('dialog', name='フォルダ名を変更', exact=True)
    expect(dialog.get_by_label('フォルダ名', exact=True)).to_have_value('talk')
    dialog.get_by_label('フォルダ名', exact=True).fill('renamed')
    dialog.get_by_role('button', name='変更を保存', exact=True).click()
    expect(card(page, 'renamed')).to_contain_text('テスト発表')
    assert ws.has_deck('renamed') and not ws.has_deck('talk')
    assert ws.qmd('renamed').read_text() == original
    expect(page.locator('.deck-notice')).to_contain_text('フォルダ名を変更しました')
    page.keyboard.press('Meta+z')
    expect(card(page)).to_be_visible()
    assert ws.has_deck('talk') and not ws.has_deck('renamed')
    assert not page.errors


def test_menu_keyboard_and_outside_click(page, gui):
    _, srv = gui
    page.goto(srv.url)
    more = card(page).get_by_role('button', name='その他の操作（名前・フォルダ名の変更、削除）', exact=True)
    more.click()
    expect(more).to_have_attribute('aria-expanded', 'true')
    expect(page.get_by_role('menuitem', name='名前を変更', exact=True)).to_be_focused()
    page.keyboard.press('ArrowDown')
    expect(page.get_by_role('menuitem', name='フォルダ名を変更', exact=True)).to_be_focused()
    page.keyboard.press('Escape')
    expect(page.get_by_role('menu')).to_have_count(0)
    expect(more).to_be_focused()
    more.click()
    page.mouse.click(5, 5)
    expect(page.get_by_role('menu')).to_have_count(0)
    assert not page.errors


def test_delete_cancel_confirm_and_keyboard_undo(page, gui):
    ws, srv = gui
    page.goto(srv.url)
    choose(page, '削除')
    dialog = page.get_by_role('dialog', name='削除', exact=True)
    dialog.get_by_role('button', name='やめる', exact=True).click()
    expect(card(page)).to_be_visible()
    assert ws.has_deck('talk')
    choose(page, '削除')
    page.get_by_role('dialog', name='削除', exact=True).get_by_role('button', name='削除', exact=True).click()
    expect(card(page)).to_have_count(0)
    assert not ws.has_deck('talk')
    assert list((ws.state / 'trash/talk').glob('*/deck/slides.qmd'))
    page.keyboard.press('Meta+z')
    expect(card(page)).to_be_visible()
    assert ws.has_deck('talk')
    assert not page.errors


def test_running_deck_has_no_actions(page, gui):
    _, srv = gui
    def running(route):
        response = route.fetch()
        data = response.json()
        for deck in data['recent']:
            deck['running'] = True
        route.fulfill(response=response, json=data)
    page.route('**/api/home', running)
    page.goto(srv.url)
    expect(card(page)).to_be_visible()
    expect(card(page).get_by_role('button', name='その他の操作（名前・フォルダ名の変更、削除）', exact=True)).to_have_count(0)
    assert not page.errors
