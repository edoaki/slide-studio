import pytest
from starlette.testclient import TestClient

from conftest import add_deck
from slide_studio import theme_edit
from slide_studio.fsutil import write_atomic
from slide_studio.server import build_app
from slide_studio.workspace import TEMPLATES


def test_table_math_colors_save_and_restore_without_changing_other_rules():
    css = (TEMPLATES / 'themes/mist.css').read_text()
    values = dict(zip(theme_edit.CONTENT_COLORS, ['#112233', '#ffffff', '#445566', '#778899']))
    changed = theme_edit.set_vars(css, values)
    assert {k: theme_edit.read_vars(changed)[k] for k in values} == values
    assert theme_edit.restore(changed, css) == css
    again = theme_edit.set_vars(changed, {'--math-ink': '#123456', '--header': '#abcdef'})
    assert again.count('/* slide-studio math-ink */') == 1
    assert theme_edit.TABLE_HEADER_RE.search(again)[1] == '#1b4a7c'
    assert theme_edit.read_vars(again)['--table-header-bg'] == '#112233'
    assert theme_edit.restore(again, changed) == changed
    with pytest.raises(ValueError):
        theme_edit.set_vars(css, {'--math-ink': 'red; color:blue'})
    with pytest.raises(ValueError):
        theme_edit.restore(changed, changed.replace('color: var(--math-ink)', 'display: none'))


def test_heading_fill_preserves_title_colors_and_undo(ws):
    css = (TEMPLATES / 'themes/mist.css').read_text()
    changed = theme_edit.set_vars(css, {'--header': '#f7f9fc'})
    assert theme_edit.TITLE_RE.search(changed)[1] == '#1b4a7c'
    again = theme_edit.set_vars(changed, {'--header': '#ffffff'})
    assert theme_edit.TITLE_RE.search(again)[1] == '#1b4a7c'
    assert again.count('/* slide-studio title header */') == 1
    assert theme_edit.restore(again, css) == css
    # 旧版で背景と同色になった保存済みテーマも、他の編集を保って修復する。
    legacy = theme_edit.TITLE_RE.sub('', changed)
    write_atomic(ws.themes / 'mist.css', legacy)
    ws.ensure()
    repaired = (ws.themes / 'mist.css').read_text()
    assert theme_edit.TITLE_RE.search(repaired)[1] == '#1b4a7c'
    assert theme_edit.read_vars(repaired)['--header'] == '#f7f9fc'
    ws.ensure()
    assert (ws.themes / 'mist.css').read_text() == repaired


def test_changes_only_root_values_and_preserves_comments():
    css = '''/* :root { --ink: bad; } */
:root {
  --ink : #123456 /* keep */;
  --font-body: "Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;
  --custom: red;
}
h2 { --ink: #123456; color: var(--ink); }
@media print { :root { --ink: #123456; } }
'''
    result = theme_edit.set_vars(css, {'--ink': '#abcdef', '--font-body': theme_edit.FONTS[1]})
    assert result == css.replace('--ink : #123456', '--ink : #abcdef').replace(theme_edit.FONTS[0], theme_edit.FONTS[1])
    assert theme_edit.read_vars(result)['--ink'] == '#abcdef'


@pytest.mark.parametrize('values', [{'--custom': '#ffffff'}, {'--ink': 'red; color:red'}, {'--ink': None}, {'--font-body': 'url(https://invalid)'}, {'--missing': '#123456'}])
def test_reject_invalid(values):
    with pytest.raises(ValueError):
        theme_edit.set_vars(':root { --ink: #123456; }', values)


def test_create_edit_conflict_and_select(ws):
    add_deck(ws, 'one', '---\ntheme: default\n---\n\n## One\n')
    with TestClient(build_app(ws)) as c:
        t = c.get('/api/themes/default').json()
        assert t['decks'] == ['one']
        original = (ws.themes / 'default.css').read_text()
        r = c.put('/api/themes/default', json={'base': t['version'], 'vars': {'--ink': '#112233'}})
        assert r.status_code == 200
        assert (ws.themes / 'default.css').read_text() == original.replace('--ink: #233244', '--ink: #112233')
        assert c.put('/api/themes/default', json={'base': t['version'], 'vars': {'--ink': '#334455'}}).status_code == 409
        r = c.put('/api/themes/default', json={'base': r.json()['version'], 'vars': {'--ink': t['vars']['--ink']}})
        assert r.status_code == 200
        assert (ws.themes / 'default.css').read_text() == original
        text = ws.qmd('one').read_text()
        r = c.post('/api/themes/select', json={'text': text, 'theme': 'night'})
        assert r.json()['text'] == text.replace('theme: default', 'theme: night')
        assert ws.qmd('one').read_text() == text


