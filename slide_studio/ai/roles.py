"""役割の正本。画面と実行で同じ定義を使う。設計書 §8.1.2。

どの担当も AI 本体の道具で置き場の中を作業し、指示は置き場の AGENTS.md・skill から読む（native.py）。
編集担当はタブの種類ごとに1つ。確認役は1つで、読むだけ（readonly）。
相談役は skill を持たず、編集担当が `slide-studio consult` で送った質問だけを受けて答える（読むだけ）。既定はオフ。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..fsutil import sha256_text
from ..workspace import StudioError

# 担当の動かし方が変われば、古い会話を続けない
NATIVE_REVISION = 'native-1'


@dataclass(frozen=True)
class Role:
    id: str
    skill: str | None  # 置き場の skill（相談役は持たない）
    configurable: bool = False
    web: bool = False  # AI に組み込みの web 検索
    readonly: bool = False  # 置き場に書かせない（確認役）
    default_on: bool = True  # タブで決めていないときに動かすか（相談役は既定でオフ）

    @property
    def schema(self):
        """最後の返事の形。None なら普通の文章。"""
        return {'chat': CHAT_SCHEMA, 'theme': REPLY_SCHEMA, 'draft': DRAFT_SCHEMA, 'review': REVIEW_SCHEMA}.get(self.id)

    @property
    def revision(self):
        # skill・返事の形・道具が変わっても、古い会話を続けない。
        return sha256_text(json.dumps([NATIVE_REVISION, self.skill, self.schema, self.web, self.readonly], ensure_ascii=False, sort_keys=True))


ROLES = {r.id: r for r in (
    Role('chat', 'slide-studio-slides', web=True),
    Role('theme', 'slide-studio-theme'),
    Role('draft', 'slide-studio-memo', web=True),
    Role('review', 'slide-studio-review', configurable=True, readonly=True),
    Role('consult', None, configurable=True, readonly=True, default_on=False),
)}
MODES = {'slides': 'chat', 'memo': 'draft', 'theme': 'theme'}
CONFIGURABLE_MODES = {mode: ('review', 'consult') for mode in MODES}
DEFAULT_ON = {r.id: r.default_on for r in ROLES.values() if r.configurable}  # 画面の切り替えの初期値
SUPPORTED_PROVIDERS = ('codex', 'claude', 'agy')
# 確認役を1つにする前の担当（A5）。保存済みの設定は、タブの種類ごとにこの順で最初にあるものを確認役に移す。
LEGACY_REVIEWS = {'slides': ('slide_review', 'html_review'), 'memo': ('draft_review',), 'theme': ('html_review',)}


def migrate(settings: dict, mode: str) -> dict:
    """古い3つの確認の担当の設定を、確認役（review）に寄せる。ほかの古い担当（html など）は捨てる。"""
    out = {k: v for k, v in (settings or {}).items() if k in CONFIGURABLE_MODES.get(mode, ())}
    if 'review' not in out:
        old = next((settings[k] for k in LEGACY_REVIEWS.get(mode, ()) if (settings or {}).get(k)), None)
        if old:
            out['review'] = old
    return out


def get(role: str) -> Role:
    if role not in ROLES:
        raise StudioError('担当の種類が正しくありません')
    return ROLES[role]


EXTRA_LIMIT = 4000  # 追加指示の長さの上限（文字）
EXTRA_LABEL = '[利用者の追加指示] この担当にいつも求めること。AGENTS.md・skill の決まりと食い違うときは、そちらを優先する。'


def base_files(ws, role: str) -> list[dict]:
    """必須の指示：AI が置き場で読む AGENTS.md と担当の skill。画面では読むだけ（アプリからは変えない）。"""
    out = []
    skill = get(role).skill
    for rel in ('AGENTS.md', *([f'.agents/skills/{skill}/SKILL.md'] if skill else [])):
        try:
            text = (ws.root / rel).read_text()
        except OSError:
            text = ''
        out.append({'path': rel, 'text': text})
    return out


def extra(ws, role: str) -> str:
    return (ws.prefs().get('ai_instructions') or {}).get(role, '')


def set_extra(ws, role: str, text) -> str:
    get(role)
    if not isinstance(text, str):
        raise StudioError('追加指示の形式が正しくありません')
    text = text.strip()
    if len(text) > EXTRA_LIMIT:
        raise StudioError(f'追加指示は {EXTRA_LIMIT} 文字までです')
    saved = dict(ws.prefs().get('ai_instructions') or {})
    if text:
        saved[role] = text
    else:
        saved.pop(role, None)
    ws.set_prefs(ai_instructions=saved)
    return text


def with_extra(ws, role: str, prompt: str) -> str:
    """追加指示は送信のたびに依頼の前に添える（続きの会話でも、直した内容がすぐ効く）。"""
    text = extra(ws, role)
    return f'{EXTRA_LABEL}\n{text}\n\n{prompt}' if text else prompt


def require_provider(model: str):
    if not model:
        raise StudioError('使える AI がありません。ログインとモデルの選択を確認してください')
    if model.split(':', 1)[0] not in SUPPORTED_PROVIDERS:
        raise StudioError('この AI には対応していません。Codex・Claude Code・Antigravity から選んでください')


def enabled(settings: dict, role: str) -> bool:
    return (settings.get(role) or {}).get('enabled', get(role).default_on)


def resolve(role: str, parent: dict, settings: dict, provider_of) -> dict:
    try:
        return _resolve(role, parent, settings, provider_of)
    except StudioError as exc:
        # 表示名は web/strings.js に集約。クライアントが役割IDを日本語に置き換える。
        raise StudioError(f'[{role}] {exc}') from exc


def _resolve(role: str, parent: dict, settings: dict, provider_of) -> dict:
    get(role)
    if not enabled(settings, role):
        return {**(settings.get(role) or {}), 'enabled': False}
    configured = settings.get(role)
    if not get(role).configurable:
        selected = parent  # 編集担当はチャットで選んだモデル・思考量をそのまま使う
    else:
        selected = configured if configured and configured.get('model') else {'model': parent['model']}
    model = selected['model']
    require_provider(model)
    p, m = provider_of(model)
    if not p or not p['ok'] or not m:
        raise StudioError(f'担当に設定された AI が使えません: {model}')
    effort = selected.get('effort')
    if effort is None:
        effort = m['effort']
    if effort is not None and effort not in m['efforts']:
        raise StudioError(f'このモデルで使えない思考量です: {effort}')
    # 既定でオフの担当は、オンにしたことを送信の記録にも残す
    return {'model': model, 'effort': effort, **({} if get(role).default_on else {'enabled': True})}


def tab_settings(mode, current, changes, provider_of):
    """1つ以上の担当を部分更新。他タブや同時に変更した別担当を上書きしない。"""
    if not isinstance(changes, dict) or set(changes) - set(CONFIGURABLE_MODES.get(mode, ())):
        raise StudioError('このチャットでは設定できない担当です')
    result = dict(current)
    for role, value in changes.items():
        # オン・オフはモデルとは別の設定。モデルや思考量を変えても、チャットに追従へ戻しても保つ
        kept = (current.get(role) or {}).get('enabled')
        if value is None:
            result.pop(role, None)
            if kept is not None:
                result[role] = {'enabled': kept}
        else:
            if (not isinstance(value, dict) or not value or set(value) - {'model', 'effort', 'enabled'}
                    or ('enabled' in value and not isinstance(value['enabled'], bool))
                    or ('model' in value and not isinstance(value['model'], str))
                    or ('model' not in value and set(value) != {'enabled'})):
                raise StudioError('AI 設定の形式が正しくありません')
            if set(value) == {'enabled'}:
                result[role] = {**result.get(role, {}), **value}
            else:
                # モデルの確認は、オフでも必ず行う（オフの担当は resolve が確かめずに返すため、オンとして確かめる）
                result[role] = resolve(role, {}, {role: {k: v for k, v in value.items() if k != 'enabled'} | {'enabled': True}}, provider_of)
                result[role].pop('enabled', None)
                on = value.get('enabled', kept)
                if on is not None:
                    result[role]['enabled'] = on
    return result



REVIEW_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {'summary': {'type': 'string'}, 'issues': {'type': 'array', 'items': {
        'type': 'object', 'additionalProperties': False,
        'properties': {k: {'type': 'string'} for k in ('target', 'message', 'suggestion')},
        'required': ['target', 'message', 'suggestion']}}},
    'required': ['summary', 'issues'],
}
CHAT_SCHEMA = json.loads((Path(__file__).with_name('schema.json')).read_text())
QUESTIONS_SCHEMA = CHAT_SCHEMA['properties']['questions']
MAX_QUESTIONS, MAX_OPTIONS = 3, 4
# テーマのチャットと話し合いの返事
REPLY_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {'summary': {'type': 'string'}, 'questions': QUESTIONS_SCHEMA},
    'required': ['summary', 'questions'],
}
# 下書きの返事。slides が空でなければ、送信の後にスライドのチャットへ引き渡す（設計書 §8.8）。
# rebuild は、利用者が今のスライドの作り直しを頼んだときだけ true（既定は変わった所だけの反映）。
DRAFT_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {'reply': {'type': 'string'}, 'slides': {'type': 'string'}, 'rebuild': {'type': 'boolean'}, 'questions': QUESTIONS_SCHEMA},
    'required': ['reply', 'slides', 'rebuild', 'questions'],
}


def clean_questions(value, items: int) -> list[dict]:
    """AI が返した確認のうち、画面に出せるものだけを残す。item は指示の番号（範囲の外は 1）。"""
    out = []
    for q in value if isinstance(value, list) else []:
        if not isinstance(q, dict) or not isinstance(q.get('text'), str) or not q['text'].strip():
            continue
        options, seen = [], set()
        for o in q.get('options') if isinstance(q.get('options'), list) else []:
            label = o.get('label') if isinstance(o, dict) else None
            if isinstance(label, str) and label.strip() and label.strip() not in seen:
                seen.add(label.strip())
                options.append({'label': label.strip(), 'description': str(o.get('description') or '').strip()})
        item = q.get('item')
        if options:
            out.append({'item': item if type(item) is int and 1 <= item <= items else 1, 'text': q['text'].strip(),
                        'options': options[:MAX_OPTIONS], 'multiple': q.get('multiple') is True})
    return out[:MAX_QUESTIONS]
