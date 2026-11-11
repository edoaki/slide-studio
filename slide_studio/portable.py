"""保管フォルダだけで再ビルドするためのコードと入口を配置する。"""
import json

from .fsutil import sha256_bytes, write_atomic
from .workspace import PKG, TEMPLATES

MODULES = (
    "__init__", "workspace", "portable", "fsutil", "source", "render",
    "pandoc_worker", "doctor", "bundle", "export", "check", "httpd", "figures",
    "steps", "page_templates", "bibliography", "topic_migrate", "cover", "theme_edit",
    "block_design",
)


def ensure_portable(ws):
    target = ws.state / "compiler" / "slide_studio"
    if PKG == target:
        return
    files = [(PKG / f"{name}.py", target / f"{name}.py") for name in MODULES]
    for directory in ("runtime", "lua", "templates"):
        files.extend((p, target / p.relative_to(PKG)) for p in sorted((PKG / directory).rglob("*"))
                     if p.is_file() and "__pycache__" not in p.parts and p.name != ".DS_Store")
    # 検査のレイアウトの判定は編集画面と共用のファイル（check.py が読む）
    # ひな形の仮の文字は UI の文言が正本（page_templates.py が読む）
    for shared in (PKG / "web" / "inject" / "layout-check.js", PKG / "web" / "strings.js"):
        files.append((shared, target / shared.relative_to(PKG)))
    files.extend((TEMPLATES / "portable" / name, ws.root / name) for name in ("README.md", "build.py"))
    stamp = ws.state / "portable-files.json"
    try:
        known = json.loads(stamp.read_text())
    except (OSError, ValueError):
        known = {}
    for src, dst in files:
        data = src.read_bytes()
        key = dst.relative_to(ws.root).as_posix()
        # README・スクリプトも利用者が編集したものは残す。
        if dst.exists() and dst.read_bytes() != data and known.get(key) != sha256_bytes(dst.read_bytes()):
            continue
        if not dst.exists() or dst.read_bytes() != data:
            write_atomic(dst, data)
        known[key] = sha256_bytes(data)
    write_atomic(stamp, json.dumps(known, indent=1))
