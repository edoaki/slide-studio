import datetime
import os
from pathlib import Path

from playwright.sync_api import expect

from slide_studio import figures
from slide_studio.fsutil import write_atomic


def test_choose_existing_and_new_topic(page, gui):
    ws, srv = gui
    ws.shelf_dir('nco').mkdir(parents=True)
    ws.shelf_dir('test').mkdir(parents=True, exist_ok=True)
    page.goto(srv.url)
    page.get_by_role('button', name='新しい発表', exact=True).click()
    expect(page.locator('select[name=shelf]')).to_have_value('test')
    # フォルダ名は「作った日-トピック」が入っていて、トピックを変えると付け直す
    today = datetime.date.today().isoformat()
    expect(page.get_by_label('フォルダ名', exact=True)).to_have_value(f'{today}-test')
    page.locator('select[name=shelf]').select_option('nco')
    expect(page.get_by_label('フォルダ名', exact=True)).to_have_value(f'{today}-nco')
    page.get_by_label('フォルダ名', exact=True).fill('nco-talk')
    page.get_by_role('button', name='作る', exact=True).click()
    expect(page).to_have_url(srv.url + '/deck/nco-talk')
    assert ws.deck_shelf('nco-talk') == 'nco'
    # 作ったままの発表があると［新しい発表］を出さないので、手を入れておく
    ws.qmd('nco-talk').write_text(ws.qmd('nco-talk').read_text() + '\n## 追加\n')
    page.goto(srv.url)
    page.get_by_role('button', name='新しい発表', exact=True).click()
    expect(page.locator('select[name=shelf]')).to_have_value('nco')
    page.locator('select[name=shelf]').select_option('')
    page.get_by_label('トピック名（英小文字・数字・ハイフン）', exact=True).fill('fresh')
    # 書き換えずに作ると、入っていたフォルダ名になる
    page.get_by_role('button', name='作る', exact=True).click()
    expect(page).to_have_url(srv.url + f'/deck/{today}-fresh')
    assert ws.deck_shelf(f'{today}-fresh') == 'fresh'
    assert not page.errors


def test_no_topics(page, gui):
    ws, srv = gui
    import shutil
    shutil.rmtree(ws.topics)
    ws.topics.mkdir()
    assert not ws.shelves()
    page.goto(srv.url)
    page.get_by_role('button', name='新しい発表', exact=True).click()
    expect(page.locator('select[name=shelf]')).to_be_hidden()
    page.get_by_label('トピック名（英小文字・数字・ハイフン）', exact=True).fill('first')
    page.get_by_label('フォルダ名', exact=True).fill('first-talk')
    page.get_by_role('button', name='作る', exact=True).click()
    expect(page).to_have_url(srv.url + '/deck/first-talk')
    assert ws.deck_shelf('first-talk') == 'first'


def test_topic_navigation_and_initial_value(page, gui):
    ws, srv = gui
    figures.new_figure(ws, 'chart', ws.shelf_dir('test'))
    page.goto(srv.url)
    page.locator('.lib').filter(has_text='test').click()
    expect(page).to_have_url(srv.url + '/topic/test')
    expect(page.locator('.topic-html iframe').first).to_have_attribute('src', '/files/topics/test/html/chart/index.html')
    page.get_by_role('button', name='このトピックのスライドを作る').click()
    expect(page.locator('select[name=shelf]')).to_have_value('test')
    page.get_by_role('button', name='やめる', exact=True).click()
    page.reload()
    page.locator('.card').filter(has_text='テスト発表').click()
    expect(page).to_have_url(srv.url + '/deck/talk')
    assert not page.errors


