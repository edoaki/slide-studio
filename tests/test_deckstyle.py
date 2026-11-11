"""余白の書き方（設計書 §10.4）：発表の CSS の変数、図の pad=、段落の包み、ページの外側の余白。"""
import pytest
from bs4 import BeautifulSoup
from starlette.testclient import TestClient

from slide_studio import deckstyle, render
from slide_studio.server import build_app
from conftest import add_deck


def test_set_vars_keeps_other_rules_and_removes_empty_block():
    css = "/* この発表だけの調整（任意） */\n.reveal .cover{color:red}\n"
    out = deckstyle.set_vars(css, {"--img-pad": "20px", "--fig-pad": "8px 0px"})
    assert out.startswith(css)
    assert deckstyle.read_vars(out) == {"--img-pad": "20px", "--fig-pad": "8px 0px"}
    out2 = deckstyle.set_vars(out, {"--img-pad": "16px", "--fig-pad": None})
    assert deckstyle.read_vars(out2) == {"--img-pad": "16px"}
    assert out2.count(deckstyle.MARK) == 1
    assert deckstyle.set_vars(out2, {"--img-pad": None}) == css


@pytest.mark.parametrize("values", [{"--color": "1px"}, {"--text-pad": "12px"}, {"--fig-pad": "1em"}, {"--gutter": "1px; color:red"}])
def test_set_vars_rejects_other_names_and_values(values):
    with pytest.raises(ValueError):
        deckstyle.set_vars("", values)


def test_padding_markup_renders(ws):
    text = '''---
title: "t"
topic: test
---

## A {#a}

::: {style="padding:8px 20px"}
包んだ段落。
:::

![画像](images/a.svg){width=100 style="padding:4px"}

{{< fig test/box height=200 pad="6 0" >}}
'''
    add_deck(ws, "talk", text)
    (ws.asset_root("talk") / "images/a.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
    soup = BeautifulSoup(render.render_text(ws, "talk", text).html, "html.parser")
    section = soup.select_one("section#a")
    wrap = section.select_one('div[style="padding:8px 20px"]')
    assert wrap.select_one("p").get_text() == "包んだ段落。"
    assert "padding:4px" in section.select_one("img")["style"]
    assert section.select_one(".animation")["style"] == "height:200px;padding:6px 0px"


def test_style_endpoint_writes_deck_css(ws):
    add_deck(ws, "talk", "## A {#a}\n\n本文。\n")
    with TestClient(build_app(ws)) as client:
        r = client.put("/api/deck/talk/style", json={"vars": {"--fig-pad": "18px"}})
        assert r.status_code == 200 and r.json()["vars"] == {"--fig-pad": "18px"}
        assert "--fig-pad:18px" in (ws.deck_dir("talk") / "styles/slides.css").read_text()
        assert client.put("/api/deck/talk/style", json={"vars": {"--fig-pad": "x"}}).status_code == 400
        r = client.post("/api/deck/talk/chunks", json={"action": "markdown", "html": '<p class="slide-studio-new" contenteditable="true">新しい<strong>段落</strong></p>'})
        assert r.json()["markdown"] == "新しい**段落**"


def test_outer_spacing_figure_argument_survives_smart_punctuation(ws):
    text = '## A\n\n{{< fig test/box height=200 pad="6 0" space="0 0 42 0" style="border:2px solid red" >}}\n'
    add_deck(ws, 'talk', text)
    soup = BeautifulSoup(render.render_text(ws, 'talk', text).html, 'html.parser')
    style = soup.select_one('.animation')['style']
    assert '--block-space:0px 0px 42px 0px' in style
    assert 'padding:6px 0px' in style and 'border:2px solid red' in style
