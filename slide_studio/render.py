"""描画：qmd → Pandoc → ページ組み立て → スライド HTML。設計書 §7。

プレビュー・検査・書き出しのすべてがこの HTML を使う（編集用のスクリプトはサーバーが後から注入する）。
ページ組み立ては quarto-html scripts/slides.py の render() を移植したもの。
"""
from __future__ import annotations

import copy
import html
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString

from . import source
from .cover import authors as cover_authors, html_block as cover_html
from . import pandoc_worker
from .fsutil import sha256_text, write_atomic
from .workspace import RUNTIME, Workspace, figure_title

LUA = Path(__file__).resolve().parent / "lua" / "slide-studio.lua"
READER = "markdown+fenced_divs+tex_math_dollars"


class RenderError(Exception):
    """Pandoc の失敗。message は qmd の行番号に直してある。"""


@dataclass
class Rendered:
    html: str
    slides: list[dict]
    doc: source.Doc
    version: str
    warnings: list[str] = field(default_factory=list)
    missing_cites: list[str] = field(default_factory=list)
    cited: list[str] = field(default_factory=list)
    unsupported: list[dict] = field(default_factory=list)
    timing: dict = field(default_factory=dict)


def warning_issues(rendered: Rendered) -> list[dict]:
    """位置を持たない重複属性の警告を、原稿の属性へ対応付ける。"""
    if not rendered.warnings:
        return []
    doc = rendered.doc
    lines = source._Lines(doc.text)
    scan = source._Scan(lines, lines.index_at(doc.front[1]))
    candidates = []
    # 引用符の中の波括弧は属性の終わりと扱わない。
    groups = re.compile(r'''\{(?:[^{}"']|"(?:\\.|[^"\\])*"|'[^']*')*\}''')
    for group in groups.finditer(doc.text, doc.front[1]):
        if scan.in_code[lines.index_at(group.start())]:
            continue
        seen = set()
        for attr in source.ATTR_TOKEN.finditer(group[0][1:-1]):
            key = attr[3]
            if key is None:
                continue
            value = attr[4] if attr[4] is not None else attr[5] if attr[5] is not None else attr[6]
            if key in seen:
                offset = group.start() + 1 + attr.start()
                page = doc.page_of(offset)
                candidates.append((key, value, offset, page))
            seen.add(key)
    out = []
    emitted = set()
    for warning in rendered.warnings:
        match = re.search(r'Ignoring duplicate attribute ([^=\s]+)="(.*)"\.', warning)
        locations = [c for c in candidates if match and c[:2] == (match[1], match[2])]
        if not locations:
            out.append(dict(level="warning", kind="pandoc", message=warning))
        for key, value, offset, page in locations:
            if offset in emitted:
                continue
            emitted.add(offset)
            out.append(dict(level="warning", kind="duplicate-attribute", message=warning,
                            attribute=key, value=value, source_offset=len(doc.text[:offset].encode('utf-16-le')) // 2,
                            source_line=lines.index_at(offset) + 1,
                            page=page.index if page else None,
                            slide=next((s["index"] for s in rendered.slides if page and s["page"] == page.index), None)))
    return out


def _map_lines(message: str, origin: list[int | None]) -> str:
    def repl(m):
        n = int(m[1])
        orig = origin[n - 1] if 0 < n <= len(origin) else None
        return f"line {orig}" if orig else f"line ?（変換用の {n} 行目）"
    return re.sub(r"line (\d+)", repl, message)


def run_pandoc(text: str, cwd: Path, extra: list[str], origin: list[int | None] | None = None) -> tuple[str, str]:
    args = ["--from", READER, "--to", "html5", "--mathml", "--wrap=none", *extra]
    r = pandoc_worker.run(text, args, cwd=cwd, timeout=60)
    if r.returncode != 0:
        msg = r.stderr.strip() or "Pandoc の変換に失敗しました"
        raise RenderError(_map_lines(msg, origin or []))
    return r.stdout, r.stderr


def render_deck(ws: Workspace, deck: str, text: str | None = None) -> Rendered:
    folder = ws.require_deck(deck)
    if text is None:
        text = ws.qmd(deck).read_text()
    return render_text(ws, deck, text)


def _citeproc_bib(ws: Workspace, deck: str, bib: Path) -> Path:
    """arXiv 番号を足す文献があるときだけ、build に写しを作って使う（reference.bib は変えない）。"""
    from .bibliography import with_arxiv_venue
    original = bib.read_text()
    shown = with_arxiv_venue(original)
    if shown == original:
        return bib
    path = ws.build_dir(deck) / "citeproc.bib"
    write_atomic(path, shown)
    return path


