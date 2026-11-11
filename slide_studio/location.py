"""保管フォルダの作成・選択・切り替え。開いたアプリの寿命は外側で管理する。"""
import asyncio
import uuid
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path

import anyio
from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import lifeline
from .workspace import StudioError, Workspace, remember_root, recent_roots


def build_location_app(open_deck=None, initial_ws=None):
    from .server import WEB, build_app

    selected = None
    current_path = None
    opened = {}
    lock = asyncio.Lock()
    stack = AsyncExitStack()

    @asynccontextmanager
    async def lifespan(app):
        nonlocal selected, current_path
        async with stack:
            if initial_ws is not None:
                selected = await activate(initial_ws)
                current_path = initial_ws.root
            yield

    async def activate(ws):
        if ws.root not in opened:
            app = build_app(ws)
            app.state.location_token = uuid.uuid4().hex
            await stack.enter_async_context(app.router.lifespan_context(app))
            opened[ws.root] = app
        return opened[ws.root]

    async def state(request):
        return JSONResponse({"current": str(current_path) if current_path else None,
                             "recent": recent_roots()})

    async def page(request):
        return FileResponse(WEB / "location.html", headers={"Cache-Control": "no-store"})

    async def events(request):
        # 知らせることはないが、窓が開いていることを lifeline に伝える
        async def stream():
            end = asyncio.Event()
            with lifeline.held(end.set):
                yield "retry: 1000\n\n"
                while not await request.is_disconnected():
                    try:
                        await asyncio.wait_for(end.wait(), timeout=15)
                        break
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    async def folders(request):
        try:
            path = Path(request.query_params.get("path") or Path.home()).expanduser().resolve()
            dirs = sorted(p.name for p in path.iterdir() if p.is_dir() and not p.name.startswith("."))
            return JSONResponse({"path": str(path), "parent": str(path.parent), "folders": dirs,
                                 "suggested": str(Path.home() / "Slides")})
        except (OSError, ValueError) as e:
            return JSONResponse({"error": str(e)}, status_code=400)

    async def choose(request):
        nonlocal selected, current_path
        origin = request.headers.get("origin")
        if origin and origin != f"http://{request.headers.get('host')}":
            return JSONResponse({"error": "同じ画面から接続してください"}, status_code=403)
        async with lock:
            try:
                body = await request.json()
                if not isinstance(body, dict):
                    raise ValueError("保管場所を指定してください")
                raw = body.get("path")
                if not isinstance(raw, str) or not raw.strip() or not Path(raw).expanduser().is_absolute():
                    raise ValueError("保管場所を絶対パスで指定してください")
                path = Path(raw).expanduser().resolve()
                mode = body.get("mode")
                if mode == "new":
                    if path.exists():
                        raise ValueError("同じ名前のフォルダがあります。既存フォルダを選ぶか、名前を変えてください")
                elif mode == "existing":
                    if not path.is_dir():
                        raise ValueError("既存のフォルダを選んでください")
                    if any(path.iterdir()) and not ((path / "decks").is_dir() and ((path / "topics").is_dir() or (path / "figures").is_dir())):
                        raise ValueError("空のフォルダか、スライドの保管フォルダ（decks・topics がある場所）を選んでください")
                else:
                    raise ValueError("新規作成か既存フォルダを選んでください")
                ws = Workspace(path)
                if open_deck and selected is None:
                    ws.require_deck(open_deck)
                if path not in opened:
                    await anyio.to_thread.run_sync(ws.ensure)
                app = await activate(ws)
                remember_root(path, previous=current_path)
                first = selected is None
                selected = app
                current_path = path
            except (OSError, ValueError, StudioError) as e:
                return JSONResponse({"error": str(e)}, status_code=400)
        return JSONResponse({"ok": True, "url": f"/deck/{open_deck}" if open_deck and first else "/"})

    setup = Starlette(routes=[Route("/", page), Route("/location", page), Route("/api/location", state), Route("/deck/{deck}", page),
                             Route("/api/events", events),
                             Route("/api/location/folders", folders),
                             Route("/api/location", choose, methods=["POST"]),
                             Mount("/web", StaticFiles(directory=WEB))], lifespan=lifespan)

    async def dispatch(scope, receive, send):
        # lifespan は選択前後とも外側で管理する。
        path = scope.get("path", "")
        if scope["type"] == "lifespan" or selected is None or path == "/location" or path.startswith("/api/location"):
            await setup(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        token = headers.get(b"x-slide-studio-location")
        if path.startswith("/api/") and token and token != selected.state.location_token.encode():
            await JSONResponse({"error": "保管場所が切り替わりました。この画面を再読み込みしてください。"}, status_code=409)(scope, receive, send)
            return
        await selected(scope, receive, send)

    return dispatch
