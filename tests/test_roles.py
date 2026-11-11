"""担当の設定・移行・native 実行と確認の会話。実AIは呼ばない。"""
import asyncio
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from conftest import add_deck
from e2e.conftest import DECK
from slide_studio.ai import native, roles, workflow
from slide_studio.ai.providers import PROVIDERS
from slide_studio.fsutil import sha256_text, write_atomic
from slide_studio.workspace import StudioError


def provider_of(key):
    if key not in ('codex:main', 'claude:other'):
        return None, None
    return {'ok': True}, {'efforts': ['low', 'high'], 'effort': 'low'}


@pytest.fixture
def flow(ws):
    add_deck(ws, 'talk', DECK)
    ws.memo('talk').write_text('下書き')
    chat = SimpleNamespace(ws=ws, provider_of=provider_of, save=lambda *a, **k: None,
                           broadcast=lambda *a: None, _step=lambda *a: None, _usage=lambda *a: None)
    record = {'id': 'round', 'mode': 'slides', 'model': 'codex:main', 'effort': 'high', 'cancel': False,
              'items': [{'text': '図を作って'}]}
    return workflow.Workflow(chat, 'talk', {}, record)


def test_restart_marks_inflight_children_failed(flow):
    from slide_studio.ai.chat import Chat
    data = {'tabs': [], 'rounds': [{'state': 'review', 'agents': [{'state': 'run', 'role': 'review'}]}]}
    write_atomic(flow.ws.state / 'chat' / 'talk.json', json.dumps(data))
    chat = Chat(SimpleNamespace(ws=flow.ws))
    round = chat.state('talk')['rounds'][0]
    assert round['state'] == 'error'
    assert round['agents'][0]['state'] == 'error'


def test_review_changes_do_not_expand_undo_to_user_edits(flow):
    from slide_studio import snapshot
    snap = snapshot.take(flow.ws, 'talk')
    before = flow.ws.qmd('talk').read_text()
    flow.ws.qmd('talk').write_text(before.replace('最初の段落。', 'AIの編集'))
    snapshot.finish(flow.ws, snap)
    flow.ws.memo('talk').write_text('確認中に利用者が編集した下書き')
    theme = flow.ws.themes / 'default.css'
    theme.write_text(theme.read_text() + '\n/* 利用者の変更 */')
    assert snapshot.changes_since_finish(flow.ws, snap) == ['decks/talk/memo.md', 'themes/default.css']
    snapshot.restore_run(flow.ws, snap)
    assert flow.ws.qmd('talk').read_text() == before
    assert flow.ws.memo('talk').read_text() == '確認中に利用者が編集した下書き'
    assert '利用者の変更' in theme.read_text()


def test_send_freezes_resolved_tab_roles(ws, monkeypatch):
    from slide_studio.ai.chat import Chat
    add_deck(ws, 'talk', DECK)
    chat = Chat(SimpleNamespace(ws=ws, broadcast=lambda *a: None, state=lambda deck: SimpleNamespace(rendered=None)))
    chat.status = {'providers': [{'id': 'codex', 'name': 'Codex', 'ok': True, 'default': 'main',
        'models': [{'id': 'main', 'name': 'Main', 'efforts': ['low','high'], 'effort': 'low'}]},
        {'id': 'claude', 'name': 'Claude', 'ok': True, 'default': 'other',
        'models': [{'id':'other','name':'Other','efforts':['low','high'],'effort':'low'}]}]}
    tab = chat.state('talk')['tabs'][0]
    tab.update(model='codex:main', effort='high', ai_roles={'review': {'model':'claude:other','effort':'low'}, 'consult': {'enabled': True}})
    async def no_run(*args): pass
    monkeypatch.setattr(chat, '_run', no_run)
    async def run():
        record = chat.send('talk', tab['id'], sha256_text(ws.qmd('talk').read_text()), [{'key':'deck','label':'全体','text':'確認'}])
        tab['ai_roles']['review']['model'] = 'codex:main'
        flow = workflow.Workflow(chat, 'talk', tab, record)
        assert flow.settings['review'] == {'model':'claude:other','effort':'low'}
        assert set(flow.settings) == {'review', 'consult'}
        assert flow.settings['consult'] == {'model': 'codex:main', 'effort': 'low', 'enabled': True}  # モデルだけチャットに追従
        assert roles.enabled(flow.settings, 'consult')
        record['ai_roles']['review']['model'] = 'codex:main'
        assert flow.settings['review']['model'] == 'claude:other'
        await asyncio.gather(*chat.tasks)
    asyncio.run(run())


def test_favorites_never_change_the_active_model(ws):
    from slide_studio.ai.chat import Chat, FAVORITES_LIMIT
    chat = Chat(SimpleNamespace(ws=ws, broadcast=lambda *a: None))
    chat.ai_status = lambda: chat._defaults()
    ws.set_prefs(ai_favorites=['codex:main'])
    chat._use_model('claude:other')
    assert ws.prefs()['ai_favorites'] == ['codex:main']
    assert chat.set_favorites([])['favorites'] == []
    assert ws.prefs()['ai_last'] == 'claude:other'
    with pytest.raises(StudioError, match='件まで'):
        chat.set_favorites([f'codex:m{i}' for i in range(FAVORITES_LIMIT + 1)])
    assert ws.prefs()['ai_favorites'] == []


def test_workspace_skills_include_shared_format(ws):
    skill = (ws.root / '.agents/skills/slide-studio-slides/SKILL.md').read_text()
    assert '{{ref:' not in skill
    assert 'figure.mjs' in skill
    assert 'renderStep' in skill


@pytest.mark.parametrize('role_id', ['chat', 'draft', 'theme', 'review'])
def test_native_revision_follows_skill_schema_web_and_harness(role_id, monkeypatch):
    from dataclasses import replace
    role = roles.get(role_id)
    before = role.revision
    assert replace(role, skill='another-skill').revision != before
    assert replace(role, web=not role.web).revision != before
    assert replace(role, readonly=not role.readonly).revision != before
    with monkeypatch.context() as patch:
        patch.setattr(roles.Role, 'schema', property(lambda self: {'type': 'string'}))
        assert role.revision != before
    monkeypatch.setattr(roles, 'NATIVE_REVISION', 'native-next')
    assert role.revision != before


