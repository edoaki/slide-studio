"""下書き（memo.md）と下書きのチャット。設計書 §8.8・§10.7。"""
import json

from conftest import add_deck
from e2e.conftest import DECK
from slide_studio import memo
from slide_studio.fsutil import sha256_text, write_atomic
from test_chat import chat, fake_codex, state, wait_done, wait_state  # noqa: F401  （fixture を使う）


def memo_tab(client) -> str:
    return next(t["id"] for t in state(client)["tabs"] if t["mode"] == "memo")


def send_memo(client, ws, text, tab=None):
    tab = tab or memo_tab(client)
    m = ws.memo("talk")
    base = sha256_text(m.read_text() if m.exists() else "")
    return client.post(f"/api/deck/talk/chat/tabs/{tab}/send",
                       json={"base": base, "items": [{"key": "memo", "label": "下書き", "text": text}]})


def test_blank_deck(ws):
    ws.new_deck("fresh", "test", title="新しい話")
    assert ws.is_blank("fresh")
    assert ws.is_untouched("fresh")
    q = ws.qmd("fresh")
    q.write_text(q.read_text().replace("説明を書く。", "問いの説明。"))
    assert not ws.is_blank("fresh")
    assert not ws.is_untouched("fresh")
    add_deck(ws, "talk", DECK)
    assert not ws.is_blank("talk")
    add_deck(ws, "empty", "---\ntitle: x\ntopic: test\n---\n")
    assert ws.is_blank("empty")


def test_from_slides_keeps_text_and_inserted_elements(ws):
    ws.new_deck("fresh", "test", title="新しい話")
    assert memo.from_slides(ws, "fresh") == ""  # 雛形のままなら載せるものが無い
    write_atomic(ws.qmd("fresh"), """---
title: "新しい話"
---

## 新しい話 {#cover .cover}

::: {.cover-title}
新しい話
:::

# 背景 {#bg}

## 問い {#q .wide}

### 小見出し {#sub}

[強い]{.red} 文。

::: {.notes}
話すこと
:::

## 図 {#fig}

::::: {.columns}
::: {.column}
左の文
:::
::: {.column}
{{< fig nco/route-example width=800 >}}
:::
:::::

::: {.lead}
囲みの文
:::

![写真](images/a.png){width=50%}

<div>生の HTML</div>

## 空 {#empty}

説明を書く。
""")
    assert memo.from_slides(ws, "fresh") == """## 背景

## 問い

### 小見出し

強い 文。

## 図

左の文

html-route-example

囲みの文

![写真](images/a.png)

## 空
"""


def test_from_slides_is_empty_without_body(ws):
    ws.new_deck("fresh", "test", title="新しい話")
    write_atomic(ws.qmd("fresh"), "---\ntitle: x\n---\n\n## 見出しだけ {#a}\n")
    assert memo.from_slides(ws, "fresh") == ""


def test_from_slides_marks_annotations(ws):
    add_deck(ws, "talk", """---
title: 注釈のある話
---

## 本文

普通の文。

::: {.footnote-small}
[補足]{.muted}の文。

＊記号付きの注釈。
:::

::::: {.columns}
::: {.column}
::: {.footnote-small}
段組内の注釈。
:::
:::
:::::

::: {.notes}
発表者だけのメモ。
:::
""")
    assert memo.from_slides(ws, "talk") == """## 本文

普通の文。

＊補足の文。

＊記号付きの注釈。

＊段組内の注釈。
"""


def test_untouched_deck_memo(ws):
    ws.new_deck("fresh", "test")
    memo = ws.memo("fresh")
    template = memo.read_text()
    write_atomic(memo, "\n" + template.replace("\n", "  \n") + "\n")
    assert ws.is_untouched("fresh")
    write_atomic(memo, template.replace("- 対象読者：", "- 対象読者：大学生"))
    assert not ws.is_untouched("fresh")
    assert ws.is_blank("fresh")
    write_atomic(memo, "")
    assert not ws.is_untouched("fresh")
    memo.unlink()
    assert ws.is_untouched("fresh")


def test_home_blank_uses_memo(chat):
    ws, srv, client = chat
    ws.new_deck("fresh", "test")

    def home_blank():
        return next(d["blank"] for d in client.get("/api/home").json()["recent"] if d["deck"] == "fresh")

    assert home_blank()
    write_atomic(ws.memo("fresh"), "# スライド案\n\n- 対象読者：大学生\n")
    assert not home_blank()
    assert client.get("/api/deck/fresh").json()["blank"] is True
    ws.memo("fresh").unlink()
    assert home_blank()


