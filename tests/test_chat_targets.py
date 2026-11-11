"""チャットの対象：id のないページの照合・図の step・表示上のページ番号。"""
import json
from types import SimpleNamespace

import pytest

from conftest import add_deck
from test_chat import chat, fake_codex, send, state, wait_done
from slide_studio import figures, source
from slide_studio.ai.context import Context
from slide_studio.fsutil import write_atomic
from slide_studio.server import StudioServer


def test_anonymous_draft_roundtrip_and_retarget(chat):
    ws, srv, client = chat
    original = ws.qmd("talk").read_text().replace("## 一枚目 {#one}", "## 一枚目")
    write_atomic(ws.qmd("talk"), original)
    tab = state(client)["tabs"][0]["id"]
    url = f"/api/deck/talk/chat/tabs/{tab}"
    draft = {"text": "noop", "page_title": "一枚目"}
    drafts = {"@2": draft, "two": "古い形式", "deck": ""}
    assert client.patch(url, json={"drafts": drafts}).status_code == 200
    assert state(client)["tabs"][0]["drafts"] == {"@2": draft, "two": "古い形式"}
    saved = json.loads((ws.state / "chat/talk.json").read_text())
    assert saved["tabs"][0]["drafts"]["@2"] == draft
    # 上にページを足すと、元の番号には別の見出しが入る。
    changed = original.replace("## 一枚目", "## 追加\n\n本文。\n\n## 一枚目")
    write_atomic(ws.qmd("talk"), changed)
    for item in ({"key": "@2", **draft}, {"key": "@3", "text": "noop"}, {"key": "@99", **draft}):
        response = send(client, ws, [item])
        assert response.status_code == 400 and "対象を選び直して" in response.json()["error"]
    assert not state(client)["rounds"]
    assert state(client)["tabs"][0]["drafts"]["@2"] == draft
    assert ws.qmd("talk").read_text() == changed
    # 明示的に選び直した番号と見出しなら送れる。ラベルはサーバーが確定する。
    response = send(client, ws, [{"key": "@3", "label": "p999 古いラベル", **draft}, {"key": "two", "label": "p999", "text": "noop"}])
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["items"][0]["label"] == "p4 一枚目"
    assert result["items"][1]["label"] == "p5 二枚目"
    wait_done(client, result["id"])


@pytest.mark.parametrize("value", [{"text": "x"}, {"text": 3, "page_title": "見出し"}, {"text": "x", "page_title": None}])
def test_invalid_draft_metadata(chat, value):
    ws, srv, client = chat
    tab = state(client)["tabs"][0]["id"]
    response = client.patch(f"/api/deck/talk/chat/tabs/{tab}", json={"drafts": {"@2": value}})
    assert response.status_code == 400


def test_figure_step_frozen_in_round_and_prompt(chat):
    ws, srv, client = chat
    folder = figures.new_figure(ws, "box", ws.shelf_dir("test"))
    write_atomic(folder / "figure.mjs", "export default {steps: ['開始', '途中', '経路を完成', '終了'], renderStep() { return '<svg/>'; }}")
    for step in (-1, 4, True, "2", {"index": 2}):
        response = send(client, ws, [{"key": "fig:test/box", "text": "noop", "step": step}])
        assert response.status_code == 400
    response = send(client, ws, [{"key": "fig:test/box", "text": "noop", "step": 2}])
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["items"][0]["step"] == {"index": 2, "count": 4, "title": "経路を完成"}
    assert result["items"][0]["label"] == "図 box · step 3/4「経路を完成」"
    wait_done(client, result["id"])
    prompt = json.loads((ws.state / "fake-codex/0.json").read_text())["prompt"]
    assert "[対象] 図 topics/test/html/box（トピック test）step 3/4「経路を完成」" in prompt
    assert "上記の step だけを変更する。他の step の表示・動作は維持する。" in prompt


def test_prompt_uses_rendered_numbers_and_builds_missing_or_stale(ws, monkeypatch):
    from slide_studio.ai import context

    text = '---\ntopic: test\n---\n\n## 最初 {#one}\n\n本文。\n\n## 次 {#two}\n\n{{< fig test/box >}}\n'
    add_deck(ws, "talk", text)
    figures.new_figure(ws, "box", ws.shelf_dir("test"))
    ctx = Context()
    ctx.ws, ctx.srv = ws, StudioServer(ws)
    built = SimpleNamespace(doc=source.parse(text), slides=[{"page": 0, "index": 0}, {"page": 1, "index": 3}])
    calls = []
    monkeypatch.setattr(context, "render_text", lambda *args: calls.append(args) or built)
    items = [{"key": "two", "label": "p999 古いラベル", "text": "直して"}, {"key": "fig:test/box", "text": "直して"}]
    for cached in (None, SimpleNamespace(doc=source.parse("## 古い原稿\n")), built):
        ctx.srv.state("talk").rendered = cached
        prompt = ctx.prompt("talk", items)
        assert '[対象] ページ p4（id: two）「次」' in prompt
        assert '[使っているページ] p4（id: two）「次」' in prompt
        assert "p999" not in prompt
    assert len(calls) == 2


def test_figure_step_without_readable_names(chat):
    """steps を変数で書いた図でも、step の番号だけで送れる。"""
    ws, srv, client = chat
    folder = figures.new_figure(ws, "dyn", ws.shelf_dir("test"))
    write_atomic(folder / "figure.mjs", "const NAMES = ['a', 'b'];\nexport default {steps: NAMES, renderStep() { return '<svg/>'; }}")
    result = send(client, ws, [{"key": "fig:test/dyn", "text": "noop", "step": 1}]).json()
    assert result["items"][0]["step"] == {"index": 1, "count": None, "title": ""}
    assert result["items"][0]["label"] == "図 dyn · step 2"
    wait_done(client, result["id"])
