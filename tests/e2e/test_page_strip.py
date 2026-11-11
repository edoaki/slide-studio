"""ページの帯：縮小画像、大きさのつまみ、step めくり、裏での撮影（shots.py）。"""
import json
import re
import time

import pytest
from playwright.sync_api import expect

from e2e.conftest import open_deck
from slide_studio import shots

STEPS = '''

## 段階表示 {#steps}

最初から見える段落。

::: {data-step="1"}
step 1 から見える段落。
:::

[強調する語]{.highlight data-highlight-step="2"} を含む段落。
'''


@pytest.fixture
def shooting(gui, monkeypatch):
    monkeypatch.setattr(shots, "ENABLED", True)
    ws, srv = gui
    qmd = ws.qmd("talk")
    text = qmd.read_text()
    qmd.write_text(text.replace("\n## まとめ {#summary}", STEPS + "\n## まとめ {#summary}"))
    return gui


def wait_shots(page, n=1):
    page.wait_for_function(f"document.querySelectorAll('#pagestrip button.has-shot').length >= {n}", timeout=30000)


def wait_until(predicate):
    deadline = time.monotonic() + 30
    while not predicate():
        assert time.monotonic() < deadline
        time.sleep(.02)


def test_visible_priority_tracks_scroll_filter_and_overview(gui, page):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    shooter = srv.app.state.shots
    wait_until(lambda: (shooter.visible.get('talk') or [None])[0] == 0)
    page.locator('#pagestrip button').last.scroll_into_view_if_needed()
    last = page.locator('#pagestrip button').count() - 1
    wait_until(lambda: last in shooter.visible.get('talk', []) and 0 not in shooter.visible['talk'])
    page.locator('#pagestrip button').last.evaluate('(b) => b.hidden = true')
    wait_until(lambda: last not in shooter.visible.get('talk', []))
    page.get_by_role('button', name='一覧を表示').click()
    wait_until(lambda: 0 in shooter.visible.get('talk', []))
    assert not page.errors


def test_theme_reshoots_visible_pages_first_and_publishes_each_step(shooting, page, monkeypatch):
    from slide_studio import theme_shots
    monkeypatch.setattr(theme_shots, 'ENABLED', False)
    ws, srv = shooting
    open_deck(page, srv, raw=False)
    shooter = srv.app.state.shots
    folder = shots.shots_dir(ws, 'talk')
    def complete():
        return folder.joinpath('index.json').exists() and all(s['hash'] for s in shots._load_index(ws, 'talk'))
    wait_until(complete)
    b = page.locator('#pagestrip button').filter(has_text='段階表示')
    i = int(b.get_attribute('data-index'))
    b.click()
    wait_until(lambda: (shooter.visible.get('talk') or [None])[0] == i)
    visible = shooter.visible['talk'][:]
    captures, partial = [], []
    original_next, original_notify = shooter.next_shot, shooter.notify
    def next_shot(deck, remaining):
        result = original_next(deck, remaining)
        captures.append(result)
        return result
    def notify(deck):
        index = shots._load_index(ws, deck)
        if index[i]['steps'] == 3 and not index[i]['hash']:
            partial.append(shots.listing(ws, deck)[i][0])
        original_notify(deck)
    monkeypatch.setattr(shooter, 'next_shot', next_shot)
    monkeypatch.setattr(shooter, 'notify', notify)
    before = b.locator('img.shot').get_attribute('src')
    theme = ws.themes / 'default.css'
    theme.write_text(theme.read_text() + '\n:root { --paper: #eeeedd; }\n')
    wait_until(lambda: bool(partial) and complete())
    assert captures[:len(visible)] == [(v, 0) for v in visible]
    assert partial and partial[0] != before
    page.wait_for_function('(old) => ![...document.querySelectorAll("#pagestrip img.shot")].some(img => img.getAttribute("src") === old)', arg=before)
    assert not page.errors


def test_thumbnails_only(shooting, page):
    ws, srv = shooting
    open_deck(page, srv, raw=False)
    expect(page.get_by_role("button", name="ページ名で表示")).to_have_count(0)
    count = page.locator("#pagestrip button").count()
    wait_shots(page, count)
    index = json.loads((shots.shots_dir(ws, "talk") / "index.json").read_text())["slides"]
    assert len(index) == count
    assert not page.errors


