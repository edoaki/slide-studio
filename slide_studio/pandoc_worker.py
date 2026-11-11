"""Pandoc Lua をパイプ経由で再利用。描画と逆変換の待ち行列を分離する。"""
from __future__ import annotations

import atexit
import json
import logging
import os
import queue
import subprocess
import threading
from pathlib import Path

from .doctor import pandoc_path

SCRIPT = Path(__file__).parent / 'lua' / 'worker.lua'


class Worker:
    def __init__(self):
        self.process = None
        self.lock = threading.Lock()

    def _close(self):
        p, self.process = self.process, None
        if p is not None:
            if p.poll() is None:
                p.kill()
            p.wait()
            p.stdin.close()
            p.stdout.close()

    def close(self):
        with self.lock:
            self._close()

    def convert(self, text: str, args: list[str], cwd: Path, timeout: float) -> subprocess.CompletedProcess[str]:
        with self.lock:
            if self.process is not None and self.process.poll() is not None:
                self._close()
            starting = self.process is None
            if starting:
                self.process = subprocess.Popen(
                    [str(pandoc_path()), 'lua', str(SCRIPT)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, encoding='utf-8',
                )
            p = self.process
            # 書き込み・readline のどちらが詰まっても子を停止し、呼び出しを解放する。
            timer = threading.Timer(timeout, p.kill)
            timer.daemon = True
            timer.start()
            try:
                if starting and json.loads(p.stdout.readline()) != {'ready': True}:
                    raise OSError('Pandoc worker did not start')
                p.stdin.write(json.dumps({'text': text, 'args': args, 'cwd': str(cwd)}, ensure_ascii=False) + '\n')
                p.stdin.flush()
                result = json.loads(p.stdout.readline())
                if not result['ok']:
                    return subprocess.CompletedProcess(args, 1, '', result['error'])
                return subprocess.CompletedProcess(args, 0, result['output'], result['stderr'])
            except (OSError, ValueError, KeyError):
                self._close()
                raise
            finally:
                timer.cancel()
                timer.join()


class Pool:
    def __init__(self, size: int):
        self.workers = [Worker() for _ in range(size)]
        self.available = queue.LifoQueue()
        for worker in self.workers:
            self.available.put(worker)

    def convert(self, text: str, args: list[str], cwd: Path, timeout: float) -> subprocess.CompletedProcess[str]:
        worker = self.available.get(timeout=timeout)
        try:
            return worker.convert(text, args, cwd, timeout)
        finally:
            self.available.put(worker)

    def close(self):
        for worker in self.workers:
            worker.close()


_render = Pool(1)
_edit = Pool(4)


def run(text: str, args: list[str], *, cwd: Path | None = None, timeout: float = 60) -> subprocess.CompletedProcess[str]:
    cwd = (cwd or Path.cwd()).resolve()
    if os.environ.get('SLIDE_STUDIO_PANDOC_MODE') != 'process':
        pool = _edit if args[1] == 'html-native_divs' else _render
        try:
            return pool.convert(text, args, cwd, timeout)
        except (OSError, ValueError, KeyError, queue.Empty) as exc:
            # 非対応の旧 Pandoc・子プロセス終了時も、従来の変換を継続できる。
            logging.getLogger(__name__).warning('Pandoc worker unavailable; using a one-shot process: %s', exc)
    return subprocess.run([str(pandoc_path()), *args], input=text, capture_output=True,
                          text=True, cwd=cwd, timeout=timeout)


def warmup():
    run('', ['--from', 'markdown', '--to', 'html5', '--wrap=none'])


def close():
    _render.close()
    _edit.close()


atexit.register(close)
