from playwright.sync_api import expect


def saved_text(page, ws, expected):
    import time

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        text = ws.qmd('talk').read_text()
        if expected in text:
            return text
        page.wait_for_timeout(30)
    raise AssertionError(ws.qmd('talk').read_text())


def test_all_templates_source_and_replacement(gui, page):
    _, srv = gui
    page.goto(srv.url)
    results = page.evaluate('''async () => {
      const { PAGE_TEMPLATES, isPlaceholder, imagePlaceholder } = await import('/web/page-templates.js');
      const { insertAt } = await import('/web/insert.js');
      const op = await import('/web/block-ops.js');
      const structure = async text => op.units(text, await (await fetch('/api/structure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
      })).json());
      const base = '## A {#page-1}\\n\\n完成。\\n\\n# B {#chapter-1}\\n\\n## C {#c}\\n';
      const out = [];
      for (const template of PAGE_TEMPLATES) {
        const result = op.addPage(base, await structure(base), 1, template);
        const st = await structure(result.text), p = st.pages[1];
        out.push({ id: template.id, pageId: p.id, title: p.title, raw: result.text.slice(p.start, p.end),
          untouched: result.text.startsWith(base.slice(0, base.indexOf('# B'))) && result.text.endsWith(base.slice(base.indexOf('# B'))) });
      }
      const raw = '## A {#a}\\n\\n:::: {.columns}\\n::: {.column}\\n図・画像\\n:::\\n::: {.column}\\n本文\\n:::\\n::::\\n';
      const st = await structure(raw), key = 'p0/0.0.0', md = '![](images/a.png)';
      const byKey = insertAt(raw, st, { key }, md, 0);
      const byPos = insertAt(raw, st, { pos: raw.indexOf('図・画像') + 2 }, md, 0);
      const byDrop = imagePlaceholder(raw, st, key, '{{< fig test/a >}}');
      return { out, byKey: byKey.text, byPos: byPos.text, byDrop: byDrop.text,
        unrelated: imagePlaceholder(raw, st, 'p0/0.1.0', md),
        nonImage: imagePlaceholder(raw, st, key, '$$x$$'),
        placeholders: ['本文', '- 項目\\n- 項目', '**小見出し**', '### 小見出し', '| セル | セル |\\n| --- | --- |', '本文について', '```\\n本文\\n```'].map(isPlaceholder) };
    }''')
    assert len(results['out']) == 8
    for t in results['out']:
        assert t['untouched']
        if t['id'] in ('references', 'appendix'):
            assert t['pageId'] == t['id']
            continue
        assert t['title'] == ''
        assert t['pageId'] == ('chapter-2' if t['id'] == 'chapter' else 'page-2')
        assert not any(c in t['raw'] for c in ('.method-slide', '.lead', '.footnote-small'))
    templates = {t['id']: t['raw'] for t in results['out']}
    assert 'bullets' not in templates
    assert templates['imageBullets'].count('**小見出し**') == 2
    assert templates['comparison'].count('### 小見出し') == 2
    assert templates['table'].count('| セル | セル | セル |') == 3
    assert results['byKey'] == results['byPos']
    assert '図・画像' not in results['byKey'] and '![](images/a.png)' in results['byKey']
    assert '図・画像' not in results['byDrop'] and '{{< fig test/a >}}' in results['byDrop']
    assert results['unrelated'] is None and results['nonImage'] is None
    assert results['placeholders'] == [True, True, True, True, True, False, False]


