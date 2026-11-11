"""文字の書式バー（設計書 §10.5）：編集中だけ出し、色はテーマの色の名前で書く。✕ でブロックの選択に戻る。"""
from playwright.sync_api import expect

from e2e.conftest import open_deck, rendered
from e2e.test_blocks import frame, go, ready, saved, select, start_edit


def pick_text(page, key, needle):
    """スライドで編集中のブロックの中の needle を選ぶ。"""
    page.evaluate("""([key, needle]) => {
      const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
      const el = doc.querySelector(`[data-slide-studio="${key}"]`), walk = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        const i = t.data.indexOf(needle); if (i < 0) continue;
        const r = doc.createRange(); r.setStart(t, i); r.setEnd(t, i + needle.length);
        const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r); return;
      }
      throw new Error('not found');
    }""", [key, needle])
    page.wait_for_timeout(50)  # selectionchange


def bar(page):
    return page.locator('#blockTools')


def test_format_bar_colors_size_and_close(gui, page):
    ws, srv = gui
    open_deck(page, srv); ready(page); go(page, 2)
    select(page, 'p2/0')
    # ブロックを選んでいるだけのときは書式バーを出さない
    expect(bar(page).get_by_role('button', name='文字の色')).to_have_count(0)
    start_edit(page, 'p2/0')
    expect(bar(page)).to_have_attribute('data-mode', 'format')
    # 色は常には出さず、A を押したときだけメニューを出す
    expect(bar(page).get_by_role('button', name='強調', exact=True)).to_be_hidden()
    pick_text(page, 'p2/0', '最初')
    bar(page).get_by_role('button', name='文字の色').click()
    # テーマの色は 本文・強調・プラス・マイナス・マーカーだけ（見出しの色・薄いは出さない）
    names = bar(page).locator('.fmt-menu .swatch:not(.more)')
    expect(names).to_have_count(5)
    assert [n.get_attribute('data-color') for n in names.all()] == ['', 'accent', 'good', 'warn', 'highlight']
    expect(bar(page).get_by_role('button', name='本文', exact=True)).to_have_attribute('aria-pressed', 'true')
    bar(page).get_by_role('button', name='強調', exact=True).click()
    expect(bar(page).get_by_role('button', name='強調', exact=True)).to_be_hidden()
    saved(page, '[最初]{.accent}の段落。')
    # 大きさは選んだ文字の px を出し、⊕ で次の段へ（原稿には em）
    expect(bar(page).get_by_role('spinbutton', name='文字の大きさ（px）')).to_have_value('29')
    bar(page).get_by_role('button', name='文字を大きく').click()
    saved(page, '[[最初]{style="font-size: 1.103em"}]{.accent}の段落。')
    expect(bar(page).get_by_role('spinbutton', name='文字の大きさ（px）')).to_have_value('32')
    # ⌘ と角括弧だけでサイズを変える。ボタンの案内も同じキー。
    expect(bar(page).get_by_role('button', name='文字を大きく')).to_have_attribute('data-keys', '⌘ ]')
    expect(bar(page).get_by_role('button', name='文字を小さく')).to_have_attribute('data-keys', '⌘ [')
    page.keyboard.press('Meta+[')
    expect(bar(page).get_by_role('spinbutton', name='文字の大きさ（px）')).to_have_value('29')
    page.keyboard.press('Meta+]')
    expect(bar(page).get_by_role('spinbutton', name='文字の大きさ（px）')).to_have_value('32')
    saved(page, '[[最初]{style="font-size: 1.103em"}]{.accent}の段落。')
    # 選ばずに色を変えるとブロック全体に。［本文］で外す
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getSelection().collapseToEnd()")
    page.wait_for_timeout(50)
    bar(page).get_by_role('button', name='文字の色').click()
    bar(page).get_by_role('button', name='マイナス').click()
    saved(page, '[[最初]{style="font-size: 1.103em"}の段落。]{.warn}')
    bar(page).get_by_role('button', name='色と大きさを戻す').click()
    saved(page, '\n最初の段落。\n')
    # マーカーは段なしで付け、最初から地の色で塗る
    bar(page).get_by_role('button', name='文字の色').click()
    bar(page).get_by_role('button', name='マーカー').click()
    saved(page, '[最初の段落。]{.highlight}')
    mark = frame(page).locator('.slide-studio-editing .highlight')
    assert mark.evaluate("e => getComputedStyle(e).backgroundColor") != 'rgba(0, 0, 0, 0)'
    bar(page).get_by_role('button', name='色と大きさを戻す').click()
    saved(page, '\n最初の段落。\n')
    # 外側を選択すると、同じ段落のブロック選択に戻る
    bar(page).get_by_role('button', name='外側を選択').click()
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    expect(frame(page).locator('.slide-studio-selected')).to_have_attribute('data-slide-studio', 'p2/0')
    expect(bar(page)).not_to_have_attribute('data-mode', 'format')
    expect(bar(page).get_by_role('button', name='外側を選択')).to_be_visible()
    assert not page.errors


