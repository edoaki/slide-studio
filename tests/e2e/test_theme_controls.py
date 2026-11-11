from playwright.sync_api import expect

from .conftest import open_deck, open_theme


def add_plain_theme(ws):
    """見出しの塗りも線もない、白地のテーマ。"""
    from slide_studio.fsutil import write_atomic
    from slide_studio.workspace import TEMPLATES
    css = (TEMPLATES / 'themes/_base.css').read_text().replace('--ink: #233244', '--ink: #444444').replace('--header: #174b78', '--header: #333333')
    write_atomic(ws.themes / 'plainhead.css', css + '#stage h2{color:var(--header);background:none;border:0}#stage :is(.cover-title,.section-slide){color:var(--header)}\n')


def theme_color(page):
    return page.evaluate("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--ink').trim()")


def test_theme_tab_allows_slide_content_editing(page, gui):
    from .test_blocks import ready, go, select, frame, start_edit, saved

    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    ready(page)
    go(page, 2)
    select(page, 'p2/0')
    open_theme(page)
    expect(page.locator('#blockTools')).to_be_visible()
    start_edit(page, 'p2/0')
    block = frame(page).locator('[data-slide-studio="p2/0"]')
    block.fill('テーマ編集中の本文。')
    page.keyboard.press('Escape')
    saved(page, 'テーマ編集中の本文。')
    expect(page.get_by_role('tab', name='テーマ', exact=True)).to_have_attribute('aria-selected', 'true')
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', 'テーマ編集中の本文。')
    ready(page)
    page.locator('#blockTools').get_by_role('button', name='削除', exact=True).click()
    page.wait_for_function("!document.querySelector('.raw textarea').value.includes('テーマ編集中の本文。')")
    expect(page.locator('#status')).to_have_text('保存済み')
    assert 'テーマ編集中の本文。' not in ws.qmd('talk').read_text()
    page.locator('#undo').click()
    saved(page, 'テーマ編集中の本文。')
    assert not page.errors


def test_save_edited_theme_on_reset(page, gui):
    ws, srv = gui
    original = (ws.themes / 'default.css').read_text()
    open_deck(page, srv, raw=False)
    open_theme(page)
    expect(page.locator('.tv-register')).to_have_count(0)
    reset = page.locator('.tv-default')
    expect(reset).to_be_disabled()
    page.locator('.theme-fields input[name="--ink"]').evaluate("(e) => { e.value = '#112233'; e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true})); }")
    expect(reset).to_be_enabled()
    edited = (ws.themes / 'default.css').read_text()
    reset.click()
    page.get_by_role('button', name='やめる', exact=True).click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    assert (ws.themes / 'default.css').read_text() == edited
    reset.click()
    page.get_by_label('テーマ名（英小文字・数字・ハイフン）', exact=True).fill('default')
    page.get_by_role('button', name='保存して戻す', exact=True).click()
    expect(page.get_by_role('dialog').get_by_role('alert')).to_have_text('同じ名前のテーマがあります')
    assert (ws.themes / 'default.css').read_text() == edited
    page.get_by_label('テーマ名（英小文字・数字・ハイフン）', exact=True).fill('mine')
    page.get_by_role('button', name='保存して戻す', exact=True).click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    expect(reset).to_be_disabled()
    expect(page.locator('.tv-themes [data-theme="mine"]')).to_be_visible()
    assert ws.deck_theme('talk') == 'default'
    assert (ws.themes / 'mine.css').read_text() == edited
    assert (ws.themes / 'default.css').read_text() == original
    page.locator('#undo').click()
    expect(reset).to_be_enabled()
    assert (ws.themes / 'default.css').read_text() == edited
    assert (ws.themes / 'mine.css').read_text() == edited
    reset.click()
    page.get_by_role('button', name='保存せずに戻す', exact=True).click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    expect(reset).to_be_disabled()
    assert (ws.themes / 'default.css').read_text() == original
    expect(page.locator('.tv-themes .theme-remove')).to_have_count(0)
    assert not page.errors


def test_switch_theme_without_reloading_frame_and_undo(page, gui):
    from .conftest import rendered
    from .test_blocks import ready

    ws, srv = gui
    open_deck(page, srv, raw=False)
    before = theme_color(page)
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.themeMarker = 42")
    open_theme(page)
    expect(page.locator('.tv-themes [aria-pressed=true]')).to_have_attribute('data-theme', 'default')
    held = []
    page.route('**/files/themes/night.css?*', lambda route: held.append(route))
    page.get_by_role('button', name='「night」を選ぶ', exact=True).click()
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('link[media=\"not all\"]') !== null")
    assert theme_color(page) == before
    page.unroute('**/files/themes/night.css?*')
    page.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--ink').trim() !== " + repr(before))
    expect(page.locator('.tv-themes [aria-pressed=true]')).to_have_attribute('data-theme', 'night')
    assert ws.deck_theme('talk') == 'night'
    rendered(page, ws)
    ready(page)
    assert page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.themeMarker") == 42
    page.locator('#undo').click()
    expect(page.locator('.tv-themes [aria-pressed=true]')).to_have_attribute('data-theme', 'default')
    assert ws.deck_theme('talk') == 'default'
    page.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--ink').trim() === " + repr(before))
    assert not page.errors


