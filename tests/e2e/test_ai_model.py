"""モデル候補を横に開く・全件スクロール・表記ゆれ検索。実際の CSS とブラウザで検証。"""
import json

from e2e.conftest import expand_subs, open_deck
from playwright.sync_api import expect
import pytest


def mount_picker(gui, page):
    _, srv = gui
    page.route("**/picker-test", lambda route: route.fulfill(
        content_type="text/html", body='''<!doctype html><html lang="ja"><head>
        <link rel="stylesheet" href="/web/shared.css"><link rel="stylesheet" href="/web/app.css">
        </head><body><div class="chat-model" style="position:absolute;right:80px;bottom:40px"></div></body></html>'''))
    page.goto(f"{srv.url}/picker-test")
    page.evaluate('''async () => {
      const { makeModelPicker } = await import('/web/ai-model.js');
      const model = (id, name) => ({ id, name, efforts: ['low', 'medium', 'high'], effort: 'medium' });
      const ai = { favorites_limit: 100, favorites: ['codex:test-big'], providers: [
        { id: 'codex', name: 'Codex', ok: true, models: [model('test-big', 'Test Big'),
          ...Array.from({ length: 75 }, (_, i) => model(`catalog/atlas-${i}`, `Atlas ${i}`))] },
        { id: 'other', name: 'Other AI', ok: true, models: [model('other/test_big', 'Test Big')] },
        { id: 'unavailable', name: 'Offline AI', ok: false, reason: 'missing', models: [model('hidden', 'Hidden')] }
      ] };
      window.ai = ai;
      window.picker = makeModelPicker({ host: document.querySelector('.chat-model'),
        onModel: key => { window.selected = key; picker.render({ key }); }, onEffort: () => {},
        onFavorites: favorites => { ai.favorites = favorites; picker.render({ ai }); },
        onRole: (role, value) => { window.roleSettings = { ...window.roleSettings, [role]: value }; picker.render({ roleSettings: window.roleSettings }); }, onRecheck: async () => { window.rechecks = (window.rechecks || 0) + 1; } });
      picker.render({ ai, key: 'codex:test-big', mode: 'slides', contextKey: 'one', roles: ['review'], roleProviders: ['codex'], roleSettings: {} });
      picker.open('models');
    }''')


def test_catalog_checks_only_and_selection(gui, page, tmp_path):
    mount_picker(gui, page)
    expect(page.locator('.ai-row')).to_have_count(1)
    assert page.locator('[role=checkbox], [data-mact=unfav], select').count() == 0
    page.get_by_role('button', name='モデルを追加', exact=True).click()
    catalog = page.locator('.ai-catalog')
    rows = catalog.locator('.ai-row')
    expect(rows).to_have_count(77)
    assert catalog.locator('.ai-bad').count() == 1
    assert catalog.locator('.ai-list').evaluate('el => el.scrollHeight > el.clientHeight')
    field = catalog.get_by_role('searchbox')
    top = field.bounding_box()['y']
    rows.last.scroll_into_view_if_needed()
    assert field.bounding_box()['y'] == top
    for query in ['testbig', '  TEST　BIG  ', 'ＴＥＳＴＢＩＧ', 'test_big']:
        field.fill(query)
        expect(rows).to_have_count(2)
        expect(field).to_be_focused()
    field.fill('does not exist')
    expect(rows).to_have_count(0)
    field.fill('atlas74')
    check = catalog.locator('[data-key="codex:catalog/atlas-74"]')
    expect(check).to_have_attribute('aria-checked', 'false')
    check.click()
    expect(check).to_have_attribute('aria-checked', 'true')
    assert page.evaluate('window.selected') is None  # 登録だけで選択しない
    expect(catalog).to_be_visible()
    for theme in ['light', 'dark']:
        page.evaluate('t => document.documentElement.dataset.theme = t', theme)
        page.screenshot(path=str(tmp_path / f'models-{theme}.png'))
    page.keyboard.press('Escape')
    assert page.locator('[role=checkbox]').count() == 0
    page.locator('[data-mact=pick][data-key="codex:catalog/atlas-74"]').click()
    assert page.evaluate('selected') == 'codex:catalog/atlas-74'
    assert not page.errors


