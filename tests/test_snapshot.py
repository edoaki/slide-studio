"""AI 実行前の控えと、置き場に配る規則（ブラウザ不要）。"""
import json
import shutil

import pytest

from slide_studio import snapshot, workspace
from slide_studio.fsutil import sha256_bytes, write_atomic
from slide_studio.workspace import StudioError, Workspace
from conftest import add_deck

QMD = "---\ntitle: 発表\ntopic: test\ntheme: default\n---\n\n## 背景 {#background}\n\n本文\n"
EMPTY = {"added": [], "modified": [], "deleted": [], "outside": []}


def test_changes_and_restore_whole_scope(ws):
    deck = add_deck(ws, "talk", QMD, bib="元の文献\n")
    write_atomic(deck / "images" / "data.bin", b"\x00\xff")
    write_atomic(ws.shelf_dir("test") / "_lib" / "part.mjs", "export default 1;")
    write_atomic(ws.shelf_dir("test") / "unused" / "figure.mjs", "元の図")
    theme = ws.themes / "default.css"
    original_theme = theme.read_bytes()
    snap = snapshot.take(ws, "talk")
    manifest = json.loads((snap.path / "manifest.json").read_text())
    assert manifest["decks/talk/slides.qmd"] == sha256_bytes(QMD.encode())
    assert "AGENTS.md" in manifest
    assert ".agents/skills/slide-studio-slides/SKILL.md" in manifest
    assert not any(p == ".slide-studio" or p.startswith(".slide-studio/") for p in manifest)

    # 棚が書き換わっても、取得時の棚を復元する。
    write_atomic(ws.qmd("talk"), QMD.replace("topic: test", "topic: other"))
    write_atomic(ws.shelf_dir("test") / "new" / "figure.mjs", "新しい図")
    write_atomic(ws.shelf_dir("test") / "_lib" / "part.mjs", "export default 2;")
    write_atomic(ws.shelf_dir("test") / "unused" / "figure.mjs", "変更した図")
    write_atomic(theme, "変更したテーマ")
    (ws.topic_dir("test") / "reference.bib").unlink()
    (deck / "images" / "data.bin").unlink()
    (deck / "new-empty" / "nested").mkdir(parents=True)
    write_atomic(ws.state / "ignored.txt", "アプリの状態")

    expected = {
        "added": ["topics/test/html/new/figure.mjs"],
        "modified": ["decks/talk/slides.qmd", "topics/test/html/_lib/part.mjs",
                     "topics/test/html/unused/figure.mjs", "themes/default.css"],
        "deleted": ["decks/talk/images/data.bin", "topics/test/reference.bib"],
        "outside": [],
    }
    expected = {k: sorted(v) for k, v in expected.items()}
    assert snapshot.changes(ws, snap) == expected
    assert snapshot.restore(ws, snap) == expected
    assert ws.qmd("talk").read_text() == QMD
    assert (ws.topic_dir("test") / "reference.bib").read_text() == "元の文献\n"
    assert (deck / "images" / "data.bin").read_bytes() == b"\x00\xff"
    assert (ws.shelf_dir("test") / "_lib" / "part.mjs").read_text() == "export default 1;"
    assert (ws.shelf_dir("test") / "unused" / "figure.mjs").read_text() == "元の図"
    assert theme.read_bytes() == original_theme
    assert not (ws.shelf_dir("test") / "new").exists()
    assert not (deck / "new-empty").exists()
    assert (deck / "styles").is_dir()
    assert (ws.state / "ignored.txt").read_text() == "アプリの状態"
    assert snapshot.changes(ws, snap) == EMPTY
    assert snapshot.restore(ws, snap) == EMPTY


def test_outside_is_reported_and_not_restored(ws):
    add_deck(ws, "talk", QMD)
    other = add_deck(ws, "talk-extra", QMD.replace("test", "test-extra"), bib="文献")
    write_atomic(ws.shelf_dir("test-extra") / "old" / "figure.mjs", "元の図")
    snap = snapshot.take(ws, "talk")
    write_atomic(other / "slides.qmd", "別の発表の変更")
    (ws.topic_dir("test-extra") / "reference.bib").unlink()
    write_atomic(ws.shelf_dir("test-extra") / "new" / "figure.mjs", "新しい図")
    write_atomic(ws.shelf_dir("test-extra") / "old" / "figure.mjs", "変更した図")
    write_atomic(ws.root / "AGENTS.md", "規則の変更")
    outside = ["AGENTS.md", "topics/test-extra/reference.bib", "decks/talk-extra/slides.qmd",
               "topics/test-extra/html/new/figure.mjs", "topics/test-extra/html/old/figure.mjs"]
    expected = {**EMPTY, "outside": outside}
    expected = {k: sorted(v) for k, v in expected.items()}
    assert snapshot.changes(ws, snap) == expected
    assert snapshot.restore(ws, snap) == expected
    expected = {k: sorted(v) for k, v in expected.items()}
    assert snapshot.changes(ws, snap) == expected
    assert (other / "slides.qmd").read_text() == "別の発表の変更"
    assert not (ws.topic_dir("test-extra") / "reference.bib").exists()
    assert (ws.shelf_dir("test-extra") / "new" / "figure.mjs").read_text() == "新しい図"
    assert (ws.shelf_dir("test-extra") / "old" / "figure.mjs").read_text() == "変更した図"