def test_settings_inherit_and_model_default():
    parent = {'model': 'codex:main', 'effort': 'high'}
    assert roles.resolve('review', parent, {}, provider_of) == {'model': 'codex:main', 'effort': 'low'}
    assert roles.resolve('review', {'model': 'codex:main'}, {}, provider_of) == {'model': 'codex:main', 'effort': 'low'}
    assert roles.resolve('review', parent, {'review': {'model': 'claude:other'}}, provider_of) == {'model': 'claude:other', 'effort': 'low'}
    for selected in ({'model': 'codex:missing'}, {'model': 'unsupported:main'}, {'model': 'codex:main', 'effort': 'bad'}):
        with pytest.raises(StudioError, match=r'\[review\]'):
            roles.resolve('review', parent, {'review': selected}, provider_of)


@pytest.mark.parametrize('role_id', ['chat', 'draft', 'theme'])
def test_editing_role_uses_selected_chat_effort(role_id):
    assert roles.resolve(role_id, {'model': 'codex:main', 'effort': 'high'}, {}, provider_of) == {
        'model': 'codex:main', 'effort': 'high'}
    assert roles.resolve(role_id, {'model': 'codex:main', 'effort': None}, {}, provider_of) == {
        'model': 'codex:main', 'effort': 'low'}


@pytest.mark.parametrize('mode', ['slides', 'memo', 'theme'])
def test_only_subagents_are_configurable(mode):
    assert roles.CONFIGURABLE_MODES[mode] == ('review', 'consult')
    saved = roles.tab_settings(mode, {}, {'review': {'model': 'claude:other'}}, provider_of)
    assert saved == {'review': {'model': 'claude:other', 'effort': 'low'}}
    assert roles.tab_settings(mode, saved, {}, provider_of) == saved
    assert roles.tab_settings(mode, saved, {'review': None}, provider_of) == {}
    assert saved['review']['model'] == 'claude:other'  # 入力を変えない
    for invalid in ('chat', 'draft', 'theme', 'html', 'html_review', 'slide_review', 'draft_review'):
        with pytest.raises(StudioError):
            roles.tab_settings(mode, saved, {invalid: None}, provider_of)
    for invalid in ([], {'review': []}, {'review': {}}, {'review': {'model': 1}},
                    {'review': {'model': 'codex:main', 'extra': True}}):
        with pytest.raises(StudioError):
            roles.tab_settings(mode, saved, invalid, provider_of)


def test_roles_use_workspace_skills_and_native_tools():
    assert set(roles.ROLES) == {'chat', 'theme', 'draft', 'review', 'consult'}
    assert {r.id for r in roles.ROLES.values() if r.web} == {'chat', 'draft'}
    assert {r.id for r in roles.ROLES.values() if r.readonly} == {'review', 'consult'}
    assert {r.id for r in roles.ROLES.values() if r.configurable} == {'review', 'consult'}
    assert roles.get('review').skill == 'slide-studio-review'
    # 相談役は skill も返事の形も持たない（質問だけを受ける）
    assert roles.get('consult').skill is None and roles.get('consult').schema is None
    for role in roles.ROLES.values():
        assert role.id == 'consult' or role.skill.startswith('slide-studio-')
    with pytest.raises(StudioError):
        roles.get('html')


@pytest.mark.parametrize(('mode', 'old', 'expected'), [
    ('slides', {'slide_review': {'model': 'codex:main'}, 'html_review': {'model': 'claude:other'}}, {'model': 'codex:main'}),
    ('slides', {'html_review': {'model': 'claude:other'}}, {'model': 'claude:other'}),
    ('memo', {'draft_review': {'model': 'codex:main'}, 'html_review': {'model': 'claude:other'}}, {'model': 'codex:main'}),
    ('theme', {'html_review': {'model': 'claude:other'}, 'slide_review': {'model': 'codex:main'}}, {'model': 'claude:other'}),
    ('slides', {'draft_review': {'model': 'codex:main'}}, None),
    ('memo', {'html_review': {'model': 'codex:main'}}, None),
    ('theme', {'draft_review': {'model': 'codex:main'}}, None),
])
def test_migrate_legacy_roles(mode, old, expected):
    settings = {**old, 'html': {'model': 'codex:missing'}}
    original = json.loads(json.dumps(settings))
    migrated = roles.migrate(settings, mode)
    assert migrated == ({'review': expected} if expected else {})
    assert roles.migrate(migrated, mode) == migrated
    assert settings == original


@pytest.mark.parametrize('mode', ['slides', 'memo', 'theme'])
def test_migrate_preserves_review_and_discards_html(mode):
    current = {'model': 'claude:other', 'effort': 'high'}
    old = {k: {'model': 'codex:main'} for k in ('html', 'html_review', 'slide_review', 'draft_review')}
    assert roles.migrate({**old, 'review': current}, mode) == {'review': current}
    assert roles.migrate({'html': old['html']}, mode) == {}
    assert roles.migrate({}, mode) == {}
    assert roles.migrate(None, mode) == {}


@pytest.mark.parametrize('source', ['tab', 'prefs'])
@pytest.mark.parametrize(('mode', 'legacy'), [('slides', 'slide_review'), ('memo', 'draft_review'), ('theme', 'html_review')])
def test_tab_ai_roles_migrate_and_save_once(ws, monkeypatch, source, mode, legacy):
    from slide_studio.ai.chat import Chat
    add_deck(ws, 'talk', DECK)
    srv = SimpleNamespace(ws=ws, broadcast=lambda *a: None)
    chat = Chat(srv)
    original = {'html': {'model': 'codex:missing'}, 'html_review': {'model': 'codex:main'},
                legacy: {'model': 'claude:other', 'effort': 'high'}}
    old = chat._new_tab({'tabs': []}, mode=mode)
    if source == 'tab':
        old['ai_roles'] = original
        ws.set_prefs(ai_roles={'review': {'model': 'codex:main'}})
    else:
        old.pop('ai_roles')
        ws.set_prefs(ai_roles=original)
    write_atomic(chat.path('talk'), json.dumps({'tabs': [old], 'rounds': []}))
    save = Mock(wraps=chat.save)
    monkeypatch.setattr(chat, 'save', save)
    tab = chat.state('talk')['tabs'][0]
    expected = {'review': original[legacy]}
    assert tab['ai_roles'] == expected
    assert json.loads(chat.path('talk').read_text())['tabs'][0]['ai_roles'] == expected
    assert chat.state('talk')['tabs'][0]['ai_roles'] == expected
    save.assert_called_once_with('talk')
    ws.set_prefs(ai_roles={'review': {'model': 'codex:main'}})
    reloaded = Chat(srv)
    reloaded_save = Mock(wraps=reloaded.save)
    monkeypatch.setattr(reloaded, 'save', reloaded_save)
    assert reloaded.state('talk')['tabs'][0]['ai_roles'] == expected
    reloaded_save.assert_not_called()
    assert reloaded.add_tab('talk', mode=mode)['ai_roles'] == {}
    # 設定を解除しても、次の起動で prefs から戻ってこない。
    reloaded.provider_of = provider_of
    reloaded.update_tab('talk', tab['id'], {'ai_roles': {'review': None}})
    assert Chat(srv).state('talk')['tabs'][0]['ai_roles'] == {}