def test_memo_get_put_conflict(chat):
    ws, srv, client = chat
    d = client.get("/api/deck/talk/memo").json()
    assert d["text"] == "" and not d["exists"] and not d["locked"]
    r = client.put("/api/deck/talk/memo", json={"text": "# 案\n", "base": d["version"]})
    assert r.status_code == 200 and ws.memo("talk").read_text() == "# 案\n"
    stale = client.put("/api/deck/talk/memo", json={"text": "x", "base": d["version"]})
    assert stale.status_code == 409 and stale.json()["text"] == "# 案\n"
    # 下書きは描き直さない・開いたときの左の欄は中身で決まる
    assert client.get("/api/deck/talk").json()["blank"] is False


def test_tabs_are_split_by_mode(chat):
    ws, srv, client = chat
    st = state(client)
    assert sorted(t["mode"] for t in st["tabs"]) == ["memo", "slides", "theme"]
    t = client.post("/api/deck/talk/chat/tabs", json={"mode": "memo"}).json()
    assert t["mode"] == "memo"
    assert client.post("/api/deck/talk/chat/tabs").json()["mode"] == "slides"
    assert client.post("/api/deck/talk/chat/tabs", json={"mode": "x"}).status_code == 400


def test_memo_chat_runs_without_check_or_slide_lock(chat):
    ws, srv, client = chat
    ws.memo("talk").write_text("背景：未定\n")
    r = send_memo(client, ws, "sleep 2; replace 未定 => 実験で確かめた").json()
    assert r["mode"] == "memo"
    wait_state(client, r["id"], "run")
    st = state(client)
    assert not st["locked"] and st["memo_locked"]
    # スライドは編集できる。下書きは AI が書いている間は保存しない
    text = ws.qmd("talk").read_text()
    assert client.put("/api/deck/talk/source", json={"text": text + "\n", "base": sha256_text(text)}).status_code == 200
    m = client.get("/api/deck/talk/memo").json()
    assert m["locked"]
    assert client.put("/api/deck/talk/memo", json={"text": "x", "base": m["version"]}).status_code == 423
    done = wait_done(client, r["id"])
    assert done["state"] == "done", done
    assert ws.memo("talk").read_text() == "背景：実験で確かめた\n"
    assert done["check"] is None and done["results"] == []
    assert done["summary"].startswith("下書きを**直しました**")
    assert done["files"]["modified"] == ["decks/talk/memo.md"]
    # 実行中にスライドを保存したので、それは下書きのほかに変わったファイルとして知らせる
    assert done["stray"] == ["decks/talk/slides.qmd"]
    log = json.loads((ws.state / "fake-codex" / "0.json").read_text())
    # 返事は {reply, slides}（スライドの schema.json ではない）。引き渡しが無ければ普通の文章だけを出す
    assert "--output-schema" in log["argv"] and not done.get("handoff")
    p = log["prompt"]
    assert "SKILL.md" not in p and "[下書き] decks/talk/memo.md" in p and "[原稿] decks/talk/slides.qmd（読むだけ" in p
    assert "slide-studio check" not in p
    # 戻すのは下書きだけ（並行して編集したスライドは残す）
    back = client.post(f"/api/deck/talk/chat/rounds/{r['id']}/restore").json()
    assert back["restored"]["files"] == ["decks/talk/memo.md"]
    assert ws.memo("talk").read_text() == "背景：未定\n"
    assert ws.qmd("talk").read_text() == text + "\n"


