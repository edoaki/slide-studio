"""段階表示と揃え：包みの統合、層、解除、履歴、編集時の表示。"""
import pytest

from playwright.sync_api import expect
from e2e.conftest import open_deck
from e2e.test_blocks import frame, go, ready, saved, select, start_edit
from e2e.test_block_ops_js import run


def test_page_counter_stays_centered_with_optional_steps(gui, page):
    from slide_studio.fsutil import write_atomic

    ws, srv = gui
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace(
        '最初の段落。', '::: {data-step="1"}\n最初の段落。\n:::').replace(
        '二番目の段落。', '::: {data-step="2"}\n二番目の段落。\n:::'))
    open_deck(page, srv, raw=False); ready(page)
    number = page.locator('#pageCount')
    steps = page.locator('#stepCount')
    def assert_centered():
        counter = number.bounding_box()
        prev = page.locator('#stepPrev').bounding_box()
        next_ = page.locator('#stepNext').bounding_box()
        center = counter['x'] + counter['width'] / 2
        arrows_center = (prev['x'] + prev['width'] / 2 + next_['x'] + next_['width'] / 2) / 2
        assert abs(center - arrows_center) < 1

    expect(number).to_have_text('1ページ')
    expect(steps).to_be_hidden()
    expect(steps).to_have_text('')
    original = number.bounding_box()
    assert_centered()
    go(page, 2)
    expect(number).to_have_text('3ページ')
    expect(steps).to_be_visible()
    expect(steps).to_have_text('1 / 3')
    page.locator('#stepNext').click()
    expect(steps).to_have_text('2 / 3')
    page.locator('#stepNext').click()
    expect(steps).to_have_text('3 / 3')
    with_steps = number.bounding_box()
    assert_centered()
    page.locator('#stepNext').click()
    expect(number).to_have_text('4ページ')
    expect(steps).to_be_hidden()
    expect(steps).to_have_text('')
    without_steps = number.bounding_box()
    assert_centered()
    for box in (with_steps, without_steps):
        assert abs(box['x'] - original['x']) < 1
        assert abs(box['y'] - original['y']) < 1
        assert abs(box['width'] - original['width']) < 1
    assert not page.errors


