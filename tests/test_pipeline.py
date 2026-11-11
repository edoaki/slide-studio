"""描画・検査・書き出し（作業手順書 手順 1 の受け入れ条件）。Playwright の Chromium を使う。"""
import json
import re
import shutil
import time
from pathlib import Path

import pytest
from bs4 import BeautifulSoup
from pypdf import PdfReader

from slide_studio import check, export, figures, httpd, render
from slide_studio.cli import main
from slide_studio.workspace import Workspace
from slide_studio.fsutil import write_atomic

from conftest import FIXTURES, SYNC, add_deck

FIGS = FIXTURES / "figs"


def deck_text(body: str, title: str = "テスト") -> str:
    return (f'---\ntitle: "{title}"\ntopic: test\ntheme: default\nlang: ja\n---\n\n'
            f"## {title} {{#cover .cover}}\n\n{body}\n\n## 参考文献 {{#references}}\n\n::: {{#refs}}\n:::\n\n# Appendix {{#appendix}}\n")


def make_font(path: Path):
    """幅の広い四角の字形を持つ小さな TrueType（SlideStudioTestFont、A・B・C）。"""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    fb = FontBuilder(1000, isTTF=True)
    names = [".notdef", "A", "B", "C"]
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({ord(c): c for c in "ABC"})
    glyphs = {}
    for n in names:
        pen = TTGlyphPen(None)
        if n != ".notdef":
            pen.moveTo((50, 0)); pen.lineTo((50, 700)); pen.lineTo((1450, 700)); pen.lineTo((1450, 0)); pen.closePath()
        glyphs[n] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (1500 if n != ".notdef" else 500, 50) for n in names})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "SlideStudioTestFont", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=800, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    fb.save(str(path))


@pytest.fixture
def figs_ws(ws):
    shutil.copytree(FIGS, ws.shelf_dir("test"))
    for d in ws.shelf_dir("test").iterdir():
        if d.is_dir() and d.name != "_lib":
            figures.write_index(d, ws)
    make_font(ws.shelf_dir("test") / "late-font" / "SlideStudioTestFont.ttf")
    return ws


# ---------------------------------------------------------------- nco-intro の取り込みと書き出し


def test_import_and_build_nco_intro(nco_ws):
    html, pdf = export.build(nco_ws, "nco-intro")
    assert html == nco_ws.deck_dir("nco-intro") / "機械学習を使った組み合わせ最適化.html" and html.exists()
    result = check.load(nco_ws, "nco-intro")
    assert not result["errors"]
    assert len(result["slides"]) == 20
    # 途中の step を指定していない原稿は、各ページの最後だけを PDF に載せる。
    assert len(PdfReader(pdf).pages) == len(result["slides"])
    # 単一 HTML は外部のファイルを参照しない
    soup = BeautifulSoup(html.read_text(), "html.parser")
    assert not soup.select("[src]:not([src^='data:'])")
    assert not soup.select("link[rel=stylesheet]")
    assert len(soup.select("iframe[srcdoc]")) == 10


def test_wrapping_does_not_change_slides(nco_ws, tmp_path):
    """.slide-studio-c で包んでも、包まない場合とスライドの画像が一致する（nco-intro の全ページの最後の step）。"""
    from playwright.sync_api import sync_playwright

    text = nco_ws.qmd("nco-intro").read_text()
    a = render.render_text(nco_ws, "nco-intro", text, wrap=True).html
    b = render.render_text(nco_ws, "nco-intro", text, wrap=False).html
    server = httpd.StaticServer(nco_ws.root)
    server.overrides["/decks/nco-intro/a.html"] = a.encode()
    server.overrides["/decks/nco-intro/b.html"] = b.encode()
    try:
        with sync_playwright() as p:
            br = p.chromium.launch()
            shots = {}
            for name in ("a", "b"):
                pg = br.new_page(viewport={"width": 1280, "height": 720})
                pg.add_init_script("window.__slideStudioNoHash=true")
                pg.goto(server.url(f"/decks/nco-intro/{name}.html"))
                pg.wait_for_function("window.deckReady===true")
                pg.evaluate("document.body.classList.add('export')")
                shots[name] = []
                for i in range(pg.evaluate("deck.count")):
                    pg.evaluate("(i)=>deck.go(i, Infinity)", i)
                    shots[name].append(pg.screenshot())
            br.close()
    finally:
        server.close()
    assert len(shots["a"]) == len(shots["b"])
    diff = [i + 1 for i, (x, y) in enumerate(zip(shots["a"], shots["b"])) if x != y]
    for i in diff:
        for name in ("a", "b"):
            (tmp_path / f"page-{i}-{name}.png").write_bytes(shots[name][i - 1])
    assert not diff, f"包みの有無で画像が違うページ: {diff}"


