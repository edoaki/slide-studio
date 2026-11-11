"""1送信の実行（編集担当と、その後の確認役）。控えと編集ロックは呼出元Chatが送信全体に保持する。

どの担当も AI 本体の道具で置き場の中を作業する（native.py）。確認役は読むだけで、会話はタブごとに続ける。
相談役は、編集担当の作業中に `slide-studio consult` で頼まれたときだけ動く（Chat.run_consult）。依頼文は質問そのもの。
話し合い（record の talk）は、編集担当の同じ会話のまま読むだけで動かし、返事は普通の文章。
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid

from .. import check
from ..fsutil import sha256_bytes
from ..workspace import StudioError
from . import native, roles
from .providers import PROVIDERS, split_key

JAPANESE = re.compile(r'[぀-ヿ一-鿿]')
CONTEXT_LIMIT = 64000


def rate_limited(error) -> bool:
    return bool(re.search(r'\b429\b|too many requests|rate.?limit', str(error), re.I))


def ai_error(name: str, error) -> str:
    """AI 本体が返した英語のエラーに日本語の案内を付ける（原文は括弧に残す）。日本語の文はそのまま。"""
    text = str(error).strip()
    if JAPANESE.search(text):
        return text
    return f'{name} とのやりとりに失敗しました。もう一度送ってください' + (f'（{text}）' if text else '')


def final_json(value):
    """担当の最後の返事（JSON 文字列か dict）。```json の囲みは外す。"""
    if isinstance(value, str):
        value = json.loads(value.strip().removeprefix('```json').removeprefix('```').removesuffix('```').strip())
    return value


def review_value(value) -> dict:
    """確認役の返事（roles.REVIEW_SCHEMA）。形が違えば StudioError。"""
    try:
        value = final_json(value)
    except (TypeError, ValueError) as exc:
        raise StudioError('確認役の返事の形が正しくありません') from exc
    keys = roles.REVIEW_SCHEMA['properties']['issues']['items']['required']
    if (not isinstance(value, dict) or not isinstance(value.get('summary'), str) or not isinstance(value.get('issues'), list)
            or not all(isinstance(i, dict) and all(isinstance(i.get(k), str) for k in keys) for i in value['issues'])):
        raise StudioError('確認役の返事の形が正しくありません')
    return {'summary': value['summary'], 'issues': [{k: i[k] for k in keys} for i in value['issues']]}


def consult_line(tab_id: str) -> str:
    """編集担当に、相談役の呼び方を知らせる。タブの id は送信をまたいで変わらない（直しの依頼でも同じ行が使える）。"""
    return (f'[相談役] 迷ったとき・別の意見がほしいときは `slide-studio consult --tab {tab_id} "質問"` で別の AI に相談できる（答えが出力される）。'
            '相談役はこの会話を見ていないので、要点と読むべきファイルのパスを質問に書く。相談役はファイルを変えない。')


