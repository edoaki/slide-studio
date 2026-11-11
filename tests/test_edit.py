import pytest

from slide_studio import source
from slide_studio.edit import cell_markdown, chunk_info, to_markdown
from slide_studio.render import render_text
from conftest import SYNC, add_deck


@pytest.mark.parametrize('path', sorted(SYNC.glob('*.qmd')), ids=lambda p: p.stem)
def test_roundtrip_and_isolated_changes(path):
    raw = path.read_bytes()
    doc = source.parse(raw.decode())
    assert source.rewrite(doc).encode() == raw
    for page in doc.pages:
        for chunk in page.walk():
            if chunk.kind != 'text':
                continue
            key = f'p{page.index}/{chunk.path}'
            text = source.rewrite(doc, {key: doc.text[chunk.start:chunk.end] + '変更'})
            assert text[:chunk.start] == doc.text[:chunk.start]
            assert text[chunk.end + 2:] == doc.text[chunk.end:]
            assert text[:page.start] == doc.text[:page.start]
            assert text[page.end + 2:] == doc.text[page.end:]


def test_direct_edit_expectations(ws):
    add_deck(ws, 'test', '')
    cache = {}
    for line in (SYNC / 'expected.md').read_text().splitlines():
        cells = [x.strip() for x in line.split('|')[1:-1]]
        if len(cells) != 7 or not cells[0].endswith('.qmd'):
            continue
        name, _, index, _, _, _, disabled = cells
        if name not in cache:
            rendered = render_text(ws, 'test', (SYNC / name).read_text())
            cache[name] = rendered.doc, chunk_info(rendered)
        doc, info = cache[name]
        page = doc.pages[int(index)]
        actual = [c.path for c in page.walk() if c.kind == 'text' and not info[f'p{index}/{c.path}']['direct']]
        assert actual == disabled.split(), name


def test_nco_every_text_can_be_changed_and_restored(nco_ws):
    text = nco_ws.qmd('nco-intro').read_text()
    doc = source.parse(text)
    for page in doc.pages:
        for c in page.walk():
            if c.kind != 'text':
                continue
            key = f'p{page.index}/{c.path}'
            original = text[c.start:c.end]
            changed = source.rewrite(doc, {key: original + '追記'})
            assert source.rewrite(source.parse(changed), {key: original}) == text


def test_nested_move_delete_definitions_and_raw_only():
    text = (SYNC / 'nested-columns.qmd').read_text()
    doc = source.parse(text)
    c = source.locate(doc, 'p0/0.1.1.0')[1]
    changed = source.rewrite(doc, {'p0/0.1.1.0': '変更'})
    assert source.locate(source.parse(changed), 'p0/0.1.1.0')[1].kind == 'text'
    assert changed == text[:c.start] + '変更' + text[c.end:]
    # 同じ列の中で順序を変え、囲みと他の列を保持する。
    moved = source.move_chunk(doc, 'p0/0.0.1', 0, 'p0/0.0.0')
    new_doc = source.parse(moved)
    old_left = source.locate(doc, 'p0/0.0.1')[1]
    new_left = source.locate(new_doc, 'p0/0.0.0')[1]
    assert moved[new_left.start:new_left.end] == text[old_left.start:old_left.end]
    old_right = source.locate(doc, 'p0/0.1')[1]
    new_right = source.locate(new_doc, 'p0/0.1')[1]
    assert moved[new_right.start:new_right.end] == text[old_right.start:old_right.end]
    with pytest.raises(ValueError):
        source.move_chunk(doc, 'p0/0', 0, 'p0/0.0.0')
    text = (SYNC / 'link-def.qmd').read_text() + '\n## 次 {#next}\n\n次の段落。\n'
    doc = source.parse(text)
    definition = next(text[c.start:c.end] for c in doc.pages[0].chunks if c.kind == 'def')
    moved = source.move_chunk(doc, 'p0/2', 1)
    assert definition in moved
    assert len(source.parse(moved).pages[1].chunks) == 2
    raw = (SYNC / 'unclosed-div.qmd').read_text()
    assert source.rewrite(source.parse(raw), {'p0/0': '編集'})
    with pytest.raises(ValueError):
        source.move_chunk(source.parse(raw), 'p0/0', 1)
    fixed = raw + '\n:::\n'
    assert not any(p.raw_only for p in source.parse(fixed).pages)


