"""AI の CLI の取得・更新（ai/runtimes.py）とログイン（providers の login）。"""
import asyncio
import hashlib
import io
import json
import os
import stat
import sys
import tarfile
import time
from subprocess import CompletedProcess
from unittest.mock import Mock

import pytest

from slide_studio.ai import providers, runtimes
from slide_studio.ai.providers import Antigravity, Claude, Codex
from slide_studio.ai.runtimes import AgySource, ClaudeSource, CodexSource, Release, Updater
from slide_studio.workspace import StudioError


class Web(dict):
    """配布元の代わり。登録の無い URL は接続できないものとして扱う。"""
    def __init__(self):
        super().__init__()
        self.requests = []

    def __call__(self, url, **kwargs):
        self.requests.append(url)
        if url not in self:
            raise OSError('offline')
        return io.BytesIO(self[url])


@pytest.fixture
def web(monkeypatch):
    fake = Web()
    monkeypatch.setattr(runtimes.urllib.request, 'urlopen', fake)
    return fake


def tar(files):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as archive:
        for name, body in files.items():
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(body), 0o755
            archive.addfile(entry, io.BytesIO(body))
    return data.getvalue()


def use(monkeypatch, cls):
    """環境変数での指定を外して、本物の取得の経路を通す。動作確認は通ったことにする。"""
    monkeypatch.delenv(cls.env_var, raising=False)
    monkeypatch.setattr(cls, 'accepts', lambda self, exe, was_ok=False: None)
    monkeypatch.setattr('shutil.which', lambda name: None)
    monkeypatch.setattr(cls, 'extra_paths', lambda self: [])
    return cls()


def publish_codex(web, version='0.167.0', body=None):
    blob = body or tar({'bin/codex': b'codex', 'bin/codex-code-mode-host': b'host'})
    name = f'codex-package-{CodexSource.target()}.tar.gz'
    url = f'https://github.test/{version}/{name}'
    web[CodexSource.API] = json.dumps({'tag_name': f'rust-v{version}', 'assets': [
        {'name': name, 'browser_download_url': url, 'digest': 'sha256:' + hashlib.sha256(blob).hexdigest(), 'size': len(blob)}]}).encode()
    web[url] = blob
    return url


def publish_claude(web, version='2.1.311', body=b'official claude binary'):
    name = ClaudeSource.platform()
    web[f'{ClaudeSource.BASE}/stable'] = version.encode() + b'\n'
    web[f'{ClaudeSource.BASE}/{version}/manifest.json'] = json.dumps(
        {'platforms': {name: {'checksum': hashlib.sha256(body).hexdigest(), 'size': len(body), 'binary': 'claude'}}}).encode()
    web[f'{ClaudeSource.BASE}/{version}/{name}/claude'] = body


def publish_agy(web, version='1.5.3', body=None, raw=False):
    blob = body or (b'agy binary' if raw else tar({'antigravity': b'agy binary'}))
    url = f'https://storage.test/{version}/cli' + ('' if raw else '.tar.gz')
    web[f'{AgySource.BASE}/manifests/{AgySource.platform()}.json'] = json.dumps(
        {'version': version, 'url': url, 'sha512': hashlib.sha512(blob).hexdigest()}).encode()
    web[url] = blob


# ---------------------------------------------------------------- 初回の取得
def test_codex_first_install_uses_latest_and_reuses(web, monkeypatch):
    codex = use(monkeypatch, Codex)
    publish_codex(web)
    assert codex.binary() is None
    exe = codex.ensure_binary()
    assert exe == str(Codex.home() / 'runtime' / '0.167.0' / 'bin' / 'codex')
    assert (Codex.home() / 'runtime' / '0.167.0' / 'bin' / 'codex-code-mode-host').is_file()
    assert codex.binary() == codex.ensure_binary() == exe
    assert len([u for u in web.requests if u.endswith('.tar.gz')]) == 1


def test_codex_uses_pinned_release_when_github_api_is_unreachable(web, monkeypatch):
    codex = use(monkeypatch, Codex)
    blob = tar({'bin/codex': b'codex'})
    monkeypatch.setitem(CodexSource.DIGESTS, CodexSource.target(), hashlib.sha256(blob).hexdigest())
    web[CodexSource().fallback().url] = blob
    assert '/0.160.0/bin/codex' in codex.ensure_binary()


def test_claude_stores_the_official_binary_unchanged(web, monkeypatch):
    claude = use(monkeypatch, Claude)
    publish_claude(web, body=b'official claude binary')
    exe = claude.ensure_binary()
    assert exe == str(Claude.home() / 'runtime' / '2.1.311' / 'claude')
    with open(exe, 'rb') as f:
        assert f.read() == b'official claude binary'
    assert stat.S_IMODE(os.stat(exe).st_mode) & 0o111
    assert any(u.startswith('https://downloads.claude.ai/claude-code-releases/2.1.311/') for u in web.requests)


