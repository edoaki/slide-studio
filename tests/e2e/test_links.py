"""リンクの入力・編集・発表・PDF（§10.5）。"""
from pathlib import Path

from pypdf import PdfReader
from playwright.sync_api import expect

from e2e.conftest import add_deck, open_deck
from e2e.test_blocks import frame, go, ready, saved, select, start_edit
from e2e.test_text_format import pick_text
from slide_studio.export import bundle_deck, pdf_from_html
from slide_studio.fsutil import write_atomic


def caret(page, needle, end=False):
    pick_text(page, 'p2/0', needle)
    page.evaluate('''end => {
      const s = document.querySelector('#slideBox iframe:not(.loading)').contentDocument.getSelection();
      if (end) s.collapseToEnd(); else s.collapseToStart();
    }''', end)
    page.wait_for_timeout(50)


def test_link_selection_update_remove_and_cancel(gui, page):
    ws, srv = gui
    open_deck(page, srv); ready(page); go(page, 2)
    select(page, 'p2/0'); start_edit(page, 'p2/0')
    pick_text(page, 'p2/0', '最初')
    page.locator('#blockTools').get_by_role('button', name='リンク', exact=True).click()
    expect(page.get_by_label('リンクの文字', exact=True)).to_have_count(0)
    page.get_by_label('URL', exact=True).fill('https://example.com/')
    page.get_by_label('URL', exact=True).press('Enter')
    saved(page, '[最初](https://example.com/)の段落。')
    caret(page, '最初')
    page.keyboard.press('Meta+k')
    expect(page.get_by_label('URL', exact=True)).to_have_value('https://example.com/')
    page.get_by_label('URL', exact=True).fill('https://other.example/')
    page.get_by_label('URL', exact=True).press('Escape')
    expect(frame(page).locator('.slide-studio-editing')).to_have_count(1)
    saved(page, '[最初](https://example.com/)の段落。')
    page.keyboard.press('Meta+k')
    page.get_by_label('URL', exact=True).fill('https://other.example/')
    page.get_by_label('URL', exact=True).press('Enter')
    saved(page, '[最初](https://other.example/)の段落。')
    caret(page, '最初')
    page.keyboard.press('Meta+k')
    page.get_by_role('button', name='リンクを外す', exact=True).click()
    saved(page, '\n最初の段落。\n')
    assert not page.errors


