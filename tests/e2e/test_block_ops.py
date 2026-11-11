"""ブロックの操作（設計書 §10.4）：クリックは中身だけ、WASD・QE、⇧WASD の並べ替え、⌥WASD の追加、
端のつまみの大きさ、余白とその「すべてに」、持って動かす、矢印のページ移動。"""
import re

import pytest
from playwright.sync_api import expect

from e2e.conftest import open_deck, rendered
from slide_studio import figures, source

LONG = '長い段落' + 'あ' * 70

DECK = f'''---
title: "操作"
topic: test
theme: default
lang: ja
---

## 列 {{#cols}}

:::: {{.columns}}
::: {{.column}}
左の一。

左の二。

左の三。

左の四。
:::
::: {{.column}}
{LONG}

右の二。
:::
::::

## 並び {{#list}}

一。

二。

三。

四。

五。

## 画像 {{#media}}

![画像](images/a.svg){{width=200}}

{{{{< fig test/box height=200 >}}}}

::: {{.row}}
箱の中。
:::

## まとめ {{#end}}

終わり。
'''

FRAME = "document.querySelector('#slideBox iframe:not(.loading)')"


def setup(gui, page, text=DECK):
    ws, srv = gui
    ws.qmd('talk').write_text(text)
    (ws.asset_root('talk') / 'images/a.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>')
    figures.new_figure(ws, 'box', ws.shelf_dir('test'))
    open_deck(page, srv)
    ready(page)
    return ws, srv


def ready(page):
    page.wait_for_function("document.querySelector('#stage')?.dataset.blocks === 'ready'")


def frame(page):
    return page.frame_locator('#slideBox iframe:not(.loading)')


def go(page, index):
    page.evaluate(f'(i) => {FRAME}.contentWindow.deck.go(i)', index)


def selected(page, key):
    page.wait_for_function(f"(key) => [...{FRAME}.contentDocument.querySelectorAll('.slide-studio-selected')].some(e => (e.dataset.slideStudio ?? 'p' + e.dataset.page) === key)", arg=key)


def settled(page, ws, text):
    """原稿に text が入って保存し、描き直した表示に追いつくまで待つ。"""
    page.wait_for_function('(t) => document.querySelector(".raw textarea").value.includes(t)', arg=text)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert text in ws.qmd('talk').read_text()
    rendered(page, ws)
    ready(page)


def click(page, key):
    frame(page).locator(f'[data-slide-studio="{key}"]').first.click()
    selected(page, key)


def pages_except(text, index):
    doc = source.parse(text)
    p = doc.pages[index]
    return text[:p.start] + text[p.end:]


def drag(page, locator, dx, dy):
    b = locator.bounding_box()
    x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
    page.mouse.move(x, y); page.mouse.down()
    page.mouse.move(x + dx / 2, y + dy / 2, steps=3); page.mouse.move(x + dx, y + dy, steps=3)
    page.mouse.up()


def test_click_selects_content_and_q_e_layers(gui, page):
    ws, srv = setup(gui, page)
    # 列の中の段落を1回のクリックで選ぶ。下の帯はパンくず
    click(page, 'p0/0.0.1')
    expect(page.locator('#hintMsg .crumbs')).to_have_text('p1›横並び›列1›段落')
    # パンくずを押すとその層を選ぶ
    page.locator('#hintMsg .crumb', has_text='横並び').click(); selected(page, 'p0/0')
    # ページは層に数えない：いちばん外側のブロックで止まる
    page.keyboard.press('KeyQ'); selected(page, 'p0/0')
    expect(page.get_by_role('button', name='外側を選択')).to_be_disabled()
    # 内側はツールバーからも選べる（前に選んでいた子へ）
    page.get_by_role('button', name='内側を選択').click(); selected(page, 'p0/0.0')
    page.keyboard.press('KeyE'); selected(page, 'p0/0.0.1')
    # 枠の色は原稿のブロック表示の線と同じ層の色（段落は3層目、横並びは1層目）
    color = lambda key: frame(page).locator(f'[data-slide-studio="{key}"]').evaluate('e => getComputedStyle(e).outlineColor')
    assert color('p0/0.0.1') == 'rgb(134, 176, 60)'
    page.keyboard.press('KeyQ'); page.keyboard.press('KeyQ'); selected(page, 'p0/0')
    assert color('p0/0') == 'rgb(63, 160, 198)'
    page.keyboard.press('KeyE'); page.keyboard.press('KeyE'); selected(page, 'p0/0.0.1')
    # W／S は縦の並び、Esc で選択を外す
    page.keyboard.press('KeyS'); selected(page, 'p0/0.0.2')
    page.keyboard.press('KeyW'); page.keyboard.press('KeyW'); selected(page, 'p0/0.0.0')
    page.keyboard.press('Escape')
    page.wait_for_function(f"!{FRAME}.contentDocument.querySelector('.slide-studio-selected')")
    # スライドの外（ステージの空いている所）を押しても選択を外す
    click(page, 'p0/0.0.0')
    box = page.locator('#viewport').bounding_box()
    page.mouse.click(box['x'] + 6, box['y'] + 6)
    page.wait_for_function(f"!{FRAME}.contentDocument.querySelector('.slide-studio-selected')")
    expect(page.locator('#blockTools')).to_be_hidden()
    # ホバーの枠は中身だけ（囲みには出さない）。原稿のブロック表示の同じブロックも示す
    hovered = frame(page).locator('[data-slide-studio="p0/0.1.1"]')
    hovered.hover()
    outline = frame(page).locator('[data-slide-studio="p0/0.1"]').evaluate('e => getComputedStyle(e).outlineStyle')
    assert outline == 'none'
    assert hovered.evaluate('e => getComputedStyle(e).outlineStyle') == 'solid'
    expect(page.locator('#qblocks .box.hovered[data-key="p0/0.1.1"]')).to_have_count(1)
    page.mouse.move(2, 2)
    expect(page.locator('#qblocks .box.hovered')).to_have_count(0)
    assert not page.errors



