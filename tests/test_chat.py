"""手順 6：チャットからの送信・Codex の実行・検査・戻す（テスト用の codex を使う）。"""
import asyncio
import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from conftest import FIXTURES, add_deck
from e2e.conftest import DECK, ServerThread
from slide_studio.fsutil import sha256_text, write_atomic
from slide_studio.workspace import StudioError


@pytest.fixture
def fake_codex(tmp_path, monkeypatch):
    exe = tmp_path / "codex"
    exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FIXTURES / "fake_codex.py"}" "$@"\n')
    exe.chmod(0o755)
    monkeypatch.setenv("SLIDE_STUDIO_CODEX", str(exe))
    return exe


@pytest.fixture
def chat(ws, fake_codex):
    add_deck(ws, "talk", DECK)
    srv = ServerThread(ws)
    client = httpx.Client(base_url=srv.url, timeout=60)
    yield ws, srv, client
    client.close()
    srv.stop()


def state(client) -> dict:
    r = client.get("/api/deck/talk/chat")
    r.raise_for_status()
    return r.json()


def send(client, ws, items, tab=None, talk=False):
    tab = tab or state(client)["tabs"][0]["id"]
    base = sha256_text(ws.qmd("talk").read_text())
    return client.post(f"/api/deck/talk/chat/tabs/{tab}/send", json={"base": base, "items": items, **({"talk": True} if talk else {})})


def wait_done(client, rid, timeout=90) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = next(r for r in state(client)["rounds"] if r["id"] == rid)
        if r["state"] not in ("run", "check", "review"):
            return r
        time.sleep(0.2)
    raise AssertionError("送信が終わりません")


def wait_state(client, rid, want, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = next(r for r in state(client)["rounds"] if r["id"] == rid)
        if r["state"] == want and (want != "run" or r["steps"]):
            return r
        time.sleep(0.1)
    raise AssertionError(f"{want} になりません")


def ai_status(client, refresh=False) -> dict:
    r = client.get("/api/ai/status", params={"refresh": 1} if refresh else {})
    r.raise_for_status()
    return r.json()


def provider(st, pid) -> dict:
    return next(p for p in st["providers"] if p["id"] == pid)


def codex_rpcs(ws):
    return [json.loads(json.loads(p.read_text())["prompt"])
            for p in sorted((ws.state / "fake-app-server").glob("*.json"), key=lambda p: int(p.stem))]


def review_rpcs(ws):
    return [rpc for rpc in codex_rpcs(ws) if "issues" in (rpc["turn"].get("outputSchema") or {}).get("properties", {})]



def test_rate_limits_are_kept_per_provider(chat):
    """5時間・1週間の上限は AI の検出で読み、実行中の知らせを重ねて覚える（次に起動したときにも出す）。"""
    ws, srv, client = chat
    codex = ai_status(client, refresh=True)["limits"]["codex"]
    assert codex["five_hour"] == {"used": 12, "resets": 4102444800} and codex["weekly"]["used"] == 40
    assert "limits" not in provider(ai_status(client), "codex")
    # 実行中の知らせ（fake_codex は5時間の分だけ送る）
    wait_done(client, send(client, ws, [{"key": "one", "label": "p4", "text": "replace 最初の段落。 => 変えた。"}]).json()["id"])
    saved = ws.prefs()["ai_limits"]["codex"]
    assert saved["five_hour"]["used"] == 30 and saved["weekly"]["used"] == 40
    assert ai_status(client)["limits"]["codex"]["five_hour"]["used"] == 30

def test_send_runs_codex_checks_and_resumes(chat):
    ws, srv, client = chat
    st = state(client)
    # スライドのチャットと下書きのチャットに1つずつ（設計書 §8.8）
    assert provider(ai_status(client), "codex")["ok"] and [t["mode"] for t in st["tabs"]] == ["slides", "memo", "theme"]
    tab = st["tabs"][0]["id"]
    # 未送信の指示はタブ・ページごとに残る
    client.patch(f"/api/deck/talk/chat/tabs/{tab}", json={"drafts": {"one": "最初の段落を直して", "deck": ""}}).raise_for_status()
    assert state(client)["tabs"][0]["drafts"] == {"one": "最初の段落を直して"}
    r = send(client, ws, [
        {"key": "one", "label": "p4 一枚目", "text": "replace 最初の段落。 => 書き換えた段落。"},
        {"key": "deck", "label": "発表全体", "text": "fail"},
    ]).json()
    assert state(client)["tabs"][0]["drafts"] == {}
    done = wait_done(client, r["id"])
    assert done["state"] == "done", done
    assert "書き換えた段落。" in ws.qmd("talk").read_text()
    assert done["files"]["modified"] == ["decks/talk/slides.qmd"]
    assert [x["ok"] for x in done["results"]] == [True, False]
    assert done["check"]["errors"] == []
    assert any(s["kind"] == "command" and s["text"].startswith("replace") for s in done["steps"])
    # プロンプト：対象のページの原文・必須・報告（設計書 §8.3）
    log = json.loads((ws.state / "fake-codex" / "0.json").read_text())
    p = log["prompt"]
    assert "[対象] ページ p3（id: one）「一枚目」" in p and "## 一枚目 {#one}" in p and "[対象] 発表全体" in p
    assert 'SKILL.md' not in p and 'AGENTS.md' not in p and "skill：slide-studio-slides" in p
    # 編集担当は置き場で、AI 本体の道具で動く（システムプロンプト・配布ツールを渡さない。設計書 §8.1.2）
    server = json.loads((ws.state / 'fake-app-server' / '0.json').read_text())
    rpc = json.loads(server['prompt'])
    assert rpc['thread']['cwd'] == str(ws.root) and 'developerInstructions' not in rpc['thread']
    assert 'dynamicTools' not in rpc['thread'] and 'sandbox' not in rpc['thread']
    # 置き場に書け、控えとチャットの記録は読むだけ（権限のプロファイル）
    args = server['argv']
    assert 'default_permissions="slide-studio"' in args and 'web_search="live"' in args
    fs = next(a for a in args if a.startswith('permissions.slide-studio.filesystem='))
    assert f'"{ws.state / "snapshots"}" = "read"' in fs and f'"{ws.state / "chat"}" = "read"' in fs
    assert [a['role'] for a in done['agents']] == ['chat', 'review'] and done['review_ok']
    # 作業中の slide-studio check は起動中のアプリに頼む（bridge）
    assert log["env_home"] == str(ws.root) and log["sandbox"] == "1"
    assert "resume" not in log["argv"] and "--output-schema" in log["argv"]
    # 同じタブの2回目は session を継続し、タブ名は最初の指示から付く
    st = state(client)
    session = st["tabs"][0]["session"]
    assert session and st["tabs"][0]["name"].startswith("replace")
    r2 = send(client, ws, [{"key": "two", "label": "p5 二枚目", "text": "replace 左の列。 => 左。"}]).json()
    wait_done(client, r2["id"])
    log2 = json.loads((ws.state / "fake-codex" / "1.json").read_text())
    assert log2["argv"][log2["argv"].index("resume") + 1] == session


def test_check_error_fixed_in_same_session(chat):
    ws, srv, client = chat
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": (
        "replace ## 一枚目 {#one} => ## 一枚目; "
        "fixwith ## 一枚目 => ## 直した一枚目 {#one}; "
        "fixwith 最初の段落。 => まだ実行しない。"
    )}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "done", done
    assert done["check"]["errors"] == []
    assert len(done["fixes"]) == 1
    fix = done["fixes"][0]
    assert fix["errors"] >= 1 and fix["limit"] == 3 and fix["summary"]
    assert done["files"]["modified"] == ["decks/talk/slides.qmd"]
    assert "## 直した一枚目 {#one}" in ws.qmd("talk").read_text()
    # 修正は先頭の1件だけ。残りの命令は次の検査エラーまで残す。
    assert (ws.state / "fake-fix").read_text() == "replace 最初の段落。 => まだ実行しない。\n"
    assert "最初の段落。" in ws.qmd("talk").read_text()
    logs = ws.state / "fake-codex"
    assert len(list(logs.glob("*.json"))) == 2
    first = json.loads((logs / "0.json").read_text())
    retry = json.loads((logs / "1.json").read_text())
    assert "resume" not in first["argv"]
    session = state(client)["tabs"][0]["session"]
    assert session and retry["argv"][retry["argv"].index("resume") + 1] == session
    assert [a["session"] for a in done["agents"] if a["parent"]] == [session, session]
    # 起動したままの app-server の同じ thread に turn/start を送る（起動し直さない。作業手順書 A6）
    servers = [json.loads((ws.state / f"fake-app-server/{i}.json").read_text()) for i in (0, 1)]
    assert json.loads(servers[1]["prompt"])["turn"]["threadId"] == session
    assert servers[0]["pid"] == servers[1]["pid"]
    prompt = retry["prompt"]
    assert "[発表] decks/talk/slides.qmd" in prompt
    assert "[検査のエラー]" in prompt
    assert "p3「一枚目」 にページ ID {#id} がありません" in prompt
    assert "[指示]" not in prompt and "[依頼]" not in prompt


