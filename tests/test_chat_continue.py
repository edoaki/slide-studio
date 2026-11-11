"""モデル切り替え・中断後の続行だけを偽のAIで検証する。"""
import json

from test_chat import chat, fake_codex, state, send, wait_done, ai_status, codex_rpcs
from slide_studio.fsutil import sha256_text


def setup(chat):
    ws, srv, client = chat
    ai_status(client)
    tab = state(client)['tabs'][0]['id']
    return ws, client, f'/api/deck/talk/chat/tabs/{tab}'


def test_switch_and_switch_back_start_fresh_keep_history_and_drafts(chat):
    ws, client, url = setup(chat)
    first = wait_done(client, send(client, ws, [{'key': 'one', 'text': 'noop 最初の提案'}]).json()['id'])
    old_session = state(client)['tabs'][0]['session']
    client.patch(url, json={'drafts': {'one': '書きかけ'}}).raise_for_status()
    for model in ['codex:test-small', 'codex:test-big']:
        client.patch(url, json={'model': model}).raise_for_status()
        assert len(state(client)['rounds']) == (1 if model.endswith('small') else 2)
        assert state(client)['tabs'][0]['drafts'] == {'one': '書きかけ'}
        r = wait_done(client, send(client, ws, [{'key': 'one', 'text': 'noop 続き'}]).json()['id'])
        assert r['state'] == 'done'
        assert state(client)['tabs'][0]['session'] != old_session
        old_session = state(client)['tabs'][0]['session']
        rpc = codex_rpcs(ws)[-1]
        assert rpc['turns_in_thread'] == 0
        assert '最初の提案' in rpc['turn']['input'][0]['text']
        assert r['model_change']['to'] == model
        client.patch(url, json={'drafts': {'one': '書きかけ'}}).raise_for_status()
    assert state(client)['rounds'][0]['id'] == first['id']


def test_limit_continue_preserves_partial_edit_and_restore_boundary(chat):
    ws, client, url = setup(chat)
    (ws.state / 'fake-edit-limit').touch()
    old = wait_done(client, send(client, ws, [{'key': 'one', 'text': 'replace 最初の段落。 => 途中成果。'}]).json()['id'])
    assert old['state'] == 'error'
    assert '途中成果。' in ws.qmd('talk').read_text()
    client.patch(url, json={'model': 'codex:test-small', 'drafts': {'one': '別の書きかけ'}}).raise_for_status()
    result = client.post(f"/api/deck/talk/chat/rounds/{old['id']}/continue", json={'base': sha256_text(ws.qmd('talk').read_text())})
    result.raise_for_status()
    done = wait_done(client, result.json()['id'])
    assert done['state'] == 'done' and done['continued_from'] == old['id']
    assert not done['review_only']
    assert state(client)['tabs'][0]['drafts'] == {'one': '別の書きかけ'}
    assert '元の全指示' in done['handover']
    assert old['errors_before'] == done['errors_before']
    client.post(f"/api/deck/talk/chat/rounds/{done['id']}/restore").raise_for_status()
    assert '途中成果。' in ws.qmd('talk').read_text()
    assert client.post(f"/api/deck/talk/chat/rounds/{old['id']}/continue", json={}).status_code == 400


def test_review_limit_restarts_only_review_and_rechecks_current_files(chat):
    ws, client, url = setup(chat)
    (ws.state / 'fake-review-limit').touch()
    old = wait_done(client, send(client, ws, [{'key': 'one', 'text': 'replace 最初の段落。 => 確認待ち。'}]).json()['id'])
    assert old['agents'][-1]['state'] == 'error'
    count = len(list((ws.state / 'fake-codex').glob('*.json')))
    client.patch(url, json={'ai_roles': {'review': {'model': 'codex:test-small', 'effort': 'low'}}}).raise_for_status()
    ws.qmd('talk').write_text(ws.qmd('talk').read_text().replace('確認待ち。', '手で直した。'))
    result = client.post(f"/api/deck/talk/chat/rounds/{old['id']}/continue", json={'base': sha256_text(ws.qmd('talk').read_text())})
    result.raise_for_status()
    done = wait_done(client, result.json()['id'])
    assert done['review_only'] and done['review_ok'] and done['state'] == 'done'
    assert done['check'] is not None
    assert len(list((ws.state / 'fake-codex').glob('*.json'))) == count
    assert all(not a['parent'] for a in done['agents'])
    assert done['agents'][-1]['model'] == 'codex:test-small'
    assert '手で直した。' in ws.qmd('talk').read_text()
    assert 'decks/talk/slides.qmd' in codex_rpcs(ws)[-1]['turn']['input'][0]['text']


