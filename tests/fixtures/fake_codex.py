"""テスト用の codex。`codex exec --json` と同じ形のイベントを出し、[指示] の命令どおりにファイルを変える。

命令（; で区切る）：
  replace A => B   発表の slides.qmd の A を B に置き換える（下書きのチャットでは memo.md）
  fixwith A => B   今は変えず、replace A => B を .slide-studio/fake-fix に1行追記する
  add PATH         置き場の PATH にファイルを作る
  delete PATH      置き場の PATH を消す
  sleep N          N 秒待つ（子プロセスの sleep を起こし、その pid を .slide-studio/fake-child.pid に書く）
  fail             その件を ok=false で報告する
  slides TEXT      下書きのチャットで、返事の slides に TEXT を入れる（スライドへの引き渡し）
  rebuild          下書きのチャットで、返事の rebuild を true にする（スライドの作り直し）
  reviewng [N]     次の N 回の確認役が直す所を1件挙げる（省略は1回）
[検査のエラー]・[確認役の指摘] の依頼では、fake-fix の先頭の1行だけ取り出して実行する（空なら何もしない）。
テーマのチャットでは replace・fixwith の対象は [テーマ] の CSS。
下書きのチャットでは最後に {reply, slides, rebuild}、テーマのチャットでは普通の文章を返す。
編集担当の引数とプロンプトを .slide-studio/fake-codex/<n>.json に残す。
App Server の全担当の RPC は .slide-studio/fake-app-server/<n>.json に残す（確認役はここだけ）。
FAKE_CODEX_THREAD_ERROR があれば、thread/start をその文のエラーで断る（Codex の英語のエラー）。
`debug models` はモデルの一覧を出し、CODEX_HOME があればセッションの記録（rollout）に使用量を書く。
"""
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

from slide_studio.fsutil import write_atomic


def emit(ev):
    print(json.dumps(ev, ensure_ascii=False), flush=True)


MODELS = {"models": [
    {"slug": "test-big", "display_name": "Test Big", "default_reasoning_level": "medium", "visibility": "list", "priority": 1,
     "context_window": 200000, "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium", "high", "xhigh")]},
    {"slug": "test-small", "display_name": "Test Small", "default_reasoning_level": "low", "visibility": "list", "priority": 2,
     "context_window": 100000, "supported_reasoning_levels": [{"effort": e} for e in ("low", "medium")]},
    {"slug": "test-hidden", "display_name": "Hidden", "visibility": "hide", "priority": 3},
]}


def apply(root: Path, qmd: Path, cmd: str) -> bool:
    """命令を1つ実行する。fail なら False。"""
    if cmd.startswith("replace "):
        a, b = cmd[len("replace "):].split(" => ")
        write_atomic(qmd, qmd.read_text().replace(a, b))
    elif cmd.startswith("fixwith "):
        with (root / ".slide-studio" / "fake-fix").open("a") as f:
            f.write("replace " + cmd[len("fixwith "):] + "\n")
    elif cmd.startswith("add "):
        p = root / cmd[4:]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("added\n")
    elif cmd.startswith("delete "):
        (root / cmd[7:]).unlink()
    elif cmd.startswith("sleep "):
        child = subprocess.Popen(["sleep", "60"])
        (root / ".slide-studio" / "fake-child.pid").write_text(str(child.pid))
        time.sleep(float(cmd[6:]))
    elif cmd == "fail":
        return False
    elif cmd.startswith("slides "):
        (root / ".slide-studio" / "fake-slides").write_text(cmd[7:])
    elif cmd == "reviewng" or cmd.startswith("reviewng "):
        count = int(cmd.split()[1]) if len(cmd.split()) > 1 else 1
        write_atomic(root / ".slide-studio" / "fake-reviewng", str(count))
    elif cmd == "rebuild":
        (root / ".slide-studio" / f"fake-{cmd}").write_text("1")
    return True


def log_run(root: Path, name: str, argv: list, prompt: str, **extra) -> None:
    log = root / ".slide-studio" / name
    log.mkdir(parents=True, exist_ok=True)
    n = len(list(log.glob("*.json")))
    (log / f"{n}.json").write_text(json.dumps({"argv": argv, "prompt": prompt, "env_home": os.environ.get("SLIDE_STUDIO_HOME"),
                                               "sandbox": os.environ.get("SLIDE_STUDIO_SANDBOX"), "pid": os.getpid(), **extra}, ensure_ascii=False))