def test_register_reset_and_remove(ws):
    add_deck(ws, 'one', '---\ntheme: night\n---\n\n## One\n')
    with TestClient(build_app(ws)) as c:
        t = c.get('/api/themes/night').json()
        assert t['modified'] is False and not t['removable']
        r = c.put('/api/themes/night', json={'base': t['version'], 'vars': {'--ink': '#112233'}})
        edited = (ws.themes / 'night.css').read_text()
        assert r.json()['modified'] is True
        # 直したテーマを元に登録する。型からは作らない
        assert c.post('/api/themes', json={'name': 'mine'}).status_code == 400
        assert c.post('/api/themes', json={'name': 'mine', 'from': 'night', 'base': t['version']}).status_code == 409
        r = c.post('/api/themes', json={'name': 'mine', 'from': 'night', 'base': r.json()['version']})
        assert r.status_code == 201 and r.json()['modified'] is False and r.json()['removable']
        assert (ws.themes / 'mine.css').read_text() == edited
        assert c.post('/api/themes', json={'name': 'mine', 'from': 'night', 'base': r.json()['version']}).status_code == 409
        # デフォルト＝登録したときの CSS。直してから戻す・取り消す・やり直す
        m = c.put('/api/themes/mine', json={'base': r.json()['version'], 'vars': {'--ink': '#445566'}}).json()
        m = c.put('/api/themes/mine', json={'base': m['version'], 'reset': True}).json()
        assert (ws.themes / 'mine.css').read_text() == edited and m['modified'] is False
        u = c.put('/api/themes/mine', json={'base': m['version'], 'css': m['before']}).json()
        assert u['vars']['--ink'] == '#445566'
        assert c.put('/api/themes/mine', json={'base': u['version'], 'css': m['css']}).json()['modified'] is False
        # 同梱テーマのデフォルトは同梱の版
        c.put('/api/themes/night', json={'base': c.get('/api/themes/night').json()['version'], 'reset': True})
        assert (ws.themes / 'night.css').read_bytes() == (TEMPLATES / 'themes/night.css').read_bytes()
        # 使っている発表があるテーマ・default は消せない
        assert c.delete('/api/themes/night').status_code == 400
        assert c.delete('/api/themes/default').status_code == 400
        r = c.delete('/api/themes/mine')
        assert r.status_code == 200 and (ws.root / r.json()['trash']).read_text() == edited
        assert not (ws.themes / 'mine.css').exists() and ws.theme_default('mine') is None
        assert c.delete('/api/themes/solarized').status_code == 200
    # 消した同梱テーマは起動し直しても置き直さない
    ws.ensure()
    assert not (ws.themes / 'solarized.css').exists() and (ws.themes / 'terracotta.css').exists()


def test_preview_events_distinguish_theme_from_content(ws):
    import asyncio
    from slide_studio.workspace import set_front
    add_deck(ws, 'one', '---\ntheme: default\n---\n\n## One\n\nBody\n')
    srv = build_app(ws).state.studio
    events = []
    srv.broadcast = events.append

    async def run():
        await srv.render('one')
        assert not events[-1]['theme_only']
        write_atomic(ws.qmd('one'), set_front(ws.qmd('one').read_text(), {'theme': 'night'}))
        await srv.render('one')
        assert events[-1]['theme_only'] and events[-1]['theme'] == 'night'
        await srv.render('one', force=True, theme_only=True)
        assert events[-1]['theme_only']
        await srv.render('one', force=True)
        assert not events[-1]['theme_only']
        write_atomic(ws.qmd('one'), ws.qmd('one').read_text().replace('Body', 'Changed'))
        await srv.render('one', force=True, theme_only=True)
        assert not events[-1]['theme_only']
    asyncio.run(run())


def test_preserve_crlf_and_duplicate_declarations():
    css = ':root {\r\n --ink: #123456; /* keep */\r\n --ink: #abcdef;\r\n}\r\n'
    assert theme_edit.set_vars(css, {'--ink': '#112233'}) == css.replace('#123456', '#112233').replace('#abcdef', '#112233')