def test_scrub_steps_and_open_first_step(shooting, page):
    ws, srv = shooting
    open_deck(page, srv, raw=False)
    b = page.locator("#pagestrip button").filter(has_text="段階表示")
    i = int(b.get_attribute("data-index"))
    page.wait_for_function(f"document.querySelector('#pagestrip button[data-index=\"{i}\"]')?.querySelectorAll('.steps i').length === 3", timeout=30000)
    b.scroll_into_view_if_needed()  # 帯は横にはみ出してスクロールする
    box = b.bounding_box()
    srcs = []
    for k in range(3):
        page.mouse.move(box["x"] + box["width"] * (k + .5) / 3, box["y"] + box["height"] / 2)
        expect(b.locator(".steps i.on")).to_have_count(1)
        assert b.locator(".steps i").nth(k).get_attribute("class") == "on"
        srcs.append(b.locator("img.shot").get_attribute("src"))
    assert [f"s{k}.png" in s for k, s in enumerate(srcs)] == [True] * 3
    # めくった位置にかかわらず、ページの最初の step を開く
    page.mouse.click(box["x"] + box["width"] * 2.5 / 3, box["y"] + box["height"] / 2)
    expect(page.locator('#pageCount')).to_have_text(f'{i + 1}ページ')
    expect(page.locator('#stepCount')).to_have_text('1 / 3')
    page.mouse.move(10, 10)
    # 今のページの縮小画像は今の step のまま
    assert "s0.png" in b.locator("img.shot").get_attribute("src")
    assert not page.errors


def test_default_width_200_capped_at_quarter_of_slide(gui, page):
    ws, srv = gui
    width = lambda: page.locator("#pagestrip button").first.bounding_box()["width"]
    page.set_viewport_size({"width": 1920, "height": 1080})
    open_deck(page, srv, raw=False)
    assert abs(width() - 200) <= 1
    # 狭い画面ではスライドの 1/4 に収める
    page.set_viewport_size({"width": 1440, "height": 900})
    open_deck(page, srv, raw=False)
    assert abs(width() - page.locator("#slideBox").bounding_box()["width"] / 4) <= 2
    assert not page.errors


def test_resize_handle_caps_at_quarter_of_slide(gui, page):
    ws, srv = gui
    page.set_viewport_size({"width": 1920, "height": 1080})  # 既定の幅がまだ上限に届かない広さ
    open_deck(page, srv, raw=False)
    grip = page.locator("#stripGrip")
    w0 = page.locator("#pagestrip button").first.bounding_box()["width"]
    g = grip.bounding_box()
    x, y = g["x"] + g["width"] / 2, g["y"]
    # 上へ 9px 引くと幅は 16px 増える（高さ 9 : 幅 16）
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x, y - 9, steps=3); page.mouse.up()
    w1 = page.locator("#pagestrip button").first.bounding_box()["width"]
    assert abs(w1 - (w0 + 16)) <= 1, (w0, w1)
    g = grip.bounding_box()
    page.mouse.move(x, g["y"]); page.mouse.down(); page.mouse.move(x, 0, steps=8); page.mouse.up()
    w2 = page.locator("#pagestrip button").first.bounding_box()["width"]
    slide = page.locator("#slideBox").bounding_box()["width"]
    assert w2 > w1 and abs(w2 - slide / 4) <= 2, (w2, slide)
    # 大きさは開き直しても残る
    open_deck(page, srv, raw=False)
    assert abs(page.locator("#pagestrip button").first.bounding_box()["width"] - w2) <= 2
    assert not page.errors


def test_heading_edit_keeps_other_thumbnail_images(shooting, page):
    from e2e.test_editor import type_at

    ws, srv = shooting
    open_deck(page, srv)
    count = page.locator('#pagestrip button').count()
    wait_shots(page, count)
    page.evaluate("""() => {
        window.stripBefore = [...document.querySelectorAll('#pagestrip button')].map(b => ({
            button: b, img: b.querySelector('img.shot'), src: b.querySelector('img.shot').getAttribute('src'),
        }));
        window.removedShots = [];
        window.stripObserver = new MutationObserver(records => {
            for (const r of records) for (const node of r.removedNodes) {
                if (node.nodeType === 1 && (node.matches('button, img.shot') || node.querySelector('img.shot')))
                    window.removedShots.push(node.tagName);
            }
        });
        window.stripObserver.observe(document.querySelector('#pagestrip'), {childList: true, subtree: true});
    }""")
    type_at(page, '## 一枚目', 'X')
    expect(page.locator('#pagestrip button .t').nth(2)).to_have_text('一枚目X')
    page.wait_for_function("""() => {
        const img = document.querySelectorAll('#pagestrip img.shot')[2];
        return img.getAttribute('src') !== window.stripBefore[2].src && img.complete && img.naturalWidth;
    }""", timeout=30000)
    assert page.evaluate("""() => window.stripBefore.every(({button, img, src}, i) => {
        const current = document.querySelectorAll('#pagestrip button')[i];
        return current === button && current.querySelector('img.shot') === img
            && current.classList.contains('has-shot') && (i === 2 || img.getAttribute('src') === src);
    })""")
    assert page.evaluate('window.removedShots') == []
    assert '## 一枚目X' in ws.qmd('talk').read_text()
    assert not page.errors


