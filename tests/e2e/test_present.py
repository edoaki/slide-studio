"""編集画面からの発表：開始位置・保存・固定表示・終了位置・全画面拒否。"""
import pytest
from playwright.sync_api import expect

from slide_studio.fsutil import write_atomic


EDITOR = "document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck"
PLAYER = "document.querySelector('.present-screen iframe').contentWindow.deck"


def open_editor(page, srv):
    page.goto(srv.url + "/deck/talk")
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady && document.querySelector('.present-tools')")
    page.get_by_role("button", name="すべての記法を表示", exact=True).click()


def prepare(page, srv):
    page.add_init_script("Element.prototype.requestFullscreen = () => Promise.reject(new Error('denied'))")
    open_editor(page, srv)


def start(page, name):
    page.get_by_role("button", name=name, exact=True).click()
    page.wait_for_function("document.querySelector('.present-screen iframe')?.contentWindow?.deckReady && !document.querySelector('.present-tools > button').disabled")


def test_current_page_starts_at_first_step_and_returns(gui, page):
    ws, srv = gui
    write_atomic(ws.qmd("talk"), ws.qmd("talk").read_text().replace("二番目の段落。", "::: {.incremental}\n- A\n- B\n:::"))
    prepare(page, srv)
    page.evaluate(f"{EDITOR}.go(2, 1)")
    start(page, "今のページから")
    assert page.evaluate(f"[{PLAYER}.index, {PLAYER}.step]") == [2, 0]
    assert page.evaluate("document.fullscreenElement === null")
    assert page.evaluate("document.querySelector('#root').inert")
    assert page.evaluate("document.querySelector('.present-screen iframe').contentDocument.querySelector('[src=\"/web/inject/edit.js\"]') === null")
    page.keyboard.press("ArrowRight")
    page.wait_for_function(f"{PLAYER}.step === 1")
    page.keyboard.press("Escape")
    expect(page.locator(".present-screen")).to_have_count(0)
    assert page.evaluate(f"[{EDITOR}.index, {EDITOR}.step]") == [2, 1]
    assert not page.evaluate("document.querySelector('#root').inert")
    assert not page.errors


@pytest.mark.parametrize("present", [False, True])
@pytest.mark.parametrize("outside", [False, True])
def test_horizontal_wheel_moves_pages_once_per_gesture(gui, page, present, outside):
    ws, srv = gui
    write_atomic(ws.qmd("talk"), ws.qmd("talk").read_text().replace(
        "二番目の段落。", "::: {.incremental}\n- A\n- B\n:::"))
    prepare(page, srv)
    if present:
        start(page, "最初から")
    selector = ".present-screen iframe" if present else "#slideBox iframe:not(.loading)"
    api = PLAYER if present else EDITOR
    page.evaluate(f"{api}.go(2, 1)")

    def wheel(events):
        return page.evaluate("""({selector, events, outside}) => {
          const w = outside ? window : document.querySelector(selector).contentWindow;
          return events.map(options => {
            const e = new w.WheelEvent('wheel', {bubbles: true, cancelable: true, ...options});
            (outside ? document.body : w.document.querySelector('.slide.active')).dispatchEvent(e);
            return e.defaultPrevented;
          });
        }""", {"selector": selector, "events": events, "outside": outside})

    assert page.evaluate("getComputedStyle(document.documentElement).overscrollBehaviorX") == "none"
    assert page.evaluate("""selector => getComputedStyle(document.querySelector(selector)
        .contentDocument.documentElement).overscrollBehaviorX""", selector) == "none"
    assert wheel([{"deltaX": 10, "deltaY": 80}, {"deltaX": 100, "ctrlKey": True}]) == [False, False]
    assert page.evaluate(f"[{api}.index, {api}.step]") == [2, 1]
    assert all(wheel([{"deltaX": dx} for dx in [15, 15, 20, 100, 60, 20, 2]]))
    assert page.evaluate(f"[{api}.index, {api}.step]") == [3, 0]
    page.wait_for_timeout(250)
    wheel([{"deltaX": -80}, {"deltaX": -40}])
    assert page.evaluate(f"[{api}.index, {api}.step]") == [2, 0]
    page.wait_for_timeout(250)
    page.evaluate(f"{api}.go(0)")
    assert wheel([{"deltaX": -80}]) == [True]
    assert page.evaluate(f"{api}.index") == 0
    page.wait_for_timeout(250)
    page.evaluate(f"{api}.go({api}.count - 1)")
    wheel([{"deltaX": 80}])
    assert page.evaluate(f"{api}.index === {api}.count - 1")
    assert not page.errors


