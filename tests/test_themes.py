"""テーマの型・移行・配色。撮影の検査は全ページ・全 step を対象にする。"""
import json
import re
import shutil

import pytest

from slide_studio import check, render, workspace
from slide_studio.fsutil import sha256_bytes, write_atomic
from slide_studio.importer import import_deck
from slide_studio.workspace import THEME_VARIABLES, TEMPLATES, Workspace, theme_variables
from conftest import FIXTURES, add_deck

THEMES = ('default', 'graphite', 'terracotta', 'solarized', 'night', 'mist')


def luminance(color):
    rgb = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return sum((c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4) * w
               for c, w in zip(rgb, (.2126, .7152, .0722)))


def contrast(a, b):
    low, high = sorted((luminance(a), luminance(b)))
    return (high + .05) / (low + .05)


@pytest.mark.parametrize('name', THEMES)
def test_theme_contract_and_contrast(name):
    css = (TEMPLATES / 'themes' / f'{name}.css').read_text()
    assert set(THEME_VARIABLES) <= set(theme_variables(css))
    assert '@import' not in css and 'url(' not in css and '@font-face' not in css
    colors = dict(re.findall(r'(--[\w-]+):\s*(#[0-9a-f]{6})\b', css))
    pairs = [(k, '--paper') for k in ('--ink', '--accent', '--link', '--header', '--muted', '--warn', '--good')]
    pairs += [('--mark-ink', '--mark'), ('--header-ink', '--header')]
    for a, b in pairs:
        assert contrast(colors[a], colors[b]) >= 4.5, (name, a, b, contrast(colors[a], colors[b]))
    assert '.method-slide' not in css and '.animation' not in css
    r, g, b = (int(colors['--link'][i:i + 2], 16) for i in (1, 3, 5))
    assert b > r + 40 and b > g, (name, colors['--link'])  # リンクはどのテーマでも青


def test_type_is_only_variables():
    css = re.sub(r'/\*.*?\*/', '', (TEMPLATES / 'themes' / '_base.css').read_text(), flags=re.S).strip()
    assert re.fullmatch(r':root\s*\{[^{}]+\}', css)
    assert len(THEME_VARIABLES) == 14


def test_copy_only_missing_and_hide_type(ws):
    assert set(ws.themes_list()) == set(THEMES)
    assert not (ws.themes / '_base.css').exists()
    for name in THEMES:
        write_atomic(ws.themes / f'{name}.css', '/* edited */')
    ws.ensure()
    assert all((ws.themes / f'{name}.css').read_text() == '/* edited */' for name in THEMES)
    (ws.themes / 'night.css').unlink()
    ws.ensure()
    assert (ws.themes / 'night.css').read_bytes() == (TEMPLATES / 'themes' / 'night.css').read_bytes()
    write_atomic(ws.themes / '_base.css', ':root{}')
    assert '_base' not in ws.themes_list()


def test_untouched_old_bundled_theme_is_upgraded(ws, monkeypatch):
    old = b'/* unmodified old night */'
    write_atomic(ws.themes / 'night.css', old)
    write_atomic(ws.themes / 'graphite.css', old)
    monkeypatch.setitem(workspace.OLD_THEMES, 'night.css', {sha256_bytes(old)})
    ws.ensure()
    assert (ws.themes / 'night.css').read_bytes() == (TEMPLATES / 'themes' / 'night.css').read_bytes()
    assert (ws.themes / 'graphite.css').read_bytes() == old  # 別のテーマの前の版とは見なさない


def test_placed_bundled_theme_follows_new_release(ws, monkeypatch, tmp_path):
    """置いた版のままなら次の版に揃え、手を入れたものは残す。"""
    src = tmp_path / 'themes'
    src.mkdir()
    shutil.copy(TEMPLATES / 'themes' / '_base.css', src)
    write_atomic(src / 'night.css', '/* v2 */')
    write_atomic(src / 'mist.css', '/* v2 */')
    monkeypatch.setattr(workspace, 'TEMPLATES', tmp_path)
    write_atomic(ws.themes / 'mist.css', (TEMPLATES / 'themes' / 'mist.css').read_text() + '/* mine */')
    ws.ensure()
    assert (ws.themes / 'night.css').read_text() == '/* v2 */'
    assert (ws.themes / 'mist.css').read_text().endswith('/* mine */')
    write_atomic(src / 'night.css', '/* v3 */')
    ws.ensure()
    assert (ws.themes / 'night.css').read_text() == '/* v3 */'