def test_review_issue_fixed_in_same_session(chat):
    ws, srv, client = chat
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": (
        "replace 最初の段落。 => 確認前の段落。; reviewng; "
        "fixwith 確認前の段落。 => 直した段落。; "
        "fixwith 二番目の段落。 => まだ実行しない。"
    )}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "done", done
    assert done["review_ok"] is True and done["check"]["errors"] == []
    assert len(done["review_fixes"]) == 1
    fix = done["review_fixes"][0]
    assert fix["issues"] == 1 and fix["limit"] == 3 and fix["summary"]
    assert "直した段落。" in ws.qmd("talk").read_text()
    assert "二番目の段落。" in ws.qmd("talk").read_text()
    assert (ws.state / "fake-fix").read_text() == "replace 二番目の段落。 => まだ実行しない。\n"
    assert not (ws.state / "fake-reviewng").exists()
    editors = [a for a in done["agents"] if a["parent"]]
    reviews = [a for a in done["agents"] if a["role"] == "review"]
    assert len(editors) == 2 and editors[0]["session"] == editors[1]["session"]
    assert [a["state"] for a in reviews] == ["needs_fix", "complete"]
    rpc = codex_rpcs(ws)
    assert len(rpc) == 4
    assert rpc[2]["turn"]["threadId"] == editors[0]["session"]
    retry = rpc[2]["turn"]["input"][0]["text"]
    assert "[確認役の指摘]" in retry and "1/3" in retry
    assert "テストの指摘" in retry
    checks = review_rpcs(ws)
    assert len(checks) == 2
    assert checks[1]["turn"]["threadId"] == reviews[0]["session"]
    for check in checks:
        prompt = check["turn"]["input"][0]["text"]
        assert "[利用者の指示]" in prompt and "id: one" in prompt
        assert "[変わったファイル]\n- decks/talk/slides.qmd" in prompt
        images = prompt.split("[変わったページの画像]", 1)[1]
        changed = ws.build_dir("talk") / "shots/p03-s0.png"
        unchanged = ws.build_dir("talk") / "shots/p04-s0.png"
        assert changed.is_file() and unchanged.is_file()
        assert changed.relative_to(ws.root).as_posix() in images
        for shot in changed.parent.glob("*.png"):
            if not shot.name.startswith("p03-"):
                assert shot.relative_to(ws.root).as_posix() not in images


def test_review_issues_stop_after_three_fixes(chat):
    ws, srv, client = chat
    fixes = "; fixwith 確認する段落。 => 一度直した段落。; fixwith 一度直した段落。 => 二度直した段落。; fixwith 二度直した段落。 => 三度直した段落。"
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目",
                           "text": "replace 最初の段落。 => 確認する段落。; reviewng 9" + fixes}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "fail", done
    assert done["review_ok"] is False and done["check"]["errors"] == []
    assert len(done["review_fixes"]) == 3
    assert all(f["issues"] == 1 and f["limit"] == 3 and f["summary"] for f in done["review_fixes"])
    assert len(list((ws.state / "fake-codex").glob("*.json"))) == 4
    assert len(review_rpcs(ws)) == 4
    assert len([a for a in done["agents"] if a["role"] == "review"]) == 4
    assert (ws.state / "fake-reviewng").read_text() == "5"


def test_review_fix_that_changes_nothing_stops(chat):
    """直しで何も変わらなければ（編集担当が直さないと決めた）、同じものをもう一度確認・直しに回さない。"""
    ws, srv, client = chat
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": "replace 最初の段落。 => 確認する段落。; reviewng 9; fixwith 無い段落。 => 直した段落。"}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "fail" and done["review_ok"] is False, done
    assert len(done["review_fixes"]) == 1
    assert len(review_rpcs(ws)) == 1
    assert [a["state"] for a in done["agents"] if a["role"] == "review"] == ["needs_fix"]


def test_review_session_resumes_separately_on_second_send(chat):
    ws, srv, client = chat
    tab = state(client)["tabs"][0]["id"]
    for before, after in [("最初の段落。", "一度目の段落。"), ("一度目の段落。", "二度目の段落。")]:
        r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": f"replace {before} => {after}"}], tab).json()
        done = wait_done(client, r["id"])
        assert done["state"] == "done" and done["review_ok"], done
        if before == "最初の段落。":
            first_review = next(a["session"] for a in done["agents"] if a["role"] == "review")
            first_editor = next(a["session"] for a in done["agents"] if a["parent"])
    assert first_review != first_editor
    checks = review_rpcs(ws)
    assert len(checks) == 2
    assert "threadId" not in checks[0]["thread"]
    assert checks[1]["turn"]["threadId"] == first_review
    assert "前に挙げたところ" in checks[1]["turn"]["input"][0]["text"]
    assert next(a["session"] for a in done["agents"] if a["parent"]) == first_editor


def test_cancel_during_review_fix_stops_further_reviews(chat):
    ws, srv, client = chat
    # A4 と共用のキューに待機を入れ、修正担当が実際に動いている間に止める。
    write_atomic(ws.state / "fake-fix", "sleep 30\n")
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目",
                           "text": "replace 最初の段落。 => 途中の段落。; reviewng 9"}]).json()
    pid_file = ws.state / "fake-child.pid"
    deadline = time.monotonic() + 20
    while not pid_file.exists() and time.monotonic() < deadline:
        time.sleep(.1)
    assert pid_file.exists()
    running = next(x for x in state(client)["rounds"] if x["id"] == r["id"])
    assert running["state"] == "run" and running["fixing"] == "review"
    assert len(review_rpcs(ws)) == 1
    client.post(f"/api/deck/talk/chat/rounds/{r['id']}/cancel").raise_for_status()
    done = wait_done(client, r["id"])
    assert done["state"] == "cancelled", done
    assert len(done["review_fixes"]) == 1
    assert len(review_rpcs(ws)) == 1
    assert (ws.state / "fake-reviewng").read_text() == "8"
    child = int(pid_file.read_text())
    deadline = time.monotonic() + 5
    while _alive(child) and time.monotonic() < deadline:
        time.sleep(.1)
    assert not _alive(child)