def test_wrapper_options_and_padding(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = '## A {#a}\n\n- A\n- B\n\n本文。\n'
    out = run(page, r'''let t = text, key = 'p0/0';
      const apply = async opts => {
        const r = op.setTextOptions(t, await st(t), key, opts); t = r.text;
        key = op.keyAt(await st(t), r.at, r.end);
      };
      await apply({ step: 2, incremental: true });
      await apply({ align: 'center' });
      let r = op.setPad(t, await st(t), key, '8px'); t = r.text;
      key = op.keyAt(await st(t), r.at, r.end);
      const combined = t, s = await st(t), nav = await import('/web/block-nav.js');
      const trail = nav.trail(s, key), up = nav.upKey(s, key);
      r = op.setPad(t, s, key, null); t = r.text; key = op.keyAt(await st(t), r.at, r.end);
      const withoutPad = t;
      await apply({ step: 0, incremental: false }); await apply({ align: 'left' });
      return { combined, withoutPad, trail, up, back: t };
    ''', text)
    assert out['combined'].count('::: {') == 1
    assert '.incremental' in out['combined'] and 'data-step="2"' in out['combined']
    assert 'padding:8px' in out['combined'] and 'text-align:center' in out['combined']
    assert 'padding:' not in out['withoutPad'] and '.incremental' in out['withoutPad']
    assert len(out['trail']) == 2 and out['up'] is None
    assert out['back'] == text


def test_step_numbers_and_compaction(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = ('## A {#a}\n\n{{< fig t/x >}}\n\n::: {data-step="1"}\nB\n:::\n\n'
            'C [x]{.highlight data-highlight-step="3"}\n\n::: {.incremental data-step="1"}\n- i\n- j\n  - k\n:::\n')
    out = run(page, r'''let t = text;
      const choices = async key => { const c = op.stepChoices(t, await st(t), key); return { ...c, others: Object.fromEntries(c.others) }; };
      const set = async (key, opts) => { t = op.setStep(t, await st(t), key, opts).text; return t; };
      const before = await choices('p0/1.0');
      const fig = await choices('p0/0');
      const together = await set('p0/0', { step: 1 });
      const moved = await set('p0/1.0', { step: 0 });
      return { before, fig, together, moved, after: await choices('p0/1') };
    ''', text)
    # 番号は data-step のまま。ほかのもの（1項目ずつの2項目・強調）の段と数
    assert out['before'] == {'step': 1, 'incremental': False, 'count': 1, 'max': 4, 'others': {'1': 1, '2': 1, '3': 1}, 'list': False}
    assert out['fig']['step'] == 0 and out['fig']['max'] == 4
    # 図を段 1 に：本文 B・箇条書きと同時。強調は空いた段 2 を詰めずにそのまま
    assert '{{< fig t/x step="1" >}}' in out['together'] and 'data-highlight-step="3"' in out['together']
    # B を段 0 に：段 1 は図と箇条書きが残るので、番号は変わらない
    assert '::: {data-step="1"}\nB' not in out['moved'] and '\nB\n' in out['moved']
    assert '{{< fig t/x step="1" >}}' in out['moved'] and 'data-highlight-step="3"' in out['moved']


def test_step_choices_have_no_gap(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = '## A {#a}\n\n::: {data-step="1"}\nA\n:::\n\nB [x]{.highlight data-highlight-step="2"}\n\n![](a.png){data-step="3"}\n'
    out = run(page, r'''let t = text;
      const lone = op.stepChoices(t, await st(t), 'p0/0.0');
      t = op.setStep(t, await st(t), 'p0/0.0', { step: 0 }).text;
      return { max: lone.max, text: t };
    ''', text)
    # 段 1 にいるのが自分だけなら、選べるのは 0・1・2・3（ほかの最大 3 の次まで）
    assert out['max'] == 4
    # 自分が段 0 に移ると、空いた段 1 を詰める：強調は 1、画像は 2
    assert 'data-highlight-step="1"' in out['text'] and '![](a.png){data-step="2"}' in out['text']
    assert out['text'].startswith('## A {#a}\n\nA\n\nB')


def test_step_align_ui_and_undo(gui, page):
    ws, srv = gui
    open_deck(page, srv); ready(page); go(page, 2); select(page, 'p2/0')
    bar = page.locator('#blockTools')
    bar.get_by_role('button', name='段階表示', exact=True).click()
    expect(bar.locator('.step-chip')).to_have_text(['0 → ①', '1 → ②'])
    bar.get_by_role('button', name='段 1（新しい段）').click()
    saved(page, 'data-step="1"'); ready(page)
    expect(frame(page).locator('[data-step="1"]')).to_be_visible()
    # 段を付けたものには、スライドと原稿のブロック表示の両方に段の数の印が出る（付けていないものには出ない）
    expect(frame(page).locator('.slide-studio-step-badge')).to_have_count(0)
    expect(page.locator('#qblocks .page.cur .step-badge')).to_have_text(['2'])
    # 段 1 にいるのが自分だけなら、2 は選べない（1 が空いて 2 だけになるため）
    bar.get_by_role('button', name='段階表示', exact=True).click()
    expect(bar.locator('.step-chip')).to_have_text(['0 → ①', '1 → ②'])
    page.keyboard.press('Escape')
    # もう1つの段落を同じ段に：段 1 にほかのものがいると分かる
    select(page, 'p2/1')
    bar.get_by_role('button', name='段階表示', exact=True).click()
    expect(bar.locator('.step-chip')).to_have_text(['0 → ①', '1 → ②', '2 → ③'])
    chip = bar.get_by_role('button', name='段 1・ほかに 1 個')
    chip.hover()
    expect(frame(page).locator('.slide-studio-step-mark')).to_have_count(1)
    chip.click()
    page.wait_for_function("document.querySelector('.raw textarea').value.split('data-step=\"1\"').length === 3")
    saved(page, 'data-step="1"'); ready(page)
    bar.get_by_role('button', name='揃え', exact=True).click()
    saved(page, 'text-align:center'); ready(page)
    assert ws.qmd('talk').read_text().count('data-step=') == 2
    page.keyboard.press('Meta+z')
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('text-align:center')")


def test_figure_step_ui(gui, page):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('二番目の段落。', '{{< fig test/demo >}}'))
    open_deck(page, srv); ready(page); go(page, 2); select(page, 'p2/1')
    bar = page.locator('#blockTools')
    expect(bar.locator('.decoration-tool')).to_have_count(0)
    bar.get_by_role('button', name='段階表示', exact=True).click()
    bar.get_by_role('button', name='段 1（新しい段）').click()
    saved(page, '{{< fig test/demo step="1" >}}'); ready(page)
    expect(frame(page).locator('.animation[data-step="1"]')).to_have_count(1)


def test_alignment_in_text_session(gui, page):
    ws, srv = gui
    open_deck(page, srv); ready(page); go(page, 2); select(page, 'p2/0'); start_edit(page, 'p2/0')
    bar = page.locator('#blockTools')
    bar.get_by_role('button', name='揃え', exact=True).click()
    expect(bar.get_by_role('button', name='揃え', exact=True)).to_have_attribute('data-align', 'center')
    bar.get_by_role('button', name='揃え', exact=True).click()
    saved(page, 'text-align:right')
    bar.get_by_role('button', name='外側を選択').click()
    ready(page)
    page.keyboard.press('Meta+z')
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('text-align:right')")


def test_alignment_cycles_without_menu(gui, page):
    ws, srv = gui
    open_deck(page, srv); ready(page); go(page, 2); select(page, 'p2/0')
    bar = page.locator('#blockTools')
    align = bar.get_by_role('button', name='揃え', exact=True)
    expect(align).to_have_attribute('data-align', 'left')
    for value in ['center', 'right', 'left']:
        align.click()
        expect(align).to_have_attribute('data-align', value)
        expect(bar.get_by_role('group', name='揃え', exact=True)).to_have_count(0)
        if value == 'left':
            page.wait_for_function("!document.querySelector('.raw textarea').value.includes('text-align:')")
            saved(page, '最初の段落。')
        else:
            saved(page, f'text-align:{value}')
        ready(page)
    page.screenshot(path='/tmp/slide-studio-align-cycle.png')
    assert 'text-align:' not in ws.qmd('talk').read_text()


def test_list_incremental_menu(gui, page):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('最初の段落。', '- 最初\n- 次'))
    open_deck(page, srv); ready(page); go(page, 2); select(page, 'p2/0')
    bar = page.locator('#blockTools')
    bar.get_by_role('button', name='段階表示', exact=True).click()
    bar.get_by_role('checkbox', name='1項目ずつ').check()
    saved(page, '.incremental data-step="0"'); ready(page)
    items = frame(page).locator('.incremental > ul > li')
    expect(items.nth(0)).to_have_attribute('data-step', '0')
    expect(items.nth(1)).to_have_attribute('data-step', '1')
    expect(items.nth(1)).to_be_visible()
    bar.get_by_role('button', name='段階表示', exact=True).click()
    expect(bar.get_by_role('checkbox', name='1項目ずつ')).to_be_checked()


FRAME_WIN = 'document.querySelector("#slideBox iframe:not(.loading)").contentWindow'


def test_badge_shape_state_and_click(gui, page):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace(
        '最初の段落。', '::: {data-step="2"}\n最初の段落。\n:::').replace(
        'まとめの段落。', '::: {data-step="3"}\nまとめの段落。\n:::'))
    open_deck(page, srv, raw=False); ready(page); go(page, 2)
    qb = page.locator('#qblocks .page.cur .step-badge')
    sb = frame(page).locator('.slide-studio-step-badge')
    expect(qb).to_have_text('2'); expect(sb).to_have_count(0)
    expect(qb).to_have_class('step-badge pending')
    for badge in (qb,):
        expect(badge.locator('svg')).to_have_count(0)
        style = badge.evaluate("e => { const s = getComputedStyle(e); return [s.backgroundColor, s.color, s.borderStyle, s.borderRadius]; }")
        assert style == ['rgb(255, 255, 255)', 'rgb(31, 99, 214)', 'dashed', '999px']
    for theme in ('dark', 'light'):
        page.evaluate('(theme) => document.documentElement.dataset.theme = theme', theme)
        expect(qb).to_have_css('color', 'rgb(31, 99, 214)')
        assert qb.evaluate('e => Math.abs(e.offsetWidth - e.offsetHeight) <= 1')
    # 原稿側の印で本文入力を始めずに、段メニューを開く。
    qb.click()
    expect(page.locator('#blockTools .step-chips')).to_be_visible()
    expect(page.locator('#qblocks .card.editing')).to_have_count(0)
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(0)
    page.keyboard.press('Escape')
    # 別のカードの入力欄を保ったまま、印だけを更新する。
    page.locator('#qblocks .page.cur .card').filter(has_text='二番目の段落。').click()
    ta = page.locator('#qblocks .card.editing textarea')
    expect(ta).to_be_focused()
    ta.evaluate('e => { window.badgeTestInput = e; e.setSelectionRange(2, 2); }')
    page.evaluate(f'{FRAME_WIN}.deck.goStage(2)')
    expect(qb).to_have_class('step-badge')
    assert ta.evaluate('e => e === window.badgeTestInput && e.selectionStart === 2 && document.activeElement === e')
    for badge in (qb,):
        expect(badge).to_have_css('background-color', 'rgb(31, 99, 214)')
        expect(badge).to_have_css('color', 'rgb(255, 255, 255)')
    page.evaluate(f'{FRAME_WIN}.deck.goStage(0)')
    expect(qb).to_have_class('step-badge pending')
    expect(qb).to_have_attribute('data-tip', '段階表示：段 2（まだ出ていない）・押すと段階表示を変える')
    # 現在以外のページの印は塗り。
    expect(page.locator('#qblocks .page.dormant .step-badge.pending')).to_have_count(0)
    assert not page.errors


