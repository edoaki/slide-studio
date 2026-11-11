"""block-ops.js の原文の書き換え（§10.4 の並べ替え・追加・大きさ・余白）。ブラウザの中で実行する。"""
DOC = '''## A {#a}

一。

:::: {.columns}
::: {.column width="60%"}
左。
:::
::: {.column width="40%"}
:::
::::

二。

## B {#b}

![画像](a.svg){width=200}

{{< fig s/x >}}
'''

RUN = '''async ([text, script]) => {
  const op = await import('/web/block-ops.js');
  const st = async t => ({ ...op.units(t, await (await fetch('/api/structure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) })).json()), text: t });
  return await (new Function('op', 'st', 'text', `return (async () => { ${script} })()`))(op, st, text);
}'''


def run(page, script, text=DOC):
    return page.evaluate(RUN, [text, script])


def test_list_backspace_boundaries(gui, page):
    _, srv = gui
    page.goto(srv.url)
    out = run(page, r'''
      return ['- A\n- B\n- C', '* A\n* B', '1. A\n2. B', '  - A\n  - B'].map(t => {
        const first = op.backspaceList(t, t.indexOf('B'));
        return [first.text, op.backspaceList(first.text, first.caret).text];
      });
    ''')
    assert out == [
        ['- A\\\n  B\n- C', '- AB\n- C'],
        ['* A\\\n  B', '* AB'],
        ['1. A\\\n   B', '1. AB'],
        ['  - A\\\n    B', '  - AB'],
    ]
    assert run(page, r'''
      return ['- B', 'A\n- B', '- A\n  - B', '- A\n- xB', '- A\n  B', '- A\\\\\n  B']
        .map(t => op.backspaceList(t, t.indexOf('B')));
    ''') == [None] * 6


def test_reorder_insert_and_columns(gui, page):
    ws, srv = gui
    page.goto(srv.url)
    # 下へ2回：となりの横並びと入れ替え、その次は「二。」と入れ替え。ページの端では止まる
    out = run(page, '''
      let t = text, s = await st(t), r = op.reorder(t, s, 'p0/0', 'down'); t = r.text;
      const first = op.keyAt(await st(t), r.at, r.end);
      s = await st(t); r = op.reorder(t, s, first, 'down'); t = r.text;
      const end = op.reorder(t, await st(t), op.keyAt(await st(t), r.at, r.end), 'down');
      return { t, first, end };''')
    assert out['first'] == 'p0/1'
    assert out['t'].startswith('## A {#a}\n\n:::: {.columns}') and out['t'].index('二。') < out['t'].index('一。') < out['t'].index('## B')
    assert out['end'] is None
    # 列の中の最初のブロックを上へ：横並びの外（前）へ出る。右へ：空の列へ入る
    out = run(page, '''const s = await st(text);
      return [op.reorder(text, s, 'p0/1.0.0', 'up').text, op.reorder(text, s, 'p0/1.0.0', 'right').text];''')
    assert '一。\n\n左。\n\n:::: {.columns}' in out[0]
    assert '::: {.column width="60%"}\n:::\n::: {.column width="40%"}\n左。\n:::' in out[1]
    # 空の列・ページの最後への段落の追加、列の追加（幅は割り直す）
    out = run(page, '''const s = await st(text);
      return [op.insertBlock(text, s, 'p0/1.1', 'after', '右。'), op.insertBlock(text, s, 'p1/1', 'after', '最後。'),
              op.addColumn(text, s, 'p0/1.0.0', 'right', '中。'), op.addColumn(text, s, 'p0/0', 'left', '前。')];''')
    assert '::: {.column width="40%"}\n右。\n:::' in out[0]['text'] and out[0]['select'] == 'p0/1.1.0'
    assert out[1]['text'].endswith('{{< fig s/x >}}\n\n最後。\n') and out[1]['select'] == 'p1/2'
    assert '::: {.column width="40%"}\n左。\n:::\n::: {.column width="33%"}\n中。\n:::\n::: {.column width="27%"}\n:::' in out[2]['text']
    assert out[2]['select'] == 'p0/1.1.0'
    assert out[3]['text'].startswith('## A {#a}\n\n:::: {.columns}\n::: {.column}\n前。\n:::\n::: {.column}\n一。\n:::\n::::') and out[3]['select'] == 'p0/0.0.0'


