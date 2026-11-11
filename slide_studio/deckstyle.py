"""発表の styles/slides.css に書く余白の変数（画面の［（種類）すべてに］）。設計書 §10.4。

変数は印を付けた1つの規則にまとめ、その規則だけを書き換える。ほかの行はそのまま残す。
テーマはこの変数を `.reveal .slides section.slide` に置くので、同じ選択子で後から上書きする。
"""
from __future__ import annotations

import re

MARK = "/* Slide Studio の余白（画面から変更） */"
SELECTOR = ".reveal .slides section.slide"
NAMES = ("--img-pad", "--fig-pad", "--gutter")
VALUE = re.compile(r"^\d+(?:\.\d+)?px(?: \d+(?:\.\d+)?px){0,3}$")
BLOCK = re.compile(re.escape(MARK) + r"\n" + re.escape(SELECTOR) + r"\{([^{}]*)\}\n?")


def read_vars(css: str) -> dict[str, str]:
    m = BLOCK.search(css)
    if not m:
        return {}
    out = {}
    for decl in m[1].split(";"):
        if ":" in decl:
            k, v = decl.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def set_vars(css: str, values: dict[str, str | None]) -> str:
    """values の変数を書く（None は消す）。変数が無くなったら規則ごと消す。"""
    for k, v in values.items():
        if k not in NAMES or (v is not None and not VALUE.match(v)):
            raise ValueError(f"余白の値が正しくありません: {k}")
    current = read_vars(css)
    for k, v in values.items():
        if v is None:
            current.pop(k, None)
        else:
            current[k] = v
    block = f"{MARK}\n{SELECTOR}{{{';'.join(f'{k}:{v}' for k, v in current.items())}}}\n" if current else ""
    m = BLOCK.search(css)
    if m:
        return css[:m.start()] + block + css[m.end():]
    if not block:
        return css
    return css + ("" if not css or css.endswith("\n") else "\n") + block
