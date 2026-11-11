"""共有する図の作成・トピック間のコピー。設計書 §5.3・§5.4・§11。

図のフォルダは index.html（雛形どおり）・figure.mjs・任意の style.css などからなる。
棚や発表の外の部品（_lib/ や別の図のファイル）は、コピー先の _lib/ にそろえる。
同じ名前の部品が既にあるとき、中身が同じならそれを使い、違えば 名前-2.mjs としてコピーして import を書き換える。
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from . import source
from .bundle import MODULE_SPEC
from .fsutil import write_atomic
from .workspace import TEMPLATES, StudioError, Workspace, check_name, runtime_rel

# 静的な import だけを扱う（§5.3）：import X from './x.mjs'・import {a} from …・import './x.mjs'・export … from
IMPORT = MODULE_SPEC
DYNAMIC = re.compile(r"""\bimport\s*\(|\bfetch\s*\(""")
SKIP = {"index.html", "main.mjs", ".DS_Store"}


def imports(code: str) -> list[str]:
    return [m["spec"] for m in IMPORT.finditer(code) if m["spec"].startswith(".")]


def index_html(fig_dir: Path, ws: Workspace) -> str:
    style = '<link rel="stylesheet" href="style.css">\n' if (fig_dir / "style.css").exists() else ""
    return (TEMPLATES / "figure" / "index.html").read_text().replace("{{RUNTIME}}", runtime_rel(fig_dir, ws)).replace("{{STYLE}}", style)


def write_index(fig_dir: Path, ws: Workspace) -> None:
    write_atomic(fig_dir / "index.html", index_html(fig_dir, ws))


def ensure_index(fig_dir: Path, ws: Workspace) -> bool:
    """index.html を雛形どおりにする（style.css を足した後など）。書き換えたら True。"""
    if not (fig_dir / "figure.mjs").exists():
        return False
    want = index_html(fig_dir, ws)
    try:
        if (fig_dir / "index.html").read_text() == want:
            return False
    except OSError:
        pass
    write_atomic(fig_dir / "index.html", want)
    return True


def free_name(base: Path, name: str) -> str:
    if not (base / name).exists():
        return name
    n = 2
    while (base / f"{name}-{n}").exists():
        n += 1
    return f"{name}-{n}"


def new_figure(ws: Workspace, name: str, base: Path, title: str | None = None) -> Path:
    check_name(name, "図の名前")
    dest = base / name
    if dest.exists():
        raise StudioError(f"既にあります: {dest}")
    dest.mkdir(parents=True)
    t = TEMPLATES / "figure"
    write_atomic(dest / "figure.mjs", (t / "figure.mjs").read_text().replace("{{NAME}}", name).replace("{{TITLE}}", title or name))
    shutil.copy2(t / "style.css", dest / "style.css")
    write_index(dest, ws)
    return dest


class _Copier:
    """図をフォルダごと別の置き場（棚か発表の figures/）へ写す。"""

    def __init__(self, ws: Workspace, src_dir: Path, dst_base: Path, lib_names=("_lib",), siblings: dict | None = None, allow: Path | None = None):
        self.ws, self.src_dir, self.dst_base = ws, src_dir.resolve(), dst_base
        self.allow = [ws.root.resolve()] + ([allow.resolve()] if allow else [])
        self.lib_names = lib_names  # この名前のフォルダの部品は、名前を変えずに _lib/ へ置く
        self.siblings = siblings or {}  # 一緒に写す図：元のフォルダ → コピー先のフォルダ
        self.placed: dict[Path, Path] = {}  # 元の部品 → コピー先
        self.stack: set[Path] = set()

    def resolve(self, owner: Path, spec: str) -> Path:
        path = (owner.parent / spec).resolve()
        if not any(path.is_relative_to(a) for a in self.allow):
            raise StudioError(f"置き場の外の部品は使えません: {spec}（{owner}）")
        if not path.exists():
            raise StudioError(f"import 先がありません: {spec}（{owner}）")
        return path

    def rewrite(self, owner_src: Path, owner_dst: Path, code: str) -> str:
        def repl(m):
            spec = m["spec"]
            if not spec.startswith("."):
                return m[0]
            dep = self.resolve(owner_src, spec)
            target = self.target_of(dep, owner_dst)
            rel = os.path.relpath(target, owner_dst.parent).replace(os.sep, "/")
            if not rel.startswith("."):
                rel = "./" + rel
            return f"{m['pre']}{m['q']}{rel}{m['q']}"
        return IMPORT.sub(repl, code)

    def target_of(self, dep: Path, owner_dst: Path) -> Path:
        if dep.is_relative_to(self.src_dir):
            return self.fig_dst / dep.relative_to(self.src_dir)
        for src, dst in self.siblings.items():
            if dep.is_relative_to(src):
                return dst / dep.relative_to(src)
        return self.place_lib(dep)

    def place_lib(self, dep: Path) -> Path:
        if dep in self.placed:
            return self.placed[dep]
        lib = self.dst_base / "_lib"
        parent = dep.parent
        # 元の _lib の部品は同じ名前で、別の図のファイルは「図の名前-ファイル名」で置く
        stem_name = dep.name if parent.name in self.lib_names else f"{parent.name}-{dep.name}"
        if dep in self.stack:  # 循環：中身の比較はせず名前だけ決める
            target = lib / stem_name
            self.placed[dep] = target
            return target
        self.stack.add(dep)
        data = dep.read_bytes()
        if dep.suffix in (".mjs", ".js"):
            probe = lib / stem_name
            data = self.rewrite(dep, probe, dep.read_text()).encode()
        stem, suffix = os.path.splitext(stem_name)
        n = 1
        while True:
            candidate = lib / (stem_name if n == 1 else f"{stem}-{n}{suffix}")
            if not candidate.exists():
                if candidate.name != stem_name and dep.suffix in (".mjs", ".js"):
                    data = self.rewrite(dep, candidate, dep.read_text()).encode()
                write_atomic(candidate, data)
                break
            if candidate.read_bytes() == data:
                break
            n += 1
        self.stack.discard(dep)
        self.placed[dep] = candidate
        return candidate

    def copy(self, name: str) -> Path:
        self.fig_dst = self.dst_base / name
        self.fig_dst.mkdir(parents=True, exist_ok=True)
        for f in sorted(self.src_dir.rglob("*")):
            if f.is_dir() or f.name in SKIP:
                continue
            rel = f.relative_to(self.src_dir)
            out = self.fig_dst / rel
            if f.suffix in (".mjs", ".js"):
                write_atomic(out, self.rewrite(f, out, f.read_text()))
            else:
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, out)
        write_index(self.fig_dst, self.ws)
        return self.fig_dst


def copy_figure(ws: Workspace, src_dir: Path, dst_base: Path, name: str | None = None, replace: bool = False) -> Path:
    """図を dst_base（棚か発表の figures/）に写す。名前が重なれば -2（replace なら置き換える）。"""
    if not (src_dir / "figure.mjs").exists():
        raise StudioError(f"図がありません: {src_dir}")
    name = name or src_dir.name
    if replace and (dst_base / name).exists():
        shutil.rmtree(dst_base / name)
    elif not replace:
        name = free_name(dst_base, name)
    return _Copier(ws, src_dir, dst_base).copy(name)


FIG_REF = re.compile(r"""(\{\{<\s*fig\s+)("?)([^"\s>]+)\2""")


def rewrite_refs(text: str, old: str, new: str) -> str:
    return FIG_REF.sub(lambda m: f"{m[1]}{m[2]}{new}{m[2]}" if m[3] == old else m[0], text)


def fig_refs(text: str) -> list[str]:
    doc = source.parse(text)
    out = []
    for p in doc.pages:
        for c in p.walk():
            if c.kind == "fig":
                args = source.fig_args(text[c.start:c.end])
                if args:
                    out.append(args["ref"])
    return out


def module_files(fig_dir: Path) -> list[Path]:
    """図が読む .mjs（図のフォルダの中と、そこから import される部品）。"""
    seen: list[Path] = []
    todo = [p for p in sorted(fig_dir.rglob("*.mjs")) if p.name != "main.mjs"]
    while todo:
        p = todo.pop()
        p = p.resolve()
        if p in seen or not p.exists():
            continue
        seen.append(p)
        for spec in imports(p.read_text()):
            todo.append((p.parent / spec))
    return seen