def test_saved_html_review_migrates_on_load(ws):
    from slide_studio.ai.chat import Chat
    add_deck(ws, "talk", DECK)
    srv = SimpleNamespace(ws=ws, broadcast=lambda ev: None)
    chat = Chat(srv)
    tab = chat._new_tab({"tabs": []})
    chosen = {"model": "codex:test-small", "effort": "low"}
    tab["ai_roles"] = {"html_review": chosen}
    write_atomic(chat.path("talk"), json.dumps({"tabs": [tab], "rounds": []}))
    loaded = chat.state("talk")["tabs"][0]
    assert loaded["ai_roles"] == {"review": chosen}
    assert json.loads(chat.path("talk").read_text())["tabs"][0]["ai_roles"] == {"review": chosen}
    assert Chat(srv).state("talk")["tabs"][0]["ai_roles"] == {"review": chosen}


def test_dropped_provider_model_is_not_used_for_unsent_tabs(ws):
    # 対応をやめた AIを前回選んでいても、新しいタブ・まだ送っていないタブは既定のモデルで送れる
    from slide_studio.ai.chat import Chat
    add_deck(ws, "talk", DECK)
    ws.set_prefs(ai_last="removed:old-model", ai_favorites=["codex:gpt-6-astra", "removed:old-model"])
    srv = SimpleNamespace(ws=ws, broadcast=lambda ev: None)
    chat = Chat(srv)
    assert chat._new_tab({"tabs": []})["model"] is None
    unsent, sent = chat._new_tab({"tabs": []}), chat._new_tab({"tabs": []})
    unsent["model"] = sent["model"] = "removed:old-model"
    rounds = [{"id": "r1", "tab": sent["id"], "state": "done"}]
    write_atomic(chat.path("talk"), json.dumps({"tabs": [unsent, sent], "rounds": rounds}))
    tabs = {t["id"]: t for t in chat.state("talk")["tabs"]}
    assert tabs[unsent["id"]]["model"] is None
    assert tabs[sent["id"]]["model"] == "removed:old-model"  # 最初の送信の後はモデルを変えない
    assert chat._defaults()["favorites"] == ["codex:gpt-6-astra"]
    ws.set_prefs(ai_last="claude:opus")
    assert chat._new_tab({"tabs": []})["model"] == "claude:opus"


def test_check_errors_stop_after_three_fixes(chat):
    ws, srv, client = chat
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目",
                           "text": "replace ## 一枚目 {#one} => ## 一枚目"}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "fail", done
    assert len(done["fixes"]) == 3
    assert all(f["errors"] >= 1 and f["limit"] == 3 and f["summary"] for f in done["fixes"])
    assert len(list((ws.state / "fake-codex").glob("*.json"))) == 4
    assert any("ページ ID {#id} がありません" in e["text"] for e in done["check"]["errors"])


def test_check_errors_from_before_the_send_are_not_fixed(chat):
    """送信の前からあったエラーは直させず、要修正にもしない。直させるのは送信で増えたエラーだけ。"""
    ws, srv, client = chat
    write_atomic(ws.qmd("talk"), ws.qmd("talk").read_text().replace("## 二枚目 {#two}", "## 二枚目"))
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": (
        "replace ## 一枚目 {#one} => ## 一枚目; "
        "fixwith ## 一枚目 => ## 直した一枚目 {#one}"
    )}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "done", done
    assert len(done["fixes"]) == 1 and done["fixes"][0]["errors"] == 1
    retry = json.loads((ws.state / "fake-codex" / "1.json").read_text())["prompt"]
    assert "「一枚目」 にページ ID" in retry and "二枚目" not in retry
    old = [e for e in done["check"]["errors"] if "二枚目" in e["text"]]
    assert old and all(e.get("old") for e in done["check"]["errors"])


def test_only_check_errors_from_before_need_no_fix(chat):
    ws, srv, client = chat
    write_atomic(ws.qmd("talk"), ws.qmd("talk").read_text().replace("## 二枚目 {#two}", "## 二枚目"))
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": "replace 最初の段落。 => 書き換えた段落。"}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "done", done
    assert not done.get("fixes")
    assert len(list((ws.state / "fake-codex").glob("*.json"))) == 1
    assert done["check"]["errors"] and all(e.get("old") for e in done["check"]["errors"])


def test_check_warnings_do_not_request_fixes(chat):
    ws, srv, client = chat
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": (
        "replace 最初の段落。 => 本文; "
        "fixwith 本文 => 修正された段落。"
    )}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "done", done
    assert done["check"]["errors"] == []
    assert any("ひな形の仮の文字" in w["text"] for w in done["check"]["warnings"])
    assert not done.get("fixes")
    assert len(list((ws.state / "fake-codex").glob("*.json"))) == 1
    assert "\n本文\n" in ws.qmd("talk").read_text()
    assert (ws.state / "fake-fix").read_text() == "replace 本文 => 修正された段落。\n"


def test_theme_check_error_fixed_in_same_session(chat):
    ws, srv, client = chat
    tab = next(t for t in state(client)["tabs"] if t["mode"] == "theme")
    css = ws.themes / "default.css"
    original = css.read_text()
    # 必須の変数名を一時的に変え、テーマ宛ての修正依頼で戻す。
    response = client.post(f"/api/deck/talk/chat/tabs/{tab['id']}/send", json={
        "base": sha256_text(original), "items": [{"key": "theme", "label": "テーマ", "text": (
            "replace --ink: => --a4-ink:; fixwith --a4-ink: => --ink:"
        )}],
    })
    response.raise_for_status()
    done = wait_done(client, response.json()["id"])
    assert done["state"] == "done", done
    assert done["check"]["kind"] == "theme" and done["check"]["errors"] == []
    assert len(done["fixes"]) == 1
    fix = done["fixes"][0]
    assert fix["errors"] >= 1 and fix["limit"] == 3 and fix["summary"]
    assert css.read_text() == original and ws.qmd("talk").read_text() == DECK
    assert (ws.state / "fake-fix").read_text() == ""
    logs = ws.state / "fake-codex"
    assert len(list(logs.glob("*.json"))) == 2
    retry = json.loads((logs / "1.json").read_text())
    session = next(t["session"] for t in state(client)["tabs"] if t["id"] == tab["id"])
    assert session and retry["argv"][retry["argv"].index("resume") + 1] == session
    assert [a["session"] for a in done["agents"] if a["parent"]] == [session, session]
    assert "[テーマ] themes/default.css" in retry["prompt"]
    assert "[検査のエラー]" in retry["prompt"]
    assert "必須の変数がありません: --ink" in retry["prompt"]
    assert "[指示]" not in retry["prompt"] and "[依頼]" not in retry["prompt"]


