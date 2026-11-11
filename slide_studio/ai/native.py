"""担当（編集担当と確認役）を、AI 本体の道具で置き場の中で動かす。設計書 §8.1.2。

起動場所は置き場。指示は置き場の AGENTS.md・skill から AI が読む（アプリはシステムプロンプトも道具も渡さない）。
編集担当が書ける範囲は置き場全体（AI 本体の sandbox）で、置き場の中では控え（.slide-studio/snapshots/）とチャットの記録（chat/）だけを書かせない。
確認役（readonly）は読むだけ：Codex は sandbox を read-only、Claude Code は書き込みの道具を渡さず、Bash も置き場に書かせない。
"""
from __future__ import annotations

import json
from pathlib import Path

from ..workspace import Workspace
from .agent import Run
from .app_server import AppServerRun
from .providers import SCHEMA, child_env

PROTECTED = ("snapshots", "chat")  # .slide-studio/ の中で書かせないもの
PROFILE = "slide-studio"
WEB_TOOLS = "WebSearch,WebFetch"
WRITE_TOOLS = "Edit,Write,NotebookEdit"


def protected(ws: Workspace) -> list[Path]:
    return [ws.state / name for name in PROTECTED]


def codex_config(ws: Workspace, web: bool) -> dict:
    """Codex の権限のプロファイル：置き場（作業フォルダ）に書け、控えとチャットの記録は読むだけ。"""
    return {"default_permissions": PROFILE, f"permissions.{PROFILE}.extends": ":workspace",
            f"permissions.{PROFILE}.filesystem": {str(p): "read" for p in protected(ws)},
            "web_search": "live" if web else "disabled"}


def _toml(value) -> str:
    if isinstance(value, dict):
        return "{" + ", ".join(f"{json.dumps(k)} = {_toml(v)}" for k, v in value.items()) + "}"
    return json.dumps(value)


def codex_args(config: dict) -> list[str]:
    return [a for key, value in config.items() for a in ("-c", f"{key}={_toml(value)}")]


def claude_settings(ws: Workspace, readonly: bool = False) -> dict:
    """Claude Code：Bash は sandbox の中で自動で許可し、控えとチャットの記録（確認役は置き場全体）への書き込みは道具でも Bash でも断る。"""
    return {"sandbox": {"enabled": True, "autoAllowBashIfSandboxed": True, "allowUnsandboxedCommands": False},
            "permissions": {"deny": [f"Edit(/{p}/**)" for p in ([ws.root] if readonly else protected(ws))]}}


def claude_command(provider, ws: Workspace, prompt, session, model_id, effort, schema, web: bool, readonly: bool = False) -> list[str]:
    """prompt が None なら、起動したまま依頼を標準入力で受ける形（--input-format stream-json。--resume は live.Pool が足す）。"""
    argv = [provider.binary() or "claude", "-p", "--output-format", "stream-json", "--verbose",
            "--permission-mode", "default" if readonly else "acceptEdits", "--setting-sources", "project",
            "--settings", json.dumps(claude_settings(ws, readonly))]
    if web:
        argv += ["--allowedTools", WEB_TOOLS]
    if readonly or not web:
        argv += ["--disallowedTools", ",".join(([WRITE_TOOLS] if readonly else []) + ([] if web else [WEB_TOOLS]))]
    if model_id:
        argv += ["--model", model_id]
    if effort:
        argv += ["--effort", effort]
    if session:
        argv += ["--resume", session]
    if schema:
        argv += ["--json-schema", json.dumps(schema) if isinstance(schema, dict) else SCHEMA.read_text()]
    if prompt is None:
        return argv + ["--input-format", "stream-json"]
    return argv + ["--", prompt]


def agy_command(provider, ws, prompt, session, model_id, effort, images, schema, web, readonly):
    argv = provider.command(ws.root, prompt, session, model_id, effort, images, schema)
    # command(*) の許可は sandbox 外にも及ぶので付けない。
    deny = ["mcp(*)"]
    if readonly:
        deny += ["write_file(*)", "command(*)"]
    else:
        deny += [f"write_file({p}/**)" for p in protected(ws)]
    if not web:
        deny += ["read_url(*)"]
    settings = {"toolPermission": "proceed-in-sandbox", "permissions": {
        "allow": ["read_url(*)"] if web else [], "deny": deny}}
    argv[argv.index('--settings') + 1] = json.dumps(settings)
    if readonly:
        argv[argv.index('--mode') + 1] = 'plan'
    return argv


def make_run(provider, ws: Workspace, prompt, session, model_id, effort, images, schema, web: bool, readonly: bool = False,
             pool=None, key=None, **callbacks):
    """pool（live.Pool）があれば起動したままの AI を使う。key は Claude Code のプロセスの持ち主（タブ・担当）。"""
    env = {**child_env(ws.root), **provider.env(ws.root)}
    if provider.id == "codex":
        if readonly:
            # 確認役：プロファイルを使わず、thread/start の sandbox で読むだけにする
            argv = provider.command(ws.root, prompt, session, model_id, effort, images, schema) + codex_args({"web_search": "live" if web else "disabled"})
            sandbox = "read-only"
        else:
            # sandbox はプロファイルで決める（thread/start の sandbox と一緒には指定できない）
            argv = provider.command(ws.root, prompt, session, model_id, effort, images, schema) + codex_args(codex_config(ws, web))
            sandbox = None
        return AppServerRun(argv, ws.root, env, provider.parser(ws.root), prompt=prompt, session=session, model_id=model_id,
                            effort=effort, images=images, schema=schema, sandbox=sandbox, pool=pool, **callbacks)
    if provider.id == "agy":
        return Run(agy_command(provider, ws, prompt, session, model_id, effort, images, schema, web, readonly),
                   ws.root, env, provider.parser(ws.root), **callbacks)
    if pool is not None and key is not None:
        from .live import ClaudeRun
        argv = claude_command(provider, ws, None, None, model_id, effort, schema, web, readonly)
        return ClaudeRun(pool, key, argv, ws.root, env, provider.parser(ws.root), prompt, session, **callbacks)
    return Run(claude_command(provider, ws, prompt, session, model_id, effort, schema, web, readonly), ws.root, env,
               provider.parser(ws.root), **callbacks)