# ---------------------------------------------------------------- 構造


def test_zero_citations_has_no_automatic_references_or_appendix(ws):
    add_deck(ws, "plain", '---\ntitle: "x"\ntopic: test\ntheme: default\n---\n\n## 表紙 {#cover}\n\n本文。\n')
    r = render.render_deck(ws, "plain")
    ids = [s["id"] for s in r.slides]
    assert ids == ["cover"]
    soup = BeautifulSoup(r.html, "html.parser")
    assert soup.select_one("#references") is None
    assert soup.select_one("#appendix") is None


def test_new_deck_template_passes_check(ws):
    ws.new_deck("talk", "test")
    result = check.check_deck(ws, "talk")
    assert not result["errors"], result["errors"]
    assert [s["id"] for s in result["slides"]] == ["cover", "background-chapter", "question", "summary", "references"]


def test_overflow_fails_with_report_and_image(ws, capsys):
    long = "\n\n".join(f"とても長い本文の段落 {i}。" * 3 for i in range(14))
    add_deck(ws, "over", deck_text(long))
    code = main(["--root", str(ws.root), "check", "over"])
    assert code == 1
    result = json.loads((ws.build_dir("over") / "checks.json").read_text())
    kinds = {x["kind"] for x in result["errors"]}
    assert "overflow" in kinds
    img = next(x["image"] for x in result["errors"] if x["kind"] == "overflow")
    assert (ws.build_dir("over") / img).exists()
    # 直したら赤枠の画像は消える。無くなったページ・step の画像も残さない（AI が古い画像を見ないように）
    build = ws.build_dir("over")
    (build / "shots" / "p40-s0.png").write_bytes(b"old")
    (build / "shots" / "p01-s7.png").write_bytes(b"old")
    add_deck(ws, "over", deck_text("短い本文。"))
    result = check.check_deck(ws, "over")
    assert not [x for x in result["errors"] if x["kind"] == "overflow"]
    assert not (build / img).exists()
    assert not (build / "shots" / "p40-s0.png").exists() and not (build / "shots" / "p01-s7.png").exists()
    assert (build / "shots" / "p01-s0.png").exists()


def test_columns_stay_inside_side_margins(ws):
    # 右の列は折り返す長さにする（余白に入ったかは段落の箱ではなく文字で見るため）
    right = "右の本文。" * 12
    cols = f':::: {{.columns}}\n::: {{.column width="60%"}}\n左の本文。\n:::\n::: {{.column width="40%"}}\n{right}\n:::\n::::'
    d = add_deck(ws, "cols", deck_text(cols))
    result = check.check_deck(ws, "cols")
    assert not [x for x in result["warnings"] if x["kind"] == "margin"], result["warnings"]
    (d / "styles" / "slides.css").write_text("#stage .columns{margin-right:-40px}")
    result = check.check_deck(ws, "cols")
    assert any(x["kind"] == "margin" and "右の本文" in x["message"] for x in result["warnings"])