def test_theme_strip_lists_recently_chosen_first(page, gui):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    names = "[...document.querySelectorAll('.tv-themes [data-theme]')].map(b => b.dataset.theme)"
    page.wait_for_function(names + "[0] === 'default'")
    assert page.evaluate(names) == ['default', *[n for n in ws.themes_list() if n != 'default']]
    assert page.locator('.tv-themes').evaluate('(e) => getComputedStyle(e).overflowX') == 'auto'
    page.get_by_role('button', name='「terracotta」を選ぶ', exact=True).click()
    expect(page.locator('.tv-themes [aria-pressed=true]')).to_have_attribute('data-theme', 'terracotta')
    page.get_by_role('button', name='「night」を選ぶ', exact=True).click()
    expect(page.locator('.tv-themes [aria-pressed=true]')).to_have_attribute('data-theme', 'night')
    # 開いている間は並びを動かさない
    assert page.evaluate(names)[0] == 'default'
    page.get_by_role('tab', name='スライド', exact=True).click()
    open_theme(page)
    page.wait_for_function(names + "[0] === 'night'")
    assert page.evaluate(names)[:3] == ['night', 'terracotta', 'default']
    assert not page.errors


def test_theme_color_change_keeps_page_drag_available(page, gui):
    from .conftest import rendered
    from .test_theme_color_picker import settled

    ws, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_label('本文', exact=True).fill('#112233')
    settled(page, '--ink', '#112233')
    page.get_by_role('tab', name='スライド', exact=True).click()
    source = page.locator('#pagestrip button').filter(has_text='二枚目')
    target = page.locator('#pagestrip button').filter(has_text='一枚目')
    source.drag_to(target, target_position={'x': 4, 'y': 25})
    expect(page.locator('#pagestrip button[data-index="2"]')).to_contain_text('二枚目')
    expect(page.locator('#status')).to_have_text('保存済み')
    rendered(page, ws)
    text = ws.qmd('talk').read_text()
    assert text.index('## 二枚目') < text.index('## 一枚目')
    assert not page.errors


def test_theme_save_finishes_when_preview_is_replaced(page, gui):
    from slide_studio.fsutil import write_atomic
    from .conftest import rendered

    ws, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    old = next(f for f in page.frames if '__slide-studio_preview__.html' in f.url)
    held = []
    page.route('**/files/themes/default.css?*', lambda route: held.append(route)
               if route.request.frame == old else route.continue_())
    try:
        with page.expect_request(lambda r: r.resource_type == 'stylesheet' and r.frame == old):
            page.get_by_label('見出しの背景', exact=True).fill('#aabbcc')
        # CSS の読み替え待ちに原稿が変わり、旧 iframe が新しいプレビューに置き換わる。
        path = ws.qmd('talk')
        write_atomic(path, path.read_text().replace('最初の段落。', '外で編集した段落。'))
        rendered(page, ws)
        assert old.is_detached()
        page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
        page.get_by_label('見出しの背景', exact=True).fill('#abcdef')
        page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
        assert '--header: #abcdef' in (ws.themes / 'default.css').read_text()
        assert not page.errors
    finally:
        # 旧 iframe の除去だけでは Playwright 側の route 待機は完了しない。
        for route in held:
            route.abort()
        page.unroute('**/files/themes/default.css?*')


def point_color(editor, value):
    editor.get_by_label('色', exact=True).click()
    code = editor.locator('.tv-inline-color').get_by_label('カラーコード', exact=True)
    code.fill(value); code.press('Enter')


def test_gradient_point_color_saves_without_closing(page, gui):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    editor = page.locator('.gradient-editor')
    editor.get_by_role('button', name='左右', exact=True).click()
    page.locator('.gradient-point').last.click()
    editor.get_by_label('色', exact=True).click()
    picker = editor.locator('.tv-inline-color')
    expect(picker).to_be_visible()
    picker.get_by_role('button', name='#ef4444 を使う', exact=True).click()
    # ✓で閉じなくても、選んだときにテーマへ書く
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    assert '#ef4444' in (ws.themes / 'default.css').read_text()
    expect(editor.get_by_label('色', exact=True)).to_have_value('#ef4444')
    # Esc は色の欄だけを閉じ、グラデーションの編集は続ける
    picker.get_by_label('カラーコード', exact=True).press('Escape')
    expect(picker).to_have_count(0)
    expect(editor).to_be_visible()
    assert not page.errors


def sample(page, js):
    return page.evaluate(f"(() => {{ const w = document.querySelector('.theme-sample iframe:not(.loading)').contentWindow; return {js}; }})()")


