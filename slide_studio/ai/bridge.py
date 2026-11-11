"""AI の sandbox の中から、起動中のアプリに検査を頼む。

sandbox（Codex の workspace-write・Claude Code の sandbox など）の中では Chromium も検査用の HTTP も起動できない。`slide-studio check` が
sandbox の中で呼ばれたら、置き場の `.slide-studio/requests/` に依頼を書き、アプリが検査して結果を書き戻す。
アプリが受け取らなければ（起動していない）None を返し、呼び出し側はその場で検査する。
相談役への質問（`slide-studio consult`）も同じ道を通る。相談はアプリの中でしかできない。
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path

from ..fsutil import write_atomic
from ..workspace import StudioError, Workspace, check_name

ACCEPT_WAIT = 5.0  # アプリが受け取るまで待つ秒数
RESULT_WAIT = 900.0
POLL = 0.25


def requests_dir(ws: Workspace) -> Path:
    return ws.state / "requests"


def in_sandbox() -> bool:
    import os
    return bool(os.environ.get("CODEX_SANDBOX") or os.environ.get("SLIDE_STUDIO_SANDBOX"))


# ------------------------------------------------------------ 依頼する側（CLI）
def request_check(ws: Workspace, deck: str | None, page: str | None = None, figure: str | None = None) -> dict | None:
    return _request(ws, {"deck": deck, "page": page, "figure": figure})


def request_audit(ws: Workspace, deck: str) -> dict | None:
    return _request(ws, {"operation": "audit_run", "deck": deck})


def request_consult(ws: Workspace, tab: str, question: str) -> dict | None:
    return _request(ws, {"operation": "consult", "tab": tab, "question": question})


def _request(ws: Workspace, body: dict) -> dict | None:
    d = requests_dir(ws)
    d.mkdir(parents=True, exist_ok=True)
    rid = uuid.uuid4().hex
    req, run, res = d / f"{rid}.req.json", d / f"{rid}.run", d / f"{rid}.res.json"
    write_atomic(req, json.dumps(body, ensure_ascii=False))
    t0 = time.monotonic()
    while req.exists() and not run.exists() and not res.exists():
        if time.monotonic() - t0 > ACCEPT_WAIT:
            req.unlink(missing_ok=True)
            return None
        time.sleep(POLL)
    while not res.exists():
        if time.monotonic() - t0 > RESULT_WAIT:
            raise StudioError("アプリでの処理が終わりませんでした")
        time.sleep(POLL)
    data = json.loads(res.read_text())
    res.unlink(missing_ok=True)
    return data


# ------------------------------------------------------------ 受ける側（アプリ）
async def serve(ws: Workspace, run_check, run_audit=None, run_consult=None) -> None:
    """依頼を見つけたら run_check(deck, page, figure) -> result を別スレッドで実行する。

    依頼は1つずつ別の task で答える（時間のかかる相談の間も、他のタブの検査を待たせない）。
    run_consult(tab, question) -> 答えの文 は、イベントループの上で動く。
    """
    d = requests_dir(ws)
    d.mkdir(parents=True, exist_ok=True)
    tasks: set[asyncio.Task] = set()
    try:
        while True:
            for req in sorted(d.glob("*.req.json")):
                rid = req.name.removesuffix(".req.json")
                run, res = d / f"{rid}.run", d / f"{rid}.res.json"
                try:
                    body = json.loads(req.read_text())
                    req.unlink()
                except (OSError, ValueError):
                    continue
                write_atomic(run, "")
                task = asyncio.create_task(_answer(ws, body, run, res, run_check, run_audit, run_consult))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
            await asyncio.sleep(POLL)
    finally:
        for task in tasks:
            task.cancel()


async def _answer(ws: Workspace, body: dict, run: Path, res: Path, run_check, run_audit, run_consult) -> None:
    import anyio

    from .. import check

    operation = body.get("operation")
    try:
        deck, page, figure = body.get("deck"), body.get("page"), body.get("figure")
        if deck:
            check_name(deck, "発表の名前")
        if operation == "audit_run":
            if run_audit is None:
                raise StudioError("アプリが監査ツールに対応していません。再起動してください")
            out = {"result": await anyio.to_thread.run_sync(run_audit, deck)}
        elif operation == "consult":
            if run_consult is None:
                raise StudioError("アプリが相談役に対応していません。再起動してください")
            out = {"answer": await run_consult(body.get("tab"), body.get("question"))}
        else:
            result = await anyio.to_thread.run_sync(run_check, deck, page, figure)
            out = {"summary": check.summary(result), "errors": len(result["errors"])}
    except Exception as e:  # noqa: BLE001  依頼側にそのまま伝える
        out = {"summary": f"{'相談' if operation == 'consult' else '検査'}できませんでした: {e}", "errors": 1}
    write_atomic(res, json.dumps(out, ensure_ascii=False))
    run.unlink(missing_ok=True)
