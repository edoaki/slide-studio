"""GUI の e2e：一時の置き場でサーバーをスレッドで起動し、Playwright の Chromium で開く。"""
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conftest import add_deck, shared_browser  # noqa: E402

from slide_studio.workspace import Workspace  # noqa: E402

DECK = '''---
title: "テスト発表"
topic: test
theme: default
lang: ja
---

## テスト発表 {#cover .cover}

::: {.cover-title}
テスト発表
:::

# 本編 {#main}

## 一枚目 {#one}

最初の段落。

二番目の段落。

## 二枚目 {#two}

:::: {.columns}
::: {.column width="50%"}
左の列。
:::
::: {.column width="50%"}
右の列。
:::
::::

## まとめ {#summary}

まとめの段落。

## 参考文献 {#references}

# Appendix {#appendix}
'''


class ServerThread:
    def __init__(self, ws: Workspace):
        import uvicorn

        from slide_studio.server import build_app
        from slide_studio.location import build_location_app

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.app = build_app(ws) if ws else build_location_app()
        self.server = uvicorn.Server(uvicorn.Config(self.app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        while not self.server.started:
            time.sleep(0.02)
        self.url = f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.server.should_exit = True
        self.thread.join(timeout=5)


@pytest.fixture
def gui(ws):
    add_deck(ws, "talk", DECK)
    srv = ServerThread(ws)
    yield ws, srv
    srv.stop()


@pytest.fixture
def page(gui):
    # Chromium はワーカーの中で使い回し、テストごとに新しいコンテキスト（保存領域も別）で開く
    b = shared_browser()
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    pg.set_default_timeout(10_000)  # 壊れたときに30秒待たない
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.errors = errors
    yield pg
    for context in b.contexts:  # テストの中で開いた別のページも閉じる
        context.close()


def open_deck(pg, srv, deck="talk", raw=True):
    pg.goto(f"{srv.url}/deck/{deck}")
    pg.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    pg.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    if raw:
        pg.get_by_role("button", name="すべての記法を表示", exact=True).click()


def rendered(pg, ws, deck="talk"):
    """プレビューが保存した原稿の版に追いつくまで待つ（版は原稿の sha256。描き直しが始まる前の古い表示で先へ進まない）。
    文字の直接編集の途中は描き直さないので、編集を終えてから呼ぶ。"""
    from slide_studio.fsutil import sha256_text

    want = sha256_text(ws.qmd(deck).read_text())
    pg.wait_for_function("(v) => document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.__slideStudioVersion === v"
                         " && !document.querySelector('#slideBox iframe.loading')", arg=want)


def open_theme(pg):
    """テーマのタブを開き、閉じてある［見出し］も開く。"""
    pg.get_by_role("tab", name="テーマ", exact=True).click()
    toggles = pg.locator(".tv-section-toggle")
    toggles.first.wait_for(state="attached")
    for summary in toggles.locator("summary").all():
        if not summary.evaluate("s => s.parentElement.open"):
            summary.click()


def slide_text(pg) -> str:
    return pg.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('.slide.active').innerText")


@pytest.fixture
def location_server(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    srv = ServerThread(None)
    yield srv
    srv.stop()


def expand_subs(page):
    """モデルの欄のサブエージェントを開く（開いた状態は覚えているので、閉じているときだけ押す）。"""
    head = page.locator('[data-mact=subs]')
    if head.get_attribute('aria-expanded') != 'true':
        head.click()
