"""HTTP・SSE・ファイル監視。設計書 §6.4・§6.5・§7.1・§10・§12。

127.0.0.1 だけで待ち受け、同一オリジン以外からの書き込み要求を拒否する（mock の server.mjs と同じ）。
プレビューは render.py の HTML をそのまま配信し、編集用のスクリプトを後から注入する。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import subprocess
import sys
import time
import webbrowser
from urllib.parse import urlsplit
from dataclasses import dataclass, field
from pathlib import Path

import anyio
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import assets, block_design, doctor, edit_scope, library, lifeline, materials, memo, source
from .fsutil import sha256_text, write_atomic
from .render import RenderError, Rendered, render_text, warning_issues
from .workspace import StudioError, Workspace, check_name

WEB = Path(__file__).resolve().parent / "web"
PREVIEW = "__slide-studio_preview__.html"
CHUNK_VERSIONS = 4  # ブロックの判定を残す版の数


@dataclass
class DeckState:
    deck: str
    html: str | None = None  # 最後に変換に成功した HTML
    version: str = ""  # その HTML の元の qmd の sha256
    error: str | None = None
    rendered: Rendered | None = None
    rendering: bool = False
    dirty: bool = False
    force: bool = False
    # 版 → (描画, 判定)。スライドで文字を編集している間に描画が進んでも、編集を始めた版を使えるよう直近の数版を残す
    chunks: dict[str, tuple[Rendered, asyncio.Task]] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class StudioServer:
    def __init__(self, ws: Workspace):
        self.ws = ws
        self.decks: dict[str, DeckState] = {}
        self.queues: set[asyncio.Queue] = set()
        self.env_cache: dict | None = None
        self.hooks: list = []  # 変換・ファイル変更のあとに呼ぶもの（検査・AI が使う）
        self.starters: list = []  # 起動時・終了時に呼ぶもの
        self.stoppers: list = []

    # ------------------------------------------------------------ 通知
    def broadcast(self, event: dict) -> None:
        for q in list(self.queues):
            q.put_nowait(event)

    # ------------------------------------------------------------ 変換
    def state(self, deck: str) -> DeckState:
        if deck not in self.decks:
            self.decks[deck] = DeckState(deck)
        return self.decks[deck]

    async def render(self, deck: str, *, force: bool = False, theme_only: bool = False) -> DeckState:
        st = self.state(deck)
        st.force |= force
        if st.rendering:
            st.dirty = True
            async with st.lock:
                return st
        changed = False
        async with st.lock:
            st.rendering = True
            try:
                while True:
                    st.dirty = False
                    text = self.ws.qmd(deck).read_text()
                    version = sha256_text(text)
                    force_render, st.force = st.force, False
                    if not force_render and st.html and st.version == version and st.error is None:
                        break
                    changed = True
                    self.broadcast({"type": "render-start", "deck": deck, "version": version})
                    t0 = time.perf_counter()
                    try:
                        r = await anyio.to_thread.run_sync(render_text, self.ws, deck, text)
                        from .workspace import set_front
                        prev = getattr(getattr(st.rendered, "doc", None), "text", None)
                        css_only = bool(prev is not None and (theme_only or prev != text)
                                        and set_front(prev, {"theme": "default"}) == set_front(text, {"theme": "default"}))
                        st.html, st.version, st.error, st.rendered = r.html, version, None, r
                        self.broadcast({"type": "render", "deck": deck, "ok": True, "version": version,
                                        "theme_only": css_only, "theme": str(getattr(getattr(r, "doc", None), "meta", {}).get("theme") or "default"),
                                        "ms": round((time.perf_counter() - t0) * 1000), "timing": r.timing,
                                        "slides": r.slides, "warnings": r.warnings, "warning_issues": warning_issues(r), "unsupported": r.unsupported,
                                        "missing_cites": r.missing_cites})
                    except (RenderError, StudioError, OSError) as e:
                        st.error = str(e)
                        self.broadcast({"type": "render", "deck": deck, "ok": False, "version": version, "error": str(e)})
                    if not st.dirty:
                        break
            finally:
                st.rendering = False
        if changed:
            for hook in self.hooks:
                hook("rendered", deck)
        return st

    async def chunk_info(self, st: DeckState, rendered: Rendered) -> dict:
        from .edit import chunk_info
        # 同じ描画への並行 GET/POST は一度の判定を共有する。
        entry = st.chunks.get(rendered.version)
        if entry is None or entry[0] is not rendered:
            entry = st.chunks[rendered.version] = (rendered, asyncio.create_task(anyio.to_thread.run_sync(chunk_info, rendered)))
            while len(st.chunks) > CHUNK_VERSIONS:
                del st.chunks[next(iter(st.chunks))]
        try:
            return await asyncio.shield(entry[1])
        except Exception:
            if st.chunks.get(rendered.version) is entry:
                del st.chunks[rendered.version]
            raise

    # ------------------------------------------------------------ 監視
    def affected_decks(self, paths: list[Path]) -> set[str]:
        out: set[str] = set()
        root = self.ws.root
        for p in paths:
            try:
                rel = p.resolve().relative_to(root).parts
            except ValueError:
                continue
            if not rel or rel[0] == ".slide-studio":
                continue
            if rel[0] == "decks" and len(rel) > 1:
                # 参考資料・下書きはスライドに入らない（実験が書き続けるフォルダでも描き直さない）
                if not materials.is_material("/".join(rel)) and rel[2:] != ("memo.md",):
                    out.add(rel[1])
            elif rel[0] in ("topics", "themes"):
                # 棚・テーマの変更は、開いている発表をすべて描き直す（どれが使うかは描画で決まる）
                out.update(self.decks)
        return {d for d in out if d in self.decks and self.ws.has_deck(d)}

    async def watch(self) -> None:
        from watchfiles import awatch

        def keep(change, path: str) -> bool:
            name = Path(path).name
            return "/.slide-studio/" not in path and not name.endswith(".tmp") and not name.startswith(".") and name != PREVIEW

        async for changes in awatch(self.ws.root, watch_filter=keep, debounce=50, step=20):
            paths = [Path(p) for _, p in changes]
            rels = sorted({str(p.relative_to(self.ws.root)) for p in paths if p.is_relative_to(self.ws.root)})
            self.broadcast({"type": "files", "paths": rels})
            for hook in self.hooks:
                hook("files", rels)
            for deck in self.affected_decks(paths):
                # 原稿だけの通知は版で重複排除。画像・テーマ等は同じ版でも再描画する。
                force = any(p != self.ws.qmd(deck) for p in paths)
                theme_only = bool(rels) and all(p.startswith("themes/") for p in rels)
                asyncio.create_task(self.render(deck, force=force, **({"theme_only": True} if theme_only else {})))


# ---------------------------------------------------------------- ルート


def _json(data, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store"})


def build_app(ws: Workspace) -> Starlette:
    srv = StudioServer(ws)
    operation_lock = asyncio.Lock()
    srv.operation_lock = operation_lock
    setup_lock = asyncio.Lock()

    async def page(request: Request):
        token = getattr(request.app.state, "location_token", "")
        html = (WEB / "app.html").read_text().replace("</head>", f'<meta name="slide-studio-location" content="{token}"></head>')
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    async def env(request: Request):
        if srv.env_cache is None or request.query_params.get("refresh"):
            def required_environment():
                return doctor.Report([doctor.check_pandoc(), doctor.check_chromium()]).to_json()
            srv.env_cache = await anyio.to_thread.run_sync(required_environment)
        items = srv.env_cache["items"] + ws.theme_preparation() + ws.migration_preparation()
        return _json({"ok": all(item["ok"] for item in items), "items": items})

    async def setup(request: Request):
        if setup_lock.locked():
            return _json({"error": "準備中です。完了を待ってください"}, 409)
        async with setup_lock:
            try:
                result = await anyio.to_thread.run_sync(lambda: subprocess.run(
                    [sys.executable, "-m", "playwright", "install", "chromium"],
                    capture_output=True, text=True, timeout=600))
                if result.returncode:
                    return _json({"error": "準備に失敗しました。ネットワークを確認して再試行してください。\n" + result.stderr[-2000:]}, 400)
            except (OSError, subprocess.TimeoutExpired) as e:
                return _json({"error": str(e)}, 400)
            srv.env_cache = None
        return _json({"ok": True})

    async def deck_operation(request: Request):
        from . import check, export
        if request.path_params["action"] not in ("check", "build"):
            return _json({"error": "操作が正しくありません"}, 404)
        deck = request.path_params["deck"]
        body = await request.json()
        if body.get("format") not in (None, "html", "pdf"):
            return _json({"error": "書き出し形式が正しくありません"}, 400)
        loop = asyncio.get_running_loop()
        def progress(value, phase="export"):
            loop.call_soon_threadsafe(srv.broadcast, {"type": "export-progress", "deck": deck,
                                                     "id": body.get("id"), "value": value, "phase": phase})
        async with operation_lock:
            try:
                check_name(deck, "発表の名前")
                ws.require_deck(deck)
                if body.get("base") != sha256_text(ws.qmd(deck).read_text()):
                    return _json({"error": "原稿が変わっています。読み込み直して再試行してください"}, 409)
                def work(browser):
                    conflict = {"conflict": True, "error": "原稿や依存ファイルが変わっています。再試行してください"}
                    if body.get("base") != sha256_text(ws.qmd(deck).read_text()):
                        return conflict
                    progress(None, "check")
                    check_end = 80 if body.get("format") == "html" else 45
                    result = check.check_deck(ws, deck, browser=browser,
                                              progress=lambda value: progress(round(check_end * value / 100), "check"))
                    if result.get("version") != check.deck_version(ws, deck) or result.get("version", {}).get("qmd") != body.get("base"):
                        return conflict
                    if request.path_params["action"] == "check":
                        return {"result": result, "summary": check.summary(result)}
                    if result["errors"] and not body.get("force"):
                        return {"blocked": True, "result": result}
                    paths = export.build(ws, deck, force=bool(body.get("force")), browser=browser, result=result,
                                         **({"format": body["format"], "progress": lambda value: progress(
                                             round(80 + 20 * (value - 45) / 55) if body["format"] == "html" else value)} if body.get("format") else {}))
                    return {"result": result, "files": [{"name": p.name, "url": f"/api/deck/{deck}/download/{p.suffix[1:]}"} for p in paths]}
                data = await asyncio.wrap_future(app.state.shots.submit(work, deck=deck))
                return _json(data, 409 if data.get("conflict") else 200)
            except Exception as e:
                # Pandoc・ブラウザ・書き込みの失敗も画面内で再試行できる。
                return _json({"error": str(e)}, 400)

    async def download(request: Request):
        from .export import output_path
        deck, kind = request.path_params["deck"], request.path_params["kind"]
        try:
            check_name(deck)
            if kind not in ("html", "pdf"):
                raise StudioError("書き出し形式が正しくありません")
            ws.require_deck(deck)
            path = output_path(ws, deck, kind)
            if not path.is_file():
                raise StudioError("まだ書き出されていません")
        except StudioError as e:
            return _json({"error": str(e)}, 404)
        return FileResponse(path, filename=path.name)

    async def home(request: Request):
        def collect():
            recent = ws.recent()
            # 作ったまま手を入れていないもの（blank・empty）があれば、ホームはその欄の［＋］を出さない（§10.1）
            shelves = [{"name": s, "count": len(ws.list_figures(shelf=s)),
                        "empty": not any(r["shelf"] == s for r in recent) and ws.topic_empty(s)} for s in ws.shelves()]
            for r in recent:
                r["blank"] = ws.is_untouched(r["deck"])
                r["running"] = any(getattr(h, key, lambda d: False)(r["deck"]) for h in srv.hooks for key in ("slides_running", "memo_locked"))
                r["shots"] = _shots.cover_listing(ws, r["deck"])
                r["thumb"] = r["shots"][0] if r["shots"] else None
            return {"root": str(ws.root), "recent": recent, "shelves": shelves, "themes": ws.themes_list(), "prefs": ws.prefs()}
        return _json(await anyio.to_thread.run_sync(collect))

    async def topic_delete(request: Request):
        try:
            trash = ws.remove_topic(request.path_params["shelf"])
        except (StudioError, OSError) as e:
            return _json({"error": str(e)}, 409)
        return _json({"trash": str(trash.relative_to(ws.root))})

    async def topic_bib_verify(request: Request):
        from .bibliography import verify_path, update_path
        shelf = request.path_params["shelf"]
        try:
            check_name(shelf)
            base = ws.topic_dir(shelf).resolve()
            path = (base / "reference.bib").resolve()
            if not base.is_relative_to(ws.topics.resolve()) or not base.is_dir() or not path.is_relative_to(base):
                raise StudioError("トピックがありません")
            body = await request.json()
            key = str(body.get("key") or "")
            if request.method == "PATCH":
                await anyio.to_thread.run_sync(update_path, path, key, body.get("fields"), body.get("original"))
            else:
                await anyio.to_thread.run_sync(verify_path, path, key)
            name = path.relative_to(ws.root).as_posix()
            for d in ws.list_decks():
                if ws.deck_shelf(d) == shelf:
                    for h in srv.hooks:
                        getattr(h, "user_wrote", lambda d, n: None)(d, name)
            return _json({"ok": True})
        except (KeyError, ValueError, OSError, StudioError) as exc:
            return _json({"error": str(exc)}, 400)

    async def topic_html_delete(request: Request):
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise StudioError("htmlMissing")
            items = await anyio.to_thread.run_sync(library.delete_topic_html, ws, request.path_params["shelf"], body.get("paths"))
            return _json({"items": items})
        except (StudioError, OSError, ValueError) as exc:
            return _json({"error": str(exc)}, 409)

    async def topic_get(request: Request):
        try:
            return _json(await anyio.to_thread.run_sync(library.topic_listing, ws, request.path_params["shelf"]))
        except (StudioError, OSError) as e:
            return _json({"error": str(e)}, 404)

    async def deck_get(request: Request):
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return _json({"error": f"発表がありません: {deck}"}, 404)
        text = ws.qmd(deck).read_text()
        # 以前の版がブロックごとに書いた装飾の色を、種類だけ（色はテーマ）に直す
        if (migrated := block_design.migrate(text)) != text:
            write_atomic(ws.qmd(deck), migrated)
            text = migrated
        doc = source.parse(text)
        st = srv.state(deck)
        if not st.html or st.version != sha256_text(text):
            await srv.render(deck)
        ws.touch_recent(deck)
        return _json({"deck": deck, "text": text, "version": sha256_text(text), "structure": doc.to_json(),
                      "render": {"ok": st.error is None, "version": st.version, "error": st.error,
                                 "slides": st.rendered.slides if st.rendered else [],
                                 "warning_issues": warning_issues(st.rendered) if st.rendered else []},
                      "blank": ws.is_blank(deck), "root": str(ws.root)})

    def slide_scope(deck: str) -> dict:
        found = (getattr(h, "slide_scope", lambda d: None)(deck) for h in srv.hooks)
        return next((s for s in found if s), {"all": False, "pages": [], "figures": []})

    async def deck_source(request: Request):
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return _json({"error": f"発表がありません: {deck}"}, 404)
        body = await request.json()
        text, base = body.get("text"), body.get("base")
        if not isinstance(text, str):
            return _json({"error": "原稿がありません"}, 400)
        scope = slide_scope(deck)
        if scope["all"]:
            return _json({"error": "AI の実行中は編集できません"}, 423)
        path = ws.qmd(deck)
        current = path.read_text()
        cur_version = sha256_text(current)
        rebased = base != cur_version
        base_text = body.get("base_text") if rebased else current
        conflict = {"error": "外で変更されました", "version": cur_version, "text": current}
        if not isinstance(base_text, str):
            return _json(conflict, 409)
        if (scope["pages"] or scope["figures"]) and edit_scope.touched(base_text, text, scope):
            return _json({"error": "AI の実行中は編集できません", "partial": True}, 423)
        # AI が別のページを書いている間の保存は、AI の変更と合流する
        final = edit_scope.merge3(base_text, text, current) if rebased else text
        if final is None:
            return _json(conflict, 409)
        from .workspace import set_front
        final = set_front(final, {})
        if final != current:
            write_atomic(path, final)
            for h in srv.hooks:
                getattr(h, "user_saved_qmd", lambda d, a, b: None)(deck, base_text, text)
        version = sha256_text(final)
        asyncio.create_task(srv.render(deck))
        return _json({"version": version, **({"text": final} if rebased else {})})

    async def deck_structure(request: Request):
        body = await request.json()
        return _json(source.parse(body.get("text", "")).to_json())

    async def chunks(request: Request):
        from .edit import cell_markdown, prepared_html, to_markdown
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return _json({"error": "発表がありません"}, 404)
        st = srv.state(deck)
        if not st.rendered:
            await srv.render(deck)
        if not st.rendered:
            return _json({"error": "表示が古い"}, 409)
        rendered, version = st.rendered, st.version
        if request.method == "GET":
            info = await srv.chunk_info(st, rendered)
            return _json({"version": version, "structure": rendered.doc.to_json(), "chunks": info})
        body = await request.json()
        if body.get("action") == "markdown":
            # スライドの見出し・新しいブロックの HTML を原稿の書き方にする
            if not isinstance(body.get("html"), str):
                return _json({"error": "操作が正しくありません"}, 400)
            html, original = body["html"], body.get("original", "")
            if not isinstance(original, str):
                return _json({"error": "操作が正しくありません"}, 400)
            if original:
                html = prepared_html(html, original)
            return _json({"markdown": await anyio.to_thread.run_sync(to_markdown, html, original)})
        if body.get("action") == "cell":
            # 表のセル。編集中に続けて別のセルも直すので、描画の版ではなく渡された原稿に対して書き換える
            try:
                if not isinstance(body.get("text"), str) or not isinstance(body.get("html"), str):
                    raise ValueError("操作が正しくありません")
                md = await anyio.to_thread.run_sync(cell_markdown, body["html"])
                return _json({"text": source.set_cell(source.parse(body["text"]), body["key"], int(body["row"]), int(body["col"]), md)})
            except (ValueError, KeyError, TypeError) as e:
                return _json({"error": str(e)}, 400)
        # この API は変換だけを行う。保存は既存の sha256 付き PUT に一本化する。
        # 基にするのは今の描画か、判定を残している版（スライドで編集中の文字は、編集を始めた版に対して変換し直す）。
        text, base = body.get("text"), body.get("base")
        if base != version:
            rendered = st.chunks[base][0] if isinstance(base, str) and base in st.chunks else None
        if rendered is None or not isinstance(text, str) or text != rendered.doc.text:
            return _json({"error": "表示が古いので、更新を待ってください"}, 409)
        try:
            doc, key, action = rendered.doc, body["key"], body["action"]
            if action == "html":
                info = await srv.chunk_info(st, rendered)
                if not info.get(key, {}).get("direct"):
                    raise ValueError("文字の編集対象が見つかりません")
                chunk = source.locate(doc, key)[1]
                original = doc.text[chunk.start:chunk.end]
                md = await anyio.to_thread.run_sync(to_markdown, body["html"], original)
                result = source.rewrite(doc, {key: md})
            elif action == "delete":
                result = source.rewrite(doc, {key: ""})
            elif action == "move":
                result = source.move_chunk(doc, key, int(body["page"]), body.get("before"))
            elif action == "image":
                width = body.get("width")
                result = source.image_options(doc, key, None if width is None else int(width), body["align"])
            else:
                raise ValueError("操作が正しくありません")
        except (ValueError, KeyError, TypeError) as e:
            return _json({"error": str(e)}, 400)
        return _json({"text": result})

    async def deck_style(request: Request):
        from . import history
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return _json({"error": "発表がありません"}, 404)
        if srv.hooks and any(getattr(h, "locked", lambda d: False)(deck) for h in srv.hooks):
            return _json({"error": "AI の実行中は編集できません"}, 423)
        body = await request.json()
        try:
            result = history.style(ws, deck, body)
        except history.Conflict as e:
            return _json({"error": str(e)}, 409)
        except ValueError as e:
            return _json({"error": str(e)}, 400)
        asyncio.create_task(srv.render(deck, force=True))
        return _json(result)

    # 下書き（memo.py）。下書きのチャットの AI が書いている間は保存しない
    async def deck_memo(request: Request):
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return _json({"error": "発表がありません"}, 404)
        locked = any(getattr(h, "memo_locked", lambda d: False)(deck) for h in srv.hooks)
        if request.method == "GET":
            return _json({**memo.read(ws, deck), "locked": locked, "slides_body": memo.from_slides(ws, deck)})
        if locked:
            return _json({"error": "AI が下書きを書いている間は編集できません"}, 423)
        body = await request.json()
        if not isinstance(body.get("text"), str):
            return _json({"error": "下書きがありません"}, 400)
        try:
            result = memo.write(ws, deck, body["text"], body.get("base"))
            for h in srv.hooks if result["version"] != body.get("base") else []:
                getattr(h, "user_wrote", lambda d, n: None)(deck, memo.rel(deck))
            return _json(result)
        except memo.MemoConflict as e:
            return _json({"error": str(e), **e.current}, 409)

    # 素材（画像・HTML）と挿入の補助
    def topic_decks(deck: str) -> list[str]:
        shelf = ws.deck_shelf(deck)
        return [d for d in ws.list_decks() if ws.deck_shelf(d) == shelf]

    def html_locked(deck: str, path: str) -> bool:
        """全体への指示の実行中か、実行中の指示の対象のページがこの HTML を使っている。"""
        for d in topic_decks(deck):
            scope = slide_scope(d)
            if scope["all"] or (scope["pages"] and edit_scope.mentions(ws.qmd(d).read_text(), scope, path)):
                return True
        return False

    def topic_wrote(deck: str, name: str) -> None:
        """トピックのファイルは同じトピックの発表で共有するので、どの発表の AI の［戻す］でも戻さない。"""
        for h in srv.hooks:
            for d in topic_decks(deck):
                getattr(h, "user_wrote", lambda d, n: None)(d, name)

    def asset_name(deck: str, path: str) -> str:
        return (ws.asset_root(deck) / path).relative_to(ws.root).as_posix()

    async def deck_assets(request: Request):
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return _json({"error": "発表がありません"}, 404)
        if request.method == "GET":
            return _json(await anyio.to_thread.run_sync(assets.listing, ws, deck))
        data = await request.body()
        try:
            out = await anyio.to_thread.run_sync(assets.add, ws, deck, request.query_params.get("name", ""),
                                                 data, request.headers.get("content-type", ""))
        except StudioError as e:
            return _json({"error": str(e)}, 400)
        if not out["reused"]:
            topic_wrote(deck, asset_name(deck, out["path"]))
        return _json(out)

    async def deck_assets_op(request: Request):
        deck, op = request.path_params["deck"], request.path_params["op"]
        if not ws.has_deck(deck):
            return _json({"error": "発表がありません"}, 404)
        body = await request.json()
        if op == "delete" and any(Path(str(p)).parts[:1] == ("html",) and html_locked(deck, str(p)) for p in body.get("paths") or []):
            return _json({"error": "AI の実行中は HTML を消せません"}, 423)
        run = {
            "delete": lambda: {"items": assets.delete(ws, deck, [str(p) for p in body.get("paths") or []])},
            "restore": lambda: {"items": assets.restore(ws, deck, [i for i in body.get("items") or [] if isinstance(i, dict)])},
        }.get(op)
        if run is None:
            return _json({"error": "その操作はありません"}, 404)
        try:
            out = await anyio.to_thread.run_sync(run)
            for item in out["items"]:
                topic_wrote(deck, asset_name(deck, item["path"]))
            return _json(out)
        except (StudioError, OSError) as e:
            return _json({"error": str(e)}, 400)

    # 発表の参考資料（materials.py）
    async def deck_materials(request: Request):
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return _json({"error": "発表がありません"}, 404)
        try:
            if request.method == "GET":
                return _json(await anyio.to_thread.run_sync(materials.listing, ws, deck))
            data = await request.body()
            return _json(await anyio.to_thread.run_sync(materials.add, ws, deck, request.query_params.get("path", ""), data))
        except StudioError as e:
            return _json({"error": str(e)}, 400)

    async def deck_materials_op(request: Request):
        deck, op = request.path_params["deck"], request.path_params["op"]
        if not ws.has_deck(deck):
            return _json({"error": "発表がありません"}, 404)
        body = await request.json()
        path, to = str(body.get("path") or ""), str(body.get("to") or "")
        run = {
            "open": lambda: {"opened": materials.open_in_os(ws, deck, path)},
            "mkdir": lambda: materials.create(ws, deck, path, True),
            "move": lambda: materials.move(ws, deck, path, to),
            "delete": lambda: materials.delete(ws, deck, path),
            "restore": lambda: materials.restore(ws, deck, path, str(body.get("trash") or "")),
        }.get(op)
        if run is None:
            return _json({"error": "その操作はありません"}, 404)
        try:
            return _json(await anyio.to_thread.run_sync(run))
        except (StudioError, OSError) as e:
            return _json({"error": str(e)}, 400)

    # トピック（同じ topic: の発表）の前に使った数式・表・画像・図（library.py）
    async def deck_library(request: Request):
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return _json({"error": "発表がありません"}, 404)
        if request.method == "GET":
            return _json(await anyio.to_thread.run_sync(library.listing, ws, deck))
        if srv.hooks and any(getattr(h, "locked", lambda d: False)(deck) for h in srv.hooks):
            return _json({"error": "AI の実行中は編集できません"}, 423)
        body = await request.json()
        try:
            return _json(await anyio.to_thread.run_sync(library.take, ws, deck, str(body.get("kind") or ""),
                                                        str(body.get("deck") or ""), str(body.get("path") or "")))
        except (StudioError, OSError) as e:
            return _json({"error": str(e)}, 400)

    async def deck_bib(request: Request):
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return _json({"error": "発表がありません"}, 404)
        if request.method in ("POST", "PATCH"):
            from .bibliography import verify, update_path, require_ready
            body = await request.json()
            try:
                if request.method == "PATCH":
                    require_ready(ws, deck)
                    update_path(ws.bib(deck), str(body.get("key") or ""), body.get("fields"), body.get("original"))
                else:
                    verify(ws, deck, str(body.get("key") or ""))
            except (KeyError, ValueError, OSError, StudioError) as exc:
                return _json({"error": str(exc)}, 400)
            topic_wrote(deck, ws.bib(deck).relative_to(ws.root).as_posix())
        try:
            if request.query_params.get("view") == "full":
                from .bibliography import listing
                return _json({"entries": await anyio.to_thread.run_sync(listing, ws.bib(deck))})
            return _json({"entries": await anyio.to_thread.run_sync(assets.bib_entries, ws, deck)})
        except (StudioError, ValueError) as exc:
            return _json({"error": str(exc)}, 409)

    async def math(request: Request):
        body = await request.json()
        try:
            return _json({"html": await anyio.to_thread.run_sync(assets.math_html, str(body.get("tex", "")))})
        except (StudioError, OSError) as e:
            return _json({"error": str(e)}, 400)

    async def preview(request: Request):
        deck = request.path_params["deck"]
        if not ws.has_deck(deck):
            return HTMLResponse("発表がありません", 404)
        st = srv.state(deck)
        if request.query_params.get("edit") == "0":
            # 発表は保存直後でも最新の描画を待ち、失敗時に古い画面を出さない。
            await srv.render(deck)
            if st.error:
                return HTMLResponse("変換できません", 500)
        elif not st.html:
            await srv.render(deck)
        if not st.html:
            return HTMLResponse(f"<pre>{st.error or '変換できません'}</pre>", 500)
        html = st.html
        if request.query_params.get("edit") != "0":
            inject = f'<script>window.__slideStudioDeck={json.dumps(deck)};window.__slideStudioVersion={json.dumps(st.version)};window.__slideStudioNoHash=true;window.__slideStudioFill=true;window.__slideStudioNoOverview=true;</script>'
            inject += '<link rel="stylesheet" href="/web/inject/edit.css"><script type="module" src="/web/inject/edit.js"></script>'
            html = html.replace("</head>", inject + "</head>", 1)
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    async def events(request: Request):
        q: asyncio.Queue = asyncio.Queue()
        srv.queues.add(q)

        async def stream():
            try:
                with lifeline.held(lambda: q.put_nowait(None)):
                    yield "retry: 1000\n\n"
                    while True:
                        try:
                            ev = await asyncio.wait_for(q.get(), timeout=15)
                            if ev is None:
                                break
                            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                        except asyncio.TimeoutError:
                            yield ": ping\n\n"
                        if await request.is_disconnected():
                            break
            finally:
                srv.queues.discard(q)
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    async def new_deck(request: Request):
        body = await request.json()
        try:
            ws.new_deck(body.get("name", ""), body.get("shelf", ""), body.get("theme") or "default",
                        body.get("from") or None, title=body.get("title") or None)
        except StudioError as e:
            return _json({"error": str(e)}, 400)
        return _json({"deck": body["name"]})

    async def new_topic(request: Request):
        body = await request.json()
        try:
            ws.new_topic(body.get("name", ""))
        except StudioError as e:
            return _json({"error": str(e)}, 400)
        return _json({"topic": body["name"]})

    class NoCacheFiles(StaticFiles):
        async def get_response(self, path, scope):
            resp = await super().get_response(path, scope)
            resp.headers["Cache-Control"] = "no-store"
            return resp

    class SameOrigin(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                origin = request.headers.get("origin")
                if origin and origin != f"http://{request.headers.get('host')}":
                    return _json({"error": "同じ画面から接続してください"}, 403)
            return await call_next(request)

    async def open_external(request: Request):
        # ブラウザーを開く操作は、このアプリからの JSON POST に限る。
        if request.headers.get("origin") != str(request.base_url).rstrip("/"):
            return _json({"error": "invalid origin"}, 403)
        try:
            body = await request.json()
            url = body.get("url") if isinstance(body, dict) else None
            parsed = urlsplit(url) if isinstance(url, str) else None
            if not parsed or parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ValueError
            if any(ord(c) < 32 for c in url):
                raise ValueError
        except (ValueError, TypeError):
            return _json({"error": "invalid URL"}, 400)
        try:
            opened = await anyio.to_thread.run_sync(webbrowser.open_new_tab, url)
        except (OSError, webbrowser.Error):
            opened = False
        return _json({"ok": bool(opened)}, 200 if opened else 503)

    routes = [
        Route("/api/open-external", open_external, methods=["POST"]),
        Route("/topic/{shelf}", page),
        Route("/api/topic/{shelf}", topic_get),
        Route("/api/topic/{shelf}/html/delete", topic_html_delete, methods=["POST"]),
        Route("/api/topic/{shelf}", topic_delete, methods=["DELETE"]),
        Route("/", page), Route("/agents", page), Route("/deck/{deck}", page), Route("/figure/{rest:path}", page),
        Route("/api/env", env), Route("/api/home", home),
        Route("/api/setup", setup, methods=["POST"]),
        Route("/api/deck/{deck}/download/{kind}", download),
        Route("/api/deck/{deck}", deck_get), Route("/api/deck/{deck}/source", deck_source, methods=["PUT"]),
        Route("/api/deck/{deck}/chunks", chunks, methods=["GET", "POST"]),
        Route("/api/deck/{deck}/style", deck_style, methods=["PUT"]),
        Route("/api/deck/{deck}/memo", deck_memo, methods=["GET", "PUT"]),
        Route("/api/deck/{deck}/assets", deck_assets, methods=["GET", "POST"]),
        Route("/api/deck/{deck}/assets/{op}", deck_assets_op, methods=["POST"]),
        Route("/api/deck/{deck}/materials", deck_materials, methods=["GET", "POST"]),
        Route("/api/deck/{deck}/materials/{op}", deck_materials_op, methods=["POST"]),
        Route("/api/deck/{deck}/library", deck_library, methods=["GET", "POST"]),
        Route("/api/topic/{shelf}/bib/verify", topic_bib_verify, methods=["POST"]),
        Route("/api/topic/{shelf}/bib", topic_bib_verify, methods=["PATCH"]),
        Route("/api/deck/{deck}/bib", deck_bib, methods=["GET", "POST", "PATCH"]),
        Route("/api/math", math, methods=["POST"]),
        Route("/api/deck/{deck}/{action}", deck_operation, methods=["POST"]),
        Route("/api/structure", deck_structure, methods=["POST"]),
        Route("/api/new", new_deck, methods=["POST"]),
        Route("/api/topics", new_topic, methods=["POST"]),
        Route("/api/events", events),
        Route("/files/decks/{deck}/" + PREVIEW, preview),
        Mount("/web", NoCacheFiles(directory=WEB), name="web"),
        Mount("/files", NoCacheFiles(directory=ws.root), name="files"),
    ]
    @contextlib.asynccontextmanager
    async def lifespan(app):
        from . import pandoc_worker
        await anyio.to_thread.run_sync(pandoc_worker.warmup)
        task = asyncio.create_task(srv.watch())
        for start in srv.starters:
            start()
        try:
            yield
        finally:
            task.cancel()
            await anyio.to_thread.run_sync(pandoc_worker.close)
            for stop in srv.stoppers:
                stop()

    app = Starlette(routes=routes, middleware=[Middleware(SameOrigin)], lifespan=lifespan)
    app.state.studio = srv
    for extend in EXTENSIONS:
        extend(app, srv, routes)
    return app


# 手順 3 以降の機能（チャンクの書き戻し・検査・AI）はここに足す
EXTENSIONS: list = []

from .ai import chat as _chat  # noqa: E402

EXTENSIONS.append(_chat.install)

from . import deck_manage as _deck_manage  # noqa: E402

EXTENSIONS.append(_deck_manage.install)

from . import shots as _shots  # noqa: E402

EXTENSIONS.append(_shots.install)

from . import themes as _themes, theme_shots as _theme_shots  # noqa: E402

EXTENSIONS.extend([_themes.install, _theme_shots.install])

from . import background_check as _background_check  # noqa: E402

EXTENSIONS.append(_background_check.install)


def free_port(start: int) -> int:
    for port in range(start, start + 100):
        with socket.socket() as s:
            # uvicorn と同じく SO_REUSEADDR を付けて確かめる（閉じた直後のポートを使えるように）
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise StudioError(f"空いているポートがありません（{start}〜）")


def open_window(url: str) -> subprocess.Popen | None:
    """本体だけを Chrome の専用ウィンドウで開く。"""
    if sys.platform == "darwin":
        profile = Path.home() / ".config" / "slide-studio" / "chrome"
        for base in (Path("/Applications"), Path.home() / "Applications"):
            chrome = base / "Google Chrome.app/Contents/MacOS/Google Chrome"
            if not chrome.is_file():
                continue
            try:
                return subprocess.Popen(
                    [str(chrome), f"--app={url}", f"--user-data-dir={profile}",
                     "--window-size=1800,900", "--no-first-run", "--no-default-browser-check",
                     "--hide-crash-restore-bubble"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, start_new_session=True,
                )
            except OSError:
                continue
    webbrowser.open_new_tab(url)
    return None


def serve(ws: Workspace | None, open_deck: str | None = None, port: int = 4320, open_browser: bool = True) -> None:
    import uvicorn

    if open_deck and ws:
        ws.require_deck(open_deck)
    port = free_port(port)
    url = f"http://127.0.0.1:{port}/" + (f"deck/{open_deck}" if open_deck else "")
    print(f"Slide Studio: {url}（置き場 {ws.root if ws else '初回画面で選択'}）")
    from .location import build_location_app
    app = build_location_app(open_deck, initial_ws=ws)
    windows: list[subprocess.Popen | None] = []

    class Server(uvicorn.Server):
        async def startup(self, sockets=None) -> None:
            await super().startup(sockets)
            if self.started and not self.should_exit and open_browser:
                # 固定時間を待たず、HTTP の準備ができてから開く。
                # ブラウザの起動中も HTTP・SSE を受け付ける。
                windows.append(await anyio.to_thread.run_sync(open_window, url))

        async def shutdown(self, sockets=None) -> None:
            # 画面の SSE がつながったままでも Ctrl+C ですぐ終わるよう、先に SSE を終わらせる
            lifeline.end_all()
            await super().shutdown(sockets)

    # 終わらない接続があっても1秒で打ち切る
    server = Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                   timeout_graceful_shutdown=1))
    lifeline.arm(None)
    if open_browser:
        def closed() -> None:
            print("窓が閉じたので終了します")
            server.should_exit = True

        lifeline.arm(closed)
    try:
        server.run()
    finally:
        lifeline.arm(None)
        # 終了するのは本体専用のプロセスだけ。リンク先のブラウザーは残す。
        for window in windows:
            if window is not None and window.poll() is None:
                window.terminate()