def test_tab_roles_validate_merge_and_isolate(ws):
    from slide_studio.ai.chat import Chat
    add_deck(ws, 'talk', DECK)
    chat = Chat(SimpleNamespace(ws=ws, broadcast=lambda *a: None))
    chat.provider_of = provider_of
    tab = chat.state('talk')['tabs'][0]
    fresh = chat.add_tab('talk')
    chat.update_tab('talk', tab['id'], {'ai_roles': {'review': {'model': 'claude:other'}}})
    assert tab['ai_roles'] == {'review': {'model': 'claude:other', 'effort': 'low'}}
    assert fresh['ai_roles'] == {}
    for bad in ({'html': None}, {'html_review': None}, {'draft_review': None}, {'slide_review': None},
                {'review': {'model': 'codex:missing'}}, {'review': {'model': 'codex:main', 'effort': 'bad'}}):
        with pytest.raises(StudioError):
            chat.update_tab('talk', tab['id'], {'ai_roles': bad})
    chat.update_tab('talk', tab['id'], {'ai_roles': {'review': None}})
    assert tab['ai_roles'] == {}
    chat.state('talk')['rounds'].append({'tab': tab['id'], 'state': 'review'})
    with pytest.raises(StudioError, match='作業中'):
        chat.update_tab('talk', tab['id'], {'ai_roles': {'review': None}})


@pytest.mark.parametrize('readonly', [False, True])
@pytest.mark.parametrize('web', [False, True])
def test_native_codex_permissions(ws, readonly, web):
    from slide_studio.ai.app_server import AppServerRun
    run = native.make_run(PROVIDERS['codex'], ws, '確認', 'previous', 'main', 'high', [], roles.REVIEW_SCHEMA, web, readonly=readonly)
    assert isinstance(run, AppServerRun)
    assert run.cwd == ws.root
    config = dict(run.argv[i + 1].split('=', 1) for i, arg in enumerate(run.argv) if arg == '-c')
    assert json.loads(config['web_search']) == ('live' if web else 'disabled')
    if readonly:
        assert run.sandbox == 'read-only'
        assert set(config) == {'web_search'}  # default_permissions / permissions は渡さない
    else:
        assert run.sandbox is None
        assert json.loads(config['default_permissions']) == 'slide-studio'
        assert json.loads(config['permissions.slide-studio.extends']) == ':workspace'
        import tomllib
        permissions = tomllib.loads('filesystem = ' + config['permissions.slide-studio.filesystem'])['filesystem']
        assert permissions == {str(ws.state / name): 'read' for name in ('snapshots', 'chat')}


@pytest.mark.parametrize('readonly', [False, True])
@pytest.mark.parametrize('web', [False, True])
def test_native_claude_permissions(ws, readonly, web):
    run = native.make_run(PROVIDERS['claude'], ws, '確認', 'previous', 'other', 'high', [], roles.REVIEW_SCHEMA, web, readonly=readonly)
    argv = run.argv
    value = lambda flag: argv[argv.index(flag) + 1]
    assert run.cwd == ws.root
    assert value('--permission-mode') == ('default' if readonly else 'acceptEdits')
    assert value('--setting-sources') == 'project'
    assert value('--resume') == 'previous'
    assert value('--model') == 'other' and value('--effort') == 'high'
    assert json.loads(value('--json-schema')) == roles.REVIEW_SCHEMA
    settings = json.loads(value('--settings'))
    protected = [ws.root] if readonly else [ws.state / name for name in ('snapshots', 'chat')]
    assert settings['permissions']['deny'] == [f'Edit(/{p}/**)' for p in protected]
    assert settings['sandbox'] == {'enabled': True, 'autoAllowBashIfSandboxed': True, 'allowUnsandboxedCommands': False}
    denied = (['Edit', 'Write', 'NotebookEdit'] if readonly else []) + ([] if web else ['WebSearch', 'WebFetch'])
    assert (value('--disallowedTools').split(',') if '--disallowedTools' in argv else []) == denied
    assert (value('--allowedTools') if '--allowedTools' in argv else None) == ('WebSearch,WebFetch' if web else None)
    assert argv[-2:] == ['--', '確認']


def fake_runs(monkeypatch, action=None):
    calls = []

    class FakeRun:
        def __init__(self, provider, ws, prompt, session, model, effort, images, schema, web, *, readonly=False, **callbacks):
            self.callbacks = callbacks
            self.session = session or f'session-{len(calls)}'
            self.final = {'summary': '確認しました', 'issues': []} if schema == roles.REVIEW_SCHEMA else '答えです' if readonly else '編集しました'
            self.cancelled, self.returncode, self.errors, self.stderr = False, None, [], ''
            self.kill_count = 0
            calls.append({'run': self, 'session': session, 'model': model, 'effort': effort, 'prompt': prompt,
                          'schema': schema, 'web': web, 'readonly': readonly, 'images': images})

        async def run(self):
            self.callbacks['on_session'](self.session)
            if action:
                await action(self)
            if self.returncode is None:
                self.returncode = 0

        async def cancel(self):
            self.kill_now()

        def kill_now(self):
            self.kill_count += 1
            self.cancelled = True
            self.returncode = -15

    monkeypatch.setattr(native, 'make_run', FakeRun)
    return calls


def test_native_session_resumes_only_matching_revision(flow, monkeypatch):
    calls = fake_runs(monkeypatch)
    flow.tab.update(session='old-parent', role_binding='old')

    async def run():
        await flow.run('今回の依頼', ['page.png'])
        parent_session = flow.tab['session']
        assert calls[-1]['session'] is None and flow.r['session_reset']
        assert not calls[-1]['readonly'] and calls[-1]['web']
        assert calls[-1]['schema'] == roles.CHAT_SCHEMA and calls[-1]['images'] == ['page.png']
        assert flow.tab['role_binding'] == f"chat:codex:main:{roles.get('chat').revision}"
        await flow.run('続き', [])
        assert calls[-1]['session'] == parent_session
        monkeypatch.setattr(roles, 'NATIVE_REVISION', 'native-next')
        await flow.run('改訂後', [])
        assert calls[-1]['session'] is None
        flow.r['model'] = 'claude:other'
        await flow.run('モデル変更後', [])
        assert calls[-1]['session'] is None
    asyncio.run(run())


