"""qmd の分割（原文チャンク方式）。設計書 §6.2。

描画（render.py）と書き戻し（GUI の編集）は、ここで作る同じ解析結果を使う。
位置はすべて原文の文字位置（str の添字）で持ち、書き戻しは触っていない部分を元の文字列のまま出す。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import yaml

from .cover import authors

FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
DIV_OPEN = re.compile(r"^ {0,3}(:{3,})[ \t]*(\{[^{}]*\}|[\w-]+)[ \t]*:*[ \t]*$")
DIV_CLOSE = re.compile(r"^ {0,3}:{3,}[ \t]*$")
HEADING = re.compile(r"^(#{1,2})[ \t]+(.*?)[ \t]*$")
ATTR_TAIL = re.compile(r"[ \t]*\{([^{}]*)\}[ \t]*$")
FIG_LINE = re.compile(r"^\{\{<\s*fig\s+(.*?)\s*>\}\}$")
IMAGE_LINE = re.compile(r"^!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?$")
FOOTNOTE_DEF = re.compile(r"^ {0,3}\[\^[^\]\s]+\]:")
LINK_DEF = re.compile(r"^ {0,3}\[[^\]^][^\]]*\]:[ \t]*\S")
RAW_HTML = re.compile(r"^ {0,3}<(?:[A-Za-z][\w-]*|!--)")
LIST_KIND = re.compile(r"^(?:([-*+])|\d+([.)]))[ \t]")
PAGE_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
BOX_KEYS = {"style", "data-step"}
# 表紙のタイトル・副題の囲み。中の文はふつうの本文として直す（余白・揃えの包みと同じ扱い）
COVER_PARTS = {"cover-title", "cover-subtitle"}
SHORTCODE = re.compile(r"\{\{<\s*([\w-]+)")
CROSSREF = re.compile(r"(?<![\w@])@(fig|tbl|sec|eq|lst|thm)-[\w-]+")


# ---------------------------------------------------------------- 属性


@dataclass
class Attrs:
    id: str = ""
    classes: list[str] = field(default_factory=list)
    kv: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {"id": self.id, "classes": self.classes, "kv": self.kv}


ATTR_TOKEN = re.compile(r"""#([^\s}]+)|\.([^\s}=]+)|([^\s=}]+)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s}]*))""")


def parse_attrs(inner: str) -> Attrs:
    a = Attrs()
    for m in ATTR_TOKEN.finditer(inner):
        if m[1]:
            a.id = m[1]
        elif m[2]:
            a.classes.append(m[2])
        else:
            value = m[4] if m[4] is not None else m[5] if m[5] is not None else m[6] or ""
            a.kv[m[3]] = value.replace('\\"', '"').replace("\\\\", "\\")
    return a


def div_attrs(line: str) -> Attrs:
    m = DIV_OPEN.match(line)
    if not m:
        return Attrs()
    spec = m[2]
    return parse_attrs(spec[1:-1]) if spec.startswith("{") else Attrs(classes=[spec])


# ---------------------------------------------------------------- 構造


@dataclass
class Chunk:
    kind: str  # text / image / fig / columns / column / box / opaque / def
    start: int  # 原文での開始位置
    end: int  # 終了位置（最後の行の改行は含まない）
    path: str  # ページの中の入れ子のパス（例 "1.0.2"）
    children: list["Chunk"] = field(default_factory=list)
    open: tuple[int, int] | None = None  # 囲みの開始行（start, end）
    close: tuple[int, int] | None = None  # 囲みの終了行
    attrs: Attrs | None = None

    @property
    def container(self) -> bool:
        return self.kind in ("columns", "column", "box")

    def walk(self):
        yield self
        for c in self.children:
            yield from c.walk()

    def to_json(self, text: str) -> dict:
        d = {"kind": self.kind, "path": self.path, "start": self.start, "end": self.end, "text": text[self.start:self.end]}
        if self.attrs is not None:
            d["attrs"] = self.attrs.to_json()
        if self.open:
            d["open"] = text[self.open[0]:self.open[1]]
            d["close"] = text[self.close[0]:self.close[1]] if self.close else ""
        if self.children:
            d["children"] = [c.to_json(text) for c in self.children]
        return d