def test_free_color_and_tooltip(gui, page):
    ws, srv = gui
    open_deck(page, srv); ready(page); go(page, 2)
    select(page, 'p2/1')
    # ボタンに文字は無く、カーソルを合わせると操作名とキーが出る
    bar(page).get_by_role('button', name='削除').hover()
    tip = page.locator('.tip.show')
    expect(tip).to_be_visible()
    expect(tip.locator('.tip-name')).to_have_text('削除')
    expect(tip.locator('kbd')).to_have_text(['Delete'])
    assert bar(page).inner_text().strip() == ''
    start_edit(page, 'p2/1')
    bar(page).get_by_role('button', name='太字').hover()
    expect(page.locator('.tip.show kbd')).to_have_text(['⌘', 'B'])
    # 自由な色だけは色の値で書く
    pick_text(page, 'p2/1', '二番目')
    bar(page).get_by_role('button', name='文字の色').click()
    page.evaluate("""() => { const i = document.querySelector('#blockTools input[type=color]'); i.value = '#e5484d'; i.dispatchEvent(new Event('change')); }""")
    saved(page, '[二番目]{style="color: #e5484d"}の段落。')
    # 書式を付けた段落も、続けてスライドで直接編集できる
    page.keyboard.press('Escape')
    rendered(page, ws); ready(page)
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    start_edit(page, 'p2/1')
    assert not page.errors


def test_smaller_text_tightens_hard_break_spacing(gui, page):
    from slide_studio.fsutil import write_atomic

    ws, srv = gui
    source = ws.qmd('talk')
    write_atomic(source, source.read_text().replace('最初の段落。', '最初の段落。\\\n次の行。'))
    open_deck(page, srv); ready(page); go(page, 2)
    paragraph = frame(page).locator('[data-slide-studio="p2/0"]')
    measure = """e => {
      const walk = e.ownerDocument.createTreeWalker(e, NodeFilter.SHOW_TEXT), tops = [];
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        if (!t.textContent.trim()) continue;
        const r = e.ownerDocument.createRange(); r.selectNodeContents(t);
        tops.push(r.getBoundingClientRect().top);
      }
      return tops.at(-1) - tops[0];
    }"""
    original = paragraph.evaluate(measure)
    select(page, 'p2/0')
    start_edit(page, 'p2/0')
    size = bar(page).get_by_role('spinbutton', name='文字の大きさ（px）')
    size.fill('18'); size.press('Enter')
    gap = paragraph.evaluate(measure)
    assert gap < original * .8, (original, gap)
    saved(page, 'font-size: 0.621em')
    page.keyboard.press('Escape')
    rendered(page, ws); ready(page)
    assert abs(paragraph.evaluate(measure) - gap) < 1
    assert '\\\n' in source.read_text()
    assert 'line-height' not in source.read_text()
    select(page, 'p2/0')
    point = paragraph.evaluate('''el => {
      const t = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      const r = el.ownerDocument.createRange(); r.selectNodeContents(t);
      const a = r.getClientRects()[0], b = el.getBoundingClientRect();
      return {x:a.left - b.left + 4, y:a.top - b.top + a.height / 2};
    }''')
    paragraph.click(position=point)
    expect(paragraph).to_have_attribute('contenteditable', 'true')
    bar(page).get_by_role('button', name='色と大きさを戻す').click()
    assert abs(paragraph.evaluate(measure) - original) < 1
    assert not page.errors
