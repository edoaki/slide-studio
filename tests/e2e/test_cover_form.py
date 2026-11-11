"""表紙の入力欄（cover-form.js）：タイトル・副題・発表者と所属。原稿の書き方と表紙の表示。"""
import re
import time
import pytest

from playwright.sync_api import expect
from e2e.conftest import open_deck, rendered

FORM = '#qblocks .page.cur .cover-form'

RUN = '''async ([text, script]) => {
  const m = await import('/web/cover-form.js');
  return await (new Function('m', 'text', `return (async () => { ${script} })()`))(m, text);
}'''


def saved(page):
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")


def saved_source(page, text):
    # 設定と表紙は記法表示から隠れるため、保存された原稿で確かめる。
    deadline = time.monotonic() + 10
    while not page.evaluate("async text => (await (await fetch('/api/deck/talk')).json()).text.includes(text)", text):
        if time.monotonic() >= deadline:
            raise AssertionError(f"原稿に保存されませんでした: {text}")
        page.wait_for_timeout(50)
    saved(page)


def cover(page):
    return page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('.slide.cover')?.innerHTML || ''")


def test_rewrites_source(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = '---\ntitle: "旧"\ntopic: t\nauthor:\n  - 誰か\ntheme: default\n---\n\n## 旧 {#cover .cover}\n\n::: {.cover-title}\n旧\n:::\n\n# 章 {#c}\n'
    out = page.evaluate(RUN, [text, r'''
      let t = m.writeTitle(text, '新しい\n題名');
      const titled = t;
      t = m.writeSubtitle(t, '副');
      const sub = t;
      t = m.writeSubtitle(t, '');
      t = m.writeAuthors(t, [{ name: '山田', affiliations: ['東大', '理研'] }, { name: '', affiliations: ['x'] }, { name: '鈴木', affiliations: ['東大'] }]);
      const br = m.readCover(text.replace('旧\n:::', 'A<br>B<br/>C\\\nD\nE\n:::')).title;
      // スライドで付けた書式は欄に出さず、欄で直した所の外は残す
      const styled = text.replace('旧\n:::', '[大きい]{style="font-size: 1.5em"}<br>[色]{.accent}\n:::');
      const kept = [m.readCover(styled).title, m.writeTitle(styled, '大きな\n色'), m.syncTitle(styled.replace('[色]', '[赤]'))];
      return [titled, sub, t, m.readCover(sub), m.writeAuthors(t, []), br, kept,
        m.marks([{ name: 'A', affiliations: ['X'] }, { name: 'B', affiliations: ['Y'] }]),
        m.marks([{ name: 'A', affiliations: ['X'] }, { name: 'B', affiliations: ['X'] }]),
        m.marks([{ name: 'A', affiliations: ['X', 'Y'] }, { name: 'B', affiliations: ['X'] }])];
    '''])
    titled, sub, final, read, cleared, br, kept, each, same, marked = out
    assert br == 'A\nB\nC\nD E'
    assert kept[0] == '大きい\n色'
    assert '::: {.cover-title}\n[大きな]{style="font-size: 1.5em"}<br>[色]{.accent}\n:::' in kept[1] and 'title: "大きな色"' in kept[1]
    assert 'title: "大きい赤"' in kept[2] and '## 大きい赤 {#cover .cover}' in kept[2]
    assert titled == text.replace('title: "旧"', 'title: "新しい題名"').replace('## 旧 {', '## 新しい題名 {').replace('::: {.cover-title}\n旧\n', '::: {.cover-title}\n新しい\\\n題名\n')
    assert '::: {.cover-title}\n新しい\\\n題名\n:::\n\n::: {.cover-subtitle}\n副\n:::\n\n# 章' in sub
    assert read == {'title': '新しい\n題名', 'subtitle': '副'}
    assert final == titled.replace('author:\n  - 誰か\n', 'author:\n  - name: "山田"\n    affiliations:\n      - "東大"\n      - "理研"\n  - name: "鈴木"\n    affiliations:\n      - "東大"\n')
    assert 'author' not in cleared
    assert each is None and same is None
    assert marked == {'X': '*1', 'Y': '*2'}


def test_affiliation_position_in_form(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    form = page.locator(FORM)
    form.get_by_label('発表者を追加').click()
    form.locator('[data-field="name:0"]').fill('山田 太郎')
    aff = form.locator('[data-field="aff:0"]')
    aff.fill('東京大学'); aff.press('Enter')
    saved(page)
    q = ws.qmd('talk')
    q.write_text(q.read_text().replace('author:', 'cover-authors-layout: {"x": 12, "size": 40}\nauthor:', 1))
    page.reload(); page.click('#blocksMode')
    right = form.get_by_label('右', exact=True)
    expect(form.get_by_label('下', exact=True)).to_have_attribute('aria-pressed', 'true')
    right.click()
    expect(right).to_have_attribute('aria-pressed', 'true')
    saved(page)
    assert 'cover-authors-layout: {"x":12,"size":40,"position":"right"}' in q.read_text()
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('.cover-authors[data-affiliation-position=\"right\"]')")
    assert not page.errors


def test_author_typography_saved_and_rendered(gui, page):
    from slide_studio.fsutil import write_atomic
    from .test_blocks import ready, frame

    ws, srv = gui
    q = ws.qmd('talk')
    write_atomic(q, q.read_text().replace(
        'title:', 'author:\n  - name: 発表者\n    affiliations: [所属]\ntitle:', 1))
    open_deck(page, srv, raw=False)
    ready(page)
    frame(page).locator('.cover-name').click()
    bar = page.locator('.cover-authors-tools')

    def settle():
        saved(page)
        rendered(page, ws)
        ready(page)

    bar.get_by_label('名前のフォント', exact=True).select_option('serif')
    settle()
    bar.get_by_label('所属のフォント', exact=True).select_option('mono')
    settle()
    bar.get_by_label('名前を太字', exact=True).click()
    settle()
    bar.get_by_label('所属を太字', exact=True).click()
    settle()
    size = bar.get_by_label('名前の文字サイズ（px）', exact=True)
    size.fill('44'); size.press('Enter'); size.blur()
    settle()
    aff_size = bar.get_by_label('所属の文字サイズ（px）', exact=True)
    aff_size.fill('30'); aff_size.press('Enter'); aff_size.blur()
    settle()
    bar.get_by_label('右', exact=True).click()
    settle()
    assert '"font":"serif"' in q.read_text()
    assert '"affFont":"mono"' in q.read_text()
    assert '"bold":true' in q.read_text()
    assert '"affBold":true' in q.read_text()

    def check_styles(root):
        name = root.locator('.cover-name')
        aff = root.locator('.cover-affiliation')
        expect(name).to_have_css('font-size', '44px')
        expect(aff).to_have_css('font-size', '30px')
        expect(name).to_have_css('font-weight', '700')
        expect(aff).to_have_css('font-weight', '700')
        assert 'Mincho' in name.evaluate('e => getComputedStyle(e).fontFamily')
        assert 'Menlo' in aff.evaluate('e => getComputedStyle(e).fontFamily')

    page.reload(); ready(page)
    check_styles(frame(page))
    from conftest import shared_browser
    exported = shared_browser().new_page()
    exported.goto(srv.url + '/files/decks/talk/__slide-studio_preview__.html?edit=0')
    exported.wait_for_function('window.deckReady')
    check_styles(exported)
    exported.close()
    frame(page).locator('.cover-name').click()
    bar.get_by_label('名前のフォント', exact=True).select_option('')
    settle()
    expect(frame(page).locator('.cover-authors')).not_to_have_attribute('data-name-font', 'serif')
    page.click('#undo'); settle()
    check_styles(frame(page))
    bar.get_by_label('名前を太字', exact=True).click()
    settle()
    expect(frame(page).locator('.cover-name')).to_have_css('font-weight', '400')
    expect(frame(page).locator('.cover-affiliation')).to_have_css('font-weight', '700')
    assert not page.errors


def test_people_and_affiliations(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    form = page.locator(FORM)
    expect(form.locator('.cf-title')).to_have_value('テスト発表')
    # 1人目：名前と所属2つ
    form.get_by_label('発表者を追加').click()
    form.locator('[data-field="name:0"]').fill('山田 太郎')
    form.locator('[data-field="name:0"]').press('Enter')
    aff = form.locator('[data-field="aff:0"]')
    aff.fill('東京大学'); aff.press('Enter')
    aff.fill('理化学研究所'); aff.press('Enter')
    # 空で Enter：次の人
    aff.press('Enter')
    form.locator('[data-field="name:1"]').fill('鈴木 花子')
    form.locator('[data-field="aff:1"]').focus()
    # ほかの人の所属を候補から選ぶ
    expect(form.locator('.cf-option')).to_have_count(2)
    form.locator('.cf-option', has_text='東京大学').click()
    expect(form.locator('.cf-person').nth(1).locator('.cf-aff')).to_have_text(['*1東京大学'])
    saved(page)
    text = ws.qmd('talk').read_text()
    assert 'author:\n  - name: "山田 太郎"\n    affiliations:\n      - "東京大学"\n      - "理化学研究所"\n  - name: "鈴木 花子"\n    affiliations:\n      - "東京大学"\n' in text
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('.cover .cover-authors.marked')")
    html = cover(page)
    assert '山田 太郎<sup>*1,*2</sup>' in html and '鈴木 花子<sup>*1</sup>' in html
    assert '<sup>*1</sup>東京大学' in html and '<sup>*2</sup>理化学研究所' in html
    # 共有をやめると印が消え、人ごとの表示になる
    form.locator('.cf-person').nth(1).get_by_label('「東京大学」を外す').click()
    saved(page)
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('.cover .cover-authors.each')")
    assert '*1' not in cover(page)
    # ⌥↓ で順番を変える
    form.locator('[data-field="name:0"]').press('Alt+ArrowDown')
    saved(page)
    t = ws.qmd('talk').read_text()
    assert t.index('鈴木 花子') < t.index('山田 太郎')
    # 外を押すと描き直し、⌘Z で戻る
    page.locator('#qblocks .page.cur .heading').click()
    page.keyboard.press('Escape')
    page.click('#undo'); saved(page)
    t = ws.qmd('talk').read_text()
    assert t.index('山田 太郎') < t.index('鈴木 花子')
    assert not page.errors


def test_title_and_subtitle(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    form = page.locator(FORM)
    # 表紙のタイトル・副題の囲みは、ブロックとしては出さない
    expect(page.locator('#qblocks .page.cur .card')).to_have_count(0)
    form.locator('.cf-title').fill('新しい題名')
    form.locator('.cf-sub').fill('副題です')
    saved(page)
    text = ws.qmd('talk').read_text()
    assert 'title: "新しい題名"' in text and '## 新しい題名 {#cover .cover}' in text
    assert '::: {.cover-title}\n新しい題名\n:::\n\n::: {.cover-subtitle}\n副題です\n:::' in text
    form.locator('.cf-sub').fill('')
    saved(page)
    assert 'cover-subtitle' not in ws.qmd('talk').read_text()
    assert not page.errors


def test_front_matter_and_cover_hidden_in_raw_editor(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv)
    ta = page.locator('.raw textarea')
    value = ta.input_value()
    assert 'title:' not in value and 'theme:' not in value and '.cover' not in value
    # 表示されている本文の先頭で Backspace を押しても、隠れた設定や表紙を削除しない。
    ta.evaluate('el => { el.focus(); el.setSelectionRange(0, 0); }')
    page.keyboard.press('Backspace')
    expect(ta).to_have_value(value)
    # 表示範囲全体を置き換えても、管理された部分はそのまま残る。
    ta.fill(value)
    expect(ta).to_have_value(value)
    # 本文は書ける
    ta.evaluate('(el, p) => el.setSelectionRange(p, p)', value.index('最初の段落。'))
    page.keyboard.type('追記')
    saved_source(page, '追記最初の段落。')
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '追記最初の段落。')
    assert not page.errors


FRAME = "document.querySelector('#slideBox iframe:not(.loading)')"


def test_title_on_slide_like_other_pages(gui, page):
    """スライドの表紙のタイトルは、ほかのページの本文と同じく選んで直す。消す・動かす・太字はない。見出しと title も変わる。"""
    ws, srv = gui
    q = ws.qmd('talk')
    q.write_text(q.read_text().replace('lang: ja\n', 'lang: ja\nauthor:\n  - name: 山田\n').replace('::: {.cover-title}\nテスト発表\n', '::: {.cover-title}\nテスト<br>発表\n'))
    open_deck(page, srv)
    page.wait_for_function("document.querySelector('#stage')?.dataset.blocks === 'ready'")
    frame = page.frame_locator('#slideBox iframe:not(.loading)')
    title = frame.locator('[data-slide-studio="p0/0.0"]')
    # 自由に動かす枠はない
    expect(page.locator('.cover-layer, .cover-part')).to_have_count(0)
    title.click()
    page.wait_for_function(f"{FRAME}.contentDocument.querySelector('[data-slide-studio=\"p0/0.0\"]').classList.contains('slide-studio-selected')")
    tools = page.locator('#blockTools')
    expect(tools.get_by_role('button', name='内側の余白', exact=True)).to_have_count(1)
    for name in ['削除', '外側を選択', '段階表示']:
        expect(tools.get_by_role('button', name=re.compile(name))).to_have_count(0)
    # Delete・⇧S では消えない・動かない
    before = q.read_text()
    page.keyboard.press('Delete'); page.keyboard.press('Shift+KeyS')
    page.wait_for_timeout(300)
    assert q.read_text() == before
    # もう一度押すと文字の編集。書式バーに大きさはあり、太字・斜体・リンクはない
    title.click()
    expect(frame.locator('.slide-studio-editing')).to_have_count(1)
    expect(tools).to_have_attribute('data-mode', 'format')
    expect(tools.locator('.fmt-size')).to_be_visible()
    for name in ['太字', '斜体', 'リンク']:
        expect(tools.get_by_role('button', name=re.compile(name))).to_be_hidden()
    page.keyboard.press('End'); page.keyboard.type('会')  # 1行目の終わり
    page.keyboard.press('Escape')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    for _ in range(50):
        if 'title: "テスト会発表"' in q.read_text():
            break
        page.wait_for_timeout(100)
    text = q.read_text()
    assert '::: {.cover-title}\nテスト会\\\n発表\n:::' in text
    assert 'title: "テスト会発表"' in text and '## テスト会発表 {#cover .cover}' in text
    # 余白もほかのページと同じつまみ。囲みの名前は残る
    page.wait_for_function("document.querySelector('#stage')?.dataset.blocks === 'ready'")
    page.keyboard.press('Escape')
    title.click()
    tools.get_by_role('button', name='内側の余白', exact=True).click()
    h = page.get_by_role('slider', name='上の余白')
    b = h.bounding_box(); x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x, y + 30, steps=4); page.mouse.up()
    for _ in range(50):
        if '::: {.cover-title style="padding:' in q.read_text():
            break
        page.wait_for_timeout(100)
    assert re.search(r'::: \{\.cover-title style="padding:\d+px[^"]*"\}\nテスト会\\\n発表\n:::', q.read_text())
    assert not page.errors


@pytest.mark.parametrize("theme", ["default", "terracotta"])
def test_cover_layout_geometry_padding_and_reload(gui, page, theme):
    from .test_blocks import ready, frame, select
    ws, srv = gui
    from slide_studio.fsutil import write_atomic
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('theme: default', f'theme: {theme}').replace('::: {.cover-title}', '::: {.cover-title style="font-size:36px;width:950px;padding-left:0px;padding-right:0px;left:25px;top:-40px;margin-top:80px"}'))
    open_deck(page, srv, raw=False); ready(page)
    select(page, 'p0/0.0')
    bar = page.locator('#blockTools')
    title = frame(page).locator('.cover-title')
    assert title.evaluate('e => getComputedStyle(e).paddingLeft') == '0px'
    assert title.locator('p').evaluate('e => getComputedStyle(e).paddingLeft') == '0px'
    expect(bar.locator('.cover-layout')).to_have_count(0)
    assert title.locator('p').evaluate('e => getComputedStyle(e).fontSize') == '36px'
    assert title.evaluate('e => e.offsetWidth') == 950
    # 左右0なら、設定幅に収まる日本語は隠れた段落余白で折り返されない。
    lines = title.locator('p').evaluate("""e => {
      const html = e.innerHTML; e.textContent = 'あ'.repeat(24);
      const r = document.createRange(); r.selectNodeContents(e);
      const lines = new Set([...r.getClientRects()].map(x => x.top)).size;
      e.innerHTML = html; return lines;
    }""")
    assert lines == 1
    assert title.evaluate('e => getComputedStyle(e).paddingLeft') == '0px'
    # 位置はブロックのドラッグ、大きさはつまみで変え、保存後の描画にも残る。位置のつまみは出さない。
    expect(page.locator('.bh.cover-move')).to_have_count(0)
    for target, dx, dy, css in [(title, 20, 10, 'left:'), (page.get_by_role('slider', name='幅と高さを変更', exact=True), -30, 15, 'min-height:')]:
        box = target.bounding_box(); x = box['x'] + box['width']/2; y = box['y'] + box['height']/2
        before = ws.qmd('talk').read_text()
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x+dx, y+dy, steps=5); page.mouse.up()
        saved_source(page, css); rendered(page, ws); ready(page)
        assert ws.qmd('talk').read_text() != before
    # 数値で片側ずつ指定した余白は、つまみの表示・測定だけでは変わらない。
    before_padding = ws.qmd('talk').read_text()
    bar.get_by_role('button', name='内側の余白', exact=True).click()
    expect(page.locator('.bh-band[data-side="left"]')).to_have_attribute('data-value', '0')
    assert title.evaluate('e => getComputedStyle(e).paddingLeft') == '0px'
    page.keyboard.press('Escape')
    assert ws.qmd('talk').read_text() == before_padding
    source = ws.qmd('talk').read_text()
    assert '.cover-title' in source and 'title: "テスト発表"' in source
    page.reload(); ready(page)
    assert title.locator('p').evaluate('e => getComputedStyle(e).fontSize') == '36px'
    assert title.evaluate('e => getComputedStyle(e).paddingRight') == '0px'
    assert not page.errors
    select(page, 'p0/0.0')
    page.screenshot(path=f'/tmp/slide-studio-cover-layout-{theme}.png')

    # ブロック本体をつかんで動かす。テキスト編集には入らない。
    box = title.bounding_box(); x, y = box['x'] + box['width']/2, box['y'] + 12
    before = title.evaluate("e => [parseFloat(e.style.left), parseFloat(e.style.top)]")
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 35, y + 20, steps=5); page.mouse.up()
    saved(page); rendered(page, ws); ready(page)
    after = title.evaluate("e => [parseFloat(e.style.left), parseFloat(e.style.top)]")
    assert after[0] > before[0] and after[1] > before[1]
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    page.reload(); ready(page)
    assert title.evaluate("e => [parseFloat(e.style.left), parseFloat(e.style.top)]") == after


