from bs4 import BeautifulSoup
import pytest

from slide_studio import render, source, check
from conftest import add_deck


@pytest.mark.parametrize("wrap", [True, False])
def test_toc_and_explicit_refs(ws, wrap):
    text = """---
title: Test
topic: test
theme: default
---
## 表紙 {#cover .cover}

本文

::: {#toc}
:::

# 背景 {#background}

## 内容 {#content}

引用 [@alpha]

# 結論 {#conclusion}

::: {#refs}
:::

# Appendix {#appendix}

# 補足 {#extra}
"""
    add_deck(ws, "generated", text, bib="@misc{alpha, title={Alpha}, year={2020}}")
    result = render.render_text(ws, "generated", text, wrap=wrap)
    soup = BeautifulSoup(result.html, "html.parser")
    assert [s["id"] for s in result.slides] == ["cover", "toc", "background", "content", "conclusion", "references", "appendix", "extra"]
    assert [e.get_text() for e in soup.select(".toc-label")] == ["背景", "結論"]
    assert "section-slide" not in soup.select_one("#toc")["class"]
    assert len(soup.select(".references-slide .csl-entry")) == 1
    assert "Alpha" in soup.select_one("#content footer").get_text()
    assert not [e for e in check.static_issues(ws, "generated", result) if e["level"] == "error"]
    without = text.replace("::: {#refs}\n:::\n", "")
    soup = BeautifulSoup(render.render_text(ws, "generated", without).html, "html.parser")
    assert not soup.select(".references-slide")
    assert "Alpha" in soup.select_one("#content footer").get_text()


def test_refs_pagination_and_empty(ws):
    bib = "\n".join(f"@misc{{k{i}, title={{Title {i}}}, year={{2020}}}}" for i in range(7))
    text = "## 本文 {#body}\n\n" + " ".join(f"[@k{i}]" for i in range(7)) + "\n\n::: {#refs}\n:::\n"
    add_deck(ws, "refs", text, bib=bib)
    soup = BeautifulSoup(render.render_deck(ws, "refs").html, "html.parser")
    assert [len(s.select(".csl-entry")) for s in soup.select(".references-slide")] == [7]
    empty = "::: {#refs}\n:::\n"
    soup = BeautifulSoup(render.render_text(ws, "refs", empty).html, "html.parser")
    assert soup.select_one(".slide-studio-no-refs").get_text() == "引用なし"


def test_citation_footer_shows_venue(ws):
    bib = """@inproceedings{conf, author={Kool, W.}, title={Conf paper}, booktitle={International Conference on Learning Representations ({ICLR} 2019)}, year={2019}}
@article{jour, author={Lin, S.}, title={Journal paper}, journal={Operations Research}, year={1973}}
@misc{pre, author={Wu, X.}, title={Preprint}, year={2025}, eprint={2406.00415}, archiveprefix={arXiv}}
@inproceedings{both, author={Wu, X.}, title={Accepted}, booktitle={NeurIPS}, year={2025}, eprint={2406.00416}, archiveprefix={arXiv}}
"""
    deck = add_deck(ws, "venue", "---\ntitle: T\ntopic: test\ntheme: default\nlang: ja\n---\n\n## 本文 {#body}\n\n[@conf; @jour; @pre; @both]\n", bib=bib)
    bib_path = ws.bib("venue")
    before = bib_path.read_text()
    soup = BeautifulSoup(render.render_deck(ws, "venue").html, "html.parser")
    lines = [p.get_text() for p in soup.select("footer.citations p")]
    assert "International Conference on Learning Representations (ICLR 2019). 2019." in lines[0]
    assert lines[0].startswith("[1] W. Kool. ")
    assert "Operations Research. 1973." in lines[1]
    assert "arXiv:2406.00415. 2025." in lines[2]
    assert "NeurIPS. 2025." in lines[3] and "arXiv" not in lines[3]
    assert bib_path.read_text() == before and deck.is_dir()


def test_markers_in_code_and_nested_div_are_not_pages():
    text = "## 本文 {#body}\n\n```markdown\n::: {#toc}\n:::\n```\n\n:::: {.box}\n::: {#refs}\n:::\n::::\n"
    doc = source.parse(text)
    assert len(doc.pages) == 1
    assert not doc.pages[0].generated


def test_heading_before_marker_and_toc_fallback(ws):
    text = "## 目次 {#toc}\n\n::: {#toc}\n:::\n\n## 内容 {#content}\n\n本文\n\n## 参考文献 {#references}\n\n::: {#refs}\n:::\n"
    add_deck(ws, "headed", text)
    result = render.render_deck(ws, "headed")
    assert len(result.slides) == 3
    soup = BeautifulSoup(result.html, "html.parser")
    assert [e.get_text() for e in soup.select(".toc-label")] == ["内容"]


def test_legacy_heading_generates_references(ws):
    add_deck(ws, "legacy", "## 本文 {#body}\n\n引用 [@alpha]\n\n## 参考文献 {#references}\n",
             bib="@misc{alpha, title={Alpha}, year={2020}}")
    result = render.render_deck(ws, "legacy")
    assert [s["id"] for s in result.slides] == ["body", "references"]
    assert "Alpha" in BeautifulSoup(result.html, "html.parser").select_one(".references-slide").get_text()


@pytest.mark.parametrize('heading', ['', '## 目次 {#toc}\n\n'])
def test_toc_layout_and_disabled_page_keep_source_mapping(ws, heading):
    text = '## 表紙 {.cover}\n\n表紙\n\n' + heading + '::: {#toc .toc-columns}\n:::\n\n# A {#a}\n\n# B {#b}\n'
    add_deck(ws, 'toc-options', text)
    result = render.render_deck(ws, 'toc-options')
    soup = BeautifulSoup(result.html, 'html.parser')
    assert soup.select_one('section.toc-slide.toc-columns')
    assert [e.get_text() for e in soup.select('.toc-label')] == ['A', 'B']
    off = text.replace('#toc .toc-columns', '#toc .toc-columns .toc-off')
    result = render.render_text(ws, 'toc-options', off)
    soup = BeautifulSoup(result.html, 'html.parser')
    assert not soup.select('section.toc-slide')
    assert soup.select_one('section#a')['data-page'] == '2'
    assert soup.select_one('section#b')['data-page'] == '3'


def test_paginated_references_check_and_pdf(ws):
    from slide_studio import export
    from pypdf import PdfReader

    text = '---\ntitle: References\ntopic: test\ntheme: default\nnocite: "@*"\n---\n\n## 参考文献 {#references}\n\n# APPENDIX {#appendix}\n'
    bib = '\n'.join(f'@misc{{k{i}, title={{Reference title {i}}}, year={{2020}}}}' for i in range(15))
    add_deck(ws, 'refs-export', text, bib=bib)
    result = check.check_deck(ws, 'refs-export')
    assert not result['errors']
    refs = [s for s in result['slides'] if s['page'] == 0]
    assert len(refs) > 1
    assert result['slides'][-1]['id'] == 'appendix'
    _, pdf = export.build(ws, 'refs-export', result=result)
    assert len(PdfReader(pdf).pages) == len(result['slides'])
