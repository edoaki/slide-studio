"""検査。設計書 §9。

各ページの各 step の静止状態を、deck.go(i, s) の Promise（図の settled・フォント・画像）を待ってから測る。
固定の待ち時間は使わない。結果は .slide-studio/build/<deck>/checks.json と、問題箇所に赤枠を付けた issues/pXX-sY.png。
"""
from __future__ import annotations

import json
import posixpath
import re
import time
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

from . import figures as figs
from . import source
from .page_templates import placeholder_blocks
from .fsutil import sha256_bytes, write_atomic
from .httpd import StaticServer
from .render import Rendered, RenderError, render_deck, warning_issues
from .workspace import THEME_VARIABLES, StudioError, Workspace, theme_variables

SETTLE_TIMEOUT_MS = 5000
PREVIEW_NAME = "__slide-studio_check__.html"
# レイアウトの判定は編集画面と同じファイル（web/inject/layout-check.js）。行頭の export を外して関数の中に入れる
LAYOUT_JS = Path(__file__).parent / "web" / "inject" / "layout-check.js"
LAYOUT = "(opt) => {\n" + re.sub(r"^export ", "", LAYOUT_JS.read_text(), flags=re.M) + "\nreturn layoutIssues(opt);\n}"

OVERLAY = r"""(boxes) => {
document.getElementById('slide-studio-issue-overlay')?.remove();
if(!boxes)return;const o=document.createElement('div');o.id='slide-studio-issue-overlay';
o.style.cssText='position:fixed;left:0;top:0;width:1280px;height:720px;pointer-events:none;z-index:2147483647';
for(const b of boxes){const d=document.createElement('div');
 d.style.cssText=`position:absolute;left:${b.x-3}px;top:${b.y-3}px;width:${b.w+6}px;height:${b.h+6}px;border:3px solid ${b.level==='error'?'#e11d48':'#d97706'};border-radius:3px;box-shadow:0 0 0 2px #fff8`;
 o.append(d);}
document.body.append(o);}"""


def _issue(level: str, kind: str, message: str, **extra) -> dict:
    return {"level": level, "kind": kind, "message": message, **extra}


def _resource_path(url: str) -> str:
    return posixpath.normpath(unquote(urlsplit(url).path))


# ---------------------------------------------------------------- 版（§9.4）


def deck_files(ws: Workspace, deck: str, text: str | None = None) -> list[Path]:
    """発表の見た目が依存するファイル（qmd を除く）。"""
    folder = ws.deck_dir(deck)
    text = text if text is not None else ws.qmd(deck).read_text()
    doc = source.parse(text)
    files = [ws.bib(deck, doc.meta), ws.themes / f"{doc.meta.get('theme') or 'default'}.css"]
    images = ws.topic_dir(str(doc.meta["topic"])) / "images" if doc.meta.get("topic") else folder / "images"
    if images.exists():
        files += sorted(p for p in images.rglob("*") if p.is_file())
    styles = folder / "styles"
    if styles.exists():
        files += sorted(p for p in styles.rglob("*") if p.is_file())
    for ref in figs.fig_refs(text):
        try:
            d = ws.figure_dir(ref, deck)
        except StudioError:
            continue
        if d.exists():
            files += [p for p in sorted(d.rglob("*")) if p.is_file()]
            files += [p for p in figs.module_files(d) if not p.is_relative_to(d.resolve())]
    return files


def deck_version(ws: Workspace, deck: str, text: str | None = None) -> dict:
    text = text if text is not None else ws.qmd(deck).read_text()
    h = []
    for p in deck_files(ws, deck, text):
        try:
            h.append(f"{p}:{sha256_bytes(p.read_bytes())}")
        except OSError:
            h.append(f"{p}:missing")
    return {"qmd": sha256_bytes(text.encode()), "deps": sha256_bytes("\n".join(sorted(set(h))).encode())}


# ---------------------------------------------------------------- 原稿の検査（ブラウザなし）


