"""ホームから担当別プロンプトを見て、必須の指示は変えられず、追加指示は書いて保存できることを確認する。"""
from playwright.sync_api import expect
from slide_studio.ai import roles
from slide_studio.ai.roles import ROLES


def test_roles_screen_and_settings(gui, page, monkeypatch):
    ws, srv = gui
    status = {'providers': [{'id': 'codex', 'name': 'Codex', 'ok': True, 'models': [
        {'id': 'test-big', 'name': 'Test Big', 'efforts': ['low', 'high'], 'effort': 'low', 'context': 1000}], 'default': 'test-big'}],
        'default': 'codex:test-big', 'favorites': ['codex:test-big']}
    monkeypatch.setattr(srv.app.state.chat, 'ai_status', lambda *a: status)
    srv.app.state.chat.status = status
    response = page.request.get(srv.url + '/api/ai/roles')
    assert response.ok
    listed = response.json()['roles']
    assert {r['id'] for r in listed} == {'chat', 'theme', 'draft', 'review', 'consult'}
    assert all(set(r) == {'id', 'revision', 'skill', 'web', 'readonly', 'configurable', 'base', 'extra'} for r in listed)
    page.goto(srv.url)
    page.get_by_role('link', name='担当ごとのプロンプトを見る・追加指示を書く').click()
    page.wait_for_url('**/agents')
    expect(page.locator('.agent-native')).to_contain_text(ROLES['chat'].skill)
    assert page.locator('.agents-nav button').count() == 5
    assert page.locator('[data-role="html"]').count() == 0
    for role in ROLES:
        page.locator(f'[data-role="{role}"]').click()
        expect(page.locator('.agent-native')).to_contain_text('AGENTS.md')
        expect(page.locator('.agent-native')).to_contain_text('AI 本体の道具')
        # 必須の指示（AGENTS.md と skill）は中身を見せるが、書き換える欄は追加指示だけ
        if ROLES[role].skill:
            expect(page.locator('.agent-native')).to_contain_text(ROLES[role].skill)
            expect(page.locator('.agent-base code')).to_have_text(['AGENTS.md', f'.agents/skills/{ROLES[role].skill}/SKILL.md'])
            expect(page.locator('.agent-base .agent-prompt').nth(1)).to_contain_text(f'name: {ROLES[role].skill}')
        else:  # 相談役は skill を持たない
            expect(page.locator('.agent-base code')).to_have_text(['AGENTS.md'])
        assert page.locator('.agent-base [contenteditable], .agent-base textarea, .agent-base input').count() == 0
        assert page.locator('textarea.agent-extra').count() == 1
        if role == 'review':
            expect(page.locator('.agent-native')).to_contain_text('読むだけ（ファイルは変えない）')
            expect(page.locator('.agent-heading h2')).to_have_text('確認')
        elif role == 'consult':
            expect(page.locator('.agent-native')).to_contain_text('読むだけ（ファイルは変えない）')
            expect(page.locator('.agent-heading h2')).to_have_text('相談役')
        else:
            expect(page.locator('.agent-native')).not_to_contain_text('読むだけ')
        assert page.locator('input, select, .ai-mbtn, .agent-setting').count() == 0
    # テーマ編集の追加指示を書くと保存され、ほかの担当には付かない。開き直しても残る
    page.locator('[data-role="theme"]').click()
    page.locator('.agent-extra').fill('見出しの色は変えない')
    expect(page.locator('.agent-extra-status')).to_have_text('保存しました')
    assert roles.extra(ws, 'theme') == '見出しの色は変えない' and roles.extra(ws, 'chat') == ''
    page.locator('[data-role="chat"]').click()
    expect(page.locator('.agent-extra')).to_have_value('')
    page.reload()
    page.locator('[data-role="theme"]').click()
    expect(page.locator('.agent-extra')).to_have_value('見出しの色は変えない')
    # 担当を移る前に保存を待たずに移っても、書いた分は残る
    page.locator('.agent-extra').fill('')
    page.locator('[data-role="review"]').click()
    for _ in range(50):
        if roles.extra(ws, 'theme') == '':
            break
        page.wait_for_timeout(100)
    assert roles.extra(ws, 'theme') == ''
    for control in page.locator('.agents-home button, .agents-home a').all():
        assert control.inner_text().strip() == ''
        assert control.get_attribute('data-tip')
        assert control.locator('svg').count() == 1
    page.locator('[data-role="chat"]').click()
    assert page.locator('input, select, .ai-mbtn, .agent-setting').count() == 0
    page.screenshot(path='/tmp/slide-studio-agents-light.png', full_page=True)
    page.emulate_media(color_scheme='dark')
    page.screenshot(path='/tmp/slide-studio-agents-dark.png', full_page=True)
    page.locator('[data-role="review"]').click()
    expect(page.locator('.agent-native')).to_be_visible()
    page.screenshot(path='/tmp/slide-studio-agents-review.png', full_page=True)
    page.get_by_role('link', name='ホーム', exact=True).click()
    page.wait_for_url(srv.url + '/')
    page.go_back()
    page.wait_for_url('**/agents')
    assert not page.errors