def test_restore_duplicate_values_exactly_and_reject_other_changes():
    css = ':root { --ink:#123456; --ink:#abcdef !important; } /* keep */\nh2 {color:red}'
    changed = theme_edit.set_vars(css, {'--ink': '#112233'})
    assert '!important' in changed
    assert theme_edit.restore(changed, css) == css
    with pytest.raises(ValueError):
        theme_edit.restore(changed, css.replace('color:red', 'color:blue'))
    with pytest.raises(ValueError):
        theme_edit.restore(changed, css.replace('/* keep */', '/* lost */'))


def test_heading_gradient_legacy_edit_and_exact_undo():
    # 以前の default の見出しのグラデーションの直接指定
    css = (TEMPLATES / 'themes/default.css').read_text() + '#stage h2{background:linear-gradient(105deg,#123c62,#205c8b)}\n'
    edited = theme_edit.set_vars(css, {'--header': '#abcdef'})
    assert theme_edit.read_vars(edited)['--header-fill'] == 'linear-gradient(105deg, var(--header), #205c8b)'
    assert '#stage h2 { background: var(--header-fill); }' in edited
    gradient = 'linear-gradient(180deg, var(--header), #aabbcc)'
    changed = theme_edit.set_vars(edited, {'--header-fill': gradient})
    assert theme_edit.read_vars(changed)['--header-fill'] == gradient
    assert changed.count('/* slide-studio heading fill */') == 1
    assert theme_edit.restore(changed, css) == css
    assert theme_edit.restore(css, changed) == changed
    solid = theme_edit.set_vars(changed, {'--header-fill': 'var(--header)'})
    assert theme_edit.read_vars(solid)['--header-fill'] == 'var(--header)'
    with pytest.raises(ValueError):
        theme_edit.set_vars(css, {'--header-fill': 'url(https://invalid)'})
    with pytest.raises(ValueError):
        theme_edit.restore(css, changed.replace('background: var(--header-fill)', 'background: red'))


def test_background_spots_preserve_theme_and_undo():
    css = ':root { --header: #1f4a78; --paper: #f5f3ef; }\n#stage h2 { color:var(--header); background:none; }'
    # 見出し色は帯なしのテーマでも背景に適用する。
    heading = theme_edit.set_vars(css, {'--header': '#123456'})
    assert theme_edit.read_vars(heading)['--header-fill'] == 'var(--header)'
    background = 'radial-gradient(ellipse at 80% 20%, color-mix(in srgb, #112233 40%, transparent), transparent 70%), var(--paper)'
    edited = theme_edit.set_vars(heading, {'--background-fill': background})
    assert theme_edit.read_vars(edited)['--background-fill'] == background
    assert theme_edit.restore(edited, css) == css
    assert theme_edit.restore(css, edited) == edited
    both = theme_edit.set_vars(edited, {'--header-fill': 'linear-gradient(90deg, var(--header), #445566)'})
    both = theme_edit.set_vars(both, {'--background-fill': background.replace('80%', '20%')})
    assert both.count('/* slide-studio heading fill */') == 1
    assert both.count('/* slide-studio page background */') == 1
    assert theme_edit.restore(both, css) == css
    assert theme_edit.set_vars(edited, {'--background-fill': 'theme'}) == heading
    for value in [None, 'url(https://invalid)', background.replace('80%', '200%'), background + ';color:red']:
        with pytest.raises(ValueError):
            theme_edit.set_vars(css, {'--background-fill': value})


def test_page_section_cover_backgrounds_are_independent():
    css = (TEMPLATES / 'themes/mist.css').read_text()
    # テーマから読み取った点：楕円の大きさ・ページの外の位置・斜めの下地を持つ
    spot = 'radial-gradient(ellipse 42% 62% at -8% 112%, color-mix(in srgb, #5581ad 80%, transparent), transparent 72%)'
    section = f'{spot}, linear-gradient(160deg, #d4dedd, #c2cad2), var(--paper)'
    edited = theme_edit.set_vars(css, {'--section-fill': section, '--cover-fill': '#123456'})
    values = theme_edit.read_vars(edited)
    assert (values['--background-fill'], values['--section-fill'], values['--cover-fill']) == ('theme', section, '#123456')
    assert '#stage .slide.section-slide { background: var(--section-fill); box-shadow: none; }' in edited
    assert '#stage .slide.cover { background: var(--cover-fill); box-shadow: none; }' in edited
    assert theme_edit.restore(edited, css) == css
    assert theme_edit.restore(css, edited) == edited
    assert theme_edit.set_vars(edited, {'--section-fill': 'theme', '--cover-fill': 'theme'}) == css
    for bad in [section.replace('42% 62%', '42% 260%'), section.replace('-8%', '-180%'), section.replace('#d4dedd', 'red'), '#12345']:
        with pytest.raises(ValueError):
            theme_edit.set_vars(css, {'--section-fill': bad})