def test_theme_tab_sample_marks_and_undo(page, gui):
    ws, srv = gui
    # 既存の発表を通常の複製経路で作る（置き場の内部名に依存しない）。
    ws.new_deck('other', ws.deck_shelf('talk'), source_deck='talk')
    open_deck(page, srv, raw=False)
    other = page.context.browser.new_page(viewport={'width': 1500, 'height': 900})
    open_deck(other, srv, deck='other', raw=False)
    before = theme_color(page)
    css = (ws.themes / 'default.css').read_text()
    open_theme(page)
    expect(page.locator('.theme-view')).not_to_contain_text('このテーマを使う発表：')
    expect(page.locator('.theme-stagebar')).to_be_hidden()
    expect(page.locator('#slideBox')).to_be_visible()
    expect(page.locator('.theme-sample')).to_be_hidden()
    assert page.locator('[data-mode="sample"]').count() == 0
    # 欄を押すと、その欄のページに移り、効いている所を囲む（押すと開く色の選択画面はテストでは開かない）
    page.locator('label[data-key="--mark"]').dispatch_event('pointerdown')
    page.wait_for_function("document.querySelector('.theme-sample iframe:not(.loading)').contentWindow.deck?.index === 2")
    page.wait_for_function("document.querySelector('.theme-sample iframe:not(.loading)').contentDocument.querySelectorAll('#slide-studio-theme-marks i').length > 0")
    page.locator('label[data-key="--ink"]').dispatch_event('pointerdown')
    expect(page.locator('#slideBox')).to_be_visible()
    expect(page.locator('.theme-sample')).to_be_hidden()
    visible = page.locator('#pagestrip button:visible')
    assert 0 < visible.count() < page.locator('#pagestrip button').count()
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.themeMarker = 77")
    # 変えたらすぐ書き、同じテーマの別の発表も変わる
    page.locator('input[name="--ink"]').fill('#123456')
    page.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--ink').trim() === '#123456'")
    other.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--ink').trim() === '#123456'")
    assert '--ink: #123456' in (ws.themes / 'default.css').read_text()
    # 欄にフォーカスがあっても ⌘Z で戻る
    page.locator('input[name="--ink"]').focus()
    page.keyboard.press('Meta+z')
    other.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--ink').trim() === " + repr(before))
    assert (ws.themes / 'default.css').read_text() == css
    expect(page.locator('input[name="--ink"]')).to_have_value('#233244')
    page.keyboard.press('Meta+Shift+z')
    other.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--ink').trim() === '#123456'")
    # 実際のスライドに切り替える
    page.get_by_role('button', name='すべてのページ', exact=True).click()
    expect(page.locator('.theme-stagebar')).to_be_hidden()
    assert page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.themeMarker") == 77
    assert page.locator('#pagestrip button:visible').count() == page.locator('#pagestrip button').count()
    expect(page.locator('#slideBox')).to_be_visible()
    expect(page.locator('.theme-sample')).to_be_hidden()
    other.close()
    assert not page.errors


def test_theme_font_samples_and_filtered_navigation(page, gui):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    choices = page.get_by_role('group', name='本文のフォント', exact=True)
    expect(choices).to_be_visible()
    assert choices.locator('.tv-font-sample').count() == 3
    assert set(choices.locator('.tv-font-sample').all_text_contents()) == {'ひらがな 漢字 100 English'}
    fonts = choices.locator('.tv-font-sample').evaluate_all('(els) => els.map(e => e.style.fontFamily)')
    assert len(set(fonts)) == len(fonts)
    choices.locator('button').nth(1).click()
    expect(choices.locator('button').nth(1)).to_have_attribute('aria-pressed', 'true')
    page.locator('label[data-key="--ink"]').dispatch_event('pointerdown')
    indices = page.locator('#pagestrip button:visible').evaluate_all('(els) => els.map(e => +e.dataset.index)')
    assert 0 < len(indices) < page.locator('#pagestrip button').count()
    for _ in range(len(indices) + 1):
        page.locator('#stage').click(position={'x': 10, 'y': 10})
        page.keyboard.press('ArrowDown')
        current = page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.index")
        assert current in indices
    page.get_by_role('tab', name='スライド', exact=True).click()
    assert page.locator('#pagestrip button:visible').count() == page.locator('#pagestrip button').count()
    open_theme(page)
    expect(page.locator('#slideBox')).to_be_visible()
    assert page.locator('#pagestrip button:visible').count() == page.locator('#pagestrip button').count()
    assert not page.errors


def test_font_change_keeps_content_page_and_marks_on_text(page, gui):
    _, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    choices = page.get_by_role('group', name='本文のフォント', exact=True)
    expect(choices).to_be_visible()
    page.evaluate("""() => {
        const w = document.querySelector('#slideBox iframe:not(.loading)').contentWindow;
        window.fontPageChanges = [];
        w.addEventListener('deckchange', e => fontPageChanges.push(e.detail.index));
    }""")
    choices.locator('button').nth(1).click()
    # 表紙のページ番号だけを本文扱いしない。本当の本文があるページへ一度だけ移る。
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.index === 2")
    indices = page.locator('#pagestrip button:visible').evaluate_all('(els) => els.map(e => +e.dataset.index)')
    assert 0 not in indices and 1 not in indices
    choices.locator('button').nth(2).click()
    result = page.evaluate("""async () => {
        const w = document.querySelector('#slideBox iframe:not(.loading)').contentWindow;
        const errors = [];
        for (let i = 0; i < 60; i++) {
            await new Promise(requestAnimationFrame);
            const rects = [...w.document.querySelectorAll('.slide.active p')].flatMap(p => {
                const r = w.document.createRange(); r.selectNodeContents(p); return [...r.getClientRects()];
            });
            const marks = [...w.document.querySelectorAll('#slide-studio-theme-marks i')];
            if (marks.length !== 1) errors.push({frame:i, count:marks.length});
            for (const mark of marks) {
                const m = mark.getBoundingClientRect();
                if (!rects.some(r => Math.abs(m.left - (r.left - 3)) < 1 && Math.abs(m.top - (r.top - 3)) < 1))
                    errors.push({frame:i, left:m.left, top:m.top, rects:rects.map(r => ({left:r.left, top:r.top}))});
            }
        }
        return {errors, changes:fontPageChanges, index:w.deck.index};
    }""")
    assert result['errors'] == []
    assert result['index'] == 2
    assert result['changes'] and set(result['changes']) == {2}
    assert not page.errors


