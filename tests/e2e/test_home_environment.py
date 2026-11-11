"""ホームの動作環境から AI を導入する。通信は置き換え、実際の AI は起動しない。"""
from urllib.parse import urlparse

import pytest
from playwright.sync_api import expect


@pytest.fixture
def home_ai(page):
    names = {'codex': 'Codex', 'claude': 'Claude Code', 'agy': 'Antigravity'}
    state = {
        'runtime': {key: {'id': key, 'name': name, 'version': None, 'terminal': False,
                         'fixed': False, 'latest': None, 'update': False, 'previous': None,
                         'auto': True, 'busy': False, 'progress': None, 'error': ''}
                    for key, name in names.items()},
        'provider': {key: {'id': key, 'name': name, 'ok': False, 'reason': 'missing', 'models': []}
                     for key, name in names.items()},
        'login': {key: {'status': 'idle', 'progress': None, 'retry': False, 'error': ''} for key in names},
        'posts': [], 'polls': {key: 0 for key in names}, 'fail_next': False,
        'hold_status': False, 'status_routes': [], 'fail_poll_once': set(),
        'poll_errors': {key: 0 for key in names},
    }

    def answer(route):
        path = urlparse(route.request.url).path
        if path == '/api/ai/runtimes':
            route.fulfill(json={'ai': list(state['runtime'].values())})
        elif path == '/api/ai/status':
            if state['hold_status']:
                state['status_routes'].append(route)
            else:
                route.fulfill(json={'providers': list(state['provider'].values())})
        elif path.endswith('/login') and (key := path.split('/')[-2]) in names:
            if route.request.method == 'POST':
                body = route.request.post_data_json
                state['posts'].append((key, body))
                if state['fail_next']:
                    state['fail_next'] = False
                    route.fulfill(status=503, json={'error': 'ログインを開始できませんでした'})
                    return
                state['login'][key] = {
                    'status': 'preparing' if body.get('download') else 'pending',
                    'progress': {'done': 40, 'total': 100} if body.get('download') else None,
                    'retry': not body.get('download'), 'error': '',
                }
            else:
                state['polls'][key] += 1
                if key in state['fail_poll_once']:
                    state['fail_poll_once'].remove(key)
                    state['poll_errors'][key] += 1
                    route.fulfill(status=503, json={'error': '一時的に接続できません'})
                    return
            route.fulfill(json=state['login'][key])
        else:
            route.fulfill(status=404, json={'error': f'想定外の API: {path}'})

    page.route('**/api/env*', lambda route: route.fulfill(json={
        'items': [{'name': 'Pandoc', 'ok': True, 'detail': 'ready'},
                  {'name': 'Chromium', 'ok': True, 'detail': 'ready'}],
    }))
    page.route('**/api/ai/**', answer)
    try:
        yield state
    finally:
        for route in state['status_routes']:
            route.abort()
        page.unroute('**/api/ai/**', answer)


def release_status(state):
    state['hold_status'] = False
    while state['status_routes']:
        state['status_routes'].pop().fulfill(json={'providers': list(state['provider'].values())})


def installed(state, key):
    state['runtime'][key]['version'] = '1.0.0'
    state['provider'][key]['reason'] = 'login'
    state['login'][key] = {'status': 'ready', 'progress': None, 'retry': False, 'error': ''}


def logged_in(state, key):
    state['provider'][key].update(ok=True, reason='')
    state['login'][key] = {'status': 'completed', 'progress': None, 'retry': False, 'error': ''}


def test_home_installs_ai_then_logs_in_and_fits_narrow_screen(page, gui, home_ai, tmp_path):
    _, srv = gui
    page.emulate_media(reduced_motion='reduce')
    page.set_viewport_size({'width': 390, 'height': 780})
    page.goto(srv.url)
    trigger = page.get_by_role('button', name='動作環境', exact=True)
    expect(trigger).to_contain_text('動作環境')
    assert trigger.locator('span').evaluate('''el => {
        const range = document.createRange(); range.selectNodeContents(el);
        return range.getClientRects().length;
    }''') == 1
    trigger.click()
    panel = page.get_by_role('dialog', name='動作環境', exact=True)
    rows = panel.locator('.env-ai li[data-ai]')
    expect(rows).to_have_count(3)
    # 更新一覧が未取得でも、3種類とも導入を開始できる。
    for key in ('codex', 'claude', 'agy'):
        expect(panel.locator(f'[data-ai="{key}"] [data-act="ai-install"]')).to_be_enabled()
    bounds = panel.bounding_box()
    assert bounds['x'] >= 0 and bounds['y'] >= 0
    assert bounds['x'] + bounds['width'] <= 390
    assert bounds['y'] + bounds['height'] <= 780
    assert panel.evaluate('el => el.scrollWidth <= el.clientWidth')
    page.screenshot(path=str(tmp_path / 'home-environment-narrow.png'))

    codex = panel.locator('[data-ai="codex"]')
    codex.get_by_role('button', name='インストール', exact=True).click()
    expect(codex.get_by_role('status')).to_contain_text('40%')
    assert home_ai['posts'] == [('codex', {'download': True})]
    installed(home_ai, 'codex')
    login = codex.get_by_role('button', name='ChatGPT でログイン', exact=True)
    expect(login).to_be_enabled()
    # インストール完了だけではログイン処理を始めない。
    assert home_ai['posts'] == [('codex', {'download': True})]
    login.click()
    expect(codex.get_by_role('status')).to_contain_text('ブラウザーでログイン')
    logged_in(home_ai, 'codex')
    expect(codex).to_contain_text('ログイン済み')
    assert home_ai['posts'] == [('codex', {'download': True}), ('codex', {'download': False})]
    page.set_viewport_size({'width': 1500, 'height': 900})
    page.emulate_media(color_scheme='dark', reduced_motion='reduce')
    page.screenshot(path=str(tmp_path / 'home-environment-dark.png'))
    assert not page.errors