def test_frame_color_by_kind(gui, page):
    """画像と図（生の HTML も）の枠は層によらず種類の色。原稿のブロック表示のカードの枠も同じ色。"""
    ws, srv = setup(gui, page)
    go(page, 2)
    tone = lambda key: frame(page).locator(f'[data-slide-studio="{key}"]').first.get_attribute('data-slide-studio-layer')
    page.wait_for_function(f"{FRAME}.contentDocument.querySelector('[data-slide-studio=\"p2/0\"]')?.dataset.slideStudioLayer === 'image'")
    assert (tone('p2/0'), tone('p2/1'), tone('p2/2')) == ('image', 'html', '1')
    click(page, 'p2/1')
    assert frame(page).locator('[data-slide-studio="p2/1"]').first.evaluate('e => getComputedStyle(e).outlineColor') == 'rgb(154, 107, 214)'
    expect(page.locator('#qblocks .page.cur .card[data-tone="image"]')).to_have_count(1)
    assert not page.errors


def test_handles_follow_line_and_end_reliably(gui, page):
    """つまみは枠の線の上にあり、動かしている間も線に付いていく。離したのが iframe にしか届かなくても終わり、
    動かしかけたまま別の所を選んでも残らない。余白のつまみは別のブロックへ移るとやめる。"""
    ws, srv = setup(gui, page)
    click(page, 'p0/0.0.1')
    line = lambda: page.evaluate(f"""() => {{ const w = {FRAME}, e = w.contentDocument.querySelector('[data-slide-studio="p0/0.0.1"]'),
      s = w.contentDocument.querySelector('#stage').getBoundingClientRect().width / 1280;
      return w.getBoundingClientRect().left + e.getBoundingClientRect().right + 5 * s; }}""")
    h = page.locator('.bh.edge-x').first
    mid = lambda: (lambda b: (b['x'] + b['width'] / 2, b['y'] + b['height'] / 2))(h.bounding_box())
    x, y = mid()
    assert abs(x - line()) < 1
    row_width = frame(page).locator('[data-slide-studio="p0/0"]').bounding_box()['width']
    expected_width = round(50 + 60 / row_width * 100)
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 60, y, steps=5)
    assert abs(mid()[0] - line()) < 1 and mid()[0] > x + 30
    page.evaluate(f"{FRAME}.contentWindow.dispatchEvent(new PointerEvent('pointerup', {{ bubbles: true }}))")
    expect(page.locator('.bh.on')).to_have_count(0)
    page.mouse.up()
    settled(page, ws, f'width="{expected_width}%"')
    page.keyboard.press('Escape')
    click(page, 'p0/0.0.1')
    x, y = mid()
    h.dispatch_event('pointerdown', {'button': 0, 'pointerId': 1, 'clientX': x, 'clientY': y})
    page.keyboard.press('Escape')
    expect(page.locator('.bh-layer .bh')).to_have_count(0)
    click(page, 'p0/0.0.1')
    page.get_by_role('button', name='内側の余白', exact=True).click()
    expect(page.locator('.bh.pad-y')).to_have_count(2)
    click(page, 'p0/0.0.2')
    expect(page.locator('.bh.pad-y')).to_have_count(0)
    expect(page.get_by_role('button', name='内側の余白', exact=True)).to_have_attribute('aria-pressed', 'false')
    assert not page.errors


def test_click_outside_block_returns_to_selection(gui, page):
    """文字の編集中は、別のブロックを押すとそのブロックを選ぶ。同じ段落内では文字・余白とも編集を続ける。"""
    ws, srv = setup(gui, page)
    go(page, 1)
    editing = frame(page).locator('.slide-studio-editing')
    def start(key):
        click(page, key); page.keyboard.press('Enter')
        expect(editing).to_have_count(1)
        expect(page.locator('#blockTools')).to_have_attribute('data-mode', 'format')
    start('p1/0'); page.keyboard.type('A')
    frame(page).locator('[data-slide-studio="p1/2"]').first.click()
    expect(editing).to_have_count(0); selected(page, 'p1/2')
    settled(page, ws, 'A一。')
    page.keyboard.press('Escape')
    start('p1/3')
    b = frame(page).locator('[data-slide-studio="p1/3"]').first.bounding_box()
    page.mouse.click(b['x'] + 3, b['y'] + b['height'] / 2)
    expect(editing).to_have_count(1)
    page.mouse.click(b['x'] + b['width'] - 30, b['y'] + b['height'] / 2)
    expect(editing).to_have_count(1)
    page.locator('#blockTools').get_by_role('button', name='外側を選択', exact=True).click()
    expect(editing).to_have_count(0); selected(page, 'p1/3')
    assert not page.errors

def test_a_d_follow_height_in_next_column(gui, page):
    ws, srv = setup(gui, page)
    click(page, 'p0/0.0.3')
    page.keyboard.press('KeyD'); selected(page, 'p0/0.1.1')  # 高さが近いのは「右の二」（同じ順番の位置ではない）
    page.keyboard.press('KeyA'); selected(page, 'p0/0.0.3')
    # 選んだ段落のツールバーが上の段落に重なるので、外してから押す
    page.keyboard.press('Escape'); click(page, 'p0/0.0.1')
    page.keyboard.press('KeyD'); selected(page, 'p0/0.1.0')
    page.keyboard.press('KeyQ'); selected(page, 'p0/0.1')
    page.keyboard.press('KeyA'); selected(page, 'p0/0.0')
    assert not page.errors