@dataclass
class Page:
    index: int
    level: int  # 1 = 章扉（#）、2 = 1枚（##）
    title: str
    attrs: Attrs
    start: int  # 見出し行の先頭
    head_end: int  # 見出し行の終わり（改行を含まない）
    end: int  # 次のページの先頭（最後のページは文書の終わり）
    generated: str = ""  # 空の #toc / #refs の囲みで指定されたページ
    raw_only: bool = False
    chunks: list[Chunk] = field(default_factory=list)
    unclosed: list[str] = field(default_factory=list)  # このページで閉じていない囲み（"```" や ":::"）

    @property
    def id(self) -> str:
        return self.attrs.id

    def walk(self):
        for c in self.chunks:
            yield from c.walk()

    def to_json(self, text: str) -> dict:
        return {
            "index": self.index, "level": self.level, "title": self.title, "id": self.id,
            "classes": self.attrs.classes, "kv": self.attrs.kv,
            "start": self.start, "head_end": self.head_end, "end": self.end,
            "generated": self.generated, "raw_only": self.raw_only, "unclosed": self.unclosed,
            "chunks": [c.to_json(text) for c in self.chunks],
        }


@dataclass
class Doc:
    text: str
    front: tuple[int, int]  # front matter の範囲（無ければ (0, 0)）
    meta: dict
    meta_error: str
    pages: list[Page]
    unclosed_at: int | None  # 最初に閉じていない囲みの位置

    @property
    def body_start(self) -> int:
        return self.front[1]

    @property
    def preamble(self) -> str:
        end = self.pages[0].start if self.pages else len(self.text)
        return self.text[self.body_start:end]

    def page_of(self, offset: int) -> Page | None:
        for p in self.pages:
            if p.start <= offset < p.end:
                return p
        return None

    def to_json(self) -> dict:
        return {
            "front": list(self.front), "meta": self.meta, "meta_error": self.meta_error, "authors": authors(self.meta),
            "pages": [p.to_json(self.text) for p in self.pages],
        }


class _Lines:
    """行の位置（改行を含まない終わり）。"""

    def __init__(self, text: str):
        self.text = text
        self.starts: list[int] = []
        self.ends: list[int] = []
        pos = 0
        for line in text.split("\n"):
            self.starts.append(pos)
            self.ends.append(pos + len(line))
            pos += len(line) + 1
        if text.endswith("\n"):  # 最後の空の「行」は数えない
            self.starts.pop()
            self.ends.pop()

    def __len__(self):
        return len(self.starts)

    def __getitem__(self, i: int) -> str:
        return self.text[self.starts[i]:self.ends[i]]

    def blank(self, i: int) -> bool:
        return not self[i].strip()

    def index_at(self, offset: int) -> int:
        lo, hi = 0, len(self.starts)
        while lo < hi:
            mid = (lo + hi) // 2
            if self.starts[mid] <= offset:
                lo = mid + 1
            else:
                hi = mid
        return lo - 1


def _front_matter(text: str) -> tuple[int, dict, str]:
    if not text.startswith("---"):
        return 0, {}, ""
    m = re.match(r"---[ \t]*\n(.*?\n)?(?:---|\.\.\.)[ \t]*(\n|$)", text, re.S)
    if not m:
        return 0, {}, ""
    try:
        meta = yaml.safe_load(m[1] or "") or {}
        if not isinstance(meta, dict):
            return m.end(), {}, "front matter が辞書ではありません"
        if "topic" not in meta and "figures" in meta:
            meta["topic"] = meta["figures"]
        return m.end(), meta, ""
    except yaml.YAMLError as e:
        return m.end(), {}, f"front matter を読めません: {e}"


def _closing_fence(open_line: str) -> re.Pattern:
    m = FENCE_OPEN.match(open_line)
    ch = m[1][0]
    return re.compile(rf"^ {{0,3}}{re.escape(ch)}{{{len(m[1])},}}[ \t]*$")