def static_issues(ws: Workspace, deck: str, rendered: Rendered) -> list[dict]:
    doc = rendered.doc
    text = doc.text
    out: list[dict] = []
    for p, c in placeholder_blocks(doc):
        out.append(_issue("warning", "placeholder", f"p{p.index + 1} にひな形の仮の文字が残っています", page=p.index, block=f"p{p.index}/{c.path}"))
    folder = ws.deck_dir(deck)
    if not doc.front[1]:
        out.append(_issue("error", "structure", "front matter がありません（title・topic・theme）"))
    if doc.meta_error:
        out.append(_issue("error", "structure", doc.meta_error))
    for key in ("topic", "theme"):
        if doc.front[1] and not doc.meta.get(key):
            out.append(_issue("error", "structure", f"front matter に {key}: がありません"))
    theme = doc.meta.get("theme")
    if theme and not (ws.themes / f"{theme}.css").exists():
        out.append(_issue("error", "missing", f"テーマがありません: themes/{theme}.css"))
    elif theme:
        out.extend(check_theme(ws, theme)["errors"])
    ids: dict[str, int] = {}
    for p in doc.pages:
        label = f"p{p.index + 1}「{p.title}」"
        if not p.id:
            out.append(_issue("error", "structure", f"{label} にページ ID {{#id}} がありません", page=p.index))
        elif not source.PAGE_ID.match(p.id):
            out.append(_issue("error", "structure", f"{label} のページ ID は英小文字・数字・ハイフンにしてください: {p.id}", page=p.index))
        elif p.id in ids:
            out.append(_issue("error", "structure", f"ページ ID が重複しています: {p.id}（p{ids[p.id] + 1} と p{p.index + 1}）", page=p.index))
        else:
            ids[p.id] = p.index
    if doc.unclosed_at is not None:
        p = doc.page_of(doc.unclosed_at)
        where = f"p{p.index + 1}" if p else "最初のページより前"
        out.append(_issue("error", "structure", f"閉じていない囲み（::: か ```）があります（{where} から最後までは原文のみ）", page=p.index if p else None))
    if doc.preamble.strip():
        out.append(_issue("warning", "structure", "最初のページの見出しより前の本文は表示されません"))
    # 図と画像
    for p in doc.pages:
        body = text[p.head_end:p.end]
        for c in p.walk():
            if c.kind == "fig":
                args = source.fig_args(text[c.start:c.end])
                ref = args["ref"] if args else ""
                try:
                    d = ws.figure_dir(ref, deck)
                except StudioError as e:
                    out.append(_issue("error", "missing", str(e), page=p.index))
                    continue
                if not (d / "figure.mjs").exists() or not (d / "index.html").exists():
                    out.append(_issue("error", "missing", f"図がありません: {ref}（{d}）", page=p.index))
                    continue
                for mod in figs.module_files(d):
                    code = mod.read_text()
                    for m in figs.DYNAMIC.finditer(code):
                        what = "fetch" if "fetch" in m[0] else "動的 import"
                        out.append(_issue("error", "figure-code", f"図で {what} は使えません: {mod.relative_to(ws.root)}", page=p.index, figure=ref))
                    for spec in figs.imports(code):
                        if not (mod.parent / spec).resolve().exists():
                            out.append(_issue("error", "missing", f"図の部品がありません: {spec}（{mod.relative_to(ws.root)}）", page=p.index, figure=ref))
        for m in re.finditer(r"!\[[^\]]*\]\(([^)\s]+)", body):
            target = m[1]
            if re.match(r"^(https?:|//)", target):
                out.append(_issue("error", "external", f"外部の画像は使えません: {target}", page=p.index))
            elif not ((ws.topic_dir(str(doc.meta["topic"])) / target) if target.startswith("images/") and doc.meta.get("topic") else folder / target).exists():
                base = f"/topics/{doc.meta['topic']}/" if target.startswith("images/") and doc.meta.get("topic") else f"/decks/{deck}/"
                out.append(_issue("error", "missing", f"画像がありません: {target}", page=p.index,
                                  resource=_resource_path(urljoin(base, target)), detection="source"))
    for key in rendered.missing_cites:
        out.append(_issue("error", "citation", f"引用キーが reference.bib にありません: {key}", citation_key=key))
    for key in unverified_keys(ws.bib(deck, doc.meta)):
        if key in rendered.cited:
            out.append(_issue("warning", "unverified", f"未確認の文献: {key}（slide-studio-status = {{unverified}}）", citation_key=key))
    for u in rendered.unsupported:
        out.append(_issue("warning", "unsupported", u["message"], page=u["page"]))
    out.extend(warning_issues(rendered))
    return out


