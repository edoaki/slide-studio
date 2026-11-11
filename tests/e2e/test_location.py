from pathlib import Path

from playwright.sync_api import expect



def test_choose_custom_location(page, tmp_path, monkeypatch, location_server):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    parent = tmp_path / "発表資料"
    parent.mkdir()
    srv = location_server
    try:
        page.goto(srv.url)
        expect(page.get_by_role("heading", name="スライドの保管場所を選ぶ")).to_be_visible()
        path = page.get_by_label("フォルダの場所・名前")
        expect(path).to_have_value(str(tmp_path / "Slides"))
        page.screenshot(path="/tmp/slide-studio-location.png")
        page.get_by_role("button", name="フォルダを探す").click()
        page.get_by_role("button", name="発表資料/", exact=True).click()
        page.get_by_role("button", name="この場所を選ぶ").click()
        expect(path).to_have_value(str(parent / "Slides"))
        path.fill(str(parent / "My Talks"))
        page.get_by_role("button", name="この場所で始める").click()
        expect(page.get_by_role("button", name="新しい発表", exact=True)).to_be_enabled(timeout=15000)
        assert (parent / "My Talks" / "build.py").is_file()
        assert not (tmp_path / "Slides").exists()
        assert not page.errors
    finally:
        srv.stop()


def test_choose_existing_location(page, tmp_path, monkeypatch, ws, location_server):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    srv = location_server
    try:
        page.goto(srv.url)
        page.get_by_role("button", name="既存のフォルダを使う").click()
        page.get_by_label("フォルダの場所・名前").fill(str(ws.root))
        page.get_by_role("button", name="この場所で始める").click()
        expect(page.locator('.card').filter(has_text='テスト発表')).to_be_visible(timeout=15000)
        assert not page.errors
    finally:
        srv.stop()


def test_switch_and_return_to_recent_folder(page, tmp_path, ws, location_server):
    srv = location_server
    page.goto(srv.url)
    page.get_by_role("button", name="既存のフォルダを使う").click()
    page.get_by_label("フォルダの場所・名前").fill(str(ws.root))
    page.get_by_role("button", name="この場所で始める").click()
    expect(page.locator('.card').filter(has_text='テスト発表')).to_be_visible(timeout=15000)
    page.get_by_role("button", name="保管場所を切り替える").click()
    page.get_by_role("link", name="ホームに戻る").click()
    expect(page.locator('.card').filter(has_text='テスト発表')).to_be_visible()
    page.get_by_role("button", name="保管場所を切り替える").click()
    destination = tmp_path / "別の保管場所"
    destination.mkdir()
    page.get_by_role("button", name="既存のフォルダを使う").click()
    page.get_by_label("フォルダの場所・名前").fill(str(destination))
    page.get_by_role("button", name="この場所で始める").click()
    expect(page.get_by_role("button", name="保管場所を切り替える")).to_be_visible(timeout=15000)
    expect(page.locator('.card')).to_have_count(0)
    assert (destination / "decks").is_dir()
    assert (destination / ".slide-studio").is_dir()
    page.get_by_role("button", name="保管場所を切り替える").click()
    page.screenshot(path="/tmp/slide-studio-location-switch.png", full_page=True)
    page.get_by_role("button", name=str(ws.root), exact=True).click()
    expect(page.locator('.card').filter(has_text='テスト発表')).to_be_visible(timeout=15000)
    assert not page.errors
