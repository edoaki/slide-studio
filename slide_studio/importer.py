"""quarto-html の発表を置き場に取り込む（slide-studio import）。設計書 §5.2・§11。

iframe → {{< fig 棚/名前 >}}、html/<図> → 棚、html/shared の部品 → 棚の _lib/、ページ ID の補完、
front matter の topic・theme、参考文献と Appendix の見出しを足す。
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from . import source
from .figures import _Copier, free_name
from .fsutil import write_atomic
from .workspace import StudioError, Workspace, check_name, set_front

RAW_IFRAME = re.compile(r"^```+\s*\{=html\}[ \t]*\n\s*(<iframe\b[^>]*>\s*</iframe>)\s*\n```+[ \t]*$", re.M)
BARE_IFRAME = re.compile(r"^[ \t]*(<iframe\b[^>]*>\s*</iframe>)[ \t]*$", re.M)
ATTR = re.compile(r"""([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")


def _iframe_attrs(tag: str) -> dict:
    return {m[1]: m[2] if m[2] is not None else m[3] for m in ATTR.finditer(tag)}


def _find_figure(deck_dir: Path, src: str) -> Path:
    direct = (deck_dir / src).resolve().parent
    if (direct / "figure.mjs").exists():
        return direct
    name = Path(src).parent.name
    for base in [deck_dir, *deck_dir.resolve().parents]:
        cand = base / "html" / name
        if (cand / "figure.mjs").exists():
            return cand
    if (direct / "index.html").exists() or any((b / "html" / name / "index.html").exists() for b in [deck_dir, *deck_dir.resolve().parents]):
        raise StudioError(f"runtime.mjs 方式（figure.mjs）ではない図は取り込めません: {src}")
    raise StudioError(f"図が見つかりません: {src}")


def _slug(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s[:40].strip("-")


def add_page_ids(text: str) -> str:
    """ID の無い # と ## に {#id} を補う（他の文字は変えない）。"""
    doc = source.parse(text)
    used = {p.id for p in doc.pages if p.id}
    counters = {1: 0, 2: 0}
    edits = []
    for p in doc.pages:
        counters[p.level] += 1
        if p.id:
            continue
        base = _slug(p.title) or ("chapter" if p.level == 1 else "page")
        new = base if base not in used and base not in ("chapter", "page") else None
        n = counters[p.level]
        while new is None or new in used:
            new = f"{base}-{n}"
            n += 1
        used.add(new)
        line = text[p.start:p.head_end]
        m = source.ATTR_TAIL.search(line)
        if m:
            inner = m[1].strip()
            new_line = line[:m.start(1)] + (f"#{new} " + inner if inner else f"#{new}") + line[m.end(1):]
        else:
            new_line = line.rstrip() + f" {{#{new}}}"
        edits.append((p.start, p.head_end, new_line))
    for a, b, rep in reversed(edits):
        text = text[:a] + rep + text[b:]
    return text


def ensure_tail(text: str) -> str:
    """## 参考文献 {#references} と # Appendix {#appendix} が無ければ末尾に足す。"""
    doc = source.parse(text)
    ids = {p.id for p in doc.pages}
    tail = ""
    if "references" not in ids:
        if "appendix" in ids:
            appendix = next(p for p in doc.pages if p.id == "appendix")
            text = text[:appendix.start] + "## 参考文献 {#references}\n\n" + text[appendix.start:]
        else:
            tail += "## 参考文献 {#references}\n\n"
    if "appendix" not in ids:
        tail += "# Appendix {#appendix}\n"
    if tail:
        text = text.rstrip("\n") + "\n\n" + tail
    return text


def import_deck(ws: Workspace, src: Path, shelf: str, name: str | None = None, theme: str = "default") -> Path:
    src = src.resolve()
    if not (src / "slides.qmd").exists():
        raise StudioError(f"slides.qmd がありません: {src}")
    check_name(shelf, "棚の名前")
    name = check_name(name or src.name, "発表の名前")
    dest = ws.deck_dir(name)
    if dest.exists():
        raise StudioError(f"既にあります: {dest}")
    text = (src / "slides.qmd").read_text()

    # 図：iframe を {{< fig >}} にし、図のフォルダを集める
    found: dict[str, Path] = {}

    def replace(m):
        attrs = _iframe_attrs(m[1])
        fig_dir = _find_figure(src, attrs.get("src", ""))
        found.setdefault(fig_dir.name, fig_dir)
        title = attrs.get("title")
        return f'{{{{< fig {shelf}/{fig_dir.name}' + (f' title="{title}"' if title else "") + " >}}"

    text = RAW_IFRAME.sub(replace, text)
    text = BARE_IFRAME.sub(replace, text)

    meta = source.parse(text).meta
    values = {"topic": shelf, "theme": theme}
    if "title" not in meta and meta.get("pagetitle"):
        values = {"title": f'"{meta["pagetitle"]}"', **values}
    if "lang" not in meta:
        values["lang"] = "ja"
    text = set_front(text, values)
    text = add_page_ids(text)
    text = ensure_tail(text)

    shelf_dir = ws.shelf_dir(shelf)
    targets = {}
    for fig_name, fig_dir in found.items():
        if (shelf_dir / fig_name).exists():
            raise StudioError(f"棚 {shelf} に同じ名前の図があります: {fig_name}")
        targets[fig_dir.resolve()] = shelf_dir / fig_name
    created: list[Path] = []
    try:
        # 発表のフォルダ（図の html/ は持ってこない）
        dest.mkdir(parents=True)
        created.append(dest)
        for item in src.iterdir():
            if item.name in ("slides.qmd", "html", "images", "figures", ".DS_Store") or item.suffix in (".html", ".pdf"):
                continue
            if item.is_dir():
                shutil.copytree(item, dest / item.name, ignore=shutil.ignore_patterns(".DS_Store"))
            else:
                shutil.copy2(item, dest / item.name)
        for sub in ("styles",):
            (dest / sub).mkdir(exist_ok=True)
        from .topic_migrate import copy_group, rewrite
        mapping = {}
        copy_group(src / "images", ws.topic_dir(shelf) / "images", mapping)
        text = rewrite(text, src / "slides.qmd", dest / "slides.qmd", mapping, ws.root)
        text = text.replace(f"../../topics/{shelf}/images/", "images/")
        if not (dest / "reference.bib").exists():
            write_atomic(dest / "reference.bib", "")
        write_atomic(dest / "slides.qmd", text)
        # 棚へ図を写す。図どうしの import（../他の図/figure.mjs）は棚の中の参照のまま残す
        shelf_dir.mkdir(parents=True, exist_ok=True)
        html_root = next(iter(targets)).parent if targets else src
        for fig_dir, dst in targets.items():
            created.append(dst)
            _Copier(ws, fig_dir, shelf_dir, lib_names=("_lib", "shared"), siblings=targets, allow=html_root).copy(dst.name)
    except BaseException:
        for path in created:
            shutil.rmtree(path, ignore_errors=True)
        raise
    from .bibliography import migrate
    migrate(ws)
    ws.touch_recent(name)
    return dest