def test_image_options_keep_unknown_attributes():
    doc = source.parse('## A\n\n![alt](images/a.png){#img .x width=200 title="a"}\n')
    result = source.image_options(doc, 'p0/0', 320, 'right')
    assert '#img .x' in result and 'title="a"' in result
    assert 'width=320' in result and 'fig-align="right"' in result
    # 揃えだけを変えるとき（スライドのツールバー）は、書いてある幅を残す
    aligned = source.image_options(source.parse(result), 'p0/0', None, 'left')
    assert 'width=320' in aligned and 'fig-align="left"' in aligned and 'fig-align="right"' not in aligned


def test_atoms_survive_text_edits(ws):
    add_deck(ws, 'test', '')
    for name in ('cite-multi', 'two-footnotes', 'math'):
        r = render_text(ws, 'test', (SYNC / (name + '.qmd')).read_text())
        html = chunk_info(r)['p0/0']['html']
        assert html
        md = to_markdown(html.replace('</p>', '追記</p>'))
        c = r.doc.pages[0].chunks[0]
        assert md == r.doc.text[c.start:c.end] + '追記'


@pytest.mark.parametrize('literal', [
    '`@code [^code] $code$`',
    '``@code ` [^code] $code$``',
    '`@code\n[^code] $code$`',
    r'\@code \[^code] \$code\$',
    '$ literal `@code [^code] $code$` $',
    '$literal `@code [^code]`$2',
])
def test_literal_atom_syntax_does_not_break_real_atoms(ws, literal):
    add_deck(ws, 'test', '', bib='@misc{a, title={Alpha}, year={2020}}')
    body = literal + ' と [@a] と脚注[^a] と $x$ と本文'
    text = '---\ntopic: test\n---\n## 本文\n\n' + body + '\n\n[^a]: 注です\n'
    rendered = render_text(ws, 'test', text)
    html = chunk_info(rendered)['p0/0']['html']
    from bs4 import BeautifulSoup

    atoms = BeautifulSoup(html, 'html.parser').select('[data-slide-studio-atom]')
    assert [el['data-slide-studio-atom'] for el in atoms] == ['[@a]', '[^a]', '$x$']
    edited = to_markdown(html.replace('本文', '変更'))
    assert '[@a]' in edited and '[^a]' in edited and '$x$' in edited
    assert '変更' in edited


@pytest.mark.parametrize('prefix', ['', r'\\'])
def test_backtick_in_math_does_not_hide_following_atoms(ws, prefix):
    add_deck(ws, 'test', '', bib='@misc{a, title={Alpha}, year={2020}}')
    body = prefix + '$x`$ と `@code [^code]` と [@a] と脚注[^a] と本文'
    rendered = render_text(ws, 'test', '---\ntopic: test\n---\n## 本文\n\n' + body + '\n\n[^a]: 注です\n')
    html = chunk_info(rendered)['p0/0']['html']
    edited = to_markdown(html.replace('本文', '変更'))
    assert '$x`$' in edited and '[@a]' in edited and '[^a]' in edited


@pytest.mark.parametrize('citation', [
    '@a.', '@a:', '@a;', '@a!', '@a.b.', '-@a.',
    '@a [p. 2].', '-@a [pp. 2–3].',
    'https://example.com/@a.', '@a [site](relative/path).', '[@a, p. $x$].',
])
def test_narrative_citation_keeps_punctuation_and_locator(ws, citation):
    add_deck(ws, 'test', '', bib='@misc{a, title={Alpha}, year={2020}}\n@misc{a.b, title={Beta}, year={2021}}')
    body = f'See {citation} Text'
    rendered = render_text(ws, 'test', '## Body\n\n' + body + '\n')
    html = chunk_info(rendered)['p0/0']['html']
    assert to_markdown(html.replace('Text', 'Changed')) == body.replace('Text', 'Changed')


@pytest.mark.parametrize('literal', [
    '<https://example.com/@a>',
    '[site](https://example.com/@a)',
    '[site](https://example.com/(foo)/@a)',
    '[site](relative/@a "title (and @a)")',
    '$x_{@a}$',
])
def test_at_sign_in_link_or_math_does_not_break_citation(ws, literal):
    add_deck(ws, 'test', '', bib='@misc{a, title={Alpha}, year={2020}}')
    body = f'See [@a] with {literal} and note[^n]. Text'
    rendered = render_text(ws, 'test', '## Body\n\n' + body + '\n\n[^n]: Note\n')
    html = chunk_info(rendered)['p0/0']['html']
    assert to_markdown(html.replace('Text', 'Changed')) == body.replace('Text', 'Changed')


