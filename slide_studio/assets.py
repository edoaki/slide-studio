"""素材（画像・HTML）の一覧・追加・形式の判定と、挿入の補助（数式のプレビュー・文献の一覧）。

画像は topics/<トピック>/images/ に置き、原稿には images/名前 と書く。
HTML は Slide Studio の図（figure.mjs と雛形どおりの index.html。設計書 §5.3）だけをスライドに入れられる。
図の形式でない HTML は topics/<トピック>/html/ に置いて見られるようにし、入れられない理由を出す。
"""
from __future__ import annotations

import re
import shutil
import time
import unicodedata
from pathlib import Path

from . import figures as figs
from . import pandoc_worker, source
from .fsutil import sha256_bytes, write_atomic
from .workspace import StudioError, Workspace, figure_steps, figure_title

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}
HTML_EXT = {".html", ".htm"}
MAX_BYTES = 50 * 1024 * 1024
EXTERNAL = re.compile(r"""(?:src|href)\s*=\s*["']?(?:https?:)?//|@import\s+(?:url\()?["']?(?:https?:)?//|\bimport\s[^;]*?from\s*["'](?:https?:)?//""", re.I)
RENDER_STEP = re.compile(r"\brenderStep\s*[(:]")


def safe_name(name: str, fallback: str) -> str:
    """原稿にそのまま書けるファイル名にする（空白・括弧などは - に）。拡張子は小文字。"""
    name = unicodedata.normalize("NFC", Path(name or "").name)
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    stem = re.sub(r"[\s()\[\]{}<>\"'`#?%&;|\\/:*!$^=+,@]+", "-", stem).strip("-.") or fallback
    return stem[:80] + ext


def _free(base: Path, name: str, data: bytes) -> tuple[Path, bool]:
    """同じ中身のファイルがあればそれを使う（True）。名前が重なれば 名前-2。"""
    if base.exists():
        h = sha256_bytes(data)
        for f in sorted(base.iterdir()):
            if f.is_file() and f.stat().st_size == len(data) and sha256_bytes(f.read_bytes()) == h:
                return f, True
    stem, ext = Path(name).stem, Path(name).suffix
    target, n = base / name, 2
    while target.exists():
        target, n = base / f"{stem}-{n}{ext}", n + 1
    return target, False


def add(ws: Workspace, deck: str, filename: str, data: bytes, content_type: str = "") -> dict:
    """ファイルを素材に置く。画像は images/、HTML は html/。返す path はトピックのフォルダからの位置。"""
    ws.require_deck(deck)
    folder = ws.asset_root(deck)
    if len(data) > MAX_BYTES:
        raise StudioError("ファイルが大きすぎます（50MB まで）")
    ext = Path(filename or "").suffix.lower()
    if not ext and content_type.startswith("image/"):
        ext = "." + {"svg+xml": "svg", "jpeg": "jpg"}.get(content_type[6:].split(";")[0], content_type[6:].split(";")[0])
        filename = (filename or "") + ext
    if ext in IMAGE_EXT:
        kind, base = "images", folder / "images"
    elif ext in HTML_EXT:
        kind, base = "html", folder / "html"
    else:
        raise StudioError(f"画像か HTML を選んでください: {filename or '名前のないファイル'}")
    # クリップボードの画像は image.png などの名前で来るので、時刻の名前にする
    fallback = "paste-" + time.strftime("%Y%m%d-%H%M%S")
    name = safe_name(filename, fallback)
    if re.fullmatch(r"(image|blob|clipboard)\.\w+", name, re.I):
        name = fallback + ext
    target, reused = _free(base, name, data)
    if not reused:
        write_atomic(target, data)
    rel = target.relative_to(folder).as_posix()
    return {"kind": kind, "path": rel, "name": target.name, "reused": reused}


# ---------------------------------------------------------------- 一覧


def _usage(text: str, needle: re.Pattern) -> int:
    pages = re.split(r"(?m)^#{1,2}[ \t]+\S.*$", text)
    return sum(1 for p in pages if needle.search(p))


def figure_status(ws: Workspace, d: Path) -> tuple[str, list[str]]:
    """図のフォルダの形式：ok（そのまま使える）・warn（使えるが直すところがある）・ng（図の形式でない）。"""
    if not (d / "figure.mjs").is_file():
        return "ng", ["figure.mjs がありません（Slide Studio の図の形式ではありません）"]
    errors, warns = [], []
    try:
        code = (d / "figure.mjs").read_text()
    except (OSError, UnicodeDecodeError):
        return "ng", ["figure.mjs を読めません"]
    if "export default" not in code:
        errors.append("figure.mjs に export default がありません")
    elif not RENDER_STEP.search(code):
        errors.append("figure.mjs に renderStep がありません")
    for mod in figs.module_files(d):
        try:
            src = mod.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        rel = mod.relative_to(ws.root).as_posix() if mod.is_relative_to(ws.root) else mod.name
        for m in figs.DYNAMIC.finditer(src):
            errors.append(f"{'fetch' if 'fetch' in m[0] else '動的 import'} は使えません（{rel}）")
        for spec in figs.imports(src):
            if not (mod.parent / spec).resolve().exists():
                errors.append(f"部品がありません: {spec}（{rel}）")
        if EXTERNAL.search(src):
            errors.append(f"外部のファイルを読み込んでいます（{rel}）")
    css = d / "style.css"
    if css.is_file() and EXTERNAL.search(css.read_text(errors="replace")):
        errors.append("style.css で外部のファイルを読み込んでいます")
    if not (d / "index.html").is_file():
        warns.append("index.html がありません（表示するときに雛形から作ります）")
    elif (d / "index.html").read_text(errors="replace") != figs.index_html(d, ws):
        warns.append("index.html が雛形と違います（表示するときに雛形に戻します）")
    if errors:
        return "ng", list(dict.fromkeys(errors))
    return ("warn" if warns else "ok"), warns


