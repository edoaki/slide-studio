"""AI のプロバイダー（Codex・Claude Code・Antigravity）。設計書 §8.1・§8.6。

detect() で接続・ログイン・モデルを確認し、make_run() で実行を作る。
Codex は App Server の JSON-RPC、ほかは CLI の JSON を共通の動作に直す。
置き場の中は自由に変えてよく、外は変えられないように、それぞれの sandbox・権限の設定で起動する。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tomllib
import webbrowser
from functools import cached_property
from pathlib import Path
from urllib.parse import urlparse

from .agent import parse_final

SCHEMA = Path(__file__).resolve().parent / "schema.json"
EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]  # 弱い順
TIMEOUT = 30


def _run(argv: list[str], timeout: float = TIMEOUT, *, env=None) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, env=env)


def _last_line(text: str) -> str:
    lines = [x for x in text.strip().splitlines() if x.strip()]
    return lines[-1].strip() if lines else ""


def _rel(root: Path, path: str) -> str:
    """途中経過のパスは置き場からの位置で出す。"""
    p = str(path or "")
    r = str(root).rstrip("/") + "/"
    return p[len(r):] if p.startswith(r) else p


CD_PREFIX = re.compile(r"^\s*cd\s+(?:\"[^\"]*\"|'[^']*'|\S+)\s*(?:&&|;)\s*")


def _short_command(cmd: str) -> str:
    """`/bin/zsh -lc "…"` の包みと先頭の `cd 場所 &&` を外して見せる（一覧では先頭しか見えないため）。"""
    try:
        parts = shlex.split(cmd)
    except ValueError:
        parts = []
    if len(parts) == 3 and parts[1] in ("-lc", "-c") and parts[0].endswith("sh"):
        cmd = parts[2]
    return CD_PREFIX.sub("", cmd, count=1) or cmd


def child_env(root: Path) -> dict:
    """AI の中のコマンドから、同じ置き場の slide-studio を呼べるようにする。
    SLIDE_STUDIO_SANDBOX があると `slide-studio check` は起動中のアプリに検査を頼む（bridge.py）。"""
    env = dict(os.environ)
    env["SLIDE_STUDIO_HOME"] = str(root)
    env["SLIDE_STUDIO_SANDBOX"] = "1"
    bindir = str(Path(sys.executable).parent)
    env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
    return env


def model(id: str, name: str, efforts: list[str] | None = None, effort: str | None = None,
          context: int | None = None) -> dict:
    efforts = [e for e in EFFORTS if e in (efforts or [])]
    if effort not in efforts:
        effort = "medium" if "medium" in efforts else (efforts[0] if efforts else None)
    return {"id": id, "name": name, "efforts": efforts, "effort": effort, "context": context}


def codex_limits(snapshot: dict) -> dict:
    """Codex の利用上限（primary・secondary）を {"five_hour"|"weekly": {"used": %, "resets": 秒}} に直す。"""
    out = {}
    for i, w in enumerate((snapshot.get("primary"), snapshot.get("secondary"))):
        if w and w.get("usedPercent") is not None:
            mins = w.get("windowDurationMins") or (300 if i == 0 else 10080)
            out["five_hour" if mins <= 24 * 60 else "weekly"] = {"used": w["usedPercent"], "resets": w.get("resetsAt")}
    return out


def claude_limits(info: dict) -> dict:
    """Claude Code の rate_limit_event を codex_limits と同じ形に直す（utilization は 0〜1）。"""
    windows = info.get("unifiedWindows") or ({info["rateLimitType"]: info} if info.get("rateLimitType") else {})
    return {key: {"used": round(w["utilization"] * 100), "resets": w.get("resetsAt")}
            for name, key in (("five_hour", "five_hour"), ("seven_day", "weekly"))
            if (w := windows.get(name)) and w.get("utilization") is not None}


async def _until_signed_in(done, signed_in, every: float = 3) -> None:
    """CLI の終了か、ログイン済みの確認の早い方まで待つ。"""
    waiter = asyncio.ensure_future(done)
    try:
        while True:
            finished, _ = await asyncio.wait({waiter}, timeout=every)
            if await asyncio.to_thread(signed_in):
                return
            if finished:
                waiter.result()  # 失敗の理由があれば出す
                raise ValueError("ログインを完了できませんでした。もう一度お試しください。")
    finally:
        waiter.cancel()


class Provider:
    id = ""
    name = ""
    env_var = ""
    exe_names: tuple[str, ...] = ()
    images_flag = False  # 画像を CLI で添付できる（できなければパスを書いて読ませる）

    def binary(self) -> str | None:
        configured = os.environ.get(self.env_var)
        if configured is not None:
            # テストや「使わない」設定のため。none で無いものとして扱う
            return None if configured in ("", "none") else configured
        managed = self.runtime.executable()
        if managed:
            return str(managed)
        for name in self.exe_names:
            found = shutil.which(name)
            if found:
                return found
        for extra in self.extra_paths():
            if extra.is_file() and os.access(extra, os.X_OK):
                return str(extra)
        return None

    def extra_paths(self) -> list[Path]:
        return []

    @staticmethod
    def home() -> Path:
        raise NotImplementedError

    @cached_property
    def runtime(self):
        from .runtimes import Runtime
        return Runtime(self)

    def overridden(self) -> bool:
        """実行ファイルを環境変数で指定している（テストや「使わない」設定）。"""
        return self.env_var in os.environ

    def ensure_binary(self) -> str:
        """ログインの前に呼ぶ。アプリ専用の実行ファイルが無ければ公式の配布元から取得する。"""
        from ..workspace import StudioError
        if self.overridden():
            found = self.binary()
            if found:
                return found
            raise StudioError(f"{self.name} の実行設定を確認してください。")
        try:
            return self.runtime.ensure(self.accepts)
        except StudioError:
            found = self.binary()  # 配布元に届かなくても、ターミナルの CLI があれば使う
            if found:
                return found
            raise

    def accepts(self, exe: str, was_ok: bool = False) -> str | None:
        """取得した版が動くかを試す。動かなければ理由を返す（その版には切り替えない）。"""
        try:
            r = _run([exe, "--version"], env={**os.environ, **self.env(self.home())})
            if r.returncode != 0:
                return _last_line(r.stderr or r.stdout) or "起動できませんでした"
            found = self._detect(exe, {})
        except (OSError, subprocess.SubprocessError, ValueError, TimeoutError) as e:
            return str(e)[:300] or "起動できませんでした"
        if found.get("reason") == "error" or (was_ok and not found.get("ok")):
            return found.get("message") or "動作を確かめられませんでした"
        return None

    async def login(self, exe: str) -> None:
        """公式のログイン画面をブラウザーで開き、完了まで待つ。失敗は例外。"""
        raise NotImplementedError

    def detect(self, cache: dict) -> dict:
        """{"id","name","ok","reason"(missing|login|error),"message","models","default"}。"""
        out = {"id": self.id, "name": self.name, "ok": False, "reason": "", "message": "", "models": [], "default": None}
        exe = self.binary()
        if not exe:
            out["reason"] = "missing"
            return out
        try:
            out.update(self._detect(exe, cache))
        except (OSError, subprocess.SubprocessError, ValueError, TimeoutError) as e:
            out.update(ok=False, reason="error", message=str(e)[:300])
        # モデルや CLI の既定値によらず、アプリの初期思考量は中に揃える。
        for m in out["models"]:
            if "medium" in m["efforts"]:
                m["effort"] = "medium"
        if out["ok"] and out["models"] and not out["default"]:
            out["default"] = out["models"][0]["id"]
        return out

    def _detect(self, exe: str, cache: dict) -> dict:
        raise NotImplementedError

    def command(self, root: Path, prompt: str, session: str | None, model_id: str | None,
                effort: str | None, images: list[Path], schema: bool = True) -> list[str]:
        """schema：最後の返答を schema.json の形にする（下書きのチャットでは普通の文章）。"""
        raise NotImplementedError

    def parser(self, root: Path):
        raise NotImplementedError

    def make_run(self, root, prompt, session, model_id, effort, images, schema=True, **callbacks):
        from .agent import Run
        return Run(self.command(root, prompt, session, model_id, effort, images, schema=schema), root,
                   {**child_env(root), **self.env(root)}, self.parser(root), **callbacks)

    def env(self, root: Path) -> dict:
        """child_env に足す環境変数。"""
        return {}

    def context(self, session: str | None) -> dict | None:
        """実行の後に分かるコンテキストの使用量（イベントに無いプロバイダー用）。"""
        return None


# ---------------------------------------------------------------- Codex（OpenAI）
class Codex(Provider):
    id, name, env_var, exe_names = "codex", "Codex", "SLIDE_STUDIO_CODEX", ("codex",)
    images_flag = True

    @staticmethod
    def home() -> Path:
        return Path(os.environ.get("SLIDE_STUDIO_CODEX_HOME") or
                    Path.home() / ".config" / "slide-studio" / "codex").expanduser().resolve()

    async def login(self, exe):
        from .app_server import Client
        client = await Client([exe, "app-server", "--listen", "stdio://"]).start()
        try:
            url = (await client.call("account/login/start", {"type": "chatgpt"}))["authUrl"]
            if urlparse(url).scheme != "https":
                raise ValueError("ログイン先の URL が正しくありません")
            # アプリ専用の Chrome プロファイルではなく、OS の既定ブラウザーへ渡す。
            if not await asyncio.to_thread(webbrowser.open, url):
                raise ValueError("ブラウザーを開けませんでした。既定のブラウザーを確認してください。")
            while True:
                ev = await client.events.get()
                if ev is None:
                    raise ValueError("ログインの接続が切れました")
                if ev.get("method") == "account/login/completed":
                    if ev["params"].get("success"):
                        return
                    raise ValueError(ev["params"].get("error") or "ログインを完了できませんでした。もう一度お試しください。")
        finally:
            await client.close()

    def _detect(self, exe: str, cache: dict) -> dict:
        from .app_server import inspect
        result = asyncio.run(inspect([exe, "app-server", "--listen", "stdio://"]))
        try:
            config = tomllib.loads((self.home() / "config.toml").read_text())
        except (OSError, ValueError):
            config = {}
        for m in result.get("models", []):
            if m["id"] == config.get("model"):
                result["default"] = m["id"]
                if config.get("model_reasoning_effort") in m["efforts"]:
                    m["effort"] = config["model_reasoning_effort"]
        return result

    def command(self, root, prompt, session, model_id, effort, images, schema=True):
        return [self.binary() or "codex", "app-server", "--listen", "stdio://"]

    def parser(self, root):
        return AppServerParser(root)

    def make_run(self, root, prompt, session, model_id, effort, images, schema=True, **callbacks):
        from .app_server import AppServerRun
        return AppServerRun(self.command(root, prompt, session, model_id, effort, images, schema),
                            root, child_env(root), self.parser(root), prompt=prompt, session=session,
                            model_id=model_id, effort=effort, images=images, schema=schema, **callbacks)


class CodexParser:
    def __init__(self, root: Path):
        self.root = root

    def feed(self, ev: dict) -> list[dict]:
        t = ev.get("type")
        if t == "thread.started":
            return [{"session": ev.get("thread_id")}]
        if t in ("item.started", "item.completed", "item.updated"):
            item = ev.get("item") or {}
            kind, iid = item.get("type"), item.get("id")
            done = t == "item.completed"
            if kind == "agent_message" and done:
                text = (item.get("text") or "").strip()
                # 最後の報告は途中経過に出さない
                return [{"final": text}] if parse_final(text) else [{"step": {"id": iid, "kind": "message", "text": text}}, {"final": text}]
            if kind == "reasoning" and done:
                text = (item.get("text") or "").strip()
                return [{"step": {"id": iid, "kind": "think", "text": text}}] if text else []
            if kind == "command_execution":
                step = {"id": iid, "kind": "command", "text": _short_command(item.get("command") or "")}
                if done:
                    step["exit"] = item.get("exit_code")
                return [{"step": step}]
            if kind == "file_change" and done:
                names = [f"{c.get('kind', '')} {_rel(self.root, c.get('path', ''))}".strip() for c in item.get("changes") or []]
                return [{"step": {"id": iid, "kind": "file", "text": "、".join(names)}}]
            if kind == "error":
                return [{"step": {"id": iid, "kind": "error", "text": item.get("message") or ""}}]
            if kind == "webSearch" and done:
                return [{"step": {"id": iid, "kind": "tool", "text": f"web 検索 {item.get('query') or ''}".strip()}}]
        if t == "error":
            return [{"step": {"id": None, "kind": "error", "text": ev.get("message") or ""}}]
        if t == "turn.failed":
            return [{"step": {"id": None, "kind": "error", "text": (ev.get("error") or {}).get("message") or "Codex が失敗しました"}}]
        return []


class AppServerParser(CodexParser):
    def feed(self, ev):
        method, p = ev.get("method"), ev.get("params") or {}
        if method == "thread/tokenUsage/updated":
            usage = p.get("tokenUsage") or {}
            return [{"usage": {"used": (usage.get("last") or {}).get("totalTokens", 0),
                               "window": usage.get("modelContextWindow")}}]
        if method == "account/rateLimits/updated":
            limits = codex_limits(p.get("rateLimits") or {})
            return [{"limits": limits}] if limits else []
        if method in ("item/started", "item/completed"):
            item = dict(p.get("item") or {})
            kind = item.get("type")
            item["type"] = {"agentMessage": "agent_message", "commandExecution": "command_execution",
                            "fileChange": "file_change"}.get(kind, kind)
            if kind == "commandExecution":
                item["exit_code"] = item.get("exitCode")
            if kind == "fileChange":
                item["changes"] = [{**c, "kind": (c.get("kind") or {}).get("type", "")} for c in item.get("changes", [])]
            if kind == "reasoning":
                item["text"] = "\n".join(item.get("summary") or item.get("content") or [])
            return super().feed({"type": method.replace("/", "."), "item": item})
        if method == "error" and not p.get("willRetry"):
            return super().feed({"type": "error", "message": (p.get("error") or {}).get("message", "Codex が失敗しました")})
        return []


# ---------------------------------------------------------------- Claude Code
CLAUDE_MODELS = [("opus", "Claude Opus"), ("sonnet", "Claude Sonnet"), ("haiku", "Claude Haiku"), ("fable", "Claude Fable")]
CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
# Bash は sandbox の中で自動で許可し、sandbox の外での実行は許さない。ファイルの編集は作業フォルダの中だけ自動で許可される
CLAUDE_SETTINGS = {"sandbox": {"enabled": True, "autoAllowBashIfSandboxed": True, "allowUnsandboxedCommands": False}}
EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


class Claude(Provider):
    id, name, env_var, exe_names = "claude", "Claude Code", "SLIDE_STUDIO_CLAUDE", ("claude",)

    @staticmethod
    def home() -> Path:
        return Path(os.environ.get("SLIDE_STUDIO_CLAUDE_HOME") or
                    Path.home() / ".config" / "slide-studio" / "claude").expanduser().resolve()

    def env(self, root: Path) -> dict:
        # アプリが取得した版を CLI 自身に書き換えさせない（更新は runtimes.py が行う）
        return {"CLAUDE_CONFIG_DIR": str(self.home()), "DISABLE_AUTOUPDATER": "1"}

    def extra_paths(self):
        return [Path.home() / ".claude" / "local" / "claude", Path.home() / ".local" / "bin" / "claude"]

    def _detect(self, exe, cache):
        r = _run([exe, "auth", "status"], env={**os.environ, **self.env(self.home())})
        try:
            status = json.loads(r.stdout)
        except ValueError:
            return {"ok": False, "reason": "error", "message": _last_line(r.stderr or r.stdout)}
        if not status.get("loggedIn"):
            return {"ok": False, "reason": "login", "message": ""}
        try:
            settings = json.loads((self.home() / "settings.json").read_text())
        except (OSError, ValueError):
            settings = {}
        default = settings.get("model") if isinstance(settings.get("model"), str) else "opus"
        effort = settings.get("effortLevel") if settings.get("effortLevel") in CLAUDE_EFFORTS else "medium"
        windows = cache.get("claude") or {}
        models = [model(i, n, CLAUDE_EFFORTS, effort, windows.get(i)) for i, n in CLAUDE_MODELS]
        if not any(m["id"] == default for m in models):
            models.insert(0, model(default, default, CLAUDE_EFFORTS, effort, windows.get(default)))
        return {"ok": True, "message": status.get("authMethod") or "", "models": models, "default": default}

    def _signed_in(self, exe: str) -> bool:
        try:
            return bool(self._detect(exe, {}).get("ok"))
        except (OSError, subprocess.SubprocessError, ValueError):
            return False

    async def login(self, exe):
        # 認証・保存は公式 CLI に任せ、出力された認証 URL を既定ブラウザーに渡す。
        self.home().mkdir(parents=True, exist_ok=True)
        proc = await asyncio.create_subprocess_exec(
            exe, "auth", "login", "--claudeai", env={**os.environ, **self.env(self.home())},
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)

        async def read_login():
            opened = False
            async for raw in proc.stdout:
                line = raw.decode("utf-8", errors="replace")
                for url in re.findall(r"https://[^\s\x1b<>]+", line):
                    parsed = urlparse(url)
                    if not opened and parsed.hostname in {"claude.ai", "platform.claude.com", "console.anthropic.com"} and parsed.path == "/oauth/authorize":
                        if not await asyncio.to_thread(webbrowser.open, url):
                            raise ValueError("ブラウザーを開けませんでした。既定のブラウザーを確認してください。")
                        opened = True
            await proc.wait()

        reader = asyncio.create_task(read_login())
        try:
            await _until_signed_in(reader, lambda: self._signed_in(exe))
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    def command(self, root, prompt, session, model_id, effort, images, schema=True):
        argv = [self.binary() or "claude", "-p", "--output-format", "stream-json", "--verbose",
                "--permission-mode", "acceptEdits", "--settings", json.dumps(CLAUDE_SETTINGS)]
        if schema:
            argv += ["--json-schema", SCHEMA.read_text()]
        if model_id:
            argv += ["--model", model_id]
        if effort:
            argv += ["--effort", effort]
        if session:
            argv += ["--resume", session]
        return argv + ["--", prompt]

    def parser(self, root):
        return ClaudeParser(root)


class ClaudeParser:
    def __init__(self, root: Path):
        self.root = root
        self.model = None
        self.tools: dict[str, dict] = {}

    def feed(self, ev: dict) -> list[dict]:
        t = ev.get("type")
        out: list[dict] = []
        if ev.get("session_id"):
            out.append({"session": ev["session_id"]})
        if t == "system" and ev.get("subtype") == "init":
            self.model = ev.get("model")
        elif t == "rate_limit_event":
            limits = claude_limits(ev.get("rate_limit_info") or {})
            if limits:
                out.append({"limits": limits})
        elif t == "assistant" and not ev.get("parent_tool_use_id"):
            msg = ev.get("message") or {}
            for c in msg.get("content") or []:
                if c.get("type") == "text" and c.get("text", "").strip():
                    out.append({"step": {"id": msg.get("id"), "kind": "message", "text": c["text"].strip()}})
                elif c.get("type") == "thinking" and (c.get("thinking") or "").strip():
                    out.append({"step": {"id": None, "kind": "think", "text": c["thinking"].strip()}})
                elif c.get("type") == "tool_use" and c.get("name") != "StructuredOutput":
                    step = self._tool(c)
                    self.tools[c.get("id")] = step
                    out.append({"step": step})
            u = msg.get("usage") or {}
            if u:
                used = sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
                out.append({"usage": {"used": used, "window": None}})
        elif t == "user":
            for c in (ev.get("message") or {}).get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in self.tools:
                    step = dict(self.tools.pop(c["tool_use_id"]))
                    if step["kind"] == "command" or c.get("is_error"):
                        step["exit"] = 1 if c.get("is_error") else 0
                    out.append({"step": step})
        elif t == "result":
            if ev.get("structured_output") is not None:
                out.append({"final": ev["structured_output"]})
            elif ev.get("result"):
                out.append({"final": ev["result"]})
            if ev.get("is_error") or (ev.get("subtype") or "success") != "success":
                out.append({"step": {"id": None, "kind": "error", "text": str(ev.get("result") or ev.get("subtype") or "Claude Code が失敗しました")}})
            usage = ev.get("modelUsage") or {}
            key = next((k for k in usage if self.model and k.startswith(self.model)), next(iter(usage), None))
            if key and usage[key].get("contextWindow"):
                out.append({"usage": {"used": None, "window": usage[key]["contextWindow"], "model": self.model}})
        return out

    def _tool(self, c: dict) -> dict:
        name, inp = c.get("name") or "", c.get("input") or {}
        if name == "Bash":
            return {"id": c.get("id"), "kind": "command", "text": _short_command(inp.get("command") or "")}
        if name in EDIT_TOOLS:
            return {"id": c.get("id"), "kind": "file", "text": f"{name} {_rel(self.root, inp.get('file_path') or inp.get('notebook_path') or '')}"}
        arg = inp.get("file_path") or inp.get("pattern") or inp.get("path") or inp.get("skill") or inp.get("query") or inp.get("description") or ""
        return {"id": c.get("id"), "kind": "tool", "text": f"{name} {_rel(self.root, str(arg))}".strip()}


# ---------------------------------------------------------------- Antigravity（Gemini）
AGY_SETTINGS = {"toolPermission": "proceed-in-sandbox"}
EFFORT_SUFFIX = re.compile(r"^(.+)-(" + "|".join(EFFORTS) + r")$")
NAME_SUFFIX = re.compile(r"\s*\((?:" + "|".join(EFFORTS) + r")\)\s*$", re.I)


class Antigravity(Provider):
    id, name, env_var, exe_names = "agy", "Antigravity", "SLIDE_STUDIO_AGY", ("agy",)

    @staticmethod
    def home() -> Path:
        """アプリが取得した実行ファイルの置き場所。ログインはターミナルの agy と共通。"""
        return Path(os.environ.get("SLIDE_STUDIO_AGY_HOME") or
                    Path.home() / ".config" / "slide-studio" / "agy").expanduser().resolve()

    def env(self, root: Path) -> dict:
        return {"AGY_CLI_DISABLE_AUTO_UPDATE": "true"}  # 更新は runtimes.py が行う

    def extra_paths(self):
        return [Path.home() / ".local" / "bin" / "agy", Path.home() / ".antigravity-main" / "agy"]

    def _signed_in(self, exe: str) -> bool:
        try:
            return bool(self._detect(exe, {}).get("ok"))
        except (OSError, subprocess.SubprocessError, ValueError):
            return False

    async def login(self, exe):
        proc = await asyncio.create_subprocess_exec(
            exe, "acp", env={**os.environ, **self.env(self.home())}, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=32 * 1024 * 1024)

        async def call(key: int, method: str, params: dict) -> dict:
            proc.stdin.write((json.dumps({"jsonrpc": "2.0", "id": key, "method": method, "params": params}) + "\n").encode())
            await proc.stdin.drain()
            while line := await proc.stdout.readline():
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if message.get("id") == key:
                    if message.get("error"):
                        raise ValueError(message["error"].get("message") or "ログインを完了できませんでした。")
                    return message.get("result") or {}
            raise ValueError("ログインの接続が切れました")

        try:
            await call(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
            await _until_signed_in(call(2, "authenticate", {"methodId": "oauth-personal"}),
                                   lambda: self._signed_in(exe), every=5)
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    def _detect(self, exe, cache):
        r = _run([exe, "models"], timeout=60, env={**os.environ, **self.env(self.home())})
        if r.returncode != 0:
            text = _last_line(r.stderr or r.stdout)
            if re.search(r"sign.?in|log.?in|authenticat", r.stdout + r.stderr, re.I):
                return {"ok": False, "reason": "login", "message": ""}
            return {"ok": False, "reason": "error", "message": text}
        # モデルは「名前-low / -medium / -high」で思考量ごとに分かれているので、1つのモデルにまとめる
        groups: dict[str, dict] = {}
        for line in r.stdout.splitlines():
            if "\t" not in line:
                continue
            mid, label = (x.strip() for x in line.split("\t", 1))
            m = EFFORT_SUFFIX.match(mid)
            base, effort = (m[1], m[2]) if m else (mid, None)
            g = groups.setdefault(base, {"name": NAME_SUFFIX.sub("", label), "efforts": []})
            if effort:
                g["efforts"].append(effort)
        if not groups:
            return {"ok": False, "reason": "login", "message": _last_line(r.stdout + r.stderr)}
        return {"ok": True, "models": [model(k, g["name"], g["efforts"]) for k, g in groups.items()]}

    def command(self, root, prompt, session, model_id, effort, images, schema=True):
        argv = [self.binary() or "agy", "--output-format", "stream-json", "--mode", "accept-edits", "--sandbox",
                "--settings", json.dumps(AGY_SETTINGS)]
        if schema:
            argv += ["--json-schema", json.dumps(schema) if isinstance(schema, dict) else str(SCHEMA)]
        if model_id:
            argv += ["--model", f"{model_id}-{effort}" if effort else model_id]
        if session:
            argv += ["--conversation", session]
        return argv + ["-p", prompt]

    def parser(self, root):
        return AgyParser(root)


class AgyParser:
    def __init__(self, root: Path):
        self.root = root
        self.texts: dict[int, str] = {}

    def feed(self, ev: dict) -> list[dict]:
        kind = ev.get("event")
        if kind == "init":
            return [{"session": ev.get("conversation_id")}]
        if kind == "result":
            r = ev.get("result") or {}
            out = []
            if r.get("structured_output") is not None:
                out.append({"final": r["structured_output"]})
            elif r.get("response"):
                out.append({"final": r["response"]})
            if r.get("status") not in (None, "SUCCESS"):
                out.append({"step": {"id": None, "kind": "error", "text": str(r.get("error") or f"Antigravity: {r.get('status')}")}})
            for d in r.get("denied_actions") or []:
                out.append({"step": {"id": None, "kind": "error", "text": f"許可されなかった操作: {d.get('display_name') or d.get('action')}"}})
            return out
        if kind != "step_update":
            return []
        s = ev.get("step_update") or {}
        i, state, st = s.get("step_index"), s.get("state"), s.get("step_type")
        if st == "agent_response":
            self.texts[i] = self.texts.get(i, "") + (s.get("text_delta") or "")
            if state != "DONE":
                return []
            out = []
            text = self.texts.pop(i, "").strip()
            if text and not parse_final(text):
                out.append({"step": {"id": f"a{i}", "kind": "message", "text": text}})
            u = s.get("usage") or {}
            if u:
                out.append({"usage": {"used": (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0), "window": None}})
            return out
        if st == "tool":
            info = s.get("tool_info") or {}
            name, params = info.get("name") or s.get("tool_name") or "", info.get("parameters") or {}
            if name == "run_command":
                step = {"id": f"t{i}", "kind": "command", "text": _short_command(params.get("CommandLine") or "")}
            else:
                path = params.get("Path") or params.get("TargetFile") or params.get("AbsolutePath") or params.get("SearchPath") or ""
                editing = any(w in name for w in ("write", "replace", "edit"))
                step = {"id": f"t{i}", "kind": "file" if editing else "tool", "text": f"{name} {_rel(self.root, path)}".strip()}
            if state == "ERROR" or info.get("error"):
                step["exit"] = 1
            elif state == "DONE" and step["kind"] == "command":
                m = re.search(r"exited with code (\d+)", info.get("output") or "")
                step["exit"] = int(m[1]) if m else 0
            return [{"step": step}]
        return []


PROVIDERS: dict[str, Provider] = {p.id: p for p in (Codex(), Claude(), Antigravity())}


def split_key(key: str) -> tuple[str, str]:
    """モデルの鍵 "codex:gpt-6-astra" を (プロバイダー, モデル) に分ける。"""
    pid, _, mid = (key or "").partition(":")
    return pid, mid
