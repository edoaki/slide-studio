"""発表の参考資料（materials.py）と、控え・描き直し・AI への指示での扱い（ブラウザ不要）。"""
import pytest
from starlette.testclient import TestClient

from conftest import add_deck
from e2e.conftest import DECK
from slide_studio import materials, snapshot
from slide_studio.fsutil import write_atomic
from slide_studio.server import build_app
from slide_studio.workspace import StudioError


@pytest.fixture
def deck(ws):
    return add_deck(ws, "talk", DECK)


def test_add_keeps_folder_layout_reuses_and_never_overwrites(ws, deck):
    assert materials.add(ws, "talk", "results/run1/loss.csv", b"a,b\n") == {"path": "results/run1/loss.csv", "reused": False}
    assert materials.add(ws, "talk", "results/run1/loss.csv", b"a,b\n")["reused"] is True
    assert materials.add(ws, "talk", "results/run1/loss.csv", b"other")["path"] == "results/run1/loss-2.csv"
    assert materials.add(ws, "talk", "テンプレート.pptx", b"PK")["path"] == "テンプレート.pptx"
    base = deck / "materials"
    assert (base / "results" / "run1" / "loss.csv").read_bytes() == b"a,b\n"
    assert (base / "テンプレート.pptx").read_bytes() == b"PK"


@pytest.mark.parametrize("path", ["../x.txt", "a/../../x", ".hidden", "a/.git/config", "", "/"])
def test_add_rejects_paths_outside_or_hidden(ws, deck, path):
    with pytest.raises(StudioError):
        materials.add(ws, "talk", path, b"x")
    assert not (deck / "materials").exists()


def test_listing_is_tree_ordered(ws, deck):
    assert materials.listing(ws, "talk") == {"path": "decks/talk/materials", "entries": [], "more": 0}
    for rel in ["b.txt", "A/z.csv", "A/sub/y.csv", "a2/x.txt", ".DS_Store"]:
        write_atomic(deck / "materials" / rel, "x")
    out = materials.listing(ws, "talk")
    assert [(e["path"], e["dir"]) for e in out["entries"]] == [
        ("A", True), ("A/sub", True), ("A/sub/y.csv", False), ("A/z.csv", False),
        ("a2", True), ("a2/x.txt", False), ("b.txt", False)]
    assert out["entries"][-1]["size"] == 1 and out["more"] == 0


def test_listing_keeps_siblings_after_large_folder(ws, deck):
    base = deck / "materials"
    for i in range(501):
        write_atomic(base / "animations" / f"{i}.txt", "x")
    for rel in ["score-table/slides.md", "実験結果/results.csv", "notes.txt"]:
        write_atomic(base / rel, "x")
    out = materials.listing(ws, "talk")
    paths = [e["path"] for e in out["entries"]]
    assert len(paths) == 507 and out["more"] == 0
    assert paths[-5:] == ["score-table", "score-table/slides.md", "実験結果", "実験結果/results.csv", "notes.txt"]
    assert "score-table/" in materials.prompt_lines(ws, "talk")[0]
    assert "実験結果/" in materials.prompt_lines(ws, "talk")[0]


def test_open_in_os_creates_folder_and_stays_inside(ws, deck, monkeypatch):
    opened = []
    monkeypatch.setattr(materials, "OPENER", opened.append)
    assert materials.open_in_os(ws, "talk") == "decks/talk/materials"
    assert (deck / "materials").is_dir()
    write_atomic(deck / "materials" / "a.txt", "x")
    materials.open_in_os(ws, "talk", "a.txt")
    assert opened == [deck / "materials", deck / "materials" / "a.txt"]
    for bad in ["missing.txt", "../slides.qmd"]:
        with pytest.raises(StudioError):
            materials.open_in_os(ws, "talk", bad)
    assert len(opened) == 2