def unverified_keys(bib: Path) -> list[str]:
    from .bibliography import listing
    try:
        return [e["key"] for e in listing(bib) if e["unverified"]]
    except ValueError:
        return []  # BibTeX の構文エラーは描画時に報告する


# ---------------------------------------------------------------- ブラウザでの検査


class Browser:
    """Playwright の Chromium を1つ起動したまま使い回す（§9.4）。同じスレッドから使う。"""

    def __init__(self):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self.browser = self._pw.chromium.launch()

    def close(self):
        try:
            self.browser.close()
        finally:
            self._pw.stop()


@contextmanager
def _browser(existing: Browser | None):
    if existing:
        yield existing
        return
    b = Browser()
    try:
        yield b
    finally:
        b.close()


def _slide_name(i: int, s: int) -> str:
    return f"p{i + 1:02d}-s{s}"


def _drop_stale(out_dir: Path, written: dict[str, set[str]], checked: set[int], count: int) -> None:
    """調べたスライドの、今回撮らなかった画像（減った step・直った問題）と、無くなったページの画像を消す。
    AI と確認役は shots/・issues/ の画像を見るので、古いものを残さない。"""
    for sub, keep in written.items():
        for p in (out_dir / sub).glob("p*-s*.png"):
            try:
                i = int(p.stem[1:].split("-")[0]) - 1
            except ValueError:
                continue
            if p.stem not in keep and (i in checked or i >= count):
                p.unlink(missing_ok=True)


