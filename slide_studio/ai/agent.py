"""AI の CLI の1回の実行（どのプロバイダーでも共通）。設計書 §8.1。

標準出力の1行ごとの JSON を、プロバイダーの parser（providers.py）が次の形の動作のリストに直す。
  {"session": id}   会話の id（次の送信で続きにする）
  {"step": step}    チャットに出す途中経過（kind・text・id。exit はコマンドの終了コード）
  {"final": 値}     最後の報告（schema.json の形の dict か、その JSON の文字列）
  {"usage": {...}}  コンテキストの使用量（used・window。window は分からなければ None）
  {"limits": {...}} アカウントの利用上限の使用率（five_hour・weekly。providers.codex_limits の形）
キャンセルはプロセスグループごと止める。
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

KILL_AFTER = 5.0  # SIGTERM のあと、これだけ待って SIGKILL


@dataclass
class Run:
    argv: list[str]
    cwd: Path
    env: dict
    parser: object  # .feed(ev: dict) -> list[dict]
    on_step: object = None  # (step: dict) -> None
    on_session: object = None  # (session_id: str) -> None
    on_usage: object = None  # (usage: dict) -> None
    on_limits: object = None  # (limits: dict) -> None
    proc: asyncio.subprocess.Process | None = None
    session: str | None = None
    final: object = ""
    errors: list[str] = field(default_factory=list)
    stderr: str = ""
    cancelled: bool = False
    returncode: int | None = None

    async def run(self) -> "Run":
        self.proc = await asyncio.create_subprocess_exec(
            *self.argv, cwd=str(self.cwd), env=self.env, stdin=subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True, limit=32 * 1024 * 1024)
        err_task = asyncio.create_task(self._read_stderr())
        assert self.proc.stdout
        async for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            for act in self.parser.feed(ev):
                self._act(act)
        self.returncode = await self.proc.wait()
        await err_task
        return self

    def _act(self, act: dict) -> None:
        if "session" in act:
            if act["session"] and act["session"] != self.session:
                self.session = act["session"]
                if self.on_session:
                    self.on_session(self.session)
        elif "final" in act:
            self.final = act["final"]
        elif "usage" in act:
            if self.on_usage:
                self.on_usage(act["usage"])
        elif "limits" in act:
            if self.on_limits:
                self.on_limits(act["limits"])
        elif "step" in act:
            step = act["step"]
            if step["kind"] == "error":
                self.errors.append(step["text"])
            if self.on_step:
                self.on_step(step)

    async def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        data = await self.proc.stderr.read()
        self.stderr = data.decode("utf-8", "replace")[-4000:]

    def _signal(self, sig: int) -> None:
        if not self.proc or self.proc.returncode is not None:
            return
        try:
            os.killpg(self.proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    async def cancel(self) -> None:
        self.cancelled = True
        self._signal(signal.SIGTERM)
        if not self.proc:
            return
        try:
            await asyncio.wait_for(asyncio.shield(self.proc.wait()), KILL_AFTER)
        except asyncio.TimeoutError:
            self._signal(signal.SIGKILL)
        # 親が先に終わっても、グループに残った子を止める
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def kill_now(self) -> None:
        """アプリの終了時。待たずにグループごと止める。"""
        self.cancelled = True
        self._signal(signal.SIGTERM)
        self._signal(signal.SIGKILL)


def parse_final(value) -> dict | None:
    """最後の報告（schema.json の形）。文字列なら JSON として読む（```json の囲みも外す）。形が違えば None。"""
    data = value
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[-1].rsplit("```", 1)[0]
        if not text.startswith("{"):
            # 説明の後に JSON を書くモデルがある。最後の { から読む
            i = text.rfind("\n{")
            text = text[i + 1:] if i >= 0 else text
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return None
    if not isinstance(data, dict) or not isinstance(data.get("summary"), str) or not isinstance(data.get("results"), list):
        return None
    return data
