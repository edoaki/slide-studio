"""役割・モデルに依存しない監査ツール。画像確認はエージェントの申告として記録する。"""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

from . import check
from .fsutil import sha256_bytes, write_atomic
from .workspace import StudioError, Workspace


def _folder(ws: Workspace, deck: str, audit_id: str) -> Path:
    ws.require_deck(deck)
    if not re.fullmatch(r"[0-9a-f]{32}", audit_id):
        raise StudioError("監査 ID が正しくありません")
    return ws.state / "audits" / deck / audit_id


def _version(ws: Workspace, deck: str) -> dict:
    package = Path(__file__).parent
    files = [Path(__file__), Path(check.__file__), check.LAYOUT_JS, *sorted((package / "runtime").glob("*"))]
    engine = sha256_bytes(b"".join(p.read_bytes() for p in files if p.is_file()))
    return {**check.deck_version(ws, deck), "engine": engine}


def run(ws: Workspace, deck: str, browser=None) -> dict:
    """全ページ・全stepを新規ディレクトリで検査。GUI の画像・検査結果と混ぜない。"""
    audit_id = uuid.uuid4().hex
    folder = _folder(ws, deck, audit_id)
    version = _version(ws, deck)
    result = check.check_deck(ws, deck, browser=browser, out_dir=folder, audit=True)
    states = []
    for slide in result["slides"]:
        for step in range(slide.get("steps") or 0):
            name = check._slide_name(slide["index"], step)
            image = folder / "shots" / f"{name}.png"
            states.append({"id": name, "page": slide.get("id"), "slide": slide["index"] + 1, "step": step + 1,
                           "image": str(image), "image_sha256": sha256_bytes(image.read_bytes())})
    issues = []
    for i, issue in enumerate(result["errors"] + result["warnings"], 1):
        x = {**issue, "id": f"issue-{i}"}
        if x.get("slide") is not None and x.get("step") is not None:
            x["state_id"] = check._slide_name(x["slide"], x["step"])
        # ツールのページ・step表記は states と同じ1始まり。checks.json は従来の0始まり。
        for key in ("slide", "step", "page"):
            if isinstance(x.get(key), int):
                x[key] += 1
        if x.get("steps"):
            x["steps"] = [s + 1 for s in x["steps"]]
        if x.get("image"):
            x["image"] = str(folder / x["image"])
        issues.append(x)
    report = {"schema_version": 1, "audit_id": audit_id, "deck": deck, "version": version,
              "checked_at": result["checked_at"], "stable": version == _version(ws, deck),
              "states": states, "issues": issues, "review": None,
              "instructions": "全状態の画像と問題を確認して audit_review に記録する。修正したら audit_run を再実行する。"}
    write_atomic(folder / "report.json", json.dumps(report, ensure_ascii=False, indent=2))
    return status(ws, deck, audit_id)


def status(ws: Workspace, deck: str, audit_id: str) -> dict:
    folder = _folder(ws, deck, audit_id)
    try:
        report = json.loads((folder / "report.json").read_text())
    except (OSError, ValueError) as e:
        raise StudioError("監査結果がありません。audit run を実行してください") from e
    fresh = report["stable"] and report["version"] == _version(ws, deck)
    images_ok = True
    for state in report["states"]:
        try:
            images_ok &= sha256_bytes(Path(state["image"]).read_bytes()) == state["image_sha256"]
        except OSError:
            images_ok = False
    review = report["review"]
    unresolved = any(x["level"] == "error" for x in report["issues"])
    if review:
        unresolved |= bool(review["visual_issues"]) or any(x["decision"] == "needs_fix" for x in review["decisions"])
    state = ("stale" if not fresh or not images_ok else "needs_fix" if unresolved
             else "needs_review" if not review or not report["states"] else "complete")
    return {**report, "status": state, "complete": state == "complete", "report": str(folder / "report.json")}


def review(ws: Workspace, deck: str, audit_id: str, *, reviewer: str, states: list[dict],
           decisions: list[dict], visual_issues: list[str]) -> dict:
    """全画像の所見・全警告の判断を記録。検査エラーを承認で消すことはできない。"""
    report = status(ws, deck, audit_id)
    if report["status"] == "stale":
        raise StudioError("監査が古くなっています。修正後に audit run を再実行してください")
    if not isinstance(reviewer, str) or not reviewer.strip():
        raise StudioError("確認したエージェント名を指定してください")
    for values, expected, key in ((states, report["states"], "note"), (decisions, report["issues"], "reason")):
        if not isinstance(values, list) or not all(isinstance(v, dict) for v in values):
            raise StudioError("画像の確認・問題の判断は配列で指定してください")
        ids = [v.get("id") for v in values]
        if not all(isinstance(x, str) for x in ids) or len(ids) != len(expected) or set(ids) != {v["id"] for v in expected}:
            raise StudioError("すべての画像と問題について、重複なく確認結果を指定してください")
        if any(not isinstance(v.get(key), str) or not v[key].strip() for v in values):
            raise StudioError("画像の所見・判断の理由を空にできません")
    by_id = {x["id"]: x for x in report["issues"]}
    for d in decisions:
        if d.get("decision") not in ("accepted", "needs_fix"):
            raise StudioError("判断は accepted または needs_fix を指定してください")
        if d["decision"] == "accepted" and by_id[d["id"]]["level"] == "error":
            raise StudioError("検査エラーは承認できません。修正して再監査してください")
    if not isinstance(visual_issues, list) or any(not isinstance(x, str) or not x.strip() for x in visual_issues):
        raise StudioError("目視で見つけた問題は文字列の配列で指定してください")
    report["review"] = {"reviewer": reviewer, "states": states, "decisions": decisions, "visual_issues": visual_issues}
    for key in ("status", "complete", "report"):
        report.pop(key, None)
    write_atomic(_folder(ws, deck, audit_id) / "report.json", json.dumps(report, ensure_ascii=False, indent=2))
    return status(ws, deck, audit_id)
