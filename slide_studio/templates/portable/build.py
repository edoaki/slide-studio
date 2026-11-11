# /// script
# requires-python = ">=3.13"
# dependencies = ["beautifulsoup4>=4.13", "playwright>=1.55", "pypdf>=6", "pyyaml>=6", "pypandoc_binary>=1.15"]
# ///
"""uv run build.py <発表名>。アプリ本体のインストールは不要。"""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / ".slide-studio" / "compiler"))


def main():
    parser = argparse.ArgumentParser(description="保管フォルダの原稿から HTML・PDF を生成")
    parser.add_argument("deck", nargs="?", help="発表名（decks/ のフォルダ名）")
    parser.add_argument("--list", action="store_true", help="発表の一覧")
    parser.add_argument("--html-only", action="store_true", help="ブラウザ不要の HTML 生成のみ（検査は省略）")
    parser.add_argument("--setup", action="store_true", help="PDF・検査用の Chromium を導入")
    args = parser.parse_args()
    if args.setup:
        return subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"]).returncode
    from slide_studio.workspace import Workspace, StudioError
    from slide_studio import export, pandoc_worker
    ws = Workspace(ROOT)
    if args.list:
        print("\n".join(ws.list_decks()))
        return 0
    if not args.deck:
        parser.error("発表名か --list / --setup を指定してください")
    try:
        ws.require_deck(args.deck)
        paths = [export.bundle_deck(ws, args.deck)] if args.html_only else export.build(ws, args.deck)
        for path in paths:
            print(path)
        return 0
    except StudioError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    finally:
        pandoc_worker.close()


if __name__ == "__main__":
    sys.exit(main())