class _Scan:
    """文書全体の囲み（コードと :::）の対応。"""

    def __init__(self, L: _Lines, first: int):
        n = len(L)
        self.code_close: dict[int, int] = {}  # コードの開始行 → 終了行
        self.div_close: dict[int, int | None] = {}  # ::: の開始行 → 終了行（閉じていなければ None）
        self.unclosed: list[tuple[int, str]] = []  # (行, 種類)
        in_code = [False] * n
        depth = [0] * n
        stack: list[int] = []
        i = first
        while i < n:
            s = L[i]
            if FENCE_OPEN.match(s) and not (FENCE_OPEN.match(s)[1][0] == "`" and "`" in FENCE_OPEN.match(s)[2]):
                close = _closing_fence(s)
                j = next((k for k in range(i + 1, n) if close.match(L[k])), None)
                if j is None:
                    # Pandoc は閉じていない ``` を普通の文字として読む。構造編集は止める（§6.2-5）
                    self.unclosed.append((i, "```"))
                    i += 1
                    continue
                self.code_close[i] = j
                for k in range(i, j + 1):
                    in_code[k] = True
                i = j + 1
                continue
            if DIV_OPEN.match(s):
                stack.append(i)
            elif DIV_CLOSE.match(s) and stack:
                self.div_close[stack.pop()] = i
            i += 1
        for o in stack:
            self.div_close[o] = None
            self.unclosed.append((o, ":::"))
        for o, c in self.div_close.items():
            if c is not None:
                for k in range(o + 1, c):
                    depth[k] += 1
        self.unclosed.sort()
        self.in_code = in_code
        self.depth = depth


def parse(text: str) -> Doc:
    front_end, meta, meta_error = _front_matter(text)
    L = _Lines(text)
    first = L.index_at(front_end) if front_end < len(text) else len(L)
    if first < 0:
        first = 0
    if front_end and first < len(L) and L.starts[first] < front_end:
        first += 1
    scan = _Scan(L, first)

    # 1. ページ分割：コードの中・閉じた ::: の中・段落の途中の # は見出しにしない
    heads: list[int] = []
    markers: dict[int, tuple[str, int]] = {}
    for i in range(first, len(L)):
        if scan.in_code[i] or scan.depth[i]:
            continue
        marker = div_attrs(L[i]).id if DIV_OPEN.match(L[i]) else ""
        close = scan.div_close.get(i)
        if marker in ("toc", "refs") and close is not None and all(L.blank(k) for k in range(i + 1, close)):
            # 見出しの直後ならそのページを使い、単独なら囲み自体をページの境界にする。
            previous = HEADING.match(L[heads[-1]]) if heads else None
            previous_attrs = ATTR_TAIL.search(previous[2]) if previous else None
            expected_id = "references" if marker == "refs" else "toc"
            if previous_attrs and parse_attrs(previous_attrs[1]).id == expected_id and all(L.blank(k) for k in range(heads[-1] + 1, i)):
                markers[heads[-1]] = (marker, close)
            else:
                heads.append(i)
                markers[i] = (marker, close)
            continue
        m = HEADING.match(L[i])
        if not m:
            continue
        prev_ok = i == first or L.blank(i - 1) or (heads and heads[-1] == i - 1)
        if prev_ok:
            heads.append(i)

    pages: list[Page] = []
    for n, i in enumerate(heads):
        m = HEADING.match(L[i])
        if i in markers:
            marker, close = markers[i]
            end = L.starts[heads[n + 1]] if n + 1 < len(heads) else len(text)
            title = "目次" if marker == "toc" else "参考文献"
            page_id = "toc" if marker == "toc" else "references"
            pages.append(Page(n, 2, title, Attrs(id=page_id, classes=[marker + "-slide"] + div_attrs(L[next(k for k in range(i, close) if DIV_OPEN.match(L[k]))]).classes),
                              L.starts[i], L.ends[close], end, generated=marker))
            continue
        raw_title = m[2]
        attrs = Attrs()
        am = ATTR_TAIL.search(raw_title)
        if am:
            attrs = parse_attrs(am[1])
            raw_title = raw_title[:am.start()]
        raw_title = re.sub(r"[ \t]+#+[ \t]*$", "", raw_title).strip()
        end = L.starts[heads[n + 1]] if n + 1 < len(heads) else len(text)
        pages.append(Page(n, len(m[1]), raw_title, attrs, L.starts[i], L.ends[i], end,
                          generated="refs" if attrs.id == "references" else ""))

    # 2. 閉じていない囲みがあるページから最後までを原文のみにする
    unclosed_at = None
    if scan.unclosed:
        line, _ = scan.unclosed[0]
        unclosed_at = L.starts[line]
        for p in pages:
            if p.end > unclosed_at:
                p.raw_only = True
        for line, kind in scan.unclosed:
            p = next((p for p in pages if p.start <= L.starts[line] < p.end), None)
            if p:
                p.unclosed.append(kind)

    # 3. チャンク分割
    for p in pages:
        if p.raw_only or p.generated:
            continue
        a = L.index_at(p.head_end) + 1
        b = L.index_at(p.end - 1) + 1 if p.end > p.head_end + 1 else a
        p.chunks = _chunks(L, scan, a, b, "")

    return Doc(text, (0, front_end), meta, meta_error, pages, unclosed_at)