def browser_issues(ws: Workspace, deck: str, rendered: Rendered, slides: list[int] | None, out_dir: Path,
                   browser: Browser | None = None, shots: bool = True, audit: bool = False,
                   progress: Callable[[float], None] | None = None) -> tuple[list[dict], list[dict], list[str]]:
    """(問題, 各スライドの step 数, 外部への通信)"""
    server = StaticServer(ws.root)
    url_path = f"/decks/{deck}/{PREVIEW_NAME}"
    server.overrides[url_path] = rendered.html.encode()
    issues: list[dict] = []
    requests: list[str] = []
    info: list[dict] = []
    written = {"shots": set(), "issues": set()}
    (out_dir / "shots").mkdir(parents=True, exist_ok=True)
    (out_dir / "issues").mkdir(parents=True, exist_ok=True)
    try:
        with _browser(browser) as b:
            ctx = b.browser.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
            origin = server.origin

            def route(r):
                if r.request.url.startswith(origin) or r.request.url.startswith(("data:", "about:", "blob:")):
                    r.continue_()
                else:
                    requests.append(r.request.url)
                    r.abort()
            ctx.route("**/*", route)
            page = ctx.new_page()
            current = {"slide": None, "step": None}

            def where():
                return {"slide": current["slide"], "step": current["step"]}
            page.on("pageerror", lambda e: issues.append(_issue("error", "js", f"JS のエラー: {e}", **where())))

            def on_console(msg):
                if msg.type == "error" and "Failed to load resource" not in msg.text:
                    issues.append(_issue("error", "js", f"JS のエラー: {msg.text}", **where()))
            page.on("console", on_console)

            def on_response(resp):
                if resp.status >= 400 and resp.url.startswith(origin):
                    issues.append(_issue("error", "missing", f"読み込めない素材: {resp.url[len(origin):]}（{resp.status}）",
                                         resource=_resource_path(resp.url), detection="network", **where()))
            page.on("response", on_response)
            page.on("requestfailed", lambda req: None if not req.url.startswith(origin) else issues.append(
                _issue("error", "missing", f"読み込めない素材: {req.url[len(origin):]}（{req.failure}）",
                       resource=_resource_path(req.url), detection="network", **where())))
            page.add_init_script("window.__slideStudioNoHash = true;")
            page.goto(server.url(url_path))
            page.wait_for_function("window.deckReady === true", timeout=20000)
            page.evaluate("document.body.classList.add('export')")
            # 実測で増えた参考文献ページを、検査結果の番号・原稿対応にも反映する。
            actual = page.evaluate("""() => deck.slides.map((s, index) => ({
                index, page: s.dataset.page === '' ? null : Number(s.dataset.page), id: s.id,
                title: s.querySelector('h1,h2')?.textContent || '',
                level: s.classList.contains('section-slide') ? 1 : 2,
                figures: [...s.querySelectorAll('[data-slide-studio-fig]')].map(e => e.dataset.slideStudioFig)
            }))""")
            if slides is not None:
                selected_pages = {rendered.slides[i]["page"] for i in slides if i < len(rendered.slides)}
                slides[:] = [s["index"] for s in actual if s["page"] in selected_pages]
            rendered.slides = actual
            count = len(actual)
            targets = slides if slides is not None else list(range(count))
            # 読み込めなかった図（figure.mjs のエラーなど）
            broken = page.evaluate("""() => [...document.querySelectorAll('iframe')].map((f,i)=>{let ok=false;try{ok=!!f.contentWindow.animation}catch{};const s=f.closest('.slide');return ok?null:{slide:[...document.querySelectorAll('#stage > .slide')].indexOf(s),src:f.getAttribute('src')}}).filter(Boolean)""")
            for x in broken:
                issues.append(_issue("error", "missing", f"図を読み込めない: {x['src']}", slide=x["slide"]))
            completed = 0
            target_count = sum(i in targets for i in range(count))
            for i in range(count):
                if i not in targets:
                    info.append(None)
                    continue
                page.evaluate("(i)=>deck.go(i,0)", i)
                max_step = page.evaluate("deck.maxStep()")
                info.append({"slide": i, "steps": max_step + 1})
                # 図の step 数が減ると、見出しの pdf="…" の番号が範囲の外に出る
                gone = [m for m in page.evaluate("(i)=>deck.pdfMarks(i)", i) if m > max_step + 1]
                if gone:
                    issues.append(_issue("warning", "pdf-step", f"PDF に入れる step {'・'.join(map(str, gone))} はありません（このページの step は {max_step + 1} 個）", slide=i))
                for s in range(max_step + 1):
                    current.update(slide=i, step=s)
                    status = page.evaluate("""([i,s,t]) => Promise.race([deck.go(i,s).then(()=>'ok'), new Promise(r=>setTimeout(()=>r('timeout'),t))])""", [i, s, SETTLE_TIMEOUT_MS])
                    if status == "timeout":
                        issues.append(_issue("error", "settle", f"描画が完了しない（{SETTLE_TIMEOUT_MS // 1000}秒以内に settled が解決しない）", slide=i, step=s))
                    found = page.main_frame.evaluate(LAYOUT, {"dx": 0, "dy": 0, "audit": audit})
                    for fr in page.frames:
                        if fr == page.main_frame or fr.parent_frame != page.main_frame:
                            continue
                        try:
                            el = fr.frame_element()
                            if not el.is_visible():
                                continue
                            box = el.bounding_box()
                        except Exception:  # noqa: BLE001 - 消えた iframe
                            continue
                        if not box:
                            continue
                        for x in fr.evaluate(LAYOUT, {"dx": box["x"], "dy": box["y"], "frame": True, "audit": audit}):
                            x["figure"] = fr.url
                            found.append(x)
                    name = _slide_name(i, s)
                    if shots:
                        write_atomic(out_dir / "shots" / f"{name}.png", page.screenshot())
                        written["shots"].add(name)
                    if found:
                        for x in found:
                            x.update(slide=i, step=s, image=f"issues/{name}.png")
                        boxes = [{**r, "level": x["level"]} for x in found for r in x.get("rects", [])]
                        page.evaluate(OVERLAY, boxes)
                        write_atomic(out_dir / "issues" / f"{name}.png", page.screenshot())
                        written["issues"].add(name)
                        page.evaluate(OVERLAY, None)
                        issues.extend(found)
                    if progress:
                        progress(100 * (completed + (s + 1) / (max_step + 1)) / target_count)
                completed += 1
            ctx.close()
            _drop_stale(out_dir, written if shots else {"issues": written["issues"]}, set(targets), count)
    finally:
        server.close()
    return issues, info, requests


# ---------------------------------------------------------------- まとめ


def _steps(x: dict) -> list[int]:
    return x.get("steps") or ([x["step"]] if x.get("step") is not None else [])