def app_server():
    global emit
    output = emit
    thread, options = None, {}
    threads = {}  # この app-server に読み込んだ thread → thread/start・resume の引数（起動したまま使うとき）
    time.sleep(float(os.environ.get('FAKE_CODEX_STARTUP') or 0))  # 起動にかかる時間（起動したままにする効果を測る）
    def notification(ev):
        t = ev['type']
        if t.startswith('item.'):
            item = dict(ev['item'])
            item['type'] = {'agent_message': 'agentMessage', 'command_execution': 'commandExecution'}.get(item['type'], item['type'])
            if 'exit_code' in item:
                item['exitCode'] = item.pop('exit_code')
            output({'method': t.replace('.', '/'), 'params': {'threadId': thread, 'turnId': 'turn-1', 'item': item}})
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' not in request:
            continue
        method, params = request['method'], request.get('params', {})
        result = {}
        if method == 'account/read':
            result = {'account': None if os.environ.get('FAKE_CODEX_LOGGED_OUT') else {'type': 'chatgpt', 'email': 'test@example.com', 'planType': 'plus'}}
        elif method == 'model/list':
            result = {'data': [{'id': m['slug'], 'displayName': m['display_name'], 'hidden': m.get('visibility') == 'hide',
                               'supportedReasoningEfforts': [{'reasoningEffort': x['effort']} for x in m.get('supported_reasoning_levels', [])],
                               'defaultReasoningEffort': m.get('default_reasoning_level'), 'isDefault': m['slug'] == 'test-big',
                               'contextWindow': int(m.get('context_window', 0) * .95)} for m in MODELS['models']], 'nextCursor': None}
        elif method == 'account/rateLimits/read':
            result = {'rateLimits': {'primary': {'usedPercent': 12, 'windowDurationMins': 300, 'resetsAt': 4102444800},
                                     'secondary': {'usedPercent': 40, 'windowDurationMins': 10080, 'resetsAt': 4102444800}}}
        elif method == 'thread/start' and os.environ.get('FAKE_CODEX_THREAD_ERROR'):
            output({'id': request['id'], 'error': {'code': -32603, 'message': os.environ['FAKE_CODEX_THREAD_ERROR']}})
            continue
        elif method in ('thread/start', 'thread/resume'):
            thread = params.get('threadId') or str(uuid.uuid4())
            threads[thread] = {**params, 'resumed': method == 'thread/resume'}
            result = {'thread': {'id': thread}}
        elif method == 'thread/fork':
            thread = str(uuid.uuid4())
            threads[thread] = {**params, 'resumed': False, 'forked': params['threadId']}
            result = {'thread': {'id': thread}}
        elif method == 'turn/start':
            thread = params['threadId']
            options = threads[thread]
            result = {'turn': {'id': 'turn-1'}}
        elif method == 'account/login/start':
            result = {'type': 'chatgpt', 'loginId': 'login-1', 'authUrl': 'https://auth.openai.com/test'}
        output({'id': request['id'], 'result': result})
        if method == 'account/login/start':
            output({'method': 'account/login/completed', 'params': {'loginId': 'login-1', 'success': True}})
        if method == 'turn/start':
            root = Path(os.environ.get('FAKE_STUDIO_ROOT') or os.environ.get('SLIDE_STUDIO_HOME') or options['cwd'])
            log_run(root, 'fake-app-server', sys.argv[1:], json.dumps({'thread': {k: v for k, v in options.items() if k != 'resumed'}, 'turn': params,
                                                                       'pid': os.getpid(), 'turns_in_thread': options.setdefault('turns', 0)}),
                    time=time.time())
            options['turns'] += 1
            if 'issues' in (params.get('outputSchema') or {}).get('properties', {}):
                limit = root / '.slide-studio' / 'fake-review-limit'
                if limit.exists():
                    limit.unlink()
                    output({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': 'turn-1', 'status': 'failed', 'error': {'message': 'Usage limit reached'}}}})
                    continue
                ng = root / '.slide-studio' / 'fake-reviewng'
                issues = []
                if ng.exists():
                    remaining = int(ng.read_text().strip() or '1')
                    if remaining > 0:
                        issues = [{'target': '全体', 'message': 'テストの指摘', 'suggestion': '直してください'}]
                        if remaining == 1:
                            ng.unlink()
                        else:
                            write_atomic(ng, str(remaining - 1))
                final = {'summary': '確認しました', 'issues': issues}
                output({'method': 'item/completed', 'params': {'threadId': thread, 'item': {'type': 'agentMessage', 'id': 'review-final', 'text': json.dumps(final)}}})
                output({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': 'turn-1', 'status': 'completed'}}})
                continue
            argv = ['exec', '--json', '-C', str(root), '-m', options['model']]
            if params.get('effort'):
                argv += ['-c', 'model_reasoning_effort="' + params['effort'] + '"']
            if params.get('outputSchema'):
                argv += ['--output-schema', 'schema.json']
            argv += ['--image=' + x['path'] for x in params['input'] if x['type'] == 'localImage']
            if options.get('threadId') or options['turns'] > 1:
                argv += ['resume', thread]
            # Keep legacy fixture log assertions, while the actual transport is RPC.
            argv += [params['input'][0]['text']]
            emit = notification
            main(argv)
            emit = output
            limit = root / '.slide-studio' / 'fake-edit-limit'
            if limit.exists():
                limit.unlink()
                output({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': 'turn-1', 'status': 'failed', 'error': {'message': 'Usage limit reached'}}}})
                continue
            output({'method': 'thread/tokenUsage/updated', 'params': {'threadId': thread, 'tokenUsage': {'last': {'totalTokens': 47500}, 'modelContextWindow': 190000}}})
            output({'method': 'account/rateLimits/updated', 'params': {'rateLimits': {'primary': {'usedPercent': 30, 'windowDurationMins': 300, 'resetsAt': 4102444800}}}})
            output({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': 'turn-1', 'status': 'completed'}}})
    return 0


def main(argv):
    if argv[0] == "app-server":
        return app_server()
    if argv[:2] == ["debug", "models"]:
        print(json.dumps(MODELS))
        return 0
    if argv[:2] == ["login", "status"]:
        if os.environ.get("FAKE_CODEX_LOGGED_OUT"):
            print("Not logged in")
            return 1
        print("Logged in using ChatGPT")
        return 0
    assert argv[0] == "exec" and "--json" in argv
    root = Path(argv[argv.index("-C") + 1])
    session = argv[argv.index("resume") + 1] if "resume" in argv else None
    prompt = argv[-1]
    log_run(root, "fake-codex", argv, prompt)
    context = prompt
    if "[確認役の指摘]" in prompt:
        # 直しの依頼は対象を繰り返さない。同じ thread の最初の依頼から対象を引き継ぐ。
        for path in sorted((root / ".slide-studio/fake-app-server").glob("*.json"), key=lambda p: int(p.stem)):
            rpc = json.loads(json.loads(path.read_text())["prompt"])
            if rpc["turn"]["threadId"] == session:
                context = rpc["turn"]["input"][0]["text"]
                break
    memo = "「下書き」チャットからの依頼" in context and re.search(r"\[下書き\] decks/([^/]+)/memo.md", context)
    theme = re.search(r"\[テーマ\] (themes/[^/]+.css)", context)
    if theme:
        qmd = root / theme[1]
    elif memo:
        qmd = root / "decks" / memo[1] / "memo.md"
        if not qmd.exists():
            qmd.write_text("")
    else:
        qmd = root / "decks" / re.search(r"\[発表\] decks/([^/]+)/slides.qmd", context)[1] / "slides.qmd"
    thread = session or str(uuid.uuid4())
    emit({"type": "thread.started", "thread_id": thread})
    emit({"type": "turn.started"})
    emit({"type": "item.completed", "item": {"id": "item_0", "type": "agent_message", "text": "始めます。"}})
    results = []
    instructions = re.findall(r"^\[(?:指示|依頼)\] (.*)$", prompt, re.M)
    if "[検査のエラー]" in prompt.splitlines() or "[確認役の指摘]" in prompt:
        pending = root / ".slide-studio" / "fake-fix"
        commands = pending.read_text().splitlines(keepends=True) if pending.exists() else []
        instructions = commands[:1]
        if commands:
            pending.write_text("".join(commands[1:]))
    for i, text in enumerate(instructions, 1):
        ok = True
        for cmd in [c.strip() for c in text.split(";") if c.strip()]:
            iid = f"c{i}-{abs(hash(cmd)) % 10000}"
            emit({"type": "item.started", "item": {"id": iid, "type": "command_execution", "command": f'/bin/zsh -lc "{cmd}"', "status": "in_progress"}})
            ok = apply(root, qmd, cmd) and ok
            emit({"type": "item.completed", "item": {"id": iid, "type": "command_execution", "command": f'/bin/zsh -lc "{cmd}"', "exit_code": 0, "status": "completed"}})
        results.append({"item": i, "ok": ok, "text": "対応しました" if ok else "できませんでした"})
    final = {"summary": f"{len(results)}件に対応しました。", "results": results}
    ask = root / ".slide-studio" / "fake-questions"
    if ask.exists():
        final["questions"] = json.loads(ask.read_text())
        ask.unlink()
    if memo:
        handoff = root / ".slide-studio" / "fake-slides"
        slides = handoff.read_text() if handoff.exists() else ""
        handoff.unlink(missing_ok=True)
        rebuild = root / ".slide-studio" / "fake-rebuild"
        final = {"reply": "下書きを**直しました**。\n- 背景を足した", "slides": slides, "rebuild": rebuild.exists()}
        rebuild.unlink(missing_ok=True)
    text = json.dumps(final, ensure_ascii=False) if "--output-schema" in argv else "テーマを**直しました**。"
    emit({"type": "item.completed", "item": {"id": "item_9", "type": "agent_message", "text": text}})
    emit({"type": "turn.completed", "usage": {}})
    if os.environ.get("CODEX_HOME"):
        d = Path(os.environ["CODEX_HOME"]) / "sessions" / "2026" / "10" / "29"
        d.mkdir(parents=True, exist_ok=True)
        info = {"last_token_usage": {"total_tokens": 47500}, "model_context_window": 190000}
        with (d / f"rollout-2026-10-29T00-00-00-{thread}.jsonl").open("a") as f:
            f.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": info}}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