def test_home_login_failure_and_pending_login_can_be_retried(page, gui, home_ai):
    _, srv = gui
    installed(home_ai, 'claude')
    home_ai['runtime']['claude'].update(version=None, terminal=True)
    home_ai['fail_next'] = True
    page.goto(srv.url)
    page.get_by_role('button', name='動作環境', exact=True).click()
    claude = page.locator('.env-ai [data-ai="claude"]')
    login = claude.locator('[data-act="ai-login"]')
    expect(login).to_have_text('Claude でログイン')
    expect(claude.locator('[data-act="ai-install"]')).to_have_count(0)
    login.click()
    expect(claude.get_by_role('status')).to_contain_text('ログインを開始できませんでした')
    expect(login).to_be_enabled()
    login.click()
    expect(login).to_have_text('もう一度ログイン')
    expect(login).to_be_enabled()
    with page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/api/ai/claude/login')):
        login.click()
    logged_in(home_ai, 'claude')
    expect(claude).to_contain_text('ログイン済み')
    assert home_ai['posts'] == [('claude', {'download': False})] * 3
    assert not page.errors


def test_home_resumes_monitoring_install_after_reload(page, gui, home_ai):
    _, srv = gui
    home_ai['login']['agy'] = {
        'status': 'preparing', 'progress': {'done': 40, 'total': 100}, 'retry': False, 'error': '',
    }
    page.goto(srv.url)
    page.get_by_role('button', name='動作環境', exact=True).click()
    agy = page.locator('.env-ai [data-ai="agy"]')
    expect(agy.get_by_role('status')).to_contain_text('40%')
    expect(agy.locator('[data-act="ai-install"]')).to_be_disabled()
    first_polls = home_ai['polls']['agy']
    page.reload()
    page.get_by_role('button', name='動作環境', exact=True).click()
    expect(agy.get_by_role('status')).to_contain_text('40%')
    assert home_ai['polls']['agy'] > first_polls
    installed(home_ai, 'agy')
    expect(agy.locator('[data-act="ai-login"]')).to_be_enabled()
    # 画面を開き直しても、実行中のインストールを再送しない。
    assert home_ai['posts'] == []
    assert not page.errors


def test_home_install_progress_does_not_wait_for_account_status(page, gui, home_ai):
    _, srv = gui
    home_ai['hold_status'] = True
    page.goto(srv.url)
    page.get_by_role('button', name='動作環境', exact=True).click()
    codex = page.locator('.env-ai [data-ai="codex"]')
    install = codex.get_by_role('button', name='インストール', exact=True)
    expect(install).to_be_enabled()
    assert home_ai['status_routes']
    install.click()
    expect(codex.get_by_role('status')).to_contain_text('40%')
    home_ai['login']['codex']['progress'] = {'done': 80, 'total': 100}
    expect(codex.get_by_role('status')).to_contain_text('80%')
    installed(home_ai, 'codex')
    expect(codex).to_contain_text('1.0.0')
    expect(codex.get_by_role('button', name='ChatGPT でログイン', exact=True)).to_be_enabled()
    assert home_ai['posts'] == [('codex', {'download': True})]
    release_status(home_ai)
    assert not page.errors


def test_home_install_poll_retries_after_temporary_error(page, gui, home_ai):
    _, srv = gui
    page.goto(srv.url)
    page.get_by_role('button', name='動作環境', exact=True).click()
    codex = page.locator('.env-ai [data-ai="codex"]')
    codex.get_by_role('button', name='インストール', exact=True).click()
    expect(codex.get_by_role('status')).to_contain_text('40%')
    with page.expect_response(lambda r: r.url.endswith('/api/ai/codex/login') and r.status == 503):
        home_ai['fail_poll_once'].add('codex')
    installed(home_ai, 'codex')
    expect(codex.get_by_role('button', name='ChatGPT でログイン', exact=True)).to_be_enabled()
    assert home_ai['poll_errors']['codex'] == 1
    assert home_ai['posts'] == [('codex', {'download': True})]
    assert not page.errors