def test_heading_font_skips_hidden_headings(page, gui):
    _, srv = gui
    open_deck(page, srv, raw=False)
    # 表紙のタイトルが本文フォントを使うテーマを再現する。
    page.evaluate("""() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        doc.querySelector('.cover-title').style.fontFamily = 'var(--font-body)';
    }""")
    open_theme(page)
    choices = page.get_by_role('group', name='見出しのフォント', exact=True)
    choices.locator('button').nth(1).click()
    # 表紙には非表示の h2 がある。見える見出しのある本編へ移動する。
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.index === 1")
    indices = page.locator('#pagestrip button:visible').evaluate_all('(els) => els.map(e => +e.dataset.index)')
    assert 0 not in indices and 1 in indices and 2 in indices
    page.wait_for_function("""() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        const marks = [...doc.querySelectorAll('#slide-studio-theme-marks i')];
        return marks.length > 0 && marks.every(m => m.getBoundingClientRect().width > 10);
    }""")
    assert not page.errors


def test_theme_marks_stay_aligned_after_sample_navigation_and_resize(page, gui):
    from slide_studio.fsutil import write_atomic
    ws, srv = gui
    text = ws.qmd('talk').read_text().replace('最初の段落。', '本文の中の**強調する文字**。').replace('左の列。', '本文の中の**強調する文字**。')
    write_atomic(ws.qmd('talk'), text)
    add_plain_theme(ws)
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='「plainhead」を選ぶ', exact=True).click()
    page.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--ink').trim() === '#444444'")
    open_theme(page)
    for width, height in [(1500, 900), (1200, 1000), (1800, 800)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.locator('label[data-key="--mark"]').dispatch_event('pointerdown')
        expect(page.locator('.theme-sample')).to_be_visible()
        page.locator('label[data-key="--accent"]').dispatch_event('pointerdown')
        expect(page.locator('#slideBox')).to_be_visible()
        for index in [3, 2]:
            page.locator(f'#pagestrip button[data-index="{index}"]').click()
            # フォントや画像が遅れて届いたときのように、枠の描画後に本文の配置が変わる。
            page.evaluate("""async () => {
                await new Promise(requestAnimationFrame);
                const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
                const p = doc.querySelector('.slide.active strong').parentElement;
                p.style.paddingTop = p.style.paddingTop ? '' : '25px';
            }""")
            page.wait_for_function("""() => {
                const f = document.querySelector('#slideBox iframe:not(.loading)'), w = f.contentWindow;
                const doc = w.document, stage = doc.querySelector('#stage').getBoundingClientRect();
                const mark = doc.querySelector('#slide-studio-theme-marks i');
                if (!mark) return false;
                const range = doc.createRange(); range.selectNodeContents(doc.querySelector('.slide.active strong'));
                const r = range.getBoundingClientRect(), m = mark.getBoundingClientRect();
                return Math.abs(stage.left) < 1 && Math.abs(stage.top) < 1
                    && Math.abs(stage.width - f.getBoundingClientRect().width) < 1
                    && Math.abs(m.left - (r.left - 3)) < 1 && Math.abs(m.top - (r.top - 3)) < 1;
            }""", timeout=3000)
    assert not page.errors


def test_heading_gradient_edit_save_reload_and_undo(page, gui):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    frame = page.frame_locator('#slideBox iframe:not(.loading)')
    expect(frame.locator('.slide.active h2')).to_be_visible()
    editor = page.locator('.gradient-editor')
    editor.get_by_role('button', name='上下', exact=True).click()
    expect(page.locator('.gradient-point')).to_have_count(2)
    dots = page.locator('.gradient-point')
    # 点は向きを変えたあとに置き直されるので、縦に並ぶまで待つ
    page.wait_for_function('''() => { const [a, b] = [...document.querySelectorAll('.gradient-point')].map(e => e.getBoundingClientRect());
        return a && b && Math.abs(a.x - b.x) < 2 && a.y < b.y; }''')
    dots.nth(1).click()
    point_color(editor, '#112233')
    background = "getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('#one h2')).backgroundImage"
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement.style.getPropertyValue('--header-fill').includes('#112233') || getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--header-fill').includes('#112233')")
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    editor.get_by_role('button', name='グラデーションの編集を終了').click()
    expect(editor).to_be_hidden()
    page.reload()
    open_theme(page)
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    page.locator('.gradient-point').nth(1).click()
    expect(editor.get_by_label('色', exact=True)).to_have_value('#112233')
    editor.get_by_role('button', name='テーマに戻す', exact=True).click()
    expect(page.locator('.gradient-point')).to_have_count(0)
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    page.wait_for_function(background + " === 'none'")  # default の見出しに塗りはない
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    page.locator('#undo').click()
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement.style.getPropertyValue('--header-fill').includes('#112233') || getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--header-fill').includes('#112233')")
    assert not page.errors


def test_background_controls_are_removed_and_heading_toggle_still_opens(page, gui):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.locator('#pagestrip button[data-index="2"]').click()
    page.get_by_role('tab', name='テーマ', exact=True).click()
    toggles = page.locator('.theme-fields > .tv-section-toggle')
    expect(toggles.locator('summary')).to_have_text(['見出し'])
    assert page.locator('.theme-fields > *').evaluate_all("es => es.map(e => e.matches('details')).join()") == 'false,false,true'
    expect(page.locator('input[name="--paper"], input[name="--section-fill"], input[name="--cover-fill"]')).to_have_count(0)
    expect(page.locator('input[name="--header-ink"]')).to_be_hidden()
    # 見出しはスライド上で編集し、テーマの設定欄の開閉を保つ。
    page.frame_locator('#slideBox iframe:not(.loading)').locator('.slide.active h2').click()
    expect(toggles.nth(0)).to_have_attribute('open', '')
    expect(page.get_by_role('tab', name='テーマ', exact=True)).to_have_attribute('aria-selected', 'true')
    expect(page.frame_locator('#slideBox iframe:not(.loading)').locator('.slide.active h2')).to_have_attribute('contenteditable', 'true')
    page.keyboard.press('Escape')
    page.get_by_role('tab', name='テーマ', exact=True).click()
    page.get_by_role('button', name='「terracotta」を選ぶ', exact=True).click()
    expect(page.locator('input[name="--header-ink"]')).to_be_visible()
    expect(page.locator('input[name="--paper"], input[name="--section-fill"], input[name="--cover-fill"]')).to_have_count(0)


def test_theme_click_selects_color_and_block_without_changing_step(page, gui):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.locator('#pagestrip button[data-index="2"]').click()
    page.evaluate("""() => {
        const w = document.querySelector('#slideBox iframe:not(.loading)').contentWindow;
        w.document.querySelector('.slide.active p').innerHTML =
          '<span class="good">良い結果 <strong id="good-click">成功</strong></span> ' +
          '<strong id="accent-click">太字</strong> ' +
          '<span id="mark-click" class="highlight animate-highlight" data-highlight-step="9">マーカー</span>';
    }""")
    open_theme(page)
    expect(page.locator('input[name="--good"]')).to_be_visible()
    frame = page.frame_locator('#slideBox iframe:not(.loading)')
    for target, key in [('good-click', '--good'), ('accent-click', '--accent'), ('mark-click', '--mark')]:
        frame.locator('#' + target).click()
        expect(page.locator(f'label[data-key="{key}"]')).to_have_class('on')
        assert page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.index") == 2
        assert frame.locator('[contenteditable="true"]').count() == 0
        assert frame.locator('.slide-studio-selected').count() == 1
        page.keyboard.press('Escape')
        assert frame.locator('#mark-click.is-highlighted').count() == 0
    # 設定欄からの検出も transition に惑わされず、マーカーだけを囲む。
    page.locator('label[data-key="--mark-ink"]').dispatch_event('pointerdown')
    page.wait_for_function("""() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        const r = doc.querySelector('#mark-click').getBoundingClientRect();
        const m = doc.querySelector('#slide-studio-theme-marks i')?.getBoundingClientRect();
        return m && m.left >= r.left - 4 && m.right <= r.right + 4;
    }""")
    # 未表示段のマーカーも編集時には実際に着色し、入力中・保存後の色が見える。
    expect(page.locator('label[data-key="--mark-line"]')).to_have_count(0)
    mark = frame.locator('#mark-click')
    for key, prop, color in [('--mark', 'backgroundColor', '#123456'), ('--mark-ink', 'color', '#abcdef')]:
        page.locator(f'input[name="{key}"]').evaluate("""(e, color) => {
            e.value = color; e.dispatchEvent(new Event('input'));
        }""", color)
        expected = 'rgb(18, 52, 86)' if key == '--mark' else 'rgb(171, 205, 239)'
        assert mark.evaluate('(e, prop) => getComputedStyle(e)[prop]', prop) == expected
        page.locator(f'input[name="{key}"]').dispatch_event('change')
        page.wait_for_function("""([key, color]) => {
            const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
            return !doc.documentElement.style.getPropertyValue(key) &&
                getComputedStyle(doc.documentElement).getPropertyValue(key).trim() === color;
        }""", arg=[key, color])
        assert mark.evaluate('(e, prop) => getComputedStyle(e)[prop]', prop) == expected
    assert mark.evaluate('e => getComputedStyle(e).boxShadow') == 'none'
    page.screenshot(path='/tmp/slide-studio-marker-colors.png')
    page.get_by_role('tab', name='スライド', exact=True).click()
    expect(mark).to_have_css('background-color', 'rgba(0, 0, 0, 0)')
    assert frame.locator('#mark-click.is-highlighted').count() == 0
    open_theme(page)
    expect(mark).to_have_css('background-color', 'rgb(18, 52, 86)')
    # 見本のクリックからも色の編集欄へ移動できる。
    page.locator('label[data-key="--warn"]').dispatch_event('pointerdown')
    expect(page.locator('.theme-sample')).to_be_visible()
    page.frame_locator('.theme-sample iframe:not(.loading)').locator('.slide.active .good').click()
    expect(page.locator('label[data-key="--good"]')).to_have_class('on')
    expect(page.locator('.theme-sample')).to_be_visible()
    page.screenshot(path='/tmp/slide-studio-theme-click.png')
    assert not page.errors


def test_gradient_popup_edges_and_heading_ink(page, gui):
    _, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    editor = page.locator('.gradient-editor')
    editor.get_by_role('button', name='上下', exact=True).click()
    page.locator('.gradient-point').last.click()
    for selector in ['.gradient-toolbar', '.gradient-color', '.gradient-point']:
        for el in page.locator(selector).all():
            r = el.bounding_box()
            assert r['x'] >= 0 and r['y'] >= 0
            assert r['x'] + r['width'] <= page.viewport_size['width']
            assert r['y'] + r['height'] <= page.viewport_size['height']
    page.screenshot(path='/tmp/slide-studio-heading-direct.png')
    page.keyboard.press('Escape')
    expect(editor).to_be_hidden()
    page.locator('input[name="--header-ink"]').fill('#102030')
    page.wait_for_function("""() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        return !doc.getElementById('theme-live-heading') && getComputedStyle(doc.querySelector('#one h2')).color === 'rgb(16, 32, 48)';
    }""")
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    editor.get_by_role('button', name='左右', exact=True).click()
    editor.get_by_role('button', name='内容も表示', exact=True).click()
    page.locator('.gradient-surface').click(position={'x': 100, 'y': 60})
    expect(editor).to_be_visible()
    editor.get_by_role('button', name='グラデーションの編集を終了').click()
    expect(editor).to_be_hidden()
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    expect(editor).to_be_visible()
    expect(editor.locator('strong')).to_have_text('見出しのグラデーション')
    assert not page.errors


def test_gradient_drag_and_narrow_viewport(page, gui):
    ws, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    editor = page.locator('.gradient-editor')
    editor.get_by_role('button', name='左右', exact=True).click()
    dot = page.locator('.gradient-point').last
    start = dot.bounding_box()
    page.mouse.move(start['x'] + 14, start['y'] + 14)
    page.mouse.down()
    page.mouse.move(start['x'] - 80, start['y'] + 60, steps=5)
    page.mouse.up()
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    css = (ws.themes / 'default.css').read_text()
    assert 'linear-gradient(90deg, var(--paper) 0%' not in css
    page.reload()
    open_theme(page)
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    expect(page.locator('.gradient-point')).to_have_count(2)
    page.set_viewport_size({'width': 1000, 'height': 700})
    page.locator('.gradient-point').last.click()
    for selector in ['.gradient-toolbar', '.gradient-color', '.gradient-point']:
        for el in page.locator(selector).all():
            r = el.bounding_box()
            assert r['x'] >= 0 and r['y'] >= 0
            assert r['x'] + r['width'] <= 1000
            assert r['y'] + r['height'] <= 700
    page.screenshot(path='/tmp/slide-studio-gradient-narrow.png')
    page.emulate_media(color_scheme='dark')
    page.screenshot(path='/tmp/slide-studio-gradient-narrow-dark.png')
    page.locator('.theme-view .memo-foot').click()
    expect(editor).to_be_hidden()
    assert not page.errors


def test_heading_gradient_sample_fallback(page, gui):
    _, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelectorAll('h2').forEach(h => h.style.display = 'none')")
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    expect(page.locator('.theme-sample')).to_be_visible()
    expect(page.locator('.gradient-editor')).to_be_visible()
    page.locator('.gradient-editor').get_by_role('button', name='上下', exact=True).click()
    expect(page.locator('.gradient-point')).to_have_count(2)
    page.keyboard.press('Escape')
    expect(page.locator('.gradient-editor')).to_be_hidden()
    assert not page.errors


def test_heading_colors_and_links_are_independent(page, gui):
    ws, srv = gui
    add_plain_theme(ws)
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='「plainhead」を選ぶ', exact=True).click()
    expect(page.get_by_label('見出しの背景', exact=True)).to_have_value('#ffffff')
    expect(page.locator('.tv-heading-rule')).to_be_hidden()
    expect(page.locator('[data-key="--header-ink"] button')).to_have_count(0)
    heading = "getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('#one h2'))"
    page.wait_for_function(heading + ".color === 'rgb(51, 51, 51)'")  # plainhead に切り替わるのを待つ
    page.get_by_label('見出しの背景', exact=True).fill('#aabbcc')
    page.wait_for_function(heading + ".backgroundColor === 'rgb(170, 187, 204)' && " + heading + ".color === 'rgb(51, 51, 51)'")
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    assert page.evaluate("""() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        return getComputedStyle(doc.querySelector('.cover-title')).color === 'rgb(51, 51, 51)'
            && getComputedStyle(doc.querySelector('.section-slide')).color === 'rgb(51, 51, 51)';
    }""")
    page.get_by_label('見出しの文字', exact=True).fill('#123456')
    page.wait_for_function(heading + ".color === 'rgb(18, 52, 86)'")
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading-ink')")
    page.get_by_label('見出しの背景', exact=True).fill('#abcdef')
    page.wait_for_function(heading + ".backgroundColor === 'rgb(171, 205, 239)' && " + heading + ".color === 'rgb(18, 52, 86)'")
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    page.get_by_role('group', name='見出しの装飾', exact=True).get_by_role('button', name='罫線', exact=True).click()
    page.locator('input[name="--rule"]').fill('#334455')
    page.wait_for_function('''() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        return !doc.getElementById('theme-live-heading-rule') && getComputedStyle(doc.querySelector('#one h2'), '::after').borderBottomColor === 'rgb(51, 68, 85)';
    }''')
    page.get_by_label('線の種類', exact=True).first.select_option('double')
    page.get_by_label('線の太さ', exact=True).select_option('4px')
    page.get_by_label('線の長さ', exact=True).select_option('0px')
    page.wait_for_function(heading + ".backgroundColor === 'rgba(0, 0, 0, 0)'")
    page.get_by_role('group', name='見出しの装飾', exact=True).get_by_role('button', name='色の帯', exact=True).click()
    page.evaluate('''() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        doc.querySelector('#one').insertAdjacentHTML('beforeend', '<p><strong id="bold-test">太字</strong><a id="link-test" href="https://example.com">リンク</a></p>');
    }''')
    page.get_by_label('リンク', exact=True).fill('#224466')
    page.get_by_label('強調色', exact=True).fill('#ee6611')
    page.wait_for_function("getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement).getPropertyValue('--accent').trim() === '#ee6611'")
    page.wait_for_function('''() => {
        const doc = document.querySelector('#slideBox iframe:not(.loading)').contentDocument;
        return !doc.documentElement.style.getPropertyValue('--accent') && !doc.documentElement.style.getPropertyValue('--link') &&
          getComputedStyle(doc.querySelector('#bold-test')).color === 'rgb(238, 102, 17)' &&
          getComputedStyle(doc.querySelector('#link-test')).color === 'rgb(34, 68, 102)';
    }''')
    page.reload()
    open_theme(page)
    expect(page.get_by_label('リンク', exact=True)).to_have_value('#224466')
    page.wait_for_function(heading + ".backgroundColor === 'rgb(171, 205, 239)' && " + heading + ".color === 'rgb(18, 52, 86)'")
    page.get_by_label('見出しの背景', exact=True).focus()
    expect(page.frame_locator('#slideBox iframe:not(.loading)').locator('.slide.active h2')).to_be_visible()
    page.screenshot(path='/tmp/slide-studio-theme-colors.png')
    page.get_by_label('見出しの背景', exact=True).click()
    expect(page.locator('.tv-inline-color')).to_be_visible()
    page.get_by_label('カラーコード', exact=True).fill('#c0d0e0')
    page.get_by_label('カラーコード', exact=True).press('Tab')
    page.wait_for_function(heading + ".backgroundColor === 'rgb(192, 208, 224)'")
    panel = page.locator('.tv-inline-color').bounding_box()
    preview = page.locator('#slideBox').bounding_box()
    assert panel['x'] + panel['width'] <= preview['x']
    page.screenshot(path='/tmp/slide-studio-theme-inline-color.png')

    assert not page.errors