def test_figure_badge_range_and_incremental(gui, page):
    from slide_studio import figures
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    figures.new_figure(ws, 'box', ws.shelf_dir('test'))
    # load の時点で animation.steps が確定する図。途中状態は5回送る。
    fig = ws.shelf_dir('test') / 'box' / 'figure.mjs'
    write_atomic(fig, fig.read_text().replace("steps: ['入力を表示', '処理を表示', '結果を表示']", "steps: ['0', '1', '2', '3', '4', '5']"))
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace(
        '最初の段落。', '{{< fig test/box step="3" >}}').replace(
        '二番目の段落。', '::: {.incremental data-step="4"}\n- 次\n- 最後\n:::'))
    open_deck(page, srv, raw=False); ready(page); go(page, 2)
    qb = page.locator('#qblocks .page.cur .step-badge')
    sb = frame(page).locator('.slide-studio-step-badge')
    expect(qb).to_have_text(['2–7', '8–9'])
    expect(sb).to_have_count(0)
    expect(qb.nth(0)).to_have_attribute('data-tip', '段階表示：段 3（図の中で 5 回送る）（まだ出ていない）・押すと段階表示を変える')
    # 図内を送っている間は後続の段4の印を白抜きのままにする。
    page.evaluate(f'{FRAME_WIN}.deck.go(2, 5)')
    expect(qb.nth(0)).to_have_class('step-badge')
    expect(qb.nth(1)).to_have_class('step-badge pending')
    qb.nth(0).click()
    expect(page.locator('#blockTools .step-chips')).to_be_visible()
    expect(frame(page).locator('.animation.slide-studio-selected')).to_have_count(1)
    qb.nth(1).click()
    expect(page.locator('#blockTools .step-chips')).to_be_visible()
    expect(page.locator('#blockTools .step-tools input[type=checkbox]')).to_be_checked()
    import os
    if path := os.environ.get('STEP_BADGE_SCREENSHOT'):
        page.keyboard.press('Escape')
        page.mouse.move(1100, 100)
        page.screenshot(path=path, full_page=True)
    # 未読み込み相当→N=0→N=5 の更新。deckchange で両側とも再取得する。
    for n, label in [(None, '2'), (0, '2'), (5, '2–7')]:
        page.evaluate(f"""n => {{ const w = {FRAME_WIN}; const f = w.document.querySelector('.slide.active iframe');
          f.contentWindow.animation.steps = n; w.dispatchEvent(new CustomEvent('deckchange', {{detail:{{index:w.deck.index, step:w.deck.step, maxStep:w.deck.maxStep()}}}})); }}""", n)
        expect(qb.nth(0)).to_have_text(label); expect(sb).to_have_count(0)
    assert not page.errors