def test_overlap_with_footer_page_number_and_overflow(ws):
    # 段落を下へずらした各ページ。既定のテーマの引用フッター（1行）の文字は y 約 671〜687、ページ番号は右下。
    # 重なりは見える文字どうしで判定する（フッターの近く・下の余白に入るだけなら問題にしない）
    low = "::: {.low}\n低い段落\n:::"
    cases = {"clear": (650, 64, ""), "near": (612, 64, "引用 [@alpha]。"), "hit": (644, 64, "引用 [@alpha]。"),
             "pn": (672, 1150, ""), "out": (700, 64, "")}
    pages = "".join(f"## {k} {{#{k}}}\n\n{cite}\n\n{low}\n\n" for k, (_, _, cite) in cases.items())
    text = f'---\ntitle: "下"\ntopic: test\ntheme: default\n---\n\n{pages}## 参考文献 {{#references}}\n\n::: {{#refs}}\n:::\n\n# Appendix {{#appendix}}\n'
    d = add_deck(ws, "low", text, bib="@misc{alpha, title={Alpha}, year={2020}}\n")
    (d / "styles" / "slides.css").write_text("".join(
        f"#stage #{k} .low p{{position:absolute;left:{x}px;top:{y}px;margin:0}}" for k, (y, x, _) in cases.items()))
    result = check.check_deck(ws, "low")
    found = {}
    for x in result["errors"] + result["warnings"]:
        if "低い段落" in x["message"]:
            found.setdefault(x["page_id"], []).append((x["level"], x["kind"], re.sub(r"\d+px", "Npx", x["short"])))
    assert "clear" not in found and "near" not in found, found
    assert found["hit"] == [("error", "footer-overlap", "引用フッターと重なる")]
    assert ("error", "page-number", "ページ番号と重なる") in found["pn"]  # 右の余白の警告も出る
    assert found["out"] == [("error", "overflow", "スライドの下に Npx はみ出す")]
    hit = next(x for x in result["errors"] if x["page_id"] == "hit")
    assert hit["block"] == "p2/1" and hit["area"]["h"] > 0


def test_figure_column_fits_drawn_area(figs_ws):
    # 図は描いた範囲に切り詰めて端に 12px のバッファを残し、枠の角も 12px 丸める。
    # 図の列は「高さ × 縦横比」、本文の列は列の間を空けて残り全部
    ws = figs_ws
    cols = ':::: {.columns}\n::: {.column}\n{{< fig test/late-font height=150 >}}\n:::\n::: {.column}\n本文。\n:::\n::::'
    add_deck(ws, "fit", deck_text(cols))
    from playwright.sync_api import sync_playwright

    r = render.render_deck(ws, "fit")
    server = httpd.StaticServer(ws.root)
    server.overrides["/decks/fit/p.html"] = r.html.encode()
    try:
        with sync_playwright() as p:
            br = p.chromium.launch()
            pg = br.new_page(viewport={"width": 1280, "height": 720})
            pg.goto(server.url("/decks/fit/p.html"))
            pg.wait_for_function("window.deckReady===true")
            pg.evaluate("document.body.classList.add('export'); deck.go(0, 0)")  # 縮小せず 1280×720 で測る
            m = pg.evaluate("""() => {
              const a = document.querySelector('.animation'), [fig, text] = document.querySelectorAll('.column');
              const f = fig.getBoundingClientRect(), t = text.getBoundingClientRect();
              return {ratio: +a.style.getPropertyValue('--fig-ratio'), h: a.getBoundingClientRect().height, fw: f.width,
                      gap: t.left - f.right, tw: t.width,
                      vb: a.querySelector('iframe').contentDocument.querySelector('#stage svg').getAttribute('viewBox')}; }""")
            # 描いた文字と iframe の4辺の間（iframe の中の座標）と、枠の角の丸め
            edge = pg.evaluate("""() => {
              const f = document.querySelector('.animation iframe'), d = f.contentDocument;
              const r = d.querySelector('#stage svg text').getBoundingClientRect(), W = d.documentElement.clientWidth, H = d.documentElement.clientHeight;
              return {gaps: [r.left, r.top, W - r.right, H - r.bottom], radius: getComputedStyle(f).borderRadius}; }""")
            br.close()
    finally:
        server.close()
    _, _, w, h = map(float, m["vb"].split())
    assert w < 800 and h < 300 and abs(m["ratio"] - w / h) < 1e-6
    assert abs(m["h"] - 150) < .1 and abs(m["fw"] - m["h"] * m["ratio"]) < 1
    assert abs(m["gap"] - 22) < 1 and m["tw"] > 1280 - 104 - 22 - m["fw"] - 1
    assert all(abs(g - 12) < 1 for g in edge["gaps"]), edge
    assert edge["radius"] == "12px"


