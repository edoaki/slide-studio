from types import SimpleNamespace

from slide_studio.shots import Shooter


def test_visible_first_images_then_steps_and_scroll(ws):
    shooter = Shooter(SimpleNamespace(ws=ws))
    remaining = {0: [0], 2: [1, 2], 7: [0], 8: [0]}
    shooter.prioritize('talk', [2, 8, 7])
    assert shooter.next_shot('talk', remaining) == (8, 0)
    del remaining[8]
    assert shooter.next_shot('talk', remaining) == (7, 0)
    del remaining[7]
    assert shooter.next_shot('talk', remaining) == (2, 1)
    # 撮影中にスクロールすると、まだ撮っていない画面内のページへ切り替わる。
    shooter.prioritize('talk', [0])
    assert shooter.next_shot('talk', remaining) == (0, 0)


def test_pending_deck_before_background_samples(ws, monkeypatch):
    from slide_studio import shots
    import threading
    order = []
    shooter = Shooter(SimpleNamespace(ws=ws, decks={'talk': SimpleNamespace(rendered=object())}))
    # 両ワーカーの開始前に依頼を積み、発表の撮影完了まで見本が始まらないことを検証する。
    shooter.thread = threading.Thread(target=shooter.run)
    shooter.job_thread = threading.Thread(target=shooter.run_jobs)
    monkeypatch.setattr(ws, 'has_deck', lambda deck: True)
    monkeypatch.setattr(shots.check, 'Browser', lambda: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(shots, 'StaticServer', lambda root: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(shooter, 'shoot', lambda *args: order.append('deck'))
    def sample(browser):
        order.append('sample')
    future = shooter.submit(sample, background=True)
    shooter.request('talk')
    shooter.job_thread.start()
    shooter.thread.start()
    try:
        future.result(timeout=2)
    finally:
        shooter.stop()
    assert order == ['deck', 'sample']
    assert future.done() and future.exception() is None


def test_interrupted_steps_are_not_cached_as_complete(ws, monkeypatch):
    from slide_studio import shots
    shooter = Shooter(SimpleNamespace(ws=ws))
    captures = []
    position = [0, 0]
    def evaluate(script, args=None):
        if script == shots.SPLIT:
            return ['<head/>', '<section/>']
        if script == 'deck.count':
            return 1
        if script == 'deck.maxStep()':
            return 2
        if isinstance(args, list):
            position[:] = args[:2]
    def screenshot():
        captures.append(tuple(position))
        return b'png'
    page = SimpleNamespace(add_init_script=lambda *a: None, goto=lambda *a, **kw: None,
                           wait_for_function=lambda *a, **kw: None, evaluate=evaluate, screenshot=screenshot)
    ctx = SimpleNamespace(route=lambda *a: None, new_page=lambda: page, close=lambda: None)
    browser = SimpleNamespace(browser=SimpleNamespace(new_context=lambda **kw: ctx))
    server = SimpleNamespace(origin='http://local', overrides={}, url=lambda p: p)
    rendered = SimpleNamespace(doc=SimpleNamespace(text=''), html='')
    monkeypatch.setattr(shots.check, 'deck_version', lambda *a: {'deps': 'version'})
    def interrupt(deck):
        if shots._load_index(ws, deck)[0]['steps'] == 3:
            shooter.pending.append(deck)
    monkeypatch.setattr(shooter, 'notify', interrupt)
    shooter.shoot('talk', rendered, browser, server)
    assert captures == [(0, 0)]
    assert shots._load_index(ws, 'talk') == [{'hash': '', 'steps': 3}]
    # 中断後は未撮影の段を取りこぼさず、新しい撮影を最後まで完了する。
    shooter.pending.clear()
    monkeypatch.setattr(shooter, 'notify', lambda deck: None)
    shooter.shoot('talk', rendered, browser, server)
    assert captures[1:] == [(0, 0), (0, 1), (0, 2)]
    assert shots._load_index(ws, 'talk')[0]['hash']


def test_checks_cannot_overwrite_thumbnail_cache(ws):
    import json
    from slide_studio import shots
    from slide_studio.fsutil import write_atomic
    old = ws.build_dir('talk') / 'shots/p01-s0.png'
    write_atomic(old, b'old check')
    assert '/shots/' in shots.cover_listing(ws, 'talk')[0]
    folder = shots.shots_dir(ws, 'talk')
    write_atomic(folder / 'p01-s0.png', b'new thumbnail')
    write_atomic(folder / shots.INDEX, json.dumps({'slides': [{'hash': 'new', 'steps': 1}]}))
    before = shots.listing(ws, 'talk')
    write_atomic(old, b'late check')
    assert shots.listing(ws, 'talk') == before
    assert shots.cover_listing(ws, 'talk') == [before[0][0]]
    assert (folder / 'p01-s0.png').read_bytes() == b'new thumbnail'


def test_visible_thumbnail_does_not_wait_for_hidden_frame(ws, monkeypatch):
    import time
    from bs4 import BeautifulSoup
    from conftest import add_deck
    from slide_studio import check, httpd
    from slide_studio.render import render_deck
    add_deck(ws, 'talk', '---\ntitle: Talk\ntopic: test\n---\n\n## A {#a}\n\n本文。\n\n## B {#b}\n\n表示中。\n')
    rendered = render_deck(ws, 'talk')
    html = BeautifulSoup(rendered.html, 'html.parser')
    frame = html.new_tag('iframe', src='/slow.html')
    html.select('#stage > .slide')[0].append(frame)
    rendered.html = str(html)
    shooter = Shooter(SimpleNamespace(ws=ws))
    shooter.prioritize('talk', [1])
    captured = []
    def notify(deck):
        from slide_studio.shots import listing
        if any(any(s) for s in listing(ws, deck)):
            captured.append(time.monotonic())
            shooter.pending.append(deck)  # 画面外の撮影に移る前に止める
    monkeypatch.setattr(shooter, 'notify', notify)
    monkeypatch.setitem(httpd.DELAYS, '/slow.html', 5)
    server, browser = httpd.StaticServer(ws.root), check.Browser()
    server.overrides['/slow.html'] = b'<html><body>slow</body></html>'
    try:
        start = time.monotonic()
        shooter.shoot('talk', rendered, browser, server)
        assert len(captured) == 1 and captured[0] - start < 5
    finally:
        browser.close()
        server.close()
