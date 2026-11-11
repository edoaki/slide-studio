"""未送信の対象を選び直す画面と、プレビューの図の step。"""
import re

from e2e.conftest import open_deck
from e2e.test_chat import fake_codex, go_slide
from playwright.sync_api import expect
from slide_studio import figures
from slide_studio.fsutil import sha256_text, write_atomic


def test_figure_selection_survives_chat_clicks_until_page_operation(gui, page):
    ws, srv = gui
    figures.new_figure(ws, 'box', ws.shelf_dir('test'))
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('まとめの段落。', 'まとめの段落。\n\n{{< fig test/box height=200 >}}'))
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    go_slide(page, 4)
    figure = page.frame_locator('#slideBox iframe:not(.loading)').locator('[data-slide-studio="p4/1"]').first
    figure.click()
    page.locator('.chat-input').click()
    page.locator('.chat-input').fill('図の色を変えて')
    expect(page.locator('.chat-tlabel')).to_have_text('図 box')
    expect(figure).to_have_class(re.compile(r'\bslide-studio-selected\b'))
    page.locator('[data-act=page]').click()
    expect(page.locator('.chat-tlabel')).to_have_text('p5 まとめ')
    page.locator('[data-act=page]').click()
    expect(page.locator('.chat-tlabel')).to_have_text('図 box')
    page.locator('#viewport').click(position={'x': 12, 'y': 12})
    expect(page.locator('.chat-tlabel')).to_have_text('図 box')
    page.frame_locator('#slideBox iframe:not(.loading)').locator('[data-slide-studio="p4/0"]').first.click()
    expect(page.locator('.chat-tlabel')).to_have_text('図 box')
    expect(page.locator('.chat-input')).to_have_value('図の色を変えて')
    page.locator('[data-act=page]').click()
    expect(page.locator('.chat-tlabel')).to_have_text('p5 まとめ')
    page.locator('[data-act=page]').click()
    expect(page.locator('.chat-tlabel')).to_have_text('図 box')
    captured = []

    def capture(route):
        captured.append(route.request.post_data_json)
        route.fulfill(status=400, json={'error': '送信内容を検証'})

    page.route('**/chat/tabs/*/send', capture)
    page.locator('.chat-send').click()
    page.wait_for_function("document.querySelector('.chat-send').disabled === false")
    assert captured[0]['items'] == [{'key': 'fig:test/box', 'label': '図 box', 'text': '図の色を変えて'}]
    expect(page.locator('.chat-tlabel')).to_have_text('図 box')
    page.locator('#viewport').click(position={'x': 12, 'y': 12})
    expect(page.locator('.chat-tlabel')).to_have_text('図 box')
    figure.click()
    go_slide(page, 2)
    expect(page.locator('.chat-tlabel')).to_have_text('p3 一枚目')
    expect(page.frame_locator('#slideBox iframe:not(.loading)').locator('.slide-studio-selected')).to_have_count(0)
    go_slide(page, 4)
    expect(page.locator('.chat-tlabel')).to_have_text('p5 まとめ')
    assert not page.errors


def test_anonymous_draft_requires_reselection_after_insertion(gui, page):
    ws, srv = gui
    text = ws.qmd("talk").read_text().replace("## 一枚目 {#one}", "## 一枚目")
    write_atomic(ws.qmd("talk"), text)
    open_deck(page, srv, raw=False)
    page.wait_for_selector(".chat-input:not([disabled])")
    go_slide(page, 2)
    page.fill(".chat-input", "元の一枚目への指示")
    page.wait_for_timeout(650)
    page.reload()
    page.wait_for_selector('.chat-input:not([disabled])')
    page.locator('.chat-actions > [data-act=hist]').click()
    page.locator('.chat-hrow', has_text='元の一枚目への指示').click()
    page.wait_for_selector(".chat-draft")
    changed = text.replace("## 一枚目", "## 追加\n\n本文。\n\n## 一枚目")
    response = page.request.put(f"{srv.url}/api/deck/talk/source", data={"text": changed, "base": sha256_text(text)})
    assert response.ok
    page.wait_for_function("[...document.querySelectorAll('#pagestrip .t')].some(e => e.textContent === '追加')")
    page.locator('.chat-send').click()
    dialog = page.get_by_role('dialog', name='未送信の指示の対象を選び直す')
    dialog.wait_for()
    assert '元の一枚目への指示' in dialog.inner_text()
    assert not page.request.get(f"{srv.url}/api/deck/talk/chat").json()['rounds']
    dialog.get_by_role('button', name='p4 一枚目 への指示にする', exact=True).click()
    assert page.input_value('.chat-input') == '元の一枚目への指示'
    captured = []
    def capture(route):
        captured.append(route.request.post_data_json)
        route.fulfill(status=400, json={'error': '送信内容を検証'})
    page.route('**/chat/tabs/*/send', capture)
    page.locator('.chat-send').click()
    page.wait_for_function("document.querySelector('.chat-send').disabled === false")
    assert captured[0]['items'] == [{'key': '@3', 'label': 'p4 一枚目', 'text': '元の一枚目への指示', 'page_title': '一枚目'}]
    assert not page.errors