def test_figure_with_space_loads_once(figs_ws):
    # 外側余白の囲みに入れるときに iframe を動かしても読み直さない（中断された読み込みを「読み込めない素材」と誤って出さない）
    ws = figs_ws
    add_deck(ws, "sp", deck_text('{{< fig test/late-font height=150 space="0" >}}'))
    from playwright.sync_api import sync_playwright

    r = render.render_deck(ws, "sp")
    server = httpd.StaticServer(ws.root)
    server.overrides["/decks/sp/p.html"] = r.html.encode()
    try:
        with sync_playwright() as p:
            br = p.chromium.launch()
            pg = br.new_page(viewport={"width": 1280, "height": 720})
            loads = []
            pg.on("request", lambda q: q.url.endswith("/late-font/index.html") and loads.append(q.url))
            pg.goto(server.url("/decks/sp/p.html"))
            pg.wait_for_function("window.deckReady===true")
            wrapped = pg.evaluate("!!document.querySelector('.slide-studio-space .animation iframe')")
            br.close()
    finally:
        server.close()
    assert wrapped and len(loads) == 1, loads


def test_structure_errors(ws):
    add_deck(ws, "s", '---\ntitle: "x"\ntopic: test\ntheme: default\n---\n\n## A\n\n本文\n\n## B {#b}\n\n## C {#b}\n')
    r = render.render_deck(ws, "s")
    msgs = [x["message"] for x in check.static_issues(ws, "s", r)]
    assert any("ページ ID {#id} がありません" in m for m in msgs)
    assert any("重複" in m for m in msgs)
    assert not any("#references" in m for m in msgs)
    assert not any("#appendix" in m for m in msgs)


def test_missing_citation_is_error(ws):
    add_deck(ws, "c", deck_text("引用 [@nokey]。"))
    r = render.render_deck(ws, "c")
    assert r.missing_cites == ["nokey"]
    assert any(x["kind"] == "citation" for x in check.static_issues(ws, "c", r))


def test_footnote_small_stacks_with_citations(ws):
    # 手書きの注と引用はどちらも下端に出る。同じフッターに積み、重ねない
    body = "本文 [@alpha]。\n\n::: {.footnote-small}\n※ 注の文。\n:::\n\n後の本文。"
    add_deck(ws, "fn", deck_text(body), bib="@misc{alpha, title={Alpha}, year={2020}}\n")
    soup = BeautifulSoup(render.render_deck(ws, "fn").html, "html.parser")
    footer = soup.select_one("section.slide footer.citations")
    kids = [k for k in footer.children if getattr(k, "name", None)]
    assert "footnote-small" in kids[0]["class"] and kids[0].get("data-slide-studio")
    assert "Alpha" in kids[1].get_text()
    assert len(soup.select(".footnote-small")) == 1
    result = check.check_deck(ws, "fn")
    assert not [x for x in result["errors"] if x["kind"] == "footer-overlap"], result["errors"]


# ---------------------------------------------------------------- 図の import・フォント・禁止事項


