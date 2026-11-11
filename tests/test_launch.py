import asyncio
from pathlib import Path
from unittest.mock import Mock

import pytest
from starlette.testclient import TestClient

from slide_studio import cli, doctor, server
from slide_studio.workspace import Workspace, default_root


@pytest.fixture
def http_startup(monkeypatch):
    import uvicorn

    async def startup(self, sockets=None):
        self.started = True

    monkeypatch.setattr(uvicorn.Server, "startup", startup)
    monkeypatch.setattr(uvicorn.Server, "run", lambda self: asyncio.run(self.startup()))


def test_default_launch_opens_home(ws, monkeypatch):
    serve = Mock()
    monkeypatch.setattr(server, "serve", serve)
    assert cli.main(["--root", str(ws.root)]) == 0
    assert serve.call_args.kwargs == {"open_deck": None, "port": 4320, "open_browser": True}


@pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])
def test_opens_normal_browser_tab(monkeypatch, platform):
    monkeypatch.setattr(server.sys, "platform", platform)
    monkeypatch.setattr(Path, "is_file", lambda self: False)
    launch, browser = Mock(), Mock()
    monkeypatch.setattr(server.subprocess, "Popen", launch)
    monkeypatch.setattr(server.webbrowser, "open_new_tab", browser)
    url = "http://127.0.0.1:4327/deck/talk"
    server.open_window(url)
    browser.assert_called_once_with(url)
    launch.assert_not_called()


@pytest.mark.parametrize("enabled", [True, False])
def test_serve_opens_selected_url_only_when_enabled(ws, monkeypatch, http_startup, enabled):
    ws.new_deck("talk", "research")
    monkeypatch.setattr(server, "free_port", lambda _: 4327)
    window = Mock()
    monkeypatch.setattr(server, "open_window", window)
    server.serve(ws, open_deck="talk", open_browser=enabled)
    if enabled:
        window.assert_called_once_with("http://127.0.0.1:4327/deck/talk")
    else:
        window.assert_not_called()


def test_closing_every_window_stops_server(monkeypatch):
    import asyncio

    from slide_studio import lifeline

    stop = Mock()
    monkeypatch.setattr(lifeline, "GRACE", 0.05)
    monkeypatch.setattr(lifeline, "_stop", stop)

    async def main():
        with lifeline.held(Mock()):
            pass
        # 再読み込み：猶予のうちにつなぎ直せば止めない
        with lifeline.held(Mock()):
            await asyncio.sleep(0.1)
            stop.assert_not_called()
        await asyncio.sleep(0.1)

    asyncio.run(main())
    stop.assert_called_once_with()


def test_ctrl_c_does_not_wait_for_open_windows(ws, monkeypatch, http_startup):
    import uvicorn

    config = Mock(wraps=uvicorn.Config)
    monkeypatch.setattr(uvicorn, "Config", config)
    monkeypatch.setattr(server, "free_port", lambda _: 4327)
    window = Mock(poll=Mock(return_value=None))
    monkeypatch.setattr(server, "open_window", lambda url: window)
    server.serve(ws)
    assert config.call_args.kwargs["timeout_graceful_shutdown"] == 1
    # 本体専用のプロセスだけを終了する。
    window.terminate.assert_called_once_with()


def test_failed_startup_does_not_open_window(ws, monkeypatch, http_startup):
    import uvicorn

    async def failed(self, sockets=None):
        self.should_exit = True

    monkeypatch.setattr(uvicorn.Server, "startup", failed)
    monkeypatch.setattr(server, "free_port", lambda _: 4327)
    window = Mock()
    monkeypatch.setattr(server, "open_window", window)
    server.serve(ws)
    window.assert_not_called()


def test_lifeline_keeps_other_windows_and_cancels_shutdown_timer(monkeypatch):
    from slide_studio import lifeline

    stop = Mock()
    monkeypatch.setattr(lifeline, "GRACE", 0.02)

    async def main():
        lifeline.arm(stop)
        try:
            with lifeline.held(Mock()):
                with lifeline.held(Mock()):
                    pass
                await asyncio.sleep(0.05)
                stop.assert_not_called()
            # Ctrl+C などで終了処理に入ったら、自動終了の予約を解除する。
            lifeline.end_all()
            await asyncio.sleep(0.05)
            stop.assert_not_called()
            # --no-browser では切断しても止めない。
            with lifeline.held(Mock()):
                pass
            await asyncio.sleep(0.05)
            stop.assert_not_called()
        finally:
            lifeline.arm(None)

    asyncio.run(main())


