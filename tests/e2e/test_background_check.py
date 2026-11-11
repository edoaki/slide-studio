"""保存後の検査の状態・帯の印と、問題を残して書き出す操作。"""
import json

from playwright.sync_api import expect

from slide_studio import check


def test_check_status_marker_goes_to_issue_step(gui, page):
    ws, srv = gui
    result = {'version': check.deck_version(ws, 'talk'), 'checked_at': 1,
              'errors': [{'level': 'error', 'slide': 2, 'step': 0, 'message': 'はみ出し', 'rects': [{'x': 30, 'y': 40, 'w': 50, 'h': 60}]}], 'warnings': []}
    page.route('**/api/deck/talk/checks', lambda r: r.fulfill(json={'busy': False, 'stale': False, 'result': result}))
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    expect(page.locator('#status')).to_have_text('検査：エラー 1・警告 0')
    flag = page.locator('#pagestrip [data-index="2"] .check-mark.error')
    expect(flag).to_have_count(1)
    flag.click()
    expect(page.locator('#pagestrip [data-index="2"]')).to_have_attribute('aria-current', 'true')
    # 場所は 1280×720 の座標なので、縮めて置かれたスライド（#stage）の中に描く
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentDocument.querySelector('#stage > .slide-studio-check-box')")


def test_duplicate_attribute_warning_opens_source(gui, page):
    from slide_studio.fsutil import write_atomic
    from slide_studio import render
    ws, srv = gui
    text = ws.qmd('talk').read_text().replace('最初の段落。', '::: {.box style="color:red" style="width:51%;"}\n最初の段落。\n:::')
    write_atomic(ws.qmd('talk'), text)
    rendered = render.render_deck(ws, 'talk')
    issues = render.warning_issues(rendered)
    assert len(issues) == 1
    result = {'version': check.deck_version(ws, 'talk'), 'errors': [], 'warnings': issues}
    page.route('**/api/deck/talk/checks', lambda r: r.fulfill(json={'busy': False, 'stale': False, 'result': result}))
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    warning = page.locator('#qstatus button', has_text='style が重複')
    expect(warning).to_be_visible()
    warning.click()
    expect(page.locator('#qhost')).to_be_visible()
    page.wait_for_function("document.querySelector('#qhost textarea').value.slice(document.querySelector('#qhost textarea').selectionStart).startsWith('style=\"width:51%;\"')")
    expect(page.locator('#pagestrip [data-index="2"]')).to_have_attribute('aria-current', 'true')
    page.locator('#status').click()
    page.locator('.issue-list .issue-link', has_text='style が重複').click()
    expect(page.locator('.dialog-back')).to_have_count(0)
    assert not page.errors


def test_old_check_never_displays_clean(gui, page):
    _, srv = gui
    result = {'version': {'qmd': 'old', 'deps': 'old'}, 'errors': [], 'warnings': []}
    page.route('**/api/deck/talk/checks', lambda r: r.fulfill(json={'busy': False, 'stale': True, 'result': result}))
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    expect(page.locator('#status')).to_have_text('検査が古い')
    expect(page.locator('.check-mark')).to_have_count(0)


def test_export_lists_errors_then_allows_force(gui, page):
    _, srv = gui
    requests = []
    def build(route):
        body = json.loads(route.request.post_data)
        requests.append(body)
        if body.get('force'):
            route.fulfill(json={'files': [{'name': 'talk.html', 'url': '/api/deck/talk/download/html'}]})
        else:
            route.fulfill(json={'blocked': True, 'result': {'errors': [{'kind': 'overflow', 'message': 'はみ出し', 'page_id': 'one', 'step': 0}], 'warnings': []}})
    page.route('**/api/deck/talk/build', build)
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    page.locator('[data-output="build"]').click()
    page.get_by_role('button', name='HTML', exact=True).click()
    expect(page.locator('.output-body')).to_contain_text('はみ出し')
    page.get_by_role('button', name='このまま書き出す', exact=True).click()
    expect(page.locator('.downloads a')).to_have_count(1)
    assert all(r['format'] == 'html' for r in requests)
    assert len(requests) == 2 and requests[1]['force'] is True


def test_check_status_lists_issues_and_goes_to_page(gui, page):
    ws, srv = gui
    result = {'version': check.deck_version(ws, 'talk'), 'checked_at': 1,
              'errors': [{'level': 'error', 'slide': 4, 'step': 0, 'message': 'はみ出し', 'rects': [{'x': 30, 'y': 40, 'w': 50, 'h': 60}]}],
              'warnings': [{'level': 'warning', 'slide': 2, 'step': 0, 'message': '小さい字'}, {'level': 'warning', 'message': 'ページの無い警告'}]}
    page.route('**/api/deck/talk/checks', lambda r: r.fulfill(json={'busy': False, 'stale': False, 'result': result}))
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    status = page.locator('#status')
    expect(status).to_have_text('検査：エラー 1・警告 2')
    # 一覧はエラーを先に、ページの順。ページの無い問題も文として読める
    status.click()
    items = page.locator('.issue-list li')
    expect(items).to_have_count(3)
    expect(items.nth(0)).to_contain_text('はみ出し')
    expect(items.nth(1)).to_contain_text('小さい字')
    expect(items.nth(2)).to_contain_text('ページの無い警告')
    expect(items.nth(2).locator('.issue-link')).to_have_count(0)
    items.nth(0).locator('.issue-link').click()
    expect(page.locator('.dialog-back')).to_have_count(0)
    expect(page.locator('#pagestrip [data-index="4"]')).to_have_attribute('aria-current', 'true')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentDocument.querySelector('.slide-studio-check-box')")
    status.press('Enter')
    page.locator('.issue-list .issue-link', has_text='小さい字').click()
    expect(page.locator('#pagestrip [data-index="2"]')).to_have_attribute('aria-current', 'true')


def test_check_status_opens_list_when_no_issue_has_a_page(gui, page):
    ws, srv = gui
    result = {'version': check.deck_version(ws, 'talk'), 'checked_at': 1,
              'errors': [{'level': 'error', 'kind': 'missing', 'slide': None, 'step': None, 'message': '読み込めない素材: /x.html'}], 'warnings': []}
    page.route('**/api/deck/talk/checks', lambda r: r.fulfill(json={'busy': False, 'stale': False, 'result': result}))
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    page.locator('#status').click()
    expect(page.locator('.issue-list li')).to_have_text('エラー読み込めない素材: /x.html')
    page.keyboard.press('Escape')
    expect(page.locator('.dialog-back')).to_have_count(0)


def test_export_issue_goes_to_its_page(gui, page):
    ws, srv = gui
    version = check.deck_version(ws, 'talk')
    page.route('**/api/deck/talk/build', lambda r: r.fulfill(json={'blocked': True, 'result': {'version': version, 'checked_at': 1,
        'errors': [{'kind': 'overflow', 'message': 'はみ出し', 'page_id': 'summary', 'slide': 4, 'step': 0, 'rects': [{'x': 30, 'y': 40, 'w': 50, 'h': 60}]}], 'warnings': []}}))
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    page.locator('[data-output="build"]').click()
    page.get_by_role('button', name='HTML', exact=True).click()
    page.locator('.output-body .issue-link').click()
    expect(page.locator('.dialog-back')).to_have_count(0)
    expect(page.locator('#pagestrip [data-index="4"]')).to_have_attribute('aria-current', 'true')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentDocument.querySelector('.slide-studio-check-box')")