def test_gradient_heading_preview_is_inert_and_non_destructive(page, gui):
    ws, srv = gui
    before = (ws.themes / 'default.css').read_text()
    source = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    editor = page.locator('.gradient-editor')
    frame = page.frame_locator('#slideBox iframe:not(.loading)')
    content = frame.locator('.slide.active p').first
    expect(editor.get_by_role('button', name='背景のみ', exact=True)).to_have_attribute('aria-pressed', 'true')
    expect(content).to_be_hidden()
    assert frame.locator('#stage').evaluate('(s) => s.inert')
    expect(editor.get_by_role('button', name='単色', exact=True)).to_have_count(0)
    expect(editor.get_by_role('button', name='色を広げる', exact=True)).to_have_count(0)
    assert editor.locator('.gradient-done').evaluate('(b) => getComputedStyle(b).backgroundColor') == 'rgba(0, 0, 0, 0)'
    editor.get_by_role('button', name='内容も表示', exact=True).click()
    expect(content).to_be_visible()
    assert frame.locator('#stage').evaluate('(s) => s.inert')
    page.locator('.gradient-surface').click(position={'x': 120, 'y': 100})
    expect(editor).to_be_visible()
    expect(frame.locator('.slide-studio-selected, .slide-studio-editing')).to_have_count(0)
    editor.get_by_role('button', name='ポイントを追加', exact=True).click()
    page.keyboard.press('Escape')
    expect(editor).to_be_visible()
    expect(editor.get_by_role('button', name='ポイントを追加', exact=True)).to_have_attribute('aria-pressed', 'false')
    page.keyboard.press('Escape')
    expect(editor).to_be_hidden()
    expect(content).to_be_visible()
    assert not frame.locator('#stage').evaluate('(s) => s.inert')
    assert (ws.themes / 'default.css').read_text() == before
    assert ws.qmd('talk').read_text() == source
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    expect(content).to_be_hidden()
    assert not page.errors


