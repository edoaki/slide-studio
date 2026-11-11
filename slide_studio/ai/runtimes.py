"""AI の CLI をアプリ専用に取得・更新する。ターミナルの CLI や履歴には触らない。

実行ファイルは各社の公式の配布元からそのまま取得し、配布元が示すハッシュで照合する（中身は変えない）。
<home>/runtime/<版>/ に置き、使う版は <home>/runtime/state.json で決める。一つ前の版は戻せるように残す。
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from ..fsutil import write_atomic
from ..workspace import StudioError

ENABLED = True  # 裏の自動更新（テストでは止める）
CHECK_EVERY = 3600  # 裏で見直す間隔（秒）
CHECK_TTL = 24 * 3600  # 配布元へ最新版を聞く間隔（秒）
FIRST_DELAY = 30  # 起動の直後は待つ（秒）
MAX_META = 16 * 1024 * 1024
MAX_PAYLOAD = 1024 * 1024 * 1024
VERSION = re.compile(r'^\d+\.\d+\.\d+')
RELEASE_ERRORS = (OSError, http.client.HTTPException, ValueError, KeyError, TypeError, AttributeError, IndexError,
                  StopIteration)
INSTALL_ERRORS = (OSError, http.client.HTTPException, ValueError, tarfile.TarError)
DEFAULT_STATE = {'current': None, 'previous': None, 'latest': None, 'checked': 0, 'auto': True, 'skip': None, 'error': None}


@dataclass(frozen=True)
class Release:
    version: str
    url: str
    algorithm: str  # sha256・sha512
    digest: str
    size: int | None = None


def _key(version: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r'\d+', version.split('-')[0]))


def _get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read(MAX_META)


def _version(text: str) -> str:
    version = text.strip()
    if not VERSION.match(version):
        raise ValueError('版を読み取れませんでした')
    return version


def _system() -> tuple[str, str]:
    system = {'Darwin': 'darwin', 'Linux': 'linux'}.get(platform.system())
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64', 'amd64': 'x64'}.get(platform.machine())
    if not system or not arch:
        raise StudioError('この環境では AI の自動準備に対応していません。')
    return system, arch


def _musl() -> bool:
    return any(Path(p).exists() for p in ('/lib/libc.musl-x86_64.so.1', '/lib/libc.musl-aarch64.so.1'))


def _extract_all(archive: Path, staging: Path) -> None:
    with tarfile.open(archive) as package:
        for entry in package:
            path = staging / entry.name
            if not path.resolve().is_relative_to(staging.resolve()):
                raise ValueError('不正な保存先です')
            if entry.isdir():
                continue
            if not entry.isfile():
                raise ValueError('未対応のファイルです')
            with package.extractfile(entry) as source:
                write_atomic(path, source.read())
            path.chmod(0o755 if entry.mode & 0o111 else 0o644)


def _place_binary(payload: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(payload, dest)
    dest.chmod(0o755)


class Source:
    """配布元。latest() で最新版を調べ、unpack() で版のフォルダの形にする。"""
    relpath = ''

    def latest(self) -> Release:
        raise NotImplementedError

    def fallback(self) -> Release | None:
        """配布元の案内を読めないときに初回の取得で使う版。"""
        return None

    def unpack(self, release: Release, payload: Path, staging: Path) -> None:
        raise NotImplementedError


class CodexSource(Source):
    relpath = 'bin/codex'
    API = 'https://api.github.com/repos/openai/codex/releases/latest'
    PINNED = '0.160.0'
    # openai/codex の rust-v0.160.0 リリースの package アセットの SHA-256。
    DIGESTS = {
        'aarch64-apple-darwin': '007df41b607dbbc8d204b9746ce7fed2d4ce6c813f44c32ceee54175ca796525',
        'x86_64-apple-darwin': '4d50514b2d8acd81ca8cfee55b667b3dc4f7681b65bf3299ff06b11a064f8861',
        'aarch64-unknown-linux-musl': '7f0fe42ff22ecfa3a47bc4a34f5b22c4218b431a4ec0aba51c7d98299f07900c',
        'x86_64-unknown-linux-musl': '4fcc47ab57f52ff75363951a8761146cd10c8288bd86fed45487dbb204a16b71',
    }

    @staticmethod
    def target() -> str:
        system, arch = _system()
        return f"{'aarch64' if arch == 'arm64' else 'x86_64'}-{'apple-darwin' if system == 'darwin' else 'unknown-linux-musl'}"

    def latest(self) -> Release:
        data = json.loads(_get(self.API))
        name = f'codex-package-{self.target()}.tar.gz'
        asset = next(a for a in data['assets'] if a['name'] == name)
        algorithm, _, digest = asset['digest'].partition(':')
        return Release(_version(data['tag_name'].removeprefix('rust-v')), asset['browser_download_url'], algorithm, digest,
                       asset.get('size'))

    def fallback(self) -> Release:
        key = self.target()
        return Release(self.PINNED,
                       f'https://github.com/openai/codex/releases/download/rust-v{self.PINNED}/codex-package-{key}.tar.gz',
                       'sha256', self.DIGESTS[key])

    def unpack(self, release, payload, staging):
        _extract_all(payload, staging)


class ClaudeSource(Source):
    """Claude Code の公式配布元（公式の install.sh と同じ場所）。不具合の大きい版を避けられる stable を追う。"""
    relpath = 'claude'
    BASE = 'https://downloads.claude.ai/claude-code-releases'
    CHANNEL = 'stable'

    @staticmethod
    def platform() -> str:
        system, arch = _system()
        return f"{system}-{arch}{'-musl' if system == 'linux' and _musl() else ''}"

    def latest(self) -> Release:
        version = _version(_get(f'{self.BASE}/{self.CHANNEL}').decode())
        name = self.platform()
        entry = json.loads(_get(f'{self.BASE}/{version}/manifest.json'))['platforms'][name]
        return Release(version, f'{self.BASE}/{version}/{name}/claude', 'sha256', entry['checksum'], entry.get('size'))

    def unpack(self, release, payload, staging):
        _place_binary(payload, staging / self.relpath)


class AgySource(Source):
    """Antigravity CLI の公式の manifest（公式の install.sh と同じ場所）。"""
    relpath = 'agy'
    BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'

    @staticmethod
    def platform() -> str:
        system, arch = _system()
        arch = 'amd64' if arch == 'x64' else arch
        return f"{system}_{arch}{'_musl' if system == 'linux' and _musl() else ''}"

    def latest(self) -> Release:
        data = json.loads(_get(f'{self.BASE}/manifests/{self.platform()}.json'))
        return Release(_version(data['version']), data['url'], 'sha512', data['sha512'])

    def unpack(self, release, payload, staging):
        if '.tar.gz' not in release.url:
            _place_binary(payload, staging / self.relpath)
            return
        with tarfile.open(payload) as package:
            entry = package.getmember('antigravity')
            if not entry.isfile():
                raise ValueError('未対応のファイルです')
            with package.extractfile(entry) as source:
                write_atomic(staging / self.relpath, source.read())
        (staging / self.relpath).chmod(0o755)


SOURCES: dict[str, Source] = {'codex': CodexSource(), 'claude': ClaudeSource(), 'agy': AgySource()}


class Runtime:
    """1つの AI のアプリ専用の実行ファイル。取得・切り替えは lock の中で1つずつ行う。"""

    def __init__(self, provider):
        self.provider = provider
        self.source = SOURCES[provider.id]
        self.lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.updating = False
        self.progress: dict | None = None

    @property
    def root(self) -> Path:
        return self.provider.home() / 'runtime'

    def state(self) -> dict:
        try:
            saved = json.loads((self.root / 'state.json').read_text())
        except (OSError, ValueError):
            saved = {}
        return {**DEFAULT_STATE, **(saved if isinstance(saved, dict) else {})}

    def _save(self, **values) -> None:
        with self.state_lock:
            write_atomic(self.root / 'state.json', json.dumps({**self.state(), **values}, ensure_ascii=False))

    def set_auto(self, auto: bool) -> None:
        self._save(auto=auto)

    def busy(self) -> bool:
        return self.updating or self.lock.locked()

    def _usable(self, version: str) -> bool:
        exe = self.root / version / self.source.relpath
        return exe.is_file() and os.access(exe, os.X_OK)

    def version(self) -> str | None:
        """今使う版（state.json に無ければ、置いてある中で一番新しい版）。"""
        current = self.state()['current']
        on_disk = sorted((d.name for d in self.root.iterdir() if d.is_dir() and VERSION.match(d.name)), key=_key,
                         reverse=True) if self.root.is_dir() else []
        return next((v for v in ([current] if current else []) + on_disk if self._usable(v)), None)

    def executable(self) -> Path | None:
        version = self.version()
        return self.root / version / self.source.relpath if version else None

    def check(self) -> Release:
        """配布元に最新版を聞いて覚える。"""
        try:
            release = self.source.latest()
        except RELEASE_ERRORS as exc:
            message = f'{self.provider.name} の最新版を確かめられませんでした。'
            self._save(error=message)
            raise StudioError(message) from exc
        self._save(latest=release.version, checked=time.time(), error=None)
        return release

    def ensure(self, accept=None) -> str:
        """アプリ専用の実行ファイルを用意する（あればそのまま）。"""
        with self.lock:
            found = self.executable()
            if found:
                return str(found)
            try:
                release = self.source.latest()
            except RELEASE_ERRORS as exc:
                release = self.source.fallback()
                if release is None:
                    raise StudioError(f'{self.provider.name} を準備できませんでした。接続を確認して、もう一度お試しください。') from exc
            return self._install(release, accept)

    def install(self, release: Release, accept=None) -> str:
        with self.lock:
            return self._install(release, accept)

    def update(self, accept=None, force: bool = False) -> bool:
        """新しい版があれば入れ替える。force：手動の更新（戻した版も入れ直す）。"""
        with self.lock:
            release = self.check()
            state, current = self.state(), self.version()
            if current is not None and _key(release.version) <= _key(current):
                return False
            if not force and release.version == state['skip']:
                return False
            try:
                self._install(release, accept)
            except StudioError as exc:
                self._save(error=str(exc))
                raise
            return True

    def rollback(self) -> None:
        """一つ前の版と入れ替える。戻した版は自動更新で入れ直さない。"""
        with self.lock:
            state = self.state()
            target, current = state['previous'], self.version()
            if not target or not self._usable(target):
                raise StudioError('戻せる版がありません。')
            self._save(current=target, previous=current, skip=current, error=None)

    def _install(self, release: Release, accept=None) -> str:
        """取得 → 照合 → 動作確認 → 切り替え。途中で失敗したら今の版のまま。"""
        dest = self.root / release.version
        try:
            if not self._usable(release.version):
                self.root.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryDirectory(dir=self.root) as tmp:
                    staging = self._fetch(release, Path(tmp))
                    if accept and (why := accept(str(staging / self.source.relpath))):
                        raise ValueError(why)
                    if dest.exists():
                        shutil.rmtree(dest)
                    os.replace(staging, dest)
        except INSTALL_ERRORS as exc:
            raise StudioError(f'{self.provider.name} を準備できませんでした。接続を確認して、もう一度お試しください。（{exc}）') from exc
        finally:
            self.progress = None
        state, current = self.state(), self.version()
        previous = current if current and current != release.version else state['previous']
        self._save(current=release.version, previous=previous, latest=release.version, skip=None, error=None)
        keep = {release.version, previous}
        for entry in self.root.iterdir():
            if entry.is_dir() and entry.name not in keep:
                shutil.rmtree(entry, ignore_errors=True)
        return str(dest / self.source.relpath)

    def _fetch(self, release: Release, work: Path) -> Path:
        if not release.url.startswith('https://') or release.algorithm not in ('sha256', 'sha512'):
            raise ValueError('取得先が正しくありません')
        payload, staging = work / 'payload', work / 'runtime'
        staging.mkdir()
        digest, size = hashlib.new(release.algorithm), 0
        with urllib.request.urlopen(release.url, timeout=60) as response, payload.open('wb') as out:
            total = release.size or int(getattr(response, 'headers', {}).get('Content-Length') or 0) or None
            self.progress = {'done': 0, 'total': total}
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_PAYLOAD:
                    raise ValueError('取得サイズが上限を超えました')
                digest.update(chunk)
                out.write(chunk)
                self.progress = {'done': size, 'total': total}
        if digest.hexdigest() != release.digest.lower():
            raise ValueError('取得したファイルを検証できませんでした')
        self.source.unpack(release, payload, staging)
        if not (staging / self.source.relpath).is_file():
            raise ValueError('実行ファイルがありません')
        return staging


@lru_cache(maxsize=16)
def _version_of(exe: str, mtime: int) -> str | None:
    try:
        r = subprocess.run([exe, '--version'], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    found = re.search(r'\d+\.\d+\.\d+', r.stdout + r.stderr)
    return found[0] if found else None


def version_of(exe: str) -> str | None:
    """ターミナルの CLI の版。"""
    try:
        return _version_of(exe, Path(exe).stat().st_mtime_ns)
    except OSError:
        return None


def info(provider) -> dict:
    """動作環境の画面に出す内容。"""
    runtime, state = provider.runtime, provider.runtime.state()
    fixed = provider.overridden()
    managed = None if fixed else runtime.version()
    found = provider.binary()
    version = managed or (version_of(found) if found else None)
    latest = None if fixed else state['latest']
    return {'id': provider.id, 'name': provider.name, 'version': version, 'terminal': bool(found and not managed),
            'fixed': fixed, 'latest': latest, 'update': bool(latest and (not managed or _key(latest) > _key(managed))),
            'previous': state['previous'] if managed else None, 'auto': state['auto'], 'busy': runtime.busy(),
            'progress': runtime.progress, 'error': state['error']}


class Updater:
    """裏で最新版を確かめて入れ替える。AI の作業中は入れ替えず、次の回に回す。"""

    def __init__(self, providers, busy, status, changed):
        self.providers, self.busy, self.status, self.changed = list(providers), busy, status, changed
        self.halt = threading.Event()

    def start(self) -> None:
        if ENABLED:
            threading.Thread(target=self._loop, name='ai-runtime-updater', daemon=True).start()

    def stop(self) -> None:
        self.halt.set()

    def _loop(self) -> None:
        if self.halt.wait(FIRST_DELAY):
            return
        while True:
            self.tick()
            if self.halt.wait(CHECK_EVERY):
                return

    def tick(self) -> None:
        try:
            usable = {p['id']: p['ok'] for p in self.status()['providers']}
        except Exception:  # noqa: BLE001 - 裏の処理なので、次の回にやり直す
            return
        for provider in self.providers:
            if self.halt.is_set():
                return
            try:
                self._one(provider, bool(usable.get(provider.id)))
            except StudioError:
                pass  # 理由は state.json に残り、動作環境の画面に出る

    def _one(self, provider, usable: bool) -> None:
        runtime = provider.runtime
        state = runtime.state()
        if provider.overridden() or not state['auto'] or time.time() - state['checked'] < CHECK_TTL:
            return
        if runtime.version() is None and not usable:
            return  # 使っていない AI は取得しない
        if self.busy() or runtime.busy():
            return
        if runtime.update(lambda exe: provider.accepts(exe, usable)):
            self.changed()
