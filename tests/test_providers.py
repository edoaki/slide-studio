"""AI のプロバイダー：起動の引数と、出力の読み取り（設計書 §8.1）。イベントは実際の CLI の出力から取った形。"""
import json
from pathlib import Path

from slide_studio.ai import agent, providers

ROOT = Path("/tmp/ws")


def test_detect_defaults_to_medium(monkeypatch):
    for provider in providers.PROVIDERS.values():
        monkeypatch.setattr(provider, 'binary', lambda: '/test/ai')
        monkeypatch.setattr(provider, '_detect', lambda exe, cache: {
            'ok': True, 'models': [
                providers.model('low-default', 'Low', ['low', 'medium', 'high'], 'low'),
                providers.model('high-default', 'High', ['low', 'medium', 'high'], 'high'),
                providers.model('no-medium', 'Limited', ['low', 'high'], 'high'),
                providers.model('no-effort', 'Fixed'),
            ],
        })
        assert [m['effort'] for m in provider.detect({})['models']] == ['medium', 'medium', 'high', None]


def feed(parser, events):
    return [a for ev in events for a in parser.feed(ev)]


def test_codex_uses_app_server(monkeypatch):
    monkeypatch.setenv("SLIDE_STUDIO_CODEX", "/test/codex")
    codex = providers.PROVIDERS["codex"]
    run = codex.make_run(ROOT, "hi", "old-thread", "gpt-x", "high", [ROOT / "a.png"])
    assert run.argv == ["/test/codex", "app-server", "--listen", "stdio://"]
    assert run.options['session'] == 'old-thread'
    assert run.options['images'] == [ROOT / 'a.png']
    assert run.options['schema'] is True


def test_parse_final_accepts_dicts_fences_and_trailing_json():
    ok = {"summary": "s", "results": []}
    assert agent.parse_final(ok) == ok
    assert agent.parse_final('説明です。\n{"summary": "s", "results": []}') == ok
    assert agent.parse_final("ただの文") is None


def test_app_server_notifications():
    parser = providers.AppServerParser(ROOT)
    actions = feed(parser, [
        {'method': 'item/completed', 'params': {'item': {'type': 'agentMessage', 'id': 'a', 'text': 'done'}}},
        {'method': 'item/completed', 'params': {'item': {'type': 'fileChange', 'id': 'f', 'changes': [{'path': '/tmp/ws/a.qmd', 'kind': {'type': 'update'}}]}}},
        {'method': 'thread/tokenUsage/updated', 'params': {'tokenUsage': {'last': {'totalTokens': 42}, 'modelContextWindow': 100}}},
        {'method': 'error', 'params': {'willRetry': True, 'error': {'message': 'temporary'}}},
    ])
    assert {'final': 'done'} in actions
    assert {'step': {'id': 'f', 'kind': 'file', 'text': 'update a.qmd'}} in actions
    assert {'usage': {'used': 42, 'window': 100}} in actions
    assert not any(a.get('step', {}).get('kind') == 'error' for a in actions)



def test_rate_limits_from_both_providers():
    """5時間・1週間の上限の使用率を同じ形にする。Codex は一部だけの知らせもある。"""
    actions = feed(providers.AppServerParser(ROOT), [
        {'method': 'account/rateLimits/updated', 'params': {'rateLimits': {
            'primary': {'usedPercent': 12, 'windowDurationMins': 300, 'resetsAt': 1000},
            'secondary': {'usedPercent': 40, 'windowDurationMins': 10080, 'resetsAt': 2000}}}},
        {'method': 'account/rateLimits/updated', 'params': {'rateLimits': {'primary': None, 'secondary': None}}},
    ])
    assert actions == [{'limits': {'five_hour': {'used': 12, 'resets': 1000}, 'weekly': {'used': 40, 'resets': 2000}}}]
    actions = feed(providers.ClaudeParser(ROOT), [
        {'type': 'rate_limit_event', 'rate_limit_info': {'status': 'allowed', 'rateLimitType': 'five_hour', 'unifiedWindows': {
            'five_hour': {'utilization': 0.74, 'resetsAt': 1793889000, 'status': 'allowed'},
            'seven_day': {'utilization': 0.38, 'resetsAt': 1794178800, 'status': 'allowed'}}}, 'session_id': 's'},
    ])
    assert {'limits': {'five_hour': {'used': 74, 'resets': 1793889000}, 'weekly': {'used': 38, 'resets': 1794178800}}} in actions

