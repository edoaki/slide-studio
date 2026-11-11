"""タブごとに AI を起動したままにする（作業手順書 A6）。送信のたびにプロセスを起動し直さない。

- Codex：起動の設定（argv・env）ごとに app-server を1つ起動したままにし、どのタブもその中の自分の thread に turn/start を送る。
  その app-server でまだ読み込んでいない thread（起動し直した後など）は thread/resume で続ける。
- Claude Code：タブ・担当ごとに `--input-format stream-json` で起動したままにし、続きの依頼を標準入力に流し込む。
  起動の引数（モデル・思考量・返事の形など）が変わった・新しい会話にするときは止めて、起動し直す（続きなら --resume）。
- しばらく使わないもの（IDLE 秒）とアプリの終了で止める。止まっていたら、今までどおり起動して会話を続ける。
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import time

from .agent import KILL_AFTER, Run

IDLE = 600.0  # これだけ使わなければ止める
SWEEP = 60.0


class ClaudeProcess:
    """起動したままの Claude Code。1回の依頼は、標準入力に user のメッセージを書き、result までを読む。"""

    def __init__(self, argv, cwd, env, session):
        self.argv, self.cwd, self.env, self.session = argv, cwd, env, session
        self.proc = None
        self.events: asyncio.Queue = asyncio.Queue()
        self.reader = None
        self.stderr = ''
        self.busy = False
        self.used = time.monotonic()

    @property
    def alive(self):
        return self.proc is not None and self.proc.returncode is None

    async def start(self):
        self.proc = await asyncio.create_subprocess_exec(
            *self.argv, cwd=str(self.cwd), env=self.env, stdin=subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True, limit=32 * 1024 * 1024)
        self.reader = asyncio.create_task(self._read())
        asyncio.create_task(self._read_stderr())
        return self

    async def _read(self):
        try:
            async for raw in self.proc.stdout:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('{'):
                    continue
                try:
                    await self.events.put(json.loads(line))
                except ValueError:
                    continue
        finally:
            await self.events.put(None)

    async def _read_stderr(self):
        data = await self.proc.stderr.read()
        self.stderr = data.decode('utf-8', 'replace')[-4000:]

    async def send(self, prompt):
        message = {'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': prompt}]}}
        self.proc.stdin.write((json.dumps(message, ensure_ascii=False) + '\n').encode())
        await self.proc.stdin.drain()

    def signal(self, sig):
        if self.alive:
            try:
                os.killpg(self.proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                pass

    def kill(self):
        self.signal(signal.SIGTERM)
        self.signal(signal.SIGKILL)


class Pool:
    """起動したままの AI。Chat が1つ持つ。"""

    def __init__(self, idle: float = IDLE):
        self.idle = idle
        self.codex: dict[tuple, object] = {}  # 起動の設定 → app_server.Client
        self.claude: dict[tuple, ClaudeProcess] = {}  # (タブ, 担当) → プロセス
        self.locks: dict[tuple, asyncio.Lock] = {}
        self.sweeper = None

    def _lock(self, key):
        return self.locks.setdefault(key, asyncio.Lock())

    def _sweep_soon(self):
        if self.sweeper is None or self.sweeper.done():
            self.sweeper = asyncio.create_task(self._sweep())

    async def _sweep(self):
        while self.codex or self.claude:
            await asyncio.sleep(min(SWEEP, self.idle))
            self.stop_idle()

    def stop_idle(self, now: float | None = None):
        now = time.monotonic() if now is None else now
        for key, client in list(self.codex.items()):
            if not client.running and now - client.used >= self.idle:
                self.codex.pop(key)
                client.kill()
        for key, proc in list(self.claude.items()):
            if not proc.busy and now - proc.used >= self.idle:
                self.claude.pop(key)
                proc.kill()

    async def codex_client(self, argv, cwd, env):
        """起動の設定ごとの app-server。止まっていれば起動し、ログインを確かめる。"""
        from .app_server import Client
        key = (tuple(argv), str(cwd), tuple(sorted(env.items())))
        async with self._lock(key):
            client = self.codex.get(key)
            if client is None or not client.alive:
                client = Client(argv, str(cwd), env)
                await client.start()
                try:
                    account = (await client.call('account/read')).get('account')
                    if not account or account.get('type') != 'chatgpt':
                        raise ValueError('ChatGPT アカウントでログインしてください')
                except BaseException:
                    await client.close()
                    raise
                self.codex[key] = client
            client.used = time.monotonic()
        self._sweep_soon()
        return client

    def held_elsewhere(self, client, thread) -> bool:
        """thread をほかの app-server が読み込んでいるか。Codex は1つの thread を1つの app-server にしか書かせない
        （thread/unsubscribe でも離さない）ので、話し合い（読むだけ）と編集を行き来するときは thread/fork で続ける。"""
        return any(other is not client and other.alive and thread in other.threads for other in self.codex.values())

    async def claude_process(self, key, argv, cwd, env, session):
        """タブ・担当ごとの Claude Code。引数が違う・会話が違えば止めて起動し直す。"""
        async with self._lock(('claude',) + key):
            proc = self.claude.get(key)
            if proc and (not proc.alive or proc.busy or proc.base != argv or proc.session != session):
                self.claude.pop(key)
                proc.kill()
                proc = None
            if proc is None:
                proc = await ClaudeProcess(argv + (['--resume', session] if session else []), cwd, env, session).start()
                proc.base = argv  # 比べるのは --resume の前まで
                self.claude[key] = proc
            proc.busy = True
            proc.used = time.monotonic()
        self._sweep_soon()
        return proc

    def drop(self, client_or_proc):
        """壊れた・中断で止めたものを外す（次は起動し直す）。"""
        for table in (self.codex, self.claude):
            for key, value in list(table.items()):
                if value is client_or_proc:
                    table.pop(key)

    def kill_all(self):
        for client in self.codex.values():
            client.kill()
        for proc in self.claude.values():
            proc.kill()
        self.codex.clear()
        self.claude.clear()
        if self.sweeper:
            self.sweeper.cancel()


class ClaudeRun(Run):
    """起動したままの Claude Code への1回の依頼。止めるとき（中断）はプロセスごと止め、次は --resume で起動し直す。"""

    def __init__(self, pool: Pool, key, argv, cwd, env, parser, prompt, session, **callbacks):
        super().__init__(argv, cwd, env, parser, **callbacks)
        self.pool, self.key, self.prompt, self.options_session = pool, key, prompt, session
        self.live = None

    async def run(self):
        self.live = await self.pool.claude_process(self.key, self.argv, self.cwd, self.env, self.options_session)
        self.proc = self.live.proc
        try:  # ここから先の失敗・中断では、このプロセスを使い回さない
            if self.cancelled:
                return self
            await self.live.send(self.prompt)
            while True:
                ev = await self.live.events.get()
                if ev is None:
                    # 途中でプロセスが終わった
                    self.returncode = await self.live.proc.wait() or 1
                    await asyncio.sleep(0)
                    self.stderr = self.live.stderr
                    self.pool.drop(self.live)
                    break
                for act in self.parser.feed(ev):
                    self._act(act)
                if ev.get('type') == 'result':
                    self.returncode = 1 if ev.get('is_error') or (ev.get('subtype') or 'success') != 'success' else 0
                    self.live.session = self.session
                    break
        except BaseException:
            self.pool.drop(self.live)
            self.live.kill()
            raise
        finally:
            self.live.busy = False
            self.live.used = time.monotonic()
        return self

    async def cancel(self):
        await super().cancel()
        if self.live:
            self.pool.drop(self.live)

    def kill_now(self):
        super().kill_now()
        if self.live:
            self.pool.drop(self.live)
