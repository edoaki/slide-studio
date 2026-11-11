import re

from playwright.sync_api import expect



def test_create_resume_copy_and_home_navigation(page, gui):
    ws, srv = gui
    page.goto(srv.url)
    expect(page).to_have_title("Slide Studio")
    page.get_by_role("button", name="新しい発表", exact=True).click()
    page.get_by_label("フォルダ名", exact=True).fill("new-talk")
    page.get_by_label("タイトル", exact=True).fill("新しい研究発表")
    page.locator("select[name=shelf]").select_option("")
    page.get_by_label("トピック名（英小文字・数字・ハイフン）", exact=True).fill("research")
    page.get_by_role("button", name="作る", exact=True).click()
    expect(page).to_have_url(srv.url + "/deck/new-talk")
    expect(page.locator("#status")).to_have_text("保存済み")
    # 作ったばかり（雛形のまま）の発表は下書きのタブから開く
    expect(page.locator(".ptabs [data-tab=memo]")).to_have_attribute("aria-selected", "true")
    page.locator(".ptabs [data-tab=qmd]").click()
    page.get_by_role("button", name="すべての記法を表示", exact=True).click()
    page.locator("#qhost textarea").fill(ws.qmd("new-talk").read_text().replace("説明を書く。", "編集を再開できる。"))
    page.get_by_role("link", name="ホーム", exact=True).click()
    page.locator(".card").filter(has_text="新しい研究発表").click()
    expect(page.locator("#status")).to_have_text("保存済み")
    assert "編集を再開できる。" in page.locator("#qhost textarea").input_value()
    page.get_by_role("link", name="ホーム", exact=True).click()
    page.get_by_role("button", name="新しい発表", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(1)
    page.get_by_role("button", name="既存の発表を複製", exact=True).click()
    page.get_by_label("複製する発表", exact=True).select_option("new-talk")
    page.get_by_label("フォルダ名", exact=True).fill("copy-talk")
    page.get_by_label("タイトル", exact=True).fill("複製した発表")
    page.get_by_role("button", name="作る", exact=True).click()
    expect(page).to_have_url(srv.url + "/deck/copy-talk")
    expect(page.locator("#deckTitle")).to_have_text("複製した発表")
    assert "編集を再開できる。" in ws.qmd("copy-talk").read_text()
    assert not page.errors


def test_export_and_download(page, gui):
    _, srv = gui
    page.goto(srv.url)
    # 既存資料の取り込みと検査のボタンは置かない（検査は書き出しの中で行う）
    expect(page.get_by_role("button", name="新しい発表", exact=True)).to_be_enabled()
    expect(page.get_by_role("button", name="既存の資料を取り込む")).to_have_count(0)
    page.locator(".card").filter(has_text="テスト発表").click()
    expect(page.locator("#status")).to_have_text("保存済み")
    expect(page.get_by_role("button", name="検査", exact=True)).to_have_count(0)
    page.evaluate("""async () => {
        window.exportProgress = [];
        const {onEvent} = await import('/web/api.js');
        onEvent(ev => { if (ev.type === 'export-progress') window.exportProgress.push(ev.value); });
    }""")
    for ext in ("html", "pdf"):
        page.evaluate("window.exportProgress = []")
        page.get_by_role("button", name="書き出し", exact=True).click()
        with page.expect_download(timeout=60000) as download:
            page.get_by_role("button", name=ext.upper(), exact=True).click()
            expect(page.get_by_role("progressbar")).to_be_visible()
        expect(page.locator(".output-body")).to_contain_text("書き出しました")
        expect(page.locator(".downloads a")).to_have_count(1)
        expect(page.locator(".downloads a")).to_have_text(f"テスト発表.{ext}")
        assert download.value.suggested_filename == f"テスト発表.{ext}"
        assert download.value.failure() is None
        values = page.evaluate("window.exportProgress")
        # 検査開始時は進捗未確定（null）、その後は書き出し完了まで進む。
        assert values[0] is None and values[-1] == 100
        values = [value for value in values if value is not None]
        assert all(0 <= value <= 100 for value in values)
        assert values == sorted(values)
        if ext == "pdf":
            assert any(60 < value < 100 for value in values)
        if ext == "html":
            assert not (gui[0].deck_dir("talk") / "テスト発表.pdf").exists()
            page.get_by_role("button", name="閉じる", exact=True).click()
    # 書き出しの検査で撮った画像が、ホームのカードの縮小画像になる
    page.get_by_role("button", name="閉じる", exact=True).click()
    page.get_by_role("link", name="ホーム", exact=True).click()
    expect(page.locator(".card .thumb img").first).to_have_attribute("src", re.compile(r"/shots/p01-s0\.png"))
    assert not page.errors


def test_missing_browser_can_be_prepared_in_gui(page, gui):
    _, srv = gui
    installed = []
    def env(route):
        route.fulfill(json={"items": [{"name": "Chromium", "ok": bool(installed), "detail": "ready" if installed else "missing"}]})
    page.route("**/api/env*", env)
    def setup(route):
        installed.append(True)
        route.fulfill(json={"ok": True})
    page.route("**/api/setup", setup)
    page.goto(srv.url)
    expect(page.get_by_role("button", name="動作環境")).to_contain_text("準備が必要")
    page.get_by_role("button", name="動作環境").click()
    page.get_by_role("button", name="書き出し用のブラウザを準備").click()
    expect(page.locator(".env-list:not(.env-ai)")).to_contain_text("ready")
    assert installed
    assert not page.errors


def test_export_panel_is_compact_and_anchored(page, gui, tmp_path):
    _, srv = gui
    page.goto(f'{srv.url}/deck/talk')
    trigger = page.locator('[data-output="build"]')
    trigger.click()
    panel = page.locator('.output-popover')
    expect(panel).to_be_visible()
    expect(panel.get_by_role('button', name='HTML', exact=True)).to_be_visible()
    expect(panel.get_by_role('button', name='PDF', exact=True)).to_be_visible()
    expect(page.locator('.dialog-back')).to_have_count(0)
    expect(panel.locator('select')).to_have_count(0)
    box, anchor = panel.bounding_box(), trigger.bounding_box()
    assert box['width'] < 260 and box['height'] < 70
    assert abs(box['y'] - (anchor['y'] + anchor['height'] + 6)) < 2
    assert abs(box['x'] + box['width'] - anchor['x'] - anchor['width']) < 2
    page.screenshot(path=str(tmp_path / 'export-panel.png'))
    page.keyboard.press('Escape')
    expect(panel).to_have_count(0)
    expect(trigger).to_be_focused()
    trigger.click()
    page.locator('#status').click()
    expect(panel).to_have_count(0)
    trigger.click()
    trigger.click()
    expect(panel).to_have_count(0)
    assert not page.errors