def test_lock_and_parallel_tabs(chat):
    ws, srv, client = chat
    tab1 = state(client)["tabs"][0]["id"]
    tab2 = client.post("/api/deck/talk/chat/tabs").json()["id"]
    r1 = send(client, ws, [{"key": "one", "label": "p4", "text": "sleep 3; replace 最初の段落。 => 一。"}], tab=tab1).json()
    wait_state(client, r1["id"], "run")
    # 実行中は対象のページの保存をロック。同じタブからは送れない。別のタブからは並行して送れる
    text = ws.qmd("talk").read_text()
    put = client.put("/api/deck/talk/source", json={"text": text.replace("最初の段落。", "x"), "base": sha256_text(text)})
    assert put.status_code == 423
    assert send(client, ws, [{"key": "one", "label": "p4", "text": "x"}], tab=tab1).status_code == 400
    r2 = send(client, ws, [{"key": "two", "label": "p5", "text": "replace 右の列。 => 右。"}], tab=tab2).json()
    lock = state(client)["lock"]
    assert not state(client)["locked"] and {p["key"] for p in lock["pages"]} == {"one", "two"}
    d2, d1 = wait_done(client, r2["id"]), wait_done(client, r1["id"])
    assert d1["state"] == d2["state"] == "done"
    text = ws.qmd("talk").read_text()
    assert "一。" in text and "右。" in text
    assert not state(client)["locked"]


def test_restore_only_own_files(chat):
    ws, srv, client = chat
    shelf = ws.shelf_dir("test")
    shelf.mkdir(parents=True, exist_ok=True)
    (shelf / "old.txt").write_text("old\n")
    (ws.root / "outside.txt").write_text("before\n")
    r = send(client, ws, [{"key": "one", "label": "p4", "text": "replace 最初の段落。 => 変えた。; add topics/test/html/new-fig/figure.mjs; delete topics/test/html/old.txt; add outside.txt"}]).json()
    done = wait_done(client, r["id"])
    assert sorted(done["files"]["added"]) == ["topics/test/html/new-fig/figure.mjs"]
    assert done["files"]["deleted"] == ["topics/test/html/old.txt"]
    assert done["files"]["outside"] == ["outside.txt"]
    # 別のタブの、後の送信（別のファイル）
    tab2 = client.post("/api/deck/talk/chat/tabs").json()["id"]
    r2 = send(client, ws, [{"key": "deck", "label": "全体", "text": "add topics/test/images/later.txt"}], tab=tab2).json()
    wait_done(client, r2["id"])
    res = client.post(f"/api/deck/talk/chat/rounds/{r['id']}/restore")
    assert res.status_code == 200, res.text
    restored = res.json()["restored"]
    assert "変えた。" not in ws.qmd("talk").read_text()
    assert not (shelf / "new-fig").exists()
    assert (shelf / "old.txt").read_text() == "old\n"
    assert (ws.asset_root("talk") / "images" / "later.txt").exists()  # 他の送信の変更は残す
    assert restored["outside"] == ["outside.txt"]
    assert client.post(f"/api/deck/talk/chat/rounds/{r['id']}/restore").status_code == 400


def test_restore_preview_shows_later_and_overlapping(chat):
    ws, srv, client = chat
    images = ws.asset_root("talk") / "images"
    tab1 = state(client)["tabs"][0]["id"]
    tab2 = client.post("/api/deck/talk/chat/tabs").json()["id"]
    r1 = send(client, ws, [{"key": "one", "label": "p4", "text": "add topics/test/images/a.txt; sleep 3"}], tab=tab1).json()
    t0 = time.time()
    while not (images / "a.txt").exists() and time.time() - t0 < 20:
        time.sleep(0.1)
    # r1 の実行中に、別のタブが別のファイルを変える（実行の前後の差では r1 の変更と区別できない）
    r2 = send(client, ws, [{"key": "deck", "label": "全体", "text": "add topics/test/images/b.txt"}], tab=tab2).json()
    wait_done(client, r2["id"])
    wait_done(client, r1["id"])
    # 送信の後に画面で原稿を直す
    text = ws.qmd("talk").read_text()
    client.put("/api/deck/talk/source", json={"text": text + "\n", "base": sha256_text(text)}).raise_for_status()
    (images / "a.txt").write_text("later\n")
    plan = client.get(f"/api/deck/talk/chat/rounds/{r1['id']}/restore").json()
    assert sorted(plan["files"]) == ["topics/test/images/a.txt", "topics/test/images/b.txt"]
    assert plan["later"] == ["topics/test/images/a.txt"]
    names = {t["id"]: t["name"] for t in state(client)["tabs"]}
    assert plan["shared"] == {"files": ["topics/test/images/b.txt"], "tabs": [names[tab2]]}
    assert plan["kept"] == []
    assert (images / "a.txt").exists()  # 確認だけでは戻さない
    # r2 から見ても、r1 の実行の差に b.txt が入るので区別できない。r1 だけが変えた a.txt は出さない
    assert client.get(f"/api/deck/talk/chat/rounds/{r2['id']}/restore").json()["shared"] == {
        "files": ["topics/test/images/b.txt"], "tabs": [names[tab1]]}


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # 終わったが回収されていない子（zombie）は動いていない
    out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(out) and not out.startswith("Z")


def test_cancel_kills_process_group_and_checks(chat):
    ws, srv, client = chat
    r = send(client, ws, [{"key": "one", "label": "p4", "text": "replace 最初の段落。 => 途中。; sleep 30"}]).json()
    pid_file = ws.state / "fake-child.pid"
    t0 = time.time()
    while not pid_file.exists() and time.time() - t0 < 20:
        time.sleep(0.1)
    child = int(pid_file.read_text())
    assert _alive(child)
    client.post(f"/api/deck/talk/chat/rounds/{r['id']}/cancel").raise_for_status()
    done = wait_done(client, r["id"])
    assert done["state"] == "cancelled" and done["check"] is not None
    t0 = time.time()
    while _alive(child) and time.time() - t0 < 5:
        time.sleep(0.1)
    assert not _alive(child)
    # 途中までの変更も戻せる
    assert "途中。" in ws.qmd("talk").read_text()
    client.post(f"/api/deck/talk/chat/rounds/{r['id']}/restore").raise_for_status()
    assert "途中。" not in ws.qmd("talk").read_text()


def test_send_rejects_stale_base_and_logged_out(chat, monkeypatch):
    ws, srv, client = chat
    tab = state(client)["tabs"][0]["id"]
    r = client.post(f"/api/deck/talk/chat/tabs/{tab}/send", json={"base": "x", "items": [{"key": "one", "text": "a"}]})
    assert r.status_code == 409 and state(client)["rounds"] == []
    monkeypatch.setenv("FAKE_CODEX_LOGGED_OUT", "1")
    codex = provider(ai_status(client, refresh=True), "codex")
    assert not codex["ok"] and codex["reason"] == "login"
    assert send(client, ws, [{"key": "one", "label": "p4", "text": "a"}]).status_code == 400