@pytest.mark.parametrize("provider", ["codex", "claude"])
def test_provider_home_change_starts_fresh_with_handover(flow, monkeypatch, provider):
    calls = fake_runs(monkeypatch)
    flow.tab['id'] = 'tab'
    flow.r['model'] = 'codex:main' if provider == 'codex' else 'claude:other'
    flow.chat.conversation_handover = Mock(return_value='以前の会話の要点')

    async def run():
        await flow.run('最初の依頼', [])
        old = flow.tab['session']
        # 分離前の記録には保存先がない。
        flow.tab.pop('session_home')
        await flow.run('続き', [])
        assert calls[-1]['session'] is None
        assert '以前の会話の要点' in calls[-1]['prompt']
        assert flow.tab['session'] != old
        current = flow.tab['session']
        await flow.run('もう一度', [])
        assert calls[-1]['session'] == current
    asyncio.run(run())


def test_extra_instructions_are_saved_per_role_and_added_to_each_send(flow, monkeypatch):
    calls = fake_runs(monkeypatch)
    ws = flow.ws
    assert roles.extra(ws, 'chat') == ''
    assert roles.set_extra(ws, 'chat', '  専門用語は短く説明する\n') == '専門用語は短く説明する'
    assert roles.extra(ws, 'review') == ''
    with pytest.raises(StudioError):
        roles.set_extra(ws, 'chat', 'あ' * (roles.EXTRA_LIMIT + 1))
    with pytest.raises(StudioError):
        roles.set_extra(ws, 'nope', '指示')
    # 必須の指示は置き場の AGENTS.md と skill。追加指示を保存しても変わらない
    base = roles.base_files(ws, 'chat')
    assert [f['path'] for f in base] == ['AGENTS.md', '.agents/skills/slide-studio-slides/SKILL.md']
    assert base[1]['text'] == (ws.root / base[1]['path']).read_text() and '専門用語' not in base[1]['text']

    async def run():
        await flow.run('今回の依頼', [])
        assert calls[-1]['prompt'].startswith(roles.EXTRA_LABEL + '\n専門用語は短く説明する\n\n')
        assert calls[-1]['prompt'].endswith('今回の依頼')
        # 直した追加指示は続きの会話でもすぐ効き、空にすると添えない
        roles.set_extra(ws, 'chat', '')
        await flow.run('続き', [])
        assert calls[-1]['prompt'] == '続き' and calls[-1]['session'] == calls[-2]['run'].session
    asyncio.run(run())


def test_review_session_is_separate_and_resumes_next_review(flow, monkeypatch):
    calls = fake_runs(monkeypatch)
    flow.r['mode'] = 'memo'
    files = {'modified': ['decks/talk/memo.md']}
    prompt = AsyncMock(side_effect=lambda again: '続きの確認' if again else '初回の確認')

    async def run():
        await flow.run('編集', [])
        parent = {k: flow.tab[k] for k in ('session', 'role_binding')}
        first = await flow.review(files, prompt)
        assert first['state'] == 'complete'
        assert flow.tab['review_session'] == first['session'] != parent['session']
        assert flow.tab['review_binding'] == f"review:codex:main:{roles.get('review').revision}"
        flow.ws.memo('talk').write_text('直した下書き')
        # 次の送信でも、同じタブの確認会話を使う。
        next_flow = workflow.Workflow(flow.chat, flow.deck, flow.tab, {**flow.r, 'id': 'next', 'agents': []})
        second = await next_flow.review(files, prompt)
        assert second['state'] == 'complete'
        assert calls[-1]['session'] == first['session']
        assert calls[-1]['prompt'] == '続きの確認'
        assert calls[-1]['readonly'] and calls[-1]['schema'] == roles.REVIEW_SCHEMA
        assert not calls[-1]['web']
        assert {k: flow.tab[k] for k in parent} == parent
        assert [c.args for c in prompt.await_args_list] == [(False,), (True,)]
    asyncio.run(run())


@pytest.mark.parametrize('usage', [{'used': 64000}, {'used': 7000, 'window': 10000}])
def test_large_parent_context_starts_fresh_with_handover(flow, monkeypatch, usage):
    async def report(run):
        run.callbacks['on_usage'](usage)
    calls = fake_runs(monkeypatch, report)
    flow.tab['id'] = 'tab'
    flow.chat.conversation_handover = Mock(return_value='最近の会話')

    async def run():
        await flow.run('最初', [])
        await flow.run('今回', [])
        assert calls[-1]['session'] is None
        assert '最近の会話\n\n今回' in calls[-1]['prompt']
        flow.chat.conversation_handover.assert_called_once_with('talk', 'tab', exclude='round')
    asyncio.run(run())


@pytest.mark.parametrize('limited', [False, True])
def test_review_context_renewal_preserves_parent_and_uses_full_prompt(flow, monkeypatch, limited):
    async def report(run):
        run.callbacks['on_usage']({'used': 64000 if not limited else 10})
        if limited and len(calls) == 1:
            run.returncode = 1
            run.errors = ['exceeded retry limit, last status: 429 Too Many Requests']
    calls = fake_runs(monkeypatch, report)
    flow.tab['session'] = 'parent-session'
    flow.r['mode'] = 'memo'
    prompt = AsyncMock(side_effect=lambda again: '続き' if again else '全文')

    async def run():
        first = await flow.review({'modified': ['decks/talk/memo.md']}, prompt)
        assert first['state'] == ('error' if limited else 'complete')
        assert len(calls) == 1  # 429 で自動再試行しない
        flow.ws.memo('talk').write_text('最新版')
        await flow.review({'modified': ['decks/talk/memo.md']}, prompt)
        assert calls[-1]['session'] is None and calls[-1]['prompt'] == '全文'
        assert flow.tab['session'] == 'parent-session'
        assert 'reset' not in flow.tab['review_session_context']
    asyncio.run(run())