def test_link_without_selection_and_undo(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    open_deck(page, srv); ready(page); go(page, 2)
    select(page, 'p2/0'); start_edit(page, 'p2/0')
    caret(page, '最初の段落。', end=True)
    page.keyboard.press('Meta+k')
    page.get_by_label('リンクの文字', exact=True).fill('資料')
    page.get_by_label('URL', exact=True).fill('https://example.com/')
    page.get_by_label('URL', exact=True).press('Enter')
    saved(page, '最初の段落。[資料](https://example.com/)')
    page.keyboard.press('Escape')
    page.click('#undo')
    saved(page, '\n最初の段落。\n')
    assert ws.qmd('talk').read_text() == before
    assert not page.errors


def test_slash_link_opens_new_tab(gui, page):
    ws, srv = gui
    open_deck(page, srv); ready(page); go(page, 2)
    select(page, 'p2/0')
    page.keyboard.press('/')
    page.get_by_role('menuitem', name='リンク', exact=True).click()
    page.get_by_label('リンクの文字', exact=True).fill('資料')
    page.get_by_label('URL', exact=True).fill('https://example.com/')
    page.get_by_label('URL', exact=True).press('Enter')
    saved(page, '最初の段落。[資料](https://example.com/)')
    ready(page)
    link = frame(page).get_by_role('link', name='資料', exact=True)
    page.context.route('https://example.com/', lambda route: route.fulfill(body='linked page'))
    original_url = page.url
    page.route('**/api/open-external', lambda route: route.fulfill(json={'ok': True}))
    with page.expect_request('**/api/open-external') as opened:
        link.click()
    assert opened.value.post_data_json == {'url': 'https://example.com/'}
    assert len(page.context.pages) == 1
    assert page.url == original_url
    expect(frame(page).locator('.slide.active')).to_be_visible()
    assert not page.errors


def test_pdf_preserves_link(ws):
    add_deck(ws, 'talk', '')
    write_atomic(ws.qmd('talk'), '## リンク\n\n[資料](https://example.com/)\n')
    html = bundle_deck(ws, 'talk')
    pdf = html.with_suffix('.pdf')
    pdf_from_html(html, pdf)
    uris = [a.get_object().get('/A', {}).get('/URI')
            for p in PdfReader(pdf).pages for a in p.get('/Annots', [])]
    assert 'https://example.com/' in uris


def test_link_dom_preserves_format_and_native_undo():
    """HTTP の待ち受けなしでも、実ブラウザの選択と編集を検証する。"""
    from playwright.sync_api import sync_playwright

    web = Path(__file__).resolve().parents[2] / 'slide_studio' / 'web'
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page()
        pg.route('http://links.test/**', lambda route: route.fulfill(
            body=(web / 'inject' / 'link.js').read_text(), content_type='text/javascript'
        ) if route.request.url.endswith('/link.js') else route.fulfill(
            body='<meta charset="utf-8"><p contenteditable="true">前<strong>資料</strong>後</p>', content_type='text/html'
        ))
        pg.goto('http://links.test/')
        result = pg.evaluate('''async () => {
          const { makeLink } = await import('/link.js');
          const el = document.querySelector('p'), s = getSelection();
          const r = document.createRange(); r.selectNode(el.querySelector('strong'));
          el.focus(); s.removeAllRanges(); s.addRange(r);
          const link = makeLink(() => el, () => s.getRangeAt(0), () => {});
          link.state(); link.apply('https://example.com/');
          const added = el.innerHTML;
          document.execCommand('undo'); const undone = el.innerHTML;
          document.execCommand('redo');
          const at = document.createRange(); at.selectNodeContents(el.querySelector('strong')); at.collapse(true);
          s.removeAllRanges(); s.addRange(at);
          const state = link.state(); link.apply('https://other.example/');
          const updated = el.querySelector('a').getAttribute('href');
          at.selectNodeContents(el.querySelector('strong')); at.collapse(true);
          s.removeAllRanges(); s.addRange(at); link.state(); link.apply(null);
          return { added, undone, state, updated, removed: el.innerHTML };
        }''')
        assert result['added'] == '前<a href="https://example.com/"><strong>資料</strong></a>後'
        assert result['undone'] == '前<strong>資料</strong>後'
        assert result['state']['existing']
        assert result['updated'] == 'https://other.example/'
        assert result['removed'] == '前<strong>資料</strong>後'
        browser.close()


def test_app_links_open_new_tabs(gui, page):
    _, srv = gui
    open_deck(page, srv)
    page.context.route('https://example.com/', lambda route: route.fulfill(body='linked page'))
    page.evaluate("""() => {
      const a = document.createElement('a');
      a.href = 'https://example.com/'; a.textContent = '外部の資料';
      document.body.prepend(a);
    }""")
    page.route('**/api/open-external', lambda route: route.fulfill(json={'ok': True}))
    with page.expect_request('**/api/open-external') as opened:
        page.get_by_role('link', name='外部の資料', exact=True).click()
    assert opened.value.post_data_json == {'url': 'https://example.com/'}
    assert len(page.context.pages) == 1
    assert page.url == f'{srv.url}/deck/talk'


def test_exported_slide_links_open_new_tabs(gui, page):
    ws, srv = gui
    write_atomic(ws.qmd('talk'), '## リンク\n\n[資料](https://example.com/)\n\n[ページ内](#local)\n\n## 次 {#local}\n')
    html = bundle_deck(ws, 'talk')
    page.context.route('https://example.com/', lambda route: route.fulfill(body='linked page'))
    page.goto(html.as_uri())
    page.wait_for_function('window.deckReady === true')
    expect(page.get_by_role('link', name='ページ内', exact=True)).not_to_have_attribute('target', '_blank')
    with page.expect_popup() as opened:
        page.get_by_role('link', name='資料', exact=True).click()
    expect(opened.value).to_have_url('https://example.com/')
    assert page.url.split('#')[0] == html.as_uri()


def test_presentation_links_use_default_browser(gui, page):
    ws, srv = gui
    write_atomic(ws.qmd('talk'), '---\ntopic: test\n---\n\n## リンク\n\n[資料](https://example.com/)\n')
    open_deck(page, srv)
    page.route('**/api/open-external', lambda route: route.fulfill(json={'ok': True}))
    page.keyboard.press('Shift+f')
    link = page.frame_locator('.present-screen iframe').get_by_role('link', name='資料', exact=True)
    with page.expect_request('**/api/open-external') as opened:
        link.click()
    assert opened.value.post_data_json == {'url': 'https://example.com/'}
    assert len(page.context.pages) == 1
    expect(page.locator('.present-screen')).to_be_visible()