def test_english_ai_error_gets_japanese_guidance(chat, monkeypatch):
    # Codex が英語のエラーで断ったら、日本語の案内を付けて出す（原文は括弧に残す）
    ws, srv, client = chat
    monkeypatch.setenv("FAKE_CODEX_THREAD_ERROR", "workspace routing discovery failed")
    r = send(client, ws, [{"key": "one", "label": "p4", "text": "replace 最初の段落。 => 変えた。"}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "error"
    assert done["error"] == "Codex とのやりとりに失敗しました。もう一度送ってください（workspace routing discovery failed）"
    from slide_studio.ai.workflow import ai_error
    assert ai_error("Codex", "ChatGPT アカウントでログインしてください") == "ChatGPT アカウントでログインしてください"
    assert ai_error("Claude Code", "") == "Claude Code とのやりとりに失敗しました。もう一度送ってください"


def test_check_from_sandbox_is_done_by_the_app(chat):
    ws, srv, client = chat
    env = {**os.environ, "CODEX_SANDBOX": "seatbelt", "SLIDE_STUDIO_HOME": str(ws.root)}
    out = subprocess.run([sys.executable, "-m", "slide_studio.cli", "--root", str(ws.root), "check", "talk"],
                         capture_output=True, text=True, env=env, timeout=120)
    assert out.returncode == 0, out.stdout + out.stderr
    assert "検査：" in out.stdout
    assert not list((ws.state / "requests").glob("*"))


def test_figure_target_prompt(chat):
    ws, srv, client = chat
    from slide_studio import figures
    figures.new_figure(ws, "box", ws.shelf_dir("test"))
    text = ws.qmd("talk").read_text().replace("まとめの段落。", "まとめの段落。\n\n{{< fig test/box >}}")
    ws.qmd("talk").write_text(text)
    # 図への指示は fig:<参照> で残し、送れる（設計書 §8.2）
    tab = state(client)["tabs"][0]["id"]
    client.patch(f"/api/deck/talk/chat/tabs/{tab}", json={"drafts": {"fig:test/box": "色を変えて"}}).raise_for_status()
    assert client.patch(f"/api/deck/talk/chat/tabs/{tab}", json={"drafts": {"fig:../x": "y"}}).status_code == 400
    r = send(client, ws, [{"key": "fig:test/box", "label": "図 box", "text": "noop"}]).json()
    wait_done(client, r["id"])
    p = json.loads((ws.state / "fake-codex" / "0.json").read_text())["prompt"]
    assert "[対象] 図 topics/test/html/box（トピック test）" in p and "[対象の原文] topics/test/html/box/figure.mjs" in p
    assert "[使っているページ] p" in p and "（id: summary）「まとめ」" in p


def test_models_effort_and_lock(chat):
    ws, srv, client = chat
    st = ai_status(client)
    codex = provider(st, "codex")
    # 一覧には見せるモデルだけ。既定は Codex の既定（設定が無ければ一覧の最初）。上限は Codex の実効の値（95%）
    assert [m["id"] for m in codex["models"]] == ["test-big", "test-small"]
    assert st["default"] == "codex:test-big" and st["favorites"] == ["codex:test-big"]
    assert codex["models"][0]["efforts"] == ["low", "medium", "high", "xhigh"] and codex["models"][0]["context"] == 190000
    assert {p["id"]: p["reason"] for p in st["providers"] if p["id"] != "codex"} == {"claude": "missing", "agy": "missing"}
    tab = state(client)["tabs"][0]["id"]
    url = f"/api/deck/talk/chat/tabs/{tab}"
    # 送る前はモデルを変えられ、選んだモデルは次のタブの既定になる。表示リストは変えない
    assert client.patch(url, json={"model": "codex:nope"}).status_code == 400
    client.patch(url, json={"model": "codex:test-small"}).raise_for_status()
    assert ai_status(client)["favorites"] == ["codex:test-big"]
    assert client.patch(url, json={"effort": "high"}).status_code == 400  # test-small に high は無い
    client.patch(url, json={"effort": "medium"}).raise_for_status()
    r = send(client, ws, [{"key": "one", "label": "p4", "text": "noop"}]).json()
    assert r["model"] == "codex:test-small" and r["effort"] == "medium" and r["model_name"] == "Test Small"
    done = wait_done(client, r["id"])
    argv = json.loads((ws.state / "fake-codex" / "0.json").read_text())["argv"]
    assert argv[argv.index("-m") + 1] == "test-small" and 'model_reasoning_effort="medium"' in argv
    # コンテキストの使用量は App Server の通知から
    assert done["context"] == {"used": 47500, "window": 190000}
    # 会話の途中でもモデルを変更でき、次の送信に適用する
    assert client.patch(url, json={"model": "codex:test-big"}).status_code == 200
    client.patch(url, json={"effort": "low"}).raise_for_status()
    tab2 = client.post("/api/deck/talk/chat/tabs").json()
    assert tab2["model"] == "codex:test-big"
    # よく使うモデルから外す
    assert client.put("/api/ai/favorites", json={"favorites": ["codex:test-small"]}).json()["favorites"] == ["codex:test-small"]


def test_saving_model_choice_does_not_wait_for_detection(chat, monkeypatch):
    from slide_studio.ai.providers import PROVIDERS
    ws, srv, client = chat
    ai_status(client, refresh=True)
    url = f"/api/deck/talk/chat/tabs/{state(client)['tabs'][0]['id']}"
    monkeypatch.setattr("slide_studio.ai.chat.STATUS_TTL", -1.0)  # 検出の期限切れ

    def no_detect(*_args):
        raise AssertionError("検出を待っています")
    for provider in PROVIDERS.values():
        monkeypatch.setattr(provider, "detect", no_detect)
    assert client.patch(url, json={"model": "codex:test-small"}).status_code == 200
    assert client.put("/api/ai/favorites", json={"favorites": ["codex:test-small"]}).json()["favorites"] == ["codex:test-small"]


def test_rejected_tab_update_preserves_conversation_and_drafts(chat):
    ws, srv, client = chat
    ai_status(client)
    first = wait_done(client, send(client, ws, [{"key": "one", "text": "noop 最初の相談"}]).json()["id"])
    tab_id = first["tab"]
    url = f"/api/deck/talk/chat/tabs/{tab_id}"
    client.patch(url, json={"drafts": {"one": "保存した書きかけ"}}).raise_for_status()
    before = next(t for t in state(client)["tabs"] if t["id"] == tab_id)
    selected = ws.prefs().get("ai_last")
    for body in (
        {"model": "codex:test-small", "effort": "high"},
        {"model": "codex:test-small", "attach": [{"path": "materials/missing.txt"}]},
        {"drafts": {"one": "消してはいけない指示"}, "open": False},
    ):
        assert client.patch(url, json=body).status_code == 400
        assert next(t for t in state(client)["tabs"] if t["id"] == tab_id) == before
        assert ws.prefs().get("ai_last") == selected
        saved = json.loads(srv.app.state.chat.path("talk").read_text())
        assert next(t for t in saved["tabs"] if t["id"] == tab_id) == before
    wait_done(client, send(client, ws, [{"key": "one", "text": "noop 続きの相談"}], tab=tab_id).json()["id"])
    assert codex_rpcs(ws)[-1]["turns_in_thread"] == 1


def test_attachments_go_to_images_and_materials(chat):
    ws, srv, client = chat
    data = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
    img = client.post("/api/deck/talk/assets", params={"name": "スクリーンショット.png"}, content=data,
                      headers={"Content-Type": "image/png"}).json()
    doc = client.post("/api/deck/talk/materials", params={"path": "memo.pdf"}, content=b"%PDF-1.4",
                      headers={"Content-Type": "application/octet-stream"}).json()
    attach = [{"path": img["path"]}, {"path": f"materials/{doc['path']}"}]
    assert img["path"].startswith("images/")
    tab = state(client)["tabs"][0]["id"]
    url = f"/api/deck/talk/chat/tabs/{tab}"
    assert client.patch(url, json={"attach": [{"path": "../slides.qmd"}]}).status_code == 400
    assert client.patch(url, json={"attach": [{"path": "images/none.png"}]}).status_code == 400
    saved = client.patch(url, json={"attach": attach}).json()["attach"]
    assert [a["kind"] for a in saved] == ["image", "file"]
    r = send(client, ws, [{"key": "deck", "label": "全体", "text": "noop"}]).json()
    assert [a["path"] for a in r["attach"]] == [img["path"], "materials/memo.pdf"]
    assert state(client)["tabs"][0]["attach"] == []
    wait_done(client, r["id"])
    log = json.loads((ws.state / "fake-codex" / "0.json").read_text())
    assert f"- topics/test/{img['path']}（画像" in log["prompt"] and "- decks/talk/materials/memo.pdf（参考資料" in log["prompt"]
    assert f"--image={ws.asset_root('talk') / img['path']}" in log["argv"]
    assert log["sandbox"] == "1"  # 作業中の slide-studio check は起動中のアプリに頼む（bridge）


def test_claude_code_provider(chat, tmp_path, monkeypatch):
    ws, srv, client = chat
    exe = tmp_path / "claude"
    exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FIXTURES / "fake_claude.py"}" "$@"\n')
    exe.chmod(0o755)
    monkeypatch.setenv("SLIDE_STUDIO_CLAUDE", str(exe))
    claude = provider(ai_status(client, refresh=True), "claude")
    assert claude["ok"] and {"opus", "sonnet", "haiku"} <= {m["id"] for m in claude["models"]}
    tab = state(client)["tabs"][0]["id"]
    client.patch(f"/api/deck/talk/chat/tabs/{tab}", json={"model": "claude:sonnet", "effort": "max"}).raise_for_status()
    r = send(client, ws, [{"key": "one", "label": "p4", "text": "replace 最初の段落。 => クロード。"}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "done", done
    assert "クロード。" in ws.qmd("talk").read_text()
    assert [x["ok"] for x in done["results"]] == [True]
    assert any(s["kind"] == "command" and s["text"].startswith("replace") and s["exit"] == 0 for s in done["steps"])
    # 使用量は最後の応答、上限は modelUsage。上限は次から一覧にも出る
    assert done["context"] == {"used": 21100, "window": 1000000}
    sonnet = next(m for m in provider(ai_status(client), "claude")["models"] if m["id"] == "sonnet")
    assert sonnet["context"] == 1000000
    log = json.loads((ws.state / "fake-claude" / "0.json").read_text())
    argv = log["argv"]
    assert argv[argv.index("--model") + 1] == "sonnet" and argv[argv.index("--effort") + 1] == "max"
    # 置き場で、AI 本体の道具で動く。Bash は sandbox の中、控えとチャットの記録には書かせない（設計書 §8.1.2）
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
    assert argv[argv.index("--setting-sources") + 1] == "project" and "--system-prompt" not in argv and "--mcp-config" not in argv
    settings = json.loads(argv[argv.index("--settings") + 1])
    assert settings["sandbox"]["enabled"] and not settings["sandbox"]["allowUnsandboxedCommands"]
    assert settings["permissions"]["deny"] == [f"Edit(/{ws.state / 'snapshots'}/**)", f"Edit(/{ws.state / 'chat'}/**)"]
    assert argv[argv.index("--allowedTools") + 1] == "WebSearch,WebFetch"  # スライドの担当は web 検索を使える
    assert log["env_home"] == str(ws.root)
    assert "--resume" not in argv and "--json-schema" in argv
    assert [a["role"] for a in done["agents"]] == ["chat", "review"] and done["review_ok"]
    review = json.loads((ws.state / "fake-claude-review/0.json").read_text())
    review_argv = review["argv"]
    assert review_argv[review_argv.index("--permission-mode") + 1] == "default"
    assert {"Edit", "Write", "NotebookEdit"} <= set(review_argv[review_argv.index("--disallowedTools") + 1].split(","))
    assert "[利用者の指示]" in review["prompt"] and "id: one" in review["prompt"]
    session = state(client)["tabs"][0]["session"]
    r2 = send(client, ws, [{"key": "one", "label": "p4", "text": "noop"}]).json()
    wait_done(client, r2["id"])
    # 起動したままの Claude Code に続きを流し込む（起動し直さない。作業手順書 A6）
    log2 = json.loads((ws.state / "fake-claude" / "1.json").read_text())
    assert log2["pid"] == log["pid"] and log2["turn"] == 1 and "--input-format" in log2["argv"]
    assert [a["session"] for a in wait_done(client, r2["id"])["agents"] if a["parent"]] == [session]


@pytest.fixture
def login_browser(monkeypatch):
    from unittest.mock import Mock
    browser = Mock(return_value=True)
    monkeypatch.setattr('webbrowser.open', browser)
    return browser


def wait_login(client, provider='codex'):
    for _ in range(250):
        status = client.get(f'/api/ai/{provider}/login').json()
        if status['status'] in ('completed', 'failed'):
            return status
        time.sleep(.02)
    raise AssertionError(status)


def test_codex_login_prepares_runtime_first(chat, monkeypatch, login_browser):
    from slide_studio.ai.providers import Codex
    from unittest.mock import Mock
    ws, srv, client = chat
    ensure = Mock(return_value=Codex().binary())
    monkeypatch.setattr(Codex, 'ensure_binary', ensure)
    assert client.post('/api/ai/codex/login').status_code == 200
    assert wait_login(client)['status'] == 'completed'
    ensure.assert_called_once()
    login_browser.assert_called_once_with('https://auth.openai.com/test')


def test_codex_login_and_rpc_options(chat, login_browser):
    ws, srv, client = chat
    assert client.post('/api/ai/codex/login').status_code == 200
    assert wait_login(client)['status'] == 'completed'
    login_browser.assert_called_once_with('https://auth.openai.com/test')
    # 何かを変えると確認担当も動く
    r = send(client, ws, [{"key": "one", "label": "p4", "text": "replace 最初の段落。 => 変えた。"}]).json()
    done = wait_done(client, r['id'])
    assert not done['error']
    log = json.loads((ws.state / 'fake-app-server' / '0.json').read_text())
    rpc = json.loads(log['prompt'])
    # 編集担当は置き場で、sandbox は権限のプロファイルで決める（thread/start の sandbox は渡さない）
    assert 'sandbox' not in rpc['thread']
    assert rpc['thread']['approvalPolicy'] == 'never'
    assert rpc['thread']['cwd'] == str(ws.root)
    assert rpc['turn']['outputSchema']['type'] == 'object'
    assert rpc['turn']['input'][0]['type'] == 'text'
    # 確認役も置き場で動くが、読むだけ。権限プロファイル・配布ツール・システムプロンプトは渡さない。
    review_log = json.loads((ws.state / 'fake-app-server' / '1.json').read_text())
    review = json.loads(review_log['prompt'])
    assert review['thread']['sandbox'] == 'read-only' and review['thread']['cwd'] == str(ws.root)
    assert 'dynamicTools' not in review['thread'] and 'developerInstructions' not in review['thread']
    assert not any('default_permissions' in arg for arg in review_log['argv'])


def test_codex_login_browser_failure(chat, login_browser):
    _, _, client = chat
    login_browser.return_value = False
    assert client.post('/api/ai/codex/login').status_code == 200
    status = wait_login(client)
    assert status['status'] == 'failed' and '既定のブラウザー' in status['error']


class WaitingLogin:
    """ブラウザーの完了を待ち続けるログイン。開いた回数と止められた回数を数える。"""
    id = 'fake'
    runtime = SimpleNamespace(progress=None)

    def __init__(self):
        self.opened = self.cancelled = 0

    def ensure_binary(self):
        return 'fake'

    async def login(self, exe):
        self.opened += 1
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled += 1
            raise


async def until_opened(provider, count):
    for _ in range(250):
        if provider.opened == count:
            return
        await asyncio.sleep(.01)
    raise AssertionError(provider.opened)


def test_login_retry_replaces_waiting_login(monkeypatch):
    from slide_studio.ai import login
    monkeypatch.setattr(login, 'RETRY_AFTER', 0)

    async def main():
        logins, provider = login.Logins(), WaitingLogin()
        logins.start(provider)
        await until_opened(provider, 1)
        assert logins.state(provider)['retry'] is True
        logins.start(provider)
        await until_opened(provider, 2)
        assert provider.cancelled == 1 and logins.state(provider)['status'] == 'pending'
        logins.stop()

    asyncio.run(main())


def test_login_retry_waits_before_reopening(monkeypatch):
    from slide_studio.ai import login
    monkeypatch.setattr(login, 'RETRY_AFTER', 60)

    async def main():
        logins, provider = login.Logins(), WaitingLogin()
        logins.start(provider)
        await until_opened(provider, 1)
        assert logins.state(provider)['retry'] is False
        first = logins.jobs['fake']
        logins.start(provider)
        assert logins.jobs['fake'] is first and provider.opened == 1
        logins.stop()

    asyncio.run(main())


def test_login_unknown_provider(chat):
    _, _, client = chat
    assert client.post('/api/ai/nope/login').status_code == 400


def test_runtime_rows_and_auto_switch(chat):
    _, _, client = chat
    rows = client.get('/api/ai/runtimes').json()['ai']
    assert [r['id'] for r in rows] == ['codex', 'claude', 'agy'] and all(r['fixed'] for r in rows if r['id'] != 'codex')
    # 環境変数で実行ファイルを指定している間は、取得や更新をしない
    assert client.post('/api/ai/codex/runtime', json={'action': 'update'}).status_code == 400


def test_second_send_does_not_wait_for_startup(chat, monkeypatch):
    """タブごとに AI を起動したままにする（作業手順書 A6）。2回目の送信は app-server の起動を待たずに始まる。"""
    ws, srv, client = chat
    monkeypatch.setenv("FAKE_CODEX_STARTUP", "1.5")
    tab = state(client)["tabs"][0]["id"]
    waits = []
    for n in range(2):
        before = len(list((ws.state / "fake-app-server").glob("*.json"))) if (ws.state / "fake-app-server").exists() else 0
        sent = time.time()
        r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": "noop"}], tab).json()
        assert wait_done(client, r["id"])["state"] == "done"
        turn = json.loads((ws.state / "fake-app-server" / f"{before}.json").read_text())
        waits.append(turn["time"] - sent)
    assert waits[0] >= 1.5 and waits[1] < 1.0, waits


def test_review_and_check_conflict_stops_with_final_report(chat):
    ws, srv, client = chat
    text = ("replace 最初の段落。 => 確認する段落。; reviewng 9; "
            "fixwith ## 一枚目 {#one} => ## 一枚目; "
            "fixwith ## 一枚目 => ## 一枚目 {#one}")
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": text}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "fail" and done["review_ok"] is False, done
    assert len(done["review_fixes"]) == 1 and len(done["fixes"]) == 1
    assert len(review_rpcs(ws)) == 1
    assert done["check"]["errors"] == []
    assert "## 一枚目 {#one}" in ws.qmd("talk").read_text()
    assert "機械検査の修正が同じ状態に戻る" in done["summary"]
    assert "最終の機械検査：エラー 0 件" in done["summary"]


def test_review_cycle_with_two_versions_stops(chat):
    ws, srv, client = chat
    text = ("replace 最初の段落。 => 確認する段落。; reviewng 9; "
            "fixwith 確認する段落。 => 別の段落。; "
            "fixwith 別の段落。 => 確認する段落。")
    r = send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": text}]).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "fail" and done["review_ok"] is False, done
    assert len(done["review_fixes"]) == 2 and len(review_rpcs(ws)) == 2
    assert "同じ状態に戻る" in done["summary"]
    reviews = [a for a in done["agents"] if a["role"] == "review"]
    assert done["final_review"] == reviews[0]["id"]


@pytest.mark.parametrize("mixed", [False, True])
def test_review_decision_waits_without_automatic_fix(chat, monkeypatch, mixed):
    from slide_studio.ai import workflow
    parse = workflow.review_value
    calls = 0
    def decision(value):
        nonlocal calls
        result = parse(value)
        fixable = [dict(i) for i in result['issues']] if mixed and calls == 0 else []
        calls += 1
        for issue in result['issues']:
            issue['message'] = '【要判断】取り上げるコンペを選んでください'
        result['issues'].extend(fixable)
        return result
    monkeypatch.setattr(workflow, 'review_value', decision)
    ws, srv, client = chat
    r = send(client, ws, [{"key": "one", "label": "p4", "text": "replace 最初の段落。 => 確認する段落。; reviewng 9; fixwith 確認する段落。 => 直した段落。"}]).json()
    done = wait_done(client, r['id'])
    assert not done['review_ok']
    assert len(done.get('review_fixes', [])) == int(mixed)
    if mixed:
        assert done['review_fixes'][0]['issues'] == 1
        assert '直した段落。' in ws.qmd('talk').read_text()
    assert len([a for a in done['agents'] if a['role'] == 'review']) == 1 + int(mixed)
    assert not done['error']


def test_send_without_changes_skips_check_and_review(chat):
    """スライド・図が変わらなかった送信（質問に答えただけなど）は、終わった後に検査も確認もしない。"""
    ws, srv, client = chat
    done = wait_done(client, send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": "これは何のページ？"}]).json()["id"])
    assert done["state"] == "done" and done["check"] is None, done
    assert not [a for a in done["agents"] if a["role"] == "review"]
    assert done["snapshot"]  # 編集の送信なので控えは取る


def test_talk_reads_only_in_the_same_conversation(chat):
    """話し合い：同じ会話のまま、読むだけ（Codex は read-only）・普通の文章で答える。控え・検査・確認役なし。"""
    ws, srv, client = chat
    tab = state(client)["tabs"][0]["id"]
    first = wait_done(client, send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": "replace 最初の段落。 => 変えた段落。"}], tab).json()["id"])
    editor = next(a["session"] for a in first["agents"] if a["parent"])
    qmd = ws.qmd("talk").read_text()
    talk = wait_done(client, send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": "replace 変えた段落。 => 話し合いで変えた。"}], tab, talk=True).json()["id"])
    assert talk["talk"] and talk["state"] == "done", talk
    assert talk["snapshot"] is None and talk["check"] is None and talk["files"] is None
    assert [a["role"] for a in talk["agents"]] == ["chat"]
    assert ws.qmd("talk").read_text() == qmd  # [指示] として扱わない
    # 編集の app-server が書いている thread は、読むだけの app-server に履歴ごと写して続ける（Codex は resume させない）
    talked = talk["agents"][0]["session"]
    rpc = [x for x in codex_rpcs(ws) if x["turn"]["threadId"] == talked][-1]
    assert rpc["thread"]["forked"] == editor and rpc["thread"]["sandbox"] == "read-only" and set(rpc["turn"]["outputSchema"]["properties"]) == {"summary", "questions"}
    text = rpc["turn"]["input"][0]["text"]
    assert "[話し合い]" in text and "[発言] replace" in text and "slide-studio consult" not in text
    assert not state(client)["locked"]
    # 話し合いの後の編集も、話し合いを含む会話を編集の設定の app-server に写して続ける
    again = wait_done(client, send(client, ws, [{"key": "one", "label": "p3 一枚目", "text": "replace 変えた段落。 => 続けて変えた。"}], tab).json()["id"])
    assert again["state"] == "done"
    rpc = [x for x in codex_rpcs(ws) if x["turn"]["threadId"] == next(a["session"] for a in again["agents"] if a["parent"])][-1]
    assert rpc["thread"]["forked"] == talked and "sandbox" not in rpc["thread"] and rpc["turn"].get("outputSchema")
    assert "続けて変えた。" in ws.qmd("talk").read_text()


def test_open_view_archives_idle_tabs_and_reuses_empty_tabs(ws):
    from slide_studio.ai.chat import Chat
    add_deck(ws, "talk", DECK)
    chat = Chat(SimpleNamespace(ws=ws, broadcast=lambda ev: None))
    data = chat.state("talk")
    old = list(data["tabs"])
    for tab in old:
        tab["drafts"] = {tab["mode"]: "書きかけ"}
        tab["session"] = "saved-session"
    running = chat.add_tab("talk")
    data["rounds"].append({"id": "r", "tab": running["id"], "state": "run", "time": 1})

    opened = chat.open_view("talk")
    assert all(not t["open"] and t["drafts"] and t["session"] == "saved-session" for t in old)
    assert running["open"] and data["rounds"][0]["state"] == "run"
    fresh = [t for t in opened["tabs"] if t["open"] and t is not running]
    assert {t["mode"] for t in fresh} == {"slides", "memo", "theme"}
    assert all(not t["drafts"] and not t["session"] for t in fresh)
    ids = [t["id"] for t in data["tabs"]]
    assert [t["id"] for t in chat.open_view("talk")["tabs"]] == ids
    assert json.loads(chat.path("talk").read_text())["tabs"] == data["tabs"]
    data["rounds"][0]["state"] = "done"
    chat.open_view("talk")
    assert not running["open"]
    assert all(t["open"] for t in fresh)


def test_last_open_tab_cannot_be_closed(ws):
    # どのチャットにも開いたタブが必ず1つある。全部閉じた古い状態でも開いたタブを足す
    from slide_studio.ai.chat import Chat
    add_deck(ws, "talk", DECK)
    srv = SimpleNamespace(ws=ws, broadcast=lambda ev: None)
    chat = Chat(srv)
    closed = chat._new_tab({"tabs": []})
    closed["open"] = False
    write_atomic(chat.path("talk"), json.dumps({"tabs": [closed], "rounds": []}))
    tabs = [t for t in chat.state("talk")["tabs"] if t["mode"] == "slides"]
    assert [t["open"] for t in tabs] == [False, True]
    only = tabs[1]
    with pytest.raises(StudioError):
        chat.update_tab("talk", only["id"], {"open": False})
    other = chat.add_tab("talk")
    chat.update_tab("talk", only["id"], {"open": False})
    with pytest.raises(StudioError):
        chat.update_tab("talk", other["id"], {"open": False})
    memo = next(t for t in chat.state("talk")["tabs"] if t["mode"] == "memo")
    with pytest.raises(StudioError):
        chat.update_tab("talk", memo["id"], {"open": False})  # 種類ごとに数える


def test_lock_covers_only_slides_and_html(chat):
    ws, srv, client = chat
    hook = srv.app.state.chat
    hook.state("talk")["rounds"].append({"id": "r", "mode": "slides", "state": "run"})
    hook.running["r"] = ("talk", "slides")
    try:
        image = client.post("/api/deck/talk/assets?name=a.png", content=b"\x89PNG\r\n").json()["path"]
        html = client.post("/api/deck/talk/assets?name=a.html", content=b"<p>x</p>").json()["path"]
        assert client.post("/api/deck/talk/assets/delete", json={"paths": [html]}).status_code == 423
        assert client.post("/api/deck/talk/assets/delete", json={"paths": [image]}).status_code == 200
        theme = client.get("/api/themes/default").json()
        assert not theme["locked"]
        assert client.put("/api/themes/default", json={"base": theme["version"], "vars": {"--ink": "#123456"}}).status_code == 200
        text = ws.qmd("talk").read_text()
        assert client.put("/api/deck/talk/source", json={"text": text + "x", "base": sha256_text(text)}).status_code == 423
        edits = hook.round("talk", "r")["user_edits"]
        assert "themes/default.css" in edits
        assert (ws.asset_root("talk") / image).relative_to(ws.root).as_posix() in edits
    finally:
        hook.running.clear()


def test_page_target_saves_other_pages_and_restore_keeps_them(chat):
    ws, srv, client = chat
    r = send(client, ws, [{"key": "one", "label": "p4", "text": "sleep 2; replace 最初の段落。 => 一。"}]).json()
    wait_state(client, r["id"], "run")
    hook = srv.app.state.chat
    for _ in range(100):
        if hook.round("talk", r["id"]).get("snapshot"):
            break
        time.sleep(0.02)
    text = ws.qmd("talk").read_text()
    saved = client.put("/api/deck/talk/source", json={"text": text.replace("右の列。", "右。"), "base": sha256_text(text)})
    assert saved.status_code == 200
    assert wait_done(client, r["id"])["state"] == "done"
    final = ws.qmd("talk").read_text()
    assert "一。" in final and "右。" in final
    assert client.post(f"/api/deck/talk/chat/rounds/{r['id']}/restore").status_code == 200
    restored = ws.qmd("talk").read_text()
    assert "最初の段落。" in restored and "右。" in restored


def test_save_merges_when_ai_changed_another_page(chat):
    ws, srv, client = chat
    hook = srv.app.state.chat
    hook.state("talk")["rounds"].append({"id": "r", "mode": "slides", "state": "run", "items": [{"key": "one"}]})
    hook.running["r"] = ("talk", "slides")
    try:
        base = ws.qmd("talk").read_text()
        write_atomic(ws.qmd("talk"), base.replace("最初の段落。", "AI。"))
        body = {"text": base.replace("右の列。", "右。"), "base": sha256_text(base), "base_text": base}
        res = client.put("/api/deck/talk/source", json=body)
        assert res.status_code == 200 and "AI。" in res.json()["text"] and "右。" in res.json()["text"]
        assert "AI。" in ws.qmd("talk").read_text()
        locked = {"text": base.replace("最初の段落。", "x"), "base": "old", "base_text": base}
        res = client.put("/api/deck/talk/source", json=locked)
        assert res.status_code == 423 and res.json()["partial"]
    finally:
        hook.running.clear()


def test_figure_target_locks_only_its_line(chat):
    ws, srv, client = chat
    hook = srv.app.state.chat
    hook.state("talk")["rounds"].append({"id": "r", "mode": "slides", "state": "run", "items": [{"key": "fig:nco/a"}]})
    hook.running["r"] = ("talk", "slides")
    try:
        text = ws.qmd("talk").read_text()
        assert not hook.locked("talk") and hook.slide_scope("talk")["figures"] == ["nco/a"]
        assert client.put("/api/deck/talk/source", json={"text": text.replace("右の列。", "右。"), "base": sha256_text(text)}).status_code == 200
    finally:
        hook.running.clear()
