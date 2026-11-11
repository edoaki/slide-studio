import shutil

import pytest
from bs4 import BeautifulSoup
from starlette.testclient import TestClient

from slide_studio import assets, check, render, export
from slide_studio.bibliography import migrate, merge
from slide_studio.fsutil import write_atomic
from slide_studio.importer import import_deck
from slide_studio.server import build_app
from slide_studio.workspace import Workspace
from conftest import FIXTURES

BIB = '@article{one,\n title = {A {nested} title},\n slide-studio-status = {unverified}\n}\n'


def legacy(ws, name, bib, topic='test'):
    write_atomic(ws.qmd(name), f'---\nfigures: {topic}\ntheme: default\n---\n## Text {{#text}}\n[@one]\n## 参考文献 {{#references}}\n# Appendix {{#appendix}}\n')
    path = ws.deck_dir(name) / 'reference.bib'
    write_atomic(path, bib)
    return path


def test_merge_and_trash_are_idempotent(ws):
    a, b = legacy(ws, 'a', BIB), legacy(ws, 'b', BIB + '@book{two, title={Second}}\n')
    ws.ensure()
    assert not a.exists() and not b.exists()
    assert ws.bib('a') == ws.bib('b')
    assert ws.bib('a').read_text().count('@article{one,') == 1
    backups = list((ws.state / 'trash').rglob('reference.bib'))
    assert sorted(p.read_text() for p in backups) == sorted([BIB, BIB + '@book{two, title={Second}}\n'])
    before = ws.bib('a').read_bytes()
    ws.ensure()
    assert ws.bib('a').read_bytes() == before
    assert len(list((ws.state / 'trash').rglob('reference.bib'))) == 2
    assert assets.bib_entries(ws, 'b')[0]['unverified']


def test_conflict_keeps_whole_topic_untouched(ws):
    a = legacy(ws, 'a', BIB)
    b = legacy(ws, 'b', BIB.replace('title}', 'different}'))
    ws.ensure()
    assert a.exists() and b.exists()
    assert not ws.bib('a').exists()
    issues = ws.migration_preparation()
    assert 'one' in issues[0]['detail'] and 'a, b' in issues[0]['detail']
    write_atomic(b, BIB)
    ws.ensure()
    assert not ws.migration_preparation() and not b.exists()


def test_existing_shared_conflict_and_empty(ws):
    ws.new_deck('empty', 'test')
    assert ws.bib('empty').read_text() == ''
    assert not (ws.deck_dir('empty') / 'reference.bib').exists()
    write_atomic(ws.bib('empty'), BIB)
    old = legacy(ws, 'other', BIB.replace('nested', 'changed'))
    ws.ensure()
    assert old.exists() and ws.bib('empty').read_text() == BIB
    assert ws.migration_preparation()


def test_verify_only_selected_entry_and_invalidate_both_decks(ws):
    legacy(ws, 'a', BIB)
    legacy(ws, 'b', BIB)
    migrate(ws)
    before = check.deck_version(ws, 'b')
    client = TestClient(build_app(ws))
    result = client.post('/api/deck/a/bib', json={'key': 'one'})
    assert result.status_code == 200
    assert not assets.bib_entries(ws, 'b')[0]['unverified']
    assert before != check.deck_version(ws, 'b')


def test_nco_citations_and_html_unchanged_by_bib_migration(ws, monkeypatch):
    # 旧配置を用意し、旧配置の bib を読む描画を移行後と比較する。
    import_deck(ws, FIXTURES / 'nco-intro', 'nco')
    shared = ws.bib('nco-intro')
    old = ws.deck_dir('nco-intro') / 'reference.bib'
    shared.rename(old)
    with monkeypatch.context() as patch:
        patch.setattr(ws, 'bib', lambda deck, meta=None: old)
        before = render.render_deck(ws, 'nco-intro')
        issues = check.static_issues(ws, 'nco-intro', before)
        html = export.bundle_deck(ws, 'nco-intro').read_text()
    ws.ensure()
    after = render.render_deck(ws, 'nco-intro')
    assert after.cited == before.cited and not after.missing_cites
    assert check.static_issues(ws, 'nco-intro', after) == issues
    assert export.bundle_deck(ws, 'nco-intro').read_text() == html
    assert len(BeautifulSoup(after.html, 'html.parser').select('.csl-entry')) > 0


def test_merge_ignores_field_order_but_preserves_values(tmp_path):
    first, second = tmp_path / 'first.bib', tmp_path / 'second.bib'
    write_atomic(first, '% @article{not-an-entry\n@article{one, title={A, B}, year=2025}\n')
    write_atomic(second, '@article{one,\n year = 2025, title = {A, B}\n}\n')
    assert merge([first, second]).count('@article{one,') == 1
    write_atomic(second, '@article{one, title={A,  B}, year=2025}\n')
    with pytest.raises(ValueError, match='one'):
        merge([first, second])


def test_conflict_blocks_export_and_verify(ws):
    from slide_studio.workspace import StudioError
    from slide_studio.bibliography import verify
    legacy(ws, 'a', BIB)
    legacy(ws, 'b', BIB.replace('nested', 'other'))
    ws.ensure()
    with pytest.raises(StudioError, match='one'):
        render.render_deck(ws, 'a')
    with pytest.raises(StudioError, match='one'):
        verify(ws, 'a', 'one')


def test_portable_shared_citations_without_app(ws, tmp_path):
    import subprocess
    import sys
    ws.new_deck('talk', 'test')
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('説明を書く。', '[@one]'))
    write_atomic(ws.bib('talk'), BIB)
    moved = tmp_path / 'moved'
    shutil.move(ws.root, moved)
    result = subprocess.run([sys.executable, '-I', str(moved / 'build.py'), 'talk', '--html-only'],
                            cwd=tmp_path, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    assert 'A nested title' in BeautifulSoup((moved / 'decks/talk/発表タイトル.html').read_text(), 'html.parser').get_text()
