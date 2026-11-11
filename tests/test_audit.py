"""監査ツール：描画された行、HTML、確認記録、版の一致、sandbox の往復。"""
import json

import pytest
from playwright.sync_api import sync_playwright

from conftest import add_deck, close_shared_browser
from slide_studio import audit, check
from slide_studio.ai import audit_tools
from slide_studio.cli import main
from slide_studio.fsutil import write_atomic
from slide_studio.workspace import StudioError


@pytest.fixture(scope="module")
def page():
    # module fixture は function の自動 fixture より先に起動する。
    close_shared_browser()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        yield page
        browser.close()


def measure(page, html, **options):
    page.set_content('<style>body{margin:0;width:1280px;height:720px}p{margin:0} '
                     '.slide{width:1280px;height:720px;position:relative} '
                     '.text{font:20px/30px monospace;word-break:break-all}</style>'
                     '<div class="slide active">' + html + '</div>')
    return page.evaluate(check.LAYOUT, {"audit": True, **options})


def test_short_rendered_lines_and_inline_markup(page):
    issues = measure(page, '<p class="text" style="width:10ch">ABCDEFGHIJ<strong>KLMNO</strong></p>')
    short = [x for x in issues if x["kind"] == "short-line"]
    assert [(x["text"], x["characters"], x["line"]) for x in short] == [("KLMNO", 5, 2)]
    for text in ('ABC', 'ABCDEFGHIJKLMNOP', 'ABCDEFGHIJ<strong>KLMNOP</strong>'):
        assert not any(x["kind"] == "short-line" for x in measure(page, f'<p class="text" style="width:10ch">{text}</p>'))
    assert any(x["kind"] == "short-line" for x in measure(page, '<p>長い文章のまとまり<br>短い行</p>'))
    repeated = measure(page, '<p>長い文章のまとまり<br>短い行<br>短い行</p>')
    assert len([x for x in check._dedupe(repeated) if x["kind"] == "short-line"]) == 2


def test_html_frame_overlap_clipping_overflow_and_hidden_step(page):
    html = ('<div style="position:absolute;left:50px;top:50px">同じ位置の文字</div>'
            '<div id="later" style="position:absolute;left:50px;top:50px;visibility:hidden">後から出る文字</div>'
            '<div style="position:absolute;left:1275px;top:100px;white-space:nowrap">外にはみ出る文字</div>'
            '<div style="position:absolute;top:200px;width:20px;overflow:hidden;white-space:nowrap">枠で切れる文字</div>')
    before = measure(page, html, frame=True)
    assert not any(x["kind"] == "overlap" for x in before)
    assert {"figure-overflow", "text-clipped"} <= {x["kind"] for x in before}
    page.locator('#later').evaluate("e => e.style.visibility = 'visible'")
    after = page.evaluate(check.LAYOUT, {"audit": True, "frame": True})
    assert any(x["kind"] == "overlap" for x in after)


def test_intentional_containment_and_empty_line_space(page):
    issues = measure(page, '<div style="background:#ccc;padding:20px"><p>枠内のラベル</p></div>'
                     '<p style="position:absolute;top:200px;line-height:100px">上の行<br>下の行</p>'
                     '<p style="position:absolute;top:275px;left:0">行間にある別の文字</p>')
    assert not any(x["kind"] == "overlap" for x in issues)


def test_svg_and_foreign_object_text(page):
    issues = measure(page, '<svg width="800" height="400"><text x="10" y="30">'
        '<tspan>長い説明のまとまり</tspan><tspan x="10" dy="30">短い行</tspan></text>'
        '<foreignObject x="10" y="100" width="500" height="200">'
        '<div xmlns="http://www.w3.org/1999/xhtml">'
        '<p class="text" style="width:10ch">ABCDEFGHIJ<strong>KLMNO</strong></p>'
        '<div style="position:absolute;top:0">重なる文字</div>'
        '</div></foreignObject></svg>', frame=True)
    assert {x["text"] for x in issues if x["kind"] == "short-line"} == {"短い行", "KLMNO"}
    assert any(x["kind"] == "overlap" for x in issues)


def test_graphemes_hidden_text_and_threshold(page):
    issues = measure(page, '<p>説明のまとまり<br>👨‍👩‍👧‍👦が三文字<span style="display:none">非表示の文字</span></p>')
    short = next(x for x in issues if x["kind"] == "short-line")
    assert short["characters"] == 5


@pytest.mark.parametrize("audit_mode", [False, True])
def test_margin_threshold_is_stable_when_preview_is_scaled(page, audit_mode):
    for scale in (1, .95, .65, .55):
        measure(page, '<style>.slide{box-sizing:border-box;padding-left:108px;'
                f'transform:scale({scale});transform-origin:0 0}}</style>'
                '<p style="position:absolute;left:106px;top:156px">タイトル</p>')
        assert not page.evaluate(check.LAYOUT, {"audit": audit_mode})
        # 境界を実際に超えたものは、縮小していても警告する。
        page.locator('p').evaluate("e => e.style.left = '105.5px'")
        issues = page.evaluate(check.LAYOUT, {"audit": audit_mode})
        assert [x["kind"] for x in issues] == ["margin"]


