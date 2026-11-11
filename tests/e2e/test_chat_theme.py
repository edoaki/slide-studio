"""テーマタブのチャット切り替え・実行・復元。"""
from playwright.sync_api import expect
from .conftest import open_deck
from .test_memo import fake_codex  # noqa: F401


def test_theme_chat_prompt_only_when_closed(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    page.get_by_role('tab', name='テーマ', exact=True).click()
    prompt = page.locator('#stepSide [data-write]')
    expect(prompt).to_be_hidden()
    page.locator('#chatToggle').click()
    expect(prompt).to_be_visible()
    prompt.click()
    expect(prompt).to_be_hidden()
    expect(page.locator('.chat-input')).to_be_focused()
    page.locator('#chatToggle').click()
    expect(prompt).to_be_visible()
    page.locator('#chatToggle').click()
    expect(prompt).to_be_hidden()
    assert not page.errors


def test_theme_chat_switch_send_restore(gui, page):
    ws, srv = gui
    original = (ws.themes / 'default.css').read_text()
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    page.get_by_role('tab', name='テーマ', exact=True).click()
    expect(page.locator('.chat-mode')).to_have_text('テーマのチャット')
    expect(page.locator('#slideBox')).to_be_visible()
    expect(page.locator('#stepSide [data-write]')).to_be_hidden()
    expect(page.locator('.chat-mode')).to_have_text('テーマのチャット')
    expect(page.locator('.chat-target')).to_be_hidden()
    expect(page.locator('.chat-drafts')).to_be_hidden()
    page.locator('.chat-input').fill('sleep 2; replace #233244 => #123456')
    page.get_by_role('tab', name='下書き', exact=True).click()
    expect(page.locator('.chat-mode')).to_have_text('下書きのチャット')
    expect(page.locator('.chat-input')).to_have_value('')
    page.get_by_role('tab', name='テーマ', exact=True).click()
    expect(page.locator('.chat-input')).to_have_value('sleep 2; replace #233244 => #123456')
    page.wait_for_selector('.theme-fields input')
    page.locator('.chat-send').click()
    expect(page.locator('input[name="--ink"]')).to_be_disabled()
    assert not page.locator('#status').inner_text().startswith('AI 作業中')
    # 途中の返事（始めます）も普通に出るので、最後の返事を見る
    expect(page.locator('.chat-reply').last).to_contain_text('1件に対応しました。', timeout=30000)
    expect(page.locator('input[name="--ink"]')).to_be_enabled()
    expect(page.locator('input[name="--ink"]')).to_have_value('#123456')
    assert page.locator('.chat-results').count() == 0
    assert page.locator('.chat-ok').count() == 1
    page.locator('#editorToggle').click()
    expect(page.locator('.chat-mode')).to_be_hidden()
    page.locator('#editorToggle').click()
    expect(page.locator('.chat-mode')).to_have_text('テーマのチャット')
    page.locator('[data-act=restore]').click()
    page.locator('.dialog [data-a=yes]').click()
    expect(page.locator('input[name="--ink"]')).to_have_value('#233244')
    assert (ws.themes / 'default.css').read_text() == original
    page.get_by_role('tab', name='スライド', exact=True).click()
    expect(page.locator('.chat-mode')).to_be_hidden()
    expect(page.locator('.chat-target')).to_be_visible()
    assert not page.errors


def test_theme_chat_can_send_from_second_tab_while_first_runs(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    page.get_by_role('tab', name='テーマ', exact=True).click()
    page.wait_for_selector('.theme-fields input')
    page.locator('.chat-input').fill('sleep 5')
    page.locator('.chat-send').click()
    expect(page.locator('input[name="--ink"]')).to_be_disabled()
    page.locator('.chat-actions [data-act=add]').click()
    expect(page.locator('.chat-tab.on .chat-tab-name')).to_have_text('新しいタブ')
    page.locator('.chat-input').fill('sleep 1')
    with page.expect_response(lambda r: r.url.endswith('/send') and r.request.method == 'POST') as response:
        page.locator('.chat-send').click()
    assert response.value.ok
    rounds = page.request.get(f'{srv.url}/api/deck/talk/chat').json()['rounds']
    assert len([r for r in rounds if r['mode'] == 'theme' and r['state'] == 'run']) == 2
    # 他のタブが実行中なら、手動のテーマ編集は引き続きロックする。
    expect(page.locator('input[name="--ink"]')).to_be_disabled()
    expect(page.locator('input[name="--ink"]')).to_be_enabled(timeout=30000)
    expect(page.locator('.chat-round .chat-files')).to_be_visible(timeout=30000)
    assert not page.errors


def test_theme_cards_show_slide_lock_and_recover(gui, page):
    from .conftest import open_theme

    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    page.locator('.chat-input').fill('sleep 3; replace テスト発表 => テスト発表')
    page.locator('.chat-send').click()
    page.wait_for_function("document.querySelector('#status').textContent.startsWith('AI 作業中')")
    open_theme(page)
    card = page.locator('.tv-themes .theme-thumb[data-theme="graphite"]')
    expect(card).to_be_disabled()
    expect(page.locator('.tv-selection-lock')).to_be_visible()
    expect(page.locator('.tv-selection-lock')).to_have_text('AI作業中のためテーマ変更不可')
    assert 'theme: default' in ws.qmd('talk').read_text()
    expect(card).to_be_enabled(timeout=30000)
    expect(page.locator('.tv-selection-lock')).to_be_hidden()
    card.click()
    expect(card).to_have_attribute('aria-pressed', 'true')
    assert not page.errors
