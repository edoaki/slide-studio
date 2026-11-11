from starlette.testclient import TestClient

from slide_studio import source
from slide_studio.fsutil import write_atomic, sha256_text
from slide_studio.server import build_app
from slide_studio.workspace import Workspace, set_front


def test_rename_and_direct_paths(tmp_path):
    root = tmp_path / 'old'
    write_atomic(root / 'figures/test/chart/figure.mjs', 'original')
    qmd = root / 'decks/talk/slides.qmd'
    write_atomic(qmd, '---\nfigures: test\ntheme: default\n---\n![](../../figures/test/chart/a.svg)\n{{< fig ./local >}}')
    write_atomic(root / 'decks/talk/figures/local/figure.mjs', 'local')
    ws = Workspace.open(root)
    assert not (root / 'figures').exists()
    assert (root / 'topics/test/html/chart/figure.mjs').read_text() == 'original'
    assert 'fig test/local' in qmd.read_text()
    assert not (root / 'decks/talk/figures').exists()
    assert (root / 'topics/test/html/local/figure.mjs').read_text() == 'local'
    assert ws.deck_shelf('talk') == 'test'
    ws.ensure()
    assert not ws.migration_preparation()


def test_old_key_and_priority():
    text = '---\nfigures: old\ntheme: default\n---\nBody\n'
    assert source.parse(text).meta['topic'] == 'old'
    assert set_front(text, {}) == text.replace('figures:', 'topic:')
    both = text.replace('theme:', 'topic: new\ntheme:')
    assert source.parse(both).meta['topic'] == 'new'
    saved = set_front(both, {'theme': 'night'})
    assert 'figures:' not in saved and 'topic: new' in saved and saved.endswith('Body\n')
    assert set_front('no front matter', {}) == 'no front matter'


def test_both_folders_are_preserved(tmp_path):
    for folder in ('figures', 'topics'):
        write_atomic(tmp_path / folder / 'test/data', folder)
    ws = Workspace.open(tmp_path)
    assert ws.migration_preparation()[0]['ok'] is False
    assert (tmp_path / 'figures/test/data').read_text() == 'figures'
    assert (tmp_path / 'topics/test/data').read_text() == 'topics'


def test_server_save_migrates_key(ws):
    ws.new_deck('talk', 'test')
    text = ws.qmd('talk').read_text().replace('topic:', 'figures:')
    write_atomic(ws.qmd('talk'), text)
    with TestClient(build_app(ws)) as client:
        response = client.put('/api/deck/talk/source', json={'text': text, 'base': sha256_text(text)})
    assert response.status_code == 200
    assert 'figures:' not in ws.qmd('talk').read_text()
    assert response.json()['version'] == sha256_text(ws.qmd('talk').read_text())


def test_cli_new_and_legacy_alias(ws):
    from slide_studio.cli import main
    for name, flag in [('new', '--topic'), ('old', '--figures')]:
        assert main(['--root', str(ws.root), 'new', name, flag, 'test']) == 0
        assert 'topic: test' in ws.qmd(name).read_text()
        assert 'figures:' not in ws.qmd(name).read_text()


def test_location_accepts_old_workspace(tmp_path, monkeypatch):
    from pathlib import Path
    from slide_studio.location import build_location_app
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    old = tmp_path / 'legacy'
    (old / 'decks').mkdir(parents=True)
    (old / 'figures').mkdir()
    with TestClient(build_location_app()) as client:
        result = client.post('/api/location', json={'mode': 'existing', 'path': str(old)})
    assert result.status_code == 200
    assert (old / 'topics').is_dir() and not (old / 'figures').exists()


def old_deck(root, deck, body, topic='test'):
    write_atomic(root / f'decks/{deck}/slides.qmd', f'---\nfigures: {topic}\ntheme: default\n---\n\n## Page {{#page}}\n\n{body}\n')