@pytest.fixture
def report(ws, monkeypatch):
    add_deck(ws, "talk", '---\ntopic: test\ntheme: default\n---\n## テスト {#one}\n本文')

    def fake_check(ws, deck, *, out_dir, **kwargs):
        write_atomic(out_dir / "shots/p01-s0.png", b"image")
        return {"slides": [{"index": 0, "id": "one", "steps": 1}], "checked_at": 123,
                "errors": [], "warnings": [{"level": "warning", "kind": "short-line", "message": "短い行"}]}

    monkeypatch.setattr(check, "check_deck", fake_check)
    return audit.run(ws, "talk")


def confirm(ws, report, **overrides):
    args = {"reviewer": "review-agent", "states": [{"id": "p01-s0", "note": "画像で配置を確認"}],
            "decisions": [{"id": "issue-1", "decision": "accepted", "reason": "意図した改行"}], "visual_issues": []}
    return audit.review(ws, "talk", report["audit_id"], **(args | overrides))


def test_review_requires_all_evidence_and_fresh_source(ws, report):
    assert report["status"] == "needs_review" and not report["complete"]
    with pytest.raises(StudioError, match="すべて"):
        confirm(ws, report, states=[])
    with pytest.raises(StudioError, match="空"):
        confirm(ws, report, decisions=[{"id": "issue-1", "decision": "accepted", "reason": ""}])
    assert confirm(ws, report, visual_issues=["p1の図の線が文字に重なる"])["status"] == "needs_fix"
    assert confirm(ws, report)["complete"]
    write_atomic(ws.themes / "default.css", (ws.themes / "default.css").read_text() + '\n/* change */')
    assert audit.status(ws, "talk", report["audit_id"])["status"] == "stale"
    with pytest.raises(StudioError, match="古く"):
        confirm(ws, report)


def test_errors_cannot_be_accepted_and_images_are_required(ws, report):
    path = audit._folder(ws, "talk", report["audit_id"]) / "report.json"
    raw = json.loads(path.read_text())
    raw["issues"][0]["level"] = "error"
    write_atomic(path, json.dumps(raw))
    with pytest.raises(StudioError, match="承認できません"):
        confirm(ws, report)
    assert confirm(ws, report, decisions=[{"id": "issue-1", "decision": "needs_fix", "reason": "配置を直す"}])["status"] == "needs_fix"
    from pathlib import Path
    Path(report["states"][0]["image"]).unlink()
    assert audit.status(ws, "talk", report["audit_id"])["status"] == "stale"


def test_audits_are_independent_and_reject_invalid_ids(ws, report):
    newer = audit.run(ws, "talk")
    assert newer["audit_id"] != report["audit_id"]
    assert newer["states"][0]["image"] != report["states"][0]["image"]
    assert confirm(ws, report)["complete"]
    assert audit.status(ws, "talk", newer["audit_id"])["status"] == "needs_review"
    with pytest.raises(StudioError):
        audit.status(ws, "talk", "../../bad")


def test_change_during_render_is_stale(ws, report, monkeypatch):
    original = check.check_deck
    def changed(*args, **kwargs):
        result = original(*args, **kwargs)
        write_atomic(ws.qmd("talk"), ws.qmd("talk").read_text() + "\nchanged")
        return result
    monkeypatch.setattr(check, "check_deck", changed)
    assert audit.run(ws, "talk")["status"] == "stale"


def test_cli_and_tool_dispatch(ws, report, tmp_path, capsys):
    assert main(["audit", "tools"]) == 0
    assert len(json.loads(capsys.readouterr().out)) == 3
    assert main(["--root", str(ws.root), "audit", "status", "talk", report["audit_id"]]) == 1
    assert json.loads(capsys.readouterr().out)["status"] == "needs_review"
    with pytest.raises(StudioError):
        audit_tools.execute(ws, "audit_run", {"deck": "talk", "prompt": "unrelated"})
    assert audit_tools.execute(ws, "audit_status", {"deck": "talk", "audit_id": report["audit_id"]})["audit_id"] == report["audit_id"]
    path = tmp_path / "review.json"
    path.write_text(json.dumps({"reviewer": "chat", "states": [{"id": "p01-s0", "note": "確認済み"}],
        "decisions": [{"id": "issue-1", "decision": "accepted", "reason": "意図した改行"}], "visual_issues": []}))
    assert main(["--root", str(ws.root), "audit", "review", "talk", report["audit_id"], "--file", str(path)]) == 0
    assert json.loads(capsys.readouterr().out)["complete"]


def test_real_audit_via_sandbox_bridge(ws, monkeypatch, capsys):
    from e2e.conftest import DECK, ServerThread
    add_deck(ws, "talk", DECK.replace("二番目の段落。", '::: {data-step="1"}\n二番目の段落。\n:::'))
    server = ServerThread(ws)
    try:
        monkeypatch.setenv("SLIDE_STUDIO_SANDBOX", "1")
        assert main(["--root", str(ws.root), "audit", "run", "talk"]) == 1
        report = json.loads(capsys.readouterr().out)
        assert report["states"] and all(x["image_sha256"] for x in report["states"])
        assert not report["complete"] and report["status"] != "stale"
        assert len({x["id"] for x in report["states"]}) == len(report["states"])
        assert {x["step"] for x in report["states"] if x["page"] == "one"} == {1, 2}
        assert not list((ws.state / "requests").glob("*"))
    finally:
        server.stop()
