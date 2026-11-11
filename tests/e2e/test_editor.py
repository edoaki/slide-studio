"""手順 2：サーバー・プレビュー・原稿の編集と保存（作業手順書の受け入れ条件）。"""
import re
import time

import pytest

from slide_studio.fsutil import sha256_file, write_atomic
from e2e.conftest import open_deck, open_theme, slide_text


def type_at(pg, needle: str, text: str):
    """原稿の needle の後ろにカーソルを置いて打つ。"""
    pg.evaluate("""([needle]) => { const ta = document.querySelector('.raw textarea'); const i = ta.value.indexOf(needle) + needle.length;
      ta.focus(); ta.setSelectionRange(i, i); }""", [needle])
    pg.keyboard.type(text)


def test_home_lists_deck_and_opens_it(gui, page):
    ws, srv = gui
    page.goto(srv.url + "/")
    page.wait_for_selector(".card")
    page.click(".card")
    page.wait_for_url("**/deck/talk")
    page.wait_for_function("document.querySelector('#slideBox iframe')?.contentWindow?.deckReady === true")
    assert not page.errors


def test_typing_updates_slide_and_file(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    # 一枚目のページへ（原稿のカーソルのページがスライドに出る）
    type_at(page, "最初の段落", "X")
    t0 = time.perf_counter()
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentDocument.querySelector('.slide.active')?.innerText.includes('最初の段落X')", timeout=5000)
    elapsed = time.perf_counter() - t0
    assert "最初の段落X" in ws.qmd("talk").read_text()
    print(f"入力からスライドの更新まで {elapsed * 1000:.0f}ms")
    assert elapsed < 1.5
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert not page.errors


def test_external_change_updates_slide(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(2)")
    qmd = ws.qmd("talk")
    qmd.write_text(qmd.read_text().replace("最初の段落。", "外で直した段落。"))
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('.slide.active').innerText.includes('外で直した段落')", timeout=5000)
    page.wait_for_function("document.querySelector('.raw textarea').value.includes('外で直した段落')", timeout=5000)
    # AI が題名を変えたら上のバーも合わせる
    assert page.locator("#deckTitle").inner_text() == "テスト発表"
    qmd.write_text(qmd.read_text().replace('title: "テスト発表"', 'title: "新しい題名"'))
    page.wait_for_function("document.querySelector('#deckTitle').textContent === '新しい題名'", timeout=5000)


def test_conflict_keeps_unsaved_input(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    # 保存を止めて未保存の入力を作る
    page.evaluate("window.__hold = true; const orig = window.fetch; window.fetch = (u, o) => (o && o.method === 'PUT' && window.__hold) ? new Promise(() => {}) : orig(u, o)")
    type_at(page, "二番目の段落", "（入力）")
    qmd = ws.qmd("talk")
    qmd.write_text(qmd.read_text().replace("まとめの段落。", "外の変更。"))
    page.wait_for_selector(".banner", timeout=5000)
    assert "外で変更されました" in page.inner_text("#status")
    assert "二番目の段落（入力）" in page.evaluate("document.querySelector('.raw textarea').value")
    assert "外の変更。" in qmd.read_text() and "（入力）" not in qmd.read_text()
    # 読み込み直す（自分の変更を捨てる）
    page.click("text=読み込み直す（自分の変更を捨てる）")
    page.wait_for_function("document.querySelector('.raw textarea').value.includes('外の変更。')")
    assert "（入力）" not in page.evaluate("document.querySelector('.raw textarea').value")


def test_save_conflict_409(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    # GUI が知らないうちにファイルが変わる（監視の通知より先に保存が届く場合）
    page.evaluate("window.__slideStudioTestBlockEvents = true")
    qmd = ws.qmd("talk")
    qmd.write_text(qmd.read_text().replace("まとめの段落。", "先に変わった。"))
    page.evaluate("""() => { const ta = document.querySelector('.raw textarea'); ta.value = ta.value.replace('最初の段落。', '最初の段落。Y'); ta.dispatchEvent(new Event('input')); }""")
    page.wait_for_selector(".banner", timeout=5000)
    assert "先に変わった" in qmd.read_text() and "段落。Y" not in qmd.read_text()


@pytest.mark.parametrize("clipboard", ["denied", "missing", "success"])
def test_conflict_copy(gui, page, clipboard):
    ws, srv = gui
    open_deck(page, srv)
    page.evaluate("window.__slideStudioTestBlockEvents = true")
    original = ws.qmd("talk").read_text()
    external = original.replace("まとめの段落。", "先に変わった。")
    write_atomic(ws.qmd("talk"), external)
    pending = original.replace("最初の段落。", "自分の入力。")
    visible = page.locator('.raw textarea').input_value()
    pending_visible = visible.replace('最初の段落。', '自分の入力。')
    page.locator('.raw textarea').fill(pending_visible)
    page.wait_for_selector('#edBanner .banner')
    page.evaluate("""mode => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: mode === 'missing' ? undefined : { writeText: async text => {
        if (mode === 'denied') throw new Error('denied'); window.copiedText = text;
      } } })""", clipboard)
    page.locator('#edBanner [data-act=copy]').click()
    if clipboard != 'success':
        fallback = page.locator('#edBanner .copy-fallback textarea')
        fallback.wait_for()
        assert fallback.input_value() == pending
        assert fallback.evaluate('(el) => el.readOnly && document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length')
        assert 'クリップボードに写せませんでした' in page.locator('#edBanner').inner_text()
        assert page.locator('.raw textarea').input_value() == pending_visible
        assert ws.qmd("talk").read_text() == external
        page.locator('#edBanner [data-act=discard]').click()
    else:
        assert page.evaluate('window.copiedText') == pending
    page.wait_for_function("document.querySelector('.raw textarea').value.includes('先に変わった。')")
    assert page.locator('.raw textarea').input_value() == visible.replace('まとめの段落。', '先に変わった。')
    assert page.locator('#edBanner .banner').count() == 0
    assert not page.errors


def test_open_and_close_does_not_touch_file(gui, page):
    ws, srv = gui
    before = sha256_file(ws.qmd("talk"))
    mtime = ws.qmd("talk").stat().st_mtime_ns
    open_deck(page, srv)
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(4)")
    page.goto(srv.url + "/")
    page.wait_for_selector(".card")
    assert sha256_file(ws.qmd("talk")) == before
    assert ws.qmd("talk").stat().st_mtime_ns == mtime


def test_pandoc_error_keeps_last_slides(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(3)")
    before = slide_text(page)
    # 設定は原稿欄に出さない。外部から壊れた YAML が届いた場合を確かめる。
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('lang: ja', 'lang: [ja'))
    page.wait_for_function("document.querySelector('#status').textContent === '表示が古い（変換に失敗）'", timeout=5000)
    assert page.is_visible(".stale-badge")
    assert "line" in page.inner_text("#qstatus")
    # 最後に成功したスライドが残っている（入力でカーソルが末尾へ動くので、同じスライドを開き直して比べる）
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(3)")
    assert slide_text(page) == before


def test_undo_redo(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    type_at(page, "まとめの段落", "Z")
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    page.click("#chatToggle")  # 原稿の外にフォーカスを移す
    page.keyboard.press("Meta+z")
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('まとめの段落Z')")
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert "まとめの段落Z" not in ws.qmd("talk").read_text()
    page.keyboard.press("Meta+Shift+z")
    page.wait_for_function("document.querySelector('.raw textarea').value.includes('まとめの段落Z')")


@pytest.mark.parametrize('raw', [False, True], ids=['blocks', 'raw'])
def test_history_buttons_keep_manuscript_scroll(gui, page, raw):
    ws, srv = gui
    text = ws.qmd('talk').read_text().replace('まとめの段落。', '\n\n'.join(f'長い原稿の段落{i}。' for i in range(70)))
    ws.qmd('talk').write_text(text)
    open_deck(page, srv, raw=raw)
    addition = '追加した長い文章。' * 80
    if raw:
        type_at(page, '長い原稿の段落50', addition)
    else:
        page.locator('#qblocks .card').filter(has_text='長い原稿の段落50。').click()
        page.get_by_label('ブロックの原稿').fill('長い原稿の段落50' + addition + '。')
        page.get_by_label('ブロックの原稿').press('Escape')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    for button, expected in [('#undo', text), ('#redo', text.replace('段落50。', '段落50' + addition + '。'))]:
        page.evaluate('''(raw) => {
          const scroller = document.querySelector('#qscroll');
          const target = () => [...document.querySelectorAll(raw ? '.raw pre .l' : '#qblocks .card')].find(e => e.textContent === '長い原稿の段落60。');
          scroller.scrollTop += target().getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100;
          window.scrollSamples = [target().getBoundingClientRect().top];
          window.opacitySamples = [];
          const sample = () => {
            scrollSamples.push(target().getBoundingClientRect().top);
            opacitySamples.push(getComputedStyle(target()).opacity);
            if (scrollSamples.length < 90) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }''', raw)
        page.click(button)
        page.wait_for_function('scrollSamples.length === 90')
        samples = page.evaluate('scrollSamples')
        assert max(samples) - min(samples) < 2, samples
        assert set(page.evaluate('opacitySamples')) == {'1'}
        assert ws.qmd('talk').read_text() == expected
    assert not page.errors


def test_slow_save_serializes_and_keeps_latest_input(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    page.evaluate("""() => {
      const original = window.fetch;
      window.saveRequests = 0; window.activeSaves = 0; window.maxSaves = 0;
      window.fetch = async (url, options) => {
        if (options?.method !== 'PUT') return original(url, options);
        window.saveRequests++; window.activeSaves++;
        window.maxSaves = Math.max(window.maxSaves, window.activeSaves);
        const response = await original(url, options);
        await new Promise(resolve => setTimeout(resolve, 1200));
        window.activeSaves--;
        return response;
      };
    }""")
    type_at(page, '最初の段落', 'A')
    page.wait_for_function('window.saveRequests === 1')
    type_at(page, '最初の段落A', 'B')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'", timeout=10000)
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentDocument.body.textContent.includes('最初の段落AB')")
    assert page.evaluate('window.maxSaves') == 1
    assert page.evaluate('window.saveRequests') == 2
    assert '最初の段落AB' in ws.qmd('talk').read_text()
    assert page.locator('.banner').count() == 0
    assert not page.errors


def test_preview_has_no_fractional_edge_gap(gui, page):
    _, srv = gui
    open_deck(page, srv)
    for width in (714, 714.25, 714.5, 713.75):
        page.locator('#slideBox').evaluate("(el, w) => el.style.width = `${w}px`", width)
        page.wait_for_function("""() => {
            const f = document.querySelector('#slideBox iframe:not(.loading)');
            const box = f.getBoundingClientRect();
            const slide = f.contentDocument.querySelector('#stage').getBoundingClientRect();
            return Math.abs(slide.x) < .02 && Math.abs(slide.y) < .02
                && Math.abs(slide.right - box.width) < .02
                && Math.abs(slide.bottom - box.height) < .02;
        }""")
    assert not page.errors


@pytest.mark.parametrize('raw', [False, True])
def test_current_slide_stays_visible_when_editor_resizes(gui, page, raw):
    ws, srv = gui
    source = ws.qmd('talk').read_text()
    write_atomic(ws.qmd('talk'), source.replace('最初の段落。', ('折り返しが変わる長い文章です。' * 15 + '\n\n') * 12))
    open_deck(page, srv, raw=raw)
    page.evaluate('document.querySelector("#slideBox iframe:not(.loading)").contentWindow.deck.go(4)')
    head = page.locator('#qhost .q-ht' if raw else '#qblocks .page.cur > .heading').filter(has_text='まとめ')
    head.wait_for(state='visible')
    page.wait_for_timeout(400)  # ページ移動時の smooth scroll の終了
    for offset, delta in [(80, 300), (80, -300), (-100, 200), (1000, -200)]:
        head.evaluate('''(el, offset) => {
            const s = document.querySelector('#qscroll');
            s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - offset;
        }''', offset)
        grip = page.locator('#splitter').bounding_box()
        x, y = grip['x'] + grip['width'] / 2, grip['y'] + grip['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + delta, y, steps=8)
        page.mouse.up()
        bounds = head.evaluate('''el => {
            const r = el.getBoundingClientRect(), s = document.querySelector('#qscroll').getBoundingClientRect();
            return [r.top - s.top, s.bottom - r.bottom];
        }''')
        assert min(bounds) >= 0, bounds
        assert page.evaluate('document.querySelector("#slideBox iframe:not(.loading)").contentWindow.deck.index') == 4
    assert not page.errors


def test_preview_follows_resize_in_same_frame(gui, page):
    """枠を広げたフレームのうちにスライドも合い、枠の地はスライドの地の色（白く光らない）。"""
    ws, srv = gui
    open_deck(page, srv)
    # Preview の観測より後に作った観測は同じ通知の中で後に呼ばれる。その時点で合っていれば描く前に合っている。
    gaps = page.evaluate("""async () => {
        const box = document.querySelector('#slideBox'), gaps = [];
        const ro = new ResizeObserver(() => {
            const f = box.querySelector('iframe:not(.loading)'), b = f.getBoundingClientRect();
            const s = f.contentDocument.querySelector('#stage').getBoundingClientRect();
            gaps.push(Math.abs(s.right - b.width) + Math.abs(s.bottom - b.height));
        });
        ro.observe(box);
        for (const w of [500, 640, 560, 600]) {
            box.style.width = `${w}px`;
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        }
        ro.disconnect();
        return gaps;
    }""")
    assert len(gaps) == 4 and max(gaps) < .05, gaps
    write_atomic(ws.themes / 'default.css', (ws.themes / 'default.css').read_text() + '\n#stage .slide{background:#123456}')
    page.wait_for_function("getComputedStyle(document.querySelector('#slideBox')).backgroundColor === 'rgb(18, 52, 86)'")
    assert not page.errors


def test_bar_undo_redo_tips_and_no_insert_button(gui, page):
    ws, srv = gui
    open_deck(page, srv)
    # 上のバーに［挿入］は置かない（挿入は / から）
    assert page.locator('header.bar #insertBtn').count() == 0
    # 取消・やり直しは押せないときもカーソルを合わせると名前とキーが出る
    for sel, name, keys in (("#undo", "元に戻す", ["⌘", "Z"]), ("#redo", "やり直す", ["⇧", "⌘", "Z"])):
        page.hover(sel)
        page.wait_for_selector(".tip.show")
        assert page.inner_text(".tip.show .tip-name") == name
        assert page.locator(".tip.show kbd").all_inner_texts() == keys
        page.mouse.move(0, 400)
        page.wait_for_selector(".tip.show", state="hidden")


def test_chat_width_drag_and_keep(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    chat_w = "document.querySelector('#chat').getBoundingClientRect().width"
    before = page.evaluate(chat_w)
    box = page.locator("#chatSplitter").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x - 150, y, steps=5)
    page.mouse.up()
    assert abs(page.evaluate(chat_w) - (before + 150)) < 3
    # 再読み込みしても幅を覚えている
    open_deck(page, srv, raw=False)
    assert abs(page.evaluate(chat_w) - (before + 150)) < 3
    # 最小幅より狭くはならない
    box = page.locator("#chatSplitter").bounding_box()
    x = box["x"] + box["width"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 1000, y, steps=5)
    page.mouse.up()
    assert abs(page.evaluate(chat_w) - 300) < 1
    assert not page.errors


def test_zero_key_closes_left_panel(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.ptabs [data-tab="qmd"]')
    editor_off = "document.body.classList.contains('editor-off')"
    page.evaluate("document.activeElement?.blur()")
    assert page.locator("#editorToggle").get_attribute("data-keys") == "0"
    page.keyboard.press("0")
    assert page.evaluate(editor_off)
    assert page.locator("#editorToggle").get_attribute("data-keys") is None
    # 閉じているときに押しても開かない。タブの数字キーで開く
    page.keyboard.press("0")
    assert page.evaluate(editor_off)
    page.keyboard.press("2")
    assert not page.evaluate(editor_off)
    # 入力欄の中では文字として入る
    page.locator(".chat-input").fill("")
    page.locator(".chat-input").press("0")
    assert page.input_value(".chat-input") == "0" and not page.evaluate(editor_off)
    assert not page.errors


def test_chat_open_on_entry_at_any_width(gui, page):
    ws, srv = gui
    chat_off = "document.body.classList.contains('chat-off')"
    page.set_viewport_size({"width": 1200, "height": 800})
    open_deck(page, srv, raw=False)
    assert not page.evaluate(chat_off)
    # 手動で閉じても、編集画面を開き直すと表示する。
    page.click("#chatToggle")
    assert page.evaluate(chat_off)
    open_deck(page, srv, raw=False)
    assert not page.evaluate(chat_off)
    # 以前の非表示設定が残っていても表示する。
    page.evaluate("localStorage.setItem('slide-studio.chatOff', '1')")
    page.set_viewport_size({"width": 1500, "height": 900})
    open_deck(page, srv, raw=False)
    assert not page.evaluate(chat_off)
    assert not page.errors


def _lock_chat(page, **state):
    def handle(route):
        response = route.fetch()
        route.fulfill(response=response, json={**response.json(), **(state or {"locked": True})})
    page.route(re.compile(r"/api/deck/talk/chat(/open)?$"), handle)


def test_ai_lock_marks_editing_panes_orange(gui, page):
    ws, srv = gui
    _lock_chat(page)
    page.goto(f"{srv.url}/deck/talk")
    page.wait_for_selector(".app.ai-locked")
    assert page.locator("#status").get_attribute("data-tone") == "ai"
    frame = "(s) => getComputedStyle(document.querySelector(s), '::after').borderTopColor"
    assert page.evaluate(frame, "#editor") == "rgb(249, 115, 22)"
    assert page.evaluate(frame, "#stage") == "rgb(249, 115, 22)"
    assert page.errors == []


def test_theme_stays_editable_during_ai_lock(gui, page):
    ws, srv = gui
    _lock_chat(page)
    page.goto(f"{srv.url}/deck/talk")
    page.wait_for_selector(".app.ai-locked")
    open_theme(page)
    field = page.locator(".tv-section label[data-key] input, label[data-key] input").first
    field.wait_for(state="attached")
    assert not field.is_disabled()
    assert page.evaluate("getComputedStyle(document.querySelector('#editor'), '::after').content") == "none"


def test_page_lock_marks_only_that_page(gui, page):
    ws, srv = gui
    _lock_chat(page, lock={"all": False, "pages": [{"key": "two", "title": None}], "figures": []})
    page.goto(f"{srv.url}/deck/talk")
    page.wait_for_selector("#qblocks .page.ai-lock")
    assert page.locator("#qblocks .page.ai-lock").count() == 1
    assert page.locator(".app.ai-locked").count() == 0
    assert page.locator("#status").get_attribute("data-tone") == "ai"
    assert "をロック" in page.locator("#status").text_content()
    assert page.locator("#pagestrip button.ai-lock").count() == 1
    assert page.errors == []


def test_figure_lock_is_quiet(gui, page):
    ws, srv = gui
    _lock_chat(page, lock={"all": False, "pages": [], "figures": ["nco/a"]})
    page.goto(f"{srv.url}/deck/talk")
    page.wait_for_function("document.querySelector('#status').dataset.tone === 'ai-soft'")
    assert page.locator(".app.ai-locked, #qblocks .page.ai-lock").count() == 0
    assert page.errors == []


def _ai_on_page(srv, key):
    hook = srv.app.state.chat
    hook.state("talk")["rounds"].append({"id": "r", "tab": "t", "mode": "slides", "state": "done", "items": [{"key": key}]})
    hook.running["r"] = ("talk", "slides")
    return hook


def test_page_lock_keeps_other_pages_editable_and_merges(gui, page):
    ws, srv = gui
    hook = _ai_on_page(srv, "two")
    try:
        page.goto(f"{srv.url}/deck/talk")
        page.wait_for_selector("#qblocks .page.ai-lock")
        page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
        page.get_by_role("button", name="すべての記法を表示", exact=True).click()
        type_at(page, "最初の段落。", "利")
        path = ws.qmd("talk")
        write_atomic(path, path.read_text().replace("右の列。", "AIの右。"))
        page.wait_for_function("document.querySelector('.raw textarea').value.includes('AIの右。') && document.querySelector('.raw textarea').value.includes('最初の段落。利')")
        for _ in range(100):
            if "最初の段落。利" in path.read_text() and "AIの右。" in path.read_text():
                break
            time.sleep(0.05)
        text = path.read_text()
        assert "最初の段落。利" in text and "AIの右。" in text
        assert page.locator("#edBanner .banner").count() == 0
        # ロック中のページには打てない
        type_at(page, "左の列。", "打")
        time.sleep(0.2)
        assert "左の列。打" not in page.evaluate("document.querySelector('.raw textarea').value")
        assert page.errors == []
    finally:
        hook.running.clear()