def render_text(ws: Workspace, deck: str, text: str, wrap: bool = True) -> Rendered:
    folder = ws.deck_dir(deck)
    t0 = time.perf_counter()
    doc = source.parse(text)
    wrapped, origin = source.wrapped_source(doc, wrap=wrap)
    extra = ["--lua-filter", str(LUA), "--citeproc", "--csl", str(RUNTIME / "numeric.csl"),
             "-M", "link-citations=true", "-M", "suppress-bibliography=false"]
    from .bibliography import require_ready
    require_ready(ws, deck, doc.meta)
    if doc.meta.get("topic"):
        extra += ["--resource-path", os.pathsep.join([str(ws.topic_dir(str(doc.meta["topic"]))), str(folder)])]
    bib = ws.bib(deck, doc.meta)
    if bib.exists():
        extra += ["--bibliography", str(_citeproc_bib(ws, deck, bib))]
    _ensure_figure_pages(ws, deck, doc)
    t1 = time.perf_counter()
    out, err = run_pandoc(wrapped, folder, extra, origin)
    t2 = time.perf_counter()
    missing = sorted(set(re.findall(r"Citeproc: citation (\S+) not found", err)))
    warnings = [line for line in err.splitlines() if line.strip() and "Citeproc: citation" not in line]
    rendered = _assemble(ws, deck, doc, out, missing)
    rendered.warnings = [_map_lines(w, origin) for w in warnings]
    rendered.unsupported = source.unsupported(doc)
    t3 = time.perf_counter()
    rendered.timing = {"parse_ms": round((t1 - t0) * 1000, 1), "pandoc_ms": round((t2 - t1) * 1000, 1),
                       "assemble_ms": round((t3 - t2) * 1000, 1)}
    return rendered


SHELL = """<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head><body><div class="reveal"><main id="stage" class="slides"></main></div><nav id="toolbar" aria-label="スライド操作"><button id="menu" aria-label="スライド一覧" title="スライド一覧（o）">☰</button><button id="fullscreen" aria-label="全画面" title="全画面（f）">⛶</button></nav><aside id="overview" aria-label="スライド一覧" role="dialog" aria-modal="true" hidden><button id="close">閉じる</button><p id="help">↑↓ ページ · ←→ step · 左右長押しで先頭／最後 · 画面左30%で戻る／それ以外で進む</p></aside></body></html>"""