def test_slides_restore_keeps_memo_edited_during_run(chat):
    ws, srv, client = chat
    ws.memo("talk").write_text("背景：未定\n")
    tab = state(client)["tabs"][0]["id"]
    base = sha256_text(ws.qmd("talk").read_text())
    r = client.post(f"/api/deck/talk/chat/tabs/{tab}/send",
                    json={"base": base, "items": [{"key": "deck", "label": "全体", "text": "sleep 2; replace 最初の段落。 => 変えた。"}]}).json()
    wait_state(client, r["id"], "run")
    # スライドの送信の間も下書きは推敲できる
    m = client.get("/api/deck/talk/memo").json()
    assert client.put("/api/deck/talk/memo", json={"text": "背景：推敲した\n", "base": m["version"]}).status_code == 200
    wait_done(client, r["id"])
    plan = client.get(f"/api/deck/talk/chat/rounds/{r['id']}/restore").json()
    assert plan["files"] == ["decks/talk/slides.qmd"] and plan["kept"] == ["decks/talk/memo.md"]
    back = client.post(f"/api/deck/talk/chat/rounds/{r['id']}/restore").json()
    assert back["restored"]["kept"] == ["decks/talk/memo.md"]
    assert "変えた。" not in ws.qmd("talk").read_text()
    assert ws.memo("talk").read_text() == "背景：推敲した\n"


def test_memo_send_rules(chat):
    ws, srv, client = chat
    tab = memo_tab(client)
    stale = client.post(f"/api/deck/talk/chat/tabs/{tab}/send",
                        json={"base": "x", "items": [{"key": "memo", "label": "下書き", "text": "a"}]})
    assert stale.status_code == 409
    base = sha256_text("")
    page = client.post(f"/api/deck/talk/chat/tabs/{tab}/send",
                       json={"base": base, "items": [{"key": "one", "label": "p4", "text": "a"}]})
    assert page.status_code == 400
    # 新しい置き場の規則に下書きの SKILL がある
    assert (ws.root / ".agents/skills/slide-studio-memo/SKILL.md").is_file()
    assert "slide-studio-memo" in (ws.root / "AGENTS.md").read_text()


def handoff(client, ws, rid, force=None):
    body = {"base": sha256_text(ws.qmd("talk").read_text())}
    if force is not None:
        body["force"] = force
    return client.post(f"/api/deck/talk/chat/rounds/{rid}/handoff", json=body)


def last_handoff_prompt(ws) -> str:
    logs = sorted((ws.state / "fake-codex").glob("*.json"), key=lambda f: int(f.stem))
    return next(p for p in (json.loads(f.read_text())["prompt"] for f in reversed(logs)) if "[下書きの担当からの方針]" in p)


def test_memo_hands_off_to_slides_chat(chat):
    """下書きのチャットの「スライドにして」は、スライドのタブの送信になる（設計書 §8.8）。"""
    ws, srv, client = chat
    ws.memo("talk").write_text("対象：学部生\n結論：実験で確かめた\n")
    doc = ws.deck_dir("talk") / "materials" / "data.csv"
    doc.parent.mkdir(parents=True, exist_ok=True)
    doc.write_text("a,b\n")
    tab = memo_tab(client)
    m = ws.memo("talk")
    r = client.post(f"/api/deck/talk/chat/tabs/{tab}/send", json={"base": sha256_text(m.read_text()), "attach": [{"path": "materials/data.csv"}],
                    "items": [{"key": "memo", "label": "下書き", "text": "slides 結論を最後のページに置く"}]}).json()
    done = wait_done(client, r["id"])
    assert done["state"] == "done", done
    # 下書きは変えず、返事は普通の文章として出す（JSON のままの返事は途中経過に残さない）
    assert ws.memo("talk").read_text() == "対象：学部生\n結論：実験で確かめた\n"
    assert done["summary"].startswith("下書きを**直しました**")
    assert not any(s["kind"] == "message" and s["text"].startswith("{") for s in done["steps"])
    assert not done.get("memo_diff")
    # 画面がスライドの保存待ちを確定してから始める
    h = done["handoff"]
    assert h["text"] == "結論を最後のページに置く" and h["pending"] and not h.get("round")
    assert handoff(client, ws, r["id"]).status_code == 200
    h = next(x for x in state(client)["rounds"] if x["id"] == r["id"])["handoff"]
    assert not h.get("error") and not h.get("pending")
    # 2回押しても1回だけ（別の画面が先に始めた）
    assert handoff(client, ws, r["id"]).json()["handoff"]["round"] == h["round"]
    st = state(client)
    tab = next(t for t in st["tabs"] if t["id"] == h["tab"])
    assert tab["mode"] == "slides" and tab["name"] == "下書きから" and tab["model"] == done["model"]
    slides = wait_done(client, h["round"])
    assert slides["mode"] == "slides" and slides["tab"] == tab["id"] and slides["items"][0]["key"] == "deck"
    assert slides["attach"] == [{"path": "materials/data.csv", "name": "data.csv", "kind": "file"}]
    # スライドの送信として行う（テスト用の codex はファイルを変えないので、検査はしない）
    assert slides["snapshot"] and slides["check"] is None
    p = last_handoff_prompt(ws)
    assert "[下書き] decks/talk/memo.md" in p and "[対象] 発表全体" in p and "結論を最後のページに置く" in p
    assert "「下書き」チャット" not in p
    # 既にスライドがあるので、全体は作り直さない
    assert "今のスライドを直してください" in p and "全体を作り直さない" in p

    # 推敲してもう一度：同じタブで、前回からの下書きの差分を添える
    r2 = send_memo(client, ws, "replace 学部生 => 院生; slides 対象に合わせる").json()
    done2 = wait_done(client, r2["id"])
    assert "+対象：院生" in done2["memo_diff"] and "-対象：学部生" in done2["memo_diff"]
    assert done2["handoff"]["pending"]
    h2 = handoff(client, ws, r2["id"]).json()["handoff"]
    assert h2["tab"] == tab["id"]
    wait_done(client, h2["round"])
    p = last_handoff_prompt(ws)
    assert "前回スライドにしたときから変わりました" in p and "+対象：院生" in p and "-対象：学部生" in p

    # 作り直しを頼まれたときだけ作り直す
    r3 = send_memo(client, ws, "rebuild; slides 全部作り直す").json()
    wait_done(client, r3["id"])
    wait_done(client, handoff(client, ws, r3["id"]).json()["handoff"]["round"])
    assert "今のスライドを作り直してください" in last_handoff_prompt(ws)