def test_block_decoration_round_trip_and_validation():
    css = ':root { --ink: #123456; }\np { margin: 0; }\n'
    values = {'--block-border': '2.5px dashed #12345680', '--block-background': '#abcdef40'}
    changed = theme_edit.set_vars(css, values)
    assert all(theme_edit.read_vars(changed)[k] == v for k, v in values.items())
    assert theme_edit.restore(changed, css) == css
    assert theme_edit.restore(css, changed) == changed
    assert theme_edit.set_vars(changed, dict.fromkeys(values, 'theme')) == css
    for value in ['-1px solid #123456ff', '2px url(x) #123456ff', 'none; color:red', None]:
        with pytest.raises(ValueError):
            theme_edit.set_vars(css, {'--block-border': value})
    with pytest.raises(ValueError):
        theme_edit.restore(changed, changed.replace('2.5px dashed', '2.5px invalid'))
    # 初期値だけを持ち、ブロックへ適用する規則は書かない。
    assert 'var(--block-border)' not in changed
    # 以前の全ブロック適用の規則も読み取り、解除できる。
    legacy = changed.replace(':root { --block-border: 2.5px dashed #12345680; }\n', ':root { --block-border: 2.5px dashed #12345680; }\n%s { border: var(--block-border); }\n' % theme_edit.LEGACY_BLOCK_SELECTOR)
    assert legacy != changed and theme_edit.read_vars(legacy)['--block-border'] == '2.5px dashed #12345680'
    assert theme_edit.set_vars(legacy, {'--block-border': 'theme', '--block-background': 'theme'}) == css


def test_block_design_colors_round_trip():
    css = ':root { --ink: #123456; }\n'
    values = {'--block-top-line': '6px solid #2167a8ff', '--block-top-fill': '#edf6fa80', '--block-shadow-color': '#65758b55',
              '--block-corner-left': '3.5px solid #7d739eff'}
    changed = theme_edit.set_vars(css, values)
    assert all(theme_edit.read_vars(changed)[k] == v for k, v in values.items())
    assert theme_edit.read_vars(changed)['--block-left-fill'] == 'theme'
    assert theme_edit.set_vars(changed, dict.fromkeys(values, 'theme')) == css
    # 線は太さ・種類・色、それ以外は色だけ
    for key, value in [('--block-top-fill', '4px solid #2167a8ff'), ('--block-top-line', '#2167a8ff'), ('--block-shadow-color', 'red')]:
        with pytest.raises(ValueError):
            theme_edit.set_vars(css, {key: value})


def test_legacy_fill_rules_upgrade_and_restore():
    css = (TEMPLATES / 'themes/terracotta.css').read_text()
    edited = theme_edit.set_vars(css, {'--header-fill': 'var(--header)'})
    legacy = edited.replace('#stage h2, #stage h2 * { color: var(--header-ink); }\n', '') + (theme_edit.BG_OVERRIDE % 'linear-gradient(180deg, var(--paper), #aabbcc)').replace(' box-shadow: none;', '')
    assert theme_edit.read_vars(legacy)['--cover-fill'] == 'linear-gradient(180deg, var(--paper), #aabbcc)'
    assert theme_edit.read_vars(legacy)['--header-fill'] == 'var(--header)'
    upgraded = theme_edit.set_vars(legacy, {'--background-fill': 'linear-gradient(90deg, var(--paper), #aabbcc)', '--header-ink': '#112233'})
    assert 'box-shadow: none;' in upgraded
    assert '#stage h2, #stage h2 * { color: var(--header-ink); }' in upgraded
    assert theme_edit.restore(upgraded, legacy) == legacy
    # 以前の全ページの指定は、章扉・表紙にも同じ値を残して3つに分ける。
    assert {k: theme_edit.read_vars(upgraded)[k] for k in ('--section-fill', '--cover-fill')} == dict.fromkeys(('--section-fill', '--cover-fill'), 'linear-gradient(180deg, var(--paper), #aabbcc)')
    assert theme_edit.BG_RE.search(upgraded) is None
    reset = theme_edit.set_vars(upgraded, {'--background-fill': 'theme', '--section-fill': 'theme', '--cover-fill': 'theme', '--header-fill': 'theme', '--header-ink': '#fff8ed'})
    assert reset == css + theme_edit.INK_OVERRIDE