def _assemble(ws: Workspace, deck: str, doc: source.Doc, body: str, missing: list[str]) -> Rendered:
    folder = ws.deck_dir(deck)
    frag = BeautifulSoup(f"<div id='slide-studio-root'>{body}</div>", "html.parser")
    root = frag.select_one("#slide-studio-root")
    # Pandoc の resource-path は HTML の URL を変えないため、配信・内包用の位置も明示する。
    if doc.meta.get("topic"):
        base = os.path.relpath(ws.topic_dir(str(doc.meta["topic"])), folder).replace(os.sep, '/')
        for image in root.select('img[src]'):
            if image['src'].startswith('images/'):
                image['src'] = base + '/' + image['src']
    from .steps import expand_incremental, lift_image_steps
    expand_incremental(root)
    lift_image_steps(root)

    refs_div = root.select_one("#refs")
    refs = {}
    refs_requested = any(p.generated == "refs" for p in doc.pages)
    if refs_div is not None:
        refs = {e["id"]: copy.copy(e) for e in refs_div.select(".csl-entry")}
        refs_div.decompose()
    notes = {}
    fn_section = root.select_one("section.footnotes")
    if fn_section is not None:
        for li in fn_section.select("li[id]"):
            for back in li.select("a.footnote-back"):
                back.decompose()
            notes[li["id"]] = li
        fn_section.extract()

    # チャンクの包みを外し、data-slide-studio を中身の要素に移す（子の結合子 > のある CSS を崩さない）
    for wrap in reversed(root.select("div.slide-studio-c")):
        kids = [k for k in wrap.contents if not (isinstance(k, NavigableString) and not k.strip())]
        if kids and all(getattr(k, "name", None) for k in kids):
            for k in kids:
                k["data-slide-studio"] = wrap["data-slide-studio"]
            wrap.unwrap()

    # 図の iframe の title（qmd に無ければ figure.mjs の title）
    for box in root.select("[data-slide-studio-fig]"):
        iframe = box.find("iframe")
        if iframe is not None and not iframe.get("title"):
            iframe["title"] = figure_title(ws.figure_dir(box["data-slide-studio-fig"], deck)) if _fig_exists(ws, box["data-slide-studio-fig"], deck) else box["data-slide-studio-fig"]

    # ページ分け：最上位の h1・h2 が source.py のページと1対1に並ぶ
    sections = []
    group = ""
    current = None
    heads = [c for c in root.children if getattr(c, "name", None) in ("h1", "h2")]
    if len(heads) != len(doc.pages):
        raise RenderError(f"ページの数が合いません（qmd {len(doc.pages)}・変換結果 {len(heads)}）。Slide Studio の不具合です。")
    page_iter = iter(doc.pages)
    for child in list(root.children):
        if getattr(child, "name", None) in ("h1", "h2"):
            page = next(page_iter)
            is_section = child.name == "h1"
            if is_section:
                group = child.get_text(" ", strip=True)
            current = frag.new_tag("section")
            current["class"] = ["slide"] + list(child.get("class", []))
            if child.get("id"):
                current["id"] = child["id"]
                del child["id"]
            for k, v in list(child.attrs.items()):
                if k.startswith("data-") or k == "style":
                    current[k] = v
                    del child[k]
            current["data-page"] = str(page.index)
            # PDF に載せる step の印（見出しの pdf="2 4"）。最後の step は印がなくても載る
            current.attrs.pop("data-pdf", None)
            if page.attrs.kv.get("pdf", "").strip():
                current["data-pdf"] = page.attrs.kv["pdf"].strip()
            current["data-group"] = group
            current["data-section-start"] = str(is_section).lower()
            if is_section:
                current["class"].append("section-slide")
            sections.append(current)
        if current is not None:
            current.append(child.extract())

    # 表紙の発表者と所属（front matter の author）。表紙の最後に置き、位置・大きさはテーマの CSS で決める
    sections = [s for s in sections if "toc-off" not in s.get("class", [])]

    people = cover_html(cover_authors(doc.meta), doc.meta.get("cover-authors-layout"))
    first_cover = next((s for s in sections if "cover" in s.get("class", [])), None)
    if people and first_cover is not None:
        first_cover.append(BeautifulSoup(people, "html.parser"))

    # 参考文献は指定位置へ展開し、実際の高さによる分割は player で行う。
    if not refs_requested:
        sections = [s for s in sections if s.get("id") != "references"]
    entries = list(refs.values())
    ref_at = next((i for i, s in enumerate(sections) if s.get("id") == "references"), None) if refs_requested else None
    appendix_at = next((i for i, s in enumerate(sections) if s.get("id") == "appendix"), None)
    ref_title = "参考文献"
    ref_page = ""
    if ref_at is not None:
        h = sections[ref_at].find(["h1", "h2"])
        ref_title = h.get_text(" ", strip=True) if h else ref_title
        ref_page = sections[ref_at]["data-page"]
        sections.pop(ref_at)
        if appendix_at is not None and appendix_at > ref_at:
            appendix_at -= 1
    else:
        ref_at = appendix_at if appendix_at is not None else len(sections)
    ref_sections = []
    chunks = [entries]
    for n, part in enumerate(chunks if refs_requested else []):
        s = frag.new_tag("section", attrs={"class": ["slide", "references-slide"], "data-group": ref_title,
                                           "data-section-start": "false", "data-page": ref_page})
        if n == 0:
            s["id"] = "references"
        h = frag.new_tag("h2")
        h.string = ref_title + (f"（{n + 1}）" if n else "")
        s.append(h)
        if not part:
            p = frag.new_tag("p", attrs={"class": "slide-studio-no-refs"})
            p.string = "引用なし"
            s.append(p)
        for e in part:
            s.append(copy.copy(e))
        ref_sections.append(s)
    sections[ref_at:ref_at] = ref_sections

    # 目次は章扉を原稿順に並べる。章のない発表では通常ページを使う。
    main_sections = sections[:next((i for i, s in enumerate(sections) if s.get("id") == "appendix"), len(sections))]
    targets = [s for s in main_sections if "section-slide" in s.get("class", []) and s.get("id") != "appendix"]
    if not targets:
        targets = [s for s in main_sections if not set(s.get("class", [])) & {"cover", "toc-slide", "references-slide", "refs-slide"}
                   and s.get("id") not in {"references", "appendix"}]
    for s in sections:
        if "toc-slide" not in s.get("class", []):
            continue
        listing = frag.new_tag("ol", attrs={"class": "toc-list"})
        for number, target in enumerate(targets, 1):
            item = frag.new_tag("li")
            label = frag.new_tag("span", attrs={"class": "toc-number"})
            label.string = f"{number:02d}"
            item.append(label)
            title = target.find(["h1", "h2"])
            name = frag.new_tag("span", attrs={"class": "toc-label"})
            name.string = title.get_text(" ", strip=True) if title else ""
            item.append(name)
            listing.append(item)
        s.append(listing)

    # 章番号・引用フッター・脚注・ページ番号
    chapter = 0
    cited: list[str] = []
    for i, s in enumerate(sections):
        # 目次と同じく Appendix より前の章だけに番号を振る。番号は CSS で出し、見出しの文字列には含めない
        if "section-slide" in s.get("class", []) and i < len(main_sections):
            chapter += 1
            s["data-chapter"] = f"{chapter:02d}"
            s.find("h1").insert(0, frag.new_tag("span", attrs={"class": "chapter-number", "data-chapter": s["data-chapter"]}))
        footer = frag.new_tag("footer", attrs={"class": "citations"})
        # 手書きの注（.footnote-small）も下端の同じ箱に入れ、引用・脚注と積む（別々に下へ固定すると重なる）
        for small in s.select(".footnote-small"):
            if small.find_parent(class_="footnote-small") is None:
                footer.append(small.extract())
        seen = set()
        for citation in s.select("[data-cites]"):
            for key in citation["data-cites"].split():
                if key in seen:
                    continue
                seen.add(key)
                if key not in cited:
                    cited.append(key)
                entry = refs.get("ref-" + key)
                p = frag.new_tag("p")
                if entry is None:
                    p["class"] = "slide-studio-missing-cite"
                    p.string = f"文献が見つかりません: {key}"
                else:
                    p.string = " ".join(entry.get_text().split())
                footer.append(p)
        for a in s.select("a.footnote-ref"):
            note = notes.get(a.get("href", "").lstrip("#"))
            if note is None:
                continue
            p = frag.new_tag("p", attrs={"class": "slide-studio-footnote"})
            sup = frag.new_tag("sup")
            sup.string = a.get_text(strip=True)
            p.append(sup)
            for part in note.find_all("p") or [note]:
                for k in list(part.contents):
                    p.append(copy.copy(k))
            footer.append(p)
            for marker in a.select("sup"):
                marker["data-slide-studio-footnote"] = a.get("href", "")
            a.unwrap()
        if footer.contents:
            s.append(footer)
        n = frag.new_tag("span", attrs={"class": "page-number"})
        n.string = f"{i + 1} / {len(sections)}"
        s.append(n)
        for a in s.select('a[role="doc-biblioref"]'):
            a.unwrap()

    shell = BeautifulSoup(SHELL, "html.parser")
    title = str(doc.meta.get("title") or doc.meta.get("pagetitle") or deck)
    shell.title.string = title
    base = shell.new_tag("style", attrs={"id": "slide-studio-base"})
    base.string = (RUNTIME / "base.css").read_text()
    shell.head.append(base)
    theme = str(doc.meta.get("theme") or "default")
    shell.head.append(shell.new_tag("link", attrs={"rel": "stylesheet", "id": "slide-studio-theme", "href": f"../../themes/{theme}.css"}))
    if (folder / "styles" / "slides.css").exists():
        shell.head.append(shell.new_tag("link", attrs={"rel": "stylesheet", "id": "slide-studio-deck-style", "href": "styles/slides.css"}))
    shell.body["data-slide-studio-deck"] = deck
    stage = shell.select_one("#stage")
    for s in sections:
        stage.append(s)
    for a in stage.select('a[href]'):
        if a['href'].startswith('#') or a.has_attr('download'):
            continue
        a['target'] = '_blank'
        a['rel'] = 'noopener'
    player = shell.new_tag("script", attrs={"id": "slide-studio-player"})
    player.string = (RUNTIME / "player.js").read_text()
    shell.body.append(player)

    slides = []
    for i, s in enumerate(sections):
        h = s.find(["h1", "h2"])
        slides.append({"index": i, "page": int(s["data-page"]) if s.get("data-page") else None, "id": s.get("id", ""),
                       "title": h.get_text(" ", strip=True) if h else "", "level": 1 if "section-slide" in s.get("class", []) else 2,
                       "figures": [b["data-slide-studio-fig"] for b in s.select("[data-slide-studio-fig]")]})
    return Rendered(str(shell), slides, doc, sha256_text(doc.text), missing_cites=missing, cited=cited)


def _ensure_figure_pages(ws: Workspace, deck: str, doc: source.Doc) -> None:
    from .figures import ensure_index

    for p in doc.pages:
        for c in p.walk():
            if c.kind == "fig":
                args = source.fig_args(doc.text[c.start:c.end])
                if args and _fig_exists(ws, args["ref"], deck):
                    ensure_index(ws.figure_dir(args["ref"], deck), ws)


def _fig_exists(ws: Workspace, ref: str, deck: str) -> bool:
    try:
        return (ws.figure_dir(ref, deck) / "figure.mjs").exists()
    except Exception:  # noqa: BLE001
        return False


def escape(s: str) -> str:
    return html.escape(s, quote=True)
