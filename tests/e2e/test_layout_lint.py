"""編集中のレイアウトの検査の表示（設計書 §9.4）：スライドの上の枠・斜線・はみ出した量、ページの帯の印、上のバーの件数、ツールバーの印。色はすべて黄色。"""
import re

from playwright.sync_api import expect

from conftest import add_deck
from e2e.conftest import DECK, open_deck
from e2e.test_blocks import frame, go, ready

# 一枚目（3枚目のスライド）の段落をスライドの下の端へずらす
LOW = DECK.replace("二番目の段落。", "二番目の段落。\n\n::: {.low}\n下の段落。\n:::")


def mark(page, i):
    return page.locator(f'#pagestrip button[data-index="{i}"] .mark')


def test_layout_issues_on_slide_strip_and_toolbar(gui, page):
    ws, srv = gui
    d = add_deck(ws, "low", LOW)
    (d / "styles" / "slides.css").write_text("#stage .low p{position:absolute;left:64px;top:700px;margin:0}")
    open_deck(page, srv, "low", raw=False); ready(page)
    # ページの帯：はみ出したページだけに黄色の印。上のバーに件数
    expect(mark(page, 2)).to_have_class("mark warning")
    expect(mark(page, 3)).to_have_count(0)
    badge = page.locator(".lint-badge")
    expect(badge).to_be_visible()
    assert badge.get_attribute("data-tip") == "レイアウトの問題 1件（押すと次のページへ）"
    # 件数を押すと問題のページへ移り、スライドの上に枠とはみ出した量が出る
    badge.click()
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.index === 2")
    lint = frame(page).locator("#slide-studio-lint")
    expect(lint.locator(".slide-studio-lint-box")).to_have_count(1)
    expect(lint.locator(".slide-studio-lint-tab")).to_have_text(re.compile(r"^↓ \d+px$"))
    # 問題のブロックを選ぶと、ツールバーに印（内容はカーソルを合わせたときの説明）
    frame(page).locator(".low p").click(position={"x": 10, "y": 6})
    flag = page.locator("#blockTools .lint-flag")
    expect(flag).to_have_count(1)
    assert re.fullmatch(r"スライドの下に \d+px はみ出す", flag.get_attribute("data-tip"))
    # 別のページへ移ると枠は消える
    go(page, 3)
    expect(lint.locator("> *")).to_have_count(0)
    assert not page.errors


def test_layout_issues_follow_changes_in_slide(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False); ready(page)
    expect(page.locator("#pagestrip .mark")).to_have_count(0)
    expect(page.locator(".lint-badge")).to_be_hidden()
    go(page, 3)
    # スライドの中身が伸びたら（文字の編集・余白のつまみなど）測り直す
    grow = "(n) => { const p = document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('#two .column p'); p.dataset.orig ??= p.textContent; p.textContent = p.dataset.orig + '長い文。'.repeat(n); }"
    page.evaluate(grow, 150)
    expect(mark(page, 3)).to_have_class("mark warning")
    expect(frame(page).locator("#slide-studio-lint .slide-studio-lint-tab")).to_have_count(1)
    page.evaluate(grow, 0)
    expect(mark(page, 3)).to_have_count(0)
    expect(page.locator(".lint-badge")).to_be_hidden()
    assert not page.errors