def html_status(path: Path) -> tuple[str, list[str]]:
    """図の形式でない HTML ファイル。入れられない理由と、直すときに気をつけることを返す。"""
    reasons = ["Slide Studio の図の形式ではありません（figure.mjs の renderStep で step ごとの SVG を返す形が必要）"]
    try:
        html = path.read_text(errors="replace")
    except OSError:
        return "ng", ["読めません"]
    if EXTERNAL.search(html):
        reasons.append("外部（CDN など）のファイルを読み込んでいます。書き出した HTML はオフラインで動かないことがあります")
    if re.search(r"\b(fetch|XMLHttpRequest)\s*\(", html) or re.search(r"\bimport\s*\(", html):
        reasons.append("fetch・動的 import を使っています")
    return "ng", reasons


def _figure_item(ws: Workspace, d: Path, ref: str, place: str, text: str, others: dict[str, str]) -> dict:
    status, reasons = figure_status(ws, d)
    rel = d.relative_to(ws.root).as_posix()
    needle = re.compile(r"\{\{<\s*fig\s+\"?" + re.escape(ref) + r"[\"\s>]")
    return {"kind": "figure", "name": d.name, "path": f"html/{d.name}", "ref": ref, "place": place,
            "title": figure_title(d), "steps": len(figure_steps(d)),
            "url": f"/files/{rel}/index.html" if (d / "index.html").is_file() else None,
            "status": status, "reasons": reasons, "used": _usage(text, needle),
            "others": [k for k, t in others.items() if needle.search(t)], "modified": _mtime(d)}


def _mtime(d: Path) -> float:
    try:
        return max([d.stat().st_mtime, *(f.stat().st_mtime for f in d.iterdir())])
    except OSError:
        return 0


def _dirs(base: Path):
    if not base.is_dir():
        return []
    return [d for d in sorted(base.iterdir()) if d.is_dir() and not d.name.startswith((".", "_"))]


def _other_texts(ws: Workspace, deck: str, shelf: str | None) -> tuple[dict[str, str], dict[str, str]]:
    """ほかの発表の原稿：（すべて、同じトピックのもの）。図は別のトピックからも使えるので、両方を返す。"""
    every, same = {}, {}
    for d in ws.list_decks():
        if d == deck:
            continue
        try:
            every[d] = ws.qmd(d).read_text()
            if shelf and str(ws.deck_meta(d).get("topic") or "") == shelf:
                same[d] = every[d]
        except (OSError, StudioError):
            continue
    return every, same


def listing(ws: Workspace, deck: str) -> dict:
    """others は、ほかの発表のうちその素材を使っているもの（消すときに知らせる）。"""
    ws.require_deck(deck)
    folder = ws.asset_root(deck)
    text = ws.qmd(deck).read_text()
    try:
        shelf = ws.deck_shelf(deck)
    except StudioError:
        shelf = None
    every, same = _other_texts(ws, deck, shelf)
    images = []
    idir = folder / "images"
    if idir.is_dir():
        for f in sorted(idir.rglob("*")):
            if not f.is_file() or f.suffix.lower() not in IMAGE_EXT or f.name.startswith("."):
                continue
            rel = f.relative_to(folder).as_posix()
            needle = re.compile(r"\]\(<?" + re.escape(rel) + r"[\s)>]")
            st = f.stat()
            images.append({"kind": "image", "name": f.name, "path": rel, "size": st.st_size,
                           "url": f"/files/{folder.relative_to(ws.root).as_posix()}/{rel}?v={int(st.st_mtime)}",
                           "used": _usage(text, needle), "others": [k for k, t in same.items() if needle.search(t)],
                           "modified": st.st_mtime})
    html = []
    if shelf:
        for d in _dirs(ws.shelf_dir(shelf)):
            html.append(_figure_item(ws, d, f"{shelf}/{d.name}", "shelf", text, every))
    hdir = folder / "html"
    if hdir.is_dir():
        for f in sorted(hdir.rglob("*")):
            if f.is_file() and f.suffix.lower() in HTML_EXT and not f.name.startswith(".") and not (f.name == "index.html" and (f.parent / "figure.mjs").exists()):
                rel = f.relative_to(folder).as_posix()
                status, reasons = html_status(f)
                html.append({"kind": "html", "name": f.name, "path": rel, "place": "file", "title": f.stem,
                             "url": f"/files/{folder.relative_to(ws.root).as_posix()}/{rel}", "status": status, "reasons": reasons,
                             "used": 0, "others": [], "modified": f.stat().st_mtime})
    return {"shelf": shelf, "images": images, "html": html}