def test_pdf_keeps_last_and_marked_steps(ws):
    """PDF には各ページの最後の step と、見出しの pdf="…" で選んだ step だけを載せる。演出の中間フレームは印刷しない。"""
    add_deck(ws, "steps", '''---
title: Steps
topic: test
theme: default
---
## Sequence {#sequence .cover pdf="2"}

BASE

{{< fig test/sequence step=2 >}}

::: {data-step="7"}
SUMMARY
:::

## Static {#static pdf="3"}

STATIC
''')
    fig = ws.shelf_dir("test") / "sequence"
    fig.mkdir(parents=True)
    write_atomic(fig / "figure.mjs", '''
const svg = text => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300"><text x="40" y="160" font-size="40">${text}</text></svg>`;
export default {
  id: 'sequence', steps: ['Before', 'After'],
  renderStep(k) { return svg(k === 0 ? 'BEFORE' : 'AFTER'); },
  transition() { return [{markup: svg('TRANSIENT'), duration: 5000}]; },
};
''')
    figures.write_index(fig, ws)
    html = export.bundle_deck(ws, "steps")
    pdf = html.with_suffix(".pdf")
    # 指定のない参考文献ページは補わない。step 0（BASE だけ）と step 3（AFTER）は印がないので載らない。
    assert export.pdf_from_html(html, pdf) == {"slides": 2, "pdf_pages": 3}
    texts = [p.extract_text() for p in PdfReader(pdf).pages]
    for text, expected in zip(texts, [{"BEFORE"}, {"AFTER", "SUMMARY"}, {"STATIC"}], strict=True):
        assert {word for word in ("BEFORE", "AFTER", "SUMMARY", "STATIC", "TRANSIENT") if word in text} == expected
    # 1 step しかないページの pdf="3" は範囲の外
    result = check.check_deck(ws, "steps")
    assert [x["message"] for x in result["warnings"] if x["kind"] == "pdf-step"] == ["PDF に入れる step 3 はありません（このページの step は 1 個）"]


def test_two_import_forms_and_late_font_offline(figs_ws):
    ws = figs_ws
    add_deck(ws, "figs", deck_text("{{< fig test/two-imports >}}\n\n## フォント {#font}\n\n{{< fig test/late-font >}}"))
    # 遅れて届くフォントでも、deck.go は図の中のフォントの読み込みを待つ
    httpd.DELAYS["/topics/test/html/late-font/SlideStudioTestFont.ttf"] = 1.5
    try:
        from playwright.sync_api import sync_playwright

        r = render.render_deck(ws, "figs")
        server = httpd.StaticServer(ws.root)
        server.overrides["/decks/figs/p.html"] = r.html.encode()
        try:
            with sync_playwright() as p:
                br = p.chromium.launch()
                pg = br.new_page(viewport={"width": 1280, "height": 720})
                pg.goto(server.url("/decks/figs/p.html"))
                pg.wait_for_function("window.deckReady===true")
                pg.evaluate("deck.go(1, 0)")
                frame = next(f for f in pg.frames if "late-font" in f.url)
                assert frame.evaluate("[...document.fonts].find(f=>f.family.includes('SlideStudioTestFont')).status") == "loaded"
                width = frame.evaluate("document.querySelector('text').getBBox().width")
                assert width > 250  # 3字 × 1.5em × 64px ≒ 288（代わりのフォントなら 120 前後）
                side = next(f for f in pg.frames if "two-imports" in f.url)
                assert "副作用の import" in side.evaluate("document.querySelector('text').textContent")
                br.close()
        finally:
            server.close()
        result = check.check_deck(ws, "figs")
        assert not result["errors"], result["errors"]
    finally:
        httpd.DELAYS.clear()
    html = export.bundle_deck(ws, "figs")
    pdf = html.with_suffix(".pdf")
    info = export.pdf_from_html(html, pdf)
    # 表紙の図（2 step）は最後の step だけが載る。2枚目がフォントのページ。
    assert info == {"slides": 4, "pdf_pages": 4}
    reader = PdfReader(pdf)
    fonts = set()
    page = reader.pages[1]

    def walk(res):
        for f in (res.get("/Font") or {}).values():
            fonts.add(str(f.get_object().get("/BaseFont")))
        for x in (res.get("/XObject") or {}).values():
            x = x.get_object()
            if x.get("/Resources"):
                walk(x["/Resources"].get_object())
    walk(page["/Resources"].get_object())
    # Chromium は Web フォントを OTS で検査し、PDF には OTS-derived-font の名前で埋め込む
    assert any("OTS-derived" in f or "SlideStudioTestFont" in f for f in fonts), fonts