@pytest.mark.parametrize('raw', [False, True])
def test_agy_manifest_archive_or_binary(web, monkeypatch, raw):
    agy = use(monkeypatch, Antigravity)
    publish_agy(web, raw=raw)
    exe = agy.ensure_binary()
    assert exe == str(Antigravity.home() / 'runtime' / '1.5.3' / 'agy')
    with open(exe, 'rb') as f:
        assert f.read() == b'agy binary'


@pytest.mark.parametrize('failure', ['digest', 'path', 'network', 'broken-json'])
def test_failed_download_installs_nothing(web, monkeypatch, failure):
    codex = use(monkeypatch, Codex)
    url = publish_codex(web, body=tar({'../escape': b'x'}) if failure == 'path' else None)
    if failure == 'digest':
        web[url] = b'tampered'
    if failure == 'network':
        del web[url]
    if failure == 'broken-json':
        web[CodexSource.API] = b'<html>'
        monkeypatch.setitem(CodexSource.DIGESTS, CodexSource.target(), 'wrong')
    with pytest.raises(StudioError, match='準備できませんでした'):
        codex.ensure_binary()
    assert codex.runtime.version() is None
    assert [p.name for p in (Codex.home() / 'runtime').iterdir()] == []


def test_explicit_setting_does_not_download(web, monkeypatch):
    monkeypatch.setenv('SLIDE_STUDIO_CODEX', 'none')
    with pytest.raises(StudioError):
        Codex().ensure_binary()
    assert not web.requests


def test_terminal_cli_is_used_when_download_fails(web, monkeypatch, tmp_path):
    claude = use(monkeypatch, Claude)
    terminal = tmp_path / 'claude'
    terminal.write_text('#!/bin/sh\n')
    terminal.chmod(0o755)
    monkeypatch.setattr('shutil.which', lambda name: str(terminal))
    assert claude.ensure_binary() == str(terminal)


def test_app_copy_comes_before_terminal_and_setting_comes_first(web, monkeypatch, tmp_path):
    claude = use(monkeypatch, Claude)
    monkeypatch.setattr('shutil.which', lambda name: str(tmp_path / 'terminal'))
    assert claude.binary() == str(tmp_path / 'terminal')
    publish_claude(web)
    exe = claude.ensure_binary()
    assert claude.binary() == exe
    monkeypatch.setenv('SLIDE_STUDIO_CLAUDE', '/fixed/claude')
    assert claude.binary() == '/fixed/claude'


# ---------------------------------------------------------------- 更新
def installed(web, monkeypatch, *versions):
    claude = use(monkeypatch, Claude)
    for version in versions:
        publish_claude(web, version, body=f'claude {version}'.encode())
        assert claude.runtime.update(force=True) is True
    return claude


def test_update_keeps_one_previous_version(web, monkeypatch):
    claude = installed(web, monkeypatch, '2.1.1', '2.1.2', '2.1.3')
    state = claude.runtime.state()
    assert (state['current'], state['previous'], state['latest']) == ('2.1.3', '2.1.2', '2.1.3')
    assert sorted(p.name for p in claude.runtime.root.iterdir() if p.is_dir()) == ['2.1.2', '2.1.3']


def test_same_or_older_release_does_nothing(web, monkeypatch):
    claude = installed(web, monkeypatch, '2.1.3')
    publish_claude(web, '2.1.3')
    assert claude.runtime.update() is False
    publish_claude(web, '2.1.2')
    assert claude.runtime.update() is False
    assert claude.runtime.version() == '2.1.3'


def test_new_version_that_does_not_run_is_not_used(web, monkeypatch):
    why = '起動できませんでした'
    claude = installed(web, monkeypatch, '2.1.1')
    publish_claude(web, '2.1.2', body=b'broken')
    with pytest.raises(StudioError, match=why):
        claude.runtime.update(lambda exe: why)
    state = claude.runtime.state()
    assert state['current'] == '2.1.1' and why in state['error']
    assert not (claude.runtime.root / '2.1.2').exists()


def test_rollback_and_auto_update_skips_that_version(web, monkeypatch):
    claude = installed(web, monkeypatch, '2.1.1', '2.1.2')
    claude.runtime.rollback()
    state = claude.runtime.state()
    assert (state['current'], state['previous'], state['skip']) == ('2.1.1', '2.1.2', '2.1.2')
    assert claude.binary().endswith('/2.1.1/claude')
    assert claude.runtime.update() is False  # 自動では戻した版を入れない
    assert claude.runtime.version() == '2.1.1'
    assert claude.runtime.update(force=True) is True  # 手動なら入れ直せる
    assert claude.runtime.version() == '2.1.2'