def test_click_survives_redraw_while_pressed(gui, page):
    mount_picker(gui, page)
    page.evaluate("ai.favorites = ['codex:test-big', 'codex:catalog/atlas-0']; picker.render({ai})")
    box = page.locator('[data-mact=pick][data-key="codex:catalog/atlas-0"]').bounding_box()
    page.mouse.move(box['x'] + 10, box['y'] + 10)
    page.mouse.down()
    page.evaluate('picker.render({})')  # 押している間に別の理由で画面を描き直す
    page.mouse.up()
    assert page.evaluate('window.selected') == 'codex:catalog/atlas-0'
    assert not page.errors


def test_expanded_codex_help_scrolls_into_view(gui, page):
    mount_picker(gui, page)
    page.evaluate("""() => {
      ai.providers.push({id: 'codex', name: 'Codex', ok: false, reason: 'login', models: []});
      picker.render({ai});
    }""")
    page.locator('[data-mact=add]').click()
    button = page.locator('[data-mact=help][data-id=codex]')
    button.scroll_into_view_if_needed()
    before = page.locator('.ai-catalog .ai-list').evaluate('el => el.scrollTop')
    button.click()
    page.wait_for_function("""() => {
      const panel = document.querySelector('.ai-bad.open').getBoundingClientRect();
      const list = document.querySelector('.ai-catalog .ai-list').getBoundingClientRect();
      return panel.top >= list.top - 1 && panel.bottom <= list.bottom + 1;
    }""")
    assert page.locator('.ai-catalog .ai-list').evaluate('el => el.scrollTop') > before
    expect(page.locator('.ai-bad.open .ai-login')).to_be_visible()
    button.click()
    expect(page.locator('.ai-bad.open')).to_have_count(0)
    assert not page.errors


def test_favorites_uncheck_keeps_selected_model_and_subagents(gui, page):
    mount_picker(gui, page)
    page.locator('[data-mact=add]').click()
    page.locator('[data-mact=favorite][data-key="codex:test-big"]').click()
    expect(page.locator('[data-mact=favorite][data-key="codex:test-big"]')).to_have_attribute('aria-checked', 'false')
    page.keyboard.press('Escape')
    expect(page.locator('.ai-row')).to_have_count(0)
    page.keyboard.press('Escape')
    assert 'Test Big' in page.locator('.ai-mname').inner_text()
    assert page.locator('[data-mact=add], [role=checkbox]').count() == 0
    expand_subs(page)
    expect(page.locator('.ai-sub-row')).to_have_count(1)
    assert page.locator('.ai-sub-row .ai-role').inner_text() == '確認'
    assert page.locator('.ai-mname[data-role="html"]').count() == 0
    assert 'チャットと同じ' not in page.locator('.ai-pop').inner_text()
    assert all('Test Big' in s for s in page.locator('.ai-sub-row .ai-mname').all_text_contents())
    page.locator('.ai-mname[data-role="review"]').click()
    assert page.locator('[data-mact=add], [role=checkbox]').count() == 0
    page.locator('[data-mact=pick]').click()
    assert page.evaluate('roleSettings.review') is None
    page.evaluate("picker.render({ contextKey: 'draft', roles: ['review'], mode: 'memo' })")
    expect(page.locator('.ai-pop')).to_be_hidden()
    page.locator('.ai-mbtn').click()
    # 開いたサブエージェントは、開き直しても開いたまま
    expect(page.locator('.ai-sub-row')).to_have_count(1)
    page.locator('[data-mact=subs]').click()
    expect(page.locator('.ai-sub-row')).to_have_count(0)
    expect(page.locator('.ai-sub-chip')).to_have_text(['確認'])
    expand_subs(page)
    expect(page.locator('.ai-sub-row')).to_have_count(1)
    assert page.locator('.ai-sub-row .ai-role').inner_text() == '確認'
    assert not page.errors