def test_badge_late_figure_load(gui, page):
    from slide_studio import figures
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    figures.new_figure(ws, 'late', ws.shelf_dir('test'))
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace(
        '最初の段落。', '{{< fig test/late step="3" >}}'))
    held = []
    page.route('**/late/figure.mjs*', lambda route: held.append(route))
    open_deck(page, srv, raw=False); ready(page)
    # 図の読み込み完了を待たずに移動し、最初は段だけ表示。
    page.evaluate(f'() => {{ void {FRAME_WIN}.deck.go(2); }}')
    qb = page.locator('#qblocks .page.cur .step-badge')
    sb = frame(page).locator('.slide-studio-step-badge')
    expect(qb).to_have_text('2'); expect(sb).to_have_count(0)
    for _ in range(100):
        if held:
            break
        page.wait_for_timeout(20)
    assert held
    for route in held:
        route.continue_()
    # プレイヤーが発行する本物の deckchange に追従。
    expect(qb).to_have_text('2–4'); expect(sb).to_have_count(0)
    assert not page.errors


def test_initial_figure_and_reverse_display_order(gui, page):
    from slide_studio import figures
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    figures.new_figure(ws, 'first', ws.shelf_dir('test'))
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace(
        '最初の段落。', '::: {data-step="2"}\n上の文字。\n:::\n\n{{< fig test/first >}}').replace(
        '二番目の段落。', '::: {data-step="1"}\n下の文字。\n:::'))
    open_deck(page, srv, raw=False); ready(page); go(page, 2)
    qb = page.locator('#qblocks .page.cur .step-badge')
    sb = frame(page).locator('.slide-studio-step-badge')
    expect(qb).to_have_text(['5', '1–3', '4'])
    expect(sb).to_have_count(0)
    expect(page.locator('#stepCount')).to_have_text('1 / 5')
    page.evaluate(f'{FRAME_WIN}.deck.go(2, 3)')
    expect(qb.nth(0)).to_have_class('step-badge pending')
    expect(qb.nth(2)).to_have_class('step-badge')
    page.evaluate(f'{FRAME_WIN}.deck.go(2, 4)')
    expect(qb.nth(0)).to_have_class('step-badge')
    qb.nth(0).click()
    expect(page.locator('#blockTools .step-chip')).to_have_text(['0 → ①', '1 → ④', '2 → ⑤'])
    assert not page.errors


