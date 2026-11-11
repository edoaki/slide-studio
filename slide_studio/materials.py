"""発表の参考資料。設計書 §4.1・§10.6。

decks/<発表>/materials/ に、その発表の参考資料（実験結果のフォルダ・PowerPoint の雛形・論文の PDF など）を
形式を問わず置く（figures/・images/ と並ぶ）。スライドには直接は入らず、AI への指示に場所と一覧を添える。
実験結果は大きいことがあるので、AI 実行前の控え（snapshot.py）・描き直し（server.py）の対象にしない。
"""
from __future__ import annotations

import filecmp
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

from .fsutil import sha256_bytes, write_atomic
from .workspace import StudioError, Workspace

DIR = "materials"
MAX_BYTES = 500 * 1024 * 1024
PROMPT_LIMIT = 30


def is_material(rel: str) -> bool:
    """置き場からの相対パス（decks/<発表>/materials/…）が参考資料か。"""
    parts = rel.split("/")
    return len(parts) > 2 and parts[0] == "decks" and parts[2] == DIR


def folder(ws: Workspace, deck: str) -> Path:
    return ws.require_deck(deck) / DIR


def _rel_parts(path: str) -> list[str]:
    """持ち込むファイルの、置き場の中での位置（フォルダごと持ち込んだときは results/run1/a.csv など）。"""
    parts = [unicodedata.normalize("NFC", p).strip() for p in re.split(r"[\\/]+", path or "")]
    parts = [p for p in parts if p]
    if not parts or any(p in (".", "..") or p.startswith(".") or "\0" in p for p in parts):
        raise StudioError(f"このファイルは置けません: {path or '名前のないファイル'}")
    return parts


def _entries(base: Path) -> tuple[list[dict], int]:
    """フォルダの中身を木の順（フォルダが先、その直後に中身）に。隠しファイルは除く。閉じたフォルダの中身で後続の項目を打ち切らない。"""
    out: list[dict] = []
    more = 0

    def walk(d: Path) -> None:
        try:
            kids = sorted((f for f in d.iterdir() if not f.name.startswith(".")),
                          key=lambda f: (not f.is_dir() or f.is_symlink(), f.name.lower()))
        except OSError:
            return
        for f in kids:
            try:
                st = f.stat()
            except OSError:
                continue
            is_dir = f.is_dir() and not f.is_symlink()
            item = {"path": f.relative_to(base).as_posix(), "name": f.name, "dir": is_dir, "modified": st.st_mtime}
            if not is_dir:
                item["size"] = st.st_size
            out.append(item)
            if is_dir:
                walk(f)

    walk(base)
    return out, more


def listing(ws: Workspace, deck: str) -> dict:
    d = folder(ws, deck)
    entries, more = _entries(d) if d.is_dir() else ([], 0)
    return {"path": f"decks/{deck}/{DIR}", "entries": entries, "more": more}


def add(ws: Workspace, deck: str, path: str, data: bytes) -> dict:
    """ファイルを置く。同じ位置に同じ中身があればそれを使い、違えば 名前-2 にする（上書きしない）。"""
    if len(data) > MAX_BYTES:
        raise StudioError("ファイルが大きすぎます（500MB まで）。大きいものはフォルダを開いて直接置いてください")
    base, target = _target(ws, deck, path)
    stem, ext, n = target.stem, target.suffix, 2
    while target.exists():
        if target.is_file() and target.stat().st_size == len(data) and sha256_bytes(target.read_bytes()) == sha256_bytes(data):
            return {"path": target.relative_to(base).as_posix(), "reused": True}
        target, n = target.with_name(f"{stem}-{n}{ext}"), n + 1
    write_atomic(target, data)
    return {"path": target.relative_to(base).as_posix(), "reused": False}


def _target(ws: Workspace, deck: str, path: str) -> tuple[Path, Path]:
    """置き場の中の位置。途中のシンボリックリンクは通らない。"""
    base = folder(ws, deck)
    target = base.joinpath(*_rel_parts(path))
    p = target.parent
    while p != base.parent:
        if p.is_symlink():
            raise StudioError(f"シンボリックリンクを経由できません: {p}")
        p = p.parent
    return base, target


def create(ws: Workspace, deck: str, path: str, is_dir: bool) -> dict:
    """空のファイルかフォルダを作る。同じ名前があれば作らない。"""
    base, target = _target(ws, deck, path)
    if target.exists() or target.is_symlink():
        raise StudioError(f"同じ名前があります: {target.name}")
    if not target.parent.is_dir() and target.parent != base:
        raise StudioError(f"フォルダがありません: {target.parent.relative_to(base).as_posix()}")
    if is_dir:
        target.mkdir(parents=True)
    else:
        write_atomic(target, b"")
    return {"path": target.relative_to(base).as_posix()}


def move(ws: Workspace, deck: str, path: str, to: str) -> dict:
    """名前を変える・別のフォルダへ移す。行き先に同じ名前があれば動かさない。"""
    base, src = _target(ws, deck, path)
    _, dst = _target(ws, deck, to)
    if not src.exists() and not src.is_symlink():
        raise StudioError(f"見つかりません: {path}")
    if dst == src:
        return {"path": dst.relative_to(base).as_posix()}
    if dst.is_relative_to(src):
        raise StudioError("フォルダを自分の中には移せません")
    # 大文字・小文字だけの変更は、大文字小文字を区別しないディスクでも同じものとして通す
    same = dst.exists() and src.parent == dst.parent and dst.name.lower() == src.name.lower() and dst.samefile(src)
    if (dst.exists() or dst.is_symlink()) and not same:
        raise StudioError(f"同じ名前があります: {dst.relative_to(base).as_posix()}")
    if not dst.parent.is_dir():
        raise StudioError(f"フォルダがありません: {dst.parent.relative_to(base).as_posix()}")
    os.rename(src, dst)
    return {"path": dst.relative_to(base).as_posix()}