def test_copy_in_keeps_layout_reuses_and_never_overwrites(ws, deck, tmp_path):
    src = tmp_path / "pc"
    write_atomic(src / "results" / "run1" / "loss.csv", "a,b\n")
    write_atomic(src / "results" / ".DS_Store", "x")
    write_atomic(src / "テンプレート.pptx", "PK")
    out = materials.copy_in(ws, "talk", "", [str(src / "results"), str(src / "テンプレート.pptx"), str(src / "none.txt")])
    assert out == {"added": ["results", "テンプレート.pptx"], "reused": 0}
    base = deck / "materials"
    assert (base / "results" / "run1" / "loss.csv").read_text() == "a,b\n"
    assert not (base / "results" / ".DS_Store").exists()
    # 同じ中身のファイルはそれを使う。フォルダと違う中身は -2 にする（上書きしない）
    assert materials.copy_in(ws, "talk", "", [str(src / "テンプレート.pptx")]) == {"added": [], "reused": 1}
    write_atomic(src / "テンプレート.pptx", "PK2")
    assert materials.copy_in(ws, "talk", "", [str(src / "テンプレート.pptx"), str(src / "results")]) == {
        "added": ["テンプレート-2.pptx", "results-2"], "reused": 0}
    assert (base / "テンプレート.pptx").read_text() == "PK"
    # 選んでいるフォルダの中へ。無いフォルダ・外・参考資料の中のものは受け付けない
    assert materials.copy_in(ws, "talk", "results/run1", [str(src / "テンプレート.pptx")])["added"] == ["results/run1/テンプレート.pptx"]
    for path, sources in [("none", [str(src / "テンプレート.pptx")]), ("../x", [str(src / "テンプレート.pptx")]), ("", [str(base / "results")])]:
        with pytest.raises(StudioError):
            materials.copy_in(ws, "talk", path, sources)
    assert not [p for p in base.rglob(".*")]  # コピーの途中の隠した名前が残らない


def test_create_move_and_delete_to_trash(ws, deck):
    base = deck / "materials"
    assert materials.create(ws, "talk", "results", True) == {"path": "results"}
    assert materials.create(ws, "talk", "results/memo.md", False) == {"path": "results/memo.md"}
    assert (base / "results").is_dir() and (base / "results" / "memo.md").read_bytes() == b""
    with pytest.raises(StudioError, match="同じ名前"):
        materials.create(ws, "talk", "results", True)
    with pytest.raises(StudioError, match="フォルダがありません"):
        materials.create(ws, "talk", "none/a.txt", False)
    # 名前の変更・移動。行き先に同じ名前があれば動かさない
    assert materials.move(ws, "talk", "results/memo.md", "results/notes.md") == {"path": "results/notes.md"}
    materials.create(ws, "talk", "old", True)
    assert materials.move(ws, "talk", "results/notes.md", "old/notes.md") == {"path": "old/notes.md"}
    materials.create(ws, "talk", "results/notes.md", False)
    with pytest.raises(StudioError, match="同じ名前"):
        materials.move(ws, "talk", "results/notes.md", "old/notes.md")
    with pytest.raises(StudioError, match="自分の中"):
        materials.move(ws, "talk", "old", "old/sub/old")
    assert materials.move(ws, "talk", "old", "Old") == {"path": "Old"}  # 大文字・小文字だけの変更
    for bad in [("../slides.qmd", "x"), ("Old", "../x"), ("Old", ".hidden")]:
        with pytest.raises(StudioError):
            materials.move(ws, "talk", *bad)
    # 削除は .slide-studio/trash/ へ移す
    out = materials.delete(ws, "talk", "Old")
    assert out["path"] == "Old" and out["trash"].startswith(".slide-studio/trash/talk/")
    assert not (base / "Old").exists() and (ws.root / out["trash"] / "notes.md").is_file()
    with pytest.raises(StudioError):
        materials.delete(ws, "talk", "Old")


def test_snapshot_skips_materials_and_restore_keeps_them(ws, deck):
    write_atomic(deck / "materials" / "big.bin", b"\x00" * 10)
    snap = snapshot.take(ws, "talk")
    assert not (snap.path / "files" / "decks" / "talk" / "materials").exists()
    assert (snap.path / "files" / "decks" / "talk" / "slides.qmd").is_file()
    # 実行中に参考資料が変わっても、範囲の外として出すだけで戻さない
    write_atomic(deck / "materials" / "big.bin", b"\x01" * 11)
    write_atomic(deck / "materials" / "new.txt", "x")
    write_atomic(ws.qmd("talk"), DECK + "\n追加\n")
    result = snapshot.changes(ws, snap)
    assert result["modified"] == ["decks/talk/slides.qmd"]
    assert result["outside"] == ["decks/talk/materials/big.bin", "decks/talk/materials/new.txt"]
    snapshot.restore(ws, snap)
    assert ws.qmd("talk").read_text() == DECK
    assert (deck / "materials" / "big.bin").read_bytes() == b"\x01" * 11
    assert (deck / "materials" / "new.txt").is_file()