def test_slider_commit_drag_cancel_lock_and_bounds(gui, page, tmp_path):
    mount_picker(gui, page)
    page.evaluate("window.changes=[]; picker.destroy(); document.querySelector('.chat-model').innerHTML=''")
    page.evaluate("""async () => {
      const {makeModelPicker} = await import('/web/ai-model.js');
      const ai={favorites: ['codex:m'], providers:[{id:'codex',ok:true,name:'Codex',models:[{id:'m',name:'Model',efforts:['low','medium','high'],effort:'medium'}]}]};
      window.picker=makeModelPicker({host:document.querySelector('.chat-model'),onModel:()=>{},onFavorites:()=>{},onRecheck:()=>{},onEffort:e=>{changes.push(e);picker.render({effort:e})}});
      picker.render({ai,key:'codex:m',contextKey:'one'});picker.open();
    }""")
    slider = page.locator('.ai-slider')
    box = slider.bounding_box()
    page.evaluate("import('/web/tip.js')")
    page.mouse.move(box['x'] + 14, box['y'] + 14)
    expect(page.locator('.ai-effort-value')).to_have_text('クリックで「低」に変更')
    expect(slider).to_have_attribute('aria-valuetext', '中')
    expect(page.locator('.ai-preview')).to_be_visible()
    page.mouse.move(box['x'] + box['width'] - 14, box['y'] + 14)
    expect(page.locator('.ai-effort-value')).to_have_text('クリックで「高」に変更')
    page.wait_for_timeout(350)
    expect(page.locator('.tip.show')).to_have_count(0)
    for theme in ['light', 'dark']:
        page.evaluate('t => document.documentElement.dataset.theme = t', theme)
        page.locator('.ai-pop').screenshot(path=str(tmp_path / f'effort-{theme}.png'))
    page.mouse.move(box['x'], box['y'] - 10)
    expect(page.locator('.ai-effort-value')).to_have_text('中')
    expect(page.locator('.ai-preview')).to_be_hidden()
    page.mouse.move(box['x'] + 14, box['y'] + 14)
    page.mouse.down()
    page.mouse.move(box['x'] + box['width'] - 14, box['y'] + 14, steps=8)
    assert page.evaluate('changes') == []
    page.mouse.up()
    expect(slider).to_have_attribute('aria-valuetext', '高')
    assert page.evaluate('changes') == ['high']
    slider.press('ArrowLeft')
    expect(slider).to_have_attribute('aria-valuetext', '中')
    assert page.evaluate('changes') == ['high', None]
    slider.press('Home')
    expect(slider).to_have_attribute('aria-valuetext', '低')
    page.evaluate('picker.render({busy:true})')
    slider.press('End')
    expect(slider).to_have_attribute('aria-valuetext', '低')
    page.set_viewport_size({'width':390,'height':844})
    page.evaluate("document.querySelector('.chat-model').style.right='40px'")
    page.evaluate('picker.render({busy:false})')
    box=page.locator('.ai-pop').bounding_box()
    assert box['x'] >= 0 and box['x']+box['width'] <= 390
    assert not page.errors


def test_unavailable_favorites_can_be_removed_at_limit(gui, page):
    mount_picker(gui, page)
    page.evaluate("ai.favorites=['codex:test-big','codex:retired','unavailable:hidden'];ai.favorites_limit=3;picker.render({ai})")
    page.locator('[data-mact=add]').click()
    retired=page.locator('[data-mact=favorite][data-key="codex:retired"]')
    offline=page.locator('[data-mact=favorite][data-key="unavailable:hidden"]')
    expect(retired).to_have_attribute('aria-checked','true')
    expect(offline).to_have_attribute('aria-checked','true')
    candidate=page.locator('[data-mact=favorite][data-key="codex:catalog/atlas-0"]')
    expect(candidate).to_have_attribute('aria-disabled','true')
    retired.click()
    expect(candidate).to_have_attribute('aria-disabled','false')
    candidate.click()
    expect(candidate).to_have_attribute('aria-checked','true')
    assert page.evaluate('window.selected') is None
    assert not page.errors


