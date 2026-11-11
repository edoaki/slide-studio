"""ページの帯の縮小画像（設計書 §10.2）。描画のたびに、各ページの各 step を裏で撮る。

撮るのは前回から変わったページだけ（ページの HTML・位置・ページ数・head・依存ファイルの版で判定）。
画像は .slide-studio/build/<deck>/thumbnails/pXX-sY.png。撮り終えたページから "shots" の通知で GUI に知らせる。
撮影専用のスレッド・Chromium を使い回し、検査・書き出しの完了を待たない。
"""
from __future__ import annotations

import asyncio
from concurrent.futures import Future
import json
import threading
from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import check
from .fsutil import sha256_text, write_atomic
from .httpd import StaticServer
from .render import Rendered
from .workspace import Workspace

ENABLED = True  # テストでは止める（使うテストだけ戻す）
INDEX = "index.json"
SPLIT = "html => { const d = new DOMParser().parseFromString(html, 'text/html'); return [d.head.outerHTML, ...[...d.querySelectorAll('#stage > .slide')].map(s => s.outerHTML)]; }"


def shots_dir(ws: Workspace, deck: str) -> Path:
    return ws.build_dir(deck) / "thumbnails"


def _load_index(ws: Workspace, deck: str) -> list[dict]:
    try:
        return json.loads((shots_dir(ws, deck) / INDEX).read_text())["slides"]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def listing(ws: Workspace, deck: str) -> list[list[str | None]]:
    """スライドごとに、各 step の画像の URL（無ければ None）。版は更新時刻で付ける。"""
    out = []
    folder = shots_dir(ws, deck)
    for i, s in enumerate(_load_index(ws, deck)):
        urls = []
        for k in range(s.get("steps") or 0):
            p = folder / f"{check._slide_name(i, k)}.png"
            try:
                urls.append(f"/files/.slide-studio/build/{deck}/thumbnails/{p.name}?v={p.stat().st_mtime_ns}")
            except OSError:
                urls.append(None)
        out.append(urls)
    return out


def cover_listing(ws: Workspace, deck: str) -> list[str]:
    """ホーム・トピックの画像。撮影前の発表だけは従来の検査画像を使う。"""
    if (shots_dir(ws, deck) / INDEX).exists():
        return [steps[0] for steps in listing(ws, deck) if steps and steps[0]]
    paths = sorted((ws.build_dir(deck) / "shots").glob("p*-s0.png"), key=lambda p: int(p.stem[1:].split("-")[0]))
    return [f"/files/.slide-studio/build/{deck}/shots/{p.name}?v={p.stat().st_mtime_ns}" for p in paths]