def test_shift_s_runs_without_waiting_and_undoes_once(gui, page):
    ws, srv = setup(gui, page)
    before = ws.qmd('talk').read_text()
    go(page, 1); click(page, 'p1/0')
    for _ in range(3):
        page.keyboard.press('Shift+KeyS')
    settled(page, ws, '二。\n\n三。\n\n四。\n\n一。\n\n五。')
    after = ws.qmd('talk').read_text()
    assert pages_except(after, 1) == pages_except(before, 1)
    selected(page, 'p1/3')
    # 続けた並べ替えは ⌘Z の1回で戻る
    page.keyboard.press('Meta+KeyZ')
    settled(page, ws, '一。\n\n二。\n\n三。')
    assert ws.qmd('talk').read_text() == before
    # 列の中では、並びの端で横並びの外へ出る。⇧D で隣の列へ
    go(page, 0); click(page, 'p0/0.0.0')
    page.keyboard.press('Shift+KeyD')
    settled(page, ws, '::: {.column}\n左の一。\n\n' + LONG)
    selected(page, 'p0/0.1.0')
    assert not page.errors


def test_alt_adds_block_and_empty_is_not_written(gui, page):
    ws, srv = setup(gui, page)
    before = ws.qmd('talk').read_text()
    go(page, 1); click(page, 'p1/0')
    page.keyboard.press('Alt+KeyS')
    expect(frame(page).locator('.slide-studio-new.slide-studio-editing')).to_have_count(1)
    page.keyboard.press('Escape')
    expect(frame(page).locator('.slide-studio-new')).to_have_count(0)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before
    selected(page, 'p1/0')
    page.keyboard.press('Alt+KeyS')
    page.keyboard.type('追加。')
    page.keyboard.press('Escape')
    settled(page, ws, '一。\n\n追加。\n\n二。')
    selected(page, 'p1/1')
    page.keyboard.press('Alt+KeyD')
    expect(frame(page).locator('.columns .slide-studio-new')).to_have_count(1)
    page.keyboard.type('右。')
    page.keyboard.press('Escape')
    settled(page, ws, ':::: {.columns}\n::: {.column}\n追加。\n:::\n::: {.column}\n右。\n:::\n::::')
    # 列の中で ⌥A：左に列を足す
    selected(page, 'p1/1.1.0')
    page.keyboard.press('Alt+KeyA')
    page.keyboard.type('中。')
    page.keyboard.press('Escape')
    settled(page, ws, '::: {.column}\n追加。\n:::\n::: {.column}\n中。\n:::\n::: {.column}\n右。\n:::')
    assert not page.errors


def test_handles_change_size_and_survive_reload(gui, page):
    ws, srv = setup(gui, page)
    go(page, 2); click(page, 'p2/0')
    drag(page, page.locator('#viewport .bh.corner').nth(3), 60, 0)
    page.wait_for_function('() => !document.querySelector(".raw textarea").value.includes("{width=200}")')
    settled(page, ws, '![画像](images/a.svg){width=')
    width = int(ws.qmd('talk').read_text().split('{width=')[1].split('}')[0].strip('"'))
    assert width > 230
    # 図は高さを書く
    click(page, 'p2/1')
    drag(page, page.locator('#viewport .bh.corner').nth(3), 0, -60)
    settled(page, ws, '{{< fig test/box height="')
    height = int(ws.qmd('talk').read_text().split('height="')[1].split('"')[0])
    # 箱は下の辺で最低の高さ
    click(page, 'p2/2.0'); page.keyboard.press('KeyQ'); selected(page, 'p2/2')
    drag(page, page.locator('#viewport .bh.edge-y'), 0, 50)
    settled(page, ws, '::: {.row style="min-height:')
    box_min = int(ws.qmd('talk').read_text().split('min-height:')[1].split('px')[0])
    # 列の辺で隣の列との幅の比
    go(page, 0); click(page, 'p0/0.0.0')
    drag(page, page.locator('#viewport .bh.edge-x'), 80, 0)
    settled(page, ws, '::: {.column width="')
    text = ws.qmd('talk').read_text()
    ws_ = [int(x.split('%')[0]) for x in text.split('::: {.column width="')[1:]]
    assert ws_[0] > ws_[1] and sum(ws_) == 100
    # 読み込み直しても同じ見た目
    open_deck(page, srv); ready(page)
    go(page, 2)
    page.wait_for_function(f"{FRAME}.contentDocument.querySelector('.slide.active img')?.getBoundingClientRect().width > 0")
    m = frame(page).locator('.slide.active').evaluate('''s => ({img: s.querySelector('img').offsetWidth, fig: s.querySelector('.animation').offsetHeight,
        box: s.querySelector('[data-slide-studio="p2/2"]').offsetHeight})''')
    assert m['img'] == width and m['fig'] == height and m['box'] >= box_min
    go(page, 0)
    cols = frame(page).locator('[data-slide-studio="p0/0"]').evaluate('e => [...e.children].map(c => c.style.width)')
    assert cols == [f'{ws_[0]}%', f'{ws_[1]}%']
    # ダブルクリックで書いた値を消す
    click(page, 'p0/0.0.0')
    page.locator('#viewport .bh.edge-x').dblclick()
    page.wait_for_function('() => !document.querySelector(".raw textarea").value.includes(".column width=")')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert '.column width=' not in ws.qmd('talk').read_text()
    assert not page.errors


