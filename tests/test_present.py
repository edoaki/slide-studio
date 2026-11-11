"""発表用 HTML は最新の描画を待ち、編集コードや検査を含めない。"""
import asyncio
import threading
from types import SimpleNamespace

import httpx
from starlette.testclient import TestClient

from conftest import add_deck
from slide_studio.fsutil import sha256_text, write_atomic
from slide_studio.render import RenderError
from slide_studio.server import build_app


def rendered(text):
    return SimpleNamespace(html=f"<html><head></head><body>{text}</body></html>",
                           timing={}, slides=[], warnings=[], unsupported=[], missing_cites=[])


def test_present_refreshes_cached_html_without_edit_scripts(ws, monkeypatch):
    add_deck(ws, "talk", "## A\n\nBefore.\n")
    calls = []

    def render(workspace, deck, text):
        calls.append(text)
        return rendered(text)

    monkeypatch.setattr("slide_studio.server.render_text", render)
    app = build_app(ws)
    client = TestClient(app)
    url = "/files/decks/talk/__slide-studio_preview__.html"
    assert "/web/inject/edit.js" in client.get(url).text
    text = "## A\n\nAfter.\n"
    write_atomic(ws.qmd("talk"), text)
    result = client.get(url + "?edit=0")
    assert result.status_code == 200
    assert result.text == rendered(text).html
    assert result.headers["cache-control"] == "no-store"
    assert app.state.studio.state("talk").version == sha256_text(text)
    assert len(calls) == 2
    assert client.get(url + "?edit=0").text == result.text
    assert len(calls) == 2


def test_present_rejects_stale_html_after_render_failure(ws, monkeypatch):
    add_deck(ws, "talk", "## A\n")
    app = build_app(ws)
    app.state.studio.state("talk").html = rendered("old").html

    def fail(*args):
        raise RenderError("broken")

    monkeypatch.setattr("slide_studio.server.render_text", fail)
    result = TestClient(app).get("/files/decks/talk/__slide-studio_preview__.html?edit=0")
    assert result.status_code == 500
    assert "old" not in result.text


def test_present_waits_for_inflight_render(ws, monkeypatch):
    add_deck(ws, "talk", "## New\n")
    entered, release = threading.Event(), threading.Event()

    def render(workspace, deck, text):
        entered.set()
        assert release.wait(5)
        return rendered(text)

    monkeypatch.setattr("slide_studio.server.render_text", render)

    async def run():
        app = build_app(ws)
        srv = app.state.studio
        srv.state("talk").html = rendered("old").html
        rendering = asyncio.create_task(srv.render("talk"))
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                pending = asyncio.create_task(client.get("/files/decks/talk/__slide-studio_preview__.html?edit=0"))
                await asyncio.sleep(.02)
                assert not pending.done()
                release.set()
                result = await pending
                assert result.status_code == 200
                assert "## New" in result.text and "old" not in result.text
        finally:
            release.set()
            await rendering

    asyncio.run(run())