def test_copy_collisions_references_hashes_and_repeat(tmp_path):
    import json
    root = tmp_path / 'old'
    write_atomic(root / 'figures/test/shared/figure.mjs', 'shared')
    for deck, value in [('a', 'one'), ('b', 'two'), ('c', 'one')]:
        old_deck(root, deck, '![](images/plot.png)\n{{< fig ./chart >}}\n<iframe src="html/raw.html"></iframe>')
        write_atomic(root / f'decks/{deck}/images/plot.png', value)
        write_atomic(root / f'decks/{deck}/figures/chart/figure.mjs', value)
        write_atomic(root / f'decks/{deck}/html/raw.html', '<img src="../images/plot.png">')
    ws = Workspace.open(root)
    assert 'images/plot.png' in ws.qmd('a').read_text()
    assert 'images/plot-2.png' in ws.qmd('b').read_text()
    assert 'fig test/chart-2' in ws.qmd('b').read_text()
    assert 'fig test/chart ' in ws.qmd('c').read_text()
    assert not (ws.images_dir('a') / 'plot-3.png').exists()
    assert ws.images_dir('b').joinpath('plot-2.png').read_text() == 'two'
    assert '../images/plot.png' in (ws.shelf_dir('test') / 'raw.html').read_text()
    assert '../images/plot-2.png' in (ws.shelf_dir('test') / 'raw-2.html').read_text()
    assert 'html/raw-2.html' in ws.qmd('b').read_text()
    plan = json.loads((ws.state / 'migrate/topics-v1/manifest.json').read_text())
    assert plan['phase'] == 'done'
    assert plan['source_hashes']['decks/b/images/plot.png'] == plan['result_hashes']['topics/test/images/plot-2.png']
    assert (ws.state / 'trash/topics-v1/decks/b/figures/chart/figure.mjs').read_text() == 'two'
    before = (ws.state / 'migrate/topics-v1/manifest.json').read_bytes()
    ws.ensure()
    assert before == (ws.state / 'migrate/topics-v1/manifest.json').read_bytes()


def test_failure_before_switch_leaves_originals_and_can_resume(tmp_path, monkeypatch):
    from slide_studio import topic_migrate
    root = tmp_path / 'old'
    write_atomic(root / 'figures/test/chart/figure.mjs', 'original')
    old_deck(root, 'talk', '{{< fig test/chart >}}')
    original = (root / 'decks/talk/slides.qmd').read_bytes()
    with monkeypatch.context() as patch:
        patch.setattr(topic_migrate, 'finish', lambda *args: (_ for _ in ()).throw(OSError('interrupted')))
        import pytest
        with pytest.raises(OSError, match='interrupted'):
            Workspace.open(root)
    assert (root / 'figures/test/chart/figure.mjs').read_text() == 'original'
    assert not (root / 'topics').exists()
    assert (root / 'decks/talk/slides.qmd').read_bytes() == original
    ws = Workspace.open(root)
    assert (ws.shelf_dir('test') / 'chart/figure.mjs').read_text() == 'original'
    assert not (root / 'figures').exists()


def test_image_render_and_bundle_uses_shared_images(ws):
    from slide_studio import render, export, check
    import base64
    ws.new_deck('talk', 'test')
    write_atomic(ws.qmd('talk'), ws.qmd('talk').read_text().replace('説明を書く。', '![](images/plot.png)'))
    write_atomic(ws.images_dir('talk') / 'plot.png', base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII='))
    result = render.render_deck(ws, 'talk')
    assert '../../topics/test/images/plot.png' in result.html
    assert not [i for i in check.static_issues(ws, 'talk', result) if i['kind'] == 'missing']
    assert 'data:image/png;base64,' in export.bundle_deck(ws, 'talk').read_text()
    assert not (ws.deck_dir('talk') / 'images').exists()


def test_lib_collisions_keep_distinct_figures_and_rewrite_imports(tmp_path):
    root = tmp_path / 'old'
    for where, value in [('figures/test', 'one'), ('decks/talk/figures', 'two')]:
        write_atomic(root / where / '_lib/part.mjs', f'export default "{value}";')
        write_atomic(root / where / 'chart/figure.mjs', 'import x from "../_lib/part.mjs"; export default x;')
    old_deck(root, 'talk', '{{< fig ./chart >}}')
    ws = Workspace.open(root)
    assert 'fig test/chart-2' in ws.qmd('talk').read_text()
    assert '../_lib/part-2.mjs' in (ws.shelf_dir('test') / 'chart-2/figure.mjs').read_text()
    assert (ws.shelf_dir('test') / '_lib/part.mjs').read_text() == 'export default "one";'
    assert (ws.shelf_dir('test') / '_lib/part-2.mjs').read_text() == 'export default "two";'


def test_interrupted_qmd_switch_resumes(tmp_path, monkeypatch):
    import pytest
    from slide_studio import topic_migrate
    root = tmp_path / 'old'
    write_atomic(root / 'figures/test/chart/figure.mjs', 'original')
    old_deck(root, 'talk', '{{< fig test/chart >}}')
    original_write = topic_migrate.write_atomic
    def interrupted(path, data):
        if path == root / 'decks/talk/slides.qmd':
            raise OSError('interrupted')
        return original_write(path, data)
    with monkeypatch.context() as patch:
        patch.setattr(topic_migrate, 'write_atomic', interrupted)
        with pytest.raises(OSError, match='interrupted'):
            Workspace.open(root)
    assert (root / 'topics/test/html/chart/figure.mjs').exists()
    assert (root / 'figures/test/chart/figure.mjs').exists()
    ws = Workspace.open(root)
    assert not (root / 'figures').exists()
    assert 'topic: test' in ws.qmd('talk').read_text()