def test_text_edit_after_padding(gui, page):
    # HTML の往復で消える末尾空白があっても、余白の操作後に編集できる。
    ws, srv = setup(gui, page, DECK.replace('二。\n', '二。 \n'))
    go(page, 1); click(page, 'p1/1')
    page.get_by_role('button', name='内側の余白', exact=True).click()
    drag(page, page.get_by_role('slider', name='下の余白'), 0, 71)
    settled(page, ws, '::: {style="padding:')
    selected(page, 'p1/1.0')
    paragraph = frame(page).locator('[data-slide-studio="p1/1.0"]')
    position = paragraph.evaluate('''el => {
      const r = document.createRange(); r.selectNodeContents(el);
      const text = r.getBoundingClientRect(), box = el.getBoundingClientRect();
      return {x:text.left-box.left+text.width/2, y:text.top-box.top+text.height/2};
    }''')
    paragraph.click(position=position)
    expect(paragraph).to_have_attribute('contenteditable', 'true')
    page.keyboard.press('End')
    page.keyboard.insert_text('追記')
    page.keyboard.press('Escape')
    settled(page, ws, '二。追記')
    assert '二。追記 \n:::' in ws.qmd('talk').read_text()
    assert 'slide-studio-quiet' not in ws.qmd('talk').read_text()
    paragraph.click(position=position)
    expect(paragraph).to_have_attribute('contenteditable', 'true')
    assert not page.errors


def test_padding_only_this_block_and_for_all(gui, page):
    ws, srv = setup(gui, page)
    before = ws.qmd('talk').read_text()
    css = ws.deck_dir('talk') / 'styles' / 'slides.css'
    go(page, 2)
    # 図の余白の初期値は0
    assert frame(page).locator('.animation[data-slide-studio="p2/1"]').evaluate('e => getComputedStyle(e).paddingTop') == '0px'
    go(page, 1); click(page, 'p1/1')
    page.get_by_role('button', name='内側の余白', exact=True).click()
    expect(page.locator('#viewport .bh-band')).to_have_count(4)
    drag(page, page.get_by_role('slider', name='上の余白'), 0, 30)
    settled(page, ws, '::: {style="padding:')
    assert '一。\n\n::: {style="padding:' in ws.qmd('talk').read_text() and '"}\n二。\n:::\n\n三。' in ws.qmd('talk').read_text()
    # 包みは層に数えない。本文には「すべてに」を出さない
    selected(page, 'p1/1.0')
    expect(page.locator('#hintMsg .crumbs')).to_have_text('p2›段落')
    expect(page.get_by_role('button', name='本文すべてに')).to_have_count(0)
    page.keyboard.press('KeyQ'); selected(page, 'p1/1.0')
    # 内側のつまみをダブルクリックすると包みも外れる
    page.get_by_role('slider', name='下の余白').dblclick()
    page.wait_for_function('() => !document.querySelector(".raw textarea").value.includes("padding:")')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before
    # 図：そのブロックだけ（pad=）→ すべてに（発表の CSS の変数にして、このブロックの値は消す）
    go(page, 2); ready(page); click(page, 'p2/1')
    page.get_by_role('button', name='内側の余白', exact=True).click()
    drag(page, page.get_by_role('slider', name='上の余白'), 0, 15)
    settled(page, ws, 'height=200 pad="')
    page.keyboard.press('Escape')
    page.get_by_role('button', name='図すべてに').click()
    page.wait_for_function('() => !document.querySelector(".raw textarea").value.includes("pad=")')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before
    assert '--fig-pad:' in css.read_text()
    page.wait_for_function(f"getComputedStyle({FRAME}.contentDocument.querySelector('[data-slide-studio=\"p2/1\"]')).paddingTop !== '0px'")
    # 画像だけの余白は {{style="padding:…"}}
    # 別のブロックへ移ると［余白］は外れる
    click(page, 'p2/0')
    expect(page.get_by_role('button', name='内側の余白', exact=True)).to_have_attribute('aria-pressed', 'false')
    page.get_by_role('button', name='内側の余白', exact=True).click()
    drag(page, page.get_by_role('slider', name='左の余白'), 20, 0)
    settled(page, ws, '{width=200 style="padding:')
    assert not page.errors


def drag_follows(page, name, dx, dy):
    """余白のつまみを動かし、離す前につまみが指の下にあることを確かめる（動かした向きだけ。辺の中央なので横の位置は変わりうる）"""
    h = page.get_by_role('slider', name=name)
    b = h.bounding_box(); x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
    page.mouse.move(x, y); page.mouse.down()
    page.mouse.move(x + dx / 2, y + dy / 2, steps=3); page.mouse.move(x + dx, y + dy, steps=3)
    a = h.bounding_box()
    assert abs(a['x'] + a['width'] / 2 - (x + dx)) < 3 if dx else abs(a['y'] + a['height'] / 2 - (y + dy)) < 3, name
    page.mouse.up()


def test_padding_handle_follows_pointer(gui, page):
    """余白のつまみは、余白を増やすと動く縁に付き、指に付いてくる。文字の下は枠が外へ伸び、上は中身が内へ押される。
    幅の決まった画像・図は枠が動かず、中身が内へ縮む。"""
    ws, srv = setup(gui, page)
    go(page, 1); click(page, 'p1/1')
    page.get_by_role('button', name='内側の余白', exact=True).click()
    for name in ('下の余白', '上の余白'):
        drag_follows(page, name, 0, 30)
        settled(page, ws, '::: {style="padding:')
        selected(page, 'p1/1.0')
    # 上も下も増えている（下を先に書き、上を足しても下は残る）
    v = [int(x) for x in re.findall(r'(\d+)px', re.search(r'padding:([^"]+)', ws.qmd('talk').read_text())[1])]
    t, b = v[0], v[2] if len(v) == 4 else v[0]
    assert t > 10 and b > 10, (t, b)
    go(page, 2); ready(page); click(page, 'p2/1')
    page.get_by_role('button', name='内側の余白', exact=True).click()
    drag_follows(page, '上の余白', 0, 15)
    settled(page, ws, 'height=200 pad="')
    click(page, 'p2/0')
    page.get_by_role('button', name='内側の余白', exact=True).click()
    drag_follows(page, '左の余白', 20, 0)
    settled(page, ws, '{width=200 style="padding:')
    assert not page.errors


