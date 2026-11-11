"""挿入の画面で、同じトピックの発表で前に使った数式・画像を選んで入れる。数式の画面の並び・大きさ・位置と、原稿のブロック表示の数式。"""
import base64

from playwright.sync_api import expect

from conftest import add_deck
from e2e.test_blocks import frame, go, ready, saved, select
from e2e.test_insert import PNG64, RUN, menu
from e2e.conftest import open_deck

OLD = '''---
topic: test
---

## 前の発表 {#old}

$$
\\sum_{i=1}^{n} x_i
$$

$$
\\frac{a}{b}
$$

$$
\\frac{a}{b}
$$

| 手法 | 精度 |
|---|---|
| 提案 | 0.91 |

![](images/plot.png){width=300}
'''


def setup(gui, page):
    ws, srv = gui
    old = add_deck(ws, 'old', OLD)
    (ws.asset_root('old') / 'images' / 'plot.png').write_bytes(base64.b64decode(PNG64))
    open_deck(page, srv)
    ready(page)
    go(page, 2)
    select(page, 'p2/0')
    return ws, ws.qmd('talk').read_text()


def test_math_candidates_narrow_by_prefix_and_tab_fills(gui, page):
    ws, before = setup(gui, page)
    menu(page, '数式')
    cands = page.locator('.ins-math .cands .cand')
    # 何も打っていなければ使った数の順
    expect(cands).to_have_count(2)
    expect(cands.first.locator('mfrac')).to_have_count(1)
    box = page.get_by_label('数式', exact=True)
    box.press_sequentially('\\su')
    expect(cands).to_have_count(1)
    expect(cands.first.locator('munderover, msubsup')).to_have_count(1)
    box.press('Tab')
    expect(box).to_have_value('\\sum_{i=1}^{n} x_i')
    expect(cands).to_have_count(0)
    box.press('Meta+Enter')
    md = '$$\n\\sum_{i=1}^{n} x_i\n$$'
    saved(page, md)
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '最初の段落。\n\n' + md)
    assert not page.errors


def test_math_candidates_arrow_and_enter(gui, page):
    _, _ = setup(gui, page)
    menu(page, '数式')
    box = page.get_by_label('数式', exact=True)
    expect(page.locator('.ins-math .cand')).to_have_count(2)
    box.press('ArrowDown')
    box.press('ArrowRight')
    expect(page.locator('.ins-math .cand.on')).to_have_count(1)
    box.press('Enter')
    expect(box).to_have_value('\\sum_{i=1}^{n} x_i')
    assert not page.errors


def test_math_layout_order_grow_matrix_and_recent(gui, page):
    setup(gui, page)
    menu(page, '数式')
    expect(page.locator('.ins-math .cand')).to_have_count(2)
    # 上から 書く欄・どう出るか・前に使った数式・雛形
    order = page.eval_on_selector('.ins-math', 'n => [...n.children].map(c => c.tagName === "TEXTAREA" ? "ta" : c.className)')
    assert order == ['acts', 'ta', 'pv', 'strip cands', 'strip snips']
    box = page.get_by_label('数式', exact=True)
    h0 = box.bounding_box()['height']
    # 行列は1行ずつの形で、a を選んだ状態。打つと置き換わる
    page.locator('.ins-math .snip[data-tip="行列"]').click()
    expect(box).to_have_value('\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}')
    page.keyboard.type('x')
    expect(box).to_have_value('\\begin{bmatrix}\nx & b \\\\\nc & d\n\\end{bmatrix}')
    # 書いた分だけ欄が広がる
    assert box.bounding_box()['height'] > h0 + 30
    expect(page.locator('.ins-math .pv math mtable')).to_have_count(1)
    page.keyboard.press('Escape')
    # 雛形は最近使った順
    menu(page, '数式')
    expect(page.locator('.ins-math .snip').first).to_have_attribute('data-tip', '行列')
    # 前に使った数式も、入れたものが先
    page.get_by_label('数式', exact=True).fill('\\sum_{i=1}^{n} x_i')
    page.get_by_label('数式', exact=True).press('Meta+Enter')
    saved(page, '\\sum_{i=1}^{n} x_i')
    menu(page, '数式')
    expect(page.locator('.ins-math .cand')).to_have_count(2)
    expect(page.locator('.ins-math .cand').first).to_have_attribute('data-tip', '\\sum_{i=1}^{n} x_i / talk・old で使用')
    assert not page.errors


def test_math_snippet_and_candidate_undo(gui, page):
    setup(gui, page)
    menu(page, '数式')
    box = page.get_by_label('数式', exact=True)
    expect(page.locator('.ins-math .cand')).to_have_count(2)
    # 前に使った数式・雛形で入れたものも ⌘Z で戻せる
    page.locator('.ins-math .cand').first.click()
    expect(box).not_to_have_value('')
    box.press('ControlOrMeta+z')
    expect(box).to_have_value('')
    box.press_sequentially('ab')
    page.locator('.ins-math .snip[data-tip="分数"]').click()
    expect(box).to_have_value('ab\\frac{}{}')
    box.press('ControlOrMeta+z')
    expect(box).to_have_value('ab')
    assert not page.errors