def test_simultaneous_figures_share_start_and_wait_for_longest(gui, page):
    from slide_studio import figures
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    for name in ('short', 'long'):
        figures.new_figure(ws, name, ws.shelf_dir('test'))
    fig = ws.shelf_dir('test') / 'long' / 'figure.mjs'
    write_atomic(fig, fig.read_text().replace("steps: ['入力を表示', '処理を表示', '結果を表示']", "steps: ['0', '1', '2', '3', '4', '5']"))
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace(
        '最初の段落。', '{{< fig test/short step="1" >}}\n\n{{< fig test/long step="1" >}}\n\n::: {data-step="1"}\n同時の文字。\n:::').replace(
        '二番目の段落。', '::: {data-step="2"}\n最後の文字。\n:::'))
    open_deck(page, srv, raw=False); ready(page); go(page, 2)
    qb = page.locator('#qblocks .page.cur .step-badge')
    sb = frame(page).locator('.slide-studio-step-badge')
    for badges in (qb,):
        expect(badges).to_have_text(['2–4', '2–7', '2', '8'])
    page.evaluate(f"""() => {{ const w = {FRAME_WIN};
      for (const f of w.document.querySelectorAll('.slide.active iframe')) {{
        const a = f.contentWindow.animation, original = a.setStep.bind(a);
        a.setStep = (n, animate) => {{ a.testStep = n; return original(n, animate); }};
      }}
    }}""")
    page.evaluate(f'{FRAME_WIN}.deck.go(2, 6)')
    expect(qb.nth(2)).to_have_class('step-badge')
    expect(qb.nth(3)).to_have_class('step-badge pending')
    assert page.evaluate(f"[...{FRAME_WIN}.document.querySelectorAll('.slide.active iframe')].map(f => f.contentWindow.animation.testStep)") == [2, 5]
    page.evaluate(f'{FRAME_WIN}.deck.go(2, 7)')
    expect(qb.nth(3)).to_have_class('step-badge')
    assert not page.errors