def _list_kind(s: str) -> str | None:
    m = LIST_KIND.match(s)
    if not m:
        return None
    return "-" if m[1] else m[2]


def _blocks(L: _Lines, scan: _Scan, a: int, b: int) -> list[tuple[int, int]]:
    """行 a..b-1 を、空行で区切った最上位のまとまり（最初の行, 最後の行）に分ける。"""
    out: list[tuple[int, int]] = []
    cur: int | None = None
    last = -1
    i = a
    while i < b:
        s = L[i]
        if cur is None:
            if L.blank(i):
                i += 1
                continue
            prev = out[-1] if out else None
            # 字下げした続きと、同じ種類のリストの続きは、前のまとまりに戻す（mock の splitParas）
            if prev and (re.match(r"^[ \t]", s) or (_list_kind(s) and _list_kind(s) == _list_kind(L[prev[0]]))):
                cur = out.pop()[0]
            else:
                cur = i
        closer = scan.code_close.get(i, scan.div_close.get(i))
        if closer is not None:
            opened_block = cur == i
            last = min(closer, b - 1)
            i = last + 1
            # 囲みで始まったまとまりは、空行がなくても囲みの終わりで区切る（:::\n::: {.column} の並び）
            if opened_block:
                out.append((cur, last))
                cur = None
            continue
        if re.match(r"^\s*\$\$", s) and not re.match(r"^\s*\$\$.*\$\$\s*$", s):
            j = next((k for k in range(i + 1, b) if "$$" in L[k]), None)
            if j is not None:
                last = j
                i = j + 1
                continue
        if L.blank(i):
            out.append((cur, last))
            cur = None
            i += 1
            continue
        last = i
        i += 1
    if cur is not None:
        out.append((cur, last))
    return out


def _chunks(L: _Lines, scan: _Scan, a: int, b: int, prefix: str) -> list[Chunk]:
    out = []
    for n, (f, l) in enumerate(_blocks(L, scan, a, b)):
        out.append(_classify(L, scan, f, l, f"{prefix}{n}"))
    return out


def _classify(L: _Lines, scan: _Scan, f: int, l: int, path: str) -> Chunk:
    start, end = L.starts[f], L.ends[l]
    first = L[f]
    one = L.text[start:end].strip()
    chunk = Chunk("text", start, end, path)
    if f in scan.code_close:
        info = FENCE_OPEN.match(first)[2].strip()
        chunk.kind = "opaque" if scan.code_close[f] == l and info.startswith("{=") else "text"
        if scan.code_close[f] != l:
            chunk.kind = "text"
        return chunk
    if f in scan.div_close and scan.div_close[f] == l:
        attrs = div_attrs(first)
        chunk.attrs = attrs
        chunk.open = (L.starts[f], L.ends[f])
        chunk.close = (L.starts[l], L.ends[l])
        if "columns" in attrs.classes:
            cols = []
            for k, (cf, cl) in enumerate(_blocks(L, scan, f + 1, l)):
                if not (cf in scan.div_close and scan.div_close[cf] == cl and "column" in div_attrs(L[cf]).classes):
                    cols = None
                    break
                col = Chunk("column", L.starts[cf], L.ends[cl], f"{path}.{k}", attrs=div_attrs(L[cf]),
                            open=(L.starts[cf], L.ends[cf]), close=(L.starts[cl], L.ends[cl]))
                col.children = _chunks(L, scan, cf + 1, cl, f"{path}.{k}.")
                cols.append(col)
            if cols:
                chunk.kind = "columns"
                chunk.children = cols
                return chunk
            chunk.kind = "opaque"
            return chunk
        classes = set(attrs.classes)
        cover = len(classes & COVER_PARTS) == 1 and classes - COVER_PARTS <= {"incremental"}
        if (cover or classes <= {"row", "incremental"}) and set(attrs.kv) <= BOX_KEYS:
            chunk.kind = "box"
            chunk.children = _chunks(L, scan, f + 1, l, f"{path}.")
            return chunk
        chunk.kind = "opaque"
        return chunk
    if f == l and FIG_LINE.match(one):
        chunk.kind = "fig"
    elif f == l and IMAGE_LINE.match(one):
        chunk.kind = "image"
    elif FOOTNOTE_DEF.match(first) or LINK_DEF.match(first):
        chunk.kind = "def"
    elif RAW_HTML.match(first) or DIV_OPEN.match(first):
        chunk.kind = "opaque"
    return chunk


