"""一覧：# ごとの列、ボタンとキー、step めくり、押すとそのページの最初へ（編集画面・書き出しの HTML）。"""
import re

import pytest
from playwright.sync_api import expect

from e2e.conftest import open_deck
from slide_studio import shots

STEPS = '''

## 段階表示 {#steps}

最初から見える段落。

::: {data-step="1"}
step 1 から見える段落。
:::

[強調する語]{.highlight data-highlight-step="2"} を含む段落。
'''
SCREEN = '.overview-screen'


@pytest.fixture
def stepped(gui, monkeypatch):
    monkeypatch.setattr(shots, "ENABLED", True)
    ws, srv = gui
    qmd = ws.qmd("talk")
    qmd.write_text(qmd.read_text().replace("\n## まとめ {#summary}", STEPS + "\n## まとめ {#summary}"))
    return gui


def thumb(page, title):
    return page.locator(f'{SCREEN} button[data-index]').filter(has_text=title)


def test_groups_by_chapter_and_keys(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.get_by_role('button', name='一覧を表示').click()
    expect(page.locator(f'{SCREEN} h2')).to_have_text(['表紙', '本編', 'Appendix'])
    rows = page.locator(f'{SCREEN} .overview-group')
    expect(rows.nth(0).locator('button[data-index]')).to_have_count(1)
    expect(rows.nth(1).locator('button[data-index]').first).to_contain_text('本編')
    # 同じ # のページは横に並ぶ
    boxes = rows.nth(1).locator('button[data-index]').evaluate_all('els => els.map(e => e.getBoundingClientRect().top)')
    assert len(boxes) > 1 and len(set(boxes)) == 1
    # 開いている間は編集画面のキーを動かさない
    index = page.evaluate("document.querySelector('#pagestrip button[aria-current=true]').dataset.index")
    page.keyboard.press('ArrowDown')
    assert page.evaluate("document.querySelector('#pagestrip button[aria-current=true]').dataset.index") == index
    page.keyboard.press('Escape')
    expect(page.locator(SCREEN)).to_have_count(0)
    page.keyboard.press('o')
    expect(page.locator(SCREEN)).to_have_count(1)
    page.keyboard.press('o')
    expect(page.locator(SCREEN)).to_have_count(0)
    assert not page.errors


def test_key_from_inside_the_slide(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    page.frame_locator('#slideBox iframe:not(.loading)').locator('#stage > .slide.active').click(position={'x': 5, 'y': 5})
    page.keyboard.press('o')
    expect(page.locator(SCREEN)).to_have_count(1)
    page.keyboard.press('Escape')
    expect(page.locator(SCREEN)).to_have_count(0)
    # 編集画面のスライドの中のキーは、隠れた HTML 用の一覧に取られない
    before = page.locator('#pageCount').text_content()
    page.frame_locator('#slideBox iframe:not(.loading)').locator('#stage > .slide.active').click(position={'x': 5, 'y': 5})
    page.keyboard.press('Escape')
    page.keyboard.press('ArrowDown')
    expect(page.locator('#pageCount')).not_to_have_text(before)
    assert not page.errors


def test_scrub_steps_and_open_first_step(stepped, page):
    ws, srv = stepped
    open_deck(page, srv, raw=False)
    page.keyboard.press('o')
    b = thumb(page, '段階表示')
    i = int(b.get_attribute('data-index'))
    expect(b.locator('.steps i')).to_have_count(3, timeout=30000)
    # カーソルが乗っていないときは最後の step
    assert b.locator('.steps i').nth(2).get_attribute('class') == 'on'
    box = b.bounding_box()
    srcs = []
    for k in range(3):
        page.mouse.move(box['x'] + box['width'] * (k + .5) / 3, box['y'] + box['height'] / 2)
        expect(b.locator('.steps i').nth(k)).to_have_class('on')
        expect(b.locator('img.shot')).to_have_attribute('src', re.compile(rf's{k}\.png'))
        srcs.append(b.locator('img.shot').get_attribute('src'))
    assert [f's{k}.png' in s for k, s in enumerate(srcs)] == [True] * 3
    # 帯と同じく、めくった位置にかかわらず最初の step を開く
    page.mouse.click(box['x'] + box['width'] * 1.5 / 3, box['y'] + box['height'] / 2)
    expect(page.locator(SCREEN)).to_have_count(0)
    expect(page.locator('#pageCount')).to_have_text(f'{i + 1}ページ')
    expect(page.locator('#stepCount')).to_have_text('1 / 3')
    assert not page.errors


def test_exported_html_scrubs_steps(stepped, page):
    ws, srv = stepped
    page.goto(f'{srv.url}/files/decks/talk/__slide-studio_preview__.html?edit=0')
    page.wait_for_function('window.deckReady === true')
    page.keyboard.press('o')
    expect(page.locator('#overview')).to_be_visible()
    expect(page.locator('#overview > h2')).to_have_text(['表紙', '本編', 'Appendix'])
    b = page.locator('#overview .thumb').filter(has_text='段階表示')
    i = int(b.get_attribute('data-index'))
    b.scroll_into_view_if_needed()
    copy = b.locator('.slide')
    expect(b.locator('.thumb-steps i')).to_have_count(3)
    assert copy.locator('[data-step].pending').count() == 0
    assert copy.locator('.is-highlighted').count() == 1
    box = b.bounding_box()
    y = box['y'] + box['height'] / 2
    page.mouse.move(box['x'] + box['width'] / 6, y)
    expect(b.locator('.thumb-steps i').nth(0)).to_have_class('on')
    expect(copy.locator('[data-step].pending')).to_have_count(1)
    assert copy.locator('.is-highlighted').count() == 0
    page.mouse.move(box['x'] + box['width'] * 5 / 6, y)
    expect(copy.locator('.is-highlighted')).to_have_count(1)
    page.mouse.move(box['x'] + box['width'] * 3 / 6, y)
    expect(b.locator('.thumb-steps i').nth(1)).to_have_class('on')
    page.mouse.click(box['x'] + box['width'] * 3 / 6, y)
    expect(page.locator('#overview')).to_be_hidden()
    assert page.evaluate('[deck.index, deck.step]') == [i, 0]
    # 戻る操作でページをまたぐときも、途中・最後の step を引き継がない。
    page.evaluate('(i) => deck.go(i, 2)', i)
    page.keyboard.press('ArrowDown')
    page.keyboard.press('ArrowLeft')
    assert page.evaluate('[deck.index, deck.step]') == [i, 0]
    page.evaluate('(i) => deck.go(i, 2)', i)
    page.reload()
    page.wait_for_function('window.deckReady === true')
    assert page.evaluate('[deck.index, deck.step]') == [i, 0]
    # o でも閉じる
    page.keyboard.press('o')
    expect(page.locator('#overview')).to_be_visible()
    page.keyboard.press('o')
    expect(page.locator('#overview')).to_be_hidden()
    assert not page.errors