def test_migration_preserves_existing_deck_overrides(ws, monkeypatch):
    add_deck(ws, 't', '---\ntitle: t\ntopic: test\ntheme: default\n---\n\n## Test {#t}\n')
    path = ws.deck_dir('t') / 'styles' / 'slides.css'
    custom = '.reveal .method-slide .animation{height:123px}\n'
    write_atomic(path, custom)
    old = b'/* unmodified old release */'
    write_atomic(ws.themes / 'default.css', old)
    monkeypatch.setattr(workspace, 'OLD_DEFAULT_THEMES', {sha256_bytes(old)})
    ws.ensure()
    migrated = path.read_text()
    assert '.method-slide' in migrated and migrated.endswith(custom)
    assert (ws.themes / 'default.css').read_bytes() == (TEMPLATES / 'themes' / 'default.css').read_bytes()
    ws.ensure()
    assert path.read_text() == migrated
    assert not ws.theme_preparation()


def test_modified_old_theme_is_reported_and_preserved(ws):
    old = '/* edited old theme */\n:root{--ink:#123456}'
    write_atomic(ws.themes / 'default.css', old)
    ws.ensure()
    assert (ws.themes / 'default.css').read_text() == old
    assert ws.theme_preparation()[0]['ok'] is False
    assert 'styles/slides.css' in ws.theme_preparation()[0]['fix']
    write_atomic(ws.themes / 'default.css', (TEMPLATES / 'themes' / 'default.css').read_text().replace('#233244', '#223344'))
    assert not ws.theme_preparation()


@pytest.mark.parametrize('variable', THEME_VARIABLES)
def test_check_uses_type_variables(ws, variable):
    add_deck(ws, 't', '---\ntitle: t\ntopic: test\ntheme: default\n---\n\n## Test {#t}\n')
    css = (TEMPLATES / 'themes' / 'default.css').read_text()
    css = re.sub(rf'{re.escape(variable)}\s*:[^;}}]+;', '', css)
    css += f'/* {variable}: ignored; */'
    write_atomic(ws.themes / 'default.css', css)
    result = render.render_deck(ws, 't')
    errors = [x for x in check.static_issues(ws, 't', result) if x['kind'] == 'theme']
    assert len(errors) == 1 and variable in errors[0]['message']


@pytest.mark.parametrize('name', THEMES)
def test_nco_theme_check(tmp_path, name):
    ws = Workspace.open(tmp_path / name)
    import_deck(ws, FIXTURES / 'nco-intro', 'nco', theme=name)
    result = check.check_deck(ws, 'nco-intro')
    assert not result['errors'], result['errors']
    assert len(list((ws.build_dir('nco-intro') / 'shots').glob('*.png'))) == sum(s['steps'] for s in result['slides'])


def test_home_environment_reports_migration_without_stale_cache(ws, monkeypatch):
    from starlette.testclient import TestClient
    from slide_studio import doctor, server

    monkeypatch.setattr(doctor, 'check_pandoc', lambda: doctor.Item('Pandoc', True, 'ready'))
    monkeypatch.setattr(doctor, 'check_chromium', lambda: doctor.Item('Chromium', True, 'ready'))
    client = TestClient(server.build_app(ws))
    assert client.get('/api/env').json()['ok']
    write_atomic(ws.themes / 'default.css', '/* edited old */')
    report = client.get('/api/env').json()
    assert not report['ok']
    assert len(report['items']) == 3 and report['items'][-1]['ok'] is False
    write_atomic(ws.themes / 'default.css', (TEMPLATES / 'themes' / 'default.css').read_bytes())
    assert client.get('/api/env').json()['ok']


@pytest.mark.parametrize('name', THEMES)
def test_nco_theme_static_check(tmp_path, name):
    ws = Workspace.open(tmp_path / name)
    import_deck(ws, FIXTURES / 'nco-intro', 'nco', theme=name)
    rendered = render.render_deck(ws, 'nco-intro')
    assert len(rendered.slides) == 20
    assert not [x for x in check.static_issues(ws, 'nco-intro', rendered) if x['level'] == 'error']


def test_theme_tab_sample_page(ws):
    from bs4 import BeautifulSoup
    from starlette.testclient import TestClient
    from slide_studio import server

    client = TestClient(server.build_app(ws))
    r = client.get('/files/decks/__theme-sample__/sample.html?theme=night')
    assert r.status_code == 200
    html = BeautifulSoup(r.text, 'html.parser')
    assert html.select_one('#slide-studio-theme')['href'] == '../../themes/night.css'
    slides = html.select('#stage > .slide')
    assert [s.find('h2').get_text() for s in slides] == ['表紙', '見出し', '見出し']
    assert slides[2].select_one('.highlight').get_text() == 'ハイライト'
    assert client.get('/files/decks/__theme-sample__/sample.html?theme=nothing').status_code == 400


