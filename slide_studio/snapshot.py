"""AI 実行前の控え・変更一覧・復元。設計書 §8.4。"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from .fsutil import sha256_bytes, write_atomic
from .materials import DIR as MATERIALS, is_material
from .workspace import StudioError, Workspace, check_name


@dataclass(frozen=True)
class Snapshot:
    path: Path
    deck: str
    shelf: str

    @property
    def scopes(self) -> tuple[str, ...]:
        return (f"decks/{self.deck}", f"topics/{self.shelf}", "themes")

    def covers(self, name: str) -> bool:
        """戻す範囲か。参考資料（materials/）は大きいことがあるので控えず、範囲の外として扱う。"""
        return not is_material(name) and any(name == s or name.startswith(s + "/") for s in self.scopes)


def _check_links(ws: Workspace, path: Path) -> None:
    """操作先の親を含め、リンクを経由した読み書きを防ぐ。"""
    current = ws.root
    for part in ("", *path.relative_to(ws.root).parts):
        current = current / part
        if current.is_symlink():
            raise StudioError(f"シンボリックリンクを経由できません: {current}")


def _snapshot_dir(ws: Workspace, deck: str) -> Path:
    check_name(deck, "発表の名前")
    path = ws.state / "snapshots" / deck
    _check_links(ws, path)
    return path


def _manifest(ws: Workspace) -> dict[str, str]:
    result = {}
    for base, dirs, files in os.walk(ws.root, followlinks=False):
        parent = Path(base)
        if parent == ws.root:
            dirs[:] = [name for name in dirs if name != ".slide-studio"]
            files = [name for name in files if name != ".slide-studio"]
        for name in list(dirs):
            if (parent / name).is_symlink():
                dirs.remove(name)
                files.append(name)
        for name in files:
            path = parent / name
            if path.is_symlink():
                # リンク先の内容ではなく、リンクそのものの変更を検出する。
                digest = sha256_bytes(b"symlink\0" + os.fsencode(os.readlink(path)))
            elif is_material(path.relative_to(ws.root).as_posix()):
                # 中身は読まず、大きさと更新時刻で変化だけを知る
                st = path.stat()
                digest = f"stat:{st.st_size}:{st.st_mtime_ns}"
            elif path.is_file():
                with path.open("rb") as f:
                    digest = hashlib.file_digest(f, "sha256").hexdigest()
            else:
                continue
            result[path.relative_to(ws.root).as_posix()] = digest
    return dict(sorted(result.items()))


def _skip_materials(src: Path):
    """発表のフォルダを控えるとき、直下の materials/ を除く。"""
    return lambda d, names: [MATERIALS] if Path(d) == src and src.parent.name == "decks" else []


def _copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_symlink():
        shutil.copy2(src, dst, follow_symlinks=False)
    elif src.is_dir():
        shutil.copytree(src, dst, symlinks=True, ignore=_skip_materials(src))
    elif src.exists():
        shutil.copy2(src, dst)


def _remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def take(ws: Workspace, deck: str) -> Snapshot:
    """発表・棚全体・themes と、.slide-studio/ 以外の全ファイルのハッシュを控える。"""
    base = _snapshot_dir(ws, deck)
    _check_links(ws, ws.qmd(deck))
    ws.require_deck(deck)
    shelf = check_name(ws.deck_shelf(deck), "棚の名前")
    base.mkdir(parents=True, exist_ok=True)
    stamp = time.time_ns()
    while True:
        path = base / f"{stamp:020d}"
        try:
            path.mkdir()
            break
        except FileExistsError:
            stamp += 1
    snap = Snapshot(path, deck, shelf)
    try:
        for scope in snap.scopes:
            _check_links(ws, ws.root / scope)
            _copy(ws.root / scope, path / "files" / scope)
        write_atomic(path / "manifest.json", json.dumps(_manifest(ws), ensure_ascii=False, indent=1))
        # 最後に書き、途中で失敗した控えを一覧に出さない。
        write_atomic(path / "snapshot.json", json.dumps({"deck": deck, "shelf": shelf}, ensure_ascii=False))
    except BaseException:
        shutil.rmtree(path)
        raise
    for old in list_snapshots(ws, deck)[20:]:
        shutil.rmtree(old.path)
    return snap


def list_snapshots(ws: Workspace, deck: str) -> list[Snapshot]:
    """新しい順の一覧。置き場を開き直しても使える。"""
    base = _snapshot_dir(ws, deck)
    if not base.exists():
        return []
    result = []
    for path in sorted(base.iterdir(), reverse=True):
        if path.is_symlink() or not path.is_dir():
            continue
        meta = path / "snapshot.json"
        if meta.is_symlink() or not meta.is_file():
            continue
        data = json.loads(meta.read_text())
        if data["deck"] != deck:
            raise StudioError(f"控えの発表が一致しません: {path}")
        result.append(Snapshot(path, deck, check_name(data["shelf"], "棚の名前")))
    return result


def latest(ws: Workspace, deck: str) -> Snapshot | None:
    items = list_snapshots(ws, deck)
    return items[0] if items else None


def changes(ws: Workspace, snap: Snapshot) -> dict:
    """相対パスの一覧 added・modified・deleted と、範囲外の警告 outside を返す。"""
    if snap.path.parent != _snapshot_dir(ws, snap.deck):
        raise StudioError(f"この置き場の控えではありません: {snap.path}")
    _check_links(ws, snap.path / "manifest.json")
    before = json.loads((snap.path / "manifest.json").read_text())
    after = _manifest(ws)
    result = {key: [] for key in ("added", "modified", "deleted", "outside")}
    for name in sorted(before.keys() | after.keys()):
        if before.get(name) == after.get(name):
            continue
        if not snap.covers(name):
            key = "outside"
        elif name not in before:
            key = "added"
        elif name not in after:
            key = "deleted"
        else:
            key = "modified"
        result[key].append(name)
    return result


def find(ws: Workspace, deck: str, name: str) -> Snapshot:
    for snap in list_snapshots(ws, deck):
        if snap.path.name == name:
            return snap
    raise StudioError("控えが残っていません（発表ごとに最新20件を残します）")


def finish(ws: Workspace, snap: Snapshot) -> dict:
    """AI の終了時の一覧を控え、実行中の変更（changes と同じ形）を返す。"""
    write_atomic(snap.path / "after.json", json.dumps(_manifest(ws), ensure_ascii=False, indent=1))
    return run_changes(ws, snap)


def changes_since_finish(ws: Workspace, snap: Snapshot) -> list[str]:
    """確認中の変更を知らせる。実装終了時のafter.json（復元範囲）は更新しない。"""
    after_file = snap.path / 'after.json'
    if not after_file.exists():
        return []
    after, current = json.loads(after_file.read_text()), _manifest(ws)
    return sorted(name for name in after.keys() | current.keys() if after.get(name) != current.get(name))


def run_changes(ws: Workspace, snap: Snapshot) -> dict:
    """実行の前後（finish の時点）の差。finish 前なら今との差。"""
    after_file = snap.path / "after.json"
    if not after_file.is_file():
        return changes(ws, snap)
    before = json.loads((snap.path / "manifest.json").read_text())
    after = json.loads(after_file.read_text())
    result = {key: [] for key in ("added", "modified", "deleted", "outside")}
    for name in sorted(before.keys() | after.keys()):
        if before.get(name) == after.get(name):
            continue
        if not snap.covers(name):
            key = "outside"
        elif name not in before:
            key = "added"
        elif name not in after:
            key = "deleted"
        else:
            key = "modified"
        result[key].append(name)
    return result


def restore_plan(ws: Workspace, snap: Snapshot, only: set[str] | None = None, keep: set[str] = frozenset()) -> dict:
    """restore_run で戻すファイル。ファイルは変えない（戻す前の確認に出す）。

    only を渡すと、その中のファイルだけを戻す（下書きのチャットは memo.md だけ。並行してスライドを編集できるため）。
    keep は戻さないファイル（実行中に利用者が画面で直したもの）。戻す対象から外したものを kept に入れる。
    later は実行の後に別の操作でさらに変わっていたファイル（戻すとその変更も消える）。
    """
    result = run_changes(ws, snap)
    result["kept"] = []
    for key in ("added", "modified", "deleted"):
        names = [n for n in result[key] if only is None or n in only]
        result["kept"] += [n for n in names if n in keep]
        result[key] = [n for n in names if n not in keep]
    after_file = snap.path / "after.json"
    after = json.loads(after_file.read_text()) if after_file.is_file() else {}
    now = _manifest(ws)
    names = result["added"] + result["modified"] + result["deleted"]
    result["later"] = [n for n in names if after and now.get(n) != after.get(n)]
    return result


def restore_run(ws: Workspace, snap: Snapshot, only: set[str] | None = None, keep: set[str] = frozenset()) -> dict:
    """その実行で変わったファイルだけを実行前に戻す（引数と結果は restore_plan と同じ）。

    変わったかどうかは実行の前後の差で決めるので、同じ時間に動いた他の実行の変更も含まれる（区別できない）。
    """
    result = restore_plan(ws, snap, only, keep)
    names = result["added"] + result["modified"] + result["deleted"]
    for name in names:
        _check_links(ws, (ws.root / name).parent)
    for name in result["modified"] + result["deleted"]:
        _check_links(ws, snap.path / "files" / name)
    for name in names:
        dest = ws.root / name
        if name in result["added"]:
            _remove(dest)
            scope = next(s for s in snap.scopes if name.startswith(s + "/"))
            parent = dest.parent
            while parent != ws.root / scope and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
        else:
            _remove(dest)
            _copy(snap.path / "files" / name, dest)
    return result


def restore(ws: Workspace, snap: Snapshot) -> dict:
    """対象範囲を控えに戻し、復元前の変更一覧を返す。outside は戻さない。"""
    result = changes(ws, snap)
    # 一部を消してから親のリンクに気付くことがないよう、先にすべて確認する。
    for scope in snap.scopes:
        _check_links(ws, (ws.root / scope).parent)
        _check_links(ws, snap.path / "files" / scope)
    for scope in snap.scopes:
        dest = ws.root / scope
        keep = dest / MATERIALS if scope.startswith("decks/") else None
        if keep and keep.is_dir() and not keep.is_symlink():
            # 参考資料は控えていないので残し、それ以外を控えに戻す
            for child in dest.iterdir():
                if child != keep:
                    _remove(child)
            for child in (snap.path / "files" / scope).iterdir():
                _copy(child, dest / child.name)
        else:
            _remove(dest)
            _copy(snap.path / "files" / scope, dest)
    return result
