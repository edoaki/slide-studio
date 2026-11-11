"""Slide Studio のコマンド。設計書 §11。"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .workspace import StudioError, Workspace, check_name, saved_root


def _ws(args) -> Workspace:
    return Workspace.open(args.root)


def cmd_doctor(args) -> int:
    from . import doctor

    report = doctor.run_all()
    print(f"置き場: {Workspace.open(args.root, ensure=False).root}")
    for item in report.items:
        mark = "✓" if item.ok else "✗"
        print(f"{mark} {item.name}: {item.detail}")
        if not item.ok and item.fix:
            print(f"    対処: {item.fix}")
    return 0 if report.ok else 1


def cmd_new(args) -> int:
    ws = _ws(args)
    dest = ws.new_deck(args.deck, args.topic, args.theme, args.source)
    print(dest / "slides.qmd")
    return 0


def cmd_import(args) -> int:
    from .importer import import_deck

    ws = _ws(args)
    dest = import_deck(ws, Path(args.path), args.topic, name=args.name, theme=args.theme)
    print(dest / "slides.qmd")
    return 0


def cmd_fig(args) -> int:
    from . import figures

    ws = _ws(args)
    if args.fig_command == "new":
        if args.deck:
            shelf = ws.deck_shelf(args.deck)
        elif args.shelf:
            shelf = check_name(args.shelf, "トピックの名前")
        else:
            raise StudioError("--shelf か --deck を指定してください")
        figures.new_figure(ws, args.name, ws.shelf_dir(shelf), title=args.title)
        print(f"{{{{< fig {shelf}/{args.name} >}}}}")
        print(ws.shelf_dir(shelf) / args.name / "figure.mjs", file=sys.stderr)
    return 0


def cmd_check(args) -> int:
    from . import check

    ws = _ws(args)
    if not args.figure and not args.deck:
        raise StudioError("発表の名前か --figure を指定してください")
    from .ai import bridge
    if bridge.in_sandbox():
        # AI の sandbox では Chromium が起動しないので、起動中のアプリに検査を頼む
        out = bridge.request_check(ws, args.deck, page=args.page, figure=args.figure)
        if out is not None:
            print(out["summary"])
            return 1 if out["errors"] else 0
    if args.figure:
        result = check.check_figure(ws, args.figure)
    else:
        if not args.deck:
            raise StudioError("発表の名前か --figure を指定してください")
        result = check.check_deck(ws, args.deck, page=args.page)
    print(check.summary(result))
    return 1 if result["errors"] else 0


def cmd_build(args) -> int:
    from . import export

    ws = _ws(args)
    out = export.build(ws, args.deck, force=args.force)
    for path in out:
        print(path)
    return 0


def cmd_audit(args) -> int:
    from .ai import audit_tools, bridge

    if args.audit_command == "tools":
        print(json.dumps(audit_tools.TOOLS, ensure_ascii=False, indent=2))
        return 0
    ws = _ws(args)
    arguments = {"deck": args.deck}
    if args.audit_command in ("review", "status"):
        arguments["audit_id"] = args.audit_id
    if args.audit_command == "review":
        try:
            body = json.loads(sys.stdin.read() if args.file == "-" else Path(args.file).read_text())
        except (OSError, ValueError) as e:
            raise StudioError(f"確認結果の JSON を読めません: {e}") from e
        if not isinstance(body, dict) or set(body) != {"reviewer", "states", "decisions", "visual_issues"}:
            raise StudioError("確認結果には reviewer・states・decisions・visual_issues を指定してください")
        arguments.update(body)

    def run_audit(deck):
        if bridge.in_sandbox():
            out = bridge.request_audit(ws, deck)
            if out is not None:
                if "result" not in out:
                    raise StudioError(out.get("summary", "監査を実行できませんでした"))
                return out["result"]
        from . import audit
        return audit.run(ws, deck)

    result = audit_tools.execute(ws, "audit_" + args.audit_command, arguments, run_audit=run_audit)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    # 未確認も成功扱いにしない。JSON は終了コードに関係なく読み取る。
    return 0 if result["complete"] else 1


def cmd_consult(args) -> int:
    from .ai import bridge

    question = sys.stdin.read() if args.question == "-" else args.question
    if not question.strip():
        raise StudioError("相談の内容が空です")
    out = bridge.request_consult(_ws(args), args.tab, question.strip())
    if out is None:
        raise StudioError("相談できるのは、アプリのチャットで AI が作業している間だけです")
    if "answer" not in out:
        raise StudioError(out.get("summary", "相談できませんでした"))
    print(out["answer"])
    return 0


def cmd_serve(args) -> int:
    from . import server

    explicit = args.root or os.environ.get("SLIDE_STUDIO_HOME")
    root = explicit or saved_root()
    # 初回・保存先の消失時は作成せずに選択画面へ。明示指定は自動化用として優先。
    ws = Workspace.open(root) if explicit or (root and root.is_dir()) else None
    server.serve(ws, open_deck=getattr(args, "deck", None), port=args.port, open_browser=not args.no_browser)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="slide-studio", description="Slide Studio")
    parser.add_argument("--root", help="置き場（SLIDE_STUDIO_HOME・保存済みの場所を優先。初期候補は ~/Slides）")
    parser.add_argument("--port", type=int, default=4320)
    parser.add_argument("--no-browser", action="store_true", help="ブラウザを開かない")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("open", help="起動して発表を開く")
    p.add_argument("deck")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("new", help="発表を作る")
    p.add_argument("deck")
    p.add_argument("--topic", "--figures", dest="topic", required=True, help="トピック")
    p.add_argument("--theme", default="default")
    p.add_argument("--from", dest="source", help="複製する元の発表")
    p.set_defaults(func=cmd_new)

    p = sub.add_parser("import", help="quarto-html の発表を取り込む")
    p.add_argument("path")
    p.add_argument("--topic", "--figures", dest="topic", required=True, help="トピック")
    p.add_argument("--name", help="発表の名前（既定はフォルダ名）")
    p.add_argument("--theme", default="default")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("fig", help="図")
    fsub = p.add_subparsers(dest="fig_command", required=True)
    q = fsub.add_parser("new", help="図を雛形から作る")
    q.add_argument("name")
    q.add_argument("--shelf")
    q.add_argument("--deck")
    q.add_argument("--title")
    p.set_defaults(func=cmd_fig)

    p = sub.add_parser("check", help="検査")
    p.add_argument("deck", nargs="?")
    p.add_argument("--page", help="ページ ID")
    p.add_argument("--figure", help="トピック/名前")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("audit", help="エージェント用の監査ツール（JSON）")
    a = p.add_subparsers(dest="audit_command", required=True)
    a.add_parser("tools", help="ツール定義を取得")
    a.add_parser("run", help="全ページ・全stepを監査").add_argument("deck")
    for name in ("review", "status"):
        q = a.add_parser(name)
        q.add_argument("deck")
        q.add_argument("audit_id")
        if name == "review":
            q.add_argument("--file", required=True, help="画像の所見と問題の判断を記した JSON（- は標準入力）")
    p.set_defaults(func=cmd_audit)

    p = sub.add_parser("consult", help="作業中の AI から相談役に質問する（アプリの中だけ）")
    p.add_argument("--tab", required=True, help="チャットのタブ（依頼文の [相談役] にある）")
    p.add_argument("question", help="質問（- は標準入力）")
    p.set_defaults(func=cmd_consult)

    p = sub.add_parser("build", help="単一 HTML と PDF を書き出す")
    p.add_argument("deck")
    p.add_argument("--force", action="store_true", help="検査のエラーがあっても書き出す")
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("doctor", help="環境の確認")
    p.set_defaults(func=cmd_doctor)

    args = parser.parse_args(argv)
    func = getattr(args, "func", cmd_serve)
    try:
        return func(args) or 0
    except StudioError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001
        from .render import RenderError

        if isinstance(e, RenderError):
            print(f"Pandoc のエラー:\n{e}", file=sys.stderr)
            return 1
        raise


if __name__ == "__main__":
    sys.exit(main())