def test_retention_and_reopen(ws, monkeypatch):
    add_deck(ws, "talk", QMD)
    add_deck(ws, "other", QMD)
    assert snapshot.latest(ws, "talk") is None
    assert snapshot.list_snapshots(ws, "talk") == []
    other = snapshot.take(ws, "other")
    # 同じ時刻に連続取得しても、既存の控えは上書きしない。
    monkeypatch.setattr(snapshot.time, "time_ns", lambda: 1234567890)
    items = [snapshot.take(ws, "talk") for _ in range(21)]
    assert snapshot.list_snapshots(ws, "talk") == list(reversed(items[1:]))
    assert not items[0].path.exists()
    assert len(list((ws.state / "snapshots" / "talk").iterdir())) == 20
    assert snapshot.list_snapshots(ws, "other") == [other]
    reopened = Workspace.open(ws.root)
    assert snapshot.latest(reopened, "talk") == items[-1]
    write_atomic(ws.qmd("talk"), "変更")
    snapshot.restore(reopened, snapshot.latest(reopened, "talk"))
    assert ws.qmd("talk").read_text() == QMD


def test_restore_deleted_scopes_and_file_directory_replacements(ws):
    deck = add_deck(ws, "talk", QMD)
    write_atomic(ws.shelf_dir("test") / "_lib" / "part.mjs", "元の部品")
    snap = snapshot.take(ws, "talk")
    shutil.rmtree(deck)
    write_atomic(deck, "フォルダの代わりのファイル")
    shutil.rmtree(ws.topic_dir("test"))
    shutil.rmtree(ws.themes)
    snapshot.restore(ws, snap)
    assert snapshot.changes(ws, snap) == EMPTY
    assert ws.qmd("talk").read_text() == QMD
    assert (ws.shelf_dir("test") / "_lib" / "part.mjs").read_text() == "元の部品"
    assert (ws.themes / "default.css").is_file()


def test_restore_removes_shelf_absent_at_take(ws):
    add_deck(ws, "talk", QMD)
    shutil.rmtree(ws.topic_dir("test"))
    snap = snapshot.take(ws, "talk")
    write_atomic(ws.shelf_dir("test") / "new" / "figure.mjs", "新しい図")
    snapshot.restore(ws, snap)
    assert not ws.shelf_dir("test").exists()


def test_symlinks_are_saved_without_following_targets(ws, tmp_path):
    deck = add_deck(ws, "talk", QMD)
    external = tmp_path / "external"
    write_atomic(external / "private.txt", "リンク先")
    (deck / "linked-dir").symlink_to(external, target_is_directory=True)
    (deck / "linked-file").symlink_to(external / "private.txt")
    (deck / "broken").symlink_to(external / "missing")
    snap = snapshot.take(ws, "talk")
    saved = snap.path / "files" / "decks" / "talk"
    assert (saved / "linked-dir").is_symlink()
    assert (saved / "linked-file").is_symlink()
    assert (saved / "broken").is_symlink()
    manifest = json.loads((snap.path / "manifest.json").read_text())
    assert "decks/talk/linked-dir/private.txt" not in manifest
    write_atomic(external / "private.txt", "リンク先の変更")
    assert snapshot.changes(ws, snap) == EMPTY
    (deck / "linked-file").unlink()
    (deck / "linked-file").symlink_to(external / "missing")
    (deck / "broken").unlink()
    (deck / "new-link").symlink_to(external, target_is_directory=True)
    assert snapshot.changes(ws, snap) == {
        "added": ["decks/talk/new-link"], "modified": ["decks/talk/linked-file"],
        "deleted": ["decks/talk/broken"], "outside": [],
    }
    snapshot.restore(ws, snap)
    assert (deck / "linked-file").readlink() == external / "private.txt"
    assert (deck / "broken").is_symlink()
    assert not (deck / "new-link").is_symlink()
    assert (external / "private.txt").read_text() == "リンク先の変更"


