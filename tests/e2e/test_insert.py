"""挿入・貼り付け・素材の操作を、保存された原稿まで検証する。"""
import base64
import re

from playwright.sync_api import expect

from e2e.conftest import open_deck
from e2e.test_blocks import frame, go, ready, saved, select
from slide_studio import figures

# 4×2 の PNG（Chromium で読めるもの。幅は実寸のまま 4 になる）
PNG64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg=='
TABLE = '| 名前 | 値 |\n|---|---|\n| 項目 | 42 |'


def menu(page, name):
    # 上のバーに［挿入］はない。ブロックを選んでいるときの / で開く
    page.keyboard.press('/')
    page.get_by_role('menuitem', name=name, exact=True).click()


def fill_table(page):
    for r, row in enumerate([['名前', '値'], ['項目', '42']], 1):
        for c, value in enumerate(row, 1):
            page.get_by_label(f'{r}行{c}列', exact=True).fill(value)
    page.get_by_label('2行2列', exact=True).press('Meta+Enter')
    expect(page.locator('.ins-table')).to_have_count(0)


def paragraph(page):
    page.locator('#qblocks .page.cur .card').filter(has_text='最初の段落。').click()
    return page.get_by_label('ブロックの原稿', exact=True)


def test_paste_image_after_selected_block_and_save(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv)
    ready(page)
    go(page, 2)
    select(page, 'p2/0')
    # スライド iframe 内の貼り付けも受ける。実際の PNG File を clipboardData に載せる。
    frame(page).locator('[data-slide-studio="p2/0"]').evaluate('''(el, png) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'image.png', {type: 'image/png'}));
      el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
    }''', PNG64)
    saved(page, '![](images/')
    text = ws.qmd('talk').read_text()
    match = re.search(r'!\[\]\((images/paste-\d{8}-\d{6}\.png)\)\{width=4 fig-align="center"\}', text)
    assert match, text
    assert text == before.replace('最初の段落。', '最初の段落。\n\n' + match[0])
    assert (ws.asset_root('talk') / match[1]).read_bytes() == base64.b64decode(PNG64)
    assert len(list((ws.asset_root('talk') / 'images').iterdir())) == 1
    open_deck(page, srv)
    saved(page, match[0])
    assert ws.qmd('talk').read_text() == text
    assert not page.errors


def test_insert_table_and_reload(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv)
    ready(page)
    go(page, 2)
    select(page, 'p2/0')
    menu(page, '表')
    fill_table(page)
    saved(page, TABLE)
    expected = before.replace('最初の段落。', '最初の段落。\n\n' + TABLE)
    assert ws.qmd('talk').read_text() == expected
    open_deck(page, srv)
    ready(page)
    go(page, 2)
    expect(frame(page).locator('.slide.active table')).to_have_count(1)
    expect(frame(page).locator('.slide.active table')).to_contain_text('42')
    assert ws.qmd('talk').read_text() == expected
    assert not page.errors


def test_insert_math_preview_and_edit_with_enter(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv)
    ready(page)
    go(page, 2)
    select(page, 'p2/0')
    menu(page, '数式')
    page.get_by_label('数式', exact=True).fill(r'\frac{x}{2}')
    expect(page.locator('.ins-math .pv math mfrac')).to_have_count(1)
    # 確定のボタンはなく、外を押すと入れて閉じる
    expect(page.locator('.ins-math .foot')).to_have_count(0)
    page.mouse.click(5, 450)
    expect(page.locator('.ins-math')).to_have_count(0)
    md = '$$\n\\frac{x}{2}\n$$'
    saved(page, md)
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '最初の段落。\n\n' + md)
    ready(page)
    select(page, 'p2/1')
    page.keyboard.press('Enter')
    expect(page.get_by_label('数式', exact=True)).to_have_value(r'\frac{x}{2}')
    # ✕ はやめる（書き換えは入らない）。✓ は入れて閉じる
    page.get_by_label('数式', exact=True).fill('y^3')
    page.locator('.ins-math .acts').get_by_role('button', name='やめる', exact=True).click()
    expect(page.locator('.ins-math')).to_have_count(0)
    page.keyboard.press('Enter')
    expect(page.get_by_label('数式', exact=True)).to_have_value(r'\frac{x}{2}')
    page.get_by_label('数式', exact=True).fill('x^2')
    page.locator('.ins-math .acts').get_by_role('button', name='入れて閉じる', exact=True).click()
    expect(page.locator('.ins-math')).to_have_count(0)
    saved(page, '$$\nx^2\n$$')
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '最初の段落。\n\n$$\nx^2\n$$')
    assert not page.errors