@pytest.mark.parametrize("present", [False, True])
@pytest.mark.parametrize("outside", [False, True])
def test_repeated_swipes_during_momentum(gui, page, present, outside):
    _, srv = gui
    prepare(page, srv)
    if present:
        start(page, "最初から")
    selector = ".present-screen iframe" if present else "#slideBox iframe:not(.loading)"
    # 実時間の待ちに依存せず、慣性中に次の操作が始まる入力を再現する。
    results = page.evaluate("""({selector, outside}) => {
      const player = document.querySelector(selector).contentWindow;
      const w = outside ? window : player;
      const target = outside ? document.body : player.document.querySelector('#stage');
      const originalNow = player.performance.now;
      let now = 1000;
      player.performance.now = () => now;
      const send = (dx, dt = 30) => {
        now += dt;
        target.dispatchEvent(new w.WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaX: dx,
        }));
        return player.deck.index;
      };
      try {
        player.deck.go(1);
        const first = [15, 15, 20, 100, 60, 30, 12, 5, 2].map(dx => send(dx));
        const repeated = [12, 20, 25, 80, 35, 10, 3].map(dx => send(dx));
        const jitter = [-2, 2, -3, 1].map(dx => send(dx));
        const reverse = [-15, -15, -20, -80, -20, -2].map(dx => send(dx));
        const idle = send(-50, 250);
        return {first, repeated, jitter, reverse, idle};
      } finally {
        player.performance.now = originalNow;
      }
    }""", {"selector": selector, "outside": outside})
    assert results == {
        "first": [1, 1, 2, 2, 2, 2, 2, 2, 2],
        "repeated": [2, 2, 3, 3, 3, 3, 3],
        "jitter": [3, 3, 3, 3],
        "reverse": [3, 3, 2, 2, 2, 2],
        "idle": 1,
    }
    assert not page.errors


def test_first_and_fixed_until_exit(gui, page):
    ws, srv = gui
    prepare(page, srv)
    page.evaluate(f"{EDITOR}.go(3)")
    start(page, "最初から")
    assert page.evaluate(f"[{PLAYER}.index, {PLAYER}.step]") == [0, 0]
    write_atomic(ws.qmd("talk"), ws.qmd("talk").read_text().replace("最初の段落。", "外部の変更。"))
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.body.textContent.includes('外部の変更。')")
    assert not page.evaluate("document.querySelector('.present-screen iframe').contentDocument.body.textContent.includes('外部の変更。')")
    page.keyboard.press("ArrowDown")
    page.wait_for_function(f"{PLAYER}.index === 1")
    page.keyboard.press("Escape")
    expect(page.locator(".present-screen")).to_have_count(0)
    assert page.evaluate(f"{EDITOR}.index") == 1
    assert not page.errors


def test_flushes_pending_source_before_start(gui, page):
    ws, srv = gui
    prepare(page, srv)
    # 同じ処理の中で入力と開始を行い、自動保存の待ち時間より先に発表を要求する。
    page.evaluate("""() => {
      const ta = document.querySelector('.raw textarea');
      ta.value = ta.value.replace('最初の段落。', '発表前に保存。');
      ta.dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('.present-tools > button').click();
    }""")
    page.wait_for_function("document.querySelector('.present-screen iframe')?.contentWindow?.deckReady && !document.querySelector('.present-tools > button').disabled")
    assert "発表前に保存。" in ws.qmd("talk").read_text()
    assert page.evaluate("document.querySelector('.present-screen iframe').contentDocument.body.textContent.includes('発表前に保存。')")
    page.keyboard.press("Escape")
    assert not page.errors


def test_fullscreen_exit_finishes_presentation(gui, page):
    _, srv = gui
    open_editor(page, srv)
    # 権限に依存せず、fullscreenchange の開始・終了を検証する。
    page.evaluate("""() => {
      let current = null;
      Object.defineProperty(document, 'fullscreenElement', {get: () => current});
      Element.prototype.requestFullscreen = async function() { current = this; document.dispatchEvent(new Event('fullscreenchange')); };
      document.exitFullscreen = async () => { current = null; document.dispatchEvent(new Event('fullscreenchange')); };
    }""")
    start(page, "最初から")
    page.evaluate(f"{PLAYER}.go(3)")
    page.evaluate("document.exitFullscreen()")
    expect(page.locator(".present-screen")).to_have_count(0)
    assert page.evaluate(f"{EDITOR}.index") == 3
    assert not page.errors


def test_save_failure_does_not_start(gui, page):
    _, srv = gui
    prepare(page, srv)
    requests = []
    page.on("request", lambda request: requests.append(request.url))
    page.route("**/api/deck/talk/source", lambda route: route.fulfill(status=500, json={"error": "保存の失敗"}))
    page.evaluate("""() => {
      const ta = document.querySelector('.raw textarea');
      ta.value += '\\n未保存の入力。'; ta.dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('.present-tools > button').click();
    }""")
    expect(page.locator(".toast")).to_contain_text("保存できませんでした")
    expect(page.locator(".present-screen")).to_have_count(0)
    assert not any("edit=0" in url for url in requests)
    assert not page.errors


def test_render_failure_does_not_start(gui, page):
    _, srv = gui
    prepare(page, srv)
    page.route("**/__slide-studio_preview__.html?edit=0", lambda route: route.fulfill(status=500, body="変換できません"))
    page.get_by_role("button", name="最初から", exact=True).click()
    expect(page.locator(".toast")).to_contain_text("発表を始められませんでした")
    expect(page.locator(".present-screen")).to_have_count(0)
    assert not page.errors


