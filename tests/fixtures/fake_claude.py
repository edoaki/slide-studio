"""テスト用の claude。`claude -p --output-format stream-json` と同じ形のイベントを出す。

命令は fake_codex.py と同じ（[指示] の行を ; で区切る）。`auth status` はログイン済みと答える。
実行ごとの引数とプロンプトを .slide-studio/fake-claude/<n>.json に残す。
`--input-format stream-json` なら起動したまま、標準入力の user のメッセージごとに1回ずつ動く（同じ会話。turn に何回目かを残す）。
"""
import json
import os
import re
import sys
import uuid
from pathlib import Path

from fake_codex import apply, emit, log_run
from slide_studio.fsutil import write_atomic


def main(argv):
    if argv[:2] == ["auth", "status"]:
        print(json.dumps({"loggedIn": True, "authMethod": "claude.ai"}))
        return 0
    assert argv[0] == "-p" and "stream-json" in argv
    session = argv[argv.index("--resume") + 1] if "--resume" in argv else str(uuid.uuid4())
    if "--input-format" in argv:
        for n, line in enumerate(sys.stdin):
            message = json.loads(line)
            assert message["type"] == "user"
            turn(argv, message["message"]["content"][0]["text"], session, n)
        return 0
    return turn(argv, argv[-1], session, 0)


def turn(argv, prompt, session, n):
    root = Path(os.environ.get('FAKE_STUDIO_ROOT') or os.environ.get('SLIDE_STUDIO_HOME') or Path.cwd())
    review = '--json-schema' in argv and 'issues' in json.loads(argv[argv.index('--json-schema') + 1]).get('properties', {})
    log_run(root, 'fake-claude-review' if review else 'fake-claude', argv, prompt, turn=n)
    model = "claude-" + argv[argv.index("--model") + 1] + "-5-5"
    if review:
        issues = []
        ng = root / '.slide-studio' / 'fake-reviewng'
        if ng.exists():
            remaining = int(ng.read_text().strip() or '1')
            if remaining > 0:
                issues = [{'target': '全体', 'message': 'テストの指摘', 'suggestion': '直してください'}]
                if remaining == 1:
                    ng.unlink()
                else:
                    write_atomic(ng, str(remaining - 1))
        emit({'type':'system','subtype':'init','session_id':session})
        emit({'type':'result','subtype':'success','is_error':False,'session_id':session,'structured_output':{'summary':'確認しました','issues':issues}})
        return 0
    deck = re.search(r"\[発表\] decks/([^/]+)/slides.qmd", prompt)[1]
    qmd = root / "decks" / deck / "slides.qmd"
    emit({"type": "system", "subtype": "init", "session_id": session, "model": model})
    usage = {"input_tokens": 10, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 20000, "output_tokens": 90}
    results = []
    for i, text in enumerate(re.findall(r"^\[指示\] (.*)$", prompt, re.M), 1):
        ok = True
        for n, cmd in enumerate(c.strip() for c in text.split(";") if c.strip()):
            tid = f"toolu_{i}_{n}"
            emit({"type": "assistant", "session_id": session, "message": {"id": f"m{i}{n}", "usage": usage,
                  "content": [{"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": cmd}}]}})
            ok = apply(root, qmd, cmd) and ok
            emit({"type": "user", "session_id": session, "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "is_error": False}]}})
        results.append({"item": i, "ok": ok, "text": "対応しました" if ok else "できませんでした"})
    final = {"summary": f"{len(results)}件に対応しました。", "results": results}
    emit({"type": "assistant", "session_id": session, "message": {"id": "mz", "usage": usage, "content": [{"type": "text", "text": "終わりました。"}]}})
    emit({"type": "result", "subtype": "success", "is_error": False, "session_id": session, "result": json.dumps(final, ensure_ascii=False),
          "structured_output": final, "modelUsage": {model: {"contextWindow": 1000000}}})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
