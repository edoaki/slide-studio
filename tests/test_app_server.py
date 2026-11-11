"""RPC 切断・失敗・ログイン失敗でも処理を成功扱いせず、子プロセスを回収する。"""
import asyncio
import sys
from pathlib import Path

import pytest

from slide_studio.ai.app_server import AppServerRun, Client
from slide_studio.ai.providers import Codex
from slide_studio.ai.providers import AppServerParser


SCRIPT = '''
import json, sys
for line in sys.stdin:
    r = json.loads(line)
    if 'id' not in r:
        continue
    method = r['method']
    if method == 'disconnect':
        sys.exit(0)
    result = {}
    if method == 'account/read':
        result = {'account': {'type': 'chatgpt'}}
    if method == 'thread/start':
        result = {'thread': {'id': 'thread-1'}}
    if method == 'turn/start':
        result = {'turn': {'id': 'turn-1'}}
    if method == 'account/login/start':
        result = {'authUrl': 'https://auth.openai.com/test'}
    print(json.dumps({'id': r['id'], 'result': result}), flush=True)
    if method == 'turn/start':
        print(json.dumps({'method': 'turn/completed', 'params': {'turn': {'id': 'turn-1', 'status': 'failed', 'error': {'message': 'quota exceeded'}}}}), flush=True)
    if method == 'account/login/start':
        print(json.dumps({'method': 'account/login/completed', 'params': {'success': False, 'error': 'denied'}}), flush=True)
'''
ARGV = [sys.executable, '-u', '-c', SCRIPT]


def test_all_clients_use_private_home(tmp_path, monkeypatch):
    import os
    from slide_studio.ai.providers import Codex
    shared = tmp_path / 'shared'
    private = tmp_path / 'private'
    monkeypatch.setenv('CODEX_HOME', str(shared))
    monkeypatch.setenv('SLIDE_STUDIO_CODEX_HOME', str(private))
    # env 無しのログイン・モデル検出も、env 付きの担当実行も同じ保存先。
    for env in (None, {**os.environ, 'SLIDE_STUDIO_SANDBOX': '1'}):
        client = Client(ARGV, env=env)
        assert client.env['CODEX_HOME'] == str(private)
        if env:
            assert client.env['SLIDE_STUDIO_SANDBOX'] == '1'
    assert private.is_dir() and not shared.exists()
    assert os.environ['CODEX_HOME'] == str(shared)
    monkeypatch.delenv('SLIDE_STUDIO_CODEX_HOME')
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    assert Codex.home() == tmp_path / '.config/slide-studio/codex'


def test_disconnect_fails_pending_rpc_and_reaps_process():
    async def check():
        client = await Client(ARGV).start()
        try:
            with pytest.raises(ValueError, match='接続が切れました'):
                await client.call('disconnect')
        finally:
            await client.close()
        assert client.proc.returncode is not None
    asyncio.run(check())


def test_failed_turn_is_not_success(tmp_path):
    async def check():
        run = AppServerRun(ARGV, tmp_path, None, AppServerParser(tmp_path), prompt='hi',
                           session=None, model_id='test', effort=None, images=[], schema=False)
        await run.run()
        assert run.returncode == 1
        assert run.errors == ['quota exceeded']
        assert run.proc.returncode is not None
    asyncio.run(check())


def test_login_failure_is_reported_and_process_closed(monkeypatch):
    monkeypatch.setattr('webbrowser.open', lambda url: True)
    clients = []
    init = Client.__init__

    def fake_app_server(self, argv):
        init(self, ARGV)
        clients.append(self)
    monkeypatch.setattr(Client, '__init__', fake_app_server)
    with pytest.raises(ValueError, match='denied'):
        asyncio.run(Codex().login('unused'))
    assert clients[0].proc.returncode is not None


# 起動したままの app-server（作業手順書 A6）。thread ごとに、少し待ってから完了を返す。2つの turn の通知が交互に届く。
LIVE = '''
import json, os, sys, threading, time, uuid
out = threading.Lock()
def emit(x):
    with out:
        print(json.dumps(x), flush=True)
def finish(thread, prompt):
    for i in range(3):
        time.sleep(0.05)
        emit({'method': 'item/completed', 'params': {'threadId': thread, 'item': {'type': 'agentMessage', 'id': f'{thread}-{i}', 'text': prompt}}})
    emit({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': 't', 'status': 'completed'}}})
for line in sys.stdin:
    r = json.loads(line)
    if 'id' not in r:
        continue
    m, p = r['method'], r.get('params', {})
    result = {}
    if m == 'account/read':
        result = {'account': {'type': 'chatgpt'}}
    if m in ('thread/start', 'thread/resume'):
        result = {'thread': {'id': p.get('threadId') or uuid.uuid4().hex, 'how': m, 'pid': os.getpid()}}
        with open(os.environ['LIVE_LOG'], 'a') as f:
            f.write(json.dumps({'method': m, 'pid': os.getpid()}) + '\\n')
    if m == 'turn/start':
        result = {'turn': {'id': 't'}}
        threading.Thread(target=finish, args=(p['threadId'], p['input'][0]['text'])).start()
    emit({'id': r['id'], 'result': result})
'''


