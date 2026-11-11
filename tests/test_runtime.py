"""連続 step のキャンセル・確定状態を実ブラウザで検証する。"""
from pathlib import Path
import shutil

import pytest
from playwright.sync_api import sync_playwright

from slide_studio import httpd
from slide_studio.bundle import Bundler
from bs4 import BeautifulSoup


FIGURE_SLIDE = '<section class="slide"><iframe src="figure.html"></iframe><p data-step="3">end</p></section>'


@pytest.mark.parametrize('leave_while_loading', [False, True])
@pytest.mark.parametrize('delayed_font', [False, True])
def test_preview_starts_before_other_pages_load(leave_while_loading, delayed_font):
    """後続ページの応答を保留しても編集プレビューが使え、移動先の段数は読み込み後に確定する。"""
    package = Path(__file__).resolve().parents[1] / 'slide_studio'
    held, fonts = [], []
    html = '''<div id="stage">
      <section class="slide"><h2>first</h2></section>
      <section class="slide"><iframe src="/slow.html"></iframe><p data-step="1">last</p></section>
      </div><script src="/player.js"></script>'''
    if delayed_font:
        html = '''<style>@font-face {font-family: delayed; src: url('/slow.woff2');}
          h2 {font-family: delayed;}</style>''' + html
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()

        def respond(route):
            path = route.request.url.split('http://studio.test')[1].split('?')[0]
            if path == '/slow.html':
                held.append(route)
                return
            if path == '/slow.woff2':
                fonts.append(route)
                return
            if path == '/player.js':
                route.fulfill(body=(package / 'runtime/player.js').read_text(), content_type='text/javascript')
            elif path.endswith('.js') and (package / 'web' / path.lstrip('/')).is_file():
                route.fulfill(body=(package / 'web' / path.lstrip('/')).read_text(), content_type='text/javascript')
            elif path.startswith('/files/'):
                route.fulfill(body=html, content_type='text/html')
            else:
                route.fulfill(body='''<div id="box"></div><script type="module">
                  import {Preview} from '/preview.js';
                  window.preview = new Preview(document.querySelector('#box'), 'talk');
                  preview.load('v1');
                </script>''', content_type='text/html')

        page.route('**/*', respond)
        page.goto('http://studio.test/', wait_until='domcontentloaded')
        if delayed_font:
            page.wait_for_function("window.preview?.pending?.contentDocument.fonts.status === 'loading'")
            assert not page.evaluate('Boolean(preview.frame)'), '表示中のフォントの読み込みは待つ'
            # フォント取得失敗時にも代替フォントで初期表示を続行できる。
            assert fonts
            fonts[0].abort()
        page.wait_for_function('window.preview?.frame && preview.slides.length === 2', timeout=3000)
        assert held, '後続ページの図はまだ応答していない'
        assert page.evaluate('preview.api.index') == 0
        page.evaluate('''() => {
          window.finished = false;
          preview.api.go(1, Infinity).then(() => window.finished = true);
        }''')
        assert not page.evaluate('window.finished')
        if leave_while_loading:
            page.evaluate('preview.api.go(0)')
        held[0].fulfill(body='''<script>
          window.animation = {steps: 3, settled: Promise.resolve(),
            setStep(k) { this.step = k; }, setVisible(v) { this.visible = v; }};
        </script>''', content_type='text/html')
        page.wait_for_function('window.finished')
        result = page.evaluate('''() => {
          const a = preview.win.document.querySelector('iframe').contentWindow.animation;
          return {index: preview.api.index, step: preview.api.step, figure: a.step, visible: a.visible};
        }''')
        if leave_while_loading:
            assert result['index'] == 0 and result['step'] == 0 and not result['visible']
        else:
            assert result == {'index': 1, 'step': 4, 'figure': 3, 'visible': True}
        browser.close()


@pytest.fixture(params=[False, True], ids=["preview", "bundled"])
def player(tmp_path, request):
    yield from _serve(tmp_path, FIGURE_SLIDE * 3, request.param)


def _serve(tmp_path, slides, bundled):
    runtime = Path(__file__).resolve().parents[1] / "slide_studio" / "runtime"
    shutil.copytree(runtime, tmp_path / "runtime")
    (tmp_path / "figure.html").write_text('''<div id="stage"></div>
<script type="module">
import {mount} from './runtime/figure.mjs';
window.renders = 0;
mount({steps: ['a','b','c','d'],
 renderStep(k) { window.renders++; return `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="${k*100}" cy="50" r="20"/></svg>`; },
 transition(from, to) { if (window.simpleMotion) return null; return [{hold: 10000, markup: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="999"/></svg>'}]; }
});
</script>''')
    html = '<link rel="stylesheet" href="runtime/base.css"><div id="stage">' + slides + '</div><script src="runtime/player.js"></script>'
    if bundled:
        soup = BeautifulSoup(html, "html.parser")
        Bundler(tmp_path).soup(soup, tmp_path)
        html = str(soup)
    (tmp_path / "index.html").write_text(html)
    server = httpd.StaticServer(tmp_path)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(server.url('index.html'))
            page.wait_for_function('window.deckReady')
            yield page
            browser.close()
    finally:
        server.close()