@pytest.mark.parametrize('wrapped', [False, True])
@pytest.mark.parametrize('body', ['説明を書く。\\\n次の行。', '- 説明を書く。\n- 次の行。'])
def test_text_buffer_includes_leading_and_can_reach_zero(gui, page, wrapped, body):
    if wrapped:
        body = f'::: {{style="padding:12px"}}\n{body}\n:::'
    ws, srv = setup(gui, page, DECK.replace('二。\n\n三。', body + '\n\n三。'))
    go(page, 1)
    key = 'p1/1.0' if wrapped else 'p1/1'
    click(page, key)
    measure = '''el => {
      const box = el.parentElement.style.padding ? el.parentElement : el;
      const scale = document.querySelector('#stage').getBoundingClientRect().width / 1280;
      const r = box.getBoundingClientRect(), range = document.createRange();
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = [];
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent.trim()) nodes.push(n);
      const rects = nodes.map(n => { range.selectNodeContents(n); return range.getBoundingClientRect(); });
      return { top: (rects[0].top-r.top)/scale, bottom:(r.bottom-rects.at(-1).bottom)/scale,
        height:r.height/scale, lineGap:(rects.at(-1).top-rects[0].top)/scale };
    }'''
    paragraph = frame(page).locator(f'[data-slide-studio="{key}"]')
    before = paragraph.evaluate(measure)
    original = ws.qmd('talk').read_text()
    page.get_by_role('button', name='内側の余白', exact=True).click()
    assert paragraph.evaluate(measure) == before
    assert ws.qmd('talk').read_text() == original
    for side in ['top', 'bottom']:
        value = int(page.locator(f'.bh-band[data-side="{side}"]').get_attribute('data-value'))
        assert abs(value - before[side]) < 1
        assert value > (12 if wrapped else 0)  # 行間の分も余白に数える
    # 上下を別々に0へ。折り返し幅と行の間隔はそのまま。
    drag(page, page.get_by_role('slider', name='上の余白'), 0, -120)
    settled(page, ws, 'text-box:trim-both text')
    selected(page, 'p1/1.0')
    drag(page, page.get_by_role('slider', name='下の余白'), 0, -120)
    settled(page, ws, 'padding:0px 12px;')
    paragraph = frame(page).locator('[data-slide-studio="p1/1.0"]')
    after = paragraph.evaluate(measure)
    assert abs(after['top']) < 1
    assert abs(after['bottom']) < 1
    assert abs(after['lineGap'] - before['lineGap']) < 1
    assert abs(after['height'] - (before['height'] - before['top'] - before['bottom'])) < 1
    # 再読込後も同じ表示。解除すると個別の余白と trim が一緒に外れる。
    page.reload(); ready(page); go(page, 1); click(page, 'p1/1.0')
    assert frame(page).locator('[data-slide-studio="p1/1.0"]').evaluate(measure) == after
    page.get_by_role('button', name='内側の余白', exact=True).click()
    expect(page.locator('.bh-band[data-side="top"]')).to_have_attribute('data-value', '0')
    page.get_by_role('slider', name='下の余白').dblclick()
    page.wait_for_function('!document.querySelector(".raw textarea").value.includes("text-box:")')
    assert not page.errors


def test_drag_moves_block_and_to_other_page(gui, page):
    ws, srv = setup(gui, page)
    go(page, 1); click(page, 'p1/0')
    src = frame(page).locator('[data-slide-studio="p1/0"]').bounding_box()
    dst = frame(page).locator('[data-slide-studio="p1/2"]').bounding_box()
    page.mouse.move(src['x'] + src['width'] - 30, src['y'] + src['height'] / 2); page.mouse.down()
    page.mouse.move(src['x'] + 20, src['y'] + 20, steps=3)
    page.mouse.move(dst['x'] + 20, dst['y'] + dst['height'] - 2, steps=5)
    expect(page.locator('#viewport .bd-line')).to_have_count(1)
    page.mouse.up()
    settled(page, ws, '二。\n\n三。\n\n一。\n\n四。')
    selected(page, 'p1/2')
    # ページの帯に落とすと、そのページの最後へ
    src = frame(page).locator('[data-slide-studio="p1/2"]').bounding_box()
    strip = page.locator('#pagestrip button').nth(3).bounding_box()
    page.mouse.move(src['x'] + src['width'] - 30, src['y'] + src['height'] / 2); page.mouse.down()
    page.mouse.move(src['x'] + 30, src['y'] + 30, steps=3)
    page.mouse.move(strip['x'] + strip['width'] / 2, strip['y'] + strip['height'] / 2, steps=8)
    expect(page.locator('#pagestrip button.drop')).to_have_count(1)
    page.mouse.up()
    settled(page, ws, '終わり。\n\n一。\n')
    # Esc で取り消す
    go(page, 1); click(page, 'p1/0')
    before = ws.qmd('talk').read_text()
    src = frame(page).locator('[data-slide-studio="p1/0"]').bounding_box()
    page.mouse.move(src['x'] + src['width'] - 30, src['y'] + src['height'] / 2); page.mouse.down()
    page.mouse.move(src['x'] + 20, src['y'] + 120, steps=4)
    page.keyboard.press('Escape')
    page.mouse.up()
    expect(page.locator('#viewport .bd-line')).to_have_count(0)
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_arrows_move_page_while_selected(gui, page):
    ws, srv = setup(gui, page)
    go(page, 1); click(page, 'p1/2')
    page.keyboard.press('ArrowDown')
    page.wait_for_function(f"{FRAME}.contentWindow.deck.index === 2")
    page.keyboard.press('ArrowUp')
    page.wait_for_function(f"{FRAME}.contentWindow.deck.index === 1")
    click(page, 'p1/2')
    page.keyboard.press('ArrowRight')
    page.wait_for_function(f"{FRAME}.contentWindow.deck.index === 2")
    assert not page.errors