@pytest.mark.parametrize("name,kind", [("uses-fetch", "figure-code"), ("uses-dynamic-import", "figure-code"), ("uses-svg-image", "svg-image")])
def test_forbidden_figure_features(figs_ws, name, kind):
    add_deck(figs_ws, "bad", deck_text(f"{{{{< fig test/{name} >}}}}"))
    result = check.check_deck(figs_ws, "bad")
    assert kind in {x["kind"] for x in result["errors"]}, result["errors"]


def test_missing_figure_and_image(ws):
    add_deck(ws, "m", deck_text("{{< fig test/nothing >}}\n\n![写真](images/none.png)"))
    result = check.check_deck(ws, "m")
    msgs = " ".join(x["message"] for x in result["errors"])
    assert "図がありません" in msgs and "画像がありません" in msgs
    image_errors = [x for x in result["errors"] if "none.png" in x["message"]]
    assert len(image_errors) == 1
    assert image_errors[0]["page_id"] == "cover"


def test_missing_html_image_still_reports_network_error(ws):
    add_deck(ws, "m", deck_text('![写真](images/none.png)\n\n<img src="other.png">'))
    result = check.check_deck(ws, "m")
    errors = result["errors"]
    assert len([x for x in errors if "none.png" in x["message"]]) == 1
    assert any("other.png" in x["message"] and x.get("detection") == "network" for x in errors)


# ---------------------------------------------------------------- 数式


def test_math_in_preview_bundle_and_pdf(ws):
    text = (SYNC / "math.qmd").read_text().replace("topic: test", "topic: test")
    text += "\n## 参考文献 {#references}\n\n# Appendix {#appendix}\n"
    add_deck(ws, "math", text)
    result = check.check_deck(ws, "math")
    assert not result["errors"], result["errors"]
    r = render.render_deck(ws, "math")
    soup = BeautifulSoup(r.html, "html.parser")
    assert soup.select("math mfrac") and soup.select("math mtable")
    html = export.bundle_deck(ws, "math")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        br = p.chromium.launch()
        pg = br.new_page(viewport={"width": 1280, "height": 720})
        pg.goto(html.as_uri())
        pg.wait_for_function("window.deckReady===true")
        sizes = pg.evaluate("[...document.querySelectorAll('.slide.active math')].map(m=>m.getBoundingClientRect().height)")
        assert len(sizes) == 3 and all(h > 10 for h in sizes), sizes
        # 行列（2行）と複数行の式は、1行の高さより高い
        assert sorted(sizes)[-1] > 50
        br.close()
    pdf = html.with_suffix(".pdf")
    export.pdf_from_html(html, pdf)
    page_text = PdfReader(pdf).pages[0].extract_text()
    # MathML は数学用の斜体の文字（𝑓 など）で出る：分数・行列・複数行の式
    for token in ("𝑎𝑏", "( 1 2", "3 4 )", "𝑓(𝑥) = 𝑥2 + 1", "𝑔(𝑥) = 1𝑥"):
        assert token in page_text, page_text


# ---------------------------------------------------------------- 速さ（§7.2）


def test_render_speed_30_pages(ws):
    pages = []
    for i in range(30):
        pages.append(f"## ページ {i} {{#p{i}}}\n\n本文の段落 {i}。**強調** と [@alpha]。\n\n- 項目 a\n- 項目 b\n\n| 列1 | 列2 |\n|---|---|\n| 1 | 2 |\n")
    text = '---\ntitle: "速さ"\ntopic: test\ntheme: default\n---\n\n' + "\n".join(pages) + "\n## 参考文献 {#references}\n\n# Appendix {#appendix}\n"
    add_deck(ws, "speed", text, bib="@misc{alpha, title={Alpha}, year={2020}}\n")
    render.render_deck(ws, "speed")
    times = []
    for _ in range(3):
        t = time.perf_counter()
        render.render_deck(ws, "speed")
        times.append((time.perf_counter() - t) * 1000)
    print(f"30ページの変換とページ組み立て: {min(times):.0f}ms（3回の最小）")
    assert min(times) < 500