@pytest.mark.parametrize('people', [
    '  - name: 山田\n    affiliations: [大学]',
    '  - name: 山田\n    affiliations: [大学]\n  - name: 鈴木\n    affiliations: [大学]',
    '  - name: 山田\n    affiliations: [大学, 研究所]\n  - name: 鈴木\n    affiliations: [大学]',
])
def test_authors_move_and_affiliation_position(gui, page, people):
    from .test_blocks import ready, frame
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    q = ws.qmd('talk')
    write_atomic(q, q.read_text().replace('lang: ja\n', f'lang: ja\nauthor:\n{people}\n'))
    open_deck(page, srv, raw=False); ready(page)
    page.set_default_timeout(5000)
    authors = frame(page).locator('.cover-authors')
    authors.click()
    bar = page.get_by_role('toolbar', name='名前と所属', exact=True)
    expect(bar).to_be_visible()
    expect(bar.locator('.aff-position-label')).to_have_text('所属：')
    expect(bar.get_by_role('spinbutton', name='所属の文字サイズ（px）', exact=True)).to_be_visible()
    for label, value in [('右', 'right'), ('左', 'left'), ('下', 'bottom')]:
        bar.get_by_role('button', name=label, exact=True).click()
        saved(page); rendered(page, ws); ready(page)
        expect(authors).to_have_attribute('data-affiliation-position', value)
        assert authors.evaluate('e => e.getBoundingClientRect().right <= e.parentElement.getBoundingClientRect().right')
        assert authors.locator('.cover-name,.cover-names').first.evaluate('e => getComputedStyle(e).fontSize') == authors.locator('.cover-affiliation').first.evaluate('e => getComputedStyle(e).fontSize')
        name = authors.locator('.cover-name,.cover-names').first.bounding_box()
        aff = authors.locator('.cover-affiliation,.cover-affiliations').first.bounding_box()
        if value == 'right':
            page.screenshot(path='/tmp/slide-studio-authors-right.png')
            assert aff['x'] >= name['x'] + name['width'] - 1
        elif value == 'left':
            assert aff['x'] + aff['width'] <= name['x'] + 1
        else:
            assert aff['y'] >= name['y'] + name['height'] - 1
    box = authors.bounding_box(); x, y = box['x'] + box['width']/2, box['y'] + 8
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 30, y - 20, steps=5); page.mouse.up()
    saved(page); rendered(page, ws); ready(page)
    position = authors.evaluate("e => [parseFloat(e.style.left), parseFloat(e.style.top)]")
    assert position[0] > 0 and position[1] < 0
    page.click('#undo'); saved(page); rendered(page, ws); ready(page)
    expect(authors).to_have_attribute('style', '')
    page.click('#redo'); saved(page); rendered(page, ws); ready(page)
    expect(authors).to_have_css('left', f'{position[0]}px')
    page.reload(); ready(page)
    assert authors.evaluate("e => [parseFloat(e.style.left), parseFloat(e.style.top)]") == position
    authors.dblclick()
    field = bar.get_by_role('spinbutton', name='名前の文字サイズ（px）', exact=True)
    field.fill('40'); field.press('Enter'); field.blur()
    saved(page); rendered(page, ws); ready(page)
    expect(authors.locator('.cover-name,.cover-names').first).to_have_css('font-size', '40px')
    field = bar.get_by_role('spinbutton', name='所属の文字サイズ（px）', exact=True)
    field.fill('19'); field.press('Enter'); field.blur()
    saved(page); rendered(page, ws); ready(page)
    expect(authors.locator('.cover-affiliation').first).to_have_css('font-size', '19px')
    expect(authors.locator('.cover-name,.cover-names').first).to_have_css('font-size', '40px')
    assert not page.errors


