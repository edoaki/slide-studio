"""トピックの中身：同じ topic:（トピック）の発表の原稿から、前に使った数式・画像・図を集める。設計書 §5.4。

保存はしない。挿入の画面を開くたびに、同じトピックの発表の slides.qmd から集める（原稿から消せば候補からも消える）。
画像・図は assets のトピック一覧から共有する。他のトピックからの挿入だけコピーする。
"""
from __future__ import annotations

import re
from pathlib import Path

from . import assets
from . import figures as figs
from . import pandoc_worker, source
from .workspace import StudioError, Workspace

MAX_MATH = 300
DISPLAY = re.compile(r"\$\$(.+?)\$\$", re.S)
# Pandoc の tex_math_dollars：開きの $ の右と閉じの $ の左は空白でなく、閉じの $ の直後は数字でない
INLINE = re.compile(r"(?<![\\$])\$(?=[^\s$])([^$\n]*?[^\s\\$])\$(?!\d)")
CODE_SPAN = re.compile(r"(`+).+?\1", re.S)
IMAGE = re.compile(r"!\[[^\]]*\]\(<?([^)\s>]+)")


def norm(tex: str) -> str:
    """数式を比べるときの形（空白を除く）。"""
    return re.sub(r"\s+", "", tex)


def decks_of(ws: Workspace, deck: str) -> tuple[str | None, list[str]]:
    """この発表のトピックと、そのトピックの発表（この発表が最初、あとは更新の新しい順）。"""
    try:
        shelf = ws.deck_shelf(deck)
    except StudioError:
        return None, [deck]
    others = []
    for d in ws.list_decks():
        if d == deck:
            continue
        try:
            if str(ws.deck_meta(d).get("topic") or "") == shelf:
                others.append(d)
        except (OSError, StudioError):
            continue
    others.sort(key=lambda d: ws.qmd(d).stat().st_mtime, reverse=True)
    return shelf, [deck, *others]


def _maths(raw: str):
    """本文のチャンクの中の数式（別行の $$…$$ と文の中の $…$）。"""
    if re.match(r"\s*(```|~~~)", raw):
        return
    raw = CODE_SPAN.sub(" ", raw)
    for m in DISPLAY.finditer(raw):
        yield m[1].strip(), True
    for m in INLINE.finditer(DISPLAY.sub(" ", raw)):
        yield m[1].strip(), False


def collect(ws: Workspace, deck: str) -> dict:
    """トピックの発表の原稿にある数式。数式は更新の新しい発表の順（同じ発表の中は使った数の順）。"""
    ws.require_deck(deck)
    shelf, decks = decks_of(ws, deck)
    math: dict[str, dict] = {}
    for order, d in enumerate(decks):
        try:
            text = ws.qmd(d).read_text()
        except OSError:
            continue
        for page in source.parse(text).pages:
            for c in page.walk():
                raw = text[c.start:c.end]
                if c.kind == "text":
                    for tex, display in _maths(raw):
                        if not tex:
                            continue
                        it = math.setdefault(norm(tex), {"tex": tex, "display": display, "count": 0, "decks": [], "order": order})
                        it["count"] += 1
                        it["display"] = it["display"] or display
                        if d not in it["decks"]:
                            it["decks"].append(d)
    rank = lambda it: (it["order"], -it["count"])  # 新しい発表のものが先（この発表が最初）
    return {
        "shelf": shelf, "decks": decks,
        "math": [{k: v for k, v in it.items() if k != "order"} for it in sorted(math.values(), key=rank)[:MAX_MATH]],
        "images": [], "figures": [],
    }


def listing(ws: Workspace, deck: str) -> dict:
    """collect に、数式の MathML（候補の表示用）を足したもの。"""
    out = collect(ws, deck)
    for it, html in zip(out["math"], math_many([it["tex"] for it in out["math"]])):
        it["html"] = html
    return out


# ---------------------------------------------------------------- 他の発表から入れる


def _files(d: Path) -> dict[str, bytes]:
    return {f.relative_to(d).as_posix(): f.read_bytes() for f in sorted(d.rglob("*"))
            if f.is_file() and f.name not in figs.SKIP}


def take(ws: Workspace, deck: str, kind: str, src_deck: str, path: str) -> dict:
    """同じトピックならそのまま返し、他のトピックなら自分のトピックへコピーする。"""
    ws.require_deck(deck)
    ws.require_deck(src_deck)
    shelf = ws.deck_shelf(deck)
    other = ws.deck_shelf(src_deck)
    src = ws.asset_root(src_deck).resolve()
    if kind == "image":
        f = (src / path).resolve()
        if not f.is_file() or not f.is_relative_to(src / "images") or f.suffix.lower() not in assets.IMAGE_EXT:
            raise StudioError(f"画像がありません: {path}")
        if shelf == other:
            return {"kind": "images", "path": f.relative_to(src).as_posix(), "name": f.name, "reused": True}
        return assets.add(ws, deck, f.name, f.read_bytes())
    if kind == "figure":
        d = (ws.shelf_dir(other) / path).resolve()
        if "/" in path or not (d / "figure.mjs").is_file() or not d.is_relative_to(ws.shelf_dir(other).resolve()):
            raise StudioError(f"図がありません: {path}")
        mine = ws.shelf_dir(shelf) / d.name
        if shelf == other or (mine.is_dir() and _files(mine) == _files(d)):
            return {"ref": f"{shelf}/{d.name}", "reused": True}
        out = figs.copy_figure(ws, d, ws.shelf_dir(shelf))
        return {"ref": f"{shelf}/{out.name}", "reused": False}
    raise StudioError(f"入れられない種類です: {kind}")