def test_restore_run_does_not_touch_materials(ws, deck):
    snap = snapshot.take(ws, "talk")
    write_atomic(deck / "materials" / "out.csv", "x")
    write_atomic(deck / "images" / "plot.png", b"png")
    snapshot.finish(ws, snap)
    result = snapshot.restore_run(ws, snap)
    assert result["added"] == ["decks/talk/images/plot.png"] and result["outside"] == ["decks/talk/materials/out.csv"]
    assert not (deck / "images" / "plot.png").exists()
    assert (deck / "materials" / "out.csv").is_file()


def test_materials_do_not_rerender_and_copy_skips_them(ws, deck):
    srv = build_app(ws).state.studio
    srv.state("talk")
    assert srv.affected_decks([deck / "materials" / "log.txt", deck / "materials"]) == set()
    assert srv.affected_decks([deck / "images" / "a.png"]) == {"talk"}
    write_atomic(deck / "materials" / "a.txt", "x")
    ws.new_deck("copy", "test", source_deck="talk")
    assert not (ws.deck_dir("copy") / "materials").exists()
    assert (ws.deck_dir("copy") / "slides.qmd").is_file()


def test_prompt_lists_materials_once(ws, deck):
    chat = build_app(ws).state.chat
    items = [{"key": "one", "label": "p3 一枚目", "text": "結果を入れて"}, {"key": "deck", "label": "発表全体", "text": "直して"}]
    assert "[参考資料]" not in chat.prompt("talk", items)
    write_atomic(deck / "materials" / "results" / "loss.csv", "x")
    write_atomic(deck / "materials" / "template.pptx", "x")
    p = chat.prompt("talk", items)
    assert p.count("[参考資料]") == 1
    assert "[参考資料] decks/talk/materials/ に 3 件（読むだけ。変えない）：results/、template.pptx" in p


def test_materials_api(ws, deck, monkeypatch):
    opened = []
    monkeypatch.setattr(materials, "OPENER", opened.append)
    with TestClient(build_app(ws)) as client:
        r = client.post("/api/deck/talk/materials?path=data/a.csv", content=b"1,2\n")
        assert r.status_code == 200 and r.json() == {"path": "data/a.csv", "reused": False}
        assert client.post("/api/deck/talk/materials?path=../a", content=b"x").status_code == 400
        out = client.get("/api/deck/talk/materials").json()
        assert [e["path"] for e in out["entries"]] == ["data", "data/a.csv"]
        assert client.post("/api/deck/talk/materials/open", json={"path": "data/a.csv"}).json() == {
            "opened": "decks/talk/materials/data/a.csv"}
        assert client.post("/api/deck/talk/materials/open", json={"path": "nope"}).status_code == 400
        assert client.post("/api/deck/talk/materials/mkdir", json={"path": "新しいフォルダ"}).json() == {"path": "新しいフォルダ"}
        assert client.post("/api/deck/talk/materials/move", json={"path": "新しいフォルダ", "to": "結果"}).json() == {"path": "結果"}
        assert client.post("/api/deck/talk/materials/move", json={"path": "結果", "to": "../x"}).status_code == 400
        assert client.post("/api/deck/talk/materials/delete", json={"path": "結果"}).status_code == 200
        assert client.post("/api/deck/talk/materials/chmod", json={"path": "data"}).status_code == 404
        assert [e["path"] for e in client.get("/api/deck/talk/materials").json()["entries"]] == ["data", "data/a.csv"]
        assert client.get("/api/deck/none/materials").status_code == 404
    assert opened == [deck / "materials" / "data" / "a.csv"]
