"""スライドの表：セルごとの文字編集と、表全体の文字サイズ・太字・列の幅。"""
import pytest
from playwright.sync_api import expect

from conftest import add_deck
from e2e.conftest import open_deck
from e2e.test_blocks import frame, ready, saved, select

DECK = '''---
title: 表
topic: test
theme: default
---

## 表 {#t}

| 項目 | 説明 [@none] |
|:---|:---|
| 内容 | 長い説明の文章がここに入ります。折り返して下に伸びることを確かめます。 |
|  | 二行目 |
'''
KEY = 'p0/0'


def open_table(ws, srv, page, nested=False):
    source = DECK
    if nested:
        source = source.replace('| 項目', ':::: {style="--table-cols:200 700"}\n::: {style="--table-size:27px"}\n| 項目', 1)
        source += '\n:::\n\nAnother paragraph.\n::::\n'
    add_deck(ws, 'tbl', source)
    open_deck(page, srv, 'tbl'); ready(page)
    select(page, 'p0/0.0.0' if nested else KEY)


def cell(page, text):
    return frame(page).locator('td,th').filter(has_text=text).first


def qmd(ws):
    return ws.qmd('tbl').read_text()


def click_text(page, loc):
    """セルの文字の上を押す（文字のないセルは左上）。"""
    loc.click(position=loc.evaluate("""el => {
      const r = el.ownerDocument.createRange(); r.selectNodeContents(el);
      const a = r.getClientRects()[0], b = el.getBoundingClientRect();
      return a ? {x: a.left - b.left + 3, y: a.top - b.top + a.height / 2} : {x: 12, y: 12};
    }"""))


def test_edit_cells_on_the_slide_and_move_between_them(gui, page):
    ws, srv = gui
    open_table(ws, srv, page)
    first = cell(page, '内容')
    click_text(page, first)
    expect(first).to_have_attribute('contenteditable', 'true')
    expect(page.locator('#blockTools')).to_have_attribute('data-mode', 'format')
    first.fill('変更後')
    saved(page, '| 変更後 | 長い説明')
    # Tab で隣のセルへ移って続けて直す。引用の原文はそのまま
    page.keyboard.press('Tab')
    second = frame(page).locator('.slide-studio-editing')
    expect(second).to_contain_text('長い説明')
    page.keyboard.type('次のセル')
    saved(page, '| 変更後 | 次のセル |')
    # 別のセルを押しても編集が続く。Enter は改行
    click_text(page, cell(page, '項目'))
    expect(cell(page, '項目')).to_have_attribute('contenteditable', 'true')
    page.keyboard.press('Meta+a')
    page.keyboard.type('見出し')
    page.keyboard.press('Enter')
    page.keyboard.type('二段')
    saved(page, '| 見出し<br>二段 | 説明 [@none] |')
    page.keyboard.press('Escape')
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    text = qmd(ws)
    assert '|:---|:---|' in text and '|  | 二行目 |' in text
    # 編集を終えたあとも1回目は表の選択
    click_text(page, cell(page, '変更後'))
    page.wait_for_timeout(100)
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    # ⌘Z はセルごと
    page.click('#undo')
    saved(page, '| 項目 | 説明 [@none] |')
    assert not page.errors


def test_empty_cell_can_be_filled(gui, page):
    ws, srv = gui
    open_table(ws, srv, page)
    empty = frame(page).locator('tbody tr').nth(1).locator('td').first
    click_text(page, empty)
    expect(empty).to_have_attribute('contenteditable', 'true')
    page.keyboard.type('埋めた')
    saved(page, '| 埋めた | 二行目 |')
    assert not page.errors


def test_table_size_bold_and_reset(gui, page):
    ws, srv = gui
    open_table(ws, srv, page)
    bar = page.locator('#blockTools')
    size = bar.get_by_role('spinbutton', name='文字の大きさ（px）')
    size.fill('20'); size.press('Enter')
    saved(page, '--table-size:20px')
    ready(page)
    table = frame(page).locator('table')
    expect(table).to_have_css('font-size', '20px')
    bar.get_by_role('button', name='文字を大きく').click()
    saved(page, '--table-size:22px')
    bar.get_by_role('button', name='表を太字').click()
    saved(page, '--table-weight:700')
    expect(frame(page).locator('tbody td').first).to_have_css('font-weight', '700')
    # 包みの中の表をそのまま選び続け、原稿の表は書き換えない
    assert '| 内容 | 長い説明' in qmd(ws)
    expect(frame(page).locator('.slide-studio-selected')).to_have_attribute('data-slide-studio', 'p0/0.0')
    # 書式を変えたあとで選ばれたままの表は、1回目は表の選択のまま。2回目でセルを直せる（包みの中でも同じ）
    ready(page)
    target = cell(page, '内容')
    click_text(page, target)
    page.wait_for_timeout(100)
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    expect(page.locator('#blockTools')).not_to_have_attribute('data-mode', 'format')
    click_text(page, target)
    expect(target).to_have_attribute('contenteditable', 'true')
    target.fill('包みの中')
    saved(page, '| 包みの中 | 長い説明')
    page.keyboard.press('Escape')
    saved(page, '| 包みの中 | 長い説明')
    ready(page)
    expect(frame(page).locator('.slide-studio-selected')).to_have_attribute('data-slide-studio', 'p0/0.0')
    bar.get_by_role('button', name='表の文字サイズ・太字・幅を戻す').click()
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('--table-')")
    assert not page.errors