def live_run(pool, tmp_path, prompt, session=None):
    import os
    env = {**os.environ, 'LIVE_LOG': str(tmp_path / 'live.log')}
    return AppServerRun([sys.executable, '-u', '-c', LIVE], tmp_path, env, AppServerParser(tmp_path), prompt=prompt,
                        session=session, model_id='test', effort=None, images=[], schema=False, pool=pool)


def test_live_app_server_is_shared_and_routes_threads(tmp_path):
    from slide_studio.ai.live import Pool
    import json

    async def check():
        pool = Pool()
        try:
            a, b = live_run(pool, tmp_path, 'A'), live_run(pool, tmp_path, 'B')
            await asyncio.gather(a.run(), b.run())
            # 2つのタブの turn が同じ app-server で並行に動き、通知はそれぞれの thread に届く
            assert a.returncode == b.returncode == 0 and a.final == 'A' and b.final == 'B'
            assert a.proc.pid == b.proc.pid and a.session != b.session
            # 2回目：読み込み済みの thread は、起動も thread/resume もせずに turn/start
            again = live_run(pool, tmp_path, 'A2', a.session)
            await again.run()
            assert again.final == 'A2' and again.session == a.session and again.proc.pid == a.proc.pid
            log = [json.loads(x) for x in (tmp_path / 'live.log').read_text().splitlines()]
            assert [x['method'] for x in log] == ['thread/start', 'thread/start']
            # しばらく使わなければ止める。次は起動し直して thread/resume で続ける
            server = a.proc
            pool.stop_idle(now=10 ** 9)
            await server.wait()
            assert not pool.codex
            later = live_run(pool, tmp_path, 'A3', a.session)
            await later.run()
            assert later.final == 'A3' and later.proc.pid != server.pid
            log = [json.loads(x) for x in (tmp_path / 'live.log').read_text().splitlines()]
            assert log[-1]['method'] == 'thread/resume'
        finally:
            pool.kill_all()
    asyncio.run(check())


def test_live_app_server_restarts_after_it_dies(tmp_path):
    from slide_studio.ai.live import Pool

    async def check():
        pool = Pool()
        try:
            first = live_run(pool, tmp_path, 'A')
            await first.run()
            first.client.kill()
            await first.proc.wait()
            # 止まった app-server は使わず、起動し直して thread/resume で続ける
            second = live_run(pool, tmp_path, 'B', first.session)
            await second.run()
            assert second.final == 'B' and second.proc.pid != first.proc.pid and second.session == first.session
        finally:
            pool.kill_all()
    asyncio.run(check())


CLAUDE = '''
import json, os, sys
argv = sys.argv[1:]
session = argv[argv.index('--resume') + 1] if '--resume' in argv else 'new-session'
with open(os.environ['LIVE_LOG'], 'a') as f:
    f.write(json.dumps({'argv': argv, 'pid': os.getpid()}) + '\\n')
for line in sys.stdin:
    text = json.loads(line)['message']['content'][0]['text']
    print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': session, 'result': text}), flush=True)
'''


def test_live_claude_reuses_process_and_restarts_on_change(tmp_path):
    import json
    import os
    from slide_studio.ai.live import ClaudeRun, Pool
    from slide_studio.ai.providers import ClaudeParser
    env = {**os.environ, 'LIVE_LOG': str(tmp_path / 'live.log')}

    def run(pool, prompt, session, effort='low'):
        argv = [sys.executable, '-u', '-c', CLAUDE, '-p', '--effort', effort, '--input-format', 'stream-json']
        return ClaudeRun(pool, ('tab', 'chat'), argv, tmp_path, env, ClaudeParser(tmp_path), prompt, session)

    async def check():
        pool = Pool()
        try:
            first = await run(pool, 'one', None).run()
            assert first.returncode == 0 and first.final == 'one' and first.session == 'new-session'
            # 同じ引数・同じ会話なら、同じプロセスに流し込む
            second = await run(pool, 'two', first.session).run()
            assert second.final == 'two' and second.proc.pid == first.proc.pid
            # 思考量（起動の引数）が変われば止めて、--resume で起動し直す
            third = await run(pool, 'three', first.session, effort='high').run()
            assert third.final == 'three' and third.proc.pid != first.proc.pid
            await first.proc.wait()
            # 中断はプロセスごと止め、次は起動し直す
            fourth = run(pool, 'four', first.session, effort='high')
            await fourth.run()
            await fourth.cancel()
            assert not pool.claude
            fifth = await run(pool, 'five', first.session, effort='high').run()
            assert fifth.final == 'five' and fifth.proc.pid != fourth.proc.pid
            log = [json.loads(x) for x in (tmp_path / 'live.log').read_text().splitlines()]
            assert len(log) == 3 and '--resume' not in log[0]['argv'] and log[1]['argv'][-2:] == ['--resume', 'new-session']
        finally:
            pool.kill_all()
    asyncio.run(check())