def test_legacy_anonymous_draft_kept_until_reselected(gui, page):
    ws, srv = gui
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('## 一枚目 {#one}', '## 一枚目'))
    state = page.request.get(f'{srv.url}/api/deck/talk/chat').json()
    tab = state['tabs'][0]['id']
    page.request.patch(f'{srv.url}/api/deck/talk/chat/tabs/{tab}', data={'drafts': {'@2': '古い形式の指示'}})
    open_deck(page, srv, raw=False)
    page.locator('.chat-actions > [data-act=hist]').click()
    page.locator('.chat-hrow', has_text='古い形式の指示').click()
    page.wait_for_selector('.chat-draft')
    page.locator('.chat-draft .pick').click()
    dialog = page.get_by_role('dialog', name='未送信の指示の対象を選び直す')
    assert '古い形式の指示' in dialog.inner_text()
    dialog.get_by_role('button', name='p3 一枚目 への指示にする', exact=True).click()
    assert page.input_value('.chat-input') == '古い形式の指示'
    page.wait_for_timeout(650)
    saved = page.request.get(f'{srv.url}/api/deck/talk/chat').json()['tabs'][0]['drafts']
    assert saved['@2'] == {'text': '古い形式の指示', 'page_title': '一枚目'}
    assert not page.errors


def test_selected_figure_step_is_sent_and_drafts_stay_per_figure(gui, page):
    ws, srv = gui
    figures.new_figure(ws, 'box', ws.shelf_dir('test'))
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('まとめの段落。', 'まとめの段落。\n\n{{< fig test/box height=200 >}}'))
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    go_slide(page, 4)
    page.frame_locator('#slideBox iframe:not(.loading)').locator('[data-slide-studio="p4/1"]').first.click()
    assert page.locator('.chat-tlabel').inner_text() == '図 box'
    page.fill('.chat-input', '色を変えて')
    page.locator('#stepNext').click()
    assert page.locator('.chat-tlabel').inner_text() == '図 box'
    page.locator('[data-act=step]').click()
    page.wait_for_function("document.querySelector('.chat-tlabel').textContent.includes('step 2/3「処理を表示」')")
    page.locator('[data-act=step]').click()
    assert page.locator('.chat-tlabel').inner_text() == '図 box'
    page.locator('[data-act=step]').click()
    assert page.input_value('.chat-input') == '色を変えて'
    assert page.locator('.chat-draft').count() == 1
    page.locator('#viewport').click(position={'x': 12, 'y': 12})
    expect(page.locator('.chat-tlabel')).to_contain_text('図 box · step 2/3')
    page.locator('#stepPrev').click()
    page.wait_for_function("document.querySelector('.chat-tlabel').textContent.includes('step 1/3「入力を表示」')")
    page.locator('#stepNext').click()
    page.locator('.chat-send').click()
    page.wait_for_selector('.chat-round')
    page.locator('#stepNext').click()
    page.wait_for_function("document.querySelector('.chat-tlabel').textContent.includes('step 3/3「結果を表示」')")
    state = page.request.get(f'{srv.url}/api/deck/talk/chat').json()
    item = state['rounds'][0]['items'][0]
    assert item['key'] == 'fig:test/box'
    assert item['step'] == {'index': 1, 'count': 3, 'title': '処理を表示'}
    assert item['label'] == '図 box · step 2/3「処理を表示」'
    assert 'step 2/3「処理を表示」' in page.locator('.chat-round .chat-sent .chat-chip').get_attribute('data-tip')
    page.wait_for_selector('.chat-round .chat-files', timeout=30000)
    assert not page.errors


def test_figure_navigation_does_not_limit_sent_instruction_to_step(gui, page):
    ws, srv = gui
    figures.new_figure(ws, 'box', ws.shelf_dir('test'))
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('まとめの段落。', 'まとめの段落。\n\n{{< fig test/box height=200 >}}'))
    open_deck(page, srv, raw=False)
    page.wait_for_selector('.chat-input:not([disabled])')
    go_slide(page, 4)
    page.frame_locator('#slideBox iframe:not(.loading)').locator('[data-slide-studio="p4/1"]').first.click()
    page.locator('#stepNext').click()
    page.fill('.chat-input', '図全体の色を変えて')
    captured = []

    def capture(route):
        captured.append(route.request.post_data_json)
        route.fulfill(status=400, json={'error': '送信内容を検証'})

    page.route('**/chat/tabs/*/send', capture)
    page.locator('.chat-send').click()
    page.wait_for_function("document.querySelector('.chat-send').disabled === false")
    assert captured[0]['items'] == [{'key': 'fig:test/box', 'label': '図 box', 'text': '図全体の色を変えて'}]
    assert not page.errors