def _dedupe(items: list[dict]) -> list[dict]:
    """同じ問題を1件にまとめる。全 step を測るので（§9.2）、step が進んでも残る問題は step の数だけ見つかるが、
    数えるのは問題の数。出た step は steps に並べ、step・image・rects は代表（はみ出しは最も大きく出た step）のもの。"""
    at: dict[tuple, int] = {}
    out: list[dict] = []
    missing_sources = {x["resource"] for x in items
                       if x["kind"] == "missing" and x.get("detection") == "source" and x.get("resource")}
    for x in items:
        # 通信時のスライド位置は読み込みの順で変わるため、素材のパスで原稿側の指摘と照合する。
        if x["kind"] == "missing" and x.get("detection") == "network" and x.get("resource") in missing_sources:
            continue
        # はみ出しの量は step で変わりうるので、量を除いて同じ問題とみなす
        key = (x["level"], x["kind"], re.sub(r"\d+px", "", x["message"]), x.get("slide"), x.get("figure"))
        if key not in at:
            at[key] = len(out)
            out.append(dict(x))
            continue
        i = at[key]
        prev = out[i]
        steps = sorted(set(_steps(prev)) | set(_steps(x)))
        if (x.get("amount") or 0) > (prev.get("amount") or 0):
            prev = out[i] = dict(x)
        if len(steps) > 1:
            prev["steps"] = steps
    return out


def step_label(x: dict) -> str:
    """問題が出た step の表記（1始まり）。例：step 2、step 1〜11、step 1〜3・5。"""
    steps = _steps(x)
    if not steps:
        return ""
    runs: list[list[int]] = []
    for s in steps:
        if runs and s == runs[-1][1] + 1:
            runs[-1][1] = s
        else:
            runs.append([s, s])
    return "step " + "・".join(f"{a + 1}" if a == b else f"{a + 1}〜{b + 1}" for a, b in runs)


def check_deck(ws: Workspace, deck: str, page: str | None = None, browser: Browser | None = None,
               text: str | None = None, slides: list[int] | None = None,
               out_dir: Path | None = None, audit: bool = False,
               progress: Callable[[float], None] | None = None) -> dict:
    ws.require_deck(deck)
    started = time.time()
    text = text if text is not None else ws.qmd(deck).read_text()
    version = deck_version(ws, deck, text)
    out_dir = out_dir if out_dir is not None else ws.build_dir(deck)
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        rendered = render_deck(ws, deck, text)
    except RenderError as e:
        result = {"deck": deck, "version": version, "checked_at": started, "scope": "all", "slides": [],
                  "errors": [_issue("error", "pandoc", f"Pandoc のエラー: {e}")], "warnings": [], "external_requests": []}
        write_atomic(out_dir / "checks.json", json.dumps(result, ensure_ascii=False, indent=1))
        return result
    scope = "all"
    if page:
        idx = [s["index"] for s in rendered.slides if s["id"] == page or (s["page"] is not None and rendered.doc.pages[s["page"]].id == page)]
        if not idx:
            raise StudioError(f"ページがありません: {page}")
        slides = idx
        scope = f"page:{page}"
    elif slides is not None:
        scope = "slides:" + ",".join(str(i + 1) for i in slides)
    found = static_issues(ws, deck, rendered)
    b_issues, info, requests = browser_issues(ws, deck, rendered, slides, out_dir, browser=browser, audit=audit,
                                              **({"progress": progress} if progress else {}))
    found += b_issues
    for url in sorted(set(requests)):
        found.append(_issue("error", "external", f"外部への通信: {url}"))
    for x in found:
        if x.get("slide") is not None and x.get("page") is None:
            s = rendered.slides[x["slide"]]
            x["page"] = s["page"]
            x["page_id"] = s["id"]
        elif x.get("page") is not None:
            x["page_id"] = rendered.doc.pages[x["page"]].id
            if x.get("slide") is None:
                x["slide"] = next((s["index"] for s in rendered.slides if s["page"] == x["page"]), None)
    found = _dedupe(found)
    prev = load(ws, deck) if scope != "all" else None
    result = {
        "deck": deck, "version": version, "checked_at": started, "elapsed": round(time.time() - started, 2),
        "scope": scope,
        "slides": [{**s, "steps": (info[s["index"]] or {}).get("steps") if s["index"] < len(info) and info[s["index"]] else None} for s in rendered.slides],
        "errors": [x for x in found if x["level"] == "error"],
        "warnings": [x for x in found if x["level"] == "warning"],
        "external_requests": sorted(set(requests)),
    }
    if prev and scope != "all":
        # 一部だけ検査したときは、他のスライドの前回の結果を残す
        checked = set(slides or [])
        for key in ("errors", "warnings"):
            result[key] = _dedupe([x for x in prev.get(key, []) if x.get("slide") not in checked and x.get("slide") is not None] + result[key])
        for s in result["slides"]:
            if s["steps"] is None:
                old = next((o for o in prev.get("slides", []) if o["index"] == s["index"]), None)
                s["steps"] = old and old.get("steps")
    write_atomic(out_dir / "checks.json", json.dumps(result, ensure_ascii=False, indent=1))
    return result


