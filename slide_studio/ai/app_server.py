"""Codex App Server の stdio JSON-RPC。認証情報は Codex に管理させる。"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import time
from pathlib import Path

from .agent import KILL_AFTER, Run


class Client:
    def __init__(self, argv, cwd=None, env=None, tool_call=None):
        from .providers import Codex
        # 認証・モデル一覧・全担当の実行を同じ専用の保存先に揃える。
        home = Codex.home()
        home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.argv, self.cwd = argv, cwd
        self.env = {**(os.environ if env is None else env), 'CODEX_HOME': str(home)}
        self.proc = None
        self.pending = {}
        self.events = asyncio.Queue()
        self.serial = 0
        self.reader = None
        self.tool_call = tool_call
        self.requests = set()
        # 起動したまま使うとき（live.Pool）：thread ごとの通知の行き先・読み込み済みの thread・実行中の turn の数
        self.subscribers: dict[str, asyncio.Queue] = {}
        self.threads: set[str] = set()
        self.running = 0
        self.used = 0.0

    @property
    def alive(self):
        return self.proc is not None and self.proc.returncode is None and self.reader is not None and not self.reader.done()

    def subscribe(self, thread):
        queue = self.subscribers[thread] = asyncio.Queue()
        return queue

    def unsubscribe(self, thread):
        self.subscribers.pop(thread, None)

    async def start(self):
        self.proc = await asyncio.create_subprocess_exec(
            *self.argv, cwd=self.cwd, env=self.env, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True, limit=32 * 1024 * 1024)
        self.reader = asyncio.create_task(self._read())
        try:
            await self.call('initialize', {'clientInfo': {'name': 'slide_studio', 'title': 'Slide Studio', 'version': '0.1.0'},
                                          'capabilities': {'experimentalApi': True}})
            await self.send({'method': 'initialized', 'params': {}})
        except BaseException:
            await self.close()
            raise
        return self

    async def send(self, message):
        self.proc.stdin.write((json.dumps(message) + '\n').encode())
        await self.proc.stdin.drain()

    async def call(self, method, params=None):
        self.serial += 1
        key = self.serial
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        try:
            await self.send({'id': key, 'method': method, 'params': params or {}})
            return await asyncio.wait_for(future, 30)
        finally:
            self.pending.pop(key, None)

    async def _read(self):
        error = ValueError('Codex App Server との接続が切れました')
        try:
            async for raw in self.proc.stdout:
                ev = json.loads(raw)
                if 'method' in ev:
                    if 'id' in ev:
                        if ev['method'] == 'item/tool/call' and self.tool_call:
                            task = asyncio.create_task(self._tool_request(ev))
                            self.requests.add(task)
                            task.add_done_callback(self.requests.discard)
                            continue
                        # 未対応の承認・入力要求を許可したり、無期限に待ったりしない。
                        await self.send({'id': ev['id'], 'error': {'code': -32601, 'message': 'Unsupported client request'}})
                    else:
                        await self._route(ev)
                else:
                    future = self.pending.get(ev.get('id'))
                    if future and not future.done():
                        if 'error' in ev:
                            future.set_exception(ValueError(ev['error'].get('message', 'Codex App Server error')))
                        else:
                            future.set_result(ev.get('result', {}))
        except (ValueError, OSError) as exc:
            error = exc
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)
            for queue in list(self.subscribers.values()):
                await queue.put(None)
            await self.events.put(None)

    async def _route(self, ev):
        """通知を thread の行き先に渡す。thread の無い通知は、行き先が1つならそこへ、ほかは events へ。"""
        thread = (ev.get('params') or {}).get('threadId')
        queue = self.subscribers.get(thread) if thread else (next(iter(self.subscribers.values())) if len(self.subscribers) == 1 else None)
        await (queue or self.events).put(ev)

    async def _tool_request(self, ev):
        try:
            p = ev['params']
            value = await self.tool_call(p['tool'], p['arguments'])
            if isinstance(value, dict) and 'content' in value:
                content = [{'type': 'inputImage', 'imageUrl': f"data:{c['mimeType']};base64,{c['data']}"}
                           if c['type'] == 'image' else {'type': 'inputText', 'text': c['text']} for c in value['content']]
            else:
                content = [{'type': 'inputText', 'text': json.dumps(value, ensure_ascii=False)}]
            result = {'success': True, 'contentItems': content}
        except Exception as exc:
            result = {'success': False, 'contentItems': [{'type': 'inputText', 'text': str(exc)}]}
        try:
            await self.send({'id': ev['id'], 'result': result})
        except (OSError, RuntimeError):
            pass

    def kill(self):
        if self.proc:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):  # macOS は終わったプロセスだけの組に EPERM を返すことがある
                pass

    async def close(self):
        for task in list(self.requests):
            task.cancel()
        if self.requests:
            await asyncio.gather(*self.requests, return_exceptions=True)
        self.kill()
        if self.proc:
            await self.proc.wait()
        if self.reader:
            await self.reader


async def inspect(argv):
    client = await Client(argv).start()
    try:
        account = (await client.call('account/read')).get('account')
        if not account or account.get('type') != 'chatgpt':
            return {'ok': False, 'reason': 'login', 'message': ''}
        from .providers import model
        models, cursor, default = [], None, None
        while True:
            result = await client.call('model/list', {'cursor': cursor})
            for m in result.get('data', []):
                if m.get('hidden'):
                    continue
                if m.get('isDefault'):
                    default = m['id']
                models.append(model(m['id'], m.get('displayName') or m['id'],
                                    [e['reasoningEffort'] for e in m.get('supportedReasoningEfforts', [])],
                                    m.get('defaultReasoningEffort'), m.get('contextWindow')))
            cursor = result.get('nextCursor')
            if not cursor:
                break
        try:
            from .providers import codex_limits
            limits = codex_limits((await client.call('account/rateLimits/read')).get('rateLimits') or {})
        except (ValueError, asyncio.TimeoutError):
            limits = {}  # 上限が分からなくても AI は使える
        return {'ok': True, 'models': models, 'default': default, 'message': '', 'limits': limits,
                'account': {'email': account.get('email'), 'plan': account.get('planType')}}
    finally:
        await client.close()


class AppServerRun(Run):
    def __init__(self, argv, cwd, env, parser, *, prompt, session, model_id, effort, images, schema,
                 system=None, tools=None, tool_call=None, config=None, sandbox='workspaceWrite', pool=None, **callbacks):
        super().__init__(argv, cwd, env, parser, **callbacks)
        self.sandbox = sandbox  # None なら起動の設定（権限のプロファイル）に任せる
        self.options = dict(prompt=prompt, session=session, model_id=model_id, effort=effort, images=images, schema=schema)
        self.client = None
        self.turn_id = None
        self.system, self.tools, self.tool_call, self.config = system, tools, tool_call, config
        self.pool = pool  # live.Pool なら、起動したままの app-server を使う（このプロセスは止めない）
        self.finished = asyncio.Event()

    async def run(self):
        o = self.options
        try:
            if self.pool:
                self.client = await self.pool.codex_client(self.argv, self.cwd, self.env)
            else:
                self.client = Client(self.argv, str(self.cwd), self.env, tool_call=self.tool_call)
                await self.client.start()
            self.proc = self.client.proc
            if self.cancelled:
                return self
            if not self.pool:
                account = (await self.client.call('account/read')).get('account')
                if not account or account.get('type') != 'chatgpt':
                    raise ValueError('ChatGPT アカウントでログインしてください')
            if o['session'] and o['session'] in self.client.threads:
                # 起動したままの app-server に読み込み済みの thread：そのまま turn/start
                self._act({'session': o['session']})
            else:
                params = {'cwd': str(self.cwd), 'model': o['model_id'], 'approvalPolicy': 'never'}
                if self.sandbox:
                    params['sandbox'] = self.sandbox
                if self.system is not None:
                    params.update(developerInstructions=self.system, sandbox='read-only', config=self.config or {})
                    if not o['session']:
                        params['dynamicTools'] = [{'type': 'function', 'name': s['name'], 'description': s['description'],
                                                   'inputSchema': s['input_schema']} for s in self.tools or []]
                if o['session']:
                    params['threadId'] = o['session']
                # ほかの app-server が書いている thread は resume できない。履歴ごと写した新しい thread で続ける
                fork = bool(o['session'] and self.pool and self.pool.held_elsewhere(self.client, o['session']))
                result = await self.client.call('thread/fork' if fork else 'thread/resume' if o['session'] else 'thread/start', params)
                self._act({'session': result['thread']['id']})
                self.client.threads.add(self.session)
            events = self.client.subscribe(self.session) if self.pool else self.client.events
            self.client.running += 1
            try:
                params = {'threadId': self.session, 'input': [{'type': 'text', 'text': o['prompt']}] +
                          [{'type': 'localImage', 'path': str(p)} for p in o['images']]}
                if o['effort']:
                    params['effort'] = o['effort']
                if o['schema']:
                    params['outputSchema'] = o['schema'] if isinstance(o['schema'], dict) else json.loads(Path(__file__).with_name('schema.json').read_text())
                result = await self.client.call('turn/start', params)
                self.turn_id = result['turn']['id']
                while True:
                    ev = await events.get()
                    if ev is None:
                        raise ValueError('Codex App Server との接続が切れました')
                    for act in self.parser.feed(ev):
                        self._act(act)
                    if ev.get('method') == 'turn/completed':
                        turn = ev['params']['turn']
                        self.returncode = 0 if turn['status'] == 'completed' else 1
                        if turn['status'] == 'interrupted':
                            self.cancelled = True
                        if turn.get('error'):
                            self._act({'step': {'id': None, 'kind': 'error', 'text': turn['error']['message']}})
                        break
            finally:
                self.client.running -= 1
                if self.pool:
                    self.client.unsubscribe(self.session)
                    self.client.used = time.monotonic()
        except BaseException:
            if self.pool and self.client and not self.client.alive:
                self.pool.drop(self.client)
            raise
        finally:
            self.finished.set()
            if not self.pool and self.client:
                await self.client.close()
        return self

    async def _interrupt(self):
        if self.client and self.session and self.turn_id:
            try:
                await asyncio.wait_for(self.client.call('turn/interrupt', {'threadId': self.session, 'turnId': self.turn_id}), 2)
            except (ValueError, OSError, asyncio.TimeoutError):
                pass

    async def cancel(self):
        self.cancelled = True
        await self._interrupt()
        if not self.pool:
            await super().cancel()
            return
        # 起動したままの app-server はほかのタブも使う。turn が止まらなければ、そのときだけ app-server ごと止める
        try:
            await asyncio.wait_for(self.finished.wait(), KILL_AFTER)
        except asyncio.TimeoutError:
            if self.client:
                self.pool.drop(self.client)
                self.client.kill()

    def kill_now(self):
        if not self.pool:
            super().kill_now()
            if self.client:
                self.client.kill()
            return
        self.cancelled = True
        if not self.finished.is_set() and self.turn_id:
            # 待たずに turn だけ止める（アプリの終了では Pool.kill_all が app-server を止める）
            try:
                asyncio.get_running_loop().create_task(self._interrupt())
            except RuntimeError:
                pass