def test_picker_cancel_insert_heading_and_placeholder_selection(gui, page):
    ws, srv = gui
    before = ws.qmd('talk').read_text()
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    add = page.locator('#qblocks .page-add .end-btn').nth(3)
    add.click()
    expect(page.get_by_role('dialog', name='ページのひな形')).to_be_visible()
    expect(page.locator('.page-templates button')).to_have_count(8)
    assert page.locator('.page-templates button').all_text_contents() == ['', '章扉', 'Reference', 'Appendix'] + [''] * 4
    page.keyboard.press('Escape')
    expect(page.locator('.page-templates')).to_have_count(0)
    assert ws.qmd('talk').read_text() == before
    add.click()
    page.get_by_role('button', name='文と図', exact=True).click()
    heading = page.get_by_role('textbox', name='見出し', exact=True)
    expect(heading).to_be_focused()
    heading.fill('追加したページ')
    heading.press('Enter')
    page.locator('#qblocks .page.cur .card').filter(has_text='図・画像').click()
    field = page.get_by_role('textbox', name='ブロックの原稿')
    assert field.evaluate('(t) => t.value.slice(t.selectionStart, t.selectionEnd)') == '図・画像'
    field.press('/')
    expect(page.locator('.ins-menu')).to_be_visible()
    expect(page.locator('#qblocks .page.cur .card').filter(has_text='図・画像')).to_be_visible()
    page.keyboard.press('Escape')
    page.locator('#qblocks .page.cur .card').filter(has_text='図・画像').click()
    field.fill('自分の図の説明。')
    field.press('Escape')
    expected = '## 追加したページ {#page-1}\n\n本文\n\n自分の図の説明。\n\n本文'
    text = saved_text(page, ws, expected)
    assert expected in text
    assert text.index('{#one}') < text.index('{#page-1}') < text.index('{#two}')
    assert not page.errors


def test_slash_image_and_material_drop_replace_placeholder(gui, page):
    import base64

    from slide_studio.fsutil import write_atomic
    from e2e.test_insert import PNG64, drag_to

    ws, srv = gui
    before = ws.qmd('talk').read_text().replace('最初の段落。', '図・画像').replace('二番目の段落。', '図・画像')
    write_atomic(ws.qmd('talk'), before)
    write_atomic(ws.asset_root('talk') / 'images' / 'a.png', base64.b64decode(PNG64))
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#stage')?.dataset.blocks === 'ready'")
    page.evaluate("document.querySelector('#slideBox iframe:not(.loading)').contentWindow.deck.go(2)")
    expect(page.locator('#qblocks .page.cur[data-page="2"]')).to_be_visible()
    page.locator('#qblocks .page.cur .card').filter(has_text='図・画像').first.click()
    page.get_by_role('textbox', name='ブロックの原稿').press('/')
    page.get_by_role('menuitem', name='画像', exact=True).click()
    page.locator('.ins-pop').get_by_role('option', name='a.png').click()  # 名前の後ろに状態（✓ 挿入可）が付く
    after = saved_text(page, ws, '![](images/a.png)')
    assert after.count('図・画像') == 1
    assert after == before.replace('図・画像', '![](images/a.png){width=4 fig-align="center"}', 1)
    # スライド上でも仮文字だけのブロックは全選択になる。
    page.wait_for_function("document.querySelector('#stage')?.dataset.blocks === 'ready' && !document.querySelector('#slideBox iframe.loading')")
    frame = page.frame_locator('#slideBox iframe:not(.loading)')
    expect(frame.locator('.slide.active img')).to_have_count(1)  # 入れた画像で描き直してから押す
    placeholder = frame.locator('.slide.active [data-slide-studio="p2/1"]')
    placeholder.click()
    placeholder.press('Enter')
    expect(placeholder).to_have_attribute('contenteditable', 'true')
    assert placeholder.evaluate('el => el.ownerDocument.getSelection().toString()') == '図・画像'
    placeholder.press('Escape')
    page.get_by_role('tab', name='素材', exact=True).click()
    page.locator('.as-kinds').get_by_role('button', name='画像', exact=True).click()
    target = placeholder.bounding_box()
    drag_to(page, page.locator('#assetsView .as-card', has_text='a.png'), target['x'] + 10, target['y'] + target['height'] / 2)
    expected = after.replace('図・画像', '![](images/a.png){width=4 fig-align="center"}')
    assert saved_text(page, ws, expected) == expected
    assert not page.errors


