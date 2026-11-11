import pytest
from playwright.sync_api import expect

from slide_studio import check, render
from slide_studio.fsutil import write_atomic


@pytest.mark.parametrize('field', ['year', 'date'])
def test_edit_bibliography_year_and_cancel(gui, page, field):
    from e2e.conftest import open_deck
    from slide_studio.bibliography import listing

    ws, srv = gui
    label = '年' if field == 'year' else '日付'
    initial = '2020' if field == 'year' else '2020-05-01'
    write_atomic(ws.bib('talk'), '@article{paper, title={{DNA} paper}, author={Doe, Jane}, ' + field + '={' + initial + '}}')
    for location, year in (('editor', '2024'), ('topic', '2025')):
        if location == 'editor':
            open_deck(page, srv, raw=False)
            page.get_by_role('tab', name='文献', exact=True).click()
        else:
            page.goto(f'{srv.url}/topic/test')
        detail = page.locator('.bib-detail')
        detail.get_by_role('button', name='文献情報を編集').click()
        assert not page.errors
        expect(detail.locator('.bib-edit')).to_be_visible()
        value = year if field == 'year' else year + '-05-01'
        detail.get_by_label(label, exact=True).fill(value)
        detail.get_by_role('button', name='保存', exact=True).click()
        expect(detail.get_by_role('button', name='文献情報を編集')).to_be_visible()
        expect(page.locator('tbody .c-year')).to_have_text(year)
        assert listing(ws.bib('talk'))[0]['fields'][field] == value
        assert 'title={{DNA} paper}' in ws.bib('talk').read_text()
        detail.get_by_role('button', name='文献情報を編集').click()
        detail.get_by_label(label, exact=True).fill('1900')
        detail.get_by_role('button', name='キャンセル').click()
        expect(page.locator('tbody .c-year')).to_have_text(year)
        assert listing(ws.bib('talk'))[0]['fields'][field] == value
    page.reload()
    expect(page.locator('tbody .c-year')).to_have_text('2025')
    assert not page.errors


def test_bibliography_edit_form_shows_whole_text(gui, page):
    import os
    from e2e.conftest import open_deck

    ws, srv = gui
    write_atomic(ws.bib('talk'), '@inproceedings{parco, title={{PARCO}: Parallel {AutoRegressive} models for multi-agent combinatorial optimization}, '
                 'author={Berto, Federico and Hua, Chuanbo and Luttmann, Laurin and Son, Jiwoo and Park, Junyoung}, year={2025}, '
                 'booktitle={Advances in Neural Information Processing Systems}, doi={10.0000/example}, url={https://example.com/a/very/long/path/to/the/paper}}')
    shots = os.environ.get('BIB_SHOTS')
    for location in ('editor', 'topic'):
        if location == 'editor':
            open_deck(page, srv, raw=False)
            page.get_by_role('tab', name='文献', exact=True).click()
        else:
            page.goto(f'{srv.url}/topic/test')
        detail = page.locator('.bib-detail')
        detail.get_by_role('button', name='文献情報を編集').click()
        expect(detail.locator('.bib-edit')).to_be_visible()
        if location == 'editor':
            expect(page.locator('.bib-list')).to_be_hidden()
        expect(detail.get_by_label('掲載誌', exact=True)).to_have_count(0)
        # どの欄も中身が隠れていない
        hidden = detail.locator('textarea').evaluate_all('els => els.filter(t => t.scrollHeight > t.clientHeight + 1).map(t => t.name)')
        assert hidden == []
        # 保存・キャンセルは詳細の下端にあり、欄と重ならない
        actions, fields = detail.locator('.bib-edit-actions').bounding_box(), detail.locator('.bib-edit-fields').bounding_box()
        box = detail.bounding_box()
        assert abs(actions['y'] + actions['height'] - (box['y'] + box['height'])) < 2
        assert fields['y'] + fields['height'] <= actions['y'] + 1
        if shots:
            page.screenshot(path=f'{shots}/bib-edit-{location}.png')
        title = detail.get_by_label('タイトル', exact=True)
        before = title.bounding_box()['height']
        title.fill('Short')
        assert title.bounding_box()['height'] < before
        detail.get_by_role('button', name='キャンセル').click()
        expect(page.locator('.bib-list')).to_be_visible()
    assert not page.errors