def test_review_continue_reports_errors_added_while_stopped(chat):
    ws, client, _ = setup(chat)
    (ws.state / 'fake-review-limit').touch()
    old = wait_done(client, send(client, ws, [{'key': 'one', 'text': 'replace 最初の段落。 => 確認待ち。'}]).json()['id'])
    assert old['agents'][-1]['state'] == 'error'
    ws.qmd('talk').write_text(ws.qmd('talk').read_text().replace('確認待ち。', '手で追加した引用 [@missing]。'))
    before = ws.qmd('talk').read_text()
    response = client.post(f"/api/deck/talk/chat/rounds/{old['id']}/continue", json={'base': sha256_text(before)})
    response.raise_for_status()
    done = wait_done(client, response.json()['id'])
    assert done['state'] == 'fail'
    assert any('missing' in e['text'] and not e.get('old') for e in done['check']['errors'])
    assert done['agents'][-1]['role'] == 'review' and done['agents'][-1]['state'] == 'skipped'
    assert ws.qmd('talk').read_text() == before


def test_switch_busy_rejected_and_cancel_then_continue(chat):
    from test_chat import wait_state
    ws, client, url = setup(chat)
    old = send(client, ws, [{'key': 'one', 'text': 'sleep 30'}]).json()
    wait_state(client, old['id'], 'run')
    assert client.patch(url, json={'model': 'codex:test-small'}).status_code == 400
    assert client.patch(url, json={'effort': 'low'}).status_code == 400
    client.post(f"/api/deck/talk/chat/rounds/{old['id']}/cancel").raise_for_status()
    assert wait_done(client, old['id'])['state'] == 'cancelled'
    client.patch(url, json={'model': 'codex:test-small'}).raise_for_status()
    result = client.post(f"/api/deck/talk/chat/rounds/{old['id']}/continue", json={'base': sha256_text(ws.qmd('talk').read_text())})
    result.raise_for_status()
    client.post(f"/api/deck/talk/chat/rounds/{result.json()['id']}/cancel").raise_for_status()
    assert wait_done(client, result.json()['id'])['state'] == 'cancelled'


def test_switch_provider_and_review_inheritance(chat, tmp_path, monkeypatch):
    import sys
    from conftest import FIXTURES
    ws, client, url = setup(chat)
    exe = tmp_path / 'claude'
    exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FIXTURES / "fake_claude.py"}" "$@"\n')
    exe.chmod(0o755)
    monkeypatch.setenv('SLIDE_STUDIO_CLAUDE', str(exe))
    ai_status(client, refresh=True)
    wait_done(client, send(client, ws, [{'key': 'one', 'text': 'noop 以前の会話'}]).json()['id'])
    client.patch(url, json={'model': 'claude:sonnet'}).raise_for_status()
    done = wait_done(client, send(client, ws, [{'key': 'one', 'text': 'replace 最初の段落。 => Claude変更。'}]).json()['id'])
    assert done['state'] == 'done'
    assert done['ai_roles']['review']['model'] == 'claude:sonnet'
    log = json.loads((ws.state / 'fake-claude' / '0.json').read_text())
    assert '以前の会話' in log['prompt'] and '--resume' not in log['argv']
    client.patch(url, json={'ai_roles': {'review': {'model': 'claude:sonnet'}}}).raise_for_status()
    client.patch(url, json={'model': 'codex:test-small'}).raise_for_status()
    done = wait_done(client, send(client, ws, [{'key': 'one', 'text': 'replace Claude変更。 => Codex変更。'}]).json()['id'])
    assert done['state'] == 'done'
    assert done['ai_roles']['review']['model'] == 'claude:sonnet'
    assert codex_rpcs(ws)[-1]['turns_in_thread'] == 0


def test_handover_bounds_history_but_keeps_current_request(chat):
    ws, srv, client = chat
    from slide_studio.ai.chat import Chat
    from types import SimpleNamespace
    ai = Chat(SimpleNamespace(ws=ws, broadcast=lambda event: None))
    tab = ai.state('talk')['tabs'][0]
    ai.state('talk')['rounds'] = [{'id': 'old', 'tab': tab['id'], 'items': [{'text': '古い' * 20000}],
                                 'summary': '長い返答', 'steps': [{'text': 'ツールログを渡さない'}]},
                                {'id': 'recent', 'tab': tab['id'], 'items': [{'text': '最近の依頼'}], 'summary': '1. 番号付き提案'}]
    prompt = ai.conversation_handover('talk', tab['id'])
    assert len(prompt) < 17000 and '1. 番号付き提案' in prompt
    history = (ws.state / 'chat' / 'history' / f"talk-{tab['id']}.jsonl").read_text()
    assert '古い' in history and 'ツールログ' not in history
    stopped = {'items': [{'text': '元の指示' * 10000}], 'error': '停止'}
    assert stopped['items'][0]['text'] in ai.conversation_handover('talk', tab['id'], stopped)


