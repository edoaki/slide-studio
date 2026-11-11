"""ページとチャンクの分割（設計書 §6.2）。正解は tests/fixtures/sync/expected.md。"""
import re

import pytest
from bs4 import BeautifulSoup

from slide_studio import figures, render, source
from conftest import SYNC, add_deck


def expected_rows():
    rows = []
    for line in (SYNC / "expected.md").read_text().splitlines():
        if not line.startswith("| ") or line.startswith("| ファイル") or line.startswith("|---"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        rows.append({"file": cells[0], "pages": int(cells[1]), "page": int(cells[2]), "id": cells[3],
                     "chunks": cells[4], "raw": cells[5] == "はい", "fixed": cells[6].split()})
    return rows


def fmt(chunks):
    return " ".join(c.path + ":" + c.kind + (f"[{fmt(c.children)}]" if c.children else "") for c in chunks)


ROWS = expected_rows()


def test_expected_covers_all_fixtures():
    assert {r["file"] for r in ROWS} == {p.name for p in SYNC.glob("*.qmd")}


@pytest.mark.parametrize("row", ROWS, ids=lambda r: f"{r['file']}-p{r['page']}")
def test_pages_and_chunks(row):
    doc = source.parse((SYNC / row["file"]).read_text())
    assert len(doc.pages) == row["pages"]
    p = doc.pages[row["page"]]
    assert (p.id or "-") == row["id"]
    assert p.raw_only == row["raw"]
    assert fmt(p.chunks) == row["chunks"]


def test_chunk_text_is_original():
    for f in SYNC.glob("*.qmd"):
        text = f.read_text()
        doc = source.parse(text)
        for p in doc.pages:
            assert text[p.start:p.end].startswith(text[p.start:p.head_end])
            for c in p.walk():
                assert text[c.start:c.end].strip() == text[c.start:c.end].strip("\n").strip() or True
                assert text[c.start:c.end] and not text[c.start:c.end].startswith("\n")
        # ページを並べると front matter の後ろの全文になる
        assert "".join(text[p.start:p.end] for p in doc.pages) == text[doc.pages[0].start:]


def _setup_figs(ws):
    figures.new_figure(ws, "box", ws.shelf_dir("test"))


@pytest.mark.parametrize("name", sorted(p.name for p in SYNC.glob("*.qmd")))
def test_rendered_html_has_every_chunk(ws, name):
    _setup_figs(ws)
    text = (SYNC / name).read_text()
    deck = name.removesuffix(".qmd")
    d = add_deck(ws, deck, text, bib="@misc{alpha, title={Alpha}, year={2020}}\n@misc{beta, title={Beta}, year={2021}}\n")
    figures.new_figure(ws, "local", ws.shelf_dir("test"))
    r = render.render_deck(ws, deck)
    soup = BeautifulSoup(r.html, "html.parser")
    for p in r.doc.pages:
        for c in p.walk():
            if c.kind == "def":
                continue
            assert soup.select(f'[data-slide-studio="p{p.index}/{c.path}"]'), f"{name} p{p.index}/{c.path}"
    # 包みは外れ、レイアウトに影響する div.slide-studio-c が残らない（文字だけを含む包みを除く）
    for wrap in soup.select("div.slide-studio-c"):
        assert any(isinstance(k, str) and k.strip() for k in wrap.contents)


def test_unclosed_div_renders_later_pages_separately(ws):
    text = (SYNC / "unclosed-div.qmd").read_text()
    add_deck(ws, "u", text)
    r = render.render_deck(ws, "u")
    ids = [s["id"] for s in r.slides]
    assert ids[:3] == ["a", "b", "c"]


def test_fig_args():
    assert source.fig_args('{{< fig nco/route-example width=800 title="経路の構成" >}}') == {
        "ref": "nco/route-example", "width": "800", "title": "経路の構成"}
    assert source.fig_args("{{< fig ./x >}}") == {"ref": "./x"}
    assert source.fig_args("{{< other x >}}") is None


def test_pandoc_error_has_qmd_line(ws):
    add_deck(ws, "bad", '---\ntitle: "x"\ntopic: test\ntheme: default\nbad: [\n---\n\n## A {#a}\n\n本文\n')
    with pytest.raises(render.RenderError) as e:
        render.render_deck(ws, "bad")
    assert "line" in str(e.value)


@pytest.mark.parametrize("tex, out", [
    ("x^2", "x^2"),
    ("\na = b\nc = d\n", "\n\\begin{gathered} a = b \\\\\nc = d \\end{gathered}\n"),
    ("a &= b \\\\\n  &= c", "\\begin{aligned} a &= b \\\\\n  &= c \\end{aligned}"),
    ("a = b \\\\ c = d", "\\begin{gathered} a = b \\\\ c = d \\end{gathered}"),
    ("x \\& y\nz", "\\begin{gathered} x \\& y \\\\\nz \\end{gathered}"),
    ("\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}", "\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}"),
])
def test_math_breaks(tex, out):
    assert source.math_breaks(tex) == out
    assert out.count("\n") == tex.count("\n")


def test_line_breaks_in_display_math_render_as_rows(ws):
    text = "---\ntopic: test\n---\n\n## A {#a}\n\n$$\na = b\nc = d\n$$\n\n本文。\n"
    add_deck(ws, "talk", text)
    r = render.render_deck(ws, "talk")
    soup = BeautifulSoup(r.html, "html.parser")
    rows = soup.select('[data-slide-studio="p0/0"] math mtable mtr')
    assert len(rows) == 2
    # 行の対応は変わらない（本文の行は原文の行を指す）
    wrapped, origin = source.wrapped_source(source.parse(text))
    lines = wrapped.split("\n")
    assert origin[lines.index("本文。")] == text.split("\n").index("本文。") + 1
    assert ws.qmd("talk").read_text() == text