def test_handoff_waits_when_draft_review_finds_issues(chat):
    ws, srv, client = chat
    ws.memo("talk").write_text("対象：学部生\n")
    r = send_memo(client, ws, "replace 学部生 => 院生; reviewng 9; slides 対象に合わせる").json()
    done = wait_done(client, r["id"])
    assert done["review_ok"] is False and done["handoff"]["blocked"] and not done["handoff"].get("pending")
    # 押されるまで始めない。押したら（force）始める
    assert handoff(client, ws, r["id"]).status_code == 400
    h = handoff(client, ws, r["id"], force=True).json()["handoff"]
    wait_done(client, h["round"])


def test_handoff_pending_after_draft_review_fix(chat):
    ws, srv, client = chat
    write_atomic(ws.memo("talk"), "対象：学部生\n")
    response = send_memo(client, ws, "replace 学部生 => 院生; reviewng; fixwith 院生 => 大学院生; slides 対象に合わせる")
    response.raise_for_status()
    done = wait_done(client, response.json()["id"])
    assert done["state"] == "done" and done["review_ok"] is True, done
    assert done["check"] is None
    assert len(done["review_fixes"]) == 1
    assert ws.memo("talk").read_text() == "対象：大学院生\n"
    assert [a["state"] for a in done["agents"] if a["role"] == "review"] == ["needs_fix", "complete"]
    assert done["handoff"]["pending"] and not done["handoff"].get("blocked")
    assert done["handoff"]["text"] == "対象に合わせる" and not done["handoff"].get("round")
    response = handoff(client, ws, done["id"])
    response.raise_for_status()
    assert wait_done(client, response.json()["handoff"]["round"])["state"] == "done"


def test_handoff_defer_keeps_slides_unchanged(chat):
    ws, srv, client = chat
    ws.memo("talk").write_text("背景：実験で確かめた\n")
    tab = memo_tab(client)
    before = ws.qmd("talk").read_text()
    sent = client.post(f"/api/deck/talk/chat/tabs/{tab}/send", json={
        "base": sha256_text(ws.memo("talk").read_text()),
        "items": [{"key": "memo", "label": "下書き", "text": "slides 結論を最後に置く"}],
    }).json()
    wait_done(client, sent["id"])
    response = client.post(f"/api/deck/talk/chat/rounds/{sent['id']}/handoff", json={"defer": True})
    assert response.status_code == 200
    h = response.json()["handoff"]
    assert h["deferred"] and not h.get("pending") and not h.get("round")
    assert not any(t.get("handoff") for t in state(client)["tabs"])
    assert handoff(client, ws, sent["id"]).status_code == 400
    assert ws.qmd("talk").read_text() == before
