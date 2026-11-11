"""参考資料のタブ：発表の materials/ を VS Code のエクスプローラーと同じ操作で扱う。"""
import base64

from playwright.sync_api import expect

from e2e.conftest import open_deck
from e2e.test_blocks import go, ready, select
from slide_studio import materials
from slide_studio.fsutil import write_atomic


def rows(page):
    return page.locator('.materials .mt-list .mt-row[data-path]')


def row(page, path):
    return page.locator(f'.materials .mt-row[data-path="{path}"]')


def name_input(page):
    return page.get_by_label('名前', exact=True)


def test_materials_tab_lists_adds_and_opens(gui, page, monkeypatch):
    ws, srv = gui
    opened = []
    monkeypatch.setattr(materials, 'OPENER', opened.append)
    base = ws.deck_dir('talk') / 'materials'
    write_atomic(base / 'results' / 'loss.csv', 'step,loss\n')
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    ready(page)
    tab = page.get_by_role('tab', name='参考資料', exact=True)
    expect(tab).to_have_text('')  # タブに数は出さない
    tab.click()
    expect(page.locator('.materials .mt-where')).to_have_text('materials/')
    expect(rows(page)).to_have_count(1)
    row(page, 'results').click()  # フォルダを開く
    expect(rows(page)).to_have_count(2)
    row(page, 'results/loss.csv').click()  # 押すと選ぶだけ
    expect(row(page, 'results/loss.csv')).to_have_class('mt-row sel')
    assert opened == []
    row(page, 'results/loss.csv').dblclick()  # ダブルクリックで開く
    page.wait_for_timeout(200)
    assert opened == [base / 'results' / 'loss.csv']

    # ファイル追加ボタンを1回押すと選択画面が開く。選んでいるファイルの隣（results/）に入る
    expect(page.locator('.materials .mt-into')).to_have_text('→ results/')
    with page.expect_file_chooser() as fc:
        page.get_by_role('button', name='パソコンからファイルを追加', exact=True).click()
    fc.value.set_files([{'name': '結果.txt', 'mimeType': 'text/plain', 'buffer': '精度 0.93'.encode()}])
    expect(row(page, 'results/結果.txt')).to_have_count(1)
    assert (base / 'results' / '結果.txt').read_text() == '精度 0.93'

    # ページを移っても同じ（発表で1つ）
    go(page, 3)
    page.wait_for_timeout(200)
    expect(row(page, 'results/結果.txt')).to_have_count(1)
    page.get_by_role('button', name='フォルダを開く', exact=True).click()
    page.wait_for_timeout(200)
    assert opened[-1] == base

    # 開き直すと、中身のある発表は原稿のタブから（設計書 §10.7）。原稿は変わらない
    open_deck(page, srv, raw=False)
    expect(page.locator('.ptabs [data-tab=qmd]')).to_have_attribute('aria-selected', 'true')
    page.locator('.ptabs [data-tab=materials]').click()
    expect(page.locator('.materials .mt-where')).to_have_text('materials/')
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_materials_create_rename_move_delete(gui, page):
    ws, srv = gui
    base = ws.deck_dir('talk') / 'materials'
    write_atomic(base / 'memo.md', 'メモ')
    write_atomic(base / '条件.md', '')
    before = ws.qmd('talk').read_text()
    open_deck(page, srv, raw=False)
    ready(page)
    go(page, 2)
    select(page, 'p2/0')  # スライドのブロックを選んでおく（ツリーのキーで消えないこと）
    page.get_by_role('tab', name='参考資料', exact=True).click()

    # 新しいフォルダ：その場で名前を打つ
    page.get_by_role('button', name='新しいフォルダ', exact=True).click()
    name_input(page).fill('実験')
    name_input(page).press('Enter')
    expect(row(page, '実験')).to_have_class('mt-row dir sel')
    assert (base / '実験').is_dir()

    # 選んでいるフォルダの中に新しいフォルダ。Esc でやめると作らない
    page.get_by_role('button', name='新しいフォルダ', exact=True).click()
    name_input(page).fill('やめる')
    name_input(page).press('Escape')
    expect(name_input(page)).to_have_count(0)
    assert list((base / '実験').iterdir()) == []
    row(page, '条件.md').drag_to(row(page, '実験'))
    expect(row(page, '実験/条件.md')).to_have_count(1)

    # Enter で名前の変更（拡張子の前まで選ばれている）
    row(page, '実験/条件.md').click()
    page.keyboard.press('Enter')
    assert page.evaluate("(() => { const i = document.querySelector('.mt-name'); return [i.selectionStart, i.selectionEnd]; })()") == [0, 2]
    page.keyboard.type('設定')
    page.keyboard.press('Enter')
    expect(row(page, '実験/設定.md')).to_have_count(1)
    assert (base / '実験' / '設定.md').is_file() and not (base / '実験' / '条件.md').exists()

    # 持ってフォルダに落とすと移る
    row(page, 'memo.md').drag_to(row(page, '実験'))
    expect(row(page, '実験/memo.md')).to_have_count(1)
    assert (base / '実験' / 'memo.md').read_text() == 'メモ'

    # ↑↓ で選び、⌫ で削除（確かめてから .slide-studio/trash/ へ）。スライドのブロックやページは動かない
    row(page, '実験/memo.md').click()
    page.keyboard.press('ArrowUp')
    expect(row(page, '実験')).to_have_class('mt-row dir sel')
    page.keyboard.press('ArrowDown')
    expect(row(page, '実験/memo.md')).to_have_class('mt-row sel')
    page.keyboard.press('Backspace')
    page.get_by_role('dialog').get_by_role('button', name='削除', exact=True).click()
    expect(row(page, '実験/memo.md')).to_have_count(0)
    assert not (base / '実験' / 'memo.md').exists()
    assert [p.name for p in (ws.state / 'trash' / 'talk').rglob('memo.md')] == ['memo.md']
    expect(row(page, '実験/設定.md')).to_have_class('mt-row sel')  # 次の行を選ぶ
    assert page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.index") == 2
    page.wait_for_timeout(300)
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')


