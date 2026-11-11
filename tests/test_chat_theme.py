"""テーマのチャット：プロンプト、対象固定、検査、復元。サーバーなしでも検証する。"""
import asyncio
import json
from types import SimpleNamespace

import pytest

from conftest import add_deck
from e2e.conftest import DECK
from slide_studio import check, snapshot
from slide_studio.ai.chat import Chat, ConflictError
from slide_studio.fsutil import sha256_text, write_atomic
from test_chat import chat, fake_codex, review_rpcs, state, wait_done  # noqa: F401 （fixture を使う）


@pytest.fixture
def theme_chat(ws):
    add_deck(ws, "talk", DECK)
    add_deck(ws, "other", DECK)
    srv = SimpleNamespace(ws=ws, broadcast=lambda ev: None)
    return ws, Chat(srv)


def test_prompt_theme_and_rules(theme_chat):
    ws, chat = theme_chat
    shot = ws.state / "themes/default/0.png"
    write_atomic(shot, b"image")
    p = chat.prompt_theme("talk", "見出しを丸くして", [{"kind": "image", "path": "images/ref.png"},
                                                    {"kind": "file", "path": "materials/ref.pdf"}])
    assert "SKILL.md" not in p
    assert "[テーマ] themes/default.css（変えてよいのはこのファイルだけ）" in p
    assert "other、talk" in p and "他の発表も変わります" in p
    assert ".slide-studio/themes/default/0.png" in p
    assert "topics/test/images/ref.png" in p and "decks/talk/materials/ref.pdf" in p
    assert "[依頼] 見出しを丸くして" in p and "[対象]" not in p
    assert (ws.root / ".agents/skills/slide-studio-theme/SKILL.md").is_file()
    assert "slide-studio-theme" in (ws.root / "AGENTS.md").read_text()


@pytest.mark.parametrize("change", ["modified", "deleted"])
def test_restore_only_sent_theme(theme_chat, change):
    ws, chat = theme_chat
    css = ws.themes / "default.css"
    original = css.read_text()
    snap = snapshot.take(ws, "talk")
    if change == "deleted":
        css.unlink()
    else:
        write_atomic(css, original + "/* edit */")
    qmd = ws.qmd("talk")
    write_atomic(qmd, qmd.read_text().replace("theme: default", "theme: night"))
    write_atomic(ws.memo("talk"), "並行した下書き")
    write_atomic(ws.deck_dir("talk") / "styles/slides.css", "/* deck */")
    write_atomic(ws.themes / "night.css", "/* another theme */")
    snapshot.finish(ws, snap)
    r = {"id": "r", "mode": "theme", "theme": "default", "state": "done", "snapshot": snap.path.name}
    chat.state("talk")["rounds"].append(r)
    asyncio.run(chat.restore("talk", "r"))
    assert r["restored"]["files"] == ["themes/default.css"]
    assert css.read_text() == original
    assert ws.deck_theme("talk") == "night"
    assert ws.memo("talk").read_text() == "並行した下書き"
    assert (ws.themes / "night.css").read_text() == "/* another theme */"
    assert (ws.deck_dir("talk") / "styles/slides.css").read_text() == "/* deck */"


def test_theme_check_only(theme_chat):
    ws, chat = theme_chat
    write_atomic(ws.qmd("talk"), "invalid slides")
    assert check.check_theme(ws, "default")["errors"] == []
    write_atomic(ws.themes / "default.css", ":root { --ink: black; }")
    result = check.check_theme(ws, "default")
    assert result["errors"] and all(e["kind"] == "theme" for e in result["errors"])
    assert chat.check_view(result)["kind"] == "theme"
    (ws.themes / "default.css").unlink()
    assert check.check_theme(ws, "default")["errors"][0]["kind"] == "theme"