def test_theme_must_define_colors(ws):
    """テーマは決まった色の組を必ず持つ（設計書 §5.6）。足りなければ検査のエラー。"""
    add_deck(ws, "t", deck_text("本文。"))
    r = render.render_deck(ws, "t")
    assert not [x for x in check.static_issues(ws, "t", r) if x["kind"] == "theme"]
    css = ws.themes / "default.css"
    css.write_text(css.read_text().replace("--warn:", "--warning:").replace("--mark-ink:", "--marker-ink:"))
    msgs = [x["message"] for x in check.static_issues(ws, "t", r) if x["kind"] == "theme"]
    assert msgs and "--warn" in msgs[0] and "--mark-ink" in msgs[0] and "--mark," not in msgs[0]


def test_old_default_theme_is_upgraded(ws, tmp_path):
    """手を入れていない前の版の default.css は今の版に置き換え、手を入れたものは残す。"""
    import hashlib
    from slide_studio import workspace
    css = ws.themes / "default.css"
    old = "/* 前の版 */\n"
    css.write_text(old)
    workspace.OLD_DEFAULT_THEMES.add(hashlib.sha256(old.encode()).hexdigest())
    try:
        ws.ensure()
        assert "--mark-line" in css.read_text()
        css.write_text("/* 自分で直したテーマ */\n")
        ws.ensure()
        assert css.read_text() == "/* 自分で直したテーマ */\n"
    finally:
        workspace.OLD_DEFAULT_THEMES.discard(hashlib.sha256(old.encode()).hexdigest())


def test_chapter_number_is_shown_outside_the_title_text(ws):
    add_deck(ws, "numbered", deck_text("本文。\n\n# 背景 {#background-chapter}\n\n## 中身 {#inside}\n\n本文。"))
    rendered = render.render_deck(ws, "numbered")
    html = BeautifulSoup(rendered.html, "html.parser")
    assert html.select_one("#background-chapter h1 .chapter-number")["data-chapter"] == "01"
    assert html.select_one("#background-chapter h1").get_text(strip=True) == "背景"
    assert not html.select("#appendix .chapter-number")


def test_explicit_appendix_is_preserved_and_can_be_removed(ws):
    text = deck_text("本文。") + "\n## 補足 {#extra}\n\n補足の説明。\n"
    add_deck(ws, "optional", text)
    rendered = render.render_deck(ws, "optional")
    assert [s["id"] for s in rendered.slides][-3:] == ["references", "appendix", "extra"]
    assert "section-slide" in BeautifulSoup(rendered.html, "html.parser").select_one("#appendix")["class"]
    without = text.split("# Appendix {#appendix}")[0]
    write_atomic(ws.qmd("optional"), without)
    rendered = render.render_deck(ws, "optional")
    assert [s["id"] for s in rendered.slides][-1] == "references"
    assert not [i for i in check.static_issues(ws, "optional", rendered) if i["level"] == "error"]


def test_check_progress_includes_each_step(ws):
    add_deck(ws, "progress", '---\ntitle: Progress\ntopic: test\ntheme: default\n---\n\n## First {#first}\n\n::: {.incremental}\n- A\n- B\n:::\n\n## Second {#second}\n\nText.\n')
    values = []
    result = check.check_deck(ws, "progress", progress=values.append)
    assert len(values) == sum(slide["steps"] for slide in result["slides"])
    assert len(values) > len(result["slides"])
    assert 0 < values[0] < 100
    assert values == sorted(values)
    assert values[-1] == 100