@pytest.mark.parametrize('role', ['', 'review'])
@pytest.mark.parametrize('fail_first', [False, True])
def test_effort_clicks_during_save_keep_last_choice(gui, page, role, fail_first):
    mount_picker(gui, page)
    page.evaluate("""async () => {
      picker.destroy(); document.querySelector('.chat-model').innerHTML = '';
      const {makeModelPicker} = await import('/web/ai-model.js');
      window.changes = []; window.saves = []; window.roleSettings = {};
      const save = (role, effort) => {
        changes.push({role, effort});
        return new Promise((resolve, reject) => saves.push({
          finish: () => {
            if (role) { roleSettings[role] = {model:'codex:test-big', effort}; picker.render({roleSettings}); }
            else picker.render({effort});
            resolve();
          }, fail: () => reject(new Error('save failed'))
        }));
      };
      window.picker = makeModelPicker({host:document.querySelector('.chat-model'),
        onEffort:e => save('', e), onRole:(r, v) => save(r, v.effort)});
      picker.render({ai, key:'codex:test-big', contextKey:'one', roles:['review']});
      picker.open();
    }""")
    if role:
        expand_subs(page)
    slider = page.locator(f'.ai-slider[data-role="{role}"]')
    slider.press('End')
    box = slider.bounding_box()
    # 保存を保留したまま低→中→低へ。クリックもキーも最後の選択を残す。
    page.mouse.click(box['x'] + 11, box['y'] + box['height'] / 2)
    expect(slider).to_have_attribute('aria-valuetext', '低')
    slider.press('ArrowRight')
    expect(slider).to_have_attribute('aria-valuetext', '中')
    slider.press('Home')
    assert page.evaluate('changes') == [{'role': role, 'effort': 'high'}]
    page.evaluate(f"saves[0].{'fail' if fail_first else 'finish'}()")
    page.wait_for_function('changes.length === 2')
    assert page.evaluate('changes[1]') == {'role': role, 'effort': 'low'}
    page.evaluate('saves[1].finish()')
    expect(slider).to_have_attribute('aria-valuetext', '低')
    assert not page.errors


def test_subagent_toggles_preserve_selection_and_lock(gui, page):
    mount_picker(gui, page)
    page.keyboard.press('Escape')
    page.evaluate("picker.render({roles:['review','consult'], roleDefaults:{review:true, consult:false}, roleSettings:{review:{model:'codex:catalog/atlas-0',effort:'high'}}}); window.roleSettings={review:{model:'codex:catalog/atlas-0',effort:'high'}}")
    expand_subs(page)
    # 確認は既定でオン、相談役は既定でオフ。押すたびに切り替わり、作業中は押せない
    for role, first in [('review', True), ('consult', False)]:
        switch = page.locator(f'[data-mact=role-toggle][data-role={role}]')
        for i, on in enumerate((first, not first, first)):
            expect(switch).to_have_attribute('aria-checked', str(on).lower())
            expect(page.locator(f'.ai-mname[data-role={role}]')).to_have_count(1 if on else 0)
            if i == 1:
                page.evaluate('picker.render({busy:true})')
                expect(switch).to_have_attribute('aria-disabled', 'true')
                page.evaluate('picker.render({busy:false})')
            if i < 2:
                switch.click()
    assert page.evaluate('roleSettings.review.model') == 'codex:catalog/atlas-0'
    assert page.evaluate('roleSettings.review.effort') == 'high'
    assert not page.errors