def test_unique_pages_disabled_and_references_read_only(gui, page):
    _, srv = gui
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    page.locator('#qblocks .page-add .end-btn').first.click()
    expect(page.get_by_role('button', name='参考文献', exact=True)).to_be_disabled()
    expect(page.get_by_role('button', name='Appendix', exact=True)).to_be_disabled()
    expect(page.get_by_role('button', name='章扉', exact=True)).to_be_enabled()
    page.keyboard.press('Escape')
    refs = page.locator('#qblocks .page').filter(has=page.locator('.heading', has_text='参考文献'))
    refs.locator('.heading').click()
    refs.locator('.heading').click()
    expect(refs.locator('textarea, .card, .page-level')).to_have_count(0)
    expect(page.frame_locator('#slideBox iframe:not(.loading)').locator('.references-slide')).to_have_count(1)


def test_references_paginate_by_height(gui, page):
    from slide_studio.fsutil import write_atomic

    ws, srv = gui
    text = '---\ntitle: Test\ntopic: test\ntheme: default\n---\n\n## 本文 {#body}\n\n' + ' '.join(f'[@k{i}]' for i in range(7)) + '\n\n## 参考文献 {#references}\n\n# APPENDIX {#appendix}\n'
    write_atomic(ws.qmd('talk'), text)
    write_atomic(ws.bib('talk'), '\n'.join(f'@misc{{k{i}, title={{Title {i}}}, year={{2020}}}}' for i in range(7)))
    # 同じ7件でも、文字が大きいテーマでは必要な枚数が増える。
    counts = []
    for size in (12, 60):
        write_atomic(ws.deck_dir('talk') / 'styles' / 'slides.css', f'#stage .references-slide .csl-entry {{font-size:{size}px; line-height:1.5}}')
        write_atomic(ws.qmd('talk'), text + '\n' * size)
        page.goto(f'{srv.url}/deck/talk')
        page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
        result = page.evaluate('''async () => {
          const w = document.querySelector('#slideBox iframe:not(.loading)').contentWindow;
          const refs = w.deck.slides.filter(s => s.classList.contains('references-slide'));
          const heights = [];
          for (const s of refs) {
            await w.deck.go(w.deck.slides.indexOf(s));
            const r = s.getBoundingClientRect(), scale = r.height / s.offsetHeight;
            heights.push([...s.querySelectorAll('.csl-entry')].every(e => e.getBoundingClientRect().bottom <= r.bottom - parseFloat(w.getComputedStyle(s).paddingBottom) * scale + 1));
          }
          return { count: refs.length, entries: refs.reduce((n,s) => n + s.querySelectorAll('.csl-entry').length, 0),
            fits: heights.every(Boolean), mapping: refs.every(s => s.dataset.page === '1'),
            last: w.deck.slides.at(-1).id, number: w.deck.slides.at(-1).querySelector('.page-number').textContent, total: w.deck.count };
        }''')
        assert result['entries'] == 7 and result['fits'] and result['mapping']
        assert result['last'] == 'appendix'
        assert result['number'] == f"{result['total']} / {result['total']}"
        counts.append(result['count'])
    assert counts[0] == 1 and counts[1] > counts[0]
    assert not page.errors


def test_add_reference_and_appendix_pages(gui, page):
    from slide_studio.fsutil import write_atomic

    ws, srv = gui
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().split('## 参考文献')[0])
    page.goto(f'{srv.url}/deck/talk')
    page.wait_for_function("document.querySelector('#slideBox iframe:not(.loading)')?.contentWindow?.deckReady === true")
    for label, marker, title in [('参考文献', '::: {#refs}', '参考文献'), ('Appendix', '# APPENDIX {#appendix}', 'APPENDIX')]:
        page.locator('#qblocks .page-add .end-btn').last.click()
        page.get_by_role('button', name=label, exact=True).click()
        saved_text(page, ws, marker)
        expect(page.locator('#qblocks .page.cur > .heading')).to_have_text(title)
        page.locator('#qblocks .page-add .end-btn').last.click()
        expect(page.get_by_role('button', name=label, exact=True)).to_be_disabled()
        page.keyboard.press('Escape')
    assert ws.qmd('talk').read_text().count('::: {#refs}') == 1
    assert ws.qmd('talk').read_text().count('{#appendix}') == 1
    assert not page.errors