def test_cover_double_click_keeps_caret_and_drag_selects(gui, page):
    from .test_blocks import ready, frame
    ws, srv = gui
    open_deck(page, srv, raw=False); ready(page)
    title = frame(page).locator('.cover-title p')
    title.dblclick()
    expect(title).to_have_attribute('contenteditable', 'true')
    assert title.evaluate('e => getSelection().isCollapsed')
    # 編集中のダブルクリックも単語を選ばない。
    title.dblclick()
    assert title.evaluate('e => getSelection().isCollapsed')
    # 実際に文字をドラッグしたときだけ範囲を選ぶ。
    box = title.evaluate("""e => { const r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect(); return {x:b.x, y:b.y, width:b.width, height:b.height}; }""")
    iframe = page.locator('#slideBox iframe:not(.loading)').bounding_box()
    x, y = iframe['x'] + box['x'] + 2, iframe['y'] + box['y'] + box['height']/2
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + box['width'] * .7, y, steps=8); page.mouse.up()
    assert title.evaluate('e => !getSelection().isCollapsed')
    assert not page.errors




def test_cover_title_align_follows_theme(gui, page):
    """テーマが表紙を中央揃えにしているとき、揃えのボタンは中央から始まり、左を選ぶと text-align:left を書く。"""
    from .test_blocks import ready, frame, select
    ws, srv = gui
    from slide_studio.fsutil import write_atomic
    # serif などのテーマの表紙の中央揃え（最後のページに置き、表紙のブロックの番号は変えない）
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text() + '\n```{=html}\n<style>#stage .cover{text-align:center}</style>\n```\n')
    open_deck(page, srv, raw=False); ready(page)
    select(page, 'p0/0.0')
    align = page.locator('#blockTools').get_by_role('button', name='揃え', exact=True)
    title = frame(page).locator('.cover-title')
    expect(align).to_have_attribute('data-align', 'center')
    align.click(); saved_source(page, 'text-align:right'); ready(page)
    expect(title).to_have_css('text-align', 'right')
    align.click(); saved_source(page, 'text-align:left'); ready(page)
    expect(title).to_have_css('text-align', 'left')
    expect(align).to_have_attribute('data-align', 'left')
    align.click()
    saved_source(page, '::: {.cover-title}\n')
    expect(title).to_have_css('text-align', 'center')
    assert not page.errors