def test_rail_uses_same_keys_and_gutter(gui, page):
    ws, srv = setup(gui, page)
    before = ws.qmd('talk').read_text()
    css = ws.deck_dir('talk') / 'styles' / 'slides.css'
    go(page, 1)
    page.click('#blocksMode')
    page.wait_for_function('() => document.querySelector("#qblocks .page.cur")?.dataset.page === "1"')
    page.locator('#qblocks .page.cur .rail[data-key="p1/0"]').click()
    # 原稿のブロック表示で線を選んでいるときも同じキー。フォーカスは選んだ線へ移る
    page.keyboard.press('KeyS'); selected(page, 'p1/1')
    page.wait_for_function('() => document.activeElement?.dataset.key === "p1/1"')
    page.keyboard.press('Shift+KeyS')
    settled(page, ws, '一。\n\n三。\n\n二。\n\n四。')
    page.click('#undo')
    settled(page, ws, '一。\n\n二。\n\n三。')
    assert ws.qmd('talk').read_text() == before
    # 横並びの［余白］は列の間。すべてにすると発表の CSS
    go(page, 0); ready(page); click(page, 'p0/0.0.0'); page.keyboard.press('KeyQ'); page.keyboard.press('KeyQ'); selected(page, 'p0/0')
    page.get_by_role('button', name='列の間隔', exact=True).click()
    drag(page, page.get_by_role('slider', name='列の間'), 10, 0)
    settled(page, ws, ':::: {.columns style="--gutter:')
    page.keyboard.press('Escape')
    page.get_by_role('button', name='横並びすべてに').click()
    page.wait_for_function('() => !document.querySelector(".raw textarea").value.includes("--gutter")')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert ws.qmd('talk').read_text() == before and '--gutter:' in css.read_text()
    assert not page.errors


def test_html_resize_keeps_ratio_and_exposes_column_width(gui, page):
    ws, srv = setup(gui, page)
    ws.qmd('talk').write_text(DECK.replace('左の一。', '{{< fig test/box height=300 >}}').replace('::: {.column}', '::: {.column width=40%}', 1))
    open_deck(page, srv); ready(page)
    fig = frame(page).locator('.slide.active .animation')
    page.wait_for_function(f"{FRAME}.contentDocument.querySelector('.animation').style.getPropertyValue('--fig-ratio') !== ''")

    def dimensions():
        # 枠の大きさが変わると図がバッファを取り直して縦横比を渡し直すので、落ち着くまで待つ
        prev = None
        for _ in range(50):
            d = fig.evaluate('e => ({w:e.getBoundingClientRect().width, h:e.getBoundingClientRect().height, r:parseFloat(e.style.getPropertyValue("--fig-ratio"))})')
            if prev and abs(d['w'] - prev['w']) < .5 and abs(d['h'] - prev['h']) < .5:
                return d
            prev = d
            page.wait_for_timeout(100)
        return d

    before = dimensions()
    assert abs(before['w'] / before['h'] - before['r']) < .02
    click(page, 'p0/0.0.0')
    expect(page.locator('#viewport .bh.corner')).to_have_count(4)
    expect(page.locator('#viewport .bh.edge-x')).to_have_count(1)
    # 高さだけを増やしても、列幅に制限された図は縦に伸びない。
    drag(page, page.locator('#viewport .bh.corner').nth(3), 0, 40)
    settled(page, ws, '{{< fig test/box height="')
    after = dimensions()
    assert abs(after['w'] / after['h'] - after['r']) < .02
    assert abs(after['w'] - before['w']) < 2
    assert abs(after['h'] - before['h']) < 2
    # 図を選んだまま列幅を広げると、図の幅・高さが一緒に増える。
    click(page, 'p0/0.0.0')
    drag(page, page.locator('#viewport .bh.edge-x'), 45, 0)
    settled(page, ws, '::: {.column width="')
    wider = dimensions()
    assert wider['w'] > after['w'] + 5
    assert abs(wider['w'] / wider['h'] - wider['r']) < .02
    open_deck(page, srv); ready(page)
    page.wait_for_function(f"{FRAME}.contentDocument.querySelector('.animation').style.getPropertyValue('--fig-ratio') !== ''")
    restored = dimensions()
    assert abs(restored['w'] - wider['w']) < 2
    assert abs(restored['w'] / restored['h'] - restored['r']) < .02
    assert not page.errors


def test_framed_block_outer_spacing_starts_from_default(gui, page):
    text = DECK.replace('二。\n\n三。', '::: {style="--block-design:top"}\n二。\n:::\n\n三。')
    ws, srv = setup(gui, page, text)
    go(page, 1); click(page, 'p1/1.0')
    page.keyboard.press('KeyQ'); selected(page, 'p1/1')  # 本文と枠を別々に選ぶ
    page.get_by_role('button', name='内側の余白', exact=True).click()
    page.keyboard.down('KeyF')
    h = page.get_by_role('slider', name='下の外側余白')
    expect(h).to_be_visible()
    rect = h.bounding_box(); x, y = rect['x'] + rect['width']/2, rect['y'] + rect['height']/2
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x, y + 14, steps=3); page.mouse.up()
    page.keyboard.up('KeyF')
    settled(page, ws, '--block-space:20px 10px ')
    assert not page.errors