def delete(ws: Workspace, deck: str, path: str) -> dict:
    """消す。控え（snapshot）の対象外なので、すぐには消さず .slide-studio/trash/<発表>/<時刻>/ へ移す。"""
    base, src = _target(ws, deck, path)
    if not src.exists() and not src.is_symlink():
        raise StudioError(f"見つかりません: {path}")
    rel = src.relative_to(base)
    dest = ws.state / "trash" / deck / time.strftime("%Y%m%d-%H%M%S") / rel
    n = 2
    while dest.exists():
        dest = dest.with_name(f"{rel.name}-{n}")
        n += 1
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), dest)
    return {"path": rel.as_posix(), "trash": dest.relative_to(ws.root).as_posix()}


def restore(ws: Workspace, deck: str, path: str, trash: str) -> dict:
    """この発表のごみ箱から戻す。同名の資料やリンクを上書きしない。"""
    base, dst = _target(ws, deck, path)
    parts = Path(trash).parts
    if len(parts) < 5 or parts[:3] != (".slide-studio", "trash", deck) or any(p in (".", "..") for p in parts):
        raise StudioError("ごみ箱の場所が正しくありません")
    src = ws.root.joinpath(*parts)
    p = src.parent
    while p != ws.root:
        if p.is_symlink():
            raise StudioError("ごみ箱の場所が正しくありません")
        p = p.parent
    if not src.exists() and not src.is_symlink():
        raise StudioError("ごみ箱に見つかりません")
    if dst.exists() or dst.is_symlink():
        raise StudioError(f"同じ名前があります: {path}")
    if not dst.parent.is_dir() and dst.parent != base:
        raise StudioError(f"フォルダがありません: {path}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), dst)
    return {"path": dst.relative_to(base).as_posix()}


def _launch(path: Path) -> None:
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    elif os.name == "nt":
        os.startfile(path)  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(path)])


OPENER = _launch  # テストでは差し替える


def open_in_os(ws: Workspace, deck: str, path: str = "") -> str:
    """参考資料のフォルダ（無ければ作る）か、その中のファイルを、パソコンの既定のアプリで開く。"""
    base = folder(ws, deck)
    target = base.joinpath(*_rel_parts(path)) if path else base
    if not path:
        base.mkdir(parents=True, exist_ok=True)
    if not target.exists() or not target.resolve().is_relative_to(base.resolve()):
        raise StudioError(f"見つかりません: {path}")
    OPENER(target)
    return target.relative_to(ws.root).as_posix()


def copy_in(ws: Workspace, deck: str, path: str, sources: list[str]) -> dict:
    """パソコンのファイル・フォルダを、構成のまま置き場へコピーする。ブラウザを通さないので大きさの上限は無い。
    同じ位置に同じ中身のファイルがあればそれを使い、違えば（フォルダは常に）名前-2 にする（上書きしない）。"""
    base = folder(ws, deck)
    dest = _target(ws, deck, path)[1] if path else base
    if path and not dest.is_dir():
        raise StudioError(f"フォルダがありません: {path}")
    dest.mkdir(parents=True, exist_ok=True)
    added: list[str] = []
    reused = 0
    for src in map(Path, sources):
        name = unicodedata.normalize("NFC", src.name)
        if not src.exists() or name.startswith("."):
            continue
        if src.resolve().is_relative_to(base.resolve()):
            raise StudioError(f"参考資料の中のものは追加できません: {name}（移すときは持って動かしてください）")
        target, stem, ext, n = dest / name, Path(name).stem, Path(name).suffix, 2
        found = False
        while target.exists() or target.is_symlink():
            if src.is_file() and target.is_file() and filecmp.cmp(src, target, shallow=False):
                found = True
                break
            target = dest / (f"{name}-{n}" if src.is_dir() else f"{stem}-{n}{ext}")
            n += 1
        if found:
            reused += 1
            continue
        # 隠した名前でコピーしてから付け替える（途中で一覧に出ない・途中で止まっても半端なものが残らない）
        tmp = dest / f".{name}.{os.getpid()}.tmp"
        try:
            if src.is_dir():
                shutil.copytree(src, tmp, symlinks=True, ignore=shutil.ignore_patterns(".*"))
            else:
                shutil.copy2(src, tmp)
            os.rename(tmp, target)
        except BaseException:
            if tmp.is_dir():
                shutil.rmtree(tmp, ignore_errors=True)
            else:
                tmp.unlink(missing_ok=True)
            raise
        added.append(target.relative_to(base).as_posix())
    return {"added": added, "reused": reused}


def prompt_lines(ws: Workspace, deck: str) -> list[str]:
    """AI への指示に添える行（設計書 §8.3）。中身が無ければ何も足さない。"""
    d = folder(ws, deck)
    if not d.is_dir():
        return []
    entries, more = _entries(d)
    if not entries:
        return []
    top = [e for e in entries if "/" not in e["path"]]
    shown = [e["path"] + ("/" if e["dir"] else "") for e in top[:PROMPT_LIMIT]]
    rest = len(top) - len(shown)
    tail = f" ほか{rest}件" if rest > 0 else ""
    rel = d.relative_to(ws.root).as_posix()
    return [f"[参考資料] {rel}/ に {len(entries) + more} 件（読むだけ。変えない）：{'、'.join(shown)}{tail}"]
