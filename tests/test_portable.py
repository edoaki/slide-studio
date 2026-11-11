import os
import shutil
import subprocess
import sys


def test_build_from_moved_folder_without_app(ws, tmp_path):
    ws.new_deck("talk", "research")
    moved = tmp_path / "資料 with spaces"
    shutil.move(ws.root, moved)
    # -I は元のリポジトリと PYTHONPATH を無視する。同梱コードだけで実行する。
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "SLIDE_STUDIO_HOME")}
    script = moved / "build.py"
    listed = subprocess.run([sys.executable, "-I", str(script), "--list"], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert listed.returncode == 0, listed.stderr
    assert listed.stdout.strip() == "talk"
    built = subprocess.run([sys.executable, "-I", str(script), "talk"], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)
    assert built.returncode == 0, built.stderr
    assert (moved / "decks/talk/発表タイトル.html").is_file()
    assert (moved / "decks/talk/発表タイトル.pdf").read_bytes().startswith(b"%PDF")


def test_portable_preserves_user_edits(ws):
    (ws.root / "README.md").write_text("自分の説明")
    (ws.root / "build.py").write_text("# custom build")
    ws.ensure()
    assert (ws.root / "README.md").read_text() == "自分の説明"
    assert (ws.root / "build.py").read_text() == "# custom build"
