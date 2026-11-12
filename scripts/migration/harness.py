"""Isolated batch-CLI launcher for the reference Python app (M0, not production).

This harness creates a temporary workspace/config/cache/AI-runtime tree, then
starts the existing CLI in a child process. The child patches
``slide_studio.workspace.location_file`` and ``default_root`` in the same
process before importing the CLI, so the real ``location.json`` is never used.

Only batch commands are allowed. GUI startup (the default command and ``open``)
and ``--root`` overrides are rejected. The parent ``HOME`` and ``CODEX_HOME``
are left unchanged; credential-looking environment variables are removed from
the child, and real AI executables are disabled with provider ``none`` values.

This M0 harness supports POSIX only. On other platforms it fails closed rather
than pretending that timeout process-tree cleanup is implemented. Each child
runs in its own process group and is killed as a group on timeout.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PREFIX = "slide-studio-m0-"
ROOT_ENV = "SLIDE_STUDIO_MIGRATION_ROOT"
REPO_ENV = "SLIDE_STUDIO_MIGRATION_REPO"
LOCATION_ENV = "SLIDE_STUDIO_MIGRATION_LOCATION_FILE"
PROBE_ENV = "SLIDE_STUDIO_MIGRATION_PROBE"
FAIL_CLOSED = 125
DEFAULT_TIMEOUT = 300.0
BATCH_COMMANDS = {"audit", "build", "check", "consult", "doctor", "fig", "import", "new"}

_CREDENTIAL_NAMES = {
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AZURE_CLIENT_SECRET", "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY", "DEEPSEEK_API_KEY", "GH_TOKEN", "GITHUB_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS", "OPENAI_API_KEY", "SSH_AUTH_SOCK",
}
_CREDENTIAL_MARKERS = ("_API_KEY", "_APIKEY", "_CREDENTIAL", "_PASSWORD", "_SECRET", "_TOKEN")
_UNSAFE_PYTHON_ENV = {
    "PYTHONBREAKPOINT", "PYTHONCASEOK", "PYTHONDEBUG", "PYTHONEXECUTABLE",
    "PYTHONFAULTHANDLER", "PYTHONHOME", "PYTHONINSPECT", "PYTHONMALLOC",
    "PYTHONOPTIMIZE", "PYTHONPATH", "PYTHONPLATLIBDIR", "PYTHONPROFILEIMPORTTIME",
    "PYTHONPYCACHEPREFIX", "PYTHONSTARTUP", "PYTHONTRACEMALLOC", "PYTHONUSERBASE",
    "PYTHONVERBOSE", "PYTHONWARNINGS",
}


class IsolationError(RuntimeError):
    """The harness cannot create or prove an isolated launch."""


# Runs in the child. It must not import the app until the injected paths have
# been checked and workspace.location_file/default_root have been replaced.
CHILD_CODE = r'''
import sys

# -c can put the caller's cwd first on sys.path. Remove it before stdlib imports.
sys.path[:] = [entry for entry in sys.path if entry]

import json
import os
from pathlib import Path

FAIL = 125
ROOT_ENV = "SLIDE_STUDIO_MIGRATION_ROOT"
REPO_ENV = "SLIDE_STUDIO_MIGRATION_REPO"
LOCATION_ENV = "SLIDE_STUDIO_MIGRATION_LOCATION_FILE"
PROBE_ENV = "SLIDE_STUDIO_MIGRATION_PROBE"
BATCH_COMMANDS = {"audit", "build", "check", "consult", "doctor", "fig", "import", "new"}


def fail(message):
    print("migration isolation failed: " + message, file=sys.stderr)
    raise SystemExit(FAIL)


def absolute(value, what):
    if not value:
        fail(what + " is not set")
    path = Path(value)
    if not path.is_absolute():
        fail(what + " is not absolute: " + value)
    try:
        return path.resolve(strict=False)
    except OSError as exc:
        fail(what + " cannot be resolved: " + str(exc))


def is_root_option(value):
    name = value.split("=", 1)[0]
    return len(name) >= 3 and "--root".startswith(name)


def guard_argv(args):
    if not args:
        fail("default launch is not allowed")
    if args[0].startswith("-"):
        fail("leading global options are not allowed")
    if any(is_root_option(arg) for arg in args):
        fail("--root is not allowed")
    if args[0] == "open":
        fail("open is not allowed")
    if args[0] not in BATCH_COMMANDS:
        fail("batch command required: " + args[0])


argv = list(sys.argv[1:])
if not os.environ.get(PROBE_ENV):
    guard_argv(argv)

root = absolute(os.environ.get(ROOT_ENV), "isolated root")
location = absolute(os.environ.get(LOCATION_ENV), "location file")
workspace_root = absolute(os.environ.get("SLIDE_STUDIO_HOME"), "SLIDE_STUDIO_HOME")
try:
    root = root.resolve(strict=True)
except OSError as exc:
    fail("isolated root does not exist: " + str(exc))
if not root.is_dir():
    fail("isolated root is not a directory: " + str(root))
for label, path in (("location file", location), ("workspace", workspace_root)):
    if not path.is_relative_to(root):
        fail(label + " escapes isolated root: " + str(path))

real_location = (Path.home() / ".config" / "slide-studio" / "location.json").resolve(strict=False)
if location == real_location:
    fail("refusing to use the real location file: " + str(real_location))

repo = absolute(os.environ.get(REPO_ENV), "repository")
try:
    repo = repo.resolve(strict=True)
except OSError as exc:
    fail("repository does not exist: " + str(exc))
if not (repo / "slide_studio" / "__init__.py").is_file():
    fail("repository does not contain slide_studio: " + str(repo))

# -c puts the caller's cwd first on sys.path. Remove cwd entries and pin the
# repository before importing the app, without changing cwd for CLI file paths.
try:
    cwd = Path(os.getcwd()).resolve(strict=False)
except OSError:
    cwd = None
pinned = [str(repo)]
for entry in sys.path:
    if not entry:
        continue
    try:
        resolved = Path(entry).resolve(strict=False)
    except OSError:
        resolved = None
    if resolved == repo or (cwd is not None and resolved == cwd):
        continue
    pinned.append(entry)
sys.path[:] = pinned

import slide_studio.workspace as workspace

workspace.location_file = lambda: location
workspace.default_root = lambda: workspace_root

if os.environ.get(PROBE_ENV):
    saved = workspace.saved_root()
    print(json.dumps({
        "root": str(root),
        "workspace": str(workspace_root),
        "location_file": str(workspace.location_file()),
        "default_root": str(workspace.default_root()),
        "saved_root": str(saved) if saved is not None else None,
        "argv": argv,
        "pid": os.getpid(),
    }, ensure_ascii=False))
    raise SystemExit(0)

import argparse

_original_parse_args = argparse.ArgumentParser.parse_args


def _guarded_parse_args(self, args=None, namespace=None):
    parsed = _original_parse_args(self, args, namespace)
    if getattr(parsed, "root", None) is not None:
        fail("--root is not allowed")
    return parsed


argparse.ArgumentParser.parse_args = _guarded_parse_args

from slide_studio.cli import main

raise SystemExit(main(argv))
'''


def _is_credential(name: str) -> bool:
    upper = name.upper()
    return upper in _CREDENTIAL_NAMES or any(marker in upper for marker in _CREDENTIAL_MARKERS)


def _is_root_option(value: str) -> bool:
    name = value.split("=", 1)[0]
    return len(name) >= 3 and "--root".startswith(name)


def _require_posix() -> None:
    if os.name != "posix":
        raise IsolationError(
            "この M0 ハーネスは POSIX のみ対応です。"
            "Windows のタイムアウト時プロセスツリー終了は未実装のため中止します"
        )


def _checked_timeout(value: float | int | None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise IsolationError("timeout は有限の正の数で指定してください")
    timeout = float(value)
    if not math.isfinite(timeout) or timeout <= 0:
        raise IsolationError("timeout は有限の正の数で指定してください")
    return timeout


def _terminate_process_group(process: subprocess.Popen) -> None:
    # start_new_session=True makes process.pid the process-group id, even if
    # the direct child has already exited while descendants are still running.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        try:
            process.kill()
        except OSError:
            pass


def _close_pipes(process: subprocess.Popen) -> None:
    for stream in (process.stdin, process.stdout, process.stderr):
        try:
            if stream is not None:
                stream.close()
        except (OSError, ValueError):
            pass


def _reap_process(process: subprocess.Popen, *, timeout: float = 5.0) -> str | None:
    """Reap a terminated child with bounded waits and no unbounded communicate."""
    try:
        process.wait(timeout=timeout)
        return None
    except subprocess.TimeoutExpired:
        pass
    except OSError:
        return "子プロセスの回収に失敗しました"
    try:
        process.kill()
    except OSError:
        pass
    try:
        process.wait(timeout=1.0)
        return None
    except subprocess.TimeoutExpired:
        pass
    except OSError:
        return "子プロセスの回収に失敗しました"
    # A descendant escaped the process group and still holds a pipe. Close our
    # ends so that neither we nor the caller can block forever on it.
    _close_pipes(process)
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        return "子プロセスを回収できませんでした"
    except OSError:
        return "子プロセスの回収に失敗しました"
    return None


def _run_child_process(command: Sequence[str], *, env: Mapping[str, str],
                       cwd: Path | str | None, timeout: float | int | None,
                       input_text: str | None) -> subprocess.CompletedProcess[str]:
    """Run one owned child with a POSIX process group and a hard timeout."""
    _require_posix()
    timeout = _checked_timeout(DEFAULT_TIMEOUT if timeout is None else timeout)
    stdin = subprocess.DEVNULL if input_text is None else subprocess.PIPE
    argv = list(command)
    try:
        process = subprocess.Popen(
            argv,
            cwd=None if cwd is None else str(cwd),
            env=dict(env),
            stdin=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )
    except OSError as exc:
        raise IsolationError(f"隔離した子プロセスを起動できません: {exc}") from exc
    try:
        stdout, stderr = process.communicate(input=input_text, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        _terminate_process_group(process)
        warning = _reap_process(process)
        _close_pipes(process)
        message = (
            f"子プロセスが {timeout} 秒で終了しませんでした"
            "（所有プロセスグループを終了しました）"
        )
        if warning:
            message += f"（{warning}）"
        raise IsolationError(message) from exc
    except BaseException:
        # KeyboardInterrupt, SystemExit, and any other failure must not leave
        # the owned child group running while the workspace is removed.
        _terminate_process_group(process)
        _reap_process(process)
        _close_pipes(process)
        raise
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def validate_batch_argv(argv: Sequence[str]) -> list[str]:
    """Require a batch command first; reject every leading global flag."""
    args = list(argv)
    if not args:
        raise IsolationError("既定の起動（GUI）はこのラッパーでは使えません")
    command = args[0]
    if command.startswith("-"):
        raise IsolationError("先頭のグローバル引数は使えません（batch コマンドを先頭に指定）")
    if any(_is_root_option(arg) for arg in args):
        raise IsolationError("--root は使えません（隔離した置き場を使います）")
    if command == "open":
        raise IsolationError("open（GUI 起動）はこのラッパーでは使えません")
    if command not in BATCH_COMMANDS:
        raise IsolationError(f"batch コマンドではありません: {command}")
    return args


@dataclass
class IsolatedDirs:
    """A temporary run tree owned by this harness."""

    root: Path
    workspace: Path
    config: Path
    cache: Path
    ai: Path
    tmp: Path
    location_file: Path
    _owned: tuple[int, int] | None = field(default=None, init=False, repr=False, compare=False)
    _cleaned: bool = field(default=False, init=False, repr=False, compare=False)

    @classmethod
    def create(cls, base_dir: Path | str | None = None) -> "IsolatedDirs":
        _require_posix()
        base = Path(tempfile.gettempdir()) if base_dir is None else Path(base_dir).expanduser().resolve()
        if not base.is_dir():
            raise IsolationError(f"一時領域の親がフォルダではありません: {base}")
        try:
            root = Path(tempfile.mkdtemp(prefix=PREFIX, dir=str(base)))
        except OSError as exc:
            raise IsolationError(f"一時領域を作成できません: {base}: {exc}") from exc
        try:
            workspace, config, cache = root / "workspace", root / "config", root / "cache"
            ai, tmp = root / "ai", root / "tmp"
            for path in (workspace, config, cache, ai, tmp,
                         ai / "codex", ai / "claude", ai / "agy", ai / "data"):
                path.mkdir(parents=True, exist_ok=True)
            st = os.lstat(root)
            dirs = cls(root=root, workspace=workspace, config=config, cache=cache,
                       ai=ai, tmp=tmp, location_file=config / "location.json")
            dirs._owned = (st.st_dev, st.st_ino)
            dirs.validate()
            return dirs
        except BaseException:
            shutil.rmtree(root, ignore_errors=True)
            raise

    def validate(self) -> None:
        try:
            root = self.root.resolve(strict=True)
        except OSError as exc:
            raise IsolationError(f"隔離した実行領域がありません: {self.root}: {exc}") from exc
        if not root.is_dir():
            raise IsolationError(f"隔離した実行領域がフォルダではありません: {root}")
        for label, path in (("workspace", self.workspace), ("config", self.config),
                            ("cache", self.cache), ("ai", self.ai), ("tmp", self.tmp)):
            try:
                resolved = path.resolve(strict=True)
            except OSError as exc:
                raise IsolationError(f"{label} がありません: {path}: {exc}") from exc
            if not resolved.is_relative_to(root) or not resolved.is_dir():
                raise IsolationError(f"{label} が隔離領域の外かフォルダではありません: {resolved}")
        location = self.location_file.resolve(strict=False)
        if not location.is_relative_to(root) or location.parent != self.config.resolve(strict=True):
            raise IsolationError(f"location.json が設定フォルダの外にあります: {location}")
        real_location = (Path.home() / ".config" / "slide-studio" / "location.json").resolve(strict=False)
        if location == real_location:
            raise IsolationError(f"実際の location.json は使えません: {location}")

    def child_env(self, overrides: Mapping[str, str] | None = None) -> dict[str, str]:
        self.validate()
        env = {key: value for key, value in os.environ.items() if not _is_credential(key)}
        for key, value in (overrides or {}).items():
            key = str(key)
            if _is_credential(key):
                continue
            if value is None:
                env.pop(key, None)
            else:
                env[key] = str(value)
        env.update({
            ROOT_ENV: str(self.root),
            REPO_ENV: str(REPO_ROOT),
            LOCATION_ENV: str(self.location_file),
            "SLIDE_STUDIO_HOME": str(self.workspace),
            "SLIDE_STUDIO_CODEX_HOME": str(self.ai / "codex"),
            "SLIDE_STUDIO_CLAUDE_HOME": str(self.ai / "claude"),
            "SLIDE_STUDIO_AGY_HOME": str(self.ai / "agy"),
            "SLIDE_STUDIO_CODEX": "none",
            "SLIDE_STUDIO_CLAUDE": "none",
            "SLIDE_STUDIO_AGY": "none",
            "XDG_CONFIG_HOME": str(self.config),
            "XDG_CACHE_HOME": str(self.cache),
            "XDG_DATA_HOME": str(self.ai / "data"),
            "APPDATA": str(self.config),
            "LOCALAPPDATA": str(self.cache),
            "TMPDIR": str(self.tmp),
            "TEMP": str(self.tmp),
            "TMP": str(self.tmp),
            "FAKE_STUDIO_ROOT": str(self.workspace),
        })
        for key in _UNSAFE_PYTHON_ENV:
            env.pop(key, None)
        env["PYTHONPATH"] = str(REPO_ROOT)
        env["PYTHONNOUSERSITE"] = "1"
        env["PYTHONSAFEPATH"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        return env

    def run(self, argv: Sequence[str], *, env: Mapping[str, str] | None = None,
            cwd: Path | str | None = None, timeout: float | None = None,
            input_text: str | None = None,
            probe: bool = False) -> subprocess.CompletedProcess[str]:
        self.validate()
        args = list(argv)
        if any(not isinstance(arg, str) for arg in args):
            raise TypeError("argv must contain only strings")
        if not probe:
            validate_batch_argv(args)
        timeout = _checked_timeout(DEFAULT_TIMEOUT if timeout is None else timeout)
        child_env = self.child_env(env)
        if probe:
            child_env[PROBE_ENV] = "1"
        else:
            child_env.pop(PROBE_ENV, None)
        return _run_child_process(
            [sys.executable, "-P", "-c", CHILD_CODE, *args],
            env=child_env,
            cwd=cwd,
            timeout=timeout,
            input_text=input_text,
        )

    def probe(self, argv: Sequence[str] = (), *, env: Mapping[str, str] | None = None,
              cwd: Path | str | None = None, timeout: float | None = None) -> dict:
        result = self.run(argv, env=env, cwd=cwd, timeout=timeout, probe=True)
        if result.returncode != 0:
            raise IsolationError(
                f"隔離状態を確認できません（終了コード {result.returncode}）: {result.stderr.strip()}"
            )
        try:
            return json.loads(result.stdout)
        except ValueError as exc:
            raise IsolationError(f"隔離状態の出力を読めません: {result.stdout!r}") from exc

    def cleanup(self) -> None:
        """Remove only the directory created by ``create``; never a caller path."""
        if self._cleaned:
            return
        root = self.root
        if not root.exists() and not root.is_symlink():
            self._cleaned = True
            return
        if self._owned is None:
            raise IsolationError(f"このツールが作った領域ではありません: {root}")
        try:
            st = os.lstat(root)
        except OSError as exc:
            raise IsolationError(f"隔離領域を確認できません: {root}: {exc}") from exc
        if stat.S_ISLNK(st.st_mode):
            raise IsolationError(f"隔離領域がシンボリックリンクです: {root}")
        if (st.st_dev, st.st_ino) != self._owned:
            raise IsolationError(f"隔離領域が置き換わっています: {root}")
        if not stat.S_ISDIR(st.st_mode):
            raise IsolationError(f"隔離領域がフォルダではありません: {root}")
        if not root.name.startswith(PREFIX):
            raise IsolationError(f"このツールが作った領域ではありません: {root}")
        shutil.rmtree(root)
        self._cleaned = True


class BaselineSession:
    """One temporary run tree with any number of separate batch invocations."""

    def __init__(self, *, base_dir: Path | str | None = None, keep: bool = False,
                 env: Mapping[str, str] | None = None, timeout: float | None = None) -> None:
        self.dirs = IsolatedDirs.create(base_dir)
        self.keep = keep
        self.env = dict(env or {})
        self.timeout = timeout
        self._closed = False

    @property
    def root(self) -> Path:
        return self.dirs.root

    def child_env(self) -> dict[str, str]:
        return self.dirs.child_env(self.env)

    def run(self, argv: Sequence[str], *, timeout: float | None = None,
            input_text: str | None = None, cwd: Path | str | None = None) -> subprocess.CompletedProcess[str]:
        if self._closed:
            raise IsolationError("この実行は終了しています")
        return self.dirs.run(argv, env=self.env, cwd=cwd,
                             timeout=self.timeout if timeout is None else timeout,
                             input_text=input_text)

    def probe(self, argv: Sequence[str] = (), *, timeout: float | None = None,
              cwd: Path | str | None = None) -> dict:
        if self._closed:
            raise IsolationError("この実行は終了しています")
        return self.dirs.probe(argv, env=self.env, cwd=cwd,
                               timeout=self.timeout if timeout is None else timeout)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if not self.keep:
            self.dirs.cleanup()

    def __enter__(self) -> "BaselineSession":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.close()
        return False


def run_cli(argv: Sequence[str], *, keep: bool = False,
            base_dir: Path | str | None = None, env: Mapping[str, str] | None = None,
            timeout: float | None = None, cwd: Path | str | None = None,
            input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    """One-shot launch. Use ``BaselineSession`` to reuse a tree."""
    session = BaselineSession(base_dir=base_dir, keep=keep, env=env, timeout=timeout)
    try:
        return session.run(argv, cwd=cwd, input_text=input_text)
    finally:
        session.close()


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    keep, base_dir, timeout = False, None, None
    while args:
        token = args[0]
        if token == "--":
            args.pop(0)
            break
        if token == "--keep":
            keep = True
            args.pop(0)
        elif token == "--base-dir" and len(args) > 1:
            base_dir = args[1]
            del args[:2]
        elif token.startswith("--base-dir="):
            base_dir = token.split("=", 1)[1]
            args.pop(0)
        elif token == "--timeout" and len(args) > 1:
            try:
                timeout = float(args[1])
            except ValueError:
                print("migration isolation failed: timeout は有限の正の数で指定してください", file=sys.stderr)
                return FAIL_CLOSED
            del args[:2]
        elif token.startswith("--timeout="):
            try:
                timeout = float(token.split("=", 1)[1])
            except ValueError:
                print("migration isolation failed: timeout は有限の正の数で指定してください", file=sys.stderr)
                return FAIL_CLOSED
            args.pop(0)
        else:
            break
    if not args:
        print("migration isolation failed: slide-studio の batch 引数を指定してください", file=sys.stderr)
        return FAIL_CLOSED
    try:
        with BaselineSession(base_dir=base_dir, keep=keep, timeout=timeout) as session:
            if keep:
                print(f"isolated root: {session.root}", file=sys.stderr)
            result = session.run(args)
            sys.stdout.write(result.stdout)
            sys.stderr.write(result.stderr)
            return result.returncode
    except IsolationError as exc:
        print(f"migration isolation failed: {exc}", file=sys.stderr)
        return FAIL_CLOSED


if __name__ == "__main__":
    raise SystemExit(main())