def test_existing_rate_limited_session_is_renewed(flow):
    flow.tab.update(id='tab', review_session='old')
    failed = {'tab': 'tab', 'agents': [{'session': 'old', 'error': '429 Too Many Requests'}]}
    flow.chat.state = Mock(return_value={'rounds': [failed]})
    assert flow.renew_session('review_session')
    flow.chat.state.return_value['rounds'].append({'tab': 'tab', 'agents': [{'session': 'old', 'state': 'complete'}]})
    assert not flow.renew_session('review_session')


@pytest.mark.parametrize('change', ['model', 'revision'])
def test_review_does_not_resume_changed_binding(flow, monkeypatch, change):
    calls = fake_runs(monkeypatch)
    flow.r['mode'] = 'memo'
    files = {'modified': ['decks/talk/memo.md']}
    prompt = AsyncMock(return_value='確認')

    async def run():
        await flow.review(files, prompt)
        flow.ws.memo('talk').write_text('新しい下書き')
        if change == 'model':
            flow.settings['review'] = {'model': 'claude:other'}
        else:
            monkeypatch.setattr(roles, 'NATIVE_REVISION', 'native-next')
        await flow.review(files, prompt)
        assert calls[-1]['session'] is None
        assert [c.args for c in prompt.await_args_list] == [(False,), (False,)]
    asyncio.run(run())


def test_check_errors_skip_review_without_building_prompt(flow, monkeypatch):
    calls = fake_runs(monkeypatch)
    flow.r['check'] = {'errors': [{'text': 'bad layout'}, {'text': 'from before', 'old': True}]}
    prompt = AsyncMock()
    assert asyncio.run(flow.review({'modified': ['decks/talk/slides.qmd']}, prompt)) is None
    assert not calls
    prompt.assert_not_awaited()
    assert flow.r['agents'][-1]['state'] == 'skipped'
    assert flow.r['agents'][-1]['role'] == 'review'
    # 送信の前からあったエラーだけなら、確認は飛ばさない
    flow.r['check'] = {'errors': [{'text': 'from before', 'old': True}]}
    prompt = AsyncMock(return_value='確認して')
    asyncio.run(flow.review({'modified': ['decks/talk/slides.qmd']}, prompt))
    assert len(calls) == 1


@pytest.mark.parametrize(('mode', 'changed'), [('slides', []), ('memo', ['decks/talk/slides.qmd']), ('theme', ['decks/talk/memo.md'])])
def test_unneeded_review_calls_neither_prompt_nor_ai(flow, monkeypatch, mode, changed):
    calls = fake_runs(monkeypatch)
    flow.r['mode'] = mode
    prompt = AsyncMock()
    assert asyncio.run(flow.review({'modified': changed}, prompt)) is None
    assert not calls and not flow.r['agents']
    prompt.assert_not_awaited()


@pytest.mark.parametrize(('mode', 'path'), [('slides', 'decks/talk/slides.qmd'), ('memo', 'decks/talk/memo.md'), ('theme', 'themes/default.css')])
@pytest.mark.parametrize('needs_fix', [False, True])
def test_review_reuses_current_version_and_marks_stale(flow, monkeypatch, mode, path, needs_fix):
    async def result(run):
        if needs_fix:
            run.final['issues'] = [{'target': '全体', 'message': '長い', 'suggestion': '短く'}]
    calls = fake_runs(monkeypatch, result)
    flow.r['mode'] = mode
    files = {'modified': [path]}
    prompt = AsyncMock(return_value='確認')

    async def run():
        first = await flow.review(files, prompt)
        assert first['state'] == ('needs_fix' if needs_fix else 'complete')
        assert await flow.review(files, prompt) is first
        assert len(calls) == 1 and prompt.await_count == 1
        target = flow.ws.root / path
        target.write_text(target.read_text() + '\n変更')
        second = await flow.review(files, prompt)
        assert second is not first and second['version'] != first['version']
        assert len(calls) == 2
        target.write_text(target.read_text() + '\n再変更')

        async def mutate(run):
            target.write_text(target.read_text() + '\n確認中の変更')
        stale_calls = fake_runs(monkeypatch, mutate)
        stale = await flow.review(files, prompt)
        assert stale['state'] == 'stale'
        assert stale['version'] != flow.version()
        await flow.review(files, prompt)
        assert len(stale_calls) == 2  # stale は再利用しない
    asyncio.run(run())


@pytest.mark.parametrize('final', ['not json', None, [], {'summary': 3, 'issues': []},
                                  {'summary': '確認', 'issues': {}}, {'summary': '確認', 'issues': [{}]}])
def test_invalid_review_reply_returns_error_record(flow, monkeypatch, final):
    async def action(run):
        run.final = final
    calls = fake_runs(monkeypatch, action)
    record = asyncio.run(flow.review({'modified': ['decks/talk/slides.qmd']}, AsyncMock(return_value='確認')))
    assert record is flow.r['agents'][-1]
    assert record['state'] == 'error' and '返事の形' in record['error']
    assert len(calls) == 1 and not flow.active


def test_missing_review_model_returns_error_record(flow, monkeypatch):
    calls = fake_runs(monkeypatch)
    flow.settings['review'] = {'model': 'codex:missing'}
    record = asyncio.run(flow.review({'modified': ['decks/talk/slides.qmd']}, AsyncMock(return_value='確認')))
    assert not calls
    assert record['state'] == 'error' and 'codex:missing' in record['error']


def test_failed_review_process_returns_error_record(flow, monkeypatch):
    async def action(run):
        run.returncode, run.errors = 1, ['確認に失敗']
    fake_runs(monkeypatch, action)
    record = asyncio.run(flow.review({'modified': ['decks/talk/slides.qmd']}, AsyncMock(return_value='確認')))
    assert record['state'] == 'error' and record['error'] == '確認に失敗'


@pytest.mark.parametrize('cancel_task', [True, False])
def test_cancelled_review_task_reaps_process(flow, monkeypatch, cancel_task):
    async def run():
        started, released = asyncio.Event(), asyncio.Event()

        async def action(run):
            started.set()
            await released.wait()
        calls = fake_runs(monkeypatch, action)
        task = asyncio.create_task(flow.review({'modified': ['decks/talk/slides.qmd']}, AsyncMock(return_value='確認')))
        await asyncio.wait_for(started.wait(), 2)
        if cancel_task:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            await flow.cancel()
            released.set()
            with pytest.raises(StudioError, match='中断'):
                await task
        assert calls[0]['run'].kill_count >= 1
        assert not flow.active
        assert flow.r['agents'][-1]['state'] == 'cancelled'
    asyncio.run(run())