def test_materials_add_files_and_folder_and_preview(gui, page, monkeypatch, tmp_path):
    ws, srv = gui
    opened = []
    monkeypatch.setattr(materials, 'OPENER', opened.append)
    src = tmp_path / 'pc'
    write_atomic(src / 'results' / 'loss.png', PNG)
    write_atomic(src / 'results' / '精度.csv', '精度,0.93\n'.encode('shift_jis'))
    write_atomic(src / 'template.pptx', b'PK')
    base = ws.deck_dir('talk') / 'materials'
    open_deck(page, srv, raw=False)
    ready(page)
    page.get_by_role('tab', name='参考資料', exact=True).click()
    with page.expect_file_chooser() as fc:
        page.get_by_role('button', name='パソコンからフォルダを追加', exact=True).click()
    fc.value.set_files(str(src / 'results'))
    expect(row(page, 'results/loss.png')).to_be_visible()
    with page.expect_file_chooser() as fc:
        page.get_by_role('button', name='パソコンからファイルを追加', exact=True).click()
    fc.value.set_files(str(src / 'template.pptx'))
    expect(row(page, 'template.pptx')).to_be_visible()
    row(page, 'template.pptx').click()
    assert (base / 'results' / 'loss.png').read_bytes() == PNG
    pv = page.locator('.mt-pv')

    # 選んだファイルの中身を木の下に出す。画像・テキスト（Shift_JIS も）・表示できないもの
    expect(pv.locator('.mt-pvb.none')).to_have_text('このアプリでは表示できません。ダブルクリックで既定のアプリで開けます')
    row(page, 'results').click()
    expect(pv).to_be_hidden()  # フォルダでは出さない
    page.keyboard.press('ArrowRight')  # 追加時に開いたフォルダを再び開く
    row(page, 'results/loss.png').click()
    expect(pv.locator('img')).to_be_visible()
    assert page.evaluate("document.querySelector('.mt-pv img').naturalWidth") == 1
    page.keyboard.press('ArrowDown')
    expect(pv.locator('pre')).to_have_text('精度,0.93\n')
    pv.get_by_role('button', name='既定のアプリで開く', exact=True).click()
    page.wait_for_timeout(200)
    assert opened == [base / 'results' / '精度.csv']

    # ほかのタブでは出さない
    page.get_by_role('tab', name='スライド', exact=True).click()
    expect(pv).to_be_hidden()
    assert not page.errors


def test_materials_large_closed_folder_keeps_other_folders_visible(gui, page):
    ws, srv = gui
    base = ws.deck_dir('talk') / 'materials'
    for i in range(501):
        write_atomic(base / 'animations' / f'{i}.txt', 'x')
    write_atomic(base / 'score-table' / 'slides.md', 'slides')
    write_atomic(base / '実験結果' / 'results.csv', 'accuracy,0.93')
    open_deck(page, srv, raw=False)
    ready(page)
    page.get_by_role('tab', name='参考資料', exact=True).click()
    expect(rows(page)).to_have_count(3)
    expect(row(page, 'animations')).to_be_visible()
    expect(row(page, 'score-table')).to_be_visible()
    row(page, '実験結果').click()
    row(page, '実験結果/results.csv').click()
    expect(page.locator('.mt-pv pre')).to_have_text('accuracy,0.93')
    assert not page.errors
