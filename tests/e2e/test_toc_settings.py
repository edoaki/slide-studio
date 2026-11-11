import re
import pytest

from playwright.sync_api import expect
from e2e.conftest import open_deck


def test_toc_settings_and_hidden_source(gui, page):
    ws, srv = gui
    q = ws.qmd('talk')
    original = q.read_text()
    open_deck(page, srv, raw=False)
    toggle = page.get_by_role('switch', name='目次を表示')
    expect(toggle).not_to_be_checked()
    expect(page.get_by_role('button', name='2列', exact=True)).to_be_disabled()
    toggle.check()
    frame = page.frame_locator('#slideBox iframe:not(.loading)')
    expect(frame.locator('.toc-list')).to_be_attached()
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(1)")
    expect(frame.locator('section.toc-slide')).to_be_visible()
    assert len(frame.locator('.toc-list').evaluate('e => getComputedStyle(e).gridTemplateColumns').split()) == 1
    # 表紙の中ではなく、表紙の次のページとして1行で出る（その行だけで開いたページの中身は持たない）
    row = page.locator('#qblocks .page.toc-page')
    expect(row.locator('.heading')).to_have_text('目次')
    expect(row.locator('.page-num')).to_have_text('2')
    expect(page.locator('#qblocks .page[data-page="0"] .toc-settings')).to_have_count(0)
    page.get_by_role('button', name='2列', exact=True).click()
    expect(frame.locator('section.toc-slide')).to_have_class(re.compile(r'\btoc-columns\b'))
    page.click('#syntaxToggle')
    raw = page.locator('.raw textarea')
    expect(raw).not_to_have_value(re.compile('title:|cover-title|#toc'))
    raw.evaluate("e => { const at = e.value.indexOf('最初の段落。') + '最初の段落'.length; e.focus(); e.setSelectionRange(at, at); }")
    raw.press_sequentially('追加本文')
    page.wait_for_function("document.querySelector('#status').dataset.tone !== 'busy'")
    page.reload()
    page.click('#blocksMode')
    expect(toggle).to_be_checked()
    expect(page.get_by_role('button', name='2列', exact=True)).to_have_attribute('aria-pressed', 'true')
    toggle.uncheck()
    expect(frame.locator('.toc-list')).to_have_count(0)
    # OFF はスライドにならないので番号を詰める
    expect(page.locator('#qblocks .page.toc-page .page-num')).to_have_text('–')
    expect(page.locator('#qblocks .page:not(.toc-page) .page-num .n').nth(1)).to_have_text('2')
    toggle.check()
    expect(frame.locator('section.toc-slide.toc-columns')).to_be_attached()
    assert original.split('# 本編')[0] in q.read_text()
    assert '追加本文' in q.read_text()
    page.click('#blocksMode')
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(1)")
    page.screenshot(path='/tmp/slide-studio-toc-settings.png')
    assert not page.errors


def test_toc_switch_right_after_typing_in_cover(gui, page):
    _, srv = gui
    open_deck(page, srv, raw=False)
    page.locator('#qblocks .page.cur .cf-sub').fill('副題')
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    toggle = page.get_by_role('switch', name='目次を表示')
    toggle.check()
    expect(page.locator('#qblocks .page.toc-page .page-num')).to_have_text('2')
    expect(toggle).to_be_checked()
    assert not page.errors


@pytest.mark.parametrize('indent', ['', ' ', '  ', '   '])
def test_toc_settings_preserve_reordered_attributes(gui, page, indent):
    ws, srv = gui
    q = ws.qmd('talk')
    original = q.read_text().replace('# 本編', indent + '::: {.toc-columns #toc .toc-columns-extra}\n:::\n\n# 本編')
    q.write_text(original)
    open_deck(page, srv, raw=False)
    toggle = page.get_by_role('switch', name='目次を表示')
    expect(toggle).to_be_checked()
    expect(page.get_by_role('button', name='2列', exact=True)).to_have_attribute('aria-pressed', 'true')
    toggle.uncheck()
    frame = page.frame_locator('#slideBox iframe:not(.loading)')
    expect(frame.locator('.toc-list')).to_have_count(0)
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert '.toc-off' in q.read_text()
    assert '.toc-columns-extra' in q.read_text()
    toggle.check()
    page.get_by_role('button', name='縦並び', exact=True).click()
    expect(frame.locator('.toc-list')).to_be_attached()
    expect(frame.locator('section.toc-slide')).not_to_have_class(re.compile(r'(?:^|\s)toc-columns(?:\s|$)'))
    page.wait_for_function("document.querySelector('#status').textContent === '保存済み'")
    assert '.toc-columns-extra' in q.read_text()
    assert not page.errors


def test_raw_projection_roundtrip_and_offsets(gui, page):
    _, srv = gui
    open_deck(page, srv)
    result = page.evaluate('''async () => {
      const {QmdEditor} = await import('/web/qmd-editor.js');
      const host = document.createElement('div'); document.body.append(host);
      const e = new QmdEditor(host);
      const text = '---\\ntitle: X\\n---\\n\\n## X {.cover}\\n\\ncover\\n\\n::: {#toc}\\n:::\\n\\n# A\\n\\nBody\\n\\n::: {#refs}\\n:::\\n\\n# B\\n\\nLast\\n';
      e.setText(text);
      const same = e.text() === text;
      const index = e.ta.value.indexOf('Body');
      const offset = e.toFull(index);
      const back = e.toDisp(offset);
      e.ta.value = e.ta.value.replace('Body', 'Edited'); e.shiftFolds();
      const edited = e.text() === text.replace('Body', 'Edited');
      e.foldAll(true); const folded = e.text() === text.replace('Body', 'Edited');
      e.foldAll(false); const unfolded = e.text() === text.replace('Body', 'Edited');
      return {same, offset, expected: text.indexOf('Body'), back, index, edited, folded, unfolded};
    }''')
    assert result['same'] and result['edited'] and result['folded'] and result['unfolded']
    assert result['offset'] == result['expected']
    assert result['back'] == result['index']