def test_review_keeps_targets(flow, monkeypatch):
    from slide_studio.ai.context import Context
    calls = fake_runs(monkeypatch)
    flow.r['items'] = [{'label': 'p2 背景', 'key': 'background', 'text': '短く'},
                       {'key': 'deck', 'text': '全体を見直す'},
                       {'key': 'fig:other/foreign', 'label': '図', 'text': '説明を補う'}]
    files = {'modified': ['decks/talk/slides.qmd']}
    context = Context()
    context.ws = flow.ws

    async def prompt(again):
        return context.prompt_review('talk', flow.r, files, ['changed-page.png'], again)
    asyncio.run(flow.review(files, prompt))
    assert len(calls) == 1
    prompt_text = calls[0]['prompt']
    assert '1. [p2 背景（id: background）] 短く' in prompt_text
    assert '2. [発表全体] 全体を見直す' in prompt_text
    assert 'topics/other/html/foreign' in prompt_text and 'トピック other' in prompt_text
    assert 'decks/talk/slides.qmd' in prompt_text and 'changed-page.png' in prompt_text


def test_review_leaves_out_files_of_overlapping_tabs(flow):
    """同じ時間に動いた下書き・テーマの送信が変えたファイルは、確認役に見せない（作業手順書 A7）。"""
    from slide_studio.ai.context import Context
    others = {'rm': {'mode': 'memo'}, 'rt': {'mode': 'theme', 'theme': 'mist'}}
    context = Context()
    context.ws = flow.ws
    context.round = lambda deck, rid: others[rid]
    flow.r['items'] = [{'label': 'p2 背景', 'key': 'background', 'text': '短く'}]
    flow.r['overlap'] = [{'deck': 'talk', 'round': 'rm'}, {'deck': 'talk', 'round': 'rt'}]
    files = {'modified': ['decks/talk/memo.md', 'decks/talk/slides.qmd', 'themes/mist.css']}
    text = context.prompt_review('talk', flow.r, files, [], False)
    changed = text.split('[変わったファイル]')[1].split('\n\n')[0]
    assert 'decks/talk/slides.qmd' in changed and 'memo.md' not in changed and 'mist.css' not in changed
    assert '同じ時間に別のタブも作業していました' in text
    flow.r['overlap'] = []
    assert '同じ時間に別のタブ' not in context.prompt_review('talk', flow.r, files, [], False)


@pytest.mark.parametrize('count', ['', '1', '3', '0'])
def test_fake_claude_review_count_and_theme_prompt(ws, count):
    marker = ws.state / 'fake-reviewng'
    write_atomic(marker, count)
    remaining = int(count or '1')
    fixture = Path(__file__).parent / 'fixtures/fake_claude.py'
    for n in range(remaining + 1):
        result = subprocess.run([sys.executable, str(fixture), '-p', '--output-format', 'stream-json',
                                 '--model', 'other', '--json-schema', json.dumps(roles.REVIEW_SCHEMA),
                                 '--', '[テーマ] themes/default.css'], capture_output=True, text=True, check=True)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        final = workflow.review_value(events[-1]['structured_output'])
        assert final['summary'] == '確認しました'
        assert len(final['issues']) == (1 if n < remaining else 0)
        left = remaining - n - 1
        if left > 0:
            assert marker.read_text() == str(left)
        elif remaining:
            assert not marker.exists()
        logged = json.loads((ws.state / 'fake-claude-review' / f'{n}.json').read_text())
        assert logged['prompt'] == '[テーマ] themes/default.css'
    assert not (ws.state / 'fake-claude').exists()


def test_fix_replaces_all_original_results(flow):
    from slide_studio.ai.chat import Chat
    from slide_studio.ai.context import Context
    chat = Chat(SimpleNamespace(ws=flow.ws))
    items = [{"key": "one", "label": "p3", "text": "文を直す"},
             {"key": "deck", "label": "全体", "text": "Appendixを削除"}]
    r = {"items": items, "summary": "削除した", "results": [{"key": "deck", "ok": True}]}
    latest = {"summary": "文は修正した。Appendixは復元した。",
              "results": [{"item": 2, "ok": False, "text": "復元した"},
                          {"item": 1, "ok": True, "text": "文を修正した"}]}
    run = SimpleNamespace(parent=None, final=latest, execute=AsyncMock())
    asyncio.run(chat._fix('talk', r, run, None, '直す'))
    assert r["summary"] == latest["summary"]
    assert [(x["key"], x["ok"], x["text"]) for x in r["results"]] == [
        ("one", True, "文を修正した"), ("deck", False, "復元した")]
    run.final = {"summary": "再修正", "results": [{"item": 1, "ok": True, "text": "修正"}]}
    asyncio.run(chat._fix('talk', r, run, None, '直す'))
    assert r["results"][1]["ok"] is False and "確認できません" in r["results"][1]["text"]
    context = Context()
    context.ws = flow.ws
    for prompt in (context.prompt_fix('talk', r, {"errors": []}, 1, 3),
                   context.prompt_review_fix('talk', r, [], 1, 3)):
        assert "1. [p3（id: one）] 文を直す" in prompt
        assert "2. [発表全体] Appendixを削除" in prompt
        assert "未達も含め全件" in prompt and "results は空" not in prompt


def test_review_gets_machine_findings_without_rechecking(flow):
    from slide_studio.ai.context import Context
    context = Context()
    context.ws = flow.ws
    flow.r['items'] = [{'key': 'deck', 'text': '読みやすく'}]
    flow.r['check'] = {'errors': [{'text': '既存のエラー', 'old': True}], 'warnings': [{'text': '未確認文献'}]}
    prompt = context.prompt_review('talk', flow.r, {}, [], False)
    assert '[機械検査済み] エラー 1 件・警告 1 件' in prompt
    assert '既存のエラー' in prompt and '未確認文献' in prompt
    assert '再検査や検査コマンドの実行は不要' in prompt
    assert 'issues に再掲せず' in prompt