def test_progress_shows_web_search_and_skill_names():
    actions = feed(providers.AppServerParser(ROOT), [
        {'method': 'item/completed', 'params': {'item': {'type': 'webSearch', 'id': 'w', 'query': '巡回セールスマン問題'}}},
    ])
    assert {'step': {'id': 'w', 'kind': 'tool', 'text': 'web 検索 巡回セールスマン問題'}} in actions
    parser = providers.ClaudeParser(ROOT)
    assert parser._tool({'id': 's', 'name': 'Skill', 'input': {'skill': 'slide-studio-slides'}})['text'] == 'Skill slide-studio-slides'
    assert parser._tool({'id': 'q', 'name': 'WebSearch', 'input': {'query': 'TSP'}})['text'] == 'WebSearch TSP'

def test_progress_hides_leading_cd():
    parser = providers.ClaudeParser(ROOT)
    bash = lambda cmd: parser._tool({'id': 'b', 'name': 'Bash', 'input': {'command': cmd}})['text']
    assert bash('cd /w/decks/x; grep -n 救 memo.md') == 'grep -n 救 memo.md'
    assert bash('cd "/w/my deck" && ls') == 'ls'
    assert bash('cd /w') == 'cd /w'
    assert providers._short_command('/bin/zsh -lc "cd /w && rg step"') == 'rg step'


def test_agy_detect_and_resume(monkeypatch):
    from subprocess import CompletedProcess
    monkeypatch.setenv('SLIDE_STUDIO_AGY', '/test/agy')
    monkeypatch.setattr(providers, '_run', lambda argv, **kw: CompletedProcess(argv, 0,
        'gemini-test-high\tGemini Test (High)\ngemini-test-low\tGemini Test (Low)\n', ''))
    p = providers.PROVIDERS['agy']
    info = p.detect({})
    assert info['ok'] and info['default'] == 'gemini-test'
    assert info['models'][0]['efforts'] == ['low', 'high']
    argv = p.command(ROOT, 'hi', 'previous', 'gemini-test', 'high', [], {'type': 'object'})
    assert argv[argv.index('--model') + 1] == 'gemini-test-high'
    assert argv[argv.index('--conversation') + 1] == 'previous'
    assert json.loads(argv[argv.index('--json-schema') + 1]) == {'type': 'object'}
    monkeypatch.setattr(providers, '_run', lambda argv, **kw: CompletedProcess(argv, 1, '', 'authentication required'))
    assert p.detect({})['reason'] == 'login'
    monkeypatch.setenv('SLIDE_STUDIO_AGY', 'none')
    assert p.detect({})['reason'] == 'missing'


def test_agy_stream_and_error():
    parser = providers.AgyParser(ROOT)
    actions = feed(parser, [
        {'event': 'init', 'conversation_id': 'session'},
        {'event': 'step_update', 'step_update': {'step_index': 1, 'step_type': 'agent_response', 'state': 'ACTIVE', 'text_delta': 'hel'}},
        {'event': 'step_update', 'step_update': {'step_index': 1, 'step_type': 'agent_response', 'state': 'DONE', 'text_delta': 'lo'}},
        {'event': 'step_update', 'step_update': {'step_index': 2, 'step_type': 'tool', 'state': 'DONE', 'tool_info': {'name': 'run_command', 'parameters': {'CommandLine': 'pwd'}, 'error': {'message': 'denied'}}}},
        {'event': 'result', 'result': {'status': 'ERROR', 'error': 'failed', 'structured_output': {'summary': 'done', 'results': []}}},
    ])
    assert {'session': 'session'} in actions
    assert {'step': {'id': 'a1', 'kind': 'message', 'text': 'hello'}} in actions
    assert any(a.get('step', {}).get('exit') == 1 for a in actions)
    assert {'step': {'id': None, 'kind': 'error', 'text': 'failed'}} in actions
    assert {'final': {'summary': 'done', 'results': []}} in actions


def test_claude_uses_private_home_for_detection_and_execution(tmp_path, monkeypatch):
    from subprocess import CompletedProcess
    private = tmp_path / 'studio-claude'
    original = tmp_path / 'real-claude'
    original.mkdir()
    marker = original / 'history.jsonl'
    marker.write_text('original history')
    monkeypatch.setenv('SLIDE_STUDIO_CLAUDE_HOME', str(private))
    monkeypatch.setenv('CLAUDE_CONFIG_DIR', str(original))
    def run(argv, **kw):
        assert kw['env']['CLAUDE_CONFIG_DIR'] == str(private)
        return CompletedProcess(argv, 0, '{"loggedIn": true}', '')
    monkeypatch.setattr(providers, '_run', run)
    provider = providers.PROVIDERS['claude']
    assert provider._detect('fake', {})['ok']
    assert provider.make_run(ROOT, 'hi', None, 'sonnet', None, []).env['CLAUDE_CONFIG_DIR'] == str(private)
    assert marker.read_text() == 'original history'
    assert list(original.iterdir()) == [marker]