def test_direct_gradient_angles_stops_roundtrip():
    css = (TEMPLATES / 'themes/default.css').read_text()
    for key, base in [('--header-fill', '--header'), ('--background-fill', '--paper')]:
        value = f'linear-gradient(237deg, var({base}) 12%, #abcdef 81%)'
        changed = theme_edit.set_vars(css, {key: value})
        assert theme_edit.read_vars(changed)[key] == value
        assert theme_edit.restore(changed, css) == css
        for bad in [value.replace('237deg', '360deg'), value.replace('12%', '101%'), value + '; color:red']:
            with pytest.raises(ValueError):
                theme_edit.set_vars(css, {key: bad})


def test_independent_heading_ink_and_optional_link():
    css = (TEMPLATES / 'themes/terracotta.css').read_text()
    ink = theme_edit.set_vars(css, {'--header-ink': '#112233'})
    assert theme_edit.read_vars(ink)['--header-fill'] == 'theme'
    assert theme_edit.INK_OVERRIDE in ink
    assert theme_edit.restore(ink, css) == css
    legacy = ':root { --accent: #123456; }'
    link = theme_edit.set_vars(legacy, {'--link': '#abcdef'})
    assert theme_edit.read_vars(link)['--link'] == '#abcdef'
    assert theme_edit.read_vars(link)['--accent'] == '#123456'
    assert theme_edit.restore(link, legacy) == legacy


def test_heading_free_points_roundtrip_and_validation():
    css = (TEMPLATES / 'themes/default.css').read_text()
    point = 'radial-gradient(ellipse at 30% 70%, color-mix(in srgb, #112233 65%, transparent), transparent 90%)'
    value = f'{point}, {point}, var(--header)'
    changed = theme_edit.set_vars(css, {'--header-fill': value})
    assert theme_edit.read_vars(changed)['--header-fill'] == value
    assert theme_edit.restore(css, changed) == changed
    assert theme_edit.restore(changed, css) == css
    for invalid in [value.replace('30%', '160%'), value.replace('90%', '151%'), ', '.join([point]*9)+', var(--header)', value+';color:red']:
        with pytest.raises(ValueError):
            theme_edit.set_vars(css, {'--header-fill': invalid})
        with pytest.raises(ValueError):
            theme_edit.restore(css, changed.replace(value, invalid))


def test_heading_mode_options_and_undo():
    css = (TEMPLATES / 'themes' / 'terracotta.css').read_text()
    filled = theme_edit.set_vars(css, {'--header': '#aabbcc'})
    assert theme_edit.read_vars(filled)['--heading-mode'] == 'fill'
    ruled = theme_edit.set_vars(filled, {'--heading-mode': 'rule', '--heading-rule-style': 'double', '--heading-rule-width': '4px', '--heading-rule-inset': '0px'})
    assert theme_edit.read_vars(ruled)['--heading-mode'] == 'rule'
    assert theme_edit.restore(ruled, filled) == filled
    assert theme_edit.restore(filled, css) == css
    for key, value in [('--heading-rule-width', '7px'), ('--heading-rule-style', 'url(x)'), ('--heading-mode', 'both')]:
        with pytest.raises(ValueError):
            theme_edit.set_vars(css, {key: value})


def test_heading_fill_mode_uses_heading_ink_and_upgrades_old_block(ws):
    # mist の h2 は文字も --header。帯にしたら文字は［見出しの文字］の色にする
    css = (TEMPLATES / 'themes' / 'mist.css').read_text()
    filled = theme_edit.set_vars(css, {'--heading-mode': 'fill'})
    assert '#stage .slide > h2, #stage .slide > h2 * { color:var(--header-ink); }' in filled
    old = filled.replace('#stage .slide > h2, #stage .slide > h2 * { color:var(--header-ink); }\n', '')
    assert theme_edit.refresh_heading_options(old) == filled
    assert theme_edit.refresh_heading_options(css) == css
    write_atomic(ws.themes / 'mist.css', old)
    ws.ensure()
    assert (ws.themes / 'mist.css').read_text() == filled