def test_claude_and_agy_show_login_button_instead_of_commands(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    calls = []

    def answer(route):
        calls.append(route.request.method)
        route.fulfill(status=200, content_type='application/json',
                      body='{"status":"failed","error":"届きません"}' if route.request.method == 'GET' else '{"status":"preparing"}')
    page.route('**/api/ai/claude/login', answer)
    page.evaluate("""async () => {
      const {helpHtml} = await import('/web/ai-model.js');
      document.querySelector('.chat-notice').innerHTML = helpHtml({id:'claude', reason:'login'}) + helpHtml({id:'agy', reason:'missing'});
    }""")
    expect(page.locator('.ai-onboarding[data-ai=claude] .ai-login')).to_have_text('Claude でログイン')
    expect(page.locator('.ai-onboarding[data-ai=agy] .ai-login')).to_have_text('ダウンロード')
    assert 'auth login' not in page.locator('.chat-notice').inner_text()
    page.locator('.ai-onboarding[data-ai=claude] .ai-login').click()
    expect(page.locator('.ai-onboarding[data-ai=claude] .ai-login-status')).to_have_text('届きません')
    expect(page.locator('.ai-onboarding[data-ai=agy] .ai-login-status')).to_have_text('')
    assert calls[0] == 'POST'
    assert not page.errors


def test_home_runtime_rows(gui, page):
    ws, srv = gui
    rows = [
        {'id': 'codex', 'name': 'Codex', 'version': '0.160.0', 'terminal': False, 'fixed': False, 'latest': '0.167.0', 'update': True,
         'previous': '0.159.0', 'auto': True, 'busy': False, 'progress': None, 'error': None},
        {'id': 'claude', 'name': 'Claude Code', 'version': '2.1.322', 'terminal': True, 'fixed': False, 'latest': '2.1.311', 'update': True,
         'previous': None, 'auto': False, 'busy': False, 'progress': None, 'error': 'Claude Code の最新版を確かめられませんでした。'},
        {'id': 'agy', 'name': 'Antigravity', 'version': None, 'terminal': False, 'fixed': False, 'latest': None, 'update': False,
         'previous': None, 'auto': True, 'busy': False, 'progress': None, 'error': None},
    ]
    posted = []
    page.route('**/api/ai/runtimes*', lambda route: route.fulfill(status=200, content_type='application/json', body=json.dumps({'ai': rows})))

    def action(route):
        posted.append((route.request.url.split('/api/ai/')[1], route.request.post_data_json))
        route.fulfill(status=200, content_type='application/json', body='{}')
    page.route('**/api/ai/*/runtime', action)
    page.goto(srv.url + '/')
    page.locator('[data-act=env]').click()
    list_ = page.locator('.env-ai')
    expect(list_.locator('li').nth(0).locator('.detail')).to_have_text('0.160.0 → 0.167.0')
    expect(list_.locator('li').nth(1).locator('.detail')).to_have_text('2.1.322（ターミナル）')
    expect(list_.locator('li').nth(1).locator('.fix')).to_be_visible()
    expect(list_.locator('li').nth(2).locator('.detail')).to_have_text('未取得')
    expect(list_.locator('li').nth(1).locator('[data-act=ai-update]')).to_have_attribute('data-tip', '2.1.311 をアプリ専用に取得')
    list_.locator('li').nth(0).locator('[data-act=ai-update]').click()
    list_.locator('li').nth(0).locator('[data-act=ai-rollback]').click()
    list_.locator('li').nth(1).locator('[data-act=ai-auto]').click()
    page.wait_for_timeout(100)
    assert posted == [('codex/runtime', {'action': 'update'}), ('codex/runtime', {'action': 'rollback'}), ('claude/runtime', {'auto': True})]
    assert not page.errors


def test_waiting_login_can_be_pressed_again_in_model_picker(gui, page):
    mount_picker(gui, page)
    posts, retry = [], {'value': False}
    def answer(route):
        if route.request.method == 'POST':
            posts.append(route.request.post_data_json)
        route.fulfill(status=200, content_type='application/json', body=json.dumps({'status': 'pending', 'retry': retry['value']}))
    page.route('**/api/ai/codex/login', answer)
    page.evaluate("""() => {
      ai.providers.push({id: 'codex', name: 'Codex', ok: false, reason: 'login', models: []});
      picker.render({ai});
    }""")
    page.locator('[data-mact=add]').click()
    page.locator('[data-mact=help][data-id=codex]').click()
    button = page.locator('.ai-bad.open .ai-login')
    button.click()
    expect(page.locator('.ai-bad.open .ai-login-status')).to_have_text('ブラウザーでログインを完了してください。')
    expect(button).to_be_disabled()
    # 待っている間も再確認できる
    page.locator('.ai-bad.open .ai-recheck').click()
    page.wait_for_function('window.rechecks === 1')
    retry['value'] = True
    expect(button).to_have_text('もう一度ログイン')
    expect(button).to_be_enabled()
    assert button.get_attribute('data-tip') == 'ログイン画面を開き直す'
    button.click()
    page.wait_for_timeout(200)
    assert len(posts) == 2
    assert not page.errors


def test_download_then_login_are_separate_actions(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    posts = []
    def answer(route):
        if route.request.method == 'POST':
            posts.append(route.request.post_data_json)
        route.fulfill(status=200, content_type='application/json', body='{"status":"ready"}')
    page.route('**/api/ai/claude/login', answer)
    page.evaluate("""async () => {
      const {helpHtml, loginAi} = await import('/web/ai-model.js');
      const host = document.createElement('div');
      host.id = 'test-onboarding'; document.body.append(host);
      host.innerHTML = helpHtml({id:'claude', reason:'missing'});
      host.onclick = e => {
        if (e.target.closest('.ai-login')) loginAi('claude', async () => {
          host.innerHTML = helpHtml({id:'claude', reason:'login'});
        });
      };
    }""")
    button = page.locator('#test-onboarding .ai-login')
    expect(button).to_have_text('ダウンロード')
    button.click()
    expect(button).to_have_text('Claude でログイン')
    expect(button).to_be_enabled()
    assert posts == [{'download': True}]
    expect(page.locator('#test-onboarding .ai-login-status')).to_have_text('')