# ---------------------------------------------------------------- 削除


def _trash_base(ws: Workspace, shelf: str) -> Path:
    # 発表の名前は _ で始まらないので、発表のごみ箱（trash/<発表>/）とは重ならない
    return ws.state / "trash" / "_assets" / shelf


def _asset(ws: Workspace, deck: str, path: str) -> tuple[Path, Path]:
    """素材の場所（トピックのフォルダからの位置）を確かめる。images/ と html/ の中だけ。"""
    folder = ws.asset_root(deck)
    parts = Path(path).parts
    if len(parts) < 2 or parts[0] not in ("images", "html") or any(p in (".", "..") or p.startswith(".") for p in parts):
        raise StudioError(f"素材の場所が正しくありません: {path}")
    target = folder.joinpath(*parts)
    p = target.parent
    while p != folder:
        if p.is_symlink():
            raise StudioError(f"素材の場所が正しくありません: {path}")
        p = p.parent
    return folder, target


def delete(ws: Workspace, deck: str, paths: list[str]) -> list[dict]:
    """素材を消す。すぐには消さず .slide-studio/trash/_assets/<トピック>/<時刻>/ へ移す（取り消しで戻す）。
    先に全部を確かめてから動かすので、1つでも見つからなければ何も消さない。"""
    ws.require_deck(deck)
    shelf = ws.deck_shelf(deck)
    targets = []
    for path in dict.fromkeys(paths):
        folder, src = _asset(ws, deck, path)
        if not src.exists() and not src.is_symlink():
            raise StudioError(f"見つかりません: {path}")
        targets.append((src.relative_to(folder), src))
    # 図のフォルダと内部の HTML が同時に選ばれた場合は、フォルダごと一度だけ移す。
    selected = {rel for rel, _ in targets}
    targets = [(rel, src) for rel, src in targets if not any(parent in selected for parent in rel.parents)]
    stamp = _trash_base(ws, shelf) / f"{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 10**9:09d}"
    out = []
    for rel, src in targets:
        dest = stamp / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), dest)
        out.append({"path": rel.as_posix(), "trash": dest.relative_to(ws.root).as_posix()})
    return out


def restore(ws: Workspace, deck: str, items: list[dict]) -> list[dict]:
    """delete で移したものを戻す。同じ名前の素材があれば上書きせず、何も戻さない。"""
    ws.require_deck(deck)
    base = _trash_base(ws, ws.deck_shelf(deck))
    moves = []
    for it in items:
        path, trash = str(it.get("path") or ""), str(it.get("trash") or "")
        _, dst = _asset(ws, deck, path)
        parts = Path(trash).parts
        src = ws.root.joinpath(*parts)
        if any(p in (".", "..") for p in parts) or not src.is_relative_to(base) or len(src.relative_to(base).parts) < 2:
            raise StudioError("ごみ箱の場所が正しくありません")
        p = src.parent
        while p != ws.root:
            if p.is_symlink():
                raise StudioError("ごみ箱の場所が正しくありません")
            p = p.parent
        if not src.exists() and not src.is_symlink():
            raise StudioError(f"ごみ箱に見つかりません: {path}")
        if dst.exists() or dst.is_symlink():
            raise StudioError(f"同じ名前があります: {path}")
        moves.append((src, dst))
    for src, dst in moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), dst)
    return [{"path": it["path"]} for it in items]


# ---------------------------------------------------------------- 挿入の補助


def math_html(tex: str) -> str:
    """数式（TeX）を MathML にする。スライドと同じ Pandoc の読み方で、挿入の画面のプレビューに使う。"""
    tex = tex.strip()
    if not tex:
        return ""
    r = pandoc_worker.run(f"$$\n{source.math_breaks(tex)}\n$$\n", ["--from", "markdown+tex_math_dollars", "--to", "html5", "--mathml", "--wrap=none"], timeout=15)
    if r.returncode:
        raise StudioError(r.stderr.strip() or "数式を変換できません")
    out = r.stdout.strip()
    if "<math" not in out:
        raise StudioError("数式として読めません")
    return out


def bib_entries(ws: Workspace, deck: str) -> list[dict]:
    from .bibliography import require_ready, listing
    require_ready(ws, deck)
    out = []
    for entry in listing(ws.bib(deck)):
        fields, authors = entry["fields"], entry["authors"]
        first = authors[0]["name"].split(",")[0].strip() if authors else ""
        out.append({"key": entry["key"], "title": fields.get("title", ""),
                    "author": first + (" ほか" if len(authors) > 1 else ""),
                    "year": fields.get("year", ""), "unverified": entry["unverified"]})
    return out