def test_rollback_without_previous(web, monkeypatch):
    claude = installed(web, monkeypatch, '2.1.1')
    with pytest.raises(StudioError, match='戻せる版'):
        claude.runtime.rollback()


# ---------------------------------------------------------------- 裏の自動更新
def updater(provider, *, usable=True, busy=False):
    changed = Mock()
    return Updater([provider], lambda: busy, lambda: {'providers': [{'id': provider.id, 'ok': usable}]}, changed), changed


def test_auto_update_replaces_when_due(web, monkeypatch):
    claude = installed(web, monkeypatch, '2.1.1')
    claude.runtime._save(checked=0)
    publish_claude(web, '2.1.2')
    job, changed = updater(claude)
    job.tick()
    assert claude.runtime.version() == '2.1.2'
    changed.assert_called_once()


@pytest.mark.parametrize('case', ['auto-off', 'checked-recently', 'working'])
def test_auto_update_waits(web, monkeypatch, case):
    claude = installed(web, monkeypatch, '2.1.1')
    claude.runtime._save(checked=time.time() if case == 'checked-recently' else 0, auto=case != 'auto-off')
    publish_claude(web, '2.1.2')
    web.requests.clear()
    job, changed = updater(claude, busy=case == 'working')
    job.tick()
    assert claude.runtime.version() == '2.1.1' and not web.requests
    changed.assert_not_called()


def test_auto_update_does_not_fetch_unused_ai(web, monkeypatch):
    claude = use(monkeypatch, Claude)
    publish_claude(web)
    job, _ = updater(claude, usable=False)
    job.tick()
    assert claude.runtime.version() is None and not web.requests


def test_auto_update_moves_working_terminal_ai_to_app_copy(web, monkeypatch):
    claude = use(monkeypatch, Claude)
    publish_claude(web, '2.1.5')
    job, _ = updater(claude, usable=True)
    job.tick()
    assert claude.runtime.version() == '2.1.5'


def test_auto_update_ignores_network_errors(web, monkeypatch):
    claude = installed(web, monkeypatch, '2.1.1')
    claude.runtime._save(checked=0)
    web.clear()
    job, _ = updater(claude)
    job.tick()
    assert claude.runtime.version() == '2.1.1' and '確かめられません' in claude.runtime.state()['error']


# ---------------------------------------------------------------- 動作確認・検出
def test_claude_status_output_that_is_not_json_is_an_error_not_a_stray_brace(monkeypatch):
    p = Claude()
    monkeypatch.setattr(providers, '_run', lambda argv, **kw: CompletedProcess(argv, 1, 'not json\n', 'boom'))
    found = p._detect('claude', {})
    assert (found['reason'], found['message']) == ('error', 'boom')


def test_claude_logged_out_has_no_message(monkeypatch):
    p = Claude()
    body = json.dumps({'loggedIn': False}, indent=2)
    monkeypatch.setattr(providers, '_run', lambda argv, **kw: CompletedProcess(argv, 1, body, ''))
    assert p._detect('claude', {}) == {'ok': False, 'reason': 'login', 'message': ''}


def test_agy_sign_in_message_and_other_failures(monkeypatch):
    p = Antigravity()
    monkeypatch.setattr(providers, '_run', lambda argv, **kw: CompletedProcess(argv, 1, '', 'Error: Please sign in to view available models.'))
    assert p._detect('agy', {})['reason'] == 'login'
    monkeypatch.setattr(providers, '_run', lambda argv, **kw: CompletedProcess(argv, 2, '', 'segfault'))
    assert p._detect('agy', {}) == {'ok': False, 'reason': 'error', 'message': 'segfault'}


def test_cli_self_update_is_off_for_app_runs():
    assert Claude().env(Claude.home())['DISABLE_AUTOUPDATER'] == '1'
    assert Antigravity().env(Antigravity.home())['AGY_CLI_DISABLE_AUTO_UPDATE'] == 'true'


@pytest.mark.parametrize('case', ['bad-version', 'error', 'lost-login', 'fine'])
def test_accepts_new_binary(monkeypatch, case):
    p = Claude()
    def run(argv, **kw):
        if argv[1:] == ['--version']:
            return CompletedProcess(argv, 1 if case == 'bad-version' else 0, '2.1.1', 'crash')
        status = {'loggedIn': case != 'lost-login', 'authMethod': 'x'}
        return CompletedProcess(argv, 0, 'oops' if case == 'error' else json.dumps(status), '')
    monkeypatch.setattr(providers, '_run', run)
    result = p.accepts('claude', was_ok=True)
    assert (result is None) == (case == 'fine')