def test_topic_html_rows_and_bib(page, gui):
    ws, srv = gui
    base = ws.shelf_dir('test')
    for n in range(14):
        write_atomic(base / f'page-{n:02}.html', f'<p>{n}</p>')
    write_atomic(ws.topic_dir('test') / 'reference.bib', """@article{beta2021, author = {Beta, B. and Gamma, G.}, title = {Second paper}, journal = {J}, year = {2021}, doi = {10.1/x}}
@inproceedings{alpha2019, author = {Alpha, A.}, title = {First paper}, booktitle = {Conf}, year = {2019}, abstract = {Short summary.}}
""")
    ws.qmd('talk').write_text(ws.qmd('talk').read_text() + '\n## 引用\n\n[@beta2021]\n')
    page.set_viewport_size({'width': 1280, 'height': 900})
    page.goto(srv.url + '/topic/test')
    html = page.locator('.topic-html')
    expect(html.locator('.card')).to_have_count(14)
    # 1280px では4列 × 3段に入りきらないので、3段のまま横にスクロールする
    expect(html).to_have_class('topic-html scroll')
    tops = html.locator('.card').evaluate_all('(cs) => new Set(cs.map(c => Math.round(c.getBoundingClientRect().top))).size')
    assert tops == 3
    assert html.evaluate('(e) => e.scrollWidth > e.clientWidth')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.set_viewport_size({'width': 2000, 'height': 900})
    expect(html).to_have_class('topic-html')
    # 文献：題名の順に並び、押すと詳細が出る
    rows = page.locator('.bib-list tbody tr')
    expect(rows).to_have_count(2)
    expect(rows.first).to_contain_text('First paper')
    expect(page.locator('.bib-detail h3')).to_have_text('First paper')
    expect(page.locator('.bib-detail')).to_contain_text('Short summary.')
    expect(page.locator('.bib-detail')).to_contain_text('どの発表も引用していません')
    rows.nth(1).click()
    expect(page.locator('.bib-detail h3')).to_have_text('Second paper')
    expect(page.locator('.bib-detail a[href="https://doi.org/10.1/x"]')).to_be_visible()
    expect(page.locator('.bib-detail .bd-decks')).to_contain_text('テスト発表')
    expect(rows.nth(1).locator('.c-creator')).to_have_text('Beta・Gamma')
    page.keyboard.press('ArrowUp')
    expect(page.locator('.bib-detail h3')).to_have_text('First paper')
    page.locator('.bib-list th.c-year button').click()
    page.locator('.bib-list th.c-year button').click()
    expect(rows.first).to_contain_text('Second paper')
    page.get_by_label('文献を探す（題名・著者・年・キー）').fill('alpha')
    expect(rows).to_have_count(1)
    assert not page.errors


def test_home_card_sizes(page, gui, tmp_path):
    ws, srv = gui
    for n in range(3):
        ws.new_deck(f'talk-{n}', 'test', title=f'研究発表 {n + 1}')
    page.goto(srv.url)
    expect(page.locator('.cards .card')).to_have_count(4)
    output = Path(os.environ.get('SLIDE_STUDIO_SHOTS', tmp_path))
    for width, height, columns in ((1440, 900, 5), (1280, 800, 4), (900, 800, 3), (390, 844, 1)):
        page.set_viewport_size({'width': width, 'height': height})
        assert page.locator('.cards').evaluate('(e) => getComputedStyle(e).gridTemplateColumns.split(" ").length') == columns
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(output / f'home-{width}x{height}.png'), full_page=True)


def test_add_buttons_hide_while_untouched(page, gui):
    ws, srv = gui
    page.goto(srv.url)
    add = lambda name: page.locator('.sec-head').get_by_role('button', name=name, exact=True)
    expect(add('新しい発表')).to_be_visible()
    add('新しいトピック').click()
    page.get_by_label('トピック名（英小文字・数字・ハイフン）', exact=True).fill('empty')
    page.get_by_role('button', name='作る', exact=True).click()
    expect(page.locator('.lib').filter(has_text='empty')).to_be_visible()
    assert ws.topic_dir('empty').is_dir()
    expect(add('新しいトピック')).to_be_hidden()
    # テーマは［＋］から作らない（編集画面のテーマのタブで、直したものを登録する）
    expect(page.locator('.sec-head').get_by_role('button', name='新しいテーマ', exact=True)).to_have_count(0)
    ws.new_deck('blank-talk', 'empty')
    page.reload()
    expect(page.locator('.deck-card-wrap[data-deck="blank-talk"]')).to_be_visible()
    expect(add('新しい発表')).to_be_hidden()
    # 手を入れると［＋］が戻る（トピックは発表が使い始めたので戻る）
    ws.qmd('blank-talk').write_text(ws.qmd('blank-talk').read_text() + '\n## 追加\n')
    page.reload()
    expect(page.locator('.deck-card-wrap[data-deck="blank-talk"]')).to_be_visible()
    expect(add('新しい発表')).to_be_visible()
    expect(add('新しいトピック')).to_be_visible()
    assert page.locator('.theme-cards').evaluate('(e) => getComputedStyle(e).flexWrap') == 'nowrap'
    assert not page.errors


