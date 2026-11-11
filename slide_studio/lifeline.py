"""窓を閉じたらサーバーも止める。

画面はどれも /api/events（SSE）を1本つなぐ。すべて切れてから GRACE 秒たってもつなぎ直されなければ、
arm() で渡された関数を呼ぶ。再読み込み・画面の移動ではすぐにつなぎ直すので止まらない。
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager

GRACE = 1.0

_open = 0
_stop = None  # serve() が窓を開いたときだけ渡す。None の間（テスト・--no-browser）は止めない
_timer: asyncio.TimerHandle | None = None
_enders: set = set()


def arm(stop) -> None:
    global _stop, _timer
    if _timer:
        _timer.cancel()
        _timer = None
    _stop = stop


def end_all() -> None:
    """サーバーを止めるとき、つながっている SSE を終わらせる（uvicorn が接続の終わりを待たずに済むように）。"""
    arm(None)
    for end in list(_enders):
        end()


@contextmanager
def held(end):
    """SSE の1本がつながっている間。end はその SSE を終わらせる関数。"""
    global _open, _timer
    _enders.add(end)
    _open += 1
    if _timer:
        _timer.cancel()
        _timer = None
    try:
        yield
    finally:
        _enders.discard(end)
        _open -= 1
        if _open == 0 and _stop:
            _timer = asyncio.get_running_loop().call_later(GRACE, _stop)