def test_footnote_after_narrative_citation_is_not_a_locator(ws):
    add_deck(ws, 'test', '', bib='@misc{a, title={Alpha}, year={2020}}')
    body = 'See @a [^n]. Text'
    rendered = render_text(ws, 'test', '## Body\n\n' + body + '\n\n[^n]: Note\n')
    html = chunk_info(rendered)['p0/0']['html']
    assert to_markdown(html.replace('Text', 'Changed')) == body.replace('Text', 'Changed')


def test_invalid_link_keeps_real_citations(ws):
    from bs4 import BeautifulSoup

    add_deck(ws, 'test', '', bib='@misc{a, title={Alpha}, year={2020}}\n@misc{b, title={Beta}, year={2021}}')
    body = 'See [@a] with [site](relative/@b "a" tail). Text'
    rendered = render_text(ws, 'test', '## Body\n\n' + body + '\n')
    html = chunk_info(rendered)['p0/0']['html']
    atoms = BeautifulSoup(html, 'html.parser').select('.citation')
    assert [el.get('data-slide-studio-atom') for el in atoms] == ['[@a]', '@b']
    edited = to_markdown(html.replace('Text', 'Changed'))
    assert '[@a]' in edited and '@b' in edited and 'Changed' in edited


def test_padded_citation_with_trailing_space(nco_ws):
    text = nco_ws.qmd('nco-intro').read_text()
    raw = next(line for line in text.splitlines() if line.startswith('制約を満たす'))
    padded = '::: {style="padding:0px 12px 71px 12px"}\n' + raw + ' \t\n:::'
    rendered = render_text(nco_ws, 'nco-intro', text.replace(raw, padded))
    chunk = next(c for p in rendered.doc.pages for c in p.walk()
                 if c.kind == 'text' and rendered.doc.text[c.start:c.end] == raw + ' \t')
    page = next(p for p in rendered.doc.pages if chunk in list(p.walk()))
    info = chunk_info(rendered)[f'p{page.index}/{chunk.path}']
    assert info['direct']
    original = rendered.doc.text[chunk.start:chunk.end]
    assert to_markdown(info['html'], original) == original
    assert to_markdown(info['html'].replace('制約を満たす', '条件を満たす'), original) == original.replace('制約を満たす', '条件を満たす')


def test_text_format_roundtrips(ws):
    """書式バーで付けた色（テーマの色の名前・自由な色）と大きさは、スライド上で直接編集できる（§10.5）。"""
    add_deck(ws, 'test', '')
    text = ('## A {#a}\n\n[強調]{.accent}と[注意 **太字**]{.warn}と[赤]{style="color: #e5484d"}と'
            '[大きい]{style="font-size: 1.25em"}と[両方]{.good style="font-size: 0.75em"}。\n')
    rendered = render_text(ws, 'test', text)
    assert chunk_info(rendered)['p0/0']['direct']
    # フォントは全体の設定だけで変える。本文に書いた font-family は残さない
    assert to_markdown('<p><span style="font-family: serif">字</span></p>') == '字'


def test_plain_newline_stays_in_one_editable_block(ws):
    from bs4 import BeautifulSoup

    add_deck(ws, 'test', '')
    body = ('**Open**：拠点に戻らなくてよい　**Multi-Depot**：拠点が複数ある\n'
            '**Skill**：能力による適合制約　**Time Window**：時間窓制約')
    rendered = render_text(ws, 'test', '## A {#a}\n\n' + body + '\n\n別のブロック\n')
    assert len(rendered.doc.pages[0].chunks) == 2
    info = chunk_info(rendered)
    assert info['p0/0']['direct'] and info['p0/1']['direct']
    block = BeautifulSoup(info['p0/0']['html'], 'html.parser')
    assert len(block.select('p')) == 1
    assert len(block.select('br')) == 1
    assert [s.text for s in block.select('strong')] == ['Open', 'Multi-Depot', 'Skill', 'Time Window']
    changed = to_markdown(info['p0/0']['html'].replace('能力', '技能'), body)
    updated = render_text(ws, 'test', '## A {#a}\n\n' + changed + '\n')
    assert len(updated.doc.pages[0].chunks) == 1
    assert len(BeautifulSoup(updated.html, 'html.parser').select('[data-slide-studio="p0/0"] br')) == 1