# ---------------------------------------------------------------- 図の参照


def fig_args(line: str) -> dict | None:
    """{{< fig nco/route-example width=800 title="…" >}} → {"ref": …, "width": …, …}"""
    m = FIG_LINE.match(line.strip())
    if not m:
        return None
    tokens = re.findall(r"""([\w-]+)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))|("(?:[^"\\]|\\.)*"|\S+)""", m[1])
    out: dict = {}
    for key, dq, sq, bare, positional in tokens:
        if key:
            out[key] = dq if dq or (not sq and not bare) else sq or bare
        elif "ref" not in out:
            out["ref"] = positional.strip('"')
    return out if "ref" in out else None


# ---------------------------------------------------------------- 描画用の原稿（§7.1）


class _Emitter:
    """描画用の原稿を行単位で組み立て、出力の行 → 原文の行（1始まり）の対応を持つ。"""

    def __init__(self, L: _Lines):
        self.L = L
        self.lines: list[str] = []
        self.origin: list[int | None] = []

    def raw(self, start: int, end: int):
        first = self.L.index_at(start)
        for k, line in enumerate(self.L.text[start:end].split("\n")):
            self.lines.append(line)
            self.origin.append(first + k + 1)

    def same_lines(self, start: int, end: int, text: str):
        """原文の start〜end の代わりに text を出す（行の数は同じ。行の対応はそのまま）。"""
        first = self.L.index_at(start)
        for k, line in enumerate(text.split("\n")):
            self.lines.append(line)
            self.origin.append(first + k + 1)

    def gen(self, text: str):
        for line in text.split("\n"):
            self.lines.append(line)
            self.origin.append(None)

    def blank(self):
        if self.lines and self.lines[-1] != "":
            self.gen("")

    def result(self) -> tuple[str, list[int | None]]:
        return "\n".join(self.lines) + "\n", self.origin


MATH_ENV = re.compile(r"\\(?:begin|end)\{")
PURE_MATH = re.compile(r"(\s*\$\$)(.*?)(\$\$\s*)", re.S)


def math_breaks(tex: str) -> str:
    """$$ の中で改行した数式（と \\\\ で区切った数式）を、表示でも改行する（& があれば aligned で揃え、なければ gathered で中央に並べる）。
    1行の数式と、\\begin{…} を自分で書いた数式（行列など）はそのまま。行の数は変えない。"""
    lines = tex.split("\n")
    body = [i for i, line in enumerate(lines) if line.strip()]
    if not body or (len(body) < 2 and "\\\\" not in tex) or MATH_ENV.search(tex):
        return tex
    env = "aligned" if any(re.search(r"(?<!\\)&", lines[i]) for i in body) else "gathered"
    for i in body[:-1]:
        lines[i] = re.sub(r"\s*\\\\\s*$", "", lines[i]) + " \\\\"
    lines[body[0]] = f"\\begin{{{env}}} " + lines[body[0]]
    lines[body[-1]] += f" \\end{{{env}}}"
    return "\n".join(lines)


def _emit_text(e: "_Emitter", start: int, end: int):
    raw = e.L.text[start:end]
    m = PURE_MATH.fullmatch(raw)
    if m and "$$" not in m[2]:
        e.same_lines(start, end, m[1] + math_breaks(m[2]) + m[3])
    else:
        e.raw(start, end)