def test_size_and_padding_round_trip(gui, page):
    ws, srv = gui
    page.goto(srv.url)
    out = run(page, '''let s = await st(text);
      const img = op.setSize(text, s, 'p1/0', 320).text, fig = op.setSize(text, s, 'p1/1', 300).text;
      const wrapped = op.setPad(text, s, 'p0/0', '8px 12px');
      const s2 = await st(wrapped.text), key = op.keyAt(s2, wrapped.at, wrapped.end);
      const changed = op.setPad(wrapped.text, s2, key, '4px');
      const s3 = await st(changed.text), back = op.setPad(changed.text, s3, op.keyAt(s3, changed.at, changed.end), null);
      return { img, fig, wrapped: wrapped.text, key, crumbs: s2.pages[0].chunks.map(c => op.isPadWrap(c)), changed: changed.text, back: back.text,
               gutter: op.setPad(text, s, 'p0/1', '30px').text,
               imgPad: op.setPad(text, s, 'p1/0', '4px').text, figPad: op.setPad(text, s, 'p1/1', '8px 0px').text,
               clear: op.setSize(img, await st(img), 'p1/0', null).text };''')
    assert '![画像](a.svg){width="320"}' in out['img']
    assert '{{< fig s/x height="300" >}}' in out['fig']
    assert '::: {style="padding:8px 12px;text-box:trim-both text"}\n一。\n:::' in out['wrapped'] and out['key'] == 'p0/0.0'
    assert out['crumbs'][0] is True
    assert '::: {style="padding:4px;text-box:trim-both text"}\n一。\n:::' in out['changed']
    assert out['back'] == DOC
    assert ':::: {.columns style="--gutter:30px"}' in out['gutter']
    assert '{width=200 style="padding:4px"}' in out['imgPad']
    assert '{{< fig s/x pad="8 0" >}}' in out['figPad']
    assert '![画像](a.svg)\n' in out['clear']


def test_move_to_page_end_and_wrapper_moves_together(gui, page):
    ws, srv = gui
    page.goto(srv.url)
    text = DOC.replace('一。', '::: {style="padding:4px"}\n一。\n:::')
    out = run(page, '''const s = await st(text);
      const r = op.move(text, s, 'p0/0.0', { pageEnd: 1 });
      return { r, key: op.keyAt(await st(r.text), r.at, r.end), del: op.remove(text, s, 'p0/0.0').text };''', text)
    assert out['r']['text'].endswith('{{< fig s/x >}}\n\n::: {style="padding:4px"}\n一。\n:::\n')
    assert out['key'] == 'p1/2.0'
    assert out['del'].startswith('## A {#a}\n\n:::: {.columns}')


def test_move_column_out_takes_contents(gui, page):
    ws, srv = gui
    page.goto(srv.url)
    text = DOC.replace('::: {.column width="40%"}\n:::', '::: {.column width="40%"}\n右。\n:::')
    out = run(page, '''const s = await st(text);
      const after = op.move(text, s, 'p0/1.1', { key: 'p0/2', side: 'after' });
      const before = op.move(text, s, 'p0/1.1', { key: 'p0/1', side: 'before' });
      const page = op.move(text, s, 'p0/1.1', { pageEnd: 1 });
      return { after, key: op.keyAt(await st(after.text), after.at, after.end), before: before.text, page: page.text,
               swap: op.move(text, s, 'p0/1.1', { key: 'p0/1.0', side: 'before' }).text };''', text)
    # 列が1つだけ残るので横並びを外し、移した列は中身だけになる
    assert out['after']['text'].startswith('## A {#a}\n\n一。\n\n左。\n\n二。\n\n右。\n\n## B')
    assert out['key'] == 'p0/3'
    assert out['before'].startswith('## A {#a}\n\n一。\n\n右。\n\n左。\n\n二。\n\n## B')
    assert out['page'].endswith('{{< fig s/x >}}\n\n右。\n')
    # 列の前後は今まで通り列ごと
    assert '::: {.column width="40%"}\n右。\n:::\n::: {.column width="60%"}\n左。\n:::' in out['swap']