def test_cover_title_and_subtitle_are_plain_text_in_a_wrap(ws):
    """表紙のタイトル・副題の囲みは箱で、中の文はスライドで直せる。表紙の欄が書いた <br> の改行も直せる。"""
    add_deck(ws, 'test', '')
    text = ('---\ntitle: "発表"\ntopic: test\ntheme: default\n---\n\n## 発表 {#cover .cover}\n\n'
            '::: {.cover-title}\n発表<br>タイトル\n:::\n\n::: {.cover-subtitle style="padding: 8px"}\n副題\n:::\n\n# 章 {#c}\n')
    rendered = render_text(ws, 'test', text)
    chunks = list(rendered.doc.pages[0].walk())
    assert [(c.path, c.kind) for c in chunks] == [('0', 'box'), ('0.0', 'text'), ('1', 'box'), ('1.0', 'text')]
    info = chunk_info(rendered)
    assert info['p0/0.0']['direct'] and info['p0/1.0']['direct']
    assert to_markdown(info['p0/0.0']['html'], '発表<br>タイトル') == '発表\\\nタイトル'


TABLE = '''## 表

| 項目 | 方式 [@a] | $x|y$ |
|:---|---:|---|
| 成功率<br>（数） | **100%** | - |
|  | a \\| b | `c|d` |
'''


def _table(ws):
    add_deck(ws, 'test', '')
    rendered = render_text(ws, 'test', TABLE)
    return rendered.doc, chunk_info(rendered)['p0/0']


def test_table_rows_follow_pandoc_cell_splitting():
    raw = TABLE.split('\n\n', 1)[1].strip()
    rows = source.table_rows(raw)
    assert [[raw[a:b].strip() for a, b in r] for r in rows] == [
        ['項目', '方式 [@a]', '$x|y$'],
        ['成功率<br>（数）', '**100%**', '-'],
        ['', 'a \\| b', '`c|d`'],
    ]
    assert source.table_rows('普通の段落') is None
    assert source.table_rows('a\n---') is None


def test_table_cells_can_be_edited_one_by_one(ws):
    doc, info = _table(ws)
    assert info['direct'] is False
    # 引用・数式・改行・太字・エスケープがあっても、原稿の書き方のまま往復できるセルは直せる
    assert all(cell['direct'] for row in info['cells'] for cell in row), info['cells']
    assert 'data-slide-studio-atom="[@a]"' in info['cells'][0][1]['html']
    for html, expected in [
        ('<td>新しい</td>', '| 新しい | 方式 [@a] |'),
        ('<td><strong>太</strong>と<span style="font-size: 1.2em">大</span></td>', '| **太**と[大]{style="font-size: 1.2em"} | 方式 [@a] |'),
        ('<th>一<br>二<br><br></th>', '| 一<br>二 | 方式 [@a] |'),
        ('<td>a|b</td>', '| a\\|b | 方式 [@a] |'),
    ]:
        out = source.set_cell(doc, 'p0/0', 0, 0, cell_markdown(html))
        assert expected in out, out
        # ほかの行は1文字も変えない
        assert out.split('\n')[3:] == doc.text.split('\n')[3:]


def test_empty_cell_gets_text_and_bad_cell_is_rejected(ws):
    doc, _ = _table(ws)
    assert '| 埋めた | a \\| b |' in source.set_cell(doc, 'p0/0', 2, 0, '埋めた')
    with pytest.raises(ValueError):
        source.set_cell(doc, 'p0/0', 9, 0, 'x')


def test_table_cells_do_not_require_identical_markdown(ws):
    add_deck(ws, 'test', '')
    raw = '## 表\n\n| 名前 | 説明 |\n|---|---|\n| [色]{style="color: #c00;"} | 複数   空白 |\n'
    info = chunk_info(render_text(ws, 'test', raw))['p0/0']
    assert all(cell['direct'] and cell['html'] for row in info['cells'] for cell in row)
    assert '変更' in cell_markdown(info['cells'][1][1]['html'].replace('空白', '変更'))