@pytest.mark.parametrize('nested', [False, True])
def test_column_widths_and_table_width_by_dragging(gui, page, nested):
    ws, srv = gui
    open_table(ws, srv, page, nested=nested)
    size = page.locator('#blockTools').get_by_role('spinbutton', name='文字の大きさ（px）')
    handles = page.locator('.bh.table-col')
    expect(handles).to_have_count(2)
    row = frame(page).locator('tbody tr').first
    before = row.bounding_box()['height']
    head = frame(page).locator('th')
    w0 = head.nth(0).bounding_box()['width']

    def drag(handle, dx):
        b = handle.bounding_box()
        x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + dx / 2, y); page.mouse.move(x + dx, y); page.mouse.up()

    drag(handles.nth(0), 60)
    saved(page, '--table-cols:')
    ready(page)
    expect(frame(page).locator('table')).to_have_css('table-layout', 'fixed')
    assert head.nth(0).bounding_box()['width'] > w0 + 20
    # 右の端は表の幅。狭めると文字が折り返して行が下に伸びる
    expect(handles).to_have_count(2)
    drag(handles.nth(1), -400)
    page.wait_for_function("(() => { const matches = [...document.querySelector('.raw textarea').value.matchAll(/--table-cols:(\\d+) (\\d+)/g)]; return matches.some(m => +m[2] < 500); })()")
    saved(page, '--table-cols:')
    ready(page)
    assert row.bounding_box()['height'] > before
    expect(size).to_be_visible()
    width = head.nth(0).bounding_box()['width']
    page.reload(); ready(page)
    assert abs(head.nth(0).bounding_box()['width'] - width) < 1
    assert not page.errors


def test_table_without_header_row_edits_the_right_row(gui, page):
    ws, srv = gui
    add_deck(ws, 'tbl', '---\ntitle: 表\ntopic: test\ntheme: default\n---\n\n## 表 {#t}\n\n|  |  |\n|---|---|\n| 一 | 二 |\n| 三 | 四 |\n')
    open_deck(page, srv, 'tbl'); ready(page)
    select(page, KEY)
    # 全部空の見出しは描画されないが、原稿の行とずれない。ダブルクリックでも編集に入る
    target = cell(page, '三')
    target.dblclick()
    expect(target).to_have_attribute('contenteditable', 'true')
    target.fill('直した')
    saved(page, '| 直した | 四 |')
    assert '| 一 | 二 |' in qmd(ws)
    assert not page.errors


def test_first_click_selects_and_the_table_can_be_dragged_from_its_text(gui, page):
    ws, srv = gui
    add_deck(ws, 'tbl', DECK.replace('## 表 {#t}\n\n', '## 表 {#t}\n\n前の段落。\n\n'))
    open_deck(page, srv, 'tbl'); ready(page)
    target = cell(page, '内容')
    click_text(page, target)
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('table.slide-studio-selected')")
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    expect(page.locator('#blockTools')).not_to_have_attribute('data-mode', 'format')
    # 選んだ表の文字の上から持って、前の段落の上へ動かす（編集には入らない）
    b = target.bounding_box()
    p = frame(page).locator('p').filter(has_text='前の段落').bounding_box()
    page.mouse.move(b['x'] + 12, b['y'] + b['height'] / 2); page.mouse.down()
    page.mouse.move(b['x'] + 12, b['y'] - 20); page.mouse.move(p['x'] + 20, p['y'] + 2); page.mouse.up()
    page.wait_for_function("document.querySelector('.raw textarea').value.indexOf('| 項目') < document.querySelector('.raw textarea').value.indexOf('前の段落')")
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    assert not page.errors


def test_fixed_columns_wrap_even_if_the_deck_css_forbids_it(gui, page):
    ws, srv = gui
    add_deck(ws, 'tbl', DECK.replace('## 表 {#t}\n\n', '## 表 {#t}\n\n::: {style="--table-cols:120 500"}\n').replace('二行目 |\n', '二行目 |\n:::\n').replace('| 内容 |', '| 問題クラスとの違いを書く長い見出し |'))
    (ws.deck_dir('tbl') / 'styles' / 'slides.css').write_text('#stage table :is(th,td):first-child{white-space:nowrap}')
    open_deck(page, srv, 'tbl'); ready(page)
    first = cell(page, '問題クラス')
    assert first.evaluate('e => e.scrollWidth <= e.clientWidth')
    assert first.bounding_box()['height'] > cell(page, '二行目').bounding_box()['height'] * 1.5
    assert not page.errors
