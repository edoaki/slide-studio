"""ホームでの発表の名前変更・ゴミ箱への移動と取り消し（§10.1）。"""
from __future__ import annotations

import contextlib
import json
import shutil
import time
import uuid

import yaml
from starlette.routing import Route

from . import source
from .fsutil import write_atomic
from .workspace import StudioError, check_name, set_front


def _safe(ws, path):
    current = ws.root
    for part in path.relative_to(ws.root).parts:
        current /= part
        if current.is_symlink():
            raise StudioError(f"シンボリックリンクを経由できません: {current}")


class Change:
    """失敗時に途中までの移動・書き込みも戻す。取り消しは直前の一操作だけ。"""
    def __init__(self, ws):
        self.ws, self.moves, self.writes = ws, [], []

    def move(self, src, dst):
        _safe(self.ws, src)
        _safe(self.ws, dst)
        if not src.exists():
            return
        if dst.exists():
            raise StudioError(f"既にあります: {dst}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        self.moves.append((src, dst))

    def write(self, path, data):
        _safe(self.ws, path)
        before = path.read_bytes() if path.exists() else None
        write_atomic(path, data)
        self.writes.append((path, before))

    def rollback(self):
        for path, before in reversed(self.writes):
            if before is None:
                path.unlink(missing_ok=True)
            else:
                write_atomic(path, before)
        for src, dst in reversed(self.moves):
            src.parent.mkdir(parents=True, exist_ok=True)
            dst.rename(src)


def _recent(ws):
    _safe(ws, ws.recent_file)
    return json.loads(ws.recent_file.read_text()) if ws.recent_file.exists() else []


def _paths(value, old, new):
    """記録のパスだけを更新し、会話本文は書き換えない。"""
    def path(s):
        prefix = f"decks/{old}"
        if s == prefix or s.startswith(prefix + "/"):
            tail = s[len(prefix):]
            if tail in (f'/{old}.html', f'/{old}.pdf'):
                tail = f'/{new}' + tail[tail.rfind('.'):]
            return f"decks/{new}" + tail
        return s
    if isinstance(value, dict):
        prose = {'text', 'summary', 'label', 'title', 'name', 'error', 'steps', 'drafts', 'session'}
        return {path(k): v if k in prose else _paths(v, old, new) for k, v in value.items()}
    if isinstance(value, list):
        return [_paths(v, old, new) for v in value]
    return path(value) if isinstance(value, str) else value


def _title(text, title):
    doc = source.parse(text)
    if doc.meta_error:
        raise StudioError(doc.meta_error)
    if not doc.front[1]:
        return set_front(text, {"title": json.dumps(title, ensure_ascii=False)})
    lines = text.splitlines(keepends=True)
    end = next(i for i in range(1, len(lines)) if lines[i].strip() in ("---", "..."))
    front = ''.join(lines[1:end])
    node = yaml.compose(front)
    if isinstance(node, yaml.MappingNode):
        if node.flow_style:
            encoded = json.dumps(title, ensure_ascii=False)
            for key, value in node.value:
                if key.value == 'title':
                    # compose は alias を解決するので、実際の値の開始位置は parse から読む。
                    event = next(event for event in yaml.parse(front) if event.start_mark.index >= key.end_mark.index)
                    alias = isinstance(event, yaml.AliasEvent)
                    stop = event.end_mark.index if alias else value.end_mark.index
                    replacement = f'&{event.anchor} {encoded}' if event.anchor and not alias else encoded
                    front = front[:event.start_mark.index] + replacement + front[stop:]
                    break
            else:
                pos = next(event.end_mark.index for event in yaml.parse(front) if isinstance(event, yaml.MappingStartEvent))
                front = front[:pos] + f"title: {encoded}" + (", " if node.value else "") + front[pos:]
            return lines[0] + front + ''.join(lines[end:])
        for key, value in node.value:
            if key.value == 'title':
                event = next(event for event in yaml.parse(front) if event.start_mark.index >= key.end_mark.index)
                alias = isinstance(event, yaml.AliasEvent)
                end = event.end_mark if alias else value.end_mark
                encoded = json.dumps(title, ensure_ascii=False)
                replacement = f'&{event.anchor} {encoded}' if event.anchor and not alias else encoded
                start = key.start_mark.line + 1
                stop = end.line + 1 + (end.column > 0)
                return ''.join(lines[:start]) + f"title: {replacement}\n" + ''.join(lines[stop:])
    return set_front(text, {"title": json.dumps(title, ensure_ascii=False)})


def rename(ws, deck, name, title=None):
    """フォルダ名（deck → name）とタイトルを変える。title が None ならタイトルはそのまま。"""
    check_name(deck); check_name(name, "フォルダ名")
    _safe(ws, ws.qmd(deck))
    ws.require_deck(deck)
    text = ws.qmd(deck).read_bytes().decode('utf-8')
    updated = text if title is None else _title(text, title)
    change = Change(ws)
    try:
        if deck != name:
            # 空のフォルダや残った状態も含め、既存のものを上書きしない。
            pairs = [(ws.deck_dir(deck), ws.deck_dir(name))] + [
                (ws.state / k / (f'{deck}.json' if k == 'chat' else deck), ws.state / k / (f'{name}.json' if k == 'chat' else name)) for k in ('build', 'snapshots', 'chat')]
            for src, dst in pairs:
                _safe(ws, src); _safe(ws, dst)
                if dst.exists():
                    raise StudioError(f"既にあります: {dst}")
            for ext in ('html', 'pdf'):
                if (ws.deck_dir(deck) / f'{name}.{ext}').exists():
                    raise StudioError(f"既にあります: {name}.{ext}")
            for src, dst in pairs:
                change.move(src, dst)
            for ext in ('html', 'pdf'):
                change.move(ws.deck_dir(name) / f'{deck}.{ext}', ws.deck_dir(name) / f'{name}.{ext}')
            snapshots = ws.state / 'snapshots' / name
            for snap in sorted(snapshots.iterdir()) if snapshots.exists() else []:
                _safe(ws, snap)
                change.move(snap / 'files' / 'decks' / deck, snap / 'files' / 'decks' / name)
                for ext in ('html', 'pdf'):
                    saved = snap / 'files' / 'decks' / name
                    change.move(saved / f'{deck}.{ext}', saved / f'{name}.{ext}')
                for filename in ('snapshot.json', 'manifest.json', 'after.json'):
                    p = snap / filename
                    _safe(ws, p)
                    if p.exists():
                        data = _paths(json.loads(p.read_text()), deck, name)
                        if filename == 'snapshot.json':
                            data['deck'] = name
                        change.write(p, json.dumps(data, ensure_ascii=False))
            chat = ws.state / 'chat' / f'{name}.json'
            for p in [chat] if chat.exists() else []:
                _safe(ws, p)
                change.write(p, json.dumps(_paths(json.loads(p.read_text()), deck, name), ensure_ascii=False))
            items = _recent(ws)
            for item in items:
                if item.get('deck') == deck:
                    item['deck'] = name
            change.write(ws.recent_file, json.dumps(items, ensure_ascii=False))
        change.write(ws.qmd(name), updated)
    except BaseException:
        change.rollback()
        raise
    return {'kind': 'rename', 'deck': deck, 'name': name, 'before': text, 'after': updated, 'change': change}


def delete(ws, deck):
    check_name(deck)
    _safe(ws, ws.qmd(deck))
    ws.require_deck(deck)
    change = Change(ws)
    trash = ws.state / 'trash' / deck / str(time.time_ns())
    items = _recent(ws)
    try:
        for src, dst in [(ws.deck_dir(deck), trash / 'deck')] + [
            (ws.state / k / (f'{deck}.json' if k == 'chat' else deck), trash / k) for k in ('chat', 'snapshots')]:
            change.move(src, dst)
        change.write(ws.recent_file, json.dumps([i for i in items if i.get('deck') != deck], ensure_ascii=False))
        _safe(ws, ws.build_dir(deck))
        if ws.build_dir(deck).exists():
            shutil.rmtree(ws.build_dir(deck))
    except BaseException:
        change.rollback()
        raise
    return {'kind': 'delete', 'deck': deck, 'trash': trash, 'recent': items}


def undo(ws, record):
    if record['kind'] == 'rename':
        _safe(ws, ws.qmd(record['name']))
        if ws.qmd(record['name']).read_bytes().decode('utf-8') != record['after']:
            raise StudioError('原稿が変わったため元に戻せません')
        change = rename(ws, record['name'], record['deck'])
        try:
            write_atomic(ws.qmd(record['deck']), record['before'])
        except BaseException:
            change['change'].rollback()
            raise
    else:
        change = Change(ws)
        deck, trash = record['deck'], record['trash']
        _safe(ws, trash / 'deck')
        if not (trash / 'deck' / 'slides.qmd').is_file():
            raise StudioError('ゴミ箱に発表が見つかりません')
        pairs = [(trash / 'deck', ws.deck_dir(deck))] + [(trash / k, ws.state / k / (f'{deck}.json' if k == 'chat' else deck)) for k in ('chat', 'snapshots')]
        for _, dst in pairs:
            _safe(ws, dst)
            if dst.exists():
                raise StudioError(f'既にあります: {dst}')
        try:
            for src, dst in pairs:
                change.move(src, dst)
            items = [i for i in _recent(ws) if i.get('deck') != deck]
            items += [i for i in record['recent'] if i.get('deck') == deck]
            change.write(ws.recent_file, json.dumps(items, ensure_ascii=False))
        except BaseException:
            change.rollback()
            raise


def install(app, srv, routes):
    from .server import _json
    latest = None

    def running(deck):
        return any(getattr(h, key, lambda d: False)(deck) for h in srv.hooks for key in ('slides_running', 'memo_locked'))

    def flush(deck):
        chat = getattr(app.state, 'chat', None)
        if chat and deck in chat.data:
            chat.save(deck)
            chat.data.pop(deck, None)

    async def manage(request):
        nonlocal latest
        body = await request.json()
        async with srv.operation_lock:
            try:
                action = body.get('action')
                if action == 'undo':
                    if not latest or body.get('token') != latest['token']:
                        raise StudioError('元に戻せる操作がありません')
                    decks = {latest['deck'], latest.get('name', latest['deck'])}
                elif action in ('rename', 'delete'):
                    decks = {check_name(body.get('deck'))}
                    if action == 'rename':
                        decks.add(check_name(body.get('name')))
                        if body.get('title') is not None and not isinstance(body['title'], str):
                            raise StudioError('タイトルを入力してください')
                else:
                    raise StudioError('操作が正しくありません')
                shooter = getattr(app.state, 'shots', None)
                # 撮影スレッドが次の発表を取り出す間も移動しない。
                with shooter.cond if shooter else contextlib.nullcontext():
                    if any(running(d) for d in decks):
                        return _json({'error': 'AI の実行が終わってから操作してください'}, 423)
                    if any(srv.state(d).lock.locked() for d in decks):
                        return _json({'error': '表示の更新が終わってから操作してください'}, 409)
                    checks = getattr(app.state, 'checks', None)
                    if (shooter and (shooter.active_deck in decks or shooter.active_job_deck in decks)) or (checks and any(d in checks.tasks for d in decks)):
                        return _json({'error': '表示の更新が終わってから操作してください'}, 409)
                    if shooter:
                        shooter.pending[:] = [d for d in shooter.pending if d not in decks]
                    for d in decks:
                        flush(d)
                    if action == 'undo':
                        undo(srv.ws, latest)
                        latest = None
                    else:
                        latest = (rename(srv.ws, body['deck'], body['name'], body.get('title')) if action == 'rename'
                                  else delete(srv.ws, body['deck']))
                        latest['token'] = uuid.uuid4().hex
                    for d in decks:
                        srv.decks.pop(d, None)
                    srv.broadcast({'type': 'files', 'paths': []})
                    return _json({'token': latest['token'] if latest else None})
            except (StudioError, OSError, ValueError) as e:
                return _json({'error': str(e)}, 400)

    app.router.routes.insert(0, Route('/api/home/manage', manage, methods=['POST']))
