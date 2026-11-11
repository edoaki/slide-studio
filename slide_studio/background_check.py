"""保存後の部分検査。書き出しのワーカーと Chromium を共有する（設計書 §9.4）。"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

from starlette.responses import JSONResponse
from starlette.routing import Route

from . import check, figures
from .fsutil import sha256_bytes, sha256_text, write_atomic

ENABLED = True  # テストでは止める（使うテストだけ戻す）


@dataclass
class Snapshot:
    rendered: object
    version: dict
    files: dict


def snapshot(ws, deck, rendered):
    files = {}
    hashes = []
    for p in check.deck_files(ws, deck, rendered.doc.text):
        try:
            files[p.resolve()] = sha256_bytes(p.read_bytes())
        except OSError:
            files[p.resolve()] = None
        hashes.append(f"{p}:{files[p.resolve()] or 'missing'}")
    version = {'qmd': sha256_text(rendered.doc.text), 'deps': sha256_text('\n'.join(sorted(set(hashes))))}
    return Snapshot(rendered, version, files)


def affected(ws, deck, previous, current):
    """None は全体。部分検査は、前回検査からの変化を安全に特定できた場合だけ。"""
    if previous is None:
        return None
    a, b = previous.rendered, current.rendered
    changed = {p for p in previous.files.keys() | current.files.keys() if previous.files.get(p) != current.files.get(p)}
    if changed:
        if any("_lib" in p.parts for p in changed):
            return None
        if a.doc.text != b.doc.text:
            return None
        refs = figures.fig_refs(b.doc.text)
        uses = set()
        for ref in refs:
            folder = ws.figure_dir(ref, deck).resolve()
            # _lib の変更は全体。図自身のファイルだけなら使用ページに限定できる。
            local = {p for p in changed if p.is_relative_to(folder)}
            if local:
                changed -= local
                uses.update(p.index for p in b.doc.pages if ref in figures.fig_refs(b.doc.text[p.start:p.end]))
        if changed or not uses:
            return None
        return [s['index'] for s in b.slides if s['page'] in uses]
    if set(a.cited) != set(b.cited) or len(a.doc.pages) != len(b.doc.pages) or a.slides != b.slides:
        return None
    if not a.doc.pages or not b.doc.pages:
        return None
    if a.doc.text[:a.doc.pages[0].start] != b.doc.text[:b.doc.pages[0].start]:
        return None
    changed_pages = []
    for old, new in zip(a.doc.pages, b.doc.pages):
        if a.doc.text[old.start:old.end] != b.doc.text[new.start:new.end]:
            # 見出しを含む変更は本文だけとみなさない。
            if a.doc.text[old.start:old.head_end] != b.doc.text[new.start:new.head_end]:
                return None
            changed_pages.append(new.index)
    if len(changed_pages) != 1:
        return None
    return [s['index'] for s in b.slides if s['page'] in changed_pages]


class BackgroundChecks:
    def __init__(self, srv, shooter):
        self.srv, self.shooter = srv, shooter
        self.previous = {}
        self.tasks = {}
        self.states = {}

    def __call__(self, kind, deck):
        if kind == 'rendered' and ENABLED:
            self.states[deck] = {'busy': True, 'stale': True}
            self.srv.broadcast({'type': 'checks', 'deck': deck, **self.states[deck]})
            # 続けて保存されたときも、走っている検査の完了を待って最新を検査する。
            if deck not in self.tasks:
                self.tasks[deck] = asyncio.create_task(self.run(deck))

    def state(self, deck):
        result = check.load(self.srv.ws, deck)
        stale = self.states.get(deck, {}).get('stale', False) if result is None else result.get('version') != check.deck_version(self.srv.ws, deck)
        return {**self.states.get(deck, {}), 'result': result, 'stale': stale}

    async def run(self, deck):
        try:
            while True:
                st = self.srv.state(deck)
                rendered = st.rendered
                if rendered is None or st.error:
                    self.states[deck] = {'busy': False, 'stale': True}
                    break
                current = snapshot(self.srv.ws, deck, rendered)
                previous = self.previous.get(deck)
                stored = check.load(self.srv.ws, deck)
                if previous and (not stored or stored.get('version') != previous.version):
                    previous = None
                slides = affected(self.srv.ws, deck, previous, current)
                self.states[deck] = {'busy': True, 'stale': True}
                self.srv.broadcast({'type': 'checks', 'deck': deck, **self.states[deck]})
                def work(browser):
                    result = check.check_deck(self.srv.ws, deck, browser=browser, text=rendered.doc.text, slides=slides)
                    # 待ち行列に入れた後の依存変更も、最新の検査と取り違えない。
                    result['version'] = current.version
                    write_atomic(self.srv.ws.build_dir(deck) / 'checks.json', json.dumps(result, ensure_ascii=False, indent=1))
                    return result
                result = await asyncio.wrap_future(self.shooter.submit(work, deck=deck))
                stale = current.version != check.deck_version(self.srv.ws, deck)
                self.previous[deck] = None if stale else current
                self.states[deck] = {'busy': False, 'stale': stale}
                self.srv.broadcast({'type': 'checks', 'deck': deck, 'result': result, **self.states[deck]})
                if not stale or self.srv.state(deck).rendered is rendered:
                    break
        except Exception as e:  # noqa: BLE001 - 検査の失敗で編集を止めない
            self.states[deck] = {'busy': False, 'stale': True, 'error': str(e)}
        finally:
            self.tasks.pop(deck, None)
            self.srv.broadcast({'type': 'checks', 'deck': deck, **self.states.get(deck, {})})

    def stop(self):
        for task in self.tasks.values():
            task.cancel()


def install(app, srv, routes):
    checks = BackgroundChecks(srv, app.state.shots)
    app.state.checks = checks
    srv.hooks.append(checks)
    srv.stoppers.insert(0, checks.stop)

    async def get(request):
        deck = request.path_params['deck']
        if not srv.ws.has_deck(deck):
            return JSONResponse({'error': '発表がありません'}, 404)
        return JSONResponse(checks.state(deck))

    app.router.routes.insert(0, Route('/api/deck/{deck}/checks', get))
