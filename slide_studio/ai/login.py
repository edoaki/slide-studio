"""ボタンから始めるログイン。実行ファイルの準備 → 公式のログイン画面 → 完了待ち。

認証は各 CLI 自身が行い、保存も CLI に任せる。アプリはトークンを読まず、預からない。
"""
from __future__ import annotations

import asyncio
import http.client
import time

import anyio

from ..workspace import StudioError

TIMEOUT = 180
RETRY_AFTER = 5  # ブラウザーへ渡してから、開き直せるようになるまでの秒数（連打でタブが増えないように）


class Job:
    def __init__(self, provider):
        self.provider = provider
        self.state: dict = {'status': 'preparing'}
        self.task: asyncio.Task | None = None
        self.pending_since: float | None = None

    def can_retry(self) -> bool:
        return self.pending_since is not None and not self.task.done() and time.monotonic() - self.pending_since >= RETRY_AFTER


class Logins:
    def __init__(self):
        self.jobs: dict[str, Job] = {}

    def state(self, provider) -> dict:
        job = self.jobs.get(provider.id)
        if job is None:
            return {'status': 'idle'}
        return {**job.state, 'progress': provider.runtime.progress, 'retry': job.can_retry()}

    def start(self, provider, *, download: bool = False) -> dict:
        job = self.jobs.get(provider.id)
        # ブラウザーのタブを閉じても CLI には伝わらないので、待っているものは押し直しで置き換える。
        if job is None or job.task.done() or job.can_retry():
            previous = job.task if job and not job.task.done() else None
            if previous:
                previous.cancel()
            job = self.jobs[provider.id] = Job(provider)
            job.task = asyncio.create_task(self._run(job, download=download, previous=previous))
        return self.state(provider)

    async def _run(self, job: Job, *, download: bool = False, previous: asyncio.Task | None = None) -> None:
        provider = job.provider
        try:
            if previous:  # 前の CLI が終わってから始める（受け口のポートが重ならないように）
                await asyncio.gather(previous, return_exceptions=True)
            exe = await anyio.to_thread.run_sync(provider.ensure_binary)
            if download:
                job.state = {'status': 'ready'}
                return
            job.state = {'status': 'pending'}
            job.pending_since = time.monotonic()
            async with asyncio.timeout(TIMEOUT):
                await provider.login(exe)
            job.state = {'status': 'completed'}
        except TimeoutError:
            job.state = {'status': 'failed', 'error': 'ログインの待ち時間を過ぎました。もう一度お試しください。'}
        except (StudioError, OSError, ValueError, KeyError, http.client.HTTPException) as exc:
            job.state = {'status': 'failed', 'error': str(exc) or 'ログインを完了できませんでした。もう一度お試しください。'}

    def stop(self) -> None:
        for job in self.jobs.values():
            if job.task:
                job.task.cancel()
