"""確認役へ渡すツール定義とディスパッチ。他の役割のプロンプトを読み込まない。

専用の確認エージェントがない場合は、呼び出し側が同じ定義をチャットへ渡す。
役割の選択・モデル設定はここでは行わない。
"""
from __future__ import annotations

from ... import audit
from ...workspace import StudioError


def _object(properties, required=None):
    return {"type": "object", "properties": properties, "required": list(properties) if required is None else required,
            "additionalProperties": False}


STRING = {"type": "string", "minLength": 1}
TOOLS = [
    {"name": "audit_run", "description": "全ページ・全stepの監査を実行し、問題と確認用画像を返す。修正後は再実行する。",
     "input_schema": _object({"deck": STRING})},
    {"name": "audit_review", "description": "全画像を開いて確認した所見と全問題の判断を記録する。エラーは承認できない。",
     "input_schema": _object({"deck": STRING, "audit_id": STRING, "reviewer": STRING,
         "states": {"type": "array", "items": _object({"id": STRING, "note": STRING})},
         "decisions": {"type": "array", "items": _object({"id": STRING,
             "decision": {"type": "string", "enum": ["accepted", "needs_fix"]}, "reason": STRING})},
         "visual_issues": {"type": "array", "items": STRING}})},
    {"name": "audit_status", "description": "監査と確認記録が最新版に対応するか調べ、完了できるか返す。",
     "input_schema": _object({"deck": STRING, "audit_id": STRING})},
]


def execute(ws, name: str, arguments: dict, *, run_audit=None) -> dict:
    spec = next((x for x in TOOLS if x["name"] == name), None)
    if spec is None:
        raise StudioError(f"監査ツールがありません: {name}")
    if not isinstance(arguments, dict) or set(arguments) != set(spec["input_schema"]["required"]):
        raise StudioError("監査ツールの引数が正しくありません")
    for key in ("deck", "audit_id"):
        if key in arguments and (not isinstance(arguments[key], str) or not arguments[key]):
            raise StudioError(f"{key} は空でない文字列で指定してください")
    if name == "audit_run":
        return run_audit(arguments["deck"]) if run_audit else audit.run(ws, **arguments)
    if name == "audit_review":
        return audit.review(ws, **arguments)
    return audit.status(ws, **arguments)