def test_default_root_ignores_unselected_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("SLIDE_STUDIO_HOME", raising=False)
    assert default_root() == tmp_path / "Slides"
    legacy = Workspace.open(tmp_path / "other-slides")
    legacy.new_deck("old-talk", "research")
    assert default_root() == tmp_path / "Slides"
    assert Workspace.open().list_decks() == []
    assert legacy.has_deck("old-talk")
    assert default_root() == tmp_path / "Slides"
    monkeypatch.setenv("SLIDE_STUDIO_HOME", str(tmp_path / "custom-new"))
    assert default_root() == tmp_path / "custom-new"


def test_bundled_pandoc_without_quarto(monkeypatch):
    monkeypatch.delenv("SLIDE_STUDIO_PANDOC", raising=False)
    monkeypatch.setattr(doctor.shutil, "which", lambda _: None)
    doctor.pandoc_path.cache_clear()
    try:
        assert doctor.pandoc_path().is_file()
        assert "pypandoc" in str(doctor.pandoc_path())
    finally:
        doctor.pandoc_path.cache_clear()


def test_gui_api_failure_and_setup(ws, monkeypatch):
    ws.new_deck("talk", "research", title='引用 "テスト"')
    assert ws.deck_meta("talk")["title"] == '引用 "テスト"'
    client = TestClient(server.build_app(ws))
    assert client.post("/api/deck/talk/build", json={"base": "old"}).status_code == 409
    assert client.get("/api/deck/talk/download/pdf").status_code == 404
    # 既存資料の取り込みは GUI から外した（CLI の slide-studio import だけ）
    assert client.post("/api/import", json={"path": str(ws.root / "missing"), "name": "missing"}).status_code in (404, 405)
    assert client.post("/api/new", json={"name": "talk", "shelf": "research"}).status_code == 400
    assert client.post("/api/new", json={}, headers={"origin": "https://other.example"}).status_code == 403
    install = Mock(return_value=Mock(returncode=0, stderr=""))
    monkeypatch.setattr(server.subprocess, "run", install)
    assert client.post("/api/setup").json() == {"ok": True}
    assert install.call_args.args[0][-4:] == ["-m", "playwright", "install", "chromium"]
    install.return_value.returncode = 1
    install.return_value.stderr = "download failed"
    assert client.post("/api/setup").status_code == 400


@pytest.mark.parametrize("user_install", [False, True])
def test_mac_app_window_uses_private_profile(monkeypatch, tmp_path, user_install):
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    base = tmp_path / "Applications" if user_install else Path("/Applications")
    chrome = base / "Google Chrome.app/Contents/MacOS/Google Chrome"
    monkeypatch.setattr(Path, "is_file", lambda self: self == chrome)
    launch, browser = Mock(), Mock()
    monkeypatch.setattr(server.subprocess, "Popen", launch)
    monkeypatch.setattr(server.webbrowser, "open_new_tab", browser)
    url = "http://127.0.0.1:4327/"
    assert server.open_window(url) is launch.return_value
    args = launch.call_args.args[0]
    assert args[:2] == [str(chrome), f"--app={url}"]
    assert f"--user-data-dir={tmp_path / '.config/slide-studio/chrome'}" in args
    browser.assert_not_called()


def test_failed_app_window_uses_default_browser(monkeypatch):
    monkeypatch.setattr(server.sys, "platform", "darwin")
    monkeypatch.setattr(Path, "is_file", lambda self: True)
    monkeypatch.setattr(server.subprocess, "Popen", Mock(side_effect=OSError))
    browser = Mock()
    monkeypatch.setattr(server.webbrowser, "open_new_tab", browser)
    assert server.open_window("http://127.0.0.1:4320/") is None
    browser.assert_called_once_with("http://127.0.0.1:4320/")


def test_external_link_uses_default_browser_and_validates_requests(ws, monkeypatch):
    browser = Mock(return_value=True)
    monkeypatch.setattr(server.webbrowser, "open_new_tab", browser)
    client = TestClient(server.build_app(ws))
    headers = {"origin": "http://testserver"}
    url = "https://example.com/paper?q=a#section"
    assert client.post('/api/open-external', json={"url": url}, headers=headers).status_code == 200
    browser.assert_called_once_with(url)
    browser.reset_mock()
    for bad in ['file:///tmp/file', 'javascript:alert(1)', 'https://', '--app=foo', None, 42]:
        assert client.post('/api/open-external', json={"url": bad}, headers=headers).status_code == 400
    for origin in [None, 'https://other.example']:
        assert client.post('/api/open-external', json={"url": url}, headers={"origin": origin} if origin else {}).status_code == 403
    browser.assert_not_called()
    browser.return_value = False
    assert client.post('/api/open-external', json={"url": url}, headers=headers).status_code == 503
