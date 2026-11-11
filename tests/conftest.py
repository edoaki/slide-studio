import os
import shutil
from pathlib import Path

import pytest

from slide_studio.workspace import Workspace

FIXTURES = Path(__file__).parent / "fixtures"
SYNC = FIXTURES / "sync"


def pytest_xdist_auto_num_workers(config):
    """-n auto（pyproject の既定）で並べる数。ファイルを2つまで指定したときは並べない（ワーカーの起動のほうが長い）。
    Chromium と Pandoc を動かすので、論理コアの半分にする（全部使うと待ち時間切れが出る）。"""
    files = {arg.split("::")[0] for arg in config.args}
    if files and len(files) <= 2 and all(f.endswith(".py") for f in files):
        return 0
    return max(1, (os.cpu_count() or 2) // 2)


# e2e の page が使い回す Playwright と Chromium（ワーカーごとに1つ）。起動はテストごとだと 0.3 秒ほどかかる
_playwright = {}


def shared_browser():
    if not (_playwright and _playwright["browser"].is_connected()):
        close_shared_browser()
        from playwright.sync_api import sync_playwright

        p = sync_playwright().start()
        _playwright.update(playwright=p, browser=p.chromium.launch())
    return _playwright["browser"]


def close_shared_browser():
    if _playwright:
        try:
            _playwright["browser"].close()
        finally:
            _playwright.pop("playwright").stop()
            _playwright.clear()


@pytest.fixture(autouse=True)
def own_playwright(request):
    """page を使わないテストは自分で Playwright を起動することがある。同じスレッドで2つは動かないので、使い回しを閉じる。"""
    if "page" not in request.fixturenames:
        close_shared_browser()


def pytest_sessionfinish(session):
    close_shared_browser()


@pytest.fixture(autouse=True)
def no_real_ai(tmp_path, monkeypatch):
    """テストでは実際の AI の CLI を呼ばない（使うテストはテスト用の CLI を指定する）。"""
    for name in ("SLIDE_STUDIO_CODEX", "SLIDE_STUDIO_CLAUDE", "SLIDE_STUDIO_AGY"):
        monkeypatch.setenv(name, "none")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.setenv("SLIDE_STUDIO_CODEX_HOME", str(tmp_path / "studio-codex-home"))
    monkeypatch.setenv("SLIDE_STUDIO_CLAUDE_HOME", str(tmp_path / "studio-claude-home"))
    monkeypatch.setenv("SLIDE_STUDIO_AGY_HOME", str(tmp_path / "studio-agy-home"))
    # ws を使わないテストでも、偽 AI のログをリポジトリ直下へ残さない。
    monkeypatch.setenv("FAKE_STUDIO_ROOT", str(tmp_path / "fake-studio"))


@pytest.fixture(autouse=True)
def no_background_shots(monkeypatch):
    """テストでは縮小画像を裏で撮らない（使うテストは shots.ENABLED を戻す）。"""
    from slide_studio import shots
    monkeypatch.setattr(shots, "ENABLED", False)


@pytest.fixture(autouse=True)
def no_background_updates(monkeypatch):
    """テストでは AI の実行ファイルを裏で更新しない。"""
    from slide_studio.ai import runtimes
    monkeypatch.setattr(runtimes, "ENABLED", False)


@pytest.fixture(autouse=True)
def no_background_checks(monkeypatch):
    """テストでは裏の検査を止める（使うテストだけ戻す）。"""
    from slide_studio import background_check
    monkeypatch.setattr(background_check, "ENABLED", False)


@pytest.fixture
def ws(tmp_path, monkeypatch) -> Workspace:
    monkeypatch.setenv("SLIDE_STUDIO_HOME", str(tmp_path / "slides"))
    workspace = Workspace.open(tmp_path / "slide-studio")
    monkeypatch.setenv("FAKE_STUDIO_ROOT", str(workspace.root))
    return workspace


def add_deck(ws: Workspace, name: str, text: str, bib: str = "") -> Path:
    d = ws.deck_dir(name)
    for sub in ("styles",):
        (d / sub).mkdir(parents=True, exist_ok=True)
    (d / "slides.qmd").write_text(text)
    if ws.deck_meta(name).get("topic"):
        ws.images_dir(name).mkdir(parents=True, exist_ok=True)
        ws.shelf_dir(ws.deck_shelf(name)).mkdir(parents=True, exist_ok=True)
    target = ws.bib(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    if bib or not target.exists():
        target.write_text(bib)
    return d


@pytest.fixture(scope="session")
def nco_ws(tmp_path_factory) -> Workspace:
    """nco-intro を取り込んだ置き場（セッションで1つ）。"""
    from slide_studio.importer import import_deck

    root = tmp_path_factory.mktemp("nco") / "slide-studio"
    w = Workspace.open(root)
    import_deck(w, FIXTURES / "nco-intro", "nco")
    return w