def test_remove_theme_from_home(page, gui):
    ws, srv = gui
    page.goto(srv.url)
    card = lambda n: page.locator('.theme-cards .theme-card').filter(has=page.locator(f'[data-theme={n}]'))
    # 使っている発表があるテーマ・default には出さない
    expect(card('default').locator('.theme-remove')).to_have_count(0)
    card('terracotta').hover()
    card('terracotta').get_by_role('button', name='「terracotta」を一覧から削除', exact=True).click()
    page.get_by_role('dialog', name='テーマを削除', exact=True).get_by_role('button', name='「terracotta」を一覧から削除', exact=True).click()
    expect(page.locator('.theme-cards [data-theme=terracotta]')).to_have_count(0)
    assert 'terracotta' not in ws.themes_list()
    assert not page.errors


def test_dialog_initial_values(page, gui):
    _, srv = gui
    page.goto(srv.url)
    expect(page.get_by_role('button', name='新しい発表', exact=True)).to_be_visible()
    for prefs, recent, extra, expected in (
        ({'shelf': 'old'}, [{'shelf': 'nco'}], {}, 'nco'),
        ({'shelf': 'test'}, [{'shelf': 'nco'}], {}, 'test'),
        ({}, [], {}, 'test'),
        ({'shelf': 'test', 'theme': 'default'}, [], {'shelf': 'nco', 'theme': 'alternate'}, 'nco'),
    ):
        page.evaluate('''async ({prefs, recent, extra}) => {
          const {newDeckDialog} = await import('/web/home.js');
          newDeckDialog({prefs, recent, shelves: [{name: 'test'}, {name: 'nco'}], themes: ['default', 'alternate']}, extra);
        }''', {'prefs': prefs, 'recent': recent, 'extra': extra})
        expect(page.locator('select[name=shelf]')).to_have_value(expected)
        if extra:
            expect(page.locator('[name=theme]')).to_have_value('alternate')
        expect(page.locator('input[name=newShelf]')).to_be_disabled()
        page.get_by_role('button', name='やめる', exact=True).click()


def test_delete_unused_topic(page, gui):
    ws, srv = gui
    ws.new_topic('unused')
    page.goto(srv.url + '/topic/unused')
    page.get_by_role('button', name='トピックを削除', exact=True).click()
    dialog = page.get_by_role('dialog', name='トピックを削除', exact=True)
    dialog.get_by_role('button', name='やめる', exact=True).click()
    assert ws.topic_dir('unused').is_dir()
    page.get_by_role('button', name='トピックを削除', exact=True).click()
    dialog.get_by_role('button', name='トピックを削除', exact=True).click()
    expect(page).to_have_url(srv.url + '/')
    expect(page.locator('.lib').filter(has_text='unused')).to_have_count(0)
    assert not ws.topic_dir('unused').exists()
    assert list((ws.state / 'trash/topics').glob('unused-*'))
    assert not page.errors


def test_delete_used_topic_shows_reason(page, gui):
    ws, srv = gui
    page.goto(srv.url + '/topic/test')
    page.get_by_role('button', name='トピックを削除', exact=True).click()
    dialog = page.get_by_role('dialog', name='トピックを削除', exact=True)
    dialog.get_by_role('button', name='トピックを削除', exact=True).click()
    expect(dialog.get_by_role('alert')).to_contain_text('このトピックを使用している発表があります')
    assert ws.topic_dir('test').is_dir()
    assert ws.qmd('talk').is_file()
    assert not page.errors