def test_outer_spacing_meta_and_bordered_neighbors(gui, page):
    text = DECK.replace('二。\n\n三。', '::: {style="border:2px solid red;padding:8px"}\n二。\n:::\n\n::: {style="border:2px solid blue;--block-space:8px 0px 0px 0px"}\n三。\n:::')
    ws, srv = setup(gui, page, text)
    original_raw = page.locator('.raw textarea').input_value()
    go(page, 1); click(page, 'p1/1.0')
    page.keyboard.press('KeyQ'); selected(page, 'p1/1')
    a = frame(page).locator('[data-slide-studio="p1/1"]')
    b = frame(page).locator('[data-slide-studio="p1/2"]')
    height = a.bounding_box()['height']
    gap = b.bounding_box()['y'] - a.bounding_box()['y'] - height
    page.get_by_role('button', name='内側の余白', exact=True).click()
    page.keyboard.down('KeyF')
    expect(page.get_by_role('slider', name='下の外側余白')).to_be_visible()
    # ドラッグ途中で F を離しても外側を変更し続ける。終了後は内側に戻る。
    h = page.get_by_role('slider', name='下の外側余白')
    rect = h.bounding_box(); x, y = rect['x'] + rect['width']/2, rect['y'] + rect['height']/2
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x, y + 10, steps=3)
    page.keyboard.up('KeyF'); page.mouse.move(x, y + 24, steps=3); page.mouse.up()
    settled(page, ws, '--block-space:0px 0px')
    expect(page.get_by_role('slider', name='下の余白', exact=True)).to_be_visible()
    assert abs(a.bounding_box()['height'] - height) < 1
    assert abs((b.bounding_box()['y'] - a.bounding_box()['y'] - height) - (gap + 24)) < 1
    assert a.evaluate('e => getComputedStyle(e).paddingBottom') == '8px'
    page.keyboard.press('Escape')
    page.get_by_role('button', name='外側の余白', exact=True).click()
    page.screenshot(path='/tmp/slide-studio-outer-spacing.png')
    page.get_by_role('slider', name='下の外側余白').dblclick()
    expect(page.locator('.raw textarea')).to_have_value(original_raw)
    expect(page.locator('#status')).to_have_text('保存済み')
    rendered(page, ws)
    assert ws.qmd('talk').read_text() == text
    assert not page.errors



def test_spacing_keys_and_hover_preview(gui, page):
    # R・F はブロックを選んでいるときだけ。押している間とボタンにカーソルを合わせている間だけ、そのつまみを出す
    ws, srv = setup(gui, page)
    go(page, 1)
    page.keyboard.down('KeyR')
    expect(page.get_by_role('slider', name='下の余白', exact=True)).to_have_count(0)
    page.keyboard.up('KeyR')
    click(page, 'p1/1')
    page.keyboard.down('KeyF')
    expect(page.get_by_role('slider', name='下の外側余白')).to_be_visible()
    expect(page.locator('#blockTools')).to_be_hidden()
    page.keyboard.up('KeyF')
    expect(page.locator('#blockTools')).to_be_visible()
    expect(page.get_by_role('slider', name='下の外側余白')).to_have_count(0)
    page.keyboard.down('KeyR')
    expect(page.get_by_role('slider', name='下の余白', exact=True)).to_be_visible()
    page.keyboard.up('KeyR')
    expect(page.get_by_role('slider', name='下の余白', exact=True)).to_have_count(0)
    page.get_by_role('button', name='外側の余白', exact=True).hover()
    expect(page.get_by_role('slider', name='下の外側余白')).to_be_visible()
    page.mouse.move(5, 5)
    expect(page.get_by_role('slider', name='下の外側余白')).to_have_count(0)
    # Esc で余白の調整を終え、選択を残す。
    outer = page.get_by_role('button', name='外側の余白', exact=True)
    outer.click(); expect(page.locator('#blockTools')).to_be_hidden()
    page.keyboard.press('Escape')
    expect(outer).to_have_attribute('aria-pressed', 'false')
    selected(page, 'p1/1')
    assert ws.qmd('talk').read_text() == DECK
    assert not page.errors


def test_outer_spacing_media_reload_shift_and_cancel(gui, page):
    ws, srv = setup(gui, page)
    go(page, 2); click(page, 'p2/0')
    page.keyboard.down('KeyF')
    page.keyboard.down('Shift')
    drag(page, page.get_by_role('slider', name='下の外側余白'), 0, 12)
    page.keyboard.up('Shift'); page.keyboard.up('KeyF')
    settled(page, ws, '--block-space:')
    original = ws.qmd('talk').read_text()
    assert re.search(r'--block-space:\d+px"', original)
    page.reload(); ready(page); go(page, 2); click(page, 'p2/0')
    image = frame(page).locator('#media img')
    assert image.evaluate('e => e.parentElement.classList.contains("slide-studio-space")')
    page.keyboard.down('KeyF')
    h = page.get_by_role('slider', name='下の外側余白')
    b = h.bounding_box(); x, y = b['x']+b['width']/2, b['y']+b['height']/2
    before = image.evaluate('e => e.style.getPropertyValue("--block-space")')
    page.mouse.move(x,y); page.mouse.down(); page.mouse.move(x,y+10,steps=3)
    h.dispatch_event('pointercancel')
    page.mouse.up(); page.keyboard.up('KeyF')
    assert image.evaluate('e => e.style.getPropertyValue("--block-space")') == before
    assert ws.qmd('talk').read_text() == original
    click(page, 'p2/1')
    page.get_by_role('button', name='外側の余白', exact=True).click()
    drag_follows(page, '下の外側余白', 0, 12)
    settled(page, ws, 'height=200 space="')
    page.wait_for_function(f"{FRAME}.contentDocument.querySelector('.animation').parentElement.classList.contains('slide-studio-space')")
    assert not page.errors