def test_memo_review_continue_keeps_handoff_and_only_runs_review(chat):
    from test_memo import send_memo, memo_tab
    ws, client, _ = setup(chat)
    ws.memo('talk').write_text('下書き本文')
    (ws.state / 'fake-review-limit').touch()
    old = wait_done(client, send_memo(client, ws, 'replace 下書き本文 => 改善した下書き; slides 作成方針').json()['id'])
    assert old['agents'][-1]['state'] == 'error'
    tab = memo_tab(client)
    client.patch(f'/api/deck/talk/chat/tabs/{tab}', json={'ai_roles': {'review': {'model': 'codex:test-small'}}}).raise_for_status()
    response = client.post(f"/api/deck/talk/chat/rounds/{old['id']}/continue", json={'base': sha256_text(ws.memo('talk').read_text())})
    response.raise_for_status()
    done = wait_done(client, response.json()['id'])
    assert done['review_ok'] and done['state'] == 'done'
    assert all(not a['parent'] for a in done['agents'])
    assert done['handoff']['pending'] and done['handoff']['text'] == old['handoff']['text']


def test_history_survives_restart_and_can_reopen_archived_tab(chat):
    from slide_studio.ai.chat import Chat
    ws, srv, client = chat
    ai_status(client)
    done = wait_done(client, send(client, ws, [{'key': 'one', 'text': 'noop 保存した会話'}]).json()['id'])
    before = state(client)
    from types import SimpleNamespace
    restored = Chat(SimpleNamespace(ws=ws, broadcast=lambda event: None))
    data = restored.open_view('talk')
    assert data['rounds'] == before['rounds']
    old_tab = next(t for t in before['tabs'] if t['id'] == done['tab'])
    archived = next(t for t in data['tabs'] if t['id'] == done['tab'])
    assert archived == {**old_tab, 'open': False}
    fresh = [t for t in data['tabs'] if t['open']]
    assert {t['mode'] for t in fresh} == {'slides', 'memo', 'theme'}
    assert all(not t['session'] and not t['drafts'] for t in fresh)
    assert next(t for t in fresh if t['mode'] == 'slides')['id'] != old_tab['id']
    assert len(data['tabs']) == len(before['tabs']) + 1  # 空の下書き・テーマのタブは再利用
    reopened = restored.update_tab('talk', old_tab['id'], {'open': True})
    assert reopened == old_tab
    assert restored.state('talk')['rounds'] == before['rounds']
    saved = json.loads(restored.path('talk').read_text())
    assert next(t for t in saved['tabs'] if t['id'] == old_tab['id']) == old_tab


def test_new_message_carries_cancelled_requests(chat):
    ws, srv, client = chat
    _, _, url = setup(chat)
    attachment = ws.deck_dir('talk') / 'materials' / 'request.txt'
    attachment.parent.mkdir(exist_ok=True)
    attachment.write_text('参考資料')
    client.patch(url, json={'attach': [{'path': 'materials/request.txt'}]}).raise_for_status()
    stopped = send(client, ws, [{'key': 'one', 'text': 'sleep 30'}]).json()
    client.post(f"/api/deck/talk/chat/rounds/{stopped['id']}/cancel").raise_for_status()
    cancelled = wait_done(client, stopped['id'])
    assert cancelled['state'] == 'cancelled' and cancelled['error'] is None
    next_round = send(client, ws, [{'key': 'two', 'text': 'noop 追加の指示'}]).json()
    assert [x['text'] for x in next_round['items']] == ['sleep 30', 'noop 追加の指示']
    assert next_round['attach'] == cancelled['attach']
    assert next_round['attach'][0]['path'] == 'materials/request.txt'
    assert next_round['resumed_from'] == stopped['id']
    assert '中断した作業を続行' in next_round['handover']
    client.post(f"/api/deck/talk/chat/rounds/{next_round['id']}/cancel").raise_for_status()
    wait_done(client, next_round['id'])
    third = send(client, ws, [{'key': 'deck', 'text': 'noop 最後の指示'}]).json()
    assert len(third['items']) == 3
    client.post(f"/api/deck/talk/chat/rounds/{third['id']}/cancel").raise_for_status()
    wait_done(client, third['id'])