@pytest.mark.parametrize("outcome", ["done", "fail", "error", "cancelled"])
def test_theme_run_and_send_rules(theme_chat, monkeypatch, outcome):
    ws, chat = theme_chat
    from slide_studio.ai import workflow
    from slide_studio.ai.providers import PROVIDERS, Provider
    calls = []
    provider = SimpleNamespace(id="fake", images_flag=True, env=lambda root: {}, parser=lambda root: None,
                               command=lambda *args, **kw: calls.append((args, kw)) or [], name="fake")
    provider.make_run = lambda *args, **kwargs: Provider.make_run(provider, *args, **kwargs)
    monkeypatch.setitem(PROVIDERS, "codex", provider)
    class Run:
        session = None
        cancelled = False
        returncode = 0
        final = "テーマを**変更しました**"
        def __init__(self, *args, **kwargs):
            calls.append((args, kwargs))
        async def run(self):
            assert chat.theme_locked("default") and not chat.locked("talk")
            if outcome == "fail":
                write_atomic(ws.themes / "default.css", ":root { --ink: black; }")
            else:
                css = ws.themes / "default.css"
                write_atomic(css, css.read_text() + "/* change */")
            write_atomic(ws.qmd("talk"), DECK + "並行した編集")
            if outcome == "error":
                raise RuntimeError("failed")
            if outcome == "cancelled":
                self.cancelled = True
    # テーマの担当は AI 本体の道具で動く（native.make_run）。web 検索は使わない
    monkeypatch.setattr(workflow.native, "make_run", lambda provider, ws_, prompt, session, model_id, effort, images, schema, web, **cb: Run(prompt, schema, web))
    async def no_review(self, files, prompt):
        return None
    monkeypatch.setattr(workflow.Workflow, 'review', no_review)
    # スライド全体の検査に入ったら失敗させる。
    monkeypatch.setattr(chat, "run_check", lambda *args: pytest.fail("slide check"))
    chat.status = {"providers": [{"id": "codex", "name": "fake", "ok": True, "default": "fake",
        "models": [{"id": "fake", "name": "fake", "efforts": [], "effort": None}]}]}
    monkeypatch.setattr(chat, "ai_status", lambda: {**chat.status, "default": "codex:fake"})
    tab = next(t for t in chat.state("talk")["tabs"] if t["mode"] == "theme")
    base = sha256_text((ws.themes / "default.css").read_text())
    async def run():
        with pytest.raises(ConflictError):
            chat.send("talk", tab["id"], "stale", [{"key": "theme", "text": "change"}])
        r = chat.send("talk", tab["id"], base, [{"key": "theme", "text": "change"}])
        assert chat.theme_locked("default") and not chat.locked("talk")
        await asyncio.gather(*chat.tasks)
        return r
    r = asyncio.run(run())
    assert r["state"] == outcome and r["check"]["kind"] == "theme"
    assert r["results"] == []
    if outcome == "fail":
        assert r["summary"].startswith(Run.final)
        assert f"最終の機械検査：エラー {len(r['check']['errors'])} 件" in r["summary"]
    else:
        assert r["summary"] == Run.final
    prompt, schema, web = calls[0][0]
    assert schema is workflow.roles.REPLY_SCHEMA and not web  # 返事の文と確認だけの形
    assert "skill：slide-studio-theme" in prompt
    assert r["files"]["modified"] == ["themes/default.css"]
    assert r["stray"] == ["decks/talk/slides.qmd"]
    assert not chat.theme_locked("default")


def test_theme_css_change_runs_review(chat, monkeypatch):
    ws, srv, client = chat
    # 見本の撮影とは分け、CSS の変更による確認役の起動と依頼文を検証する。
    monkeypatch.setattr(Chat, "theme_review_images", lambda self, theme: [])
    tab = next(t for t in state(client)["tabs"] if t["mode"] == "theme")
    css = ws.themes / "default.css"
    original = css.read_text()
    response = client.post(f"/api/deck/talk/chat/tabs/{tab['id']}/send", json={
        "base": sha256_text(original), "items": [{"key": "theme", "label": "テーマ",
            "text": "replace --ink: => /* 確認する変更 */ --ink:"}],
    })
    response.raise_for_status()
    done = wait_done(client, response.json()["id"])
    assert done["state"] == "done" and done["review_ok"] is True, done
    assert css.read_text() != original
    assert done["check"]["kind"] == "theme" and done["check"]["errors"] == []
    assert done["files"]["modified"] == ["themes/default.css"]
    assert [a["role"] for a in done["agents"]] == ["theme", "review"]
    checks = review_rpcs(ws)
    assert len(checks) == 1
    prompt = checks[0]["turn"]["input"][0]["text"]
    assert "[テーマ] themes/default.css" in prompt
    assert "[利用者の指示]" in prompt and "確認する変更" in prompt
    assert "[変わったファイル]\n- themes/default.css" in prompt


def test_reply_with_questions_is_shown_without_raw_json():
    from slide_studio.ai.chat import Chat
    raw = json.dumps({"summary": "どちらにしますか", "questions": [
        {"item": 1, "text": "色は？", "multiple": False, "options": [{"label": "青", "description": ""}, {"label": "緑", "description": ""}]}]}, ensure_ascii=False)
    r = {"items": [{"key": "theme"}], "steps": [{"kind": "message", "text": raw}, {"kind": "command", "text": "ls"}]}
    reply = Chat._summary_final(raw)
    Chat._plain_reply(r, raw, reply["summary"], reply)
    assert r["summary"] == "どちらにしますか" and [o["label"] for o in r["questions"][0]["options"]] == ["青", "緑"]
    assert r["steps"] == [{"kind": "command", "text": "ls"}]
    assert Chat._summary_final("ただの文章") is None


def test_shared_theme_controls_lock(theme_chat):
    from starlette.applications import Starlette
    from starlette.testclient import TestClient
    from slide_studio import themes
    ws, chat = theme_chat
    chat.state("other")["rounds"].append({"id": "r", "mode": "theme", "theme": "default", "state": "run"})
    routes = []
    app = Starlette()
    themes.install(app, SimpleNamespace(ws=ws, hooks=[chat]), routes)
    client = TestClient(app)
    detail = client.get("/api/themes/default").json()
    assert detail["locked"] and not chat.locked("talk")
    assert client.put("/api/themes/default", json={"base": detail["version"], "vars": {"--ink": "#123456"}}).status_code == 423
    night = client.get("/api/themes/night").json()
    assert not night["locked"]
    chat.state("other")["rounds"][0]["state"] = "done"
    assert not client.get("/api/themes/default").json()["locked"]
    assert client.put("/api/themes/default", json={"base": detail["version"], "vars": {"--ink": "#123456"}}).status_code == 200