@pytest.mark.parametrize('control', ['button', 'handle'])
def test_spacing_control_release_outside_keeps_selection(gui, page, control):
    ws, srv = setup(gui, page)
    go(page, 1); click(page, 'p1/1')
    outer = page.get_by_role('button', name='外側の余白', exact=True)
    if control == 'handle':
        outer.click()
    target = outer if control == 'button' else page.get_by_role('slider', name='下の外側余白')
    rect = target.bounding_box()
    page.mouse.move(rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2)
    page.mouse.down()
    # 押した操作部から外へ離しても、その一連の操作では選択を解除しない。
    viewport = page.locator('#viewport').bounding_box()
    page.mouse.move(viewport['x'] + 4, viewport['y'] + 4, steps=3)
    page.mouse.up()
    if control == 'button':
        expect(page.locator('#blockTools')).to_be_visible()
    else:
        expect(page.locator('#blockTools')).to_be_hidden()
    selected(page, 'p1/1')
    page.locator('#status').click()
    expect(page.locator('#blockTools')).to_be_hidden()
    assert ws.qmd('talk').read_text() == DECK
    assert not page.errors


@pytest.mark.parametrize('return_to_start', [False, True])
def test_unchanged_outer_spacing_preserves_source(gui, page, return_to_start):
    ws, srv = setup(gui, page)
    go(page, 1); click(page, 'p1/1')
    original_raw = page.locator('.raw textarea').input_value()
    paragraph = frame(page).locator('[data-slide-studio="p1/1"]')
    page.get_by_role('button', name='外側の余白', exact=True).click()
    handle = page.get_by_role('slider', name='下の外側余白')
    rect = handle.bounding_box()
    x, y = rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2
    page.mouse.move(x, y); page.mouse.down()
    # 0未満へ動かす操作と、一度増やしてから元へ戻す操作は原稿を変えない。
    # pointermoveを確実に処理し、移動イベントが省略されて通ることを避ける。
    for dy in ([30, 0] if return_to_start else [-30]):
        handle.dispatch_event('pointermove', {'pointerId': 1, 'buttons': 1, 'clientX': x, 'clientY': y + dy})
    page.mouse.up()
    expect(page.locator('.raw textarea')).to_have_value(original_raw)
    selected(page, 'p1/1')
    assert paragraph.evaluate('e => e.style.getPropertyValue("--block-space")') == ''
    assert ws.qmd('talk').read_text() == DECK
    assert not page.errors


def test_spacing_handle_release_keeps_selection(gui, page):
    ws, srv = setup(gui, page)
    go(page, 1); click(page, 'p1/1')
    page.get_by_role('button', name='外側の余白', exact=True).click()
    # 一時的に内側のつまみへ切り替え、押している途中でキーを離す。
    # pointerup で外側のつまみに描き直されても、その操作は外側クリックではない。
    page.keyboard.down('KeyR')
    handle = page.get_by_role('slider', name='下の余白', exact=True)
    rect = handle.bounding_box()
    page.mouse.move(rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2)
    page.mouse.down()
    page.keyboard.up('KeyR')
    page.mouse.up()
    expect(page.locator('#blockTools')).to_be_hidden()
    selected(page, 'p1/1')
    expect(page.get_by_role('slider', name='下の外側余白')).to_be_visible()
    # 次の本当の外側クリックは解除する。
    page.locator('#status').click()
    expect(page.locator('#blockTools')).to_be_hidden()
    assert ws.qmd('talk').read_text() == DECK
    assert not page.errors


def test_spacing_choices_and_tooltip_do_not_cover_selection(gui, page):
    ws, srv = setup(gui, page)
    go(page, 1); click(page, 'p1/1')
    inner = page.get_by_role('button', name='内側の余白', exact=True)
    outer = page.get_by_role('button', name='外側の余白', exact=True)
    expect(inner).to_be_visible()
    expect(outer).to_be_visible()
    inner.click()
    expect(page.locator('#blockTools')).to_be_hidden()
    expect(page.get_by_role('slider', name='下の余白', exact=True)).to_be_visible()
    page.screenshot(path='/tmp/slide-studio-spacing-hidden.png')
    page.keyboard.press('Escape')
    selected(page, 'p1/1')
    outer.click()
    expect(page.locator('#blockTools')).to_be_hidden()
    expect(page.get_by_role('slider', name='下の外側余白')).to_be_visible()
    page.keyboard.press('Escape')
    page.get_by_role('button', name='内側の余白', exact=True).hover()
    expect(page.locator('.tip.show')).to_be_visible()
    tip = page.locator('.tip.show').bounding_box()
    bar = page.locator('#blockTools').bounding_box()
    assert tip['y'] + tip['height'] <= bar['y'] or tip['y'] >= bar['y'] + bar['height']
    selected_rect = frame(page).locator('[data-slide-studio="p1/1"]').bounding_box()
    assert tip['y'] + tip['height'] <= selected_rect['y'] or tip['y'] >= selected_rect['y'] + selected_rect['height']
    page.screenshot(path='/tmp/slide-studio-spacing-choices.png')
    assert ws.qmd('talk').read_text() == DECK


def test_outer_spacing_keeps_existing_paragraph_gap(gui, page):
    ws, srv = setup(gui, page)
    go(page, 1); click(page, 'p1/1')
    def gap():
        return page.evaluate(f"""() => {{
          const d = {FRAME}.contentDocument, ps = d.querySelectorAll('#list p');
          return ps[2].getBoundingClientRect().top - ps[1].getBoundingClientRect().bottom;
        }}""")
    before = gap()
    page.keyboard.down('KeyF')
    drag_follows(page, '下の外側余白', 0, 20)
    page.keyboard.up('KeyF')
    settled(page, ws, '--block-space:')
    assert abs(gap() - before - 20) < 1
    page.reload(); ready(page); go(page, 1)
    assert abs(gap() - before - 20) < 1