def test_gradient_templates_preserve_points_and_drag_undo(page, gui):
    from slide_studio.theme_edit import read_vars
    import re

    ws, srv = gui
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    editor = page.locator('.gradient-editor')
    editor.get_by_role('button', name='左右', exact=True).click()
    page.locator('.gradient-point').last.click()
    point_color(editor, '#ab1234')
    expect(editor.get_by_role('button', name='ポイントを削除', exact=True)).to_be_disabled()
    editor.get_by_role('button', name='ポイントを追加', exact=True).click()
    page.locator('.gradient-surface').click(position={'x': 120, 'y': 100})
    expect(page.locator('.gradient-point')).to_have_count(3)
    point_color(editor, '#1234ab')
    editor.get_by_role('button', name='上下', exact=True).click()
    expect(page.locator('.gradient-point')).to_have_count(3)
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    before = read_vars((ws.themes / 'default.css').read_text())['--header-fill']
    assert re.findall(r'at (\d+)% (\d+)%', before) == [('50', '0'), ('50', '50'), ('50', '100')]
    assert '#ab1234' in before and '#1234ab' in before
    dot = page.locator('.gradient-point').nth(1)
    r = dot.bounding_box()
    page.mouse.move(r['x']+12, r['y']+12)
    page.mouse.down()
    page.mouse.move(r['x']+65, r['y']+50, steps=6)
    page.mouse.up()
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    after = read_vars((ws.themes / 'default.css').read_text())['--header-fill']
    assert after != before
    with page.expect_response(lambda r: '/api/themes/' in r.url and r.request.method == 'PUT') as saved:
        page.locator('#undo').click()
    saved.value.finished()
    expect(editor).to_be_visible()
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement.style.getPropertyValue('--header-fill') === ''")
    assert read_vars((ws.themes / 'default.css').read_text())['--header-fill'] == before
    with page.expect_response(lambda r: '/api/themes/' in r.url and r.request.method == 'PUT') as saved:
        page.locator('#redo').click()
    saved.value.finished()
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)').contentDocument.documentElement.style.getPropertyValue('--header-fill') === ''")
    assert read_vars((ws.themes / 'default.css').read_text())['--header-fill'] == after
    page.reload()
    open_theme(page)
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    expect(page.locator('.gradient-point')).to_have_count(3)
    page.locator('.gradient-point').last.click()
    expect(editor.get_by_label('色', exact=True)).to_have_value('#1234ab')
    assert not page.errors