def test_handoff_copies_reviewer_settings_once(ws, monkeypatch):
    from slide_studio.ai.chat import Chat
    add_deck(ws, 'talk', DECK)
    chat = Chat(SimpleNamespace(ws=ws, broadcast=lambda *a: None))
    data = chat.state('talk')
    src = next(t for t in data['tabs'] if t['mode'] == 'memo')
    src.update(model='codex:main', effort='low', ai_roles={'review': {'model': 'claude:other', 'effort': 'high'}})
    record = {'id': 'memo-round', 'tab': src['id'], 'handoff': {'text': '作って', 'pending': True}}
    data['rounds'].append(record)
    sent = {}
    monkeypatch.setattr(chat, 'send', lambda deck, tab, *a: sent.update(id='slide-round', tab=tab) or sent)
    chat.handoff('talk', record['id'], 'base')
    target = next(t for t in data['tabs'] if t['id'] == sent['tab'])
    assert target['ai_roles'] == src['ai_roles']
    assert target['ai_roles']['review'] is not src['ai_roles']['review']
    # 引き渡し先で後から変えた設定は、次の引き渡しで上書きしない。
    target['ai_roles']['review']['model'] = 'codex:main'
    assert src['ai_roles']['review']['model'] == 'claude:other'
    data['rounds'].append({'id': 'next', 'tab': src['id'], 'handoff': {'text': '反映', 'pending': True}})
    chat.handoff('talk', 'next', 'base')
    assert sent['tab'] == target['id']
    assert target['ai_roles']['review']['model'] == 'codex:main'


def test_interrupted_fix_does_not_keep_initial_success(flow):
    from slide_studio.ai.chat import Chat
    chat = Chat(SimpleNamespace(ws=flow.ws))
    chat._files = AsyncMock()
    chat._check = AsyncMock()
    r = {'items': [{'key': 'deck', 'label': '全体', 'text': '直す'}],
         'summary': '成功した', 'results': [{'ok': True}], 'check': {'errors': []}}
    run = SimpleNamespace(parent=None, execute=AsyncMock(side_effect=StudioError('利用上限')))
    with pytest.raises(StudioError, match='利用上限'):
        asyncio.run(chat._fix('talk', r, run, 'snapshot', '直す'))
    assert '成功した' not in r['summary']
    assert r['results'][0]['ok'] is False
    chat._files.assert_awaited_once_with('talk', r, 'snapshot')
    chat._check.assert_awaited_once_with('talk', r)


def test_consult_runs_only_the_question_in_its_own_session(flow, monkeypatch):
    calls = fake_runs(monkeypatch)
    flow.tab['id'] = 'tab1'
    # 相談役の基本の指示は置き場の AGENTS.md だけ
    assert [f['path'] for f in roles.base_files(flow.ws, 'consult')] == ['AGENTS.md']

    async def run():
        # 相談役は既定でオフ：相談の仕方を添えず、呼ばれても動かない
        await flow.run('図を作って', [])
        assert 'slide-studio consult' not in calls[-1]['prompt']
        with pytest.raises(StudioError):
            await flow.execute('consult', '質問')
        flow.settings['consult'] = {'enabled': True}
        await flow.run('図を作って', [])
        # オンにすると、編集担当に相談の仕方を添える（タブの id で相談役を呼ぶ）
        assert calls[-1]['prompt'].endswith(workflow.consult_line('tab1'))
        assert 'slide-studio consult --tab tab1' in calls[-1]['prompt']
        parent = {k: flow.tab[k] for k in ('session', 'role_binding')}
        first = await flow.execute('consult', 'この図の配色はどう？')
        assert calls[-1]['prompt'] == 'この図の配色はどう？'
        assert calls[-1]['readonly'] and calls[-1]['schema'] is None and not calls[-1]['web']
        assert first['state'] == 'complete' and first['question'] == 'この図の配色はどう？' and not first['parent']
        assert flow.tab['consult_session'] == first['session'] != parent['session']
        assert flow.tab['consult_binding'] == f"consult:codex:main:{roles.get('consult').revision}"
        # 2回目の相談は同じ会話を続け、編集担当・確認役の会話には触れない
        await flow.execute('consult', '続きの質問')
        assert calls[-1]['session'] == first['session']
        assert {k: flow.tab[k] for k in parent} == parent and 'review_session' not in flow.tab
    asyncio.run(run())


def test_run_consult_needs_a_running_tab(flow, monkeypatch):
    from slide_studio.ai.chat import Chat
    fake_runs(monkeypatch)
    flow.tab['id'] = 'tab1'
    flow.settings['consult'] = {'enabled': True}
    chat = SimpleNamespace(runs={'round': flow})

    async def run():
        for tab, question in (('other', '質問'), ('tab1', '  ')):
            with pytest.raises(StudioError):
                await Chat.run_consult(chat, tab, question)
        assert await Chat.run_consult(chat, 'tab1', ' 質問 ') == '答えです'
        assert flow.r['agents'][-1]['question'] == '質問'
        flow.cancelled = True
        with pytest.raises(StudioError):
            await Chat.run_consult(chat, 'tab1', '質問')
    asyncio.run(run())


def test_consult_goes_through_bridge_without_blocking_checks(ws, monkeypatch, capsys):
    from slide_studio.ai import bridge
    from slide_studio.cli import main
    add_deck(ws, 'talk', DECK)
    release = asyncio.Event()
    asked = []

    async def run_consult(tab, question):
        asked.append((tab, question))
        await release.wait()
        if tab != 'tab1':
            raise StudioError('相談できるのは、そのタブで AI が作業している間だけです')
        return '答えです'

    def run_check(deck, page, figure):
        return {'deck': deck, 'errors': [], 'warnings': []}

    async def run():
        server = asyncio.create_task(bridge.serve(ws, run_check, run_consult=run_consult))
        try:
            consult = asyncio.create_task(asyncio.to_thread(main, ['--root', str(ws.root), 'consult', '--tab', 'tab1', ' 配色は？ ']))
            while not asked:
                await asyncio.sleep(.05)
            # 相談の答えを待つ間も、検査には答える
            checked = await asyncio.wait_for(asyncio.to_thread(bridge.request_check, ws, 'talk'), 5)
            assert checked['errors'] == 0
            release.set()
            assert await consult == 0
            assert asked == [('tab1', '配色は？')]
            assert capsys.readouterr().out == '答えです\n'
            assert await asyncio.to_thread(main, ['--root', str(ws.root), 'consult', '--tab', 'other', '質問']) != 0
            assert '相談できませんでした: 相談できるのは' in capsys.readouterr().err
            assert not list((ws.state / 'requests').glob('*'))
        finally:
            server.cancel()
    asyncio.run(run())


def test_consult_without_app_says_so(ws, monkeypatch, capsys):
    from slide_studio.ai import bridge
    from slide_studio.cli import main
    monkeypatch.setattr(bridge, 'ACCEPT_WAIT', .3)
    assert main(['--root', str(ws.root), 'consult', '--tab', 'tab1', '質問']) != 0
    assert 'アプリのチャットで AI が作業している間だけ' in capsys.readouterr().err
    assert main(['--root', str(ws.root), 'consult', '--tab', 'tab1', '  ']) != 0
    assert '相談の内容が空です' in capsys.readouterr().err


