"""単一 HTML 化。元：quarto-html scripts/slides.py の bundle()・module_inline()・css_inline()。

画像・CSS・JS・図（iframe → srcdoc）を内包する。図の import は次の2形式を内包する（設計書 §5.3）：
  import X from './x.mjs'（import {a} from … を含む）と import './x.mjs'
"""
from __future__ import annotations

import base64
import mimetypes
import re
from pathlib import Path

from bs4 import BeautifulSoup

from .workspace import StudioError

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")
# 文の先頭の静的な import / export … from だけを拾う（コメントや文字列の中の import は拾わない）
MODULE_SPEC = re.compile(r"""(?m)^(?P<pre>[ \t]*(?:import[ \t]*|(?:import|export)\b[^;'"()=]*?\bfrom[ \t]*))(?P<q>['"])(?P<spec>[^'"\n]+)(?P=q)""")


def data_uri(path: Path) -> str:
    kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{kind};base64," + base64.b64encode(path.read_bytes()).decode()


class Bundler:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.cache: dict[Path, str] = {}

    def local(self, base: Path, value: str) -> Path:
        if re.match(r"^(https?:|//)", value):
            raise StudioError(f"外部への参照はローカルに保存してください: {value}")
        path = (base / value.split("#")[0].split("?")[0]).resolve()
        if not path.is_relative_to(self.root):
            raise StudioError(f"置き場の外のファイルは使えません: {value}")
        if not path.is_file():
            raise StudioError(f"ファイルがありません: {path}")
        return path

    def css(self, css: str, base: Path) -> str:
        if "@import" in css:
            raise StudioError(f"CSS の @import は使わず、ローカルの CSS にまとめてください（{base}）")

        def replace(m):
            value = m[1].strip(" \"'")
            if value.startswith(("data:", "#")) or not value:
                return m[0]
            return 'url("' + data_uri(self.local(base, value)) + '")'
        return re.sub(r"url\(([^)]+)\)", replace, css)

    def module_source(self, code: str, base: Path, stack: tuple = ()) -> str:
        def replace(m):
            spec = m["spec"]
            if spec.startswith("data:"):
                return m[0]
            if not spec.startswith("."):
                raise StudioError(f"ローカルの相対パス以外の import は使えません: {spec}")
            dep = self.local(base, spec)
            inner = self.module(dep, stack)
            return m["pre"] + m["q"] + "data:text/javascript;base64," + base64.b64encode(inner.encode()).decode() + m["q"]
        return MODULE_SPEC.sub(replace, code)

    def module(self, path: Path, stack: tuple = ()) -> str:
        if path in stack:
            raise StudioError(f"import が循環しています: {path}")
        if path not in self.cache:
            self.cache[path] = self.module_source(path.read_text(), path.parent, (*stack, path))
        return self.cache[path]

    def soup(self, soup: BeautifulSoup, base: Path) -> None:
        for el in list(soup.select("script")):
            if el.get("src"):
                path = self.local(base, el["src"])
                el.string = self.module(path) if el.get("type") == "module" else path.read_text()
                del el["src"]
            elif el.get("type") == "module" and el.string:
                el.string = self.module_source(el.string, base)
        for el in list(soup.select('link[rel="stylesheet"]')):
            path = self.local(base, el["href"])
            style = soup.new_tag("style")
            for k in ("id",):
                if el.get(k):
                    style[k] = el[k]
            style.string = self.css(path.read_text(), path.parent)
            el.replace_with(style)
        for el in list(soup.select("img[src],source[src],video[src],audio[src]")):
            if not el["src"].startswith("data:"):
                el["src"] = data_uri(self.local(base, el["src"]))
        for el in list(soup.select("iframe[src]")):
            path = self.local(base, el["src"])
            child = BeautifulSoup(path.read_text(), "html.parser")
            self.soup(child, path.parent)
            el["srcdoc"] = str(child)
            del el["src"]
            el["tabindex"] = "-1"
        for style in soup.select("style"):
            style.string = self.css(style.string or "", base)
        for el in soup.select("[style]"):
            el["style"] = self.css(el["style"], base)
        if soup.select("[srcset]"):
            raise StudioError("srcset は使わず src にしてください")


def bundle_html(html: str, base: Path, root: Path) -> str:
    soup = BeautifulSoup(html, "html.parser")
    Bundler(root).soup(soup, base)
    return str(soup)
