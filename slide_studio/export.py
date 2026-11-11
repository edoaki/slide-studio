"""書き出し：単一 HTML（オフラインで動く）と、各ページの最後の step（と印を付けた step）を並べた PDF。

書き出し先は decks/<名前>/<発表タイトル>.html と .pdf。元：quarto-html scripts/slides.py の verify(export=True)。
"""
from __future__ import annotations

import io
import re
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from pypdf import PdfReader, PdfWriter

from . import check
from .bundle import bundle_html
from .fsutil import write_atomic
from .render import render_deck
from .workspace import StudioError, Workspace


def output_path(ws: Workspace, deck: str, kind: str) -> Path:
    meta = ws.deck_meta(deck)
    title = str(meta.get("title") or meta.get("pagetitle") or deck)
    title = re.sub(r'\s+', ' ', title).strip()
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', '_', title).strip(' .')
    # 拡張子を含めても一般的なファイル名の長さ制限に収める。
    title = title.encode('utf-8')[:240].decode('utf-8', errors='ignore').rstrip(' .') or deck
    return ws.deck_dir(deck) / f"{title}.{kind}"


def bundle_deck(ws: Workspace, deck: str) -> Path:
    rendered = render_deck(ws, deck)
    html = bundle_html(rendered.html, ws.deck_dir(deck), ws.root)
    out = output_path(ws, deck, "html")
    write_atomic(out, html)
    return out


def pdf_from_html(html_path: Path, pdf_path: Path, browser: check.Browser | None = None,
                  *, progress: Callable[[int], None] | None = None) -> dict:
    """単一 HTML をオフラインで確認し、各ページの最後の step と、見出しの pdf="…" で選んだ step を PDF にする。"""
    errors: list[str] = []
    requests: list[str] = []
    with tempfile.TemporaryDirectory(prefix="slide-studio-portable-") as tmp, check._browser(browser) as b:
        standalone = Path(tmp).resolve() / html_path.name
        shutil.copy2(html_path, standalone)
        ctx = b.browser.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=1, offline=True)

        local = standalone.parent.as_uri()

        def route(r):
            url = r.request.url
            if url.startswith(("data:", "about:", "blob:")) or url.startswith(local):
                r.continue_()
            else:
                requests.append(r.request.url)
                r.abort()
        ctx.route("**/*", route)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"JS のエラー: {e}"))
        page.add_init_script("window.__slideStudioNoHash = true;")
        page.goto(standalone.as_uri())
        page.wait_for_function("window.deckReady === true", timeout=30000)
        page.evaluate("document.body.classList.add('export')")
        broken = page.evaluate("""() => [...document.querySelectorAll('iframe')].filter(f=>{try{return !f.contentWindow.animation}catch{return true}}).map(f=>f.title)""")
        errors += [f"単一 HTML で図が動かない: {t}" for t in broken]
        count = page.evaluate("deck.count")
        writer = PdfWriter()
        expected_pages = 0
        for i in range(count):
            # 図の読み込みを待ってから step 数を取得する。
            page.evaluate("(i)=>deck.go(i, 0, false)", i)
            steps = page.evaluate("(i)=>deck.pdfSteps(i)", i)
            expected_pages += len(steps)
            for n, step in enumerate(steps):
                # 遷移中のフレームは含めず、図・フォント・画像の確定を待つ。
                page.evaluate("([i, step])=>deck.go(i, step, false)", [i, step])
                # 文字は画像化せず、文字のまま残す。
                pdf = page.pdf(width="1280px", height="720px", print_background=True, page_ranges="1")
                writer.append(PdfReader(io.BytesIO(pdf)))
                if progress:
                    progress(round(60 + 35 * (i + (n + 1) / len(steps)) / count))
        ctx.close()
    if errors or requests:
        raise StudioError("単一 HTML の確認に失敗しました:\n" + "\n".join(errors + [f"外部への通信: {u}" for u in requests]))
    buf = io.BytesIO()
    writer.write(buf)
    write_atomic(pdf_path, buf.getvalue())
    pages = len(PdfReader(pdf_path).pages)
    if pages != expected_pages:
        raise StudioError(f"PDF のページ数が載せる step の数と合いません（PDF {pages}・step {expected_pages}）")
    return {"slides": count, "pdf_pages": pages}


def build(ws: Workspace, deck: str, force: bool = False, *, browser: check.Browser | None = None,
          result: dict | None = None, format: str | None = None,
          progress: Callable[[int], None] | None = None) -> list[Path]:
    if format not in (None, "html", "pdf"):
        raise StudioError("書き出し形式が正しくありません")
    report = progress or (lambda value: None)
    ws.require_deck(deck)
    with check._browser(browser) as b:
        result = result if result is not None else check.check_deck(ws, deck, browser=b)
        if result["errors"] and not force:
            raise StudioError("検査にエラーがあります。問題を修正してから書き出してください。\n" + check.summary(result))
        report(45)
        html = bundle_deck(ws, deck)
        report(60)
        paths = [html]
        if format != "html":
            pdf = html.with_suffix(".pdf")
            pdf_from_html(html, pdf, browser=b, **({"progress": progress} if progress else {}))
            paths = [pdf] if format == "pdf" else [html, pdf]
    report(100)
    return paths
