"""下書きのタブと下書きのチャット（設計書 §8.8・§10.7）。テスト用の codex を使う。"""
import sys

import pytest

from conftest import FIXTURES
from e2e.conftest import open_deck
from .test_chat import reopen_history
from slide_studio.fsutil import write_atomic


@pytest.fixture(autouse=True)
def fake_codex(tmp_path, monkeypatch):
    exe = tmp_path / "codex"
    exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FIXTURES / "fake_codex.py"}" "$@"\n')
    exe.chmod(0o755)
    monkeypatch.setenv("SLIDE_STUDIO_CODEX", str(exe))


def left_tab(pg) -> str:
    return pg.evaluate("document.querySelector('.ptabs [aria-selected=true]').dataset.tab")


def test_opens_memo_for_blank_deck_and_switches_chat(gui, page):
    ws, srv = gui
    ws.new_deck("fresh", "test", title="新しい話")
    open_deck(page, srv, deck="fresh", raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    # 中身がまだ無い発表は下書きから。タブは先頭
    assert left_tab(page) == "memo"
    assert page.evaluate("document.querySelector('.ptabs button').dataset.tab") == "memo"
    assert page.locator(".memo-input").is_visible()
    # チャットは下書きのチャット：対象・未送信の一覧が無い
    assert page.locator(".chat-mode").is_visible()
    assert page.locator(".chat-target").is_hidden() and page.locator(".chat-drafts").is_hidden()

    assert page.locator('.memo-audience').is_visible()
    assert page.locator('.memo-conclusion').is_visible()
    assert page.locator('.memo-required').all_text_contents() == ['必須', '必須']
    assert page.locator('.memo-audience').get_attribute('required') is not None
    assert page.locator('.memo-duration').get_attribute('required') is not None
    assert page.locator('.memo-missing').is_visible()
    assert '公開してよい範囲' not in page.locator('.memo-input').input_value()
    page.get_by_label('対象読者', exact=False).fill('大学生')
    page.get_by_label('想定発表時間', exact=False).fill('15分')
    page.get_by_label('伝えたい結論', exact=True).fill('実験の意義\n今後の課題')
    assert page.locator('.memo-missing').is_hidden()
    assert page.locator('.memo-audience').is_visible()
    page.fill(".memo-input", "背景：未定\n")
    page.wait_for_function("document.querySelector('.memo-foot .state').textContent === '保存しました'")
    assert ws.memo("fresh").read_text() == '# スライド案\n\n- 対象読者：大学生\n- 発表時間：15分\n- 伝えたい結論：実験の意義\n  今後の課題\n\n背景：未定\n'
    page.reload()
    page.wait_for_function("document.querySelector('.memo-audience')?.value === '大学生'")
    assert page.locator('.memo-audience').is_visible()
    assert page.locator('.memo-duration').input_value() == '15分'
    assert page.locator('.memo-conclusion').input_value() == '実験の意義\n今後の課題'

    page.fill(".chat-input", "replace 未定 => 実験で確かめた")
    page.locator(".chat-send").click()
    page.wait_for_selector(".chat-reply strong", timeout=30000)
    assert page.locator(".chat-reply strong").inner_text() == "直しました"
    assert page.locator(".chat-results").count() == 0 and page.locator(".chat-ok").count() == 0
    page.wait_for_function("document.querySelector('.memo-input').value === '背景：実験で確かめた\\n'")
    # スライドの編集はロックしない
    assert not page.locator("#status").inner_text().startswith("AI 作業中")

    # 原稿に移るとスライドのチャット（別の会話）に戻る
    page.locator(".ptabs [data-tab=qmd]").click()
    assert page.locator(".chat-mode").is_hidden() and page.locator(".chat-target").is_visible()
    assert page.locator(".chat-round").count() == 0
    # 原稿の欄を閉じても、スライドのチャット
    page.locator(".ptabs [data-tab=memo]").click()
    assert page.locator(".chat-mode").is_visible() and page.locator(".chat-round").count() == 1
    page.locator("#editorToggle").click()
    assert page.locator(".chat-mode").is_hidden()
    page.locator("#editorToggle").click()
    assert page.locator(".chat-mode").is_visible()

    # この送信の前に戻すと下書きが戻る
    page.locator("[data-act=restore]").click()
    page.locator(".dialog [data-a=yes]").click()
    page.wait_for_function("document.querySelector('.memo-input').value === '背景：未定\\n'")
    assert not page.errors


def test_opens_qmd_for_deck_with_content(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    assert left_tab(page) == "qmd"
    assert page.locator(".chat-mode").is_hidden()
    assert not page.errors


@pytest.mark.parametrize("scope,position", [
    ("- 公開範囲：学内\n  詳細は非公開\n\t図は配布可", 1),
    ("* 公開してよい範囲: 研究室内\n    要確認", 0),
    ("- 公開範囲：公開可", 3),
])
def test_preserves_hidden_memo_fields(gui, page, scope, position):
    ws, srv = gui
    fields = ["- 対象読者：大学生", "- 発表時間：15分", "- 伝えたい結論：実験の意義\n  今後の課題"]
    fields.insert(position, scope)
    text = "# スライド案\n\n" + "\n".join(fields) + "\n\n## 背景\n\n本文\n"
    write_atomic(ws.memo("talk"), text)
    mtime = ws.memo("talk").stat().st_mtime_ns
    open_deck(page, srv, raw=False)
    page.locator('.ptabs [data-tab=memo]').click()
    page.wait_for_function("document.querySelector('.memo-audience').value === '大学生'")
    assert "公開" not in page.locator('.memo-input').input_value()
    page.get_by_role('link', name='ホーム', exact=True).click()
    page.wait_for_url(srv.url + '/')
    assert ws.memo("talk").read_text() == text
    assert ws.memo("talk").stat().st_mtime_ns == mtime
    open_deck(page, srv, raw=False)
    page.locator('.ptabs [data-tab=memo]').click()
    page.wait_for_function("document.querySelector('.memo-audience').value === '大学生'")
    page.locator('.memo-audience').fill('高校生')
    page.wait_for_function("document.querySelector('.memo-foot .state').textContent === '保存しました'")
    assert ws.memo("talk").read_text() == text.replace('大学生', '高校生')
    assert not page.errors


@pytest.mark.parametrize("clipboard", ["denied", "missing", "success"])
def test_memo_conflict_copy(gui, page, clipboard):
    ws, srv = gui
    write_atomic(ws.memo("talk"), "# スライド案\n\n- 対象読者：大学生\n- 発表時間：15分\n- 伝えたい結論：結論\n\n本文\n")
    open_deck(page, srv, raw=False)
    page.locator('.ptabs [data-tab=memo]').click()
    page.wait_for_function("document.querySelector('.memo-audience').value === '大学生'")
    page.evaluate("window.__slideStudioTestBlockEvents = true")
    write_atomic(ws.memo("talk"), "外で直した下書き\n")
    page.locator('.memo-input').fill('自分の入力\n')
    page.wait_for_selector('.memo-banner .banner')
    page.evaluate("""mode => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: mode === 'missing' ? undefined : { writeText: async text => {
        if (mode === 'denied') throw new Error('denied'); window.copiedText = text;
      } } })""", clipboard)
    page.locator('.memo-banner [data-act=reload]').click()
    expected = "# スライド案\n\n- 対象読者：大学生\n- 発表時間：15分\n- 伝えたい結論：結論\n\n自分の入力\n"
    if clipboard != 'success':
        fallback = page.locator('.memo-banner .copy-fallback textarea')
        fallback.wait_for()
        assert fallback.input_value() == expected
        assert fallback.evaluate('(el) => el.readOnly && document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length')
        assert 'クリップボードに写せませんでした' in page.locator('.memo-banner').inner_text()
        assert page.locator('.memo-input').input_value() == '自分の入力\n'
        assert ws.memo("talk").read_text() == "外で直した下書き\n"
        discard = page.locator('.memo-banner [data-act=discard]')
        assert discard.inner_text() == ''
        assert discard.get_attribute('data-tip') == '書いた文を捨てて読み込み直す'
        discard.click()
    else:
        assert page.evaluate('window.copiedText') == expected
    page.wait_for_function("document.querySelector('.memo-input').value === '外で直した下書き\\n'")
    assert page.locator('.memo-banner .banner').count() == 0
    assert not page.errors


def test_external_change_keeps_caret_and_scroll(gui, page):
    # AI が下書きを書き換えても、書いていた位置から飛ばない
    ws, srv = gui
    head = "# スライド案\n\n- 対象読者：大学生\n- 発表時間：15分\n- 伝えたい結論：結論\n\n"
    body = "".join(f"## {i}\n\n本文 {i}\n\n" for i in range(80))
    write_atomic(ws.memo("talk"), head + body)
    open_deck(page, srv, raw=False)
    page.locator('.ptabs [data-tab=memo]').click()
    page.wait_for_function("document.querySelector('.memo-audience').value === '大学生'")
    page.wait_for_function("(v => v.scrollHeight - v.clientHeight > 200)(document.querySelector('.memo-view'))")
    page.evaluate("() => { const t = document.querySelector('.memo-input'); t.focus(); t.setSelectionRange(30, 30); document.querySelector('.memo-view').scrollTop = 200; }")
    write_atomic(ws.memo("talk"), head + body + "## 足した所\n")
    page.wait_for_function("document.querySelector('.memo-input').value.endsWith('## 足した所\\n')")
    assert page.evaluate("() => { const t = document.querySelector('.memo-input'); return [t.selectionStart, t.selectionEnd, document.querySelector('.memo-view').scrollTop]; }") == [30, 30, 200]
    assert not page.errors


def test_handoff_starts_from_screen_and_shows_memo_diff(gui, page):
    """「スライドにして」は画面がスライドの保存を確定してから始める。下書きの変わった所を出す（設計書 §8.8）。"""
    ws, srv = gui
    write_atomic(ws.memo("talk"), "背景：未定\n")
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    page.locator(".ptabs [data-tab=memo]").click()
    page.fill(".chat-input", "replace 未定 => 実験で確かめた; slides 結論を最後に置く")
    page.locator(".chat-send").click()
    # 確認ボタンを押すまで、再読み込みしても始まらない
    page.get_by_role("button", name="スライドを作る", exact=True).wait_for(timeout=30000)
    assert page.evaluate("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>!s.tabs.some(t=>t.handoff))")
    page.reload()
    page.locator(".ptabs [data-tab=memo]").click()
    reopen_history(page, "replace 未定")
    page.get_by_role("button", name="スライドを作る", exact=True).wait_for()
    assert page.get_by_role("button", name="まだ下書きを続ける", exact=True).is_visible()
    page.get_by_role("button", name="スライドを作る", exact=True).click()
    page.wait_for_selector(".chat-handoff [data-act=handoff]", timeout=30000)
    page.wait_for_function("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>s.tabs.some(t=>t.handoff && t.name==='下書きから'))")
    diff = page.locator(".chat-diff")
    assert diff.locator("summary").get_attribute("data-tip")
    diff.locator("summary").click()
    assert diff.locator(".add").inner_text() == "+背景：実験で確かめた" and diff.locator(".del").inner_text() == "-背景：未定"
    assert not page.errors


def test_handoff_continue_draft_persists_without_starting(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    page.locator(".ptabs [data-tab=memo]").click()
    page.fill(".chat-input", "slides 結論を最後に置く")
    page.locator(".chat-send").click()
    button = page.get_by_role("button", name="まだ下書きを続ける", exact=True)
    button.wait_for(timeout=30000)
    button.click()
    page.get_by_text("スライドは作らず、下書きを続けます", exact=True).wait_for()
    page.reload()
    page.locator(".ptabs [data-tab=memo]").click()
    reopen_history(page, "slides 結論を最後に置く")
    page.get_by_text("スライドは作らず、下書きを続けます", exact=True).wait_for()
    assert page.get_by_role("button", name="スライドを作る", exact=True).count() == 0
    assert page.evaluate("fetch('/api/deck/talk/chat').then(r=>r.json()).then(s=>!s.tabs.some(t=>t.handoff))")
    assert page.locator(".chat-input").is_enabled()
    assert left_tab(page) == "memo"
    assert not page.errors


def test_memo_fields_scroll_with_body(gui, page):
    ws, srv = gui
    text = "# スライド案\n\n- 対象読者：大学生\n- 発表時間：15分\n\n" + "本文\n" * 100
    write_atomic(ws.memo("talk"), text)
    open_deck(page, srv, raw=False)
    page.locator('.ptabs [data-tab=memo]').click()
    page.wait_for_function("document.querySelector('.memo-input').clientHeight > 1500")
    page.locator('.memo-view').evaluate('(el) => el.scrollTop = 0')
    fields = page.locator('.memo-fields')
    top = fields.bounding_box()['y']
    page.locator('.memo-input').hover(position={"x": 30, "y": 30})
    page.mouse.wheel(0, 600)
    page.wait_for_function("document.querySelector('.memo-view').scrollTop > 400")
    assert fields.bounding_box()['y'] < top - 400
    assert page.locator('.memo-input').evaluate('(el) => el.scrollHeight <= el.clientHeight + 1')
    page.locator('.memo-view').evaluate('(el) => el.scrollTop = 0')
    page.get_by_label('対象読者', exact=False).fill('高校生')
    page.wait_for_function("document.querySelector('.memo-foot .state').textContent === '保存しました'")
    assert ws.memo("talk").read_text().count('本文\n') == 100
    assert not page.errors


def test_reflect_slides_button(gui, page):
    ws, srv = gui
    ws.new_deck("fresh", "test", title="新しい話")
    open_deck(page, srv, deck="fresh", raw=False)
    page.wait_for_selector(".memo-input")
    page.wait_for_function("document.querySelector('.memo-foot .state').textContent !== ''")
    # 雛形のままなら出ない
    assert page.locator(".memo-reflect").is_hidden()

    # 原稿に中身が入ると出る
    text = ws.qmd("fresh").read_text().replace("説明を書く。", "本当の説明")
    write_atomic(ws.qmd("fresh"), text)
    page.wait_for_selector(".memo-reflect:not([hidden])", timeout=15000)

    page.fill(".memo-input", "元の文\n")
    page.wait_for_function("document.querySelector('.memo-foot .state').textContent === '保存しました'")
    page.locator(".memo-reflect").click()
    page.wait_for_function("document.querySelector('.memo-input').value.includes('本当の説明')")
    page.wait_for_function("document.querySelector('.memo-foot .state').textContent === '保存しました'")
    assert "本当の説明" in ws.memo("fresh").read_text()

    # ⌘Z で元に戻り、戻した文も保存される
    page.keyboard.press("ControlOrMeta+z")
    page.wait_for_function("document.querySelector('.memo-input').value === '元の文\\n'")
    page.wait_for_function("document.querySelector('.memo-foot .state').textContent === '保存しました'")
    assert "元の文" in ws.memo("fresh").read_text() and "本当の説明" not in ws.memo("fresh").read_text()


def test_memo_has_no_draft_to_slides_shortcut(gui, page):
    ws, srv = gui
    ws.new_deck("fresh", "test", title="新しい話")
    open_deck(page, srv, deck="fresh", raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    page.fill(".memo-input", "## 問い\n\n本文\n")
    assert page.locator(".memo-to-slides").count() == 0
    assert page.locator(".chat-input").input_value() == ""