class Shooter:
    def __init__(self, srv):
        self.srv, self.ws = srv, srv.ws
        self.cond = threading.Condition()
        self.pending: list[str] = []
        self.active_deck: str | None = None  # ホームの移動・削除と撮影の書き込みを重ねない
        self.active_job_deck: str | None = None
        self.jobs: list[tuple[object, Future, str | None]] = []
        self.background_jobs: list[tuple[object, Future, str | None]] = []
        self.visible: dict[str, list[int]] = {}
        self.thread: threading.Thread | None = None
        self.job_thread: threading.Thread | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.stopping = False

    # ------------------------------------------------------------ server.py のフック
    def __call__(self, kind, arg) -> None:
        if kind == "rendered" and ENABLED:
            self.request(arg)

    def request(self, deck: str) -> None:
        with self.cond:
            if self.stopping:
                return
            if deck not in self.pending:
                self.pending.append(deck)
            if self.thread is None:
                self.thread = threading.Thread(target=self.run, name="slide-studio-shots", daemon=True)
                self.thread.start()
            self.cond.notify_all()

    def prioritize(self, deck: str, indices: list[int]) -> None:
        with self.cond:
            self.visible[deck] = list(dict.fromkeys(indices))
            if indices and deck in self.pending:
                self.pending.remove(deck)
                self.pending.insert(0, deck)

    def next_shot(self, deck: str, remaining: dict[int, list[int]]) -> tuple[int, int]:
        # 各画像の直前に読み直し、撮影中のスクロールにも追従する。
        with self.cond:
            visible = {i: rank for rank, i in enumerate(self.visible.get(deck, []))}
        i = min(remaining, key=lambda i: (
            (0 if remaining[i][0] == 0 else 1) if i in visible else (2 if remaining[i][0] == 0 else 3),
            visible.get(i, i),
        ))
        return i, remaining[i][0]

    def submit(self, work, *, deck: str | None = None, background: bool = False) -> Future:
        """検査・書き出し・テーマ見本用のブラウザで直列に行う。帯の撮影は独立。"""
        future = Future()
        with self.cond:
            if self.stopping:
                future.set_exception(RuntimeError("ブラウザは終了しています"))
                return future
            (self.background_jobs if background else self.jobs).append((work, future, deck))
            if self.job_thread is None:
                self.job_thread = threading.Thread(target=self.run_jobs, name="slide-studio-browser", daemon=True)
                self.job_thread.start()
            self.cond.notify_all()
        return future

    def newer(self, deck: str) -> bool:
        """撮っている間に描き直された（今の撮影をやめて撮り直す）。"""
        with self.cond:
            return self.stopping or deck in self.pending

    def start(self) -> None:
        self.loop = asyncio.get_running_loop()

    def stop(self) -> None:
        with self.cond:
            self.stopping = True
            for _, future, _ in self.jobs + self.background_jobs:
                future.cancel()
            self.jobs.clear()
            self.background_jobs.clear()
            self.cond.notify_all()
        for thread in (self.thread, self.job_thread):
            if thread:
                thread.join(timeout=5)

    def notify(self, deck: str) -> None:
        if self.loop and not self.loop.is_closed():
            ev = {"type": "shots", "deck": deck, "slides": listing(self.ws, deck)}
            self.loop.call_soon_threadsafe(self.srv.broadcast, ev)

    # ------------------------------------------------------------ 検査・書き出しのスレッド
    def run_jobs(self) -> None:
        browser = None
        try:
            while True:
                with self.cond:
                    self.active_job_deck = None
                    while not self.stopping and not self.jobs and not (
                        self.background_jobs and not self.pending and self.active_deck is None
                    ):
                        self.cond.wait()
                    if self.stopping:
                        return
                    work, future, self.active_job_deck = (self.jobs or self.background_jobs).pop(0)
                if future.set_running_or_notify_cancel():
                    try:
                        if browser is None:
                            browser = check.Browser()
                        future.set_result(work(browser))
                    except Exception as e:  # noqa: BLE001 - 呼び出し元に返す
                        future.set_exception(e)
                        _close(browser)
                        browser = None
        finally:
            _close(browser)

    # ------------------------------------------------------------ 撮影のスレッド
    def run(self) -> None:
        browser = server = None
        try:
            while True:
                with self.cond:
                    self.active_deck = None
                    self.cond.notify_all()
                    while not self.pending and not self.stopping:
                        self.cond.wait()
                    if self.stopping:
                        return
                    deck = self.active_deck = self.pending.pop(0)
                st = self.srv.decks.get(deck)
                rendered = st.rendered if st else None
                if rendered is None or not self.ws.has_deck(deck):
                    continue
                try:
                    if browser is None:
                        browser = check.Browser()
                    if server is None:
                        server = StaticServer(self.ws.root)
                    self.shoot(deck, rendered, browser, server)
                except Exception as e:  # noqa: BLE001 - Chromium が無い・落ちた。次の描画で起動し直す
                    print(f"縮小画像を作れません（{deck}）: {e}")
                    _close(browser, server)
                    browser = server = None
        finally:
            _close(browser, server)

    def shoot(self, deck: str, rendered: Rendered, browser: check.Browser, server: StaticServer) -> None:
        folder = shots_dir(self.ws, deck)
        folder.mkdir(parents=True, exist_ok=True)
        deps = check.deck_version(self.ws, deck, rendered.doc.text)["deps"]
        url_path = f"/decks/{deck}/{check.PREVIEW_NAME}"
        server.overrides[url_path] = rendered.html.encode()
        ctx = browser.browser.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
        try:
            origin = server.origin
            ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith((origin, "data:", "about:", "blob:")) else r.abort())
            page = ctx.new_page()
            page.add_init_script("window.__slideStudioNoHash = true;")
            # 画面外の図・画像の load や表紙の settle を待たず、撮るページだけ deck.go で待つ。
            page.goto(server.url(url_path), wait_until="domcontentloaded")
            page.wait_for_function("!!window.deck", timeout=20000)
            page.evaluate("document.body.classList.add('export')")
            head, *parts = page.evaluate(SPLIT, page.evaluate("""() => {
                const d = document.cloneNode(true);
                d.querySelectorAll('#stage > .slide').forEach(s => {
                    s.classList.remove('active'); s.removeAttribute('aria-hidden');
                });
                return d.documentElement.outerHTML;
            }"""))
            n = page.evaluate("deck.count")
            prev = _load_index(self.ws, deck)
            index = [prev[i] if i < len(prev) else {"hash": "", "steps": 0} for i in range(n)]
            keys = [sha256_text("\n".join([deps, str(i), str(n), head, html])) for i, html in enumerate(parts[:n])]
            keys += [""] * (n - len(keys))

            def save():
                write_atomic(folder / INDEX, json.dumps({"slides": index}, ensure_ascii=False))
            if len(prev) != n:
                save()
                self.notify(deck)
            remaining = {}
            for i in range(n):
                done = index[i].get("hash") == keys[i] and keys[i] and all(
                    (folder / f"{check._slide_name(i, k)}.png").exists() for k in range(index[i].get("steps") or 0))
                if not done:
                    remaining[i] = [0]
            while remaining:
                if self.newer(deck):
                    return
                i, k = self.next_shot(deck, remaining)
                page.evaluate("([i, s, t]) => Promise.race([deck.go(i, s), new Promise(r => setTimeout(r, t))])",
                              [i, k, check.SETTLE_TIMEOUT_MS])
                if self.newer(deck):
                    return
                if k == 0:
                    steps = page.evaluate("deck.maxStep()") + 1
                    remaining[i] = list(range(steps))
                    index[i] = {"hash": "", "steps": steps}
                png = page.screenshot()
                if self.newer(deck):
                    return
                write_atomic(folder / f"{check._slide_name(i, k)}.png", png)
                remaining[i].pop(0)
                if not remaining[i]:
                    del remaining[i]
                    index[i]["hash"] = keys[i]
                # 段数の多い図でも最初の画像から通知。全段が揃うまでキャッシュ完了にはしない。
                save()
                self.notify(deck)
            names = {f"{check._slide_name(i, k)}.png" for i in range(n) for k in range(index[i].get("steps") or 0)}
            # 消えたページ・step の画像を消す（ホームの一覧は p*-s0.png を並べるため）
            for p in folder.glob("p*-s*.png"):
                if p.name not in names:
                    p.unlink(missing_ok=True)
        finally:
            ctx.close()
            server.overrides.pop(url_path, None)