# ---------------------------------------------------------------- 候補の数式の表示

_mathml: dict[str, str | None] = {}


def math_many(texs: list[str]) -> list[str | None]:
    """数式をまとめて MathML にする（候補の一覧用。1回の Pandoc で変換し、結果を覚えておく）。"""
    todo = [t for t in dict.fromkeys(texs) if t not in _mathml and "$$" not in t]
    if todo:
        src = "\n\n".join(f"::: {{#m{i}}}\n$$\n{source.math_breaks(t)}\n$$\n:::" for i, t in enumerate(todo))
        r = pandoc_worker.run(src, ["--from", "markdown+tex_math_dollars", "--to", "html5", "--mathml", "--wrap=none"], timeout=30)
        got = dict(re.findall(r'<div id="m(\d+)">\s*(.*?)\s*</div>', r.stdout, re.S)) if not r.returncode else {}
        if len(_mathml) > 5000:
            _mathml.clear()
        for i, t in enumerate(todo):
            html = got.get(str(i), "")
            _mathml[t] = html if "<math" in html else None
    return [_mathml.get(t) for t in texs]


def topic_listing(ws: Workspace, shelf: str) -> dict:
    """トピックに割り当てた発表と HTML・文献。_lib は部品なので件数だけ返す。"""
    from urllib.parse import quote

    from . import bibliography
    from .shots import cover_listing
    from .workspace import check_name, figure_steps

    check_name(shelf)
    base = ws.shelf_dir(shelf).resolve()
    if not base.is_relative_to(ws.topics.resolve()) or not base.is_dir():
        raise StudioError(f"トピックがありません: {shelf}")
    recent = ws.recent()
    decks = [d for d in recent if d["shelf"] == shelf]
    for d in decks:
        d["shots"] = cover_listing(ws, d["deck"])
        d["thumb"] = d["shots"][0] if d["shots"] else None
    texts = {d["deck"]: ws.qmd(d["deck"]).read_text() for d in recent}
    items, shared = [], 0
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(base)
        if not path.is_file() or not path.resolve().is_relative_to(base) or any(p.startswith('.') for p in rel.parts):
            continue
        if rel.parts[0] == "_lib":
            shared += 1
            continue
        if path.suffix.lower() not in assets.HTML_EXT:
            continue
        is_index = path.name == "index.html"
        ref = path.parent.relative_to(base).as_posix() if is_index else rel.as_posix()
        status, reasons = assets.figure_status(ws, path.parent) if is_index else assets.html_status(path)
        used = []
        for d in recent:
            text = texts[d["deck"]]
            figure_ref = re.compile(r'\{\{<\s*fig\s+"?' + re.escape(shelf + "/" + ref) + r'["\s>]')
            html_ref = re.compile(r'(?:\.\./)+topics/' + re.escape(shelf + '/html/' + rel.as_posix()) + r'(?=["\s)>?#]|$)')
            if (is_index and figure_ref.search(text)) or html_ref.search(text):
                used.append(d["deck"])
        items.append({"name": ref, "path": rel.as_posix(), "kind": "figure" if is_index and status != "ng" else "html",
                      "status": status, "reasons": reasons,
                      "steps": len(figure_steps(path.parent)) if is_index and status != "ng" else 0,
                      "url": "/files/topics/" + quote(shelf + '/html/' + rel.as_posix(), safe='/'), "decks": used})
    try:
        bib, bib_error = bibliography.listing(ws.topic_dir(shelf) / "reference.bib"), False
    except ValueError:
        bib, bib_error = [], True
    for entry in bib:
        entry["decks"] = [d["deck"] for d in decks if bibliography.cites(texts[d["deck"]], entry["key"])]
    return {"name": shelf, "recent": decks, "html": items, "shared_count": shared, "bib": bib, "bib_error": bib_error}


def delete_topic_html(ws: Workspace, shelf: str, paths: list[str]) -> list[dict]:
    """選択した HTML だけをごみ箱へ移す。共有するスクリプト等は残す。"""
    import time

    if not isinstance(paths, list) or not paths or any(not isinstance(p, str) for p in paths):
        raise StudioError("htmlMissing")
    items = {item["path"]: item for item in topic_listing(ws, shelf)["html"]}
    base = ws.shelf_dir(shelf)
    targets = []
    for path in dict.fromkeys(paths):
        item = items.get(path)
        target = base / path
        if item is None or any(p.is_symlink() for p in (target, *target.parents)):
            raise StudioError("htmlMissing")
        if item["decks"]:
            raise StudioError("htmlInUse")
        targets.append((path, target))
    trash = ws.state / "trash" / "_assets" / shelf / str(time.time_ns()) / "html"
    out = []
    for path, target in targets:
        dest = trash / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        target.rename(dest)
        out.append({"path": path, "trash": dest.relative_to(ws.root).as_posix()})
    return out
