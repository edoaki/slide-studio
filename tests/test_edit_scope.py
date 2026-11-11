"""AI の実行中のロックの範囲と、原稿の合流（edit_scope.py）。"""
from slide_studio import edit_scope as es

BASE = "## 一 {#one}\n\n本文一\n\n## 二 {#two}\n\n本文二\n\n{{< fig nco/a width=3 >}}\n\n## 三 {#three}\n\n本文三\n"


def test_merge_keeps_both_sides_when_lines_differ():
    mine = BASE.replace("本文一", "利用者")
    theirs = BASE.replace("本文三", "AI")
    merged = es.merge3(BASE, mine, theirs)
    assert "利用者" in merged and "AI" in merged


def test_merge_keeps_pages_added_by_ai():
    theirs = BASE.replace("## 三 {#three}", "## 新 {#new}\n\nAI\n\n## 三 {#three}")
    merged = es.merge3(BASE, BASE.replace("本文一", "利用者"), theirs)
    assert "利用者" in merged and "## 新 {#new}" in merged


def test_merge_stops_when_same_line_changes():
    assert es.merge3(BASE, BASE.replace("本文二", "利用者"), BASE.replace("本文二", "AI")) is None


def test_merge_same_change_once():
    both = BASE.replace("本文二", "同じ")
    assert es.merge3(BASE, both, both) == both


def scope(pages=(), figures=()):
    return {"all": False, "pages": [{"key": k, "title": t} for k, t in pages], "figures": list(figures)}


def test_touched_only_for_locked_page():
    s = scope(pages=[("two", None)])
    assert es.touched(BASE, BASE.replace("本文二", "x"), s)
    assert not es.touched(BASE, BASE.replace("本文一", "x"), s)
    assert es.touched(BASE, BASE.replace("## 二 {#two}\n\n本文二\n\n{{< fig nco/a width=3 >}}\n\n", ""), s)


def test_touched_page_without_id_follows_inserted_pages():
    text = "## 一\n\n本文一\n\n## 二\n\n本文二\n"
    s = scope(pages=[("@1", "二")])
    added = "## 零\n\n本文零\n\n" + text
    assert not es.touched(text, added, s)
    assert es.touched(text, added.replace("本文二", "x"), s)


def test_touched_figure_line():
    s = scope(figures=["nco/a"])
    assert es.touched(BASE, BASE.replace("width=3", "width=5"), s)
    assert not es.touched(BASE, BASE.replace("本文二", "x"), s)