def test_math_popup_moves_and_keeps_size(gui, page):
    setup(gui, page)
    menu(page, '数式')
    pop = page.locator('.ins-math')
    expect(page.locator('.ins-math .cand')).to_have_count(2)
    b = pop.bounding_box()
    # 空いている所（どう出るかの欄）を掴んで動かす
    pv = page.locator('.ins-math .pv').bounding_box()
    page.mouse.move(pv['x'] + 10, pv['y'] + 10)
    page.mouse.down()
    page.mouse.move(pv['x'] - 190, pv['y'] + 60, steps=5)
    page.mouse.up()
    moved = pop.bounding_box()
    assert abs(moved['x'] - (b['x'] - 200)) < 2 and abs(moved['y'] - (b['y'] + 50)) < 2
    expect(pop).to_have_count(1)
    # 右下のつまみで大きさを変えると、次に開いたときもその大きさ
    page.mouse.move(moved['x'] + moved['width'] - 4, moved['y'] + moved['height'] - 4)
    page.mouse.down()
    page.mouse.move(moved['x'] + moved['width'] + 116, moved['y'] + moved['height'] + 80, steps=5)
    page.mouse.up()
    w = pop.bounding_box()['width']
    assert w > moved['width'] + 100
    page.keyboard.press('Escape')
    menu(page, '数式')
    expect(page.locator('.ins-math .cand')).to_have_count(2)
    assert abs(page.locator('.ins-math').bounding_box()['width'] - w) < 2
    assert not page.errors


def test_table_has_no_candidates_or_buttons(gui, page):
    setup(gui, page)
    menu(page, '表')
    expect(page.get_by_label('1行1列', exact=True)).to_be_focused()
    expect(page.locator('.ins-table .cand, .ins-table .foot')).to_have_count(0)
    assert not page.errors


def test_popup_closes_on_click_in_slide(gui, page):
    setup(gui, page)
    menu(page, '文献の引用')
    expect(page.locator('.ins-cite')).to_have_count(1)
    # 選んだ段落の下に開くので、段落の上ではなくスライドの空いた所を押す
    s = frame(page).locator('.slide.active').bounding_box()
    page.mouse.click(s['x'] + s['width'] - 20, s['y'] + s['height'] * .6)
    expect(page.locator('.ins-cite')).to_have_count(0)
    assert not page.errors


def test_block_view_math_chip_opens_editor(gui, page):
    ws, srv = gui
    add_deck(ws, 'old', OLD)
    text = ws.qmd('talk').read_text().replace('最初の段落。', '最初の段落。\n\n$$\n\\frac{a}{b} + \\sum_{k=1}^{K} w_k x_k\n$$')
    ws.qmd('talk').write_text(text)
    open_deck(page, srv, raw=False)
    ready(page)
    go(page, 2)
    chip = page.locator('#qblocks .page.cur .chip.math')
    expect(chip).to_have_count(1)
    expect(chip).to_have_text('\\frac{a}{b} + \\sum_{k=1}^{K} w_k x_k')
    # 長い数式は書き始めだけが見える
    assert chip.bounding_box()['width'] <= 281
    chip.click()
    box = page.get_by_label('数式', exact=True)
    expect(box).to_have_value('\\frac{a}{b} + \\sum_{k=1}^{K} w_k x_k')
    expect(page.get_by_label('ブロックの原稿', exact=True)).to_have_count(0)
    box.fill('y^2')
    page.mouse.click(5, 450)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    page.wait_for_function("() => document.querySelector('#qblocks .page.cur .chip.math')?.textContent === 'y^2'")
    assert ws.qmd('talk').read_text() == text.replace('\\frac{a}{b} + \\sum_{k=1}^{K} w_k x_k', 'y^2')
    assert not page.errors


def test_emptying_math_removes_block(gui, page):
    ws, srv = gui
    text = ws.qmd('talk').read_text()
    ws.qmd('talk').write_text(text.replace('最初の段落。', '最初の段落。\n\n$$\nx^2\n$$'))
    open_deck(page, srv, raw=False)
    ready(page)
    go(page, 2)
    page.locator('#qblocks .page.cur .chip.math').click()
    page.get_by_label('数式', exact=True).fill('')
    page.mouse.click(5, 450)
    expect(page.locator('#qblocks .page.cur .chip.math')).to_have_count(0)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == text
    assert not page.errors


def test_preview_of_math_with_line_breaks(gui, page):
    setup(gui, page)
    menu(page, '数式')
    page.get_by_label('数式', exact=True).fill('a = b\nc = d')
    expect(page.locator('.ins-math .pv math mtable mtr')).to_have_count(2)
    assert not page.errors


def test_image_from_other_deck_is_shared(gui, page):
    ws, before = setup(gui, page)
    menu(page, '画像')
    tile = page.locator('.ins-pick .tile').filter(has_text='plot.png')
    expect(tile).to_have_count(1)
    tile.click()
    md = '![](images/plot.png){width=4 fig-align="center"}'
    saved(page, md)
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '最初の段落。\n\n' + md)
    assert (ws.asset_root('talk') / 'images' / 'plot.png').read_bytes() == base64.b64decode(PNG64)
    assert not page.errors


def test_match_helpers(gui, page):
    _, srv = gui
    page.goto(srv.url)
    out = page.evaluate(RUN, ['', r'''
      const items = ['\\frac{a}{b}', '\\sum_i x_i', 'x \\frac{1}{2}', 'y'].map(tex => ({tex}));
      const tex = xs => xs.map(x => x.tex);
      return {
        empty: tex(ins.matchMath(items, '', 2)),
        prefix: tex(ins.matchMath(items, '\\fr')),
        spaces: tex(ins.matchMath(items, '\\frac {a}')),
        exact: tex(ins.matchMath(items, 'y')),
        recent: ins.byRecent(['a', 'b', 'c', 'd'], x => x, ['c', 'z', 'a']),
      };
    '''])
    assert out['empty'] == ['\\frac{a}{b}', '\\sum_i x_i']
    # 前から一致するものが先、途中に含むものが後
    assert out['prefix'] == ['\\frac{a}{b}', 'x \\frac{1}{2}']
    assert out['spaces'] == ['\\frac{a}{b}']
    assert out['exact'] == []
    assert out['recent'] == ['c', 'a', 'b', 'd']
