"""下書き（decks/<発表>/memo.md）。設計書 §10.7。

左の欄の［下書き］タブで書き、下書きのチャット（ai/chat.py の mode "memo"）で AI と直す。
スライドには入らないので、変わっても描き直さない（server.py）。保存は原稿と同じく版（sha256）を合わせる。
"""
from __future__ import annotations

import re

from . import source
from .fsutil import sha256_text, write_atomic
from .workspace import TEMPLATES, StudioError, Workspace

_ATTRS = r"\{\s*(?:[#.]|[\w-]+=)[^}]*\}"
_SPAN = re.compile(r"\[([^\[\]]*)\]" + _ATTRS)  # [語]{.class}
_TAIL = re.compile(r"\s*" + _ATTRS + r"\s*$")  # 見出し・画像の末尾の {…}


class MemoConflict(StudioError):
    def __init__(self, current: dict):
        super().__init__("外で変更されました")
        self.current = current


def rel(deck: str) -> str:
    return f"decks/{deck}/memo.md"


def read(ws: Workspace, deck: str) -> dict:
    """まだ無ければ空（保存したときに作る）。"""
    path = ws.memo(deck)
    ws.require_deck(deck)
    text = path.read_text() if path.is_file() else ""
    return {"text": text, "version": sha256_text(text), "exists": path.is_file()}


def _plain(block: str) -> str:
    """1つのまとまりを下書きの書き方にする：図は html-名前、飾りの指定は除く。"""
    block = block.strip()
    if args := source.fig_args(block):
        return f"html-{args['ref'].rsplit('/', 1)[-1]}"
    if source.IMAGE_LINE.match(block):
        return _TAIL.sub("", block)
    count = 1
    while count:
        block, count = _SPAN.subn(r"\1", block)
    return "\n".join(_TAIL.sub("", line) if line.startswith("#") else line for line in block.split("\n"))


def _blocks(text: str, chunks: list[source.Chunk], skip: set[str]):
    for c in chunks:
        raw = text[c.start:c.end]
        if c.container:
            yield from _blocks(text, c.children, skip)
        elif c.kind == "opaque":
            # 飾りの囲み（.lead など）の中も文。生の HTML・発表者ノートは載せない
            if c.open and "notes" not in c.attrs.classes:
                inner = "\n".join(line for line in raw.split("\n") if not source.DIV_OPEN.match(line) and not source.DIV_CLOSE.match(line))
                for block in filter(None, map(_plain, re.split(r"\n[ \t]*\n", inner))):
                    if "footnote-small" in c.attrs.classes and not block.startswith("＊"):
                        block = "＊" + block
                    yield block
        elif raw.strip() not in skip:
            yield _plain(raw)


def from_slides(ws: Workspace, deck: str) -> str:
    """原稿の文と挿入した要素だけを下書きの本文（構成・内容）の形にする。載せるものが無ければ空。"""
    blank = source.parse((TEMPLATES / "deck" / "slides.qmd").read_text())
    skip = {blank.text[c.start:c.end].strip() for p in blank.pages for c in p.walk() if c.kind == "text"}
    doc = source.parse(ws.qmd(deck).read_text())
    found = False
    pages = []
    for p in doc.pages:
        if "cover" in p.attrs.classes or p.generated:
            continue
        blocks = list(_blocks(doc.text, p.chunks, skip))
        found = found or bool(blocks)
        pages.append("\n\n".join([f"## {p.title}", *blocks]))
    return "\n\n".join(pages) + "\n" if found else ""


def write(ws: Workspace, deck: str, text: str, base: str) -> dict:
    cur = read(ws, deck)
    if base != cur["version"]:
        raise MemoConflict(cur)
    if text != cur["text"] or not cur["exists"]:
        write_atomic(ws.memo(deck), text)
    return {"version": sha256_text(text)}