def test_old_cover_layout_is_dropped_when_preparing_themes(ws):
    """以前の版がスライドで表紙を動かして書いた位置・大きさは、テーマを用意するときに取り除く。"""
    path = ws.themes / 'terracotta.css'
    css = path.read_text()
    layout = ('\n/* slide-studio cover layout */\n'
              '#stage .slide.cover > .cover-title { position:absolute; left:55px; top:204px; margin:0; max-width:calc(100% - 55px - var(--content-inset, 0px)); font-size:54px; }\n'
              '#stage .slide.cover > .cover-authors { font-size:37px; }\n')
    write_atomic(path, css + layout)
    ws.ensure()
    assert path.read_text() == css


def test_block_shape_settings_roundtrip_and_ranges():
    css = ':root { --ink: #123456; }\n'
    values = {'--block-quote-line': '3.5px solid #789abcff', '--block-quote-ink': '#112233ff',
              '--block-quote-radius': '12px', '--block-quote-shadow': '0.35'}
    changed = theme_edit.set_vars(css, values)
    assert all(theme_edit.read_vars(changed)[k] == v for k, v in values.items())
    assert '--block-quote-accent:#789abcff' in changed
    assert theme_edit.set_vars(changed, dict.fromkeys(values, 'theme')) == css
    for key, value in [('--block-border', '0.5px solid #112233ff'), ('--block-top-radius', '41px'),
                       ('--block-top-shadow', '1.1')]:
        with pytest.raises(ValueError):
            theme_edit.set_vars(css, {key: value})


def test_reset_can_save_current_theme(ws):
    with TestClient(build_app(ws)) as c:
        original = (ws.themes / 'default.css').read_text()
        t = c.get('/api/themes/default').json()
        edited = c.put('/api/themes/default', json={'base': t['version'], 'vars': {'--ink': '#112233'}}).json()
        body = {'base': edited['version'], 'reset': True, 'save_as': 'saved'}
        assert c.put('/api/themes/default', json={**body, 'base': t['version']}).status_code == 409
        assert not (ws.themes / 'saved.css').exists()
        assert c.put('/api/themes/default', json={**body, 'save_as': 'night'}).status_code == 409
        assert c.put('/api/themes/default', json={**body, 'save_as': '../bad'}).status_code == 400
        assert (ws.themes / 'default.css').read_text() == edited['css']
        r = c.put('/api/themes/default', json=body)
        assert r.status_code == 200 and r.json()['modified'] is False
        assert (ws.themes / 'saved.css').read_text() == edited['css']
        assert ws.theme_default('saved') == edited['css']
        assert (ws.themes / 'default.css').read_text() == original


@pytest.mark.parametrize('layout', ['{x: 120, y: -40, size: 42, position: right}', '\n  x: 120\n  y: -40\n  size: 42\n  position: right'])
def test_select_theme_resets_only_cover_positions(ws, layout):
    from slide_studio import source
    text = ('---\ntheme: default\nauthor: Alice\ncover-authors-layout: ' + layout + '\ntitle: Talk\n---\n\n'
            '## Talk {.cover}\n\n::: {.cover-title style="left:100px;top:80px;font-size:90px"}\nTitle\n:::\n\n'
            '::: {.cover-subtitle style="top:20px;color:red"}\nSubtitle\n:::\n\n'
            '## Body\n\n::: {.cover-title style="left:100px"}\nUnchanged\n:::\n')
    with TestClient(build_app(ws)) as client:
        same = client.post('/api/themes/select', json={'text': text, 'theme': 'default'})
        assert same.json()['text'] == text
        response = client.post('/api/themes/select', json={'text': text, 'theme': 'graphite'})
    assert response.status_code == 200
    result = response.json()['text']
    assert 'style="font-size:90px"' in result
    assert 'style="color:red"' in result
    assert result.split('## Body')[1] == text.split('## Body')[1]
    meta = source.parse(result).meta
    assert meta['cover-authors-layout'] == {'size': 42, 'position': 'right'}
    assert meta['title'] == 'Talk' and meta['author'] == 'Alice'
