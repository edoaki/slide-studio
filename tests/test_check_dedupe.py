"""検査の問題の数え方：step ごとに見つかった同じ問題は1件にまとめる。"""
from slide_studio import check


def _x(step, message="引用フッターと重なる: 本文", kind="footer-overlap", slide=2, **extra):
    return {"level": "error", "kind": kind, "message": message, "slide": slide, "step": step,
            "image": f"issues/p03-s{step}.png", **extra}


def test_same_issue_on_every_step_counts_once():
    out = check._dedupe([_x(s) for s in range(4)])
    assert len(out) == 1
    assert out[0]["step"] == 0 and out[0]["steps"] == [0, 1, 2, 3]
    assert check.step_label(out[0]) == "step 1〜4"


def test_overflow_keeps_worst_step():
    xs = [_x(s, f"スライドの下に {n}px はみ出す: 図", kind="overflow", amount=n) for s, n in [(0, 10), (1, 30), (2, 20)]]
    [x] = check._dedupe(xs)
    assert x["step"] == 1 and x["amount"] == 30 and x["steps"] == [0, 1, 2]


def test_different_slides_or_issues_stay_separate():
    out = check._dedupe([_x(0), _x(0, slide=3), _x(0, message="引用フッターと重なる: 別の本文")])
    assert len(out) == 3
    assert all("steps" not in x for x in out)
    assert check.step_label(out[0]) == "step 1"


def test_step_label_gaps():
    assert check.step_label({"steps": [0, 1, 2, 4]}) == "step 1〜3・5"
    assert check.step_label({"step": None}) == ""


def test_partial_check_merges_with_previous_steps():
    first = check._dedupe([_x(0), _x(1)])
    again = check._dedupe(first + [_x(2)])
    assert len(again) == 1 and again[0]["steps"] == [0, 1, 2]


def test_missing_image_prefers_source_locations_over_network_error():
    resource = "/topics/test/images/none.png"
    sources = [_x(None, kind="missing", message="画像がありません: images/none.png",
                  slide=s, resource=resource, detection="source") for s in (1, 3)]
    network = _x(None, kind="missing", message="読み込めない素材（404）", slide=None,
                 resource=resource, detection="network")
    other = {**network, "resource": "/topics/other/images/none.png"}
    assert check._dedupe([network, *sources, other]) == [*sources, other]
    assert check._dedupe([network]) == [network]


def test_resource_path_normalizes_browser_url():
    assert check._resource_path("http://localhost:8000/topics/test/images/%E5%9B%B3.png?v=1") == "/topics/test/images/図.png"