def wrapped_source(doc: Doc, wrap: bool = True) -> tuple[str, list[int | None]]:
    """各チャンクを ::: {.slide-studio-c data-slide-studio="p<ページ>/<パス>"} で包んだ原稿と、行の対応。
    wrap=False は包まない原稿（包んでも見た目が変わらないことの確認用）。"""
    L = _Lines(doc.text)
    e = _Emitter(L)
    if doc.front[1]:
        e.raw(0, doc.front[1])
    if doc.pages:
        pre_end = doc.pages[0].start
        if pre_end > doc.front[1]:
            e.raw(doc.front[1], pre_end)
    for p in doc.pages:
        e.blank()
        if p.generated:
            classes = " ".join("." + c for c in p.attrs.classes)
            e.gen(f"## {p.title} {{#{p.id} {classes}}}")
            if p.generated == "refs":
                e.blank()
                e.gen("::: {#refs}")
                e.gen(":::")
        else:
            e.raw(p.start, p.head_end)
        e.blank()
        if p.raw_only:
            if p.end > p.head_end + 1:
                e.raw(p.head_end + 1, p.end - 1 if doc.text[p.end - 1:p.end] == "\n" else p.end)
            # 閉じていない ::: はページの終わりで閉じて描画する（後ろのページを取り込ませない）
            for _ in range(sum(1 for k in p.unclosed if k == ":::")):
                e.blank()
                e.gen(":::")
            continue
        for c in p.chunks:
            e.blank()
            if wrap:
                _emit_chunk(e, c, p.index)
            elif c.kind == "text":
                _emit_text(e, c.start, c.end)
            else:
                e.raw(c.start, c.end)
    return e.result()


def _emit_chunk(e: _Emitter, c: Chunk, page: int):
    if c.kind == "def":
        e.raw(c.start, c.end)
        e.blank()
        return
    e.gen(f'::: {{.slide-studio-c data-slide-studio="p{page}/{c.path}"}}')
    e.blank()
    if c.container:
        e.raw(*c.open)
        for child in c.children:
            e.blank()
            _emit_chunk(e, child, page)
        e.blank()
        e.raw(*c.close)
    elif c.kind == "text":
        _emit_text(e, c.start, c.end)
    else:
        e.raw(c.start, c.end)
    e.blank()
    e.gen(":::")
    e.blank()


# ---------------------------------------------------------------- 未対応の記法（§7.1）


def unsupported(doc: Doc) -> list[dict]:
    out = []
    for p in doc.pages:
        body = doc.text[p.head_end:p.end]
        for m in SHORTCODE.finditer(body):
            if m[1] != "fig":
                out.append({"page": p.index, "message": f"Slide Studio では未対応の記法：ショートコード {{{{< {m[1]} >}}}}"})
        for m in CROSSREF.finditer(body):
            out.append({"page": p.index, "message": f"Slide Studio では未対応の記法：相互参照 {m[0]}"})
        for c in p.walk():
            if c.attrs and any(k.startswith("callout") for k in c.attrs.classes):
                out.append({"page": p.index, "message": "Slide Studio では未対応の記法：callout"})
        for m in re.finditer(r"^ {0,3}```+\s*\{(?!=)[\w-]+", body, re.M):
            out.append({"page": p.index, "message": "Slide Studio では未対応の記法：コードの実行"})
    return out


# ---------------------------------------------------------------- 原文への書き戻し

def locate(doc: Doc, key: str) -> tuple[Page, Chunk]:
    m = re.fullmatch(r"p(\d+)/([\d.]+)", key)
    if not m:
        raise ValueError("チャンクが見つかりません")
    page = next((p for p in doc.pages if p.index == int(m[1])), None)
    if page is None or page.raw_only:
        raise ValueError("このページは原稿で編集してください")
    chunk = next((c for c in page.walk() if c.path == m[2]), None)
    if chunk is None or chunk.kind == "def":
        raise ValueError("チャンクが見つかりません")
    return page, chunk


def rewrite(doc: Doc, replacements: dict[str, str] | None = None) -> str:
    """非重複のチャンクだけを置換する。未変更の空白・囲みもそのまま残す。"""
    edits = sorted((locate(doc, k)[1].start, locate(doc, k)[1].end, v)
                   for k, v in (replacements or {}).items())
    for a, b in zip(edits, edits[1:]):
        if a[1] > b[0]:
            raise ValueError("囲みと中身を同時に変更できません")
    text = doc.text
    for start, end, value in reversed(edits):
        text = text[:start] + value + text[end:]
    return text