def _close(*things) -> None:
    for t in things:
        try:
            t and t.close()
        except Exception:  # noqa: BLE001 - 終了時の後片付け
            pass


def install(app, srv, routes) -> None:
    shooter = Shooter(srv)
    srv.hooks.append(shooter)
    srv.starters.append(shooter.start)
    srv.stoppers.append(shooter.stop)
    app.state.shots = shooter
    srv.browser_worker = shooter

    async def get(request: Request):
        deck = request.path_params["deck"]
        if not srv.ws.has_deck(deck):
            return JSONResponse({"error": "発表がありません"}, 404)
        return JSONResponse({"slides": listing(srv.ws, deck)})

    async def priority(request: Request):
        deck = request.path_params["deck"]
        if not srv.ws.has_deck(deck):
            return JSONResponse({"error": "発表がありません"}, 404)
        try:
            data = await request.json()
        except ValueError:
            data = None
        indices = data.get("indices") if isinstance(data, dict) else None
        if not isinstance(indices, list) or len(indices) > 1000 or any(type(i) is not int or i < 0 for i in indices):
            return JSONResponse({"error": "ページの指定が不正です"}, 400)
        shooter.prioritize(deck, indices)
        return JSONResponse({"ok": True})

    # 既存の /api/deck/{deck}/{action} より先に照合させる
    app.router.routes[0:0] = [Route("/api/deck/{deck}/shots", get),
                             Route("/api/deck/{deck}/shots/priority", priority, methods=["POST"])]