def test_cover_title_font_size_can_be_changed(gui, page):
    from .test_blocks import ready, frame
    ws, srv = gui
    open_deck(page, srv, raw=False); ready(page)
    title = frame(page).locator('.cover-title p')
    title.dblclick()
    field = page.locator('#blockTools').get_by_role('spinbutton', name='文字の大きさ（px）')
    expect(field).to_have_value('80')
    field.fill('48'); field.press('Enter')
    expect(title.locator('span')).to_have_css('font-size', '48px')
    page.locator('#blockTools').get_by_role('button', name='外側を選択', exact=True).click()
    saved_source(page, 'font-size: 0.6em')
    saved(page); rendered(page, ws)
    page.reload(); ready(page)
    expect(frame(page).locator('.cover-title p span')).to_have_css('font-size', '48px')


def test_cover_title_font_size_from_selection(gui, page):
    from .test_blocks import ready, frame
    ws, srv = gui
    open_deck(page, srv, raw=False); ready(page)
    title = frame(page).locator('.cover-title')
    title.click()
    field = page.locator('#blockTools').get_by_role('spinbutton', name='文字の大きさ（px）')
    expect(field).to_have_value('80')
    field.fill('50'); field.press('Enter')
    saved_source(page, 'font-size:50px')
    saved(page); rendered(page, ws); ready(page)
    expect(title.locator('p')).to_have_css('font-size', '50px')
    page.reload(); ready(page)
    expect(title.locator('p')).to_have_css('font-size', '50px')
    assert not page.errors