class Workflow:
    def __init__(self, chat, deck, tab, record):
        self.chat, self.ws, self.deck, self.tab, self.r = chat, chat.ws, deck, tab, record
        self.theme = record.get('theme') or self.ws.deck_theme(deck)
        self.settings = json.loads(json.dumps(record.get('ai_roles', tab.get('ai_roles', {}))))
        self.active = []
        self.cancelled = False
        self.parent = None
        self.r.setdefault('agents', [])

    def __getattr__(self, name):
        if name in ('session', 'final', 'errors', 'stderr', 'returncode'):
            return getattr(self.parent, name) if self.parent else {'session': None, 'final': '', 'errors': [], 'stderr': '', 'returncode': None}[name]
        raise AttributeError(name)

    def step(self, record, step):
        step = {**step, 'role': record['role'],
                'id': f"{record['id']}:{step['id']}" if step.get('id') else None}
        self.chat._step(self.deck, self.r, step)

    def version(self):
        """確認した対象の版。確認の間に変われば、その確認は古い（stale）。"""
        mode = self.r.get('mode', 'slides')
        if mode == 'memo':
            p = self.ws.memo(self.deck)
            return sha256_bytes(p.read_bytes() if p.exists() else b'')
        if mode == 'theme':
            p = self.ws.themes / f'{self.theme}.css'
            return sha256_bytes(p.read_bytes() if p.exists() else b'')
        return check.deck_version(self.ws, self.deck)

    def renew_session(self, key):
        context = self.tab.get(key + '_context') or {}
        # 更新前に失敗した会話にも適用する。成功済みの古い失敗は見ない。
        if not context and self.tab.get(key) and hasattr(self.chat, 'state'):
            for previous in reversed(self.chat.state(self.deck)['rounds']):
                if previous.get('tab') != self.tab.get('id'):
                    continue
                agent = next((a for a in reversed(previous.get('agents', []))
                              if a.get('session') == self.tab[key]), None)
                if agent:
                    return rate_limited(agent.get('error', ''))
        if context.get('session') != self.tab.get(key):
            return False
        limit = min(CONTEXT_LIMIT, (context.get('window') or CONTEXT_LIMIT / .7) * .7)
        return context.get('reset', False) or (context.get('used') or 0) >= limit

    async def execute(self, role, prompt, *, parent=False, images=None, talk=False):
        if not parent and not roles.enabled(self.settings, role):
            raise StudioError(f'[{role}] この担当はオフです')
        if self.cancelled or self.r['cancel']:
            raise StudioError('実行は中断しています')
        try:
            chosen = roles.resolve(role, self.r, {} if parent else self.settings, self.chat.provider_of)
        except StudioError as exc:
            failed = {'id': uuid.uuid4().hex, 'role': role, 'parent': parent, 'state': 'error',
                      'summary': '', 'issues': [], 'error': str(exc)}
            self.r['agents'].append(failed)
            self.chat.save(self.deck)
            self.chat.broadcast(self.deck, self.r)
            raise
        definition = roles.get(role)
        record = {'id': uuid.uuid4().hex, 'role': role, **chosen, 'state': 'run', 'session': None,
                  'prompt_revision': definition.revision, 'summary': '', 'issues': [], 'parent': parent}
        if role == 'consult':
            record['question'] = prompt
        self.r['agents'].append(record)
        review = role == 'review'
        # 会話はタブごとに、編集担当・確認役・相談役で別々に続ける。異なる役割・モデル・改訂の履歴は resume しない。
        keys = ('session', 'role_binding') if parent else (f'{role}_session', f'{role}_binding')
        binding = f"{role}:{chosen['model']}:{definition.revision}"
        session = self.tab.get(keys[0]) if self.tab.get(keys[1]) == binding else None
        provider = PROVIDERS[split_key(chosen['model'])[0]]
        session_home = str(provider.home()) if provider.id in ('codex', 'claude') else None
        if session and session_home and self.tab.get(keys[0] + '_home') != session_home:
            session = None
            if parent and self.tab.get(keys[0]):
                prompt = self.chat.conversation_handover(self.deck, self.tab['id'], exclude=self.r['id']) + '\n\n' + prompt
        if session and self.renew_session(keys[0]):
            session = None
            record['context_reset'] = True
            if parent:
                prompt = self.chat.conversation_handover(self.deck, self.tab['id'], exclude=self.r['id']) + '\n\n' + prompt
        if parent and self.tab.get('session') and session is None and not record.get('context_reset'):
            self.r['session_reset'] = True

        def on_session(sid):
            if sid != self.tab.get(keys[0]):
                self.tab.pop(keys[0] + '_context', None)
            record['session'] = sid
            self.tab.update({keys[0]: sid, keys[1]: binding})
            self.tab[keys[0] + '_home'] = session_home
            self.chat.save(self.deck, soon=True)
        def on_usage(usage):
            context = self.tab.setdefault(keys[0] + '_context', {})
            context.update({k: v for k, v in usage.items() if v is not None})
            context['session'] = record['session']
            record['context'] = dict(context)
            if parent:
                self.chat._usage(self.deck, self.r, usage)
            self.chat.save(self.deck, soon=True)
        # 話し合いは会話（binding）を編集担当と共有し、この回だけ読むだけにする
        schema, readonly = (roles.REPLY_SCHEMA, True) if talk else (definition.schema, definition.readonly)
        callbacks = dict(on_session=on_session, on_step=lambda s: self.step(record, s),
                         on_usage=on_usage,
                         on_limits=lambda lim: self.chat._limits(provider.id, lim))
        roles.require_provider(chosen['model'])
        prompt = roles.with_extra(self.ws, role, prompt)
        # 起動したままの AI（Chat が持つ live.Pool）。Claude Code はタブ・担当ごとに1つ
        run = native.make_run(provider, self.ws, prompt, session, split_key(chosen['model'])[1], chosen['effort'],
                              images or [], schema, definition.web, readonly=readonly,
                              pool=getattr(self.chat, 'live', None), key=(self.tab.get('id'), role), **callbacks)
        if parent:
            self.parent = run
        self.active.append(run)
        try:
            before = self.version() if review else None
            try:
                await run.run()
            except (ValueError, OSError) as exc:  # AI 本体への依頼の失敗（通信・時間切れなど）
                raise StudioError(ai_error(provider.name, exc)) from exc
            if run.cancelled or self.cancelled or self.r['cancel']:
                self.cancelled = True
                self.r['cancel'] = True
                record['state'] = 'cancelled'
                raise StudioError('実行は中断しました')
            if run.returncode:
                raise StudioError(ai_error(provider.name, run.errors[-1] if run.errors else run.stderr or '担当の実行に失敗しました'))
            if review:
                record.update(review_value(run.final), version=before)
                record['state'] = 'stale' if before != self.version() else 'needs_fix' if record['issues'] else 'complete'
            else:
                record.update(state='complete', summary=run.final if isinstance(run.final, str) else json.dumps(run.final, ensure_ascii=False))
            return record
        except asyncio.CancelledError:
            record['state'] = 'cancelled'
            run.kill_now()
            raise
        except Exception as exc:
            if rate_limited(exc):
                self.tab[keys[0] + '_context'] = {'session': self.tab.get(keys[0]), 'reset': True}
            if record['state'] == 'run':
                record['state'] = 'cancelled' if self.cancelled or self.r['cancel'] else 'error'
            record['error'] = str(exc)
            raise
        finally:
            if run.returncode is None:
                run.kill_now()
            self.active.remove(run)
            self.chat.save(self.deck)
            self.chat.broadcast(self.deck, self.r)

    async def run(self, prompt, images):
        role = roles.MODES[self.r.get('mode', 'slides')]
        talk = self.r.get('talk', False)
        # 相談は置き場に依頼を書くので、読むだけの話し合いでは使えない
        if self.tab.get('id') and roles.enabled(self.settings, 'consult') and not talk:
            prompt = f"{prompt}\n\n{consult_line(self.tab['id'])}"
        await self.execute(role, prompt, parent=True, images=images, talk=talk)
        return self

    def wanted(self, files) -> bool:
        """確認するか。下書きは memo.md、テーマは CSS が変わったとき。スライドは何か変わったとき（memo.md だけでも）。"""
        if not roles.enabled(self.settings, 'review'):
            return False
        changed = {n for k in ('modified', 'added', 'deleted') for n in (files or {}).get(k, [])}
        mode = self.r.get('mode', 'slides')
        if self.r.get('review_only'):
            return True
        if mode == 'memo':
            return f'decks/{self.deck}/memo.md' in changed
        if mode == 'theme':
            return f'themes/{self.theme}.css' in changed
        return bool(changed) or bool(self.r.get('review_only'))

    async def review(self, files, prompt):
        """確認役を1回動かし、その記録を返す。確認しなくてよい・検査のエラーで飛ばしたときは None。

        prompt は依頼文を作る関数（確認するときだけ呼ぶ。引数は、確認役の会話が続くか）。
        確認役が動かなかった・返事の形が違うときは、state が error の記録を返す（送信全体は失敗にしない）。
        """
        if self.cancelled or self.r['cancel'] or not self.wanted(files):
            return None
        if any(not x.get('old') for x in (self.r.get('check') or {}).get('errors', [])):
            self.r['agents'].append({'id': uuid.uuid4().hex, 'role': 'review', 'parent': False, 'state': 'skipped',
                                     'summary': '機械検査のエラーを直してから確認してください。', 'issues': []})
            return None
        # 同じ版で済んでいる確認は使い回す
        current = self.version()
        existing = next((a for a in reversed(self.r['agents']) if a['role'] == 'review' and a.get('version') == current
                         and a['state'] in ('complete', 'needs_fix')), None)
        if existing:
            return existing
        try:
            chosen = roles.resolve('review', self.r, self.settings, self.chat.provider_of)
            again = (bool(self.tab.get('review_session')) and not self.renew_session('review_session')
                     and self.tab.get('review_binding') == f"review:{chosen['model']}:{roles.get('review').revision}")
        except StudioError:
            again = False
        count = len(self.r['agents'])
        try:
            return await self.execute('review', await prompt(again))
        except Exception:
            if self.cancelled or self.r['cancel'] or len(self.r['agents']) == count:
                raise
            return self.r['agents'][-1]

    async def cancel(self):
        self.cancelled = True
        self.r['cancel'] = True
        for run in reversed(list(self.active)):
            await run.cancel()

    def kill_now(self):
        self.cancelled = True
        for run in reversed(list(self.active)):
            run.kill_now()