def move_chunk(doc: Doc, key: str, page_index: int, before: str | None = None) -> str:
    """指定チャンクの直前、またはページ末尾へ原文のまま移す。"""
    _, chunk = locate(doc, key)
    page = next((p for p in doc.pages if p.index == page_index), None)
    if page is None or page.raw_only:
        raise ValueError("このページは原稿で編集してください")
    if before:
        target_page, target = locate(doc, before)
        if target_page != page:
            raise ValueError("移動先のページが違います")
        pos = target.start
    else:
        pos = page.end
    if chunk.start <= pos <= chunk.end:
        if pos == chunk.start:
            return doc.text
        raise ValueError("自分の中には移動できません")
    raw = doc.text[chunk.start:chunk.end]
    # 空行で境界を保証する。定義や周辺の原文には触れない。
    insertion = "\n\n" + raw + "\n\n"
    edits = [(chunk.start, chunk.end, ""), (pos, pos, insertion)]
    text = doc.text
    for start, end, value in sorted(edits, reverse=True):
        text = text[:start] + value + text[end:]
    return text


# ---------------------------------------------------------------- 表のセル

TABLE_RULE = re.compile(r"\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*")
# セルを区切らない部分（Pandoc の pipe table と同じく \| ・コード・数式・HTML のタグ）と、区切りの |
CELL_PART = re.compile(r"\\.|(`+).+?(?<!`)\1(?!`)|\$\$.+?\$\$|\$(?!\s)(?:\\.|[^$\n])*?(?<!\s)\$(?!\d)|</?[A-Za-z][^<>\n]*>|\|")


def table_rows(raw: str) -> list[list[tuple[int, int]]] | None:
    """パイプ表のセルの範囲（raw の中の位置。| と | の間）。見出しが 0 行目で、区切りの行は数えない。表でなければ None。"""
    lines = raw.split("\n")
    if len(lines) < 2 or not TABLE_RULE.fullmatch(lines[1]):
        return None
    rows, pos = [], 0
    for n, line in enumerate(lines):
        if n != 1:
            bars = [m.start() for m in CELL_PART.finditer(line) if m[0] == "|"]
            if not bars:
                return None
            cuts = ([] if not line[:bars[0]].strip() else [-1]) + bars + ([] if not line[bars[-1] + 1:].strip() else [len(line)])
            rows.append([(pos + a + 1, pos + b) for a, b in zip(cuts, cuts[1:])])
        pos += len(line) + 1
    return rows


def set_cell(doc: Doc, key: str, row: int, col: int, markdown: str) -> str:
    """表の1つのセルの中身だけを置き換える。前後の空白と、ほかのセルは原文のまま。"""
    _, chunk = locate(doc, key)
    raw = doc.text[chunk.start:chunk.end]
    rows = table_rows(raw) if chunk.kind == "text" else None
    if not rows or not 0 <= row < len(rows) or not 0 <= col < len(rows[row]):
        raise ValueError("セルが見つかりません")
    a, b = rows[row][col]
    old = raw[a:b]
    lead, trail = (old[:len(old) - len(old.lstrip())], old[len(old.rstrip()):]) if old.strip() else (" ", " ")
    return rewrite(doc, {key: raw[:a] + lead + markdown + trail + raw[b:]})


def image_options(doc: Doc, key: str, width: int | None, align: str) -> str:
    """画像の幅と揃えを書く。width が None なら、書いてある幅をそのまま残す。"""
    _, chunk = locate(doc, key)
    if chunk.kind != "image" or (width is not None and not 1 <= width <= 1280) or align not in ("left", "center", "right"):
        raise ValueError("画像の幅・揃えが正しくありません")
    raw = doc.text[chunk.start:chunk.end]
    m = ATTR_TAIL.search(raw)
    attrs = m[1] if m else ""
    keys = "fig-align" if width is None else "width|fig-align"
    attrs = re.sub(rf'''(?:^|\s)(?:{keys})=(?:"[^"]*"|'[^']*'|\S+)''', '', attrs).strip()
    raw = raw[:m.start()] if m else raw
    size = "" if width is None else f"width={width} "
    return rewrite(doc, {key: raw + '{' + (attrs + ' ' if attrs else '') + size + f'fig-align="{align}"' + '}'})