def test_slash_menu_removes_slash_and_inserts_after_live_paragraph(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    ready(page)
    go(page, 2)
    field = paragraph(page)
    field.press('ControlOrMeta+End')
    field.press('Enter')
    field.press('/')
    expect(page.get_by_role('menu', name='挿入', exact=True)).to_be_visible()
    page.get_by_role('menuitem', name='表', exact=True).click()
    fill_table(page)
    saved(page, TABLE)
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '最初の段落。\n\n' + TABLE)
    assert not page.errors


def test_tsv_paste_in_live_paragraph(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    ready(page)
    go(page, 2)
    field = paragraph(page)
    field.evaluate(r'''el => {
      const dt = new DataTransfer(); dt.setData('text/plain', '名前\t値\r\n項目\t42\r\n');
      el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
    }''')
    saved(page, TABLE)
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '最初の段落。\n\n' + TABLE)
    assert not page.errors


def assets_fixture(ws):
    deck = ws.asset_root('talk')
    (deck / 'images/a.png').write_bytes(base64.b64decode(PNG64))
    (deck / 'images/b.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
    (deck / 'html').mkdir(exist_ok=True)
    (deck / 'html/plain.html').write_text('<h1>普通の HTML</h1>')
    figures.new_figure(ws, 'shared', ws.shelf_dir('test'))
    figures.new_figure(ws, 'local', deck / 'html')


def test_assets_tabs_counts_and_invalid_html(gui, page):
    ws, srv = gui
    assets_fixture(ws)
    before = ws.qmd('talk').read_text()
    open_deck(page, srv)
    # 原稿の欄にファイル名は出さない
    expect(page.locator('#editor .panel-head')).not_to_contain_text('slides.qmd')
    page.get_by_role('tab', name='素材', exact=True).click()
    view, kinds = page.locator('#assetsView'), page.locator('.as-kinds')
    expect(view).to_be_visible()
    expect(kinds.locator('[data-kind="images"] .n')).to_have_text('2')
    expect(kinds.locator('[data-kind="html"] .n')).to_have_text('3')
    expect(view.locator('.as-card')).to_have_count(3)
    expect(view.locator('.as-add')).to_have_count(0)
    # 挿入可否を文字で確認できる
    expect(view.locator('.as-ready')).to_have_text(['✓ 挿入可', '✓ 挿入可'])
    expect(view.locator('.as-unavailable')).to_have_text('挿入不可')
    invalid = view.locator('.as-card', has_text='plain.html')
    expect(invalid).to_have_class(re.compile(r'\bng\b'))
    expect(invalid).to_have_attribute('data-tip', re.compile('図の形式ではありません'))
    expect(invalid.get_by_role('button', name='AI に図の形式で作り直してもらう（チャットに指示を足す）', exact=True)).to_have_count(1)
    invalid.click()
    preview = page.get_by_role('dialog', name='素材のプレビュー')
    expect(preview).to_be_visible()
    expect(preview.locator('iframe')).to_have_attribute('sandbox', 'allow-scripts')
    expect(preview.frame_locator('iframe').locator('h1')).to_have_text('普通の HTML')
    preview.get_by_role('button', name='閉じる', exact=True).click()
    figure = view.locator('.as-card', has_text='shared')
    figure.focus()
    page.keyboard.press('Enter')
    expect(preview).to_be_visible()
    expect(preview.frame_locator('iframe').locator('#stage svg')).to_be_visible()
    preview.get_by_role('button', name='次のステップ').click()
    page.wait_for_function('document.querySelector(".as-preview iframe").contentWindow.animation.step === 1')
    preview.get_by_role('button', name='前のステップ').click(delay=650)
    page.wait_for_function('document.querySelector(".as-preview iframe").contentWindow.animation.step === 0')
    preview.get_by_role('button', name='閉じる', exact=True).click()
    assert ws.qmd('talk').read_text() == before
    page.get_by_role('tab', name='スライド', exact=True).click()
    expect(view).to_be_hidden()
    assert not page.errors


def test_asset_preview_close_keeps_focus_moved_to_another_card(gui, page):
    _, srv = gui
    page.goto(srv.url)
    result = page.evaluate('''async png => {
      const { assetPreview } = await import('/web/asset-preview.js');
      const first = document.createElement('button'), next = document.createElement('button');
      document.body.append(first, next);
      const results = [];
      for (const moveFocus of [false, true]) {
        first.focus();
        const dialog = assetPreview({kind:'image', name:'test.png', url:`data:image/png;base64,${png}`}, first);
        const closed = new Promise(resolve => dialog.addEventListener('close', resolve, {once:true}));
        dialog.close();
        if (moveFocus) next.focus();
        await closed;
        results.push(document.activeElement === (moveFocus ? next : first));
      }
      first.remove(); next.remove();
      return {results, dialogs: document.querySelectorAll('.as-preview').length};
    }''', PNG64)
    assert result == {'results': [True, True], 'dialogs': 0}



def test_select_and_delete_assets_then_undo(gui, page):
    ws, srv = gui
    assets_fixture(ws)
    (ws.asset_root('talk') / 'images/c.png').write_bytes(base64.b64decode(PNG64) + b'c')
    deck = ws.asset_root('talk')
    open_deck(page, srv)
    ready(page)
    page.get_by_role('tab', name='素材', exact=True).click()
    view, kinds = page.locator('#assetsView'), page.locator('.as-kinds')
    kinds.get_by_role('button', name='画像', exact=True).click()
    cards = view.locator('.as-card')
    expect(cards).to_have_count(3)
    # 通常のタップは拡大表示。削除キーや全選択では選択モードに入らない
    cards.nth(0).click()
    preview = page.get_by_role('dialog', name='素材のプレビュー')
    expect(preview.locator('img')).to_be_visible()
    assert preview.bounding_box()['width'] > cards.nth(0).bounding_box()['width'] * 2
    expect(view.locator('.as-card.sel')).to_have_count(0)
    page.keyboard.press('Escape')
    expect(preview).to_have_count(0)
    page.keyboard.press('Backspace')
    page.keyboard.press('Meta+a')
    expect(page.get_by_role('dialog')).to_have_count(0)
    expect(view.locator('.as-card.sel')).to_have_count(0)
    expect(cards.nth(0).locator('.as-pick')).to_be_hidden()
    view.get_by_role('button', name='選択', exact=True).click()
    page.keyboard.press('Escape')  # ボタンにフォーカスがある状態でも解除
    expect(cards.nth(0).locator('.as-pick')).to_be_hidden()
    cards.nth(0).click(delay=650)
    expect(view.locator('.as-card.sel')).to_have_count(1)
    expect(preview).to_have_count(0)
    cards.nth(0).click()  # 長押しで選んだカードを外す
    # 押すと1つ、⌘ で足す、⇧ で範囲
    cards.nth(0).click()
    expect(view.locator('.as-card.sel')).to_have_count(1)
    cards.nth(2).click(modifiers=['Meta'])
    expect(view.locator('.as-count')).to_have_text('2個を選択中')
    cards.nth(1).click(modifiers=['Shift'])
    expect(view.locator('.as-card.sel')).to_have_count(2)
    # 左上の丸で外す。Esc で全部外し、⌘A ですべて
    cards.nth(1).hover()
    cards.nth(1).get_by_role('button', name='選ぶ（もう一度押すと外す）', exact=True).click()
    expect(view.locator('.as-card.sel')).to_have_count(1)
    page.keyboard.press('Escape')
    expect(view.locator('.as-card.sel')).to_have_count(0)
    view.get_by_role('button', name='選択', exact=True).click()
    cards.nth(0).focus()
    page.keyboard.press('Meta+a')
    expect(view.locator('.as-card.sel')).to_have_count(3)
    # 外したものは消さない。ダイアログでやめると何も消えない
    cards.nth(2).click(modifiers=['Meta'])
    view.get_by_role('button', name='選んだ素材を削除', exact=True).click()
    dialog = page.get_by_role('dialog', name='素材を削除')
    expect(dialog).to_contain_text('2個の素材（a.png、b.svg）を削除します。')
    dialog.get_by_role('button', name='やめる', exact=True).click()
    assert (deck / 'images/a.png').exists()
    view.get_by_role('button', name='選んだ素材を削除', exact=True).click()
    page.get_by_role('dialog', name='素材を削除').get_by_role('button', name='削除', exact=True).click()
    expect(cards).to_have_count(1)
    assert not (deck / 'images/a.png').exists() and not (deck / 'images/b.svg').exists() and (deck / 'images/c.png').exists()
    expect(kinds.locator('[data-kind="images"] .n')).to_have_text('1')
    # 取り消しで戻る
    page.keyboard.press('Meta+z')
    expect(cards).to_have_count(3)
    assert (deck / 'images/a.png').exists() and (deck / 'images/b.svg').exists()
    # Delete キーでも消せる（スライドのブロックは消さない）
    before = ws.qmd('talk').read_text()
    view.get_by_role('button', name='選択', exact=True).click()
    cards.nth(2).click()
    page.keyboard.press('Backspace')
    page.get_by_role('dialog', name='素材を削除').get_by_role('button', name='削除', exact=True).click()
    expect(cards).to_have_count(2)
    assert ws.qmd('talk').read_text() == before
    assert not page.errors

def drag_to(page, source, x, y):
    b = source.bounding_box()
    page.mouse.move(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2)
    page.mouse.down()
    for i in range(1, 11):
        page.mouse.move(b['x'] + (x - b['x']) * i / 10, b['y'] + (y - b['y']) * i / 10)
    page.mouse.up()


def test_drag_asset_onto_slide_and_page_strip(gui, page):
    ws, srv = gui
    assets_fixture(ws)
    before = ws.qmd('talk').read_text()
    open_deck(page, srv)
    ready(page)
    go(page, 2)
    page.get_by_role('tab', name='素材', exact=True).click()
    view, kinds = page.locator('#assetsView'), page.locator('.as-kinds')
    # 図を「最初の段落」の上半分に落とすと、その前に入る
    kinds.get_by_role('button', name='HTML', exact=True).click()
    target = frame(page).locator('[data-slide-studio="p2/0"]').bounding_box()  # 画面の座標
    drag_to(page, view.locator('.as-card', has_text='shared'), target['x'] + 20, target['y'] + 3)
    saved(page, '{{< fig test/shared >}}')
    text = ws.qmd('talk').read_text()
    assert text == before.replace('最初の段落。', '{{< fig test/shared >}}\n\n最初の段落。')
    # 挿入した素材には別の使用中ラベルが付く
    expect(view.locator('.as-card', has_text='shared').locator('.as-used')).to_have_text('使用中')
    # 図の形式でない HTML は持てない
    drag_to(page, view.locator('.as-card', has_text='plain.html'), target['x'] + 20, target['y'] + 3)
    page.wait_for_timeout(300)
    assert ws.qmd('talk').read_text() == text
    # 画像をページの帯の「二枚目」に落とすと、そのページの最後に入る
    kinds.get_by_role('button', name='画像', exact=True).click()
    strip = page.locator('#pagestrip button[data-index="3"]').bounding_box()
    drag_to(page, view.locator('.as-card', has_text='a.png'), strip['x'] + strip['width'] / 2, strip['y'] + strip['height'] / 2)
    saved(page, '![](images/a.png)')
    after = ws.qmd('talk').read_text()
    assert after == text.replace('::::\n\n## まとめ', '::::\n\n![](images/a.png){width=4 fig-align="center"}\n\n## まとめ')
    assert not page.errors


def test_insert_citation_from_bibliography(gui, page):
    ws, srv = gui
    (ws.bib('talk')).write_text('@article{sample2025,\n title={Sample paper},\n author={Doe, Jane},\n year={2025}\n}\n')
    before = ws.qmd('talk').read_text()
    open_deck(page, srv)
    ready(page)
    go(page, 2)
    select(page, 'p2/0')
    menu(page, '文献の引用')
    page.locator('.ins-cite').get_by_role('option').filter(has_text='sample2025').click()
    saved(page, '[@sample2025]')
    assert ws.qmd('talk').read_text() == before.replace('最初の段落。', '最初の段落。[@sample2025]')
    assert not page.errors


def test_edit_table_with_toolbar(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text().replace('最初の段落。', TABLE)
    ws.qmd('talk').write_text(before)
    open_deck(page, srv)
    ready(page)
    go(page, 2)
    select(page, 'p2/0')
    page.locator('#blockTools').get_by_role('button', name='表を直す', exact=True).click()
    expect(page.get_by_label('2行2列', exact=True)).to_have_value('42')
    page.get_by_label('2行2列', exact=True).fill('99')
    page.get_by_label('2行2列', exact=True).press('Meta+Enter')
    saved(page, '| 項目 | 99 |')
    assert ws.qmd('talk').read_text() == before.replace('| 項目 | 42 |', '| 項目 | 99 |')
    assert not page.errors


RUN = '''async ([text, script]) => {
  const ins = await import('/web/insert.js');
  const {structureOf} = await import('/web/structure.js');
  return await (new Function('ins', 'structureOf', 'text', `return (async () => { ${script} })()`))(ins, structureOf, text);
}'''


def test_insert_at_key_caret_and_page_end(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = '## A {#a}\n\n一。\n\n二。\n\n## B {#b}\n\n三。\n'
    results = page.evaluate(RUN, [text, '''const st = await structureOf(text);
      return [{key: 'p0/0'}, {pos: text.indexOf('一。') + 1}, {}, {key: 'missing'}]
        .map(a => ins.insertAt(text, st, a, '追加。', 0).text);
    '''])
    assert results[:2] == [text.replace('一。', '一。\n\n追加。')] * 2
    assert results[2:] == [text.replace('二。', '二。\n\n追加。')] * 2
    empty = '## A {#a}\n\n## B {#b}\n\n三。\n'
    result = page.evaluate(RUN, [empty, "return ins.insertAt(text, await structureOf(text), {}, '追加。', 0).text;"])
    assert result.index('## A') < result.index('追加。') < result.index('## B')
    assert result.endswith('三。\n')


def test_pure_table_image_math_code_and_inline_helpers(gui, page):
    _, srv = gui
    page.goto(srv.url)
    out = page.evaluate(RUN, ['', r'''
      const table = {rows: [['A', 'B', 'C', 'D'], ['a|b', '2', '', '4']], align: ['l', 'c', 'r', null]};
      return {
        roundtrip: ins.parseTable(ins.tableMd(table)), table,
        invalid: ins.parseTable('ordinary paragraph'),
        widths: [{w: 2000, h: 500}, {w: 1000, h: 2000}, {w: 80, h: 40}, null].map(s => ins.imageMd('images/a.png', s)),
        math: [ins.pureMath(' $$\nx^2\n$$ '), ins.pureMath('text $$x$$'), ins.pureMath('$$a$$\n$$b$$')],
        code: ins.codeMd(' python ', 'print(1)\n'), fence: ins.codeMd('', '```\nx\n```'),
        rows: ins.tsvRows(' A\tB\r\n1\r\n'),
        sheet: ['A\tB\n1\t2', 'A\tB', 'A\nB', ''].map(ins.isSheet),
        inline: [ins.inlineAt('abc.', 4, '[@key]'), ins.inlineAt('本文。', 3, '[@key]')]
      };
    '''])
    assert out['roundtrip'] == out['table']
    assert out['invalid'] is None
    assert out['widths'] == [f'![](images/a.png){{width={w} fig-align="center"}}' for w in (1000, 220, 80)] + ['![](images/a.png){fig-align="center"}']
    assert out['math'] == ['x^2', None, None]
    assert out['code'] == '```python\nprint(1)\n```'
    assert out['fence'] == '~~~~\n```\nx\n```\n~~~~'
    assert out['rows'] == [['A', 'B'], ['1', '']]
    assert out['sheet'] == [True, False, False, False]
    assert out['inline'] == ['abc. [@key]', '本文。[@key]']