def test_topic_steps_selection_and_delete(page, gui):
    ws, srv = gui
    figures.new_figure(ws, 'chart', ws.shelf_dir('test'))
    write_atomic(ws.shelf_dir('test') / 'unused.html', '<p>Unused</p>')
    ws.qmd('talk').write_text(ws.qmd('talk').read_text() + '\n{{< fig test/chart >}}\n')
    page.goto(srv.url + '/topic/test')
    chart = page.locator('.topic-html .card').filter(has_text='chart')
    expect(chart).to_contain_text('使用中')
    expect(chart.locator('.topic-step')).to_have_count(3)
    for step in range(3):
        frame = chart.locator('iframe').nth(step)
        frame.scroll_into_view_if_needed()
        expect(frame).to_have_attribute('src', '/files/topics/test/html/chart/index.html')
        page.wait_for_function('(k) => document.querySelectorAll(".topic-html iframe")[k]?.contentWindow.animation?.step === k', arg=step)
    expect(chart).not_to_contain_text('段')
    page.get_by_role('button', name='選択', exact=True).click()
    page.get_by_role('checkbox', name='「chart」を選択', exact=True).check()
    page.get_by_role('checkbox', name='「unused.html」を選択', exact=True).check()
    page.get_by_role('button', name='選択した HTML を削除', exact=True).click()
    modal = page.get_by_role('dialog')
    modal.get_by_role('button', name='選択した HTML を削除', exact=True).click()
    expect(modal.get_by_role('alert')).to_contain_text('使用中')
    assert (ws.shelf_dir('test') / 'unused.html').exists()
    modal.get_by_role('button', name='やめる', exact=True).click()
    page.get_by_role('checkbox', name='「chart」を選択', exact=True).uncheck()
    page.get_by_role('button', name='選択した HTML を削除', exact=True).click()
    modal.get_by_role('button', name='選択した HTML を削除', exact=True).click()
    expect(page.locator('.topic-html .card')).to_have_count(1)
    assert not (ws.shelf_dir('test') / 'unused.html').exists()
    assert not page.errors


def test_topic_preview_steps_and_long_press(page, gui):
    ws, srv = gui
    figures.new_figure(ws, 'chart', ws.shelf_dir('test'))
    write_atomic(ws.shelf_dir('test') / 'unused.html', '<p>Unused</p>')
    page.goto(srv.url + '/topic/test')
    card = page.locator('.topic-html .card').filter(has_text='chart')
    expect(card.locator('input')).to_be_hidden()
    expect(card.locator('a')).to_have_count(0)
    card.locator('.name').click()
    preview = page.get_by_role('dialog', name='素材のプレビュー')
    expect(preview).to_be_visible()
    expect(preview.locator('.as-preview-hint')).to_contain_text('左側を長押しで最初へ')
    page.wait_for_function('document.querySelector(".as-preview iframe")?.contentWindow.animation?.step === 0')
    next_step = preview.get_by_role('button', name='次のステップ')
    back = preview.get_by_role('button', name='前のステップ')
    def step_is(k):
        page.wait_for_function('(k) => document.querySelector(".as-preview iframe").contentWindow.animation.step === k', arg=k)
    next_step.click()
    step_is(1)
    next_step.click()
    step_is(2)
    next_step.click()
    step_is(2)
    back.click()
    step_is(1)
    next_step.click()
    back.click(delay=650)
    step_is(0)
    page.keyboard.press('Escape')
    expect(preview).to_have_count(0)
    card.locator('.name').click(delay=650)
    expect(preview).to_have_count(0)
    expect(card.locator('input')).to_be_checked()
    other = page.locator('.topic-html .card').filter(has_text='unused.html')
    other.locator('.name').click()
    expect(other.locator('input')).to_be_checked()
    page.get_by_role('button', name='選ぶのをやめる', exact=True).click()
    expect(card.locator('input')).to_be_hidden()
    assert not page.errors