def test_removing_column_keeps_remaining_frame_and_step(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = ('## A\n\n:::: {.columns}\n'
            '::: {.column width="40%" style="--block-design:plain;padding:8px;--block-space:4px" data-step="2"}\n左。\n\n説明。\n:::\n'
            '::: {.column width="60%" style="--block-design:top;text-align:center"}\n右。\n:::\n::::\n')
    out = run(page, '''
      const results = [];
      for (const key of ['p0/0.1', 'p0/0.0']) {
        const r = op.remove(text, await st(text), key), s = await st(r.text), box = s.pages[0].chunks[0];
        results.push({kind:box.kind, attrs:box.attrs, children:box.children.map(c => r.text.slice(c.start, c.end)), text:r.text});
      }
      return results;
    ''', text)
    for result in out:
        assert result['kind'] == 'box'
        assert result['attrs']['classes'] == []
        assert '.column' not in result['text']
        assert 'width=' not in result['text']
    assert out[0]['attrs']['kv'] == {'style': '--block-design:plain;padding:8px;--block-space:4px', 'data-step': '2'}
    assert out[0]['children'] == ['左。', '説明。']
    assert out[1]['attrs']['kv'] == {'style': '--block-design:top;text-align:center'}
    assert out[1]['children'] == ['右。']


def test_moving_column_out_keeps_both_frames(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = ('## A\n\n:::: {.columns}\n'
            '::: {.column width="40%" style="--block-design:plain;padding:8px"}\n左。\n:::\n'
            '::: {.column width="60%" style="--block-design:top" data-step="2"}\n右。\n\n説明。\n:::\n::::\n\n終わり。\n')
    out = run(page, '''
      const results = [];
      for (const spec of [{key:'p0/0', side:'before'}, {key:'p0/1', side:'after'}]) {
        const r = op.move(text, await st(text), 'p0/0.1', spec), s = await st(r.text);
        const key = op.keyAt(s, r.at, r.end), moved = op.find(s, key)?.chunk;
        results.push({key, kind:moved?.kind, attrs:moved?.attrs,
          children:moved?.children.map(c => r.text.slice(c.start, c.end)), text:r.text});
      }
      return results;
    ''', text)
    for result in out:
        assert result['kind'] == 'box'
        assert result['attrs']['kv'] == {'style': '--block-design:top', 'data-step': '2'}
        assert result['children'] == ['右。', '説明。']
        assert result['text'].count('--block-design:plain;padding:8px') == 1
        assert result['text'].count('--block-design:top') == 1
        assert '.column' not in result['text']
        assert 'width=' not in result['text']
    assert [result['key'] for result in out] == ['p0/0', 'p0/2']


def test_column_collapse_keeps_outer_frame_and_step(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = ('## A\n\n:::: {.columns style="--block-design:top;--block-space:12px" data-step="1"}\n'
            '::: {.column width="40%" style="--block-design:plain;padding:8px" data-step="2"}\n左。\n:::\n'
            '::: {.column width="60%"}\n右。\n:::\n::::\n\n終わり。\n')
    result = run(page, '''
      const results = [];
      for (const r of [op.remove(text, await st(text), 'p0/0.1'),
        op.move(text, await st(text), 'p0/0.1', {key:'p0/1', side:'after'})]) {
        const s = await st(r.text), outer = s.pages[0].chunks[0], inner = outer.children[0];
        results.push({outer:{kind:outer.kind, attrs:outer.attrs}, inner:{kind:inner.kind, attrs:inner.attrs}, text:r.text});
      }
      return results;
    ''', text)
    for out in result:
        assert out['outer'] == {'kind': 'box', 'attrs': {'id': '', 'classes': [],
            'kv': {'style': '--block-design:top;--block-space:12px', 'data-step': '1'}}}
        assert out['inner'] == {'kind': 'box', 'attrs': {'id': '', 'classes': [],
            'kv': {'style': '--block-design:plain;padding:8px', 'data-step': '2'}}}
        assert '.column' not in out['text']
        assert 'width=' not in out['text']


def test_add_paragraph_beside_padding_wrapper(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = '## A\n\n::: {style="padding:8px" data-step="2"}\n本文。\n:::\n'
    result = run(page, '''
      const s = await st(text), results = [];
      for (const side of ['before', 'after']) {
        const r = op.insertBlock(text, s, 'p0/0.0', side, '追加。'), next = await st(r.text);
        results.push({text:r.text, kinds:next.pages[0].chunks.map(c => c.kind)});
      }
      const p = op.pendingBelow(s, 'p0/0.0');
      return {results, owner:p.owner, atEnd:p.pos === s.pages[0].chunks[0].end};
    ''', text)
    assert result['results'][0]['kinds'] == ['text', 'box']
    assert result['results'][1]['kinds'] == ['box', 'text']
    assert result['results'][0]['text'] == text.replace('::: {style=', '追加。\n\n::: {style=')
    assert result['results'][1]['text'] == text.rstrip() + '\n\n追加。\n'
    assert result['owner'] is None
    assert result['atEnd']


def test_moves_only_when_order_changes(gui, page):
    _, srv = gui
    page.goto(srv.url)
    out = run(page, '''const s = await st(text);
      return [op.moves(text, s, 'p0/0', { key: 'p0/1', side: 'before' }), op.moves(text, s, 'p0/0', { key: 'p0/0', side: 'after' }),
              op.moves(text, s, 'p0/2', { key: 'p0/1', side: 'after' }), op.moves(text, s, 'p1/1', { pageEnd: 1 }),
              op.moves(text, s, 'p0/1.0', { key: 'p0/1.1', side: 'before' }), op.moves(text, s, 'p0/1', { into: 'p0/1.1' }),
              op.moves(text, s, 'p0/0', { key: 'p0/2', side: 'after' }), op.moves(text, s, 'p0/1.1', { key: 'p0/1.0', side: 'before' })];''')
    assert out == [False, False, False, False, False, False, True, True]


def test_decoration_keeps_wrappers_and_other_attributes(gui, page):
    _, srv = gui
    page.goto(srv.url)
    out = run(page, '''
      const values = { border: '3px dotted #11223380', 'background-color': '#aabbcc40' };
      let r = op.setTextOptions(text, await st(text), 'p0/0', { padding: '8px', align: 'center', step: 2 });
      let s = await st(r.text), key = op.keyAt(s, r.at, r.end);
      r = op.setDecoration(r.text, s, key, values);
      s = await st(r.text); key = r.select || op.keyAt(s, r.at, r.end);
      const decorated = r.text, attrs = op.find(s, key).chunk.attrs;
      const reset = op.setDecoration(r.text, s, key, { border: null, 'background-color': null }).text;
      return { decorated, attrs, reset, image: op.setDecoration(text, await st(text), 'p1/0', values).text,
        fig: op.setDecoration(text, await st(text), 'p1/1', values),
        column: op.setDecoration(text, await st(text), 'p0/1.0', values).text };
    ''')
    assert out['decorated'].count('border:3px dotted #11223380') == 1
    assert out['attrs']['kv']['data-step'] == '2'
    assert 'text-align:center' in out['attrs']['kv']['style']
    assert 'padding:8px;text-align:center' in out['reset'] and 'border:' not in out['reset']
    assert 'width=200 style="border:3px dotted #11223380;background-color:#aabbcc40"' in out['image']
    assert out['fig'] is None
    assert 'width="60%" style="border:' in out['column']



def test_align_follows_surrounding_alignment(gui, page):
    """テーマが中央揃えの所では、書いていない揃え＝中央。左を選んだら left を書き、中央に戻したら消す。"""
    _, srv = gui
    page.goto(srv.url)
    out = run(page, '''
      const s = await st(text), base = 'center';
      const shown = op.textOptions(op.find(s, 'p0/0').chunk, base).align;
      let r = op.setTextOptions(text, s, 'p0/0', { align: 'left', alignBase: base });
      const left = r.text, s2 = await st(r.text), key = op.keyAt(s2, r.at, r.end);
      r = op.setTextOptions(r.text, s2, key, { align: 'center', alignBase: base });
      return { shown, left, back: r.text };
    ''')
    assert out['shown'] == 'center'
    assert 'text-align:left' in out['left']
    assert out['back'] == DOC

def test_design_roundtrip_preserves_content_and_layout(gui, page):
    _, srv = gui
    page.goto(srv.url)
    out = run(page, '''
      const { designValues, clearDecoration } = await import('/web/block-design.js');

      const results = [];
      for (const kind of ['plain', 'top', 'left', 'quote', 'bracket', 'fold']) for (const key of ['p0/0', 'p0/1', 'p0/1.0', 'p1/0']) {
        const base = op.setSpace(text, await st(text), key, '16px').text;
        let r = op.setDecoration(base, await st(base), key === 'p0/0' ? 'p0/0.0' : key, designValues(kind));
        let s = await st(r.text), selected = r.select || op.keyAt(s, r.at, r.end);
        const chunk = op.find(s, selected).chunk;
        const decoration = op.decorationOf(r.text, chunk);
        const wrappers = r.text.match(new RegExp(`--block-design:${kind}`, 'g'))?.length;
        // 段階表示・揃えを変えても、装飾の囲みを二重に作らない。
        if (chunk.kind === 'text') {
          r = op.setTextOptions(r.text, s, selected, { step: 2, align: 'center' });
          s = await st(r.text); selected = op.keyAt(s, r.at, r.end);
          if (!op.isPadWrap(op.find(s, selected).chunk.parent)) throw new Error('wrapper lost');
          r = op.setTextOptions(r.text, s, selected, { step: 0, align: 'left' });
          s = await st(r.text); selected = op.keyAt(s, r.at, r.end);
        }
        const reset = op.setDecoration(r.text, s, selected, clearDecoration()).text;
        results.push({ decoration, kind, wrappers, restored: reset === base });
      }
      return results;
    ''')
    for result in out:
        assert result['restored']
        assert result['wrappers'] == 1
        assert result['decoration'] == {'--block-design': result['kind']}


def test_outer_spacing_preserves_other_options(gui, page):
    _, srv = gui
    page.goto(srv.url)
    out = run(page, '''
      let t = op.setPad(text, await st(text), 'p0/0', '8px').text;
      t = op.setDecoration(t, await st(t), 'p0/0.0', {border:'2px solid red'}).text;
      const spaced = op.setSpace(t, await st(t), 'p0/0', '0px 0px 42px 0px').text;
      const s = await st(spaced);
      const reset = op.setSpace(spaced, s, 'p0/0', null).text;
      const media = [];
      for (const key of ['p1/0', 'p1/1', 'p0/1', 'p0/1.0']) {
        const v = op.setSpace(text, await st(text), key, '16px').text;
        media.push([v, op.setSpace(v, await st(v), key, null).text]);
      }
      return {spaced, reset, t, hidden:op.isPadWrap(s.pages[0].chunks[0]), media};
    ''')
    assert '--block-space:0px 0px 42px 0px' in out['spaced']
    assert 'padding:8px' in out['spaced'] and 'border:2px solid red' in out['spaced']
    assert not out['hidden'] and out['reset'] == out['t']
    for spaced, reset in out['media']:
        assert '--block-space:16px' in spaced or 'space="16"' in spaced
        assert reset == DOC


def test_designed_box_keeps_boundary_when_adding_and_moving(gui, page):
    _, srv = gui
    page.goto(srv.url)
    out = run(page, '''
      const { designValues } = await import('/web/block-design.js');
      const results = [];
      for (const kind of ['plain', 'top', 'left', 'quote', 'bracket', 'fold']) {
        const framed = op.setDecoration(text, await st(text), 'p0/0', designValues(kind));
        const s = await st(framed.text), box = op.find(s, framed.select).chunk;
        const added = op.insertBlock(framed.text, s, box.key, 'after', '説明。');
        const moved = op.move(framed.text, s, 'p0/1', {key: box.children[0].key, side: 'after'});
        const ms = await st(moved.text), parent = ms.pages[0].chunks[0];
        const back = op.move(moved.text, ms, parent.children[1].key, {key: parent.key, side: 'after'});
        const pending = op.pendingBelow(s, box.key);
        const contentFirst = '## A\\n\\n::: {}\\n名前。\\n\\n説明。\\n:::\\n';
        const designedLast = op.setDecoration(contentFirst, await st(contentFirst), 'p0/0', designValues(kind));
        const shape = (t, b) => ({attrs: b.attrs, children: b.children.map(c => t.slice(c.start, c.end).trim())});
        const addedBox = (await st(added.text)).pages[0].chunks[0];
        const designedBox = (await st(designedLast.text)).pages[0].chunks[0];
        results.push({kind, selected: box.kind, hidden: op.isPadWrap(box), owner: pending.owner,
          sameOrder: JSON.stringify(shape(added.text, addedBox)) === JSON.stringify(shape(designedLast.text, designedBox)),
          added: addedBox.children.map(c => c.kind),
          moved: parent.children.map(c => c.kind), restored: back.text.replace(/\\n+/g, '\\n') === framed.text.replace(/\\n+/g, '\\n')});
      }
      return results;
    ''', '## A\n\n名前。\n\n説明。\n')
    for result in out:
        assert result['selected'] == 'box'
        assert not result['hidden']
        assert result['owner'] == 'p0/0'
        assert result['sameOrder']
        assert result['added'] == ['text', 'text']
        assert result['moved'] == ['text', 'text']
        assert result['restored']


def test_horizontal_split_and_design_have_one_column_structure(gui, page):
    _, srv = gui
    page.goto(srv.url)
    result = run(page, '''
      const { designValues } = await import('/web/block-design.js');
      const design = designValues('plain'), results = [];
      for (const method of ['addRight', 'addColumn']) {
        const split = async (t, key) => method === 'addRight'
          ? op.addRight(t, await st(t), key) : op.addColumn(t, await st(t), key, 'right', '右。');
        const framed = op.setDecoration(text, await st(text), 'p0/0', design);
        const first = await split(framed.text, framed.select);
        const splitFirst = await split(text, 'p0/0');
        const second = op.setDecoration(splitFirst.text, await st(splitFirst.text), 'p0/0.0.0', design);
        for (const r of [first, second]) {
          let t = r.text, s = await st(t);
          const added = op.insertBlock(t, s, 'p0/0.0', 'after', '説明。');
          const col = (await st(added.text)).pages[0].chunks[0].children[0];
          results.push({ attrs: col.attrs, kinds: col.children.map(c => c.kind),
            body: col.children.map(c => added.text.slice(c.start, c.end).trim()) });
        }
      }
      return results;
    ''', '## A\n\n名前。\n')
    assert all(r == result[0] for r in result)
    assert result[0]['kinds'] == ['text', 'text']
    assert result[0]['body'] == ['名前。', '説明。']
    assert result[0]['attrs']['classes'] == ['column']
    assert result[0]['attrs']['kv']['style'] == '--block-design:plain'


def test_design_merges_existing_single_box_into_column(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = '## A\n\n:::: {.columns}\n::: {.column width="45%"}\n::: {style="padding:12px;--block-design:plain"}\n名前。\n\n説明。\n:::\n:::\n::: {.column width="55%"}\n右。\n:::\n::::\n'
    for key in ['p0/0.0', 'p0/0.0.0']:
        result = run(page, '''
          const r = op.setDecoration(text, await st(text), KEY, {'--block-design':'top'});
          const col = (await st(r.text)).pages[0].chunks[0].children[0];
          return {selected:r.select, attrs:col.attrs, kids:col.children.map(c => c.kind)};
        '''.replace('KEY', repr(key)), text)
        assert result['selected'] == 'p0/0.0'
        assert result['kids'] == ['text', 'text']
        assert result['attrs']['kv'] == {'width': '45%', 'style': 'padding:12px;--block-design:top'}


def test_move_framed_box_into_empty_column_promotes_it(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = '## A\n\n::: {style="--block-design:plain;padding:12px"}\n名前。\n\n説明。\n:::\n\n:::: {.columns}\n::: {.column width="40%"}\n:::\n::: {.column width="60%"}\n右。\n:::\n::::\n'
    result = run(page, '''
      const r = op.move(text, await st(text), 'p0/0', {into:'p0/1.0'});
      const s = await st(r.text), col = s.pages[0].chunks[0].children[0];
      return {style:col.attrs.kv, kinds:col.children.map(c => c.kind), text:r.text, selected:op.keyAt(s, r.at, r.end)};
    ''', text)
    assert result['style'] == {'width': '40%', 'style': '--block-design:plain;padding:12px'}
    assert result['kinds'] == ['text', 'text']
    assert result['text'].count('--block-design:plain') == 1
    assert result['selected'] == 'p0/0.0'


def test_move_box_into_column_keeps_independent_styles(gui, page):
    _, srv = gui
    page.goto(srv.url)
    cases = [
        ('--block-design:plain', '--block-design:plain'),
        ('--block-design:plain', '--block-shadow:on'),
        ('font-size:1.2em', 'font-size:1.2em'),
        ('opacity:0.5', 'opacity:0.5'),
    ]
    for outer_style, inner_style in cases:
        text = (f'## A\n\n::: {{style="{inner_style}"}}\n名前。\n:::\n\n'
                f':::: {{.columns}}\n::: {{.column width="40%" style="{outer_style}"}}\n:::\n'
                '::: {.column width="60%"}\n右。\n:::\n::::\n')
        result = run(page, '''
          const r = op.move(text, await st(text), 'p0/0', {into:'p0/1.0'});
          const s = await st(r.text), col = s.pages[0].chunks[0].children[0], box = col.children[0];
          return {column:col.attrs.kv, kind:box.kind, box:box.attrs?.kv,
            contents:box.children.map(c => r.text.slice(c.start, c.end))};
        ''', text)
        assert result['column'] == {'width': '40%', 'style': outer_style}
        assert result['kind'] == 'box'
        assert result['box'] == {'style': inner_style}
        assert result['contents'] == ['名前。']


def test_design_after_adding_description_targets_column_and_can_be_removed(gui, page):
    _, srv = gui
    page.goto(srv.url)
    text = '## A\n\n:::: {.columns}\n::: {.column width="50%"}\n名前。\n\n説明。\n:::\n::: {.column width="50%"}\n右。\n:::\n::::\n'
    result = run(page, '''
      const { designValues, clearDecoration } = await import('/web/block-design.js');
      const r = op.setDecoration(text, await st(text), 'p0/0.0.0', designValues('plain'));
      const s = await st(r.text), col = s.pages[0].chunks[0].children[0];
      return {selected:r.select, kinds:col.children.map(c => c.kind),
        design:op.decorationOf(r.text, col.children[1]),
        restored:op.setDecoration(r.text, s, col.children[1].key, clearDecoration()).text};
    ''', text)
    assert result['selected'] == 'p0/0.0'
    assert result['kinds'] == ['text', 'text']
    assert result['design'] == {'--block-design': 'plain'}
    assert result['restored'] == text