def test_bibliography_height_resize(gui, page):
    ws, srv = gui
    write_atomic(ws.bib('talk'), '\n'.join(
        f'@article{{paper{i}, title={{Paper {i}}}, author={{Doe, Jane}}, abstract={{' + 'Abstract. ' * 100 + '}}'
        for i in range(30)
    ))
    for location in ('editor', 'topic'):
        if location == 'editor':
            from e2e.conftest import open_deck
            open_deck(page, srv, raw=False)
            page.get_by_role('tab', name='文献', exact=True).click()
        else:
            page.goto(f'{srv.url}/topic/test')
            expect(page.locator('.bib-resize')).to_be_hidden()
            page.set_viewport_size({'width': 800, 'height': 900})
        grip = page.get_by_role('separator', name='一覧と詳細の高さ')
        expect(grip).to_be_visible()
        listing, detail = page.locator('.bib-list'), page.locator('.bib-detail')
        before = listing.bounding_box()['height']
        assert before > detail.bounding_box()['height'] * 1.5
        grip.scroll_into_view_if_needed()
        box = grip.bounding_box()
        page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        page.mouse.down()
        page.mouse.move(box['x'] + box['width'] / 2, box['y'] - 80, steps=5)
        page.mouse.up()
        assert listing.bounding_box()['height'] < before - 60
        after_drag = listing.bounding_box()['height']
        grip.press('ArrowDown')
        assert listing.bounding_box()['height'] > after_drag + 10
        for key in ('ArrowUp', 'ArrowDown'):
            for _ in range(25):
                grip.press(key)
            assert listing.bounding_box()['height'] >= 79
            assert detail.bounding_box()['height'] >= 79
        assert listing.evaluate('e => e.scrollHeight > e.clientHeight')
        assert detail.evaluate('e => e.scrollHeight > e.clientHeight')
    assert not page.errors


def test_deck_bibliography_and_warning_navigation(gui, page):
    ws, srv = gui
    write_atomic(ws.bib('talk'), """@article{used, title={Used paper}, author={Smith, Jane}, year={2025}, slide-studio-status={unverified}}
@article{unused, title={Unused paper}, year={2024}}
""")
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('最初の段落。', '最初の段落。 [@used]'))
    rendered = render.render_deck(ws, 'talk')
    warnings = [x for x in check.static_issues(ws, 'talk', rendered) if x['kind'] == 'unverified']
    assert warnings[0]['citation_key'] == 'used'
    result = {'version': check.deck_version(ws, 'talk'), 'errors': [], 'warnings': warnings}
    page.route('**/api/deck/talk/checks', lambda r: r.fulfill(json={'busy': False, 'stale': False, 'result': result}))
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    page.locator('#status').click()
    page.locator('.issue-link').click()
    sec = page.locator('.editor-bib')
    expect(sec).to_be_visible()
    expect(sec.locator('.bib-detail h3')).to_have_text('Used paper')
    expect(sec.locator('[data-page]')).to_have_count(1)
    sec.locator('[data-page]').click()
    expect(page.locator('#pagestrip [data-index="2"]')).to_have_attribute('aria-current', 'true')
    sec.locator('input').fill('')
    expect(sec.locator('tbody tr')).to_have_count(2)
    expect(sec.locator('tr[data-key="used"] .c-used svg')).to_have_count(1)
    expect(sec.locator('tr[data-key="unused"] .c-used svg')).to_have_count(0)
    expect(sec.locator('[data-filter="all"]')).to_have_attribute('aria-pressed', 'true')
    sec.locator('[data-filter="used"]').click()
    expect(sec.locator('[data-filter="used"]')).to_have_attribute('aria-pressed', 'true')
    expect(sec.locator('tbody tr')).to_have_count(1)
    sec.locator('[data-filter="unused"]').click()
    expect(sec.locator('tbody tr')).to_have_count(1)
    expect(sec.locator('tr[data-key="unused"]')).to_have_count(1)
    page.locator('[role=tab][data-tab=qmd]').click()
    page.keyboard.press('6')
    expect(sec).to_be_visible()
    assert not page.errors


def test_verify_from_home_and_editor(gui, page):
    from e2e.conftest import open_deck
    from slide_studio.check import unverified_keys

    ws, srv = gui
    for location in ('home', 'editor'):
        write_atomic(ws.bib('talk'), '@article{pending, title={Paper}, author={Doe}, year={2025}, slide-studio-status={unverified}}')
        if location == 'home':
            page.goto(f'{srv.url}/topic/test')
        else:
            open_deck(page, srv, raw=False)
            page.get_by_role('tab', name='文献', exact=True).click()
        button = page.get_by_role('button', name='確認済みにする', exact=True)
        expect(button).to_be_visible()
        button.click()
        expect(button).to_have_count(0)
        expect(page.locator('.bib-detail .u')).to_have_count(0)
        assert not unverified_keys(ws.bib('talk'))
        page.reload()
        if location == 'editor':
            page.get_by_role('tab', name='文献', exact=True).click()
        expect(page.locator('.bib-detail h3')).to_have_text('Paper')
        expect(page.locator('.bib-detail .u')).to_have_count(0)
    assert not page.errors
