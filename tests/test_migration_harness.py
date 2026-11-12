from __future__ import annotations

import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from functools import lru_cache
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"


def _load_harness():
    path = ROOT / "scripts" / "migration" / "harness.py"
    spec = importlib.util.spec_from_file_location("m0_migration_harness", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


harness = _load_harness()


def test_child_env_isolates_app_paths_but_preserves_home_and_codex(tmp_path):
    home = tmp_path / "parent home"
    codex = tmp_path / "codex credential dir"
    with harness.BaselineSession(env={
        "HOME": str(home),
        "USERPROFILE": str(home),
        "CODEX_HOME": str(codex),
        "OPENAI_API_KEY": "secret",
        "GH_TOKEN": "secret",
        "SSH_AUTH_SOCK": "/tmp/agent.sock",
        "PYTHONPATH": str(tmp_path / "inherited"),
        "PYTHONHOME": str(tmp_path / "python-home"),
        "PYTHONSTARTUP": str(tmp_path / "startup.py"),
        "PYTHONINSPECT": "1",
        "PYTHONBREAKPOINT": "evil.hook",
        "PYTHONUSERBASE": str(tmp_path / "user-base"),
    }) as session:
        env = session.child_env()
        assert env["HOME"] == str(home)
        assert env["USERPROFILE"] == str(home)
        assert env["CODEX_HOME"] == str(codex)
        assert "OPENAI_API_KEY" not in env
        assert "GH_TOKEN" not in env
        assert "SSH_AUTH_SOCK" not in env
        assert env["PYTHONPATH"] == str(harness.REPO_ROOT)
        for key in ("PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT",
                    "PYTHONBREAKPOINT", "PYTHONUSERBASE"):
            assert key not in env
        assert env["PYTHONNOUSERSITE"] == "1"
        assert env["PYTHONSAFEPATH"] == "1"
        assert env[harness.REPO_ENV] == str(harness.REPO_ROOT)
        assert env["SLIDE_STUDIO_HOME"] == str(session.dirs.workspace)
        assert env[harness.ROOT_ENV] == str(session.dirs.root)
        assert env[harness.LOCATION_ENV] == str(session.dirs.location_file)
        assert env["SLIDE_STUDIO_CODEX"] == "none"
        assert env["SLIDE_STUDIO_CLAUDE"] == "none"
        assert env["SLIDE_STUDIO_AGY"] == "none"
        assert env["SLIDE_STUDIO_CODEX_HOME"] == str(session.dirs.ai / "codex")
        assert env["SLIDE_STUDIO_CLAUDE_HOME"] == str(session.dirs.ai / "claude")
        assert env["SLIDE_STUDIO_AGY_HOME"] == str(session.dirs.ai / "agy")
        assert env["XDG_CONFIG_HOME"] == str(session.dirs.config)
        assert env["XDG_CACHE_HOME"] == str(session.dirs.cache)
        assert env["TMPDIR"] == str(session.dirs.tmp)
        assert session.dirs.location_file.parent == session.dirs.config
        root = session.root
    assert not root.exists()


def test_existing_location_sentinel_is_not_read_or_written(tmp_path):
    fake_home = tmp_path / "fake home" / "利用者"
    real_workspace = tmp_path / "実際 の 保管場所"
    real_workspace.mkdir()
    sentinel_path = fake_home / ".config" / "slide-studio" / "location.json"
    sentinel_path.parent.mkdir(parents=True)
    sentinel = {"root": str(real_workspace), "recent": [str(real_workspace)], "sentinel": "残す"}
    sentinel_bytes = json.dumps(sentinel, ensure_ascii=False, indent=1).encode()
    sentinel_path.write_bytes(sentinel_bytes)

    env = {"HOME": str(fake_home), "USERPROFILE": str(fake_home),
           "CODEX_HOME": str(tmp_path / "codex-auth")}
    with harness.BaselineSession(env=env) as session:
        probe = session.probe(["日本語 の 引数", "with space"])
        assert Path(probe["location_file"]).resolve() == session.dirs.location_file.resolve()
        assert Path(probe["default_root"]).resolve() == session.dirs.workspace.resolve()
        assert probe["saved_root"] is None
        assert probe["argv"] == ["日本語 の 引数", "with space"]
        assert Path(probe["location_file"]).resolve() != sentinel_path.resolve()

        result = session.run(["import", str(FIXTURES / "nco-intro"), "--topic", "nco",
                              "--name", "sentinel-test"])
        assert result.returncode == 0, result.stderr
        assert (session.dirs.workspace / "decks" / "sentinel-test" / "slides.qmd").is_file()

    assert sentinel_path.read_bytes() == sentinel_bytes
    assert not (real_workspace / "decks").exists()


def test_separated_invocations_share_only_the_explicit_session(tmp_path):
    with harness.BaselineSession() as first:
        before = first.probe(["first"])
        imported = first.run(["import", str(FIXTURES / "nco-intro"), "--topic", "nco",
                              "--name", "nco-one"])
        assert imported.returncode == 0, imported.stderr
        after = first.probe(["second"])
        assert before["pid"] != after["pid"]
        assert before["root"] == after["root"]
        assert (first.dirs.workspace / "decks" / "nco-one" / "slides.qmd").is_file()

        with harness.BaselineSession() as second:
            assert second.root != first.root
            assert not (second.dirs.workspace / "decks" / "nco-one").exists()
            again = second.run(["import", str(FIXTURES / "nco-intro"), "--topic", "nco",
                                "--name", "nco-one"])
            assert again.returncode == 0, again.stderr

    assert not first.root.exists()
    assert not second.root.exists()


def test_unicode_and_spaces_in_paths_and_argv(tmp_path):
    base = tmp_path / "移行 ベース"
    base.mkdir()
    source = base / "原稿 フィクスチャ"
    shutil.copytree(FIXTURES / "nco-intro", source)

    with harness.BaselineSession(base_dir=base) as session:
        argv = ["import", str(source), "--topic", "nco", "--name", "nco-intro"]
        probe = session.probe(["図 の 引数", "--name=値 空白"])
        assert probe["argv"] == ["図 の 引数", "--name=値 空白"]
        result = session.run(argv)
        assert result.returncode == 0, result.stderr
        assert (session.dirs.workspace / "decks" / "nco-intro" / "slides.qmd").is_file()
        assert "nco-intro" in result.stdout


def test_repository_import_is_pinned_and_relative_paths_keep_cwd(tmp_path):
    cwd = tmp_path / "caller cwd"
    fake = cwd / "slide_studio"
    fake.mkdir(parents=True)
    (fake / "__init__.py").write_text("raise RuntimeError('wrong checkout')\n")
    shutil.copytree(FIXTURES / "nco-intro", cwd / "原稿 fixture")
    inherited = tmp_path / "inherited"
    (inherited / "slide_studio").mkdir(parents=True)

    with harness.BaselineSession(env={"PYTHONPATH": str(inherited)}) as session:
        probe = session.probe(["cwd-test"], cwd=cwd)
        assert probe["argv"] == ["cwd-test"]
        result = session.run(["import", "原稿 fixture", "--topic", "nco",
                              "--name", "cwd-relative"], cwd=cwd)
        assert result.returncode == 0, result.stderr
        assert (session.dirs.workspace / "decks" / "cwd-relative" / "slides.qmd").is_file()


def test_batch_guard_rejects_gui_and_root_overrides(tmp_path):
    with harness.BaselineSession() as session:
        for argv in ([], ["open"], ["--root", str(tmp_path), "import", "x", "--topic", "nco"],
                     ["--root=" + str(tmp_path), "import", "x", "--topic", "nco"]):
            with pytest.raises(harness.IsolationError):
                session.run(argv)


def test_leading_options_and_argparse_abbreviations_cannot_escape(tmp_path):
    outside = tmp_path / "outside"
    with harness.BaselineSession() as session:
        for argv in (
            ["--port", "4320", "new", "escaped", "--topic", "nco"],
            ["--no-browser", "new", "escaped", "--topic", "nco"],
            ["--", "new", "escaped", "--topic", "nco"],
            ["--r=" + str(outside), "new", "escaped", "--topic", "nco"],
            ["--roo=" + str(outside), "new", "escaped", "--topic", "nco"],
            ["--ro=" + str(outside), "new", "escaped", "--topic", "nco"],
            ["--r", str(outside), "new", "escaped", "--topic", "nco"],
            ["--roo", str(outside), "new", "escaped", "--topic", "nco"],
            ["--ro", str(outside), "new", "escaped", "--topic", "nco"],
        ):
            with pytest.raises(harness.IsolationError):
                session.run(argv)
    assert not outside.exists()


@pytest.mark.parametrize("argv", [
    ["--r=/outside", "import", "x", "--topic", "nco"],
    ["--ro=/outside", "import", "x", "--topic", "nco"],
    ["--roo=/outside", "import", "x", "--topic", "nco"],
    ["--root=/outside", "import", "x", "--topic", "nco"],
    ["open"],
    [],
])
def test_child_code_rejects_forbidden_launch_directly(tmp_path, argv):
    dirs = harness.IsolatedDirs.create(tmp_path)
    try:
        env = dirs.child_env()
        env.pop(harness.PROBE_ENV, None)
        result = subprocess.run(
            [sys.executable, "-P", "-c", harness.CHILD_CODE, *argv],
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        assert result.returncode == harness.FAIL_CLOSED
        assert "migration isolation failed" in result.stderr
    finally:
        dirs.cleanup()


def test_invalid_timeout_and_main_errors_fail_closed():
    with harness.BaselineSession() as session:
        for bad in (0, -1, float("nan"), float("inf"), "10", True):
            with pytest.raises(harness.IsolationError):
                session.run(["doctor"], timeout=bad)
    assert harness.main(["--timeout", "x", "doctor"]) == harness.FAIL_CLOSED
    assert harness.main(["--timeout", "0", "doctor"]) == harness.FAIL_CLOSED


def test_timeout_terminates_owned_process_group(tmp_path):
    pid_file = tmp_path / "pids.txt"
    script = (
        "import os, subprocess, sys, time\n"
        "grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"open({str(pid_file)!r}, 'w').write(str(os.getpid()) + ' ' + str(grandchild.pid))\n"
        "time.sleep(60)\n"
    )
    with pytest.raises(harness.IsolationError):
        harness._run_child_process(
            [sys.executable, "-c", script],
            env=os.environ.copy(),
            cwd=None,
            timeout=2.0,
            input_text=None,
        )

    deadline = time.time() + 5
    while not pid_file.exists() and time.time() < deadline:
        time.sleep(0.05)
    assert pid_file.exists()
    _child_pid, grandchild_pid = map(int, pid_file.read_text().split())
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            os.kill(grandchild_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        try:
            os.kill(grandchild_pid, signal.SIGKILL)
        except OSError:
            pass
        pytest.fail(f"descendant {grandchild_pid} survived timeout")


def test_interruption_terminates_owned_process_group(monkeypatch):
    calls = []
    created = []

    class FakeProcess:
        def __init__(self, argv, **kwargs):
            self.pid = 424242
            self.returncode = None
            self.stdin = self.stdout = self.stderr = None
            self.waits = []
            created.append(self)

        def communicate(self, input=None, timeout=None):
            raise KeyboardInterrupt

        def wait(self, timeout=None):
            self.waits.append(timeout)
            self.returncode = -signal.SIGKILL
            return self.returncode

        def kill(self):
            calls.append(("kill", self.pid))

    def fake_killpg(pgid, sig):
        calls.append(("killpg", pgid, sig))

    monkeypatch.setattr(harness.subprocess, "Popen", FakeProcess)
    monkeypatch.setattr(harness.os, "killpg", fake_killpg)

    with pytest.raises(KeyboardInterrupt):
        harness._run_child_process(
            [sys.executable, "-c", "ignored"],
            env={},
            cwd=None,
            timeout=10.0,
            input_text=None,
        )

    assert ("killpg", 424242, signal.SIGKILL) in calls
    assert created[0].waits and all(value is not None for value in created[0].waits)


def test_timeout_kills_descendants_after_leader_has_exited(tmp_path):
    pid_file = tmp_path / "exited-leader-pids.txt"
    script = (
        "import os, subprocess, sys\n"
        "grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"open({str(pid_file)!r}, 'w').write(str(os.getpid()) + ' ' + str(grandchild.pid))\n"
        "raise SystemExit(0)\n"
    )
    with pytest.raises(harness.IsolationError):
        harness._run_child_process(
            [sys.executable, "-c", script],
            env=os.environ.copy(),
            cwd=None,
            timeout=1.0,
            input_text=None,
        )

    deadline = time.time() + 5
    while not pid_file.exists() and time.time() < deadline:
        time.sleep(0.05)
    assert pid_file.exists()
    _leader_pid, grandchild_pid = map(int, pid_file.read_text().split())
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            os.kill(grandchild_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        try:
            os.kill(grandchild_pid, signal.SIGKILL)
        except OSError:
            pass
        pytest.fail(f"descendant {grandchild_pid} survived timeout after leader exit")


def test_cli_argv_and_failure_exit_code(tmp_path):
    missing = tmp_path / "missing 原稿"
    with harness.BaselineSession() as session:
        failed = session.run(["import", str(missing), "--topic", "nco", "--name", "missing"])
        assert failed.returncode == 1
        assert "slides.qmd" in failed.stderr
        assert not (session.dirs.workspace / "decks" / "missing").exists()

        invalid = session.run(["import"])
        assert invalid.returncode == 2
        assert "usage" in invalid.stderr.lower()


def test_keep_retains_output_until_explicit_cleanup(tmp_path):
    with harness.BaselineSession(base_dir=tmp_path, keep=True) as session:
        root = session.root
        session.probe()
    assert root.is_dir()
    session.dirs.cleanup()
    assert not root.exists()


def test_cleanup_requires_create_ownership_and_rejects_mutated_root(tmp_path):
    foreign = tmp_path / (harness.PREFIX + "foreign")
    foreign.mkdir()
    keep = foreign / "keep.txt"
    keep.write_text("foreign")
    lookalike = harness.IsolatedDirs(
        root=foreign, workspace=foreign / "workspace", config=foreign / "config",
        cache=foreign / "cache", ai=foreign / "ai", tmp=foreign / "tmp",
        location_file=foreign / "config" / "location.json",
    )
    with pytest.raises(harness.IsolationError):
        lookalike.cleanup()
    assert keep.read_text() == "foreign"

    owned = harness.IsolatedDirs.create(tmp_path)
    moved = owned.root.with_name(owned.root.name + "-moved")
    owned.root.rename(moved)
    owned.root.mkdir()
    replacement = owned.root / "keep.txt"
    replacement.write_text("replacement")
    with pytest.raises(harness.IsolationError):
        owned.cleanup()
    assert replacement.read_text() == "replacement"
    shutil.rmtree(moved)
    shutil.rmtree(owned.root)


def test_fail_closed_without_isolation_or_with_foreign_cleanup(tmp_path):
    env = dict(os.environ)
    for name in (harness.ROOT_ENV, harness.REPO_ENV, harness.LOCATION_ENV,
                 "SLIDE_STUDIO_HOME", harness.PROBE_ENV):
        env.pop(name, None)
    env["PYTHONPATH"] = os.pathsep.join([str(harness.REPO_ROOT), env.get("PYTHONPATH", "")])
    result = subprocess.run([sys.executable, "-c", harness.CHILD_CODE, "doctor"], env=env,
                            capture_output=True, text=True, encoding="utf-8", check=False)
    assert result.returncode == harness.FAIL_CLOSED
    assert "migration isolation failed" in result.stderr

    not_a_dir = tmp_path / "not-a-dir"
    not_a_dir.write_text("x")
    with pytest.raises(harness.IsolationError):
        harness.IsolatedDirs.create(not_a_dir)

    caller = tmp_path / "caller-data"
    caller.mkdir()
    keep = caller / "keep.txt"
    keep.write_text("caller data")
    foreign = harness.IsolatedDirs(
        root=caller, workspace=caller / "workspace", config=caller / "config",
        cache=caller / "cache", ai=caller / "ai", tmp=caller / "tmp",
        location_file=caller / "config" / "location.json",
    )
    with pytest.raises(harness.IsolationError):
        foreign.cleanup()
    assert keep.read_text() == "caller data"


@lru_cache(maxsize=1)
def _chromium_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return False
    playwright = None
    try:
        playwright = sync_playwright().start()
        return Path(playwright.chromium.executable_path).is_file()
    except Exception:
        return False
    finally:
        if playwright is not None:
            playwright.stop()


@pytest.mark.skipif(
    os.environ.get("SLIDE_STUDIO_MIGRATION_CHROMIUM") != "1",
    reason="real Chromium test is opt-in (set SLIDE_STUDIO_MIGRATION_CHROMIUM=1)",
)
def test_import_build_check_against_nco_fixture():
    if not _chromium_available():
        pytest.skip("Playwright Chromium is not installed")
    with harness.BaselineSession(timeout=240) as session:
        imported = session.run(["import", str(FIXTURES / "nco-intro"), "--topic", "nco"])
        assert imported.returncode == 0, imported.stderr

        built = session.run(["build", "nco-intro", "--force"], timeout=240)
        assert built.returncode == 0, built.stderr
        assert list((session.dirs.workspace / "decks" / "nco-intro").glob("*.html"))
        assert list((session.dirs.workspace / "decks" / "nco-intro").glob("*.pdf"))

        checked = session.run(["check", "nco-intro"], timeout=240)
        assert checked.returncode == 0, checked.stderr