def figure_deck(ref: str) -> str:
    """図だけの検査に使う一時の発表の名前。画像は .slide-studio/build/<この名前>/shots/ に残る。"""
    return "_check-" + re.sub(r"[^a-z0-9-]", "-", ref)


def check_figure(ws: Workspace, ref: str, browser: Browser | None = None, theme: str | None = None) -> dict:
    """図だけを検査する：theme（無ければその図を使っている発表のテーマ、それも無ければ default）の1枚に図を置いて、各 step を測る。"""
    import shutil

    decks = [d for d in ws.list_decks() if ref in figs.fig_refs(ws.qmd(d).read_text())]
    theme = theme or (ws.deck_theme(decks[0]) if decks else "default")
    if not (ws.figure_dir(ref) / "figure.mjs").exists():
        raise StudioError(f"図がありません: {ref}")
    # 一時の発表（名前が _ で始まる発表は一覧に出さない）。図の参照の相対パスを発表と同じにするため decks/ に置く
    tmp = figure_deck(ref)
    deck_dir = ws.deck_dir(tmp)
    shutil.rmtree(deck_dir, ignore_errors=True)
    deck_dir.mkdir(parents=True)
    try:
        qmd = (f'---\ntitle: "{ref}"\ntopic: {ref.split("/")[0]}\ntheme: {theme}\n---\n\n'
               f"## {ref} {{#figure}}\n\n{{{{< fig {ref} height=560 >}}}}\n\n## 参考文献 {{#references}}\n\n# Appendix {{#appendix}}\n")
        write_atomic(deck_dir / "slides.qmd", qmd)
        result = check_deck(ws, tmp, browser=browser, slides=[0])
        result["figure"] = ref
        result["decks"] = decks
        return result
    finally:
        shutil.rmtree(deck_dir, ignore_errors=True)


def load(ws: Workspace, deck: str) -> dict | None:
    try:
        return json.loads((ws.build_dir(deck) / "checks.json").read_text())
    except (OSError, ValueError):
        return None


def check_theme(ws: Workspace, name: str) -> dict:
    path = ws.themes / f"{name}.css"
    errors = []
    if not path.is_file():
        errors.append(_issue("error", "theme", f"テーマがありません: themes/{name}.css"))
    else:
        defined = theme_variables(path.read_text())
        lacking = [v for v in THEME_VARIABLES if v not in defined]
        if lacking:
            errors.append(_issue("error", "theme", f"テーマ themes/{name}.css に必須の変数がありません: {', '.join(lacking)}"))
    return {"kind": "theme", "errors": errors, "warnings": []}


def summary(result: dict) -> str:
    e, w = result["errors"], result["warnings"]
    head = "検査：問題なし" if not e and not w else f"検査：エラー {len(e)}・警告 {len(w)}"
    lines = [head]
    for x in e + w:
        where = []
        if x.get("slide") is not None:
            where.append(f"p{x['slide'] + 1}")
        if step_label(x):
            where.append(step_label(x))
        mark ="✗" if x["level"] == "error" else "!"
        lines.append(f"  {mark} {' '.join(where) + ' ' if where else ''}{x['message']}" + (f"  [{x['image']}]" if x.get("image") else ""))
    lines.append(f"  結果: .slide-studio/build/{result['deck']}/checks.json")
    return "\n".join(lines)