@pytest.mark.parametrize("shortcut, expected", [("Shift+F", 0), ("f", 2)])
@pytest.mark.parametrize("focus", ["toolbar", "preview"])
def test_start_shortcuts(gui, page, shortcut, expected, focus):
    _, srv = gui
    prepare(page, srv)
    page.evaluate(f"{EDITOR}.go(2)")
    if focus == "toolbar":
        page.locator(".present-tools > button").first.focus()
    else:
        page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.focus()")
    page.evaluate(f"{EDITOR}.go(2)")
    page.keyboard.press(shortcut)
    page.wait_for_function("document.querySelector('.present-screen iframe')?.contentWindow?.deckReady && !document.querySelector('.present-tools > button').disabled")
    assert page.evaluate(f"{PLAYER}.index") == expected
    page.keyboard.press("Escape")
    expect(page.locator(".present-screen")).to_have_count(0)
    assert page.evaluate(f"{EDITOR}.index") == expected
    expect(page.locator("#hintKeys")).not_to_contain_text("クリック")
    expect(page.locator("#hintKeys")).not_to_contain_text("F5")
    assert not page.errors


def test_shortcuts_do_not_interrupt_typing(gui, page):
    _, srv = gui
    prepare(page, srv)
    field = page.locator(".raw textarea")
    field.focus()
    page.keyboard.press("End")
    before = field.input_value()
    page.keyboard.press("p")
    page.keyboard.press("f")
    page.keyboard.press("Shift+F")
    assert len(field.input_value()) == len(before) + 3
    assert "pfF" in field.input_value()
    expect(page.locator(".output-popover")).to_have_count(0)
    expect(page.locator(".present-screen")).to_have_count(0)
    assert not page.errors


@pytest.mark.parametrize("focus", ["toolbar", "preview"])
@pytest.mark.parametrize("format", ["html", "pdf"])
def test_p_opens_export_choices(gui, page, focus, format):
    _, srv = gui
    prepare(page, srv)
    requests = []

    def build(route):
        requests.append(route.request.post_data_json)
        route.fulfill(json={"blocked": True, "result": {"errors": [], "warnings": []}})

    page.route("**/api/deck/talk/build", build)
    if focus == "toolbar":
        page.locator(".present-tools > button").first.focus()
    else:
        page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.focus()")
    page.keyboard.press("p")
    expect(page.locator('[data-format="html"]')).to_be_visible()
    expect(page.locator('[data-format="pdf"]')).to_be_visible()
    page.keyboard.press("p")
    assert requests == []
    page.locator(f'[data-format="{format}"]').click()
    expect(page.locator("[data-force]")).to_be_visible()
    assert len(requests) == 1
    assert requests[0]["format"] == format
    assert requests[0]["force"] is False
    expect(page.locator(".present-screen")).to_have_count(0)
    assert not page.errors


def test_f_key_release_keeps_fullscreen(gui, page):
    _, srv = gui
    open_editor(page, srv)
    page.locator(".present-tools > button").first.focus()
    page.keyboard.down("f")
    page.wait_for_function("document.querySelector('.present-screen iframe')?.contentWindow?.deckReady && !document.querySelector('.present-tools > button').disabled")
    assert page.evaluate("document.fullscreenElement !== null")
    page.keyboard.up("f")
    assert page.evaluate("document.fullscreenElement !== null")
    expect(page.locator(".present-screen")).to_have_count(1)
    page.keyboard.press("Escape")
    expect(page.locator(".present-screen")).to_have_count(0)
    assert not page.errors


def test_export_progress_updates_during_check(gui, page):
    _, srv = gui
    page.add_init_script("""const Native = window.EventSource;
      window.EventSource = class extends Native {
        constructor(...args) { super(...args); window.testEvents = this; }
      };""")
    prepare(page, srv)
    pending = []
    page.route("**/api/deck/talk/build", lambda route: pending.append(route))
    page.locator('[data-output="build"]').click()
    page.locator('[data-format="html"]').click()
    bar = page.locator('.output-progress')
    expect(bar).to_be_visible()
    expect(bar).not_to_have_attribute('value', '0')
    page.wait_for_timeout(100)
    assert pending
    request_id = pending[0].request.post_data_json['id']
    def emit(value, phase, id=request_id):
        page.evaluate("ev => testEvents.onmessage({data: JSON.stringify(ev)})",
                      dict(type='export-progress', deck='talk', id=id, value=value, phase=phase))
    emit(None, 'check')
    expect(page.get_by_text('ページを検査しています…', exact=True)).to_be_visible()
    emit(20, 'check')
    expect(bar).to_have_attribute('value', '20')
    emit(60, 'check', 'other-request')
    expect(bar).to_have_attribute('value', '20')
    emit(80, 'check')
    expect(bar).to_have_attribute('value', '80')
    emit(85, 'export')
    expect(page.get_by_text('書き出しています…', exact=True)).to_be_visible()
    expect(bar).to_have_attribute('value', '85')
    pending[0].fulfill(json={"blocked": True, "result": {"errors": [], "warnings": []}})
    expect(bar).to_have_count(0)
    assert not page.errors
