"""共通履歴のファイル操作。原稿とCSSの競合、ごみ箱の復元。"""
import pytest

from conftest import add_deck
from slide_studio import history, materials
from slide_studio.fsutil import sha256_text, write_atomic
from slide_studio.workspace import StudioError


def test_style_and_source_round_trip(ws):
    d = add_deck(ws, "talk", "## A\n\n元。\n")
    css = d / "styles/slides.css"
    write_atomic(css, "/* 保つ */\n.x { color: red; }\n")
    before = ws.qmd("talk").read_text()
    result = history.style(ws, "talk", {"vars": {"--img-pad": "12px"},
                                         "text": "## A\n\n後。\n", "base": sha256_text(before)})
    assert result["vars"] == {"--img-pad": "12px"}
    assert ws.qmd("talk").read_text() == result["text"]
    undo = history.style(ws, "talk", {"css": result["before"], "css_base": result["css"],
                                      "text": before, "base": result["version"]})
    assert css.read_text() == result["before"]
    assert ws.qmd("talk").read_text() == before
    history.style(ws, "talk", {"css": result["css"], "css_base": undo["css"],
                                "text": result["text"], "base": undo["version"]})
    assert css.read_text() == result["css"]


@pytest.mark.parametrize("changed", ["css", "source"])
def test_style_conflict_changes_neither_file(ws, changed):
    d = add_deck(ws, "talk", "元")
    css = d / "styles/slides.css"
    write_atomic(css, "original")
    body = {"css": "undo", "css_base": "original", "text": "undo", "base": sha256_text("元")}
    write_atomic(css if changed == "css" else ws.qmd("talk"), "外で変更")
    before = css.read_bytes(), ws.qmd("talk").read_bytes()
    with pytest.raises(history.Conflict):
        history.style(ws, "talk", body)
    assert (css.read_bytes(), ws.qmd("talk").read_bytes()) == before


def test_style_undo_restores_missing_css(ws):
    d = add_deck(ws, "talk", "元")
    r = history.style(ws, "talk", {"vars": {"--gutter": "20px"}})
    assert r["before"] is None
    history.style(ws, "talk", {"css": None, "css_base": r["css"]})
    assert not (d / "styles/slides.css").exists()


def test_material_tree_delete_restore_redo(ws):
    add_deck(ws, "talk", "元")
    materials.add(ws, "talk", "results/run/a.csv", b"x,y\n1,2\n")
    materials.move(ws, "talk", "results", "renamed")
    for _ in range(2):
        r = materials.delete(ws, "talk", "renamed")
        assert not (materials.folder(ws, "talk") / "renamed").exists()
        materials.restore(ws, "talk", "renamed", r["trash"])
        assert (materials.folder(ws, "talk") / "renamed/run/a.csv").read_bytes() == b"x,y\n1,2\n"
    materials.move(ws, "talk", "renamed", "results")
    assert ws.qmd("talk").read_text() == "元"


def test_material_restore_does_not_overwrite(ws):
    add_deck(ws, "talk", "元")
    materials.add(ws, "talk", "a.txt", b"old")
    r = materials.delete(ws, "talk", "a.txt")
    materials.add(ws, "talk", "a.txt", b"new")
    with pytest.raises(StudioError):
        materials.restore(ws, "talk", "a.txt", r["trash"])
    assert (ws.root / r["trash"]).read_bytes() == b"old"
    assert (materials.folder(ws, "talk") / "a.txt").read_bytes() == b"new"


@pytest.mark.parametrize("trash", ["/tmp/a", ".slide-studio/trash/other/1/a", ".slide-studio/trash/talk/../../a", ""])
def test_material_restore_rejects_invalid_trash(ws, trash):
    add_deck(ws, "talk", "元")
    with pytest.raises(StudioError):
        materials.restore(ws, "talk", "a", trash)


def test_material_restore_rejects_symlink_parent(ws, tmp_path):
    add_deck(ws, "talk", "元")
    outside = tmp_path / "outside"
    outside.mkdir()
    write_atomic(outside / "a", "outside")
    trash = ws.state / "trash/talk"
    trash.mkdir(parents=True)
    (trash / "linked").symlink_to(outside, target_is_directory=True)
    with pytest.raises(StudioError):
        materials.restore(ws, "talk", "a", ".slide-studio/trash/talk/linked/a")
    assert (outside / "a").read_text() == "outside"