@pytest.mark.parametrize('prefix', ['', '😀'])
def test_pdf_step_checkbox_writes_heading(gui, page, prefix):
    """step の帯のチェックで、見出しの pdf="…" に PDF に入れる step を書く。最後の step は常に入る。"""
    from slide_studio.fsutil import write_atomic

    ws, srv = gui
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('title: "テスト発表"', f'title: "{prefix}テスト発表"').replace(
        '最初の段落。', '::: {data-step="1"}\n最初の段落。\n:::').replace(
        '二番目の段落。', '::: {data-step="2"}\n二番目の段落。\n:::'))
    open_deck(page, srv)
    wrap, box = page.locator('#pdfStepWrap'), page.locator('#pdfStep')
    expect(wrap).to_have_class('pdf-step off')
    go(page, 2)
    expect(page.locator('#stepCount')).to_have_text('1 / 3')
    expect(wrap).to_have_class('pdf-step')
    expect(box).not_to_be_checked()
    expect(wrap).to_have_attribute('data-tip', 'PDF に入れる')
    box.check()
    saved(page, '## 一枚目 {#one pdf="1"}')
    page.locator('#stepNext').click(); page.locator('#stepNext').click()
    expect(page.locator('#stepCount')).to_have_text('3 / 3')
    expect(box).to_be_checked()
    expect(box).to_be_disabled()
    expect(wrap).to_have_attribute('data-tip', 'PDF に入れる（最後の step は常に入る）')
    page.locator('#stepPrev').click()
    box.check()
    saved(page, '## 一枚目 {#one pdf="1 2"}')
    page.locator('#stepPrev').click()
    expect(box).to_be_checked()
    box.uncheck()
    saved(page, '## 一枚目 {#one pdf="2"}')
    assert page.evaluate('document.querySelector("#slideBox iframe:not(.loading)").contentWindow.deck.pdfSteps(2)') == [1, 2]
    assert not page.errors