# ---------------------------------------------------------------- ログイン
def script(tmp_path, name, body):
    path = tmp_path / name
    path.write_text(f'#!{sys.executable}\n' + body)
    path.chmod(0o755)
    return str(path)


CLAUDE_CLI = '''
import json, os, pathlib, sys
home = pathlib.Path(os.environ['CLAUDE_CONFIG_DIR'])
if sys.argv[1:] == ['auth', 'login', '--claudeai']:
    (home / 'signed-in').write_text('yes')
elif sys.argv[1:] == ['auth', 'status']:
    print(json.dumps({'loggedIn': (home / 'signed-in').exists(), 'authMethod': 'claude.ai'}))
'''


def test_claude_login_runs_the_official_login_and_confirms(tmp_path):
    asyncio.run(Claude().login(script(tmp_path, 'claude', CLAUDE_CLI)))
    assert (Claude.home() / 'signed-in').read_text() == 'yes'


def test_claude_login_that_ends_without_signing_in_fails(tmp_path):
    cli = script(tmp_path, 'claude', '''
import json, sys
if sys.argv[1:] == ['auth', 'status']:
    print(json.dumps({'loggedIn': False}))
''')
    with pytest.raises(ValueError, match='ログインを完了できません'):
        asyncio.run(Claude().login(cli))


AGY_CLI = '''
import json, os, pathlib, sys
flag = pathlib.Path(os.environ['FAKE_AGY_FLAG'])
if sys.argv[1:] == ['models']:
    if flag.exists():
        print('m-low\\tM (Low)')
    else:
        print('Error: Please sign in', file=sys.stderr); sys.exit(1)
    sys.exit(0)
for line in sys.stdin:
    message = json.loads(line)
    if message['method'] == 'initialize':
        print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': {'authMethods': [{'id': 'oauth-personal'}]}}), flush=True)
    if message['method'] == 'authenticate':
        if os.environ.get('FAKE_AGY_DENY'):
            print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'error': {'message': 'denied'}}), flush=True)
        else:
            assert message['params'] == {'methodId': 'oauth-personal'}
            flag.write_text('yes')
            print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': {}}), flush=True)
'''


def test_agy_login_through_acp(tmp_path, monkeypatch):
    monkeypatch.setenv('FAKE_AGY_FLAG', str(tmp_path / 'flag'))
    asyncio.run(Antigravity().login(script(tmp_path, 'agy', AGY_CLI)))
    assert (tmp_path / 'flag').exists()


def test_agy_login_denied(tmp_path, monkeypatch):
    monkeypatch.setenv('FAKE_AGY_FLAG', str(tmp_path / 'flag'))
    monkeypatch.setenv('FAKE_AGY_DENY', '1')
    with pytest.raises(ValueError, match='denied'):
        asyncio.run(Antigravity().login(script(tmp_path, 'agy', AGY_CLI)))


def test_logins_report_preparing_failure():
    from slide_studio.ai.login import Logins

    class Broken(Codex):
        def ensure_binary(self):
            raise StudioError('届きません')

    async def check():
        logins, provider = Logins(), Broken()
        assert logins.state(provider) == {'status': 'idle'}
        logins.start(provider)
        await logins.jobs['codex'].task
        return logins.state(provider)
    assert asyncio.run(check()) == {'status': 'failed', 'error': '届きません', 'progress': None, 'retry': False}


def test_download_stops_before_login():
    from slide_studio.ai.login import Logins

    async def run():
        provider = Mock(id='claude')
        provider.runtime.progress = None
        provider.ensure_binary.return_value = '/fake/claude'
        logins = Logins()
        logins.start(provider, download=True)
        await logins.jobs['claude'].task
        assert logins.state(provider)['status'] == 'ready'
        provider.login.assert_not_called()
        provider.ensure_binary.assert_called_once()
    asyncio.run(run())


@pytest.mark.parametrize('opens', [True, False])
def test_claude_login_opens_printed_url(tmp_path, monkeypatch, opens):
    url = 'https://claude.ai/oauth/authorize?state=test&code_challenge=test'
    browser = Mock(return_value=opens)
    monkeypatch.setattr(providers.webbrowser, 'open', browser)
    cli = script(tmp_path, 'claude', CLAUDE_CLI.replace(
        "    (home / 'signed-in').write_text('yes')",
        "    print(" + repr(url) + ", flush=True)\n    import time; time.sleep(0.2)\n    (home / 'signed-in').write_text('yes')"))
    if opens:
        asyncio.run(Claude().login(cli))
    else:
        with pytest.raises(ValueError, match='ブラウザーを開けません'):
            asyncio.run(Claude().login(cli))
    browser.assert_called_once_with(url)