def test_restore_replaces_scope_symlink_without_touching_target(ws, tmp_path):
    deck = add_deck(ws, "talk", QMD)
    snap = snapshot.take(ws, "talk")
    external = tmp_path / "external"
    write_atomic(external / "private.txt", "リンク先")
    shutil.rmtree(deck)
    deck.symlink_to(external, target_is_directory=True)
    snapshot.restore(ws, snap)
    assert not deck.is_symlink()
    assert ws.qmd("talk").read_text() == QMD
    assert list(external.iterdir()) == [external / "private.txt"]
    assert (external / "private.txt").read_text() == "リンク先"


def test_restore_rejects_symlink_parent_before_any_removal(ws, tmp_path):
    add_deck(ws, "talk", QMD)
    snap = snapshot.take(ws, "talk")
    external = tmp_path / "external"
    write_atomic(external / "test" / "private.txt", "リンク先")
    shutil.rmtree(ws.topics)
    ws.topics.symlink_to(external, target_is_directory=True)
    write_atomic(ws.qmd("talk"), "復元前の変更")
    with pytest.raises(StudioError, match="シンボリックリンク"):
        snapshot.restore(ws, snap)
    assert ws.qmd("talk").read_text() == "復元前の変更"
    assert (external / "test" / "private.txt").read_text() == "リンク先"


def test_take_rejects_symlink_qmd(ws, tmp_path):
    add_deck(ws, "talk", QMD)
    external = tmp_path / "external.qmd"
    write_atomic(external, QMD)
    ws.qmd("talk").unlink()
    ws.qmd("talk").symlink_to(external)
    with pytest.raises(StudioError, match="シンボリックリンク"):
        snapshot.take(ws, "talk")
    assert snapshot.list_snapshots(ws, "talk") == []


def test_workspace_installs_agent_rules(ws):
    assert (ws.root / "AGENTS.md").is_file()
    assert (ws.root / "CLAUDE.md").read_text() == "@AGENTS.md\n"
    skill = ws.root / ".agents" / "skills" / "slide-studio-slides" / "SKILL.md"
    text = skill.read_text()
    link = ws.root / ".claude/skills/slide-studio-slides"
    assert link.is_symlink() and (link / "SKILL.md").samefile(skill)
    assert (ws.root / ".agents/skills/slide-studio-review/SKILL.md").is_file()
    known = json.loads((ws.state / "agent-files.json").read_text())
    for rel, digest in known.items():
        if rel == "_version":
            continue
        data = (ws.root / rel).read_bytes()
        assert b"{{ref:" not in data, rel
        assert digest == sha256_bytes(data)
    assert text.startswith("---\nname: slide-studio-slides\ndescription:")
    assert "slide-studio check <deck>" in text
    assert "slide-studio-status = {unverified}" in text


@pytest.mark.parametrize("edited", [False, True])
def test_workspace_removes_retired_agent_files(ws, tmp_path, monkeypatch, edited):
    # 本文の更新中でも、廃止後のテンプレートで移行を確かめる。
    templates = tmp_path / "templates"
    shutil.copytree(workspace.TEMPLATES, templates)
    shutil.rmtree(templates / "workspace/.agents/skills/slide-studio-audit", ignore_errors=True)
    monkeypatch.setattr(workspace, "TEMPLATES", templates)
    rel = ".agents/skills/slide-studio-audit/SKILL.md"
    link = ws.root / ".claude/skills/slide-studio-audit"
    link.symlink_to("../../.agents/skills/slide-studio-audit", target_is_directory=True)
    old = ws.root / rel
    original = "以前に配った確認用 skill\n"
    write_atomic(old, original)
    stamp = ws.state / "agent-files.json"
    known = json.loads(stamp.read_text())
    known[rel] = sha256_bytes(original.encode())
    write_atomic(stamp, json.dumps(known))
    if edited:
        write_atomic(old, "利用者が編集した skill\n")

    Workspace.open(ws.root)

    if edited:
        assert old.read_text() == "利用者が編集した skill\n"
        assert (link / "SKILL.md").is_file()
    else:
        assert not old.exists()
        assert not old.parent.exists()
        assert not link.is_symlink()
    remaining = json.loads(stamp.read_text())
    assert rel not in remaining
    assert remaining["_version"] == known["_version"]