@pytest.mark.parametrize('mode', ['memo', 'slides', 'theme'])
def test_draft_format_is_only_requested_for_memo_review(flow, mode):
    from slide_studio.ai.context import Context

    record = {**flow.r, 'mode': mode, 'theme': 'default',
              'items': [{'key': 'deck', 'label': '全体', 'text': '直す'}]}
    context = Context()
    context.ws = flow.ws
    prompt = context.prompt_review('talk', record, {}, [], False)
    assert ('slide-studio-memo/SKILL.md' in prompt) == (mode == 'memo')
    assert ('下書きの固定形式' in prompt) == (mode == 'memo')


@pytest.mark.parametrize('role', ['review', 'consult'])
def test_role_toggle_preserves_model_and_inheritance(role):
    saved = roles.tab_settings('slides', {}, {role: {'enabled': False}}, provider_of)
    assert roles.resolve(role, {}, saved, provider_of) == {'enabled': False}
    saved = roles.tab_settings('slides', saved, {role: {'enabled': True}}, provider_of)
    assert roles.resolve(role, {'model': 'codex:main'}, saved, provider_of)['model'] == 'codex:main'
    current = {role: {'model': 'claude:other', 'effort': 'low'}}
    off = roles.tab_settings('slides', current, {role: {'enabled': False}}, provider_of)
    on = roles.tab_settings('slides', off, {role: {'enabled': True}}, provider_of)
    assert {k: v for k, v in roles.resolve(role, {}, on, provider_of).items() if k != 'enabled'} == current[role]
    assert roles.enabled({role: roles.resolve(role, {}, on, provider_of)}, role)
    with pytest.raises(StudioError):
        roles.tab_settings('slides', {}, {role: {'enabled': 'false'}}, provider_of)


@pytest.mark.parametrize('role', ['review', 'consult'])
@pytest.mark.parametrize('on', [True, False])
def test_changing_role_model_keeps_toggle(role, on):
    # モデル・思考量を変えても、チャットに追従へ戻しても、オン・オフはそのまま
    saved = roles.tab_settings('slides', {}, {role: {'enabled': on}}, provider_of)
    saved = roles.tab_settings('slides', saved, {role: {'model': 'claude:other', 'effort': None}}, provider_of)
    assert saved[role] == {'model': 'claude:other', 'effort': 'low', 'enabled': on}
    assert roles.enabled(saved, role) is on
    saved = roles.tab_settings('slides', saved, {role: None}, provider_of)
    assert saved[role] == {'enabled': on}
    # オフでも使えないモデルは保存しない
    with pytest.raises(StudioError):
        roles.tab_settings('slides', {role: {'enabled': False}}, {role: {'model': 'codex:missing'}}, provider_of)


def test_disabled_roles_do_not_run(flow, monkeypatch):
    calls = fake_runs(monkeypatch)
    flow.settings = {'review': {'enabled': False}, 'consult': {'enabled': False}}
    flow.tab['id'] = 'tab1'

    async def run():
        await flow.run('編集して', [])
        assert 'slide-studio consult' not in calls[-1]['prompt']
        assert await flow.review({'modified': ['slides.qmd']}, AsyncMock()) is None
        with pytest.raises(StudioError, match='オフ'):
            await flow.execute('consult', '質問')
        assert len(calls) == 1
    asyncio.run(run())


def test_consult_is_off_unless_turned_on():
    # 相談役は既定でオフ。確認役は既定でオン
    assert roles.DEFAULT_ON == {'review': True, 'consult': False}
    assert not roles.enabled({}, 'consult') and roles.enabled({}, 'review')
    assert roles.resolve('consult', {'model': 'codex:main'}, {}, provider_of) == {'enabled': False}
    on = roles.tab_settings('slides', {}, {'consult': {'enabled': True}}, provider_of)
    chosen = roles.resolve('consult', {'model': 'codex:main'}, on, provider_of)
    assert chosen['model'] == 'codex:main' and roles.enabled({'consult': chosen}, 'consult')


@pytest.mark.parametrize('readonly', [False, True])
@pytest.mark.parametrize('web', [False, True])
def test_native_agy_permissions(ws, readonly, web):
    run = native.make_run(PROVIDERS['agy'], ws, '確認', 'previous', 'gemini-test', 'high', [],
                          roles.REVIEW_SCHEMA, web, readonly=readonly, pool=object(), key='tab')
    argv = run.argv
    assert '--input-format' not in argv  # Claude の常駐プロセスに渡さない
    assert '--sandbox' in argv
    settings = json.loads(argv[argv.index('--settings') + 1])
    deny = settings['permissions']['deny']
    assert ('read_url(*)' in deny) == (not web)
    assert 'command(*)' not in settings['permissions']['allow']
    if readonly:
        assert 'command(*)' in deny and 'write_file(*)' in deny
        assert argv[argv.index('--mode') + 1] == 'plan'
    else:
        for p in native.protected(ws):
            assert f'write_file({p}/**)' in deny
    assert json.loads(argv[argv.index('--json-schema') + 1]) == roles.REVIEW_SCHEMA
    assert 'agy' in roles.SUPPORTED_PROVIDERS


def test_clean_questions_keeps_only_what_the_screen_can_show():
    opt = lambda *names: [{"label": n, "description": ""} for n in names]
    got = roles.clean_questions([
        {"item": 9, "text": " 含めますか？ ", "options": opt("はい", "はい", " いいえ ", "a", "b", "c"), "multiple": False},
        {"item": 2, "text": "どれ", "options": opt("x"), "multiple": True},
        {"item": 1, "text": "選択肢なし", "options": [], "multiple": False},
        {"item": 1, "text": "  ", "options": opt("x", "y"), "multiple": False},
        "壊れた形",
    ], 2)
    assert got == [
        {"item": 1, "text": "含めますか？", "options": opt("はい", "いいえ", "a", "b"), "multiple": False},
        {"item": 2, "text": "どれ", "options": opt("x"), "multiple": True},
    ]
    assert roles.clean_questions(None, 1) == []
    assert all(s["properties"]["questions"] for s in (roles.CHAT_SCHEMA, roles.DRAFT_SCHEMA, roles.REPLY_SCHEMA))
