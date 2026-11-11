"""AI の実行中に画面から直せない範囲（ページ・図）と、並行して書かれた原稿の合流。"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from . import source

FIG = re.compile(r'\{\{<\s*fig\s+"?([^"\s>]+)"?[^>]*>\}\}')


def _hunks(base: list[str], other: list[str]) -> list[tuple[int, int, list[str]]]:
    ops = SequenceMatcher(None, base, other, autojunk=False).get_opcodes()
    return [(i1, i2, other[j1:j2]) for tag, i1, i2, j1, j2 in ops if tag != "equal"]


def merge3(base: str, mine: str, theirs: str) -> str | None:
    """行単位の3方向の合流。同じ行を両方が別々に変えていれば None。"""
    lines = base.splitlines(keepends=True)
    hunks = sorted(_hunks(lines, mine.splitlines(keepends=True)) + _hunks(lines, theirs.splitlines(keepends=True)),
                   key=lambda h: (h[0], h[1]))
    out, at, last = [], 0, None
    for hunk in hunks:
        if hunk == last:
            continue
        start, end, new = hunk
        if start < at or (last and last[0] == last[1] == start == end):
            return None
        out += lines[at:start] + new
        at, last = end, hunk
    return "".join(out + lines[at:])


def find_page(doc, spec: dict):
    """id のないページ（@番号）は、ページの増減でずれないよう見出しで探す。"""
    key = spec["key"]
    if not key.startswith("@"):
        return next((p for p in doc.pages if p.id == key), None)
    index = int(key[1:]) if key[1:].isdigit() else -1
    same = [p for p in doc.pages if not p.id and p.title == spec.get("title")]
    if same:
        return min(same, key=lambda p: abs(p.index - index))
    return doc.pages[index] if 0 <= index < len(doc.pages) else None


def _figure_lines(text: str, ref: str) -> list[str]:
    return sorted(m[0] for m in FIG.finditer(text) if m[1] == ref)


def touched(before: str, after: str, scope: dict) -> bool:
    """before から after への変更が、ロック中のページ・図にかかるか。"""
    old, new = source.parse(before), source.parse(after)
    for spec in scope["pages"]:
        page = find_page(old, spec)
        if page is None:
            continue
        now = find_page(new, spec)
        if now is None or before[page.start:page.end].rstrip() != after[now.start:now.end].rstrip():
            return True
    return any(_figure_lines(before, ref) != _figure_lines(after, ref) for ref in scope["figures"])


def mentions(text: str, scope: dict, path: str) -> bool:
    """ロック中のページの原文に path が書かれているか。"""
    doc = source.parse(text)
    pages = (find_page(doc, spec) for spec in scope["pages"])
    return any(page is not None and path in text[page.start:page.end] for page in pages)