def test_gradient_hidden_heading_preserves_ink_and_single_color_returns(page, gui):
    ws, srv = gui
    add_plain_theme(ws)
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.get_by_role('button', name='「plainhead」を選ぶ', exact=True).click()
    expect(page.locator('.tv-themes [aria-pressed=true]')).to_have_attribute('data-theme', 'plainhead')
    expect(page.get_by_label('見出しの背景', exact=True)).to_have_value('#ffffff')
    page.get_by_role('button', name='見出しのグラデーション', exact=True).click()
    editor = page.locator('.gradient-editor')
    editor.get_by_role('button', name='左右', exact=True).click()
    page.wait_for_function("!document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getElementById('theme-live-heading')")
    editor.get_by_role('button', name='内容も表示', exact=True).click()
    heading = "getComputedStyle(document.querySelector('#slideBox iframe:not(.loading)').contentDocument.querySelector('#one h2'))"
    page.wait_for_function(heading + ".color === 'rgb(51, 51, 51)' && " + heading + ".backgroundImage.includes('radial-gradient')")
    editor.get_by_role('button', name='グラデーションの編集を終了').click()
    # 通常の色欄のインラインピッカーから単色へ戻せる。
    page.get_by_label('見出しの背景', exact=True).click()
    page.locator('.tv-inline-color input[type=text]').fill('#abcdef')
    page.locator('.tv-inline-color input[type=text]').press('Tab')
    page.wait_for_function(heading + ".backgroundColor === 'rgb(171, 205, 239)' && " + heading + ".backgroundImage === 'none'")
    assert not page.errors