def test_retired_serif_is_not_recreated_and_custom_terracotta_survives(ws):
    old = '/* untouched serif */'
    write_atomic(ws.themes / 'serif.css', old)
    record = ws.state / 'bundled-themes.json'
    placed = json.loads(record.read_text())
    placed['serif.css'] = sha256_bytes(old.encode())
    write_atomic(record, json.dumps(placed))
    custom = (ws.themes / 'terracotta.css').read_text() + '\n/* my layout */'
    write_atomic(ws.themes / 'terracotta.css', custom)
    add_deck(ws, 'legacy', '---\ntheme: serif\n---\n\n## Keep content\n')
    ws.set_prefs(theme='serif', recent_themes=['serif', 'night', 'terracotta'])
    ws.ensure(); ws.ensure()
    assert ws.deck_theme('legacy') == 'terracotta'
    assert ws.prefs()['theme'] == 'terracotta'
    assert ws.prefs()['recent_themes'] == ['terracotta', 'night']
    assert not (ws.themes / 'serif.css').exists()
    assert (ws.themes / 'terracotta.css').read_text() == custom
    assert list((ws.state / 'trash/themes').glob('*/serif.css'))


@pytest.mark.parametrize('name', THEMES)
def test_block_palettes_are_distinct_and_readable(name):
    from slide_studio.theme_edit import read_vars
    values = read_vars((TEMPLATES / 'themes' / f'{name}.css').read_text())
    colors = []
    for kind in ('top', 'left', 'quote', 'bracket', 'fold'):
        ink, fill = (values[f'--block-{kind}-{part}'][:7] for part in ('ink', 'fill'))
        assert contrast(ink, fill) >= 4.5, (name, kind)
        colors.append(values[f'--block-{kind}-line'])
        assert contrast(fill, values['--paper'][:7]) >= 1.2, (name, kind)  # 地から見分けられる
    assert len(set(colors)) == 5
    assert values['--block-top-radius'] == '10px' and values['--block-bracket-radius'] == '0px'
    assert values['--block-top-line'].startswith('8px') and values['--block-left-line'].startswith('10px')


def test_old_palette_is_repainted_keeping_gui_overrides(ws):
    from slide_studio.theme_edit import read_vars, set_vars
    css = (TEMPLATES / 'themes/night.css').read_text().split('/* block palette v4:')[0]
    old = (':root {\n  --block-top-line:3.5px solid #112233ff;\n  --block-top-fill:#223344ff;\n'
           '  --block-top-radius:17px;\n}\n')
    path = ws.themes / 'mine.css'
    write_atomic(path, set_vars(css + '/* block palette v2: 旧 */\n' + old, {'--block-left-fill': '#abcdefff'}))
    ws.ensure()
    values = read_vars(path.read_text())
    assert '/* block palette v2:' not in path.read_text()
    assert values['--block-top-line'].startswith('8px') and values['--block-top-radius'] == '10px'
    assert values['--block-left-fill'] == '#abcdefff'
    assert list((ws.state / 'trash/themes').glob('*/mine.css'))


def test_custom_dark_theme_gets_readable_role_colors_without_overwriting_css(ws):
    from slide_studio.theme_edit import read_vars
    original = (TEMPLATES / 'themes/night.css').read_text().split('/* block palette v4:')[0]
    path = ws.themes / 'custom-night.css'
    write_atomic(path, original)
    ws.ensure()
    css = path.read_text()
    assert css.startswith(original)
    values = read_vars(css)
    lines = [values[f'--block-{k}-line'] for k in ('top', 'left', 'quote', 'bracket', 'fold')]
    assert len(set(lines)) == 5
    for kind in ('top', 'left', 'quote', 'bracket', 'fold'):
        assert contrast(values[f'--block-{kind}-ink'][:7], values[f'--block-{kind}-fill'][:7]) >= 4.5
    ws.ensure()
    assert path.read_text() == css


@pytest.mark.parametrize('retired', ['sage', 'simple'])
@pytest.mark.parametrize('with_css', [True, False])
def test_retired_theme_moves_decks_and_preferences_to_default(ws, with_css, retired):
    if with_css:
        write_atomic(ws.themes / f'{retired}.css', '/* customized retired theme */')
    original = f'---\ntheme: {retired}\n---\n\n## Keep content\n'
    add_deck(ws, 'legacy', original)
    ws.set_prefs(theme=retired, recent_themes=[retired, 'night', 'default'])
    ws.ensure()
    assert retired not in ws.themes_list()
    assert ws.qmd('legacy').read_text() == original.replace(f'theme: {retired}', 'theme: default')
    assert ws.prefs()['theme'] == 'default'
    assert ws.prefs()['recent_themes'] == ['default', 'night']
    backups = list((ws.state / 'trash/themes').glob('*/decks/legacy/slides.qmd'))
    assert len(backups) == 1 and backups[0].read_text() == original
    if with_css:
        assert list((ws.state / 'trash/themes').glob(f'*/{retired}.css'))[0].read_text() == '/* customized retired theme */'
    ws.ensure()
    assert retired not in ws.themes_list()
    assert len(list((ws.state / 'trash/themes').glob('*/decks/legacy/slides.qmd'))) == 1
