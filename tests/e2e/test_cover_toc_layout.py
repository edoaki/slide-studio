"""同梱テーマの表紙と目次：発表者は題名とそろい、スライドの中に収まり、目次の見出しは本文ページと同じ位置に出る。"""
import pytest
from conftest import add_deck, shared_browser

from slide_studio.httpd import StaticServer
from slide_studio.render import render_text
from slide_studio.workspace import TEMPLATES

THEMES = sorted(p.stem for p in (TEMPLATES / 'themes').glob('*.css') if not p.name.startswith('_'))

DECK = '''---
title: "題"
theme: {theme}
lang: ja
author:
  - name: "発表者"
    affiliations:
      - "所属"
---

## 題 {{#cover .cover}}

::: {{.cover-title}}
一行目の題名をここに書く\\
二行目の題名をここに書く
:::

::: {{.cover-subtitle}}
副題
:::

::: {{#toc}}
:::

# 章 {{#chapter}}

## 本文 {{#body}}

本文。
'''

MEASURE = '''() => {
  const stage = document.querySelector('#stage').getBoundingClientRect(), k = stage.width / 1280;
  const left = el => { const r = document.createRange(); r.selectNodeContents(el); return (r.getBoundingClientRect().left - stage.left) / k; };
  const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return { left: (r.left - stage.left) / k, top: (r.top - stage.top) / k }; };
  const authors = document.querySelector('.cover-authors');
  return {
    title: left(document.querySelector('.cover-title p')),
    author: left(authors.querySelector('p')),
    bottom: (authors.getBoundingClientRect().bottom - stage.top) / k,
    toc: box('#toc > h2'), page: box('#body > h2'),
  };
}'''


@pytest.mark.parametrize('theme', THEMES)
def test_cover_authors_and_toc_heading_follow_the_theme(ws, theme):
    text = DECK.format(theme=theme)
    add_deck(ws, 'talk', text)
    html = render_text(ws, 'talk', text).html
    srv = StaticServer(ws.root)
    srv.overrides['/decks/talk/sample.html'] = html.encode()
    context = shared_browser().new_context(viewport={'width': 1280, 'height': 720})
    try:
        page = context.new_page()
        page.goto(srv.url('/decks/talk/sample.html'))
        page.wait_for_function('window.deckReady === true')
        page.evaluate("document.body.classList.add('export')")
        got = page.evaluate(MEASURE)
    finally:
        context.close()
        srv.close()
    assert abs(got['author'] - got['title']) <= 1
    assert got['bottom'] <= 720
    assert got['toc'] == pytest.approx(got['page'], abs=1)