def test_theme_change_restores_cover_positions_and_undo(page, gui):
    from slide_studio.fsutil import write_atomic

    ws, srv = gui
    path = ws.qmd('talk')
    text = path.read_text().replace('lang: ja\n', 'lang: ja\nauthor: Alice\ncover-authors-layout: {x: 150, y: -50, size: 40}\n')
    text = text.replace('::: {.cover-title}', '::: {.cover-title style="left:120px;top:60px"}')
    write_atomic(path, text)
    open_deck(page, srv, raw=False)
    open_theme(page)
    page.locator('.theme-thumb[data-theme="graphite"]').click()
    page.wait_for_function('''() => {
      const doc = document.querySelector('#slideBox iframe:not(.loading)')?.contentDocument;
      const title = doc?.querySelector('.cover-title'), authors = doc?.querySelector('.cover-authors');
      if (!title || !authors) return false;
      const style = doc.defaultView.getComputedStyle(title);
      return style.marginTop === '100px' && style.left === '0px' && style.top === '0px'
        && !authors.style.left && !authors.style.top;
    }''')
    expect(page.locator('#status')).to_have_text('保存済み')
    assert 'x:' not in path.read_text() and 'size' in path.read_text()
    with page.expect_response(lambda r: r.request.method == 'PUT' and r.url.endswith('/source')):
        page.locator('#undo').click()
    expect(page.locator('#status')).to_have_text('保存済み')
    assert path.read_text() == text
    assert not page.errors