def test_interrupted_hold_settles_without_stale_frame(player):
    result = player.evaluate('''async () => {
      const a = document.querySelector('iframe').contentWindow.animation;
      const first = deck.move(1);
      const interrupted = a.settled;
      const next = deck.move(1);
      const completed = await Promise.race([
        Promise.all([first, interrupted, next]).then(() => true),
        new Promise(r => setTimeout(() => r(false), 1000))
      ]);
      return {completed, step: deck.step, x: Number(document.querySelector('iframe').contentDocument.querySelector('circle').getAttribute('cx'))};
    }''')
    assert result == {"completed": True, "step": 2, "x": 200}


def test_burst_reverse_and_page_change(player):
    result = player.evaluate('''async () => {
      const frames = [...document.querySelectorAll('iframe')];
      const calls = frames.map(() => 0);
      frames.forEach((f, i) => {
        const a = f.contentWindow.animation, original = a.setVisible;
        a.setVisible = function(v) { calls[i]++; return original.call(this, v); };
      });
      for (let i=0; i<40; i++) { deck.move(1); deck.move(-1); }
      await deck.settle();
      const stepCalls = [...calls];
      await deck.go(1, 2);
      return {stepCalls, calls, index: deck.index, step: deck.step,
        active: [...document.querySelectorAll('.slide.active')].length,
        x: Number(frames[1].contentDocument.querySelector('circle').getAttribute('cx'))};
    }''')
    assert result == {"stepCalls": [0, 0, 0], "calls": [1, 1, 0], "index": 1, "step": 2, "active": 1, "x": 200}


def test_same_step_does_not_render_and_jump_is_final(player):
    result = player.evaluate('''async () => {
      const w = document.querySelector('iframe').contentWindow;
      const before = w.renders;
      await deck.go(0, 0); await deck.go(0, 0);
      const extra = w.renders - before;
      await deck.jump(1);
      return {extra, step: deck.step, pending: document.querySelector('[data-step]').classList.contains('pending'),
        x: Number(w.document.querySelector('circle').getAttribute('cx'))};
    }''')
    # 図の4つの step（0〜3）を送り終えてから、段 3 の本文が step 4 で出る（空いた段 1・2 は飛ばす）
    assert result == {"extra": 0, "step": 4, "pending": False, "x": 300}


def test_motion_cancel_clears_moving_and_keeps_latest_geometry(player):
    # モジュールは配布版と同じコピー。RAF 中断も hold 中断と別に検証する。
    result = player.evaluate('''async () => {
      const {createMotion} = await import('./runtime/motion.mjs');
      const stage = document.createElement('div'); document.body.append(stage);
      const m = createMotion(stage), svg = x => `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="${x}"/></svg>`;
      await m.update(svg(0));
      const old = m.update(svg(100), 10000);
      await m.update(svg(200), 0);
      return {old: await old, moving: stage.dataset.moving, x: stage.querySelector('circle').getAttribute('cx')};
    }''')
    assert result == {"old": False, "moving": "false", "x": "200"}


def test_animation_resumes_after_pause_and_reduced_motion(player):
    result = player.evaluate('''async () => {
      const w = document.querySelector('iframe').contentWindow;
      w.simpleMotion = true;
      // 入力間隔だけを制御し、RAF とアニメーションは実際に動かす。
      let now = 1000; performance.now = () => now;
      const first = deck.move(1);
      const moving = w.document.querySelector('#stage').dataset.moving;
      now += 100; await deck.move(1); await first;
      const stopped = w.document.querySelector('#stage').dataset.moving;
      now += 500; const last = deck.move(-1);
      const resumed = w.document.querySelector('#stage').dataset.moving;
      await last;
      return {moving, stopped, resumed, step: deck.step,
        x: Number(w.document.querySelector('circle').getAttribute('cx'))};
    }''')
    assert result == {"moving": "true", "stopped": "false", "resumed": "true", "step": 1, "x": 100}
    player.emulate_media(reduced_motion="reduce")
    assert player.evaluate('''async () => {
      const a = document.querySelector('iframe').contentWindow.animation;
      await a.setStep(3, true);
      return document.querySelector('iframe').contentDocument.querySelector('#stage').dataset.moving;
    }''') == "false"


def test_leaving_page_cancels_pending_transition(player):
    assert player.evaluate('''async () => {
      const w = document.querySelector('iframe').contentWindow;
      deck.move(1); const pending = w.animation.settled;
      await deck.go(1);
      return await Promise.race([
        pending.then(() => Number(w.document.querySelector('circle').getAttribute('cx'))),
        new Promise(r => setTimeout(() => r('timeout'), 1000))
      ]);
    }''') == 100


def test_figure_stage_plays_out_before_next_stage(tmp_path):
    # 段 0：本文、段 1：図（4つの step）、段 2：本文。図を送り終えるまで段 2 は出ない
    slide = ('<section class="slide"><p>a</p><div class="animation" data-step="1"><iframe src="figure.html"></iframe></div>'
             '<p data-step="2" id="late">b</p></section>')
    served = _serve(tmp_path, slide, False)
    page = next(served)
    result = page.evaluate('''async () => {
      const w = document.querySelector('iframe').contentWindow, out = [];
      for (let s = 0; s <= deck.maxStep(); s++) {
        await deck.go(0, s);
        out.push([deck.stageAt(), document.querySelector('.animation').classList.contains('pending'),
          document.querySelector('#late').classList.contains('pending'), w.animation.step]);
      }
      await deck.goStage(2);
      return {out, max: deck.maxStep(), stage2: deck.step};
    }''')
    served.close()
    assert result == {"max": 5, "stage2": 5, "out": [
        [0, True, True, 0], [1, False, True, 0], [1, False, True, 1], [1, False, True, 2], [1, False, True, 3], [2, False, False, 3]]}