def test_shots_only_reshoot_changed_pages(shooting, page):
    ws, srv = shooting
    open_deck(page, srv, raw=False)
    count = page.locator("#pagestrip button").count()
    wait_shots(page, count)
    folder = shots.shots_dir(ws, "talk")
    before = {p.name: p.stat().st_mtime_ns for p in folder.glob("p*-s*.png")}
    qmd = ws.qmd("talk")
    qmd.write_text(qmd.read_text().replace("まとめの段落。", "まとめの段落を変えた。"))
    i = page.locator("#pagestrip button").filter(has_text="まとめ").get_attribute("data-index")
    name = f"p{int(i) + 1:02d}-s0.png"
    page.wait_for_function(f"document.querySelector('#pagestrip button[data-index=\"{i}\"] img.shot')?.src.includes('{name}?v=') && !document.querySelector('#pagestrip button[data-index=\"{i}\"] img.shot').src.endsWith('v={before[name]}')", timeout=30000)
    after = {p.name: p.stat().st_mtime_ns for p in folder.glob("p*-s*.png")}
    changed = sorted(n for n in after if after[n] != before.get(n))
    assert changed == [name]
    # ページを消すと、そのページの画像も消える
    qmd.write_text(qmd.read_text().replace("\n## まとめ {#summary}\n\nまとめの段落を変えた。\n", "\n"))
    page.wait_for_function(f"document.querySelectorAll('#pagestrip button').length === {count - 1}", timeout=30000)
    page.wait_for_function(f"!document.querySelector('#pagestrip button[data-index=\"{count - 1}\"]')")
    import time
    for _ in range(100):
        if len(list(folder.glob("p*-s0.png"))) == count - 1:
            break
        time.sleep(.1)
    assert len(list(folder.glob("p*-s0.png"))) == count - 1


@pytest.mark.parametrize('edit', ['slide', 'theme'])
def test_edits_update_thumbnails_while_check_is_running(shooting, page, monkeypatch, edit):
    import threading
    from slide_studio import background_check, check, theme_shots
    from slide_studio.fsutil import write_atomic
    ws, srv = shooting
    started, release = threading.Event(), threading.Event()
    original = check.check_deck
    def slow_check(*args, **kwargs):
        started.set()
        assert release.wait(30), '検査を解放できなかった'
        return original(*args, **kwargs)
    monkeypatch.setattr(check, 'check_deck', slow_check)
    monkeypatch.setattr(background_check, 'ENABLED', True)
    monkeypatch.setattr(theme_shots, 'ENABLED', False)
    try:
        # 検査中はステータスが「保存済み」以外になるため、プレビューの準備だけを待つ。
        page.goto(f'{srv.url}/deck/talk')
        page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
        assert started.wait(5)
        b = page.locator('#pagestrip button').filter(has_text='まとめ')
        b.click()
        expect(b).to_have_class(re.compile('has-shot'), timeout=10000)
        before = b.locator('img.shot').get_attribute('src')
        folder = shots.shots_dir(ws, 'talk')
        image = folder / before.split('/')[-1].split('?')[0]
        pixels = image.read_bytes()
        t0 = time.monotonic()
        if edit == 'slide':
            path = ws.qmd('talk')
            write_atomic(path, path.read_text().replace('まとめの段落。', '編集後の新しい段落。'))
        else:
            path = ws.themes / 'default.css'
            write_atomic(path, path.read_text() + '\n:root { --paper: #aabbcc; }\n')
        page.wait_for_function('old => { const img = document.querySelector(\'#pagestrip button[aria-current="true"] img.shot\'); return img && img.getAttribute("src") !== old && img.complete && img.naturalWidth; }', arg=before, timeout=10000)
        assert image.read_bytes() != pixels
        assert not release.is_set()
        print(f'{edit}: 保存からサムネイル更新まで {time.monotonic() - t0:.2f}s（検査は停止中）')
        assert not page.errors
    finally:
        release.set()