def test_pdf_step_keeps_marks_after_edit_before_preview_refresh(gui, page):
    """保存待ちの原稿を編集しても、追加済みの PDF の印を次の操作で失わない。"""
    from slide_studio.fsutil import write_atomic
    from e2e.conftest import rendered

    ws, srv = gui
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace(
        '最初の段落。', '::: {data-step="1"}\n最初の段落。\n:::').replace(
        '二番目の段落。', '::: {data-step="2"}\n二番目の段落。\n:::'))
    open_deck(page, srv)
    go(page, 2)
    box, raw = page.locator('#pdfStep'), page.locator('.raw textarea')
    pending = []
    hold = True
    page.route('**/api/deck/talk/source', lambda route: pending.append(route)
               if hold and route.request.method == 'PUT' else route.continue_())
    with page.expect_request(lambda r: r.method == 'PUT' and r.url.endswith('/source')):
        box.check()
    assert 'pdf="1"' in raw.input_value()
    # 本文の入力が入ると、PDF の印を付けた直後の原稿とは一致しなくなる。
    raw.fill(raw.input_value().replace('最初の段落。', '編集した段落。'))
    raw.blur()
    page.locator('#pagestrip button[data-index="2"]').click()
    page.locator('#stepNext').click()
    expect(page.locator('#stepCount')).to_have_text('2 / 3')
    box.check()
    expect(box).to_be_enabled()
    assert 'pdf="1 2"' in raw.input_value()
    hold = False
    for route in pending:
        route.continue_()
    expect(page.locator('#status')).to_have_text('保存済み')
    rendered(page, ws)
    assert '## 一枚目 {#one pdf="1 2"}' in ws.qmd('talk').read_text()
    assert '編集した段落。' in ws.qmd('talk').read_text()
    assert not page.errors


@pytest.mark.parametrize('kind', ['box', 'column', 'columns'])
def test_container_step_preserves_children(gui, page, kind):
    _, srv = gui
    page.goto(srv.url)
    attrs = '#group style="padding:8px"'
    text = (f'## A {{#a}}\n\n:::: {{{attrs}}}\n'
            '::: {data-step="3"}\n子。\n:::\n\n'
            '[強調]{.highlight data-highlight-step="4"}\n::::\n\n'
            '::: {data-step="5"}\n後。\n:::\n')
    key = 'p0/0'
    if kind != 'box':
        text = text.replace(f':::: {{{attrs}}}', ':::::: {.columns}\n::::: {.column width="60%"}').replace('\n::::\n', '\n:::::\n::::::\n')
        attrs = '.columns' if kind == 'columns' else '.column width="60%"'
        key = 'p0/0' if kind == 'columns' else 'p0/0.0'
    out = run(page, '''
      const before = op.stepChoices(text, await st(text), 'KEY');
      const added = op.setStep(text, await st(text), 'KEY', { step: 1 });
      const state = op.stepState(added.text, op.find(await st(added.text), 'KEY').chunk);
      const removed = op.setStep(added.text, await st(added.text), 'KEY', { step: 0 });
      return { others: Object.fromEntries(before.others), added, state, removed };
    '''.replace('KEY', key), text)
    assert out['others'] == {'3': 1, '4': 1, '5': 1}
    assert out['state'] == {'step': 1, 'incremental': False}
    assert f'{{{attrs} data-step="1"}}' in out['added']['text']
    assert 'data-step="2"}\n子。' in out['added']['text']
    assert 'data-highlight-step="3"' in out['added']['text']
    assert 'data-step="4"}\n後。' in out['added']['text']
    assert out['removed']['text'] == text.replace('data-step="3"', 'data-step="1"').replace('data-highlight-step="4"', 'data-highlight-step="2"').replace('data-step="5"', 'data-step="3"')


def test_container_step_ui_and_undo(gui, page):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace(
        '最初の段落。', '::: {.row}\n最初の段落。\n\n囲みの本文。\n:::'))
    open_deck(page, srv, raw=False); ready(page); go(page, 2)
    select(page, 'p2/0.0')
    page.locator('#blockTools').get_by_role('button', name='外側を選択', exact=True).click()
    bar = page.locator('#blockTools')
    bar.get_by_role('button', name='段階表示', exact=True).click()
    bar.get_by_role('button', name='段 1（新しい段）').click()
    saved(page, '.row data-step="1"'); ready(page)
    expect(frame(page).locator('.row')).to_have_attribute('data-step', '1')
    expect(page.locator('#qblocks .page.cur .step-badge')).to_have_text(['2'])
    page.locator('#qblocks .page.cur .step-badge').click()
    bar.get_by_role('button', name='段 0（最初から）', exact=True).click()
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('data-step=')")
    page.keyboard.press('Meta+z')
    saved(page, '.row data-step="1"')
