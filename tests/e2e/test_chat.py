"""手順 6：チャットの画面（案 C2：ページごとに書きためて、まとめて送る）。テスト用の codex を使う。"""
import json
import re
import sys

import pytest

from conftest import FIXTURES
from e2e.conftest import expand_subs, open_deck
from playwright.sync_api import expect

from slide_studio.fsutil import write_atomic


@pytest.fixture(autouse=True)
def fake_codex(tmp_path, monkeypatch):
    exe = tmp_path / "codex"
    exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FIXTURES / "fake_codex.py"}" "$@"\n')
    exe.chmod(0o755)
    monkeypatch.setenv("SLIDE_STUDIO_CODEX", str(exe))


def go_slide(pg, i):
    pg.locator("#pagestrip button").nth(i).click()
    pg.wait_for_function(f"document.querySelector('#pagestrip button[aria-current=true]')?.dataset.index === '{i}'")


def reopen_history(page, text):
    page.wait_for_selector('.chat-input:not([disabled])')
    page.locator('.chat-actions > [data-act=hist]').click()
    page.locator('.chat-hrow', has_text=text).click()


def test_chat_toggle_shortcut_and_icon(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    input_box = page.locator('.chat-input')
    expect(input_box).not_to_be_disabled()
    toggle = page.locator('#chatToggle')
    expect(toggle).to_have_attribute('data-keys', '⌥ C')
    open_icon = toggle.inner_html()
    input_box.fill('下書き')

    input_box.press('Alt+KeyC')
    expect(input_box).not_to_be_visible()
    expect(toggle).to_have_attribute('data-keys', 'C')
    assert toggle.inner_html() != open_icon

    page.keyboard.press('Alt+KeyC')
    expect(input_box).to_be_focused()
    expect(input_box).to_have_value('下書き')
    expect(toggle).to_have_attribute('data-keys', '⌥ C')
    assert not page.errors


def test_open_chat_shortcut(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    go_slide(page, 2)
    page.locator('#chatToggle').click()
    expect(page.locator('.chat-input')).not_to_be_visible()
    page.keyboard.press('c')
    expect(page.locator('.chat-input')).to_be_focused()
    expect(page.locator('.chat-input')).to_have_value('')
    page.keyboard.press('c')
    expect(page.locator('.chat-input')).to_have_value('c')

    page.locator('#chatToggle').click()
    frame = page.frame_locator('#slideBox iframe:not(.loading)')
    frame.locator('[data-slide-studio="p2/0"]').click()
    page.keyboard.press('c')
    expect(page.locator('.chat-input')).not_to_be_visible()
    page.keyboard.press('Escape')
    page.keyboard.press('Shift+c')
    expect(page.locator('.chat-input')).not_to_be_visible()
    page.keyboard.press('c')
    expect(page.locator('.chat-input')).to_be_focused()
    expect(page.locator('.chat-input')).to_have_value('c')
    assert not page.errors


def test_drafts_per_page_send_and_restore(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 2)  # 一枚目
    page.fill(".chat-input", "replace 最初の段落。 => 書き換えた段落。")
    go_slide(page, 3)  # 二枚目：入力欄はそのページの指示に切り替わる
    assert page.input_value(".chat-input") == ""
    page.fill(".chat-input", "replace 左の列。 => 左。")
    assert page.locator(".chat-draft").count() == 2
    assert page.locator(".chat-tab .count").inner_text() == "2"
    assert page.locator("#pagestrip button").nth(2).locator(".chat-dots span").count() == 1
    # 書きかけの指示を押すと、そのページへ移って続きを書ける
    page.locator(".chat-draft .pick").first.click()
    page.wait_for_function("document.querySelector('#pagestrip button[aria-current=true]')?.dataset.index === '2'")
    assert "最初の段落" in page.input_value(".chat-input")
    # 開き直すと新しい会話になり、書きかけは履歴から戻せる
    page.wait_for_timeout(600)
    page.reload()
    page.wait_for_selector('.chat-input:not([disabled])')
    expect(page.locator('.chat-input')).to_have_value('')
    reopen_history(page, 'replace 最初の段落。')
    page.wait_for_selector(".chat-draft")
    assert page.locator(".chat-draft").count() == 2

    page.locator(".chat-send").click()
    page.wait_for_selector(".chat-files [data-act=restore]", timeout=30000)
    assert page.locator(".chat-draft").count() == 0
    assert page.locator(".chat-results svg.ok").count() == 2
    assert page.locator(".chat-ok").count() == 1
    text = ws.qmd("talk").read_text()
    assert "書き換えた段落。" in text and "左。" in text
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")

    page.locator("[data-act=restore]").click()
    page.locator(".dialog [data-a=yes]").click()
    page.wait_for_selector(".chat-files .chat-note")
    assert "書き換えた段落。" not in ws.qmd("talk").read_text()
    assert not page.errors


def test_lock_while_running_and_whole_deck_target(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    page.locator("[data-act=whole]").click()
    assert page.locator(".chat-tlabel").inner_text() == "発表全体"
    page.fill(".chat-input", "sleep 2")
    page.locator(".chat-send").click()
    page.wait_for_function("document.querySelector('#status').textContent.startsWith('AI 作業中')")
    assert page.locator(".chat-send").is_disabled()
    # ファイルを変えない送信なので、戻すは出ない
    page.wait_for_selector(".chat-round .chat-files", timeout=30000)
    assert page.locator("[data-act=restore]").count() == 0
    page.wait_for_function("!document.querySelector('#status').textContent.startsWith('AI 作業中')")
    assert not page.errors


def test_logged_out_shows_guidance_and_blocks_send(gui, page, monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_LOGGED_OUT", "1")
    ws, srv = gui
    page.request.get(f"{srv.url}/api/ai/status?refresh=1")  # 起動時の検出の後にログアウトした
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-notice .ai-onboarding")
    assert "Codex でスライドをつくる" in page.locator(".chat-notice").inner_text()
    assert page.locator('.chat-notice .warn, .chat-howto').count() == 0
    assert 'brew' not in page.locator('.chat-notice').inner_text()
    assert page.locator(".chat-send").is_disabled()
    # OS のブラウザー起動だけ差し替え、完了後の再検出まで確かめる。
    from unittest.mock import Mock
    browser = Mock(return_value=True)
    monkeypatch.setattr('webbrowser.open', browser)
    page.evaluate("() => { window.open = () => { throw new Error('unexpected popup'); }; }")
    monkeypatch.delenv("FAKE_CODEX_LOGGED_OUT")
    for theme in ['light', 'dark']:
        page.evaluate('theme => document.documentElement.dataset.theme = theme', theme)
        page.locator('.chat-notice').screenshot(path=f'/tmp/slide-studio-codex-login-{theme}.png', animations='disabled')
    page.locator('.ai-onboarding [data-mact=login]').click()
    page.wait_for_function("!document.querySelector('.chat-notice .ai-onboarding')")
    browser.assert_called_once_with('https://auth.openai.com/test')
    page.fill('.chat-input', 'なにか')
    page.wait_for_function("!document.querySelector('.chat-send').disabled")
    assert not page.errors



def test_codex_missing_login_failure_can_retry(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    page.evaluate("""async () => {
      const {helpHtml} = await import('/web/ai-model.js');
      document.querySelector('.chat-notice').innerHTML = helpHtml({id:'codex', reason:'missing'});
    }""")
    button = page.locator('.ai-onboarding [data-mact=login]')
    expect(button).to_be_enabled()
    page.route('**/api/ai/codex/login', lambda route: route.fulfill(
        status=400, content_type='application/json', body='{"error":"接続を確認して再試行してください"}'))
    page.evaluate("() => { window.open = () => { throw new Error('unexpected popup'); }; }")
    button.click()
    expect(page.locator('.ai-login-status')).to_have_text('接続を確認して再試行してください')
    expect(button).to_be_enabled()
    assert not page.errors


def test_undo_clearing_drafts(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 2)
    page.fill(".chat-input", "一枚目への指示")
    go_slide(page, 3)
    page.fill(".chat-input", "二枚目への指示")
    page.locator("[data-act=clear]").click()
    assert page.locator(".chat-draft").count() == 0
    page.keyboard.press("Meta+z")
    page.wait_for_function("document.querySelectorAll('.chat-draft').length === 2")
    assert page.input_value(".chat-input") == "二枚目への指示"
    # 1件だけ消しても戻せる。サーバーにも戻る
    page.locator(".chat-draft .x").first.click()
    assert page.locator(".chat-draft").count() == 1
    page.keyboard.press("Meta+z")
    page.wait_for_function("document.querySelectorAll('.chat-draft').length === 2")
    page.wait_for_timeout(700)
    page.reload()
    reopen_history(page, '一枚目への指示')
    page.wait_for_selector(".chat-draft")
    assert page.locator(".chat-draft").count() == 2
    assert not page.errors


def test_figure_target_and_keys(gui, page):
    from slide_studio import figures
    ws, srv = gui
    figures.new_figure(ws, "box", ws.shelf_dir("test"))
    ws.new_deck("other", "test")
    ws.qmd("other").write_text(ws.qmd("other").read_text() + "\n{{< fig test/box >}}\n")
    ws.qmd("talk").write_text(ws.qmd("talk").read_text().replace("まとめの段落。", "まとめの段落。\n\n{{< fig test/box height=200 >}}"))
    open_deck(page, srv, raw=False)
    page.wait_for_function("document.querySelector('#stage')?.dataset.blocks === 'ready'")
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 4)  # まとめ
    label = page.locator(".chat-tlabel")
    assert label.inner_text().startswith("p5") and page.locator("[data-act=page]").count() == 0
    # 図を押すと図への指示になり、［ページ］が出る
    page.frame_locator("#slideBox iframe:not(.loading)").locator('[data-slide-studio="p4/1"]').first.click()
    page.wait_for_function("document.querySelector('.chat-tlabel').textContent.trim() === '図 box'")
    assert "other" in page.locator(".chat-figure-users").inner_text()
    toggle = page.locator("[data-act=page]")
    assert toggle.get_attribute("aria-pressed") == "false" and toggle.get_attribute("data-keys") == "⌥ 2"
    page.fill(".chat-input", "色を変えて")
    toggle.click()
    assert label.inner_text().startswith("p5") and page.input_value(".chat-input") == ""
    assert page.locator("[data-act=page]").get_attribute("data-keys") == "⌥ 1"
    # ⌥1 図・⌥3 発表全体（入力欄の中でも使える）
    page.locator(".chat-input").press("Alt+Digit1")
    assert label.inner_text() == "図 box" and page.input_value(".chat-input") == "色を変えて"
    page.locator(".chat-input").press("Alt+Digit3")
    assert label.inner_text() == "発表全体"
    page.locator(".chat-input").press("Alt+Digit1")
    assert label.inner_text() == "図 box"
    # 未送信の指示に図として残り、押すと図を選び直す
    go_slide(page, 2)
    assert label.inner_text().startswith("p3")
    page.locator(".chat-draft .pick").first.click()
    page.wait_for_function("document.querySelector('.chat-tlabel').textContent.trim() === '図 box'")
    assert page.locator(".chat-draft .chat-chip.fig").inner_text() == "box"
    # スライドの中で押したキーも効く
    page.frame_locator("#slideBox iframe:not(.loading)").locator('[data-slide-studio="p4/1"]').first.press("Alt+Digit2")
    assert label.inner_text().startswith("p5")
    assert not page.errors


PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def test_model_effort_attach_and_context(gui, page, tmp_path):
    import base64
    import json
    ws, srv = gui
    open_deck(page, srv, raw=False)
    btn = page.locator(".ai-mbtn")
    page.wait_for_selector(".ai-mbtn:not([disabled])")
    assert btn.inner_text().replace("\n", "") == "Test Big中"
    # 思考量：スライダー（←→）。確定して保存する
    btn.click()
    assert "Codex" not in page.locator(".ai-pop").inner_text()
    assert page.locator(".ai-pop").bounding_box()["height"] < 160
    assert page.locator(".ai-slider").get_attribute("aria-valuetext") == "中"
    page.screenshot(path=str(tmp_path / "model-effort.png"))
    assert page.locator(".ai-stop").count() == 4
    slide_index = page.locator('#pagestrip button[aria-current="true"]').get_attribute("data-index")
    page.locator(".ai-slider").press("ArrowRight")
    assert page.locator('#pagestrip button[aria-current="true"]').get_attribute("data-index") == slide_index
    page.wait_for_function("document.querySelector('.ai-slider').getAttribute('aria-valuetext') === '高'")
    assert "高" in btn.inner_text()
    page.wait_for_function("fetch(location.origin + '/api/deck/talk/chat').then(r => r.json()).then(s => s.tabs[0].effort === 'high')")
    page.locator(".ai-slider").press("ArrowLeft")
    page.wait_for_function("document.querySelector('.ai-slider').getAttribute('aria-valuetext') === '中'")
    assert page.locator(".ai-slider").get_attribute("aria-valuetext") == "中"
    # モデル：よく使うモデルと検索。使えない AI は開くと案内
    page.locator(".ai-mname").click()
    assert page.locator(".ai-row").count() == 1
    assert page.locator(".ai-row [role=checkbox]").count() == 0
    page.get_by_role("button", name="モデルを追加", exact=True).click()
    assert page.locator(".ai-catalog .ai-row").count() == 2  # 検索前から全候補が出る
    page.screenshot(path=str(tmp_path / "model-catalog.png"))
    assert page.locator(".ai-bad").count() == 2  # テストでは Claude Code と Antigravity が無い
    page.locator(".ai-bad .pick").first.click()
    expect(page.locator(".ai-bad.open .ai-login")).to_have_text("ダウンロード")
    expect(page.locator(".ai-bad.open .ai-login")).to_have_attribute("data-download", "true")
    search_y = page.locator(".ai-search input").bounding_box()["y"]
    page.fill(".ai-search input", "small")
    assert page.locator(".ai-search input").bounding_box()["y"] == search_y  # 候補が減っても入力欄は動かない
    page.locator('[data-mact=favorite][data-key="codex:test-small"]').click()
    page.wait_for_function("document.querySelector('[data-mact=favorite][data-key=\"codex:test-small\"]').getAttribute('aria-checked') === 'true'")
    assert 'Test Big' in btn.inner_text()
    page.keyboard.press('Escape')
    assert page.locator('[role=checkbox]').count() == 0
    page.locator('[data-mact=pick][data-key="codex:test-small"]').click()
    page.wait_for_function("document.querySelector('.ai-mbtn').textContent.includes('Test Small')")
    page.keyboard.press('Escape')
    assert page.locator('.ai-pop').is_hidden()
    # 添付：＋（ファイルを選ぶ）と貼り付け。写真は images/、ほかは materials/
    shot = tmp_path / "shot.png"; shot.write_bytes(base64.b64decode(PNG))
    memo = tmp_path / "memo.txt"; memo.write_text("メモ")
    page.locator(".chat-file").set_input_files([str(shot), str(memo)])
    page.wait_for_function("document.querySelectorAll('.chat-field .chat-att').length === 2")
    page.locator(".chat-input").focus()
    page.evaluate(f"""() => {{
      const bin = Uint8Array.from(atob('{PNG}') + '\\0', c => c.charCodeAt(0));  // 中身を変える（同じ中身は再利用される）
      const dt = new DataTransfer(); dt.items.add(new File([bin], 'image.png', {{ type: 'image/png' }}));
      document.querySelector('.chat-input').dispatchEvent(new ClipboardEvent('paste', {{ clipboardData: dt, bubbles: true, cancelable: true }}));
    }}""")
    page.wait_for_function("document.querySelectorAll('.chat-field .chat-att').length === 3")
    assert page.locator(".chat-field .chat-att.img img").count() == 2
    # 添付しただけでは保存しない（送信したときに置く）
    assert not (ws.asset_root("talk") / "images" / "shot.png").exists()
    assert not (ws.deck_dir("talk") / "materials" / "memo.txt").exists()
    # 送信：添付は送った指示に残り、コンテキストの円が出る。送った後もモデルを変更できる
    page.fill(".chat-input", "noop")
    page.locator(".chat-send").click()
    page.wait_for_selector(".chat-round .chat-files", timeout=30000)
    assert (ws.asset_root("talk") / "images" / "shot.png").is_file()
    assert (ws.deck_dir("talk") / "materials" / "memo.txt").read_text() == "メモ"
    assert list((ws.asset_root("talk") / "images").glob("paste-*.png"))
    assert page.locator(".chat-sent .chat-att").count() == 3 and page.locator(".chat-field .chat-att").count() == 0
    assert "Test Small" in page.locator(".chat-sent-model").inner_text()
    page.wait_for_selector(".chat-ctx:not([hidden])")
    # ツールチップにはアカウントの上限も出す（5時間の分は実行中の知らせで更新される）
    page.wait_for_function("document.querySelector('.chat-ctx').getAttribute('aria-label').includes('5時間の上限：30%')")
    label = page.locator(".chat-ctx").get_attribute("aria-label")
    assert label.startswith("コンテキスト：25% を使用済み（残り 75%）\n使用済みトークン：48K / 190K\n\n5時間の上限：30% を使用済み（")
    assert "\n1週間の上限：40% を使用済み（" in label and "にリセット" in label
    log = json.loads((ws.state / "fake-codex" / "0.json").read_text())
    assert sum(a.startswith("--image=") for a in log["argv"]) == 2 and "materials/memo.txt" in log["prompt"]
    btn.click()
    page.locator('.ai-mname').click()
    assert page.locator('[data-mact=pick][data-key="codex:test-big"]').get_attribute('aria-disabled') == 'false'
    assert page.locator('[data-mact=add]').is_visible()  # 使用中も表示リストは編集できる
    assert not page.errors


def test_subagent_settings_per_chat_persist_and_run(gui, page):
    from playwright.sync_api import expect
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.ai-mbtn:not([disabled])')
    page.locator('.ai-mbtn').click()
    assert page.locator('[data-mact=add]').count() == 0
    page.locator('.ai-main-model .ai-mname').click()
    assert page.locator('[role=checkbox]').count() == 0
    page.locator('[data-mact=add]').click()
    page.locator('[data-mact=favorite][data-key="codex:test-small"]').click()
    expect(page.locator('[data-mact=favorite][data-key="codex:test-small"]')).to_have_attribute('aria-checked','true')
    page.keyboard.press('Escape')
    page.keyboard.press('Escape')
    expand_subs(page)
    # 確認役と相談役（図の担当は無い。編集担当が図も作る）
    expect(page.locator('.ai-sub-row')).to_have_count(2)
    assert all('Test Big' in s for s in page.locator('.ai-sub-row .ai-mname').all_text_contents())
    assert 'チャットと同じ' not in page.locator('.ai-pop').inner_text()
    page.locator('.ai-mname[data-role="review"]').click()
    assert page.locator('[data-mact=add], [role=checkbox], select').count() == 0
    page.locator('[data-mact=pick][data-key="codex:test-small"]').click()
    page.wait_for_function("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>s.tabs.find(t=>t.mode==='slides').ai_roles.review?.model==='codex:test-small')")
    expect(page.locator('.ai-mname[data-role="review"]')).to_contain_text('Test Small')
    for theme in ['light','dark']:
        page.evaluate('t=>document.documentElement.dataset.theme=t', theme)
        page.screenshot(path=f'/tmp/slide-studio-picker-{theme}.png')
    page.locator('.ptabs [data-tab=memo]').click()
    expect(page.locator('.ai-pop')).to_be_hidden()
    page.locator('.ai-mbtn').click()
    expand_subs(page)
    expect(page.locator('.ai-sub-row')).to_have_count(2)
    expect(page.locator('.ai-mname[data-role="review"]')).to_contain_text('Test Big')  # タブごとの設定
    page.locator('.ai-mname[data-role="review"]').click()
    page.locator('[data-mact=pick][data-key="codex:test-small"]').click()
    page.wait_for_function("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>s.tabs.find(t=>t.mode==='memo').ai_roles.review?.model==='codex:test-small')")
    page.reload()
    page.wait_for_selector('.ai-mbtn:not([disabled])')
    page.locator('.ptabs [data-tab=memo]').click()
    page.locator('.ai-mbtn').click()
    expand_subs(page)
    expect(page.locator('.ai-mname[data-role="review"]')).to_contain_text('Test Small')
    page.locator('.ptabs [data-tab=qmd]').click()
    page.locator('.ai-mbtn').click()
    expand_subs(page)
    expect(page.locator('.ai-mname[data-role="review"]')).to_contain_text('Test Small')
    # 親のモデルを選ぶと追従へ戻る。同じモデルの思考量だけを個別指定できる。
    page.locator('.ai-mname[data-role="review"]').click()
    page.locator('[data-mact=pick][data-key="codex:test-big"]').click()
    page.wait_for_function("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>!s.tabs.find(t=>t.mode==='slides').ai_roles.review)")
    page.locator('.ai-slider[data-role="review"]').press('End')
    page.wait_for_function("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>s.tabs.find(t=>t.mode==='slides').ai_roles.review?.effort==='xhigh')")
    page.keyboard.press('Escape')
    page.fill('.chat-input','noop')
    page.locator('.chat-send').click()
    page.wait_for_selector('.chat-round .chat-files',timeout=30000)
    state=page.request.get(srv.url+'/api/deck/talk/chat').json()
    assert state['rounds'][-1]['ai_roles']['review']=={'model':'codex:test-big','effort':'xhigh'}
    assert not page.errors


def test_model_changes_keep_subagent_on(gui, page, tmp_path):
    from playwright.sync_api import expect
    ws, srv = gui
    page.request.put(srv.url+'/api/ai/favorites', data={'favorites':['codex:test-big','codex:test-small']})
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.ai-mbtn:not([disabled])')
    page.locator('.ai-mbtn').click()
    expand_subs(page)
    consult = page.locator('[data-mact=role-toggle][data-role=consult]')
    expect(consult).to_have_attribute('aria-checked', 'false')  # 相談役は既定でオフ
    consult.click()
    expect(consult).to_have_attribute('aria-checked', 'true')
    roles = "fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>s.tabs.find(t=>t.mode==='slides').ai_roles.consult)"
    page.wait_for_function(f"{roles}.then(c=>c?.enabled===true)")
    for theme in ['light','dark']:
        page.evaluate('t=>document.documentElement.dataset.theme=t', theme)
        page.locator('.ai-pop').screenshot(path=str(tmp_path / f'subs-{theme}.png'))
    # 相談役のモデルを変えても、チャットに追従へ戻しても、チャットのモデルを変えてもオンのまま
    for key in ['codex:test-small', 'codex:test-big']:
        page.locator('.ai-mname[data-role="consult"]').click()
        page.locator(f'[data-mact=pick][data-key="{key}"]').click()
        expect(consult).to_have_attribute('aria-checked', 'true')
        page.wait_for_function(f"{roles}.then(c=>c?.enabled===true && (c.model||'codex:test-big')==='{key}')")
    page.locator('.ai-main-model .ai-mname').click()
    page.locator('[data-mact=pick][data-key="codex:test-small"]').click()
    page.wait_for_function("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>s.tabs.find(t=>t.mode==='slides').model==='codex:test-small')")
    expect(consult).to_have_attribute('aria-checked', 'true')
    expect(page.locator('.ai-mname[data-role="consult"]')).to_contain_text('Test Small')
    page.keyboard.press('Escape')
    page.locator('.ai-mbtn').click()
    expect(page.locator('.ai-sub-row')).to_have_count(2)  # 開いたまま
    page.locator('[data-mact=subs]').click()
    expect(page.locator('.ai-sub-chip.on')).to_have_count(2)
    assert not page.errors


def test_role_save_failure_does_not_erase_queued_change(gui, page):
    from playwright.sync_api import expect
    ws, srv = gui
    page.request.put(srv.url+'/api/ai/favorites', data={'favorites':['codex:test-big','codex:test-small']})
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.ai-mbtn:not([disabled])')
    page.fill('.chat-input','noop')
    held, requests = [], []
    def intercept(route):
        body=route.request.post_data_json
        if route.request.method=='PATCH' and 'ai_roles' in body:
            requests.append(body)
            if len(requests)==1:
                held.append(route)
                return
        route.continue_()
    page.route('**/api/deck/talk/chat/tabs/*',intercept)
    def open_review():
        page.locator('.ai-mbtn').click()
        expand_subs(page)
    # 1つ目（思考量）の保存が失敗しても、待っている2つ目（モデル）は消えない
    open_review()
    page.locator('.ai-slider[data-role="review"]').press('End')
    expect(page.locator('.chat-send')).to_be_disabled()
    page.locator('.ptabs [data-tab=memo]').click()
    page.locator('.ptabs [data-tab=qmd]').click()
    open_review()
    page.locator('.ai-mname[data-role="review"]').click()
    page.locator('[data-mact=pick][data-key="codex:test-small"]').click()
    assert len(requests)==1
    held[0].fulfill(status=400,content_type='application/json',body='{"error":"保存できませんでした"}')
    page.wait_for_function("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>s.tabs.find(t=>t.mode==='slides').ai_roles.review?.model==='codex:test-small')")
    expect(page.locator('.ai-mname[data-role="review"]')).to_contain_text('Test Small')
    expect(page.locator('.chat-send')).to_be_enabled()
    assert len(requests)==2
    assert not page.errors


def test_review_issues_left_after_limit_can_be_resent(gui, page):
    """確認役の指摘を同じ会話で直させ、上限まで残った指摘は［確認の指摘を添えて再依頼］で未送信の指示に加える（作業手順書 A5）。"""
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 2)
    page.fill(".chat-input", "replace 最初の段落。 => 確認する段落。; reviewng 9; fixwith 確認する段落。 => 一度。; fixwith 一度。 => 二度。; fixwith 二度。 => 三度。")
    page.locator(".chat-send").click()
    page.wait_for_selector("[data-act=retry-review]", timeout=30000)
    notes = page.locator(".chat-ai .chat-note").all_text_contents()
    assert sum("確認で指摘 1件 → 直させました" in n for n in notes) == 3
    assert any("3回直させても確認の指摘が残りました" in n for n in notes)
    assert "テストの指摘" in page.locator(".agent-result").last.inner_text()
    page.locator("[data-act=retry-review]").click()
    page.wait_for_selector(".chat-draft")
    page.wait_for_timeout(600)
    drafts = page.request.get(srv.url + "/api/deck/talk/chat").json()["tabs"][0]["drafts"]
    assert "確認で見つかった問題を直して：全体：テストの指摘" in drafts["deck"]
    assert not page.errors


def test_check_errors_from_before_are_shown_apart(gui, page):
    """送信の前からあった検査のエラーは別の欄（開閉）に出し、要修正・再依頼にしない（作業手順書 A7）。"""
    ws, srv = gui
    write_atomic(ws.qmd("talk"), ws.qmd("talk").read_text().replace("## 二枚目 {#two}", "## 二枚目"))
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 2)
    page.fill(".chat-input", "replace 最初の段落。 => 書き換えた段落。")
    page.locator(".chat-send").click()
    old = page.locator("details.chat-box.warn", has_text="送信の前からあった検査のエラー 1件")
    old.wait_for(timeout=30000)
    expect(page.locator(".chat-ai .chat-ok").last).to_be_visible()
    expect(page.locator(".chat-ai .chat-box.bad")).to_have_count(0)
    expect(page.locator("[data-act=retry]")).to_have_count(0)
    old.locator("summary").click()
    expect(old).to_contain_text("二枚目")
    assert not page.errors


def test_cycle_uses_current_version_review_for_display_and_retry(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 2)
    page.fill(".chat-input", "replace 最初の段落。 => Aの段落。; reviewng 9; fixwith Aの段落。 => Bの段落。; fixwith Bの段落。 => Aの段落。")
    page.locator(".chat-send").click()
    page.wait_for_selector("[data-act=retry-review]", timeout=30000)
    chat = srv.app.state.chat
    r = chat.state("talk")["rounds"][-1]
    reviews = [a for a in r["agents"] if a["role"] == "review"]
    assert len(reviews) == 2 and r["final_review"] == reviews[0]["id"]
    reviews[0]["issues"][0]["message"] = "現在のAに残る問題"
    reviews[1]["issues"][0]["message"] = "過去のBだけの問題"
    chat.save("talk")
    chat.broadcast("talk", r)
    expect(page.locator(".agent-result").last).to_contain_text("現在のAに残る問題")
    page.locator("[data-act=retry-review]").click()
    expect(page.locator(".chat-draft")).to_contain_text("現在のAに残る問題")
    expect(page.locator(".chat-draft")).not_to_contain_text("過去のBだけの問題")
    # 問題なし・古い確認は、確認中の変更ファイルの注意とともに表示しない。
    current = reviews[0]
    r["review_changes"] = ["decks/talk/slides.qmd"]
    for review_state in ("complete", "stale"):
        current.update(state=review_state, summary="指示どおりです。", issues=[])
        chat.broadcast("talk", r)
        expect(page.locator(".agent-result")).to_have_count(0)
        expect(page.locator(".chat-ai")).not_to_contain_text("確認中に変更されたファイル")
        expect(page.locator(".chat-ai")).not_to_contain_text("指示どおりです。")
    current.update(state="error", error="確認の実行に失敗しました")
    chat.broadcast("talk", r)
    expect(page.locator(".agent-result")).to_contain_text("確認の実行に失敗しました")
    assert not page.errors


def test_continue_with_selected_model_keeps_chat(gui, page, tmp_path):
    ws, srv = gui
    (ws.state / 'fake-edit-limit').touch()
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    go_slide(page, 2)
    page.fill('.chat-input', 'replace 最初の段落。 => 続行する段落。')
    page.locator('.chat-send').click()
    button = page.get_by_role('button', name='別モデルで続ける', exact=True)
    expect(button).to_be_visible(timeout=30000)
    button.click()
    # 候補に追加してから選択。選択だけでは送信しない。
    page.locator('[data-mact=add]').click()
    page.locator('[data-mact=favorite][data-key="codex:test-small"]').click()
    page.keyboard.press('Escape')
    page.locator('[data-mact=pick][data-key="codex:test-small"]').click()
    expect(page.locator('.chat-round')).to_have_count(1)
    page.keyboard.press('Escape')
    page.get_by_role('button', name='選択したモデルで続ける', exact=True).click()
    expect(page.locator('.chat-round')).to_have_count(2)
    # 変えたのは中断した送信なので、戻すはそちらに出る。続きは何も変えていない
    expect(page.locator('.chat-round').last.locator('.chat-files')).to_contain_text('ファイルの変更なし', timeout=30000)
    expect(page.locator('.chat-round').first.locator('[data-act=restore]')).to_be_visible()
    expect(page.locator('.chat-round').last).to_contain_text('codex:test-big → codex:test-small')
    expect(page.locator('.chat-round').last).to_contain_text('中断した送信の続き')
    assert '続行する段落。' in ws.qmd('talk').read_text()
    page.screenshot(path=str(tmp_path / 'continue-model.png'))
    assert not page.errors


def test_continue_review_picker_changes_only_reviewer(gui, page):
    ws, srv = gui
    (ws.state / 'fake-review-limit').touch()
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    page.request.put(f'{srv.url}/api/ai/favorites', data={'favorites': ['codex:test-big', 'codex:test-small']})
    page.reload()
    page.wait_for_selector('.chat-input:not([disabled])')
    go_slide(page, 2)
    page.fill('.chat-input', 'replace 最初の段落。 => 確認だけ再開。')
    page.locator('.chat-send').click()
    button = page.get_by_role('button', name='確認役を選んで続ける', exact=True)
    expect(button).to_be_visible(timeout=30000)
    count = len(list((ws.state / 'fake-codex').glob('*.json')))
    button.click()
    expect(page.locator('.ai-pop .ai-sec')).to_have_text('確認')
    page.locator('[data-mact=pick][data-key="codex:test-small"]').click()
    page.keyboard.press('Escape')
    page.get_by_role('button', name='選択したモデルで続ける', exact=True).click()
    expect(page.locator('.chat-round')).to_have_count(2)
    # 問題なしの確認は表示しない（履歴に残すだけ）。終わったことは操作の欄で分かる
    expect(page.locator('.chat-round').last.locator('.chat-acts')).to_be_attached(timeout=30000)
    expect(page.locator('.chat-round').last.locator('.agent-result')).to_have_count(0)
    assert len(list((ws.state / 'fake-codex').glob('*.json'))) == count
    data = page.request.get(f'{srv.url}/api/deck/talk/chat').json()
    assert data['rounds'][-1]['model'] == 'codex:test-big'
    assert data['rounds'][-1]['ai_roles']['review']['model'] == 'codex:test-small'
    assert not page.errors


@pytest.mark.parametrize("mode", ["slides", "memo", "theme"])
def test_send_feedback_before_save_and_failed_request(gui, page, mode, tmp_path):
    """保存・送信の返事を止めても即表示し、失敗時は本文と添付を戻す。"""
    _, srv = gui
    open_deck(page, srv, raw=False)
    if mode != "slides":
        page.get_by_role("tab", name={"memo": "下書き", "theme": "テーマ"}[mode], exact=True).click()
    page.wait_for_selector('.chat-input:not([disabled])')
    if mode == "theme":
        page.wait_for_selector('.theme-fields input')
    page.locator('.chat-file').set_input_files({
        "name": "note.txt", "mimeType": "text/plain", "buffer": b"reference",
    })
    saves, sends = [], []
    def hold_save(route):
        if route.request.method == "PATCH":
            saves.append(route)
        else:
            route.continue_()
    page.route("**/chat/tabs/*", hold_save)
    page.route("**/chat/tabs/*/send", lambda route: sends.append(route))
    page.fill('.chat-input', 'sleep 1')
    # 入力可能になった後も AI の準備中は送信できない。evaluate 内の click は自動待機しない。
    expect(page.locator('.chat-send')).to_be_enabled()
    # 同じイベント内でも表示が変わる。連打も送信を増やさない。
    immediate = page.evaluate("""() => {
        const button = document.querySelector('.chat-send');
        button.click(); button.click();
        return { text: document.querySelector('.chat-pending')?.textContent,
                 input: document.querySelector('.chat-input').value,
                 busy: button.getAttribute('aria-busy') };
    }""")
    assert '送信しています…' in immediate['text'] and 'sleep 1' in immediate['text']
    assert immediate['input'] == '' and immediate['busy'] == 'true'
    expect(page.locator('.chat-pending')).to_be_visible()
    expect(page.locator('.chat-tab.on [data-act=close]')).to_have_count(0)
    expect(page.locator('.chat-tab.on .chat-tab-status')).to_have_text('送信中')
    expect(page.locator('.chat-input')).to_be_disabled()
    expect(page.locator('.chat-pending .chat-att')).to_contain_text('note.txt')
    expect(page.locator('.chat-pending [data-act=unattach]')).to_have_count(0)
    page.screenshot(path=str(tmp_path / f'chat-sending-{mode}.png'))
    assert not sends
    page.wait_for_timeout(50)
    assert len(saves) == 1
    saves.pop().continue_()
    # HTTP の返事まで待機表示が続く。
    expect(page.locator('.chat-field > .chat-attach')).to_be_empty()
    for _ in range(100):
        if sends:
            break
        page.wait_for_timeout(50)
    assert len(sends) == 1
    expect(page.locator('.chat-pending')).to_be_visible()
    sends.pop().fulfill(status=503, json={"error": "送信テストのエラー"})
    expect(page.locator('.chat-pending')).to_have_count(0)
    expect(page.locator('.chat-input')).to_have_value('sleep 1')
    expect(page.locator('.chat-input')).to_be_enabled()
    expect(page.locator('.chat-field .chat-att')).to_contain_text('note.txt')
    expect(page.locator('.chat-send')).to_be_enabled()
    expect(page.locator('.chat-send')).to_have_attribute('aria-busy', 'false')
    expect(page.locator('.chat-tab.on [data-act=close]')).to_have_count(1)
    expect(page.locator('.chat-tab.on .chat-tab-status')).to_have_count(0)
    page.unroute("**/chat/tabs/*/send")
    page.unroute("**/chat/tabs/*", hold_save)
    page.locator('.chat-send').click()
    page.wait_for_selector('.chat-round .chat-files', timeout=30000)
    expect(page.locator('.chat-box.bad')).to_have_count(0)
    expect(page.locator('.chat-pending')).to_have_count(0)
    expect(page.locator('.chat-round')).to_have_count(1)
    expect(page.locator('.chat-input')).to_have_value('')
    expect(page.locator('.chat-field > .chat-attach')).to_be_empty()
    assert not page.errors


def test_resolved_reviews_hidden_and_decisions_orange(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 2)
    page.fill(".chat-input", "replace 最初の段落。 => 確認する段落。; reviewng 1; fixwith 確認する段落。 => 直した段落。")
    page.locator(".chat-send").click()
    # 直して問題なしになった確認は表示しない（履歴に残すだけ）
    expect(page.locator('.chat-round .chat-acts')).to_be_attached(timeout=30000)
    expect(page.locator('.agent-result')).to_have_count(0)
    expect(page.locator('.chat-ai')).not_to_contain_text('テストの指摘')
    chat = srv.app.state.chat
    r = chat.state('talk')['rounds'][-1]
    review = next(a for a in r['agents'] if a['id'] == r['final_review'])
    review.update(state='needs_fix', summary='判断が必要です。', issues=[{
        'target': '次に扱う問題', 'message': '【要判断】コンペを選んでください', 'suggestion': '候補A、候補B'}])
    r.update(state='fail', review_ok=False)
    chat.save('talk')
    chat.broadcast('talk', r)
    notice = page.locator('.agent-result.decision-needed')
    expect(notice).to_contain_text('判断が必要です')
    assert notice.evaluate('(el) => getComputedStyle(el).color') == 'rgb(154, 70, 0)'
    assert not page.errors


def test_ai_question_is_answered_with_a_click(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 2)
    question = [{"item": 1, "text": "次ページも変えますか？", "multiple": False, "options": [
        {"label": "含める", "description": "次ページも変更する"}, {"label": "含めない", "description": ""}]}]
    write_atomic(ws.state / "fake-questions", json.dumps(question, ensure_ascii=False))
    page.fill(".chat-input", "fail")
    page.locator(".chat-send").click()
    first = page.locator('.chat-tab.on [data-act=tab]').get_attribute('data-tab')
    page.locator('.chat-actions [data-act=add]').click()
    waiting = page.locator(f'.chat-tab:has([data-act=tab][data-tab="{first}"])')
    expect(waiting).to_have_class('chat-tab awaiting-answer', timeout=30000)
    expect(waiting.locator('[role=tab]')).to_have_attribute('aria-label', re.compile('確認待ち'))
    expect(waiting.locator('.dot')).to_have_count(0)
    assert waiting.evaluate("el => getComputedStyle(el).boxShadow") != 'none'
    assert waiting.locator('.chat-tab-name').evaluate("el => getComputedStyle(el).borderBottomWidth") == '2px'
    waiting.locator('[data-act=tab]').click()
    expect(waiting).to_have_class('chat-tab on awaiting-answer')
    # 確認待ちの件は ✕ ではなく ? を出し、選択肢を押すだけで同じ対象への次の送信になる
    option = page.locator('.chat-option', has_text='含める')
    expect(option).to_be_visible(timeout=30000)
    expect(page.locator('.chat-option').first.locator('small')).to_have_text('次ページも変更する')
    expect(page.locator('.chat-results svg.ask')).to_have_count(1)
    option.click()
    expect(page.locator('.chat-round').nth(1).locator('.chat-item').first).to_contain_text('次ページも変えますか？ → 含める', timeout=30000)
    expect(waiting).to_have_class('chat-tab on')
    # 答えた後は選べない
    expect(page.locator('.chat-round').first.locator('.chat-option')).to_have_count(0)
    expect(page.locator('.chat-round').first.locator('.chat-question-text')).to_have_text('次ページも変えますか？')
    rounds = srv.app.state.chat.state('talk')['rounds']
    assert rounds[-1]['items'][0]['key'] == rounds[-2]['items'][0]['key']
    assert not page.errors


def test_ai_questions_with_multiple_choices_wait_for_send(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 2)
    options = lambda *names: [{"label": n, "description": ""} for n in names]
    write_atomic(ws.state / "fake-questions", json.dumps([
        {"item": 1, "text": "どの図？", "multiple": True, "options": options("図A", "図B", "図C")},
        {"item": 1, "text": "順番は？", "multiple": False, "options": options("先", "後")},
    ], ensure_ascii=False))
    page.fill(".chat-input", "fail")
    page.locator(".chat-send").click()
    submit = page.locator('[data-act=answer-send]')
    expect(submit).to_be_disabled(timeout=30000)
    page.locator('.chat-option', has_text='図C').click()
    page.locator('.chat-option', has_text='図A').click()
    expect(page.locator('.chat-option[aria-pressed=true]')).to_have_count(2)
    expect(submit).to_be_disabled()  # 全部の質問に答えるまで送れない
    page.locator('.chat-option', has_text='後').click()
    submit.click()
    sent = page.locator('.chat-round').nth(1).locator('.chat-item').first
    expect(sent).to_contain_text('どの図？ → 図A、図C', timeout=30000)
    expect(sent).to_contain_text('順番は？ → 後')
    assert not page.errors


def test_last_tab_is_replaced_not_emptied(gui, page):
    # 新しいタブ1つだけなら閉じられない。書いたら閉じられ、閉じると新しいタブに入れ替わる
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    tabs = page.locator(".chat-tab")
    expect(tabs).to_have_count(1)
    expect(tabs.locator("[data-act=close]")).to_have_count(0)
    go_slide(page, 2)
    page.fill(".chat-input", "replace 最初の段落。 => 書き換えた段落。")
    expect(tabs.locator("[data-act=close]")).to_have_count(1)
    first = tabs.first.locator("[data-act=tab]").get_attribute("data-tab")
    tabs.locator("[data-act=close]").click()
    expect(tabs.locator(f"[data-tab={first}]")).to_have_count(0)
    expect(tabs).to_have_count(1)
    expect(page.locator(".chat-main")).to_be_visible()
    expect(tabs.locator("[data-act=close]")).to_have_count(0)
    expect(page.locator(".chat-input")).to_have_value("")
    expect(page.locator(".chat-cross")).to_have_count(0)
    expect(page.locator("#stepSide")).to_be_empty()
    # 閉じたタブは履歴から戻せ、2つ以上なら新しいタブも閉じられる
    page.locator(".chat-actions > [data-act=hist]").click()
    page.locator(f".chat-hist [data-act=reopen][data-tab={first}]").click()
    expect(tabs).to_have_count(2)
    expect(tabs.locator("[data-act=close]")).to_have_count(2)
    page.reload()
    page.wait_for_selector(".chat-input:not([disabled])")
    expect(page.locator(".chat-cross")).to_have_count(0)
    expect(page.locator("#stepSide")).to_be_empty()


def test_reload_starts_fresh_and_keeps_only_running_conversations_open(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    first = page.locator('.chat-tab [data-act=tab]').get_attribute('data-tab')
    page.fill('.chat-input', 'sleep 4')
    page.locator('.chat-send').click()
    expect(page.locator('.chat-tab-status')).to_have_text('作業中')
    expect(page.locator('.chat-tab [data-act=close]')).to_have_count(0)
    # 別のタブがあっても、API から実行中のタブを閉じられない。
    page.locator('.chat-actions [data-act=add]').click()
    response = page.request.patch(f'{srv.url}/api/deck/talk/chat/tabs/{first}', data={'open': False})
    assert response.status == 400
    assert '作業中' in response.json()['error']
    page.reload()
    tab = page.locator(f'.chat-tab:has([data-act=tab][data-tab="{first}"])')
    expect(tab).to_be_visible()
    expect(page.locator('.chat-tab.on .chat-tab-name')).to_have_text('新しいタブ')
    expect(page.locator('.chat-input')).to_have_value('')
    tab.locator('[data-act=tab]').click()
    expect(page.locator('.chat-round .chat-files')).to_be_visible(timeout=30000)
    expect(tab.locator('[data-act=close]')).to_have_count(1)
    expect(tab.locator('.chat-tab-status')).to_have_count(0)
    page.reload()
    expect(page.locator('.chat-input')).to_be_enabled()
    expect(tab).to_have_count(0)
    expect(page.locator('.chat-round')).to_have_count(0)
    page.locator('.chat-actions > [data-act=hist]').click()
    expect(page.locator('.chat-hsec')).to_have_count(0)
    expect(page.locator('.chat-hrow')).to_have_count(1)
    expect(page.locator('.chat-hrow .chat-hstate')).to_have_count(0)
    page.get_by_role('textbox', name='会話を検索').fill('見つからない会話')
    expect(page.locator('.chat-hrow')).to_have_count(0)
    page.get_by_role('textbox', name='会話を検索').fill('sleep')
    page.locator(f'.chat-hist [data-act=reopen][data-tab="{first}"]').click()
    expect(tab).to_be_visible()
    expect(page.locator('.chat-round')).to_have_count(1)
    page.locator('.chat-actions > [data-act=hist]').click()
    row = page.locator(f'.chat-hrow[data-tab="{first}"]')
    expect(row).to_have_class('chat-hrow is-open')
    expect(row.locator('.chat-hstate')).to_have_text('開いています')
    expect(row.locator('.dot')).to_be_visible()
    page.locator('.chat-hhead [data-act=hist]').click()
    tab.locator('[data-act=close]').click()
    page.locator('.chat-actions > [data-act=hist]').click()
    expect(row).to_have_class('chat-hrow')
    expect(row.locator('.chat-hstate')).to_have_count(0)
    assert not page.errors


def test_plus_reuses_empty_tab_and_names_drafts(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    tabs = page.locator('.chat-tab')
    first = tabs.locator('[data-act=tab]').get_attribute('data-tab')
    page.locator('.chat-actions [data-act=add]').click()
    expect(tabs).to_have_count(1)
    expect(tabs.locator('.chat-tab-name')).to_have_text('新しいタブ')
    page.fill('.chat-input', '最初に書いたメッセージ\n次の行')
    expect(tabs.locator('.chat-tab-name')).to_have_text('最初に書いたメッセージ')
    page.locator('.chat-actions [data-act=add]').click()
    expect(tabs).to_have_count(2)
    empty = page.locator('.chat-tab.on [data-act=tab]').get_attribute('data-tab')
    page.locator(f'.chat-tab [data-act=tab][data-tab="{first}"]').click()
    page.locator('.chat-actions [data-act=add]').click()
    expect(tabs).to_have_count(2)
    expect(page.locator('.chat-tab.on [data-act=tab]')).to_have_attribute('data-tab', empty)
    expect(page.locator('.chat-tab.on .chat-tab-name')).to_have_text('新しいタブ')
    assert not page.errors
    assert not page.errors


def test_main_effort_does_not_change_subagents(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.ai-mbtn:not([disabled])')
    page.locator('.ai-mbtn').click()
    expand_subs(page)
    main = page.locator('.ai-slider[data-role=""]')
    review = page.locator('.ai-slider[data-role="review"]')
    consult = page.locator('.ai-slider[data-role="consult"]')

    def saved(action):
        with page.expect_response(lambda r: r.request.method == 'PATCH' and '/chat/tabs/' in r.url) as response:
            action()
        assert response.value.ok
        expect(main).to_have_attribute('aria-disabled', 'false')

    saved(lambda: page.locator('[data-mact=role-toggle][data-role="consult"]').click())
    saved(lambda: main.press('End'))
    expect(main).to_have_attribute('aria-valuetext', '特に高い')
    expect(review).to_have_attribute('aria-valuetext', '中')
    expect(consult).to_have_attribute('aria-valuetext', '中')
    # メインと同じ値を選んでも個別設定を保持する。
    saved(lambda: review.press('End'))
    expect(review).to_have_attribute('aria-valuetext', '特に高い')
    saved(lambda: main.press('Home'))
    expect(main).to_have_attribute('aria-valuetext', '低')
    expect(review).to_have_attribute('aria-valuetext', '特に高い')
    expect(consult).to_have_attribute('aria-valuetext', '中')
    page.reload()
    page.wait_for_selector('.ai-mbtn:not([disabled])')
    page.locator('.ai-mbtn').click()
    expand_subs(page)
    expect(main).to_have_attribute('aria-valuetext', '低')
    expect(review).to_have_attribute('aria-valuetext', '特に高い')
    expect(consult).to_have_attribute('aria-valuetext', '中')
    assert not page.errors


def test_history_lists_all_modes_and_opens_matching_editor(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    base = f'{srv.url}/api/deck/talk/chat'
    state = page.request.get(base).json()
    memo = next(t for t in state['tabs'] if t['mode'] == 'memo')
    response = page.request.patch(f"{base}/tabs/{memo['id']}", data={
        'name': '下書きの相談', 'drafts': {'memo': '検索できる書きかけ'}})
    assert response.ok
    page.reload()
    page.locator('.chat-actions > [data-act=hist]').click()
    row = page.locator(f".chat-hrow[data-tab='{memo['id']}']")
    expect(row).to_be_visible()
    expect(row.locator('.name')).to_have_text('下書きの相談')
    page.get_by_role('textbox', name='会話を検索').fill('検索できる書きかけ')
    expect(row).to_be_visible()
    row.click()
    expect(page.locator(f".chat-tab [data-act=tab][data-tab='{memo['id']}']")).to_have_attribute('aria-selected', 'true')
    expect(page.locator('.chat-input')).to_have_value('検索できる書きかけ')
    # 別の種類のチャットでも、開いている状態は履歴に表示する。
    page.locator('.ptabs [data-tab=qmd]').click()
    page.locator('.chat-actions > [data-act=hist]').click()
    expect(row.locator('.chat-hstate')).to_have_text('開いています')
    assert not page.errors


def test_add_and_pick_show_before_save_finishes(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.ai-mbtn:not([disabled])')
    held = []

    page.route('**/api/ai/favorites', lambda route: held.append(route))
    page.locator('.ai-mbtn').click()
    page.locator('.ai-main-model .ai-mname').click()
    page.locator('[data-mact=add]').click()
    check = page.locator('[data-mact=favorite][data-key="codex:test-small"]')
    check.click()
    # 保存の応答が無くてもチェックは付き、続けて操作できる
    expect(check).to_have_attribute('aria-checked', 'true', timeout=300)
    assert len(held) == 1
    page.keyboard.press('Escape')
    page.locator('[data-mact=pick][data-key="codex:test-small"]').click()
    expect(page.locator('.ai-mbtn')).to_contain_text('Test Small', timeout=300)
    held.pop().continue_()
    page.wait_for_function("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>s.tabs.find(t=>t.mode==='slides').model==='codex:test-small')")
    page.wait_for_function("fetch('/api/ai/status').then(r=>r.json()).then(s=>s.favorites.includes('codex:test-small'))")
    assert not page.errors


def test_cancelled_message_copy_edit_and_followup(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    go_slide(page, 2)
    page.locator('.chat-input').fill('sleep 30')
    page.locator('.chat-send').click()
    page.locator('[data-act=cancel]').click(timeout=30000)
    expect(page.locator('[data-act=cancel]')).to_have_count(0, timeout=30000)
    expect(page.get_by_text('止めました', exact=True)).to_have_count(0)
    expect(page.get_by_text('AI が途中で失敗しました', exact=True)).to_have_count(0)
    page.evaluate("""() => { window.copiedMessage = null;
      Object.defineProperty(navigator, 'clipboard', {configurable: true,
        value: {writeText: async text => { window.copiedMessage = text; }}}); }""")
    page.locator('[data-act=copy-message]').click()
    assert page.evaluate('window.copiedMessage') == 'sleep 30'
    go_slide(page, 3)
    page.locator('[data-act=edit-message]').click()
    expect(page.locator('.chat-input')).to_have_value('sleep 30')
    page.locator('.chat-input').fill('noop 追加の指示')
    page.locator('.chat-send').click()
    expect(page.locator('.chat-round').last.locator('.chat-sent')).to_contain_text('sleep 30')
    expect(page.locator('.chat-round').last.locator('.chat-sent')).to_contain_text('追加の指示')
    page.locator('[data-act=cancel]').click(timeout=30000)
    expect(page.locator('[data-act=cancel]')).to_have_count(0, timeout=30000)
    assert not page.errors
