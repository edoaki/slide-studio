"""環境の確認（slide-studio doctor とホームの「環境」）。設計書 §7.1・§8.1・§10.1。"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

QUARTO_CANDIDATES = ["/Applications/quarto/bin/quarto", "/usr/local/bin/quarto", "/opt/quarto/bin/quarto"]


class PandocNotFound(RuntimeError):
    pass


def _arch() -> str:
    return "aarch64" if platform.machine() in ("arm64", "aarch64") else "x86_64"


@lru_cache(maxsize=1)
def pandoc_path() -> Path:
    """明示指定、依存パッケージ同梱版、PATH、旧 Quarto 環境の順に探す。"""
    override = os.environ.get("SLIDE_STUDIO_PANDOC")
    if override:
        path = Path(override)
        if not path.is_file():
            raise PandocNotFound(f"指定された Pandoc がありません: {override}")
        return path
    import pypandoc

    bundled = Path(pypandoc.__file__).parent / "files" / ("pandoc.exe" if os.name == "nt" else "pandoc")
    if bundled.is_file():
        return bundled
    standalone = shutil.which("pandoc")
    if standalone:
        return Path(standalone)
    quarto = shutil.which("quarto") or next((q for q in QUARTO_CANDIDATES if Path(q).is_file()), None)
    if not quarto:
        raise PandocNotFound("同梱の Pandoc が見つかりません。Slide Studio を起動し直してください。")
    tools = Path(quarto).resolve().parent / "tools"
    for candidate in (tools / _arch() / "pandoc", tools / "pandoc"):
        if candidate.is_file():
            return candidate.resolve()
    raise PandocNotFound(f"Quarto 同梱の Pandoc が見つかりません: {tools}")


@lru_cache(maxsize=1)
def pandoc_version() -> str:
    out = subprocess.run([str(pandoc_path()), "--version"], capture_output=True, text=True, check=True).stdout
    return out.splitlines()[0].split()[-1]


@dataclass
class Item:
    name: str
    ok: bool
    detail: str
    fix: str = ""


@dataclass
class Report:
    items: list[Item] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(i.ok for i in self.items)

    def to_json(self) -> dict:
        return {"ok": self.ok, "items": [i.__dict__ for i in self.items]}


def check_pandoc() -> Item:
    try:
        return Item("Pandoc", True, f"{pandoc_version()}（{pandoc_path()}）")
    except (PandocNotFound, subprocess.CalledProcessError, OSError) as e:
        return Item("Pandoc", False, str(e), "Slide Studio を起動し直してください")


def check_chromium() -> Item:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            exe = Path(p.chromium.executable_path)
        if exe.exists():
            return Item("Chromium", True, str(exe))
        return Item("Chromium", False, "検査・PDF用のブラウザが未導入です", "ホームの準備ボタンを押してください")
    except Exception as e:  # noqa: BLE001 - 環境の表示なので理由をそのまま出す
        return Item("Chromium", False, str(e), "ホームの準備ボタンを押してください")


def check_ai() -> Item:
    """AI の CLI（Codex・Claude Code）。どれか1つが使えればよい。"""
    from concurrent.futures import ThreadPoolExecutor

    from .ai.providers import PROVIDERS

    with ThreadPoolExecutor(len(PROVIDERS)) as pool:
        found = list(pool.map(lambda p: p.detect({}), PROVIDERS.values()))
    why = {"missing": "見つかりません", "login": "ログインしていません", "error": "確かめられません"}
    detail = "・".join(f"{p['name']} " + (f"✓（{len(p['models'])} モデル）" if p["ok"] else why.get(p["reason"], p["reason"])) for p in found)
    if any(p["ok"] for p in found):
        return Item("AI", True, detail)
    return Item("AI", False, detail, "チャットのログインボタンから始められます")


def run_all() -> Report:
    return Report([check_pandoc(), check_chromium(), check_ai()])
