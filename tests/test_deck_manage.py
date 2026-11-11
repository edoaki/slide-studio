"""ホームの発表管理：移動・控えの継続・取り消し・競合。"""
import asyncio
import json

import httpx
import pytest

from slide_studio import deck_manage, snapshot
from slide_studio.fsutil import write_atomic
from slide_studio.server import build_app
from slide_studio.workspace import StudioError


def setup_deck(ws):
    ws.new_deck('talk', 'test', title='元の題')
    for name, data in [('materials/data.csv', '1,2'), ('talk.html', '<html>'), ('talk.pdf', 'pdf')]:
        write_atomic(ws.deck_dir('talk') / name, data)
    write_atomic(ws.shelf_dir('test') / 'keep.txt', '共有')
    write_atomic(ws.build_dir('talk') / 'shots/p01-s0.png', b'png')
    snap = snapshot.take(ws, 'talk')
    write_atomic(ws.state / 'chat/talk.json', json.dumps({'tabs': [], 'rounds': [{'text': 'decks/talk/slides.qmd を直す', 'files': {'modified': ['decks/talk/slides.qmd']}, 'snapshot': snap.path.name}]}))
    return snap


def test_rename_state_snapshots_and_undo(ws):
    snap = setup_deck(ws)
    original = ws.qmd('talk').read_bytes()
    op = deck_manage.rename(ws, 'talk', 'renamed', '新しい題')
    assert not ws.has_deck('talk')
    assert ws.deck_meta('renamed')['title'] == '新しい題'
    assert (ws.deck_dir('renamed') / 'renamed.pdf').read_text() == 'pdf'
    assert (ws.build_dir('renamed') / 'shots/p01-s0.png').exists()
    assert ws.recent()[0]['deck'] == 'renamed'
    new_snap = snapshot.find(ws, 'renamed', snap.path.name)
    assert (new_snap.path / 'files/decks/renamed/slides.qmd').exists()
    manifest = json.loads((new_snap.path / 'manifest.json').read_text())
    assert 'decks/renamed/slides.qmd' in manifest
    chat = json.loads((ws.state / 'chat/renamed.json').read_text())
    assert chat['rounds'][0]['files']['modified'] == ['decks/renamed/slides.qmd']
    assert chat['rounds'][0]['text'] == 'decks/talk/slides.qmd を直す'
    deck_manage.undo(ws, op)
    assert ws.qmd('talk').read_bytes() == original
    assert snapshot.latest(ws, 'talk').deck == 'talk'
    assert (ws.deck_dir('talk') / 'talk.html').exists()
    assert (ws.state / 'chat/talk.json').exists()
    assert not ws.has_deck('renamed')


def test_rename_folder_only_keeps_source(ws):
    ws.new_deck('talk', 'test', title='元の題')
    original = ws.qmd('talk').read_bytes()
    op = deck_manage.rename(ws, 'talk', 'moved')
    assert ws.qmd('moved').read_bytes() == original
    deck_manage.undo(ws, op)
    assert ws.qmd('talk').read_bytes() == original and not ws.has_deck('moved')


def test_delete_and_restore_keeps_materials_and_shelf(ws):
    setup_deck(ws)
    op = deck_manage.delete(ws, 'talk')
    assert not ws.has_deck('talk') and not ws.build_dir('talk').exists()
    assert (op['trash'] / 'deck/materials/data.csv').read_text() == '1,2'
    assert (op['trash'] / 'chat').exists() and (op['trash'] / 'snapshots').exists()
    assert (ws.shelf_dir('test') / 'keep.txt').read_text() == '共有'
    assert ws.recent() == []
    deck_manage.undo(ws, op)
    assert (ws.deck_dir('talk') / 'materials/data.csv').exists()
    assert (ws.state / 'chat/talk.json').exists()
    assert snapshot.latest(ws, 'talk')
    assert ws.recent()[0]['deck'] == 'talk'


def test_collision_invalid_name_and_undo_conflicts(ws):
    setup_deck(ws)
    ws.new_deck('exists', 'test')
    for name in ('exists', '../escape', 'UPPER'):
        with pytest.raises(StudioError):
            deck_manage.rename(ws, 'talk', name, '失敗')
        assert ws.deck_meta('talk')['title'] == '元の題'
    op = deck_manage.delete(ws, 'talk')
    ws.new_deck('talk', 'test', title='別の発表')
    with pytest.raises(StudioError):
        deck_manage.undo(ws, op)
    assert ws.deck_meta('talk')['title'] == '別の発表'
    assert (op['trash'] / 'deck').exists()


def test_title_only_and_multiline_title(ws):
    ws.new_deck('talk', 'test')
    write_atomic(ws.qmd('talk'), '---\n# comment\ntitle: |\n  複数行\n  の題\ntopic: test\n---\n\n## 本文\nそのまま\n')
    original = ws.qmd('talk').read_text()
    op = deck_manage.rename(ws, 'talk', 'talk', '題: "引用"\n次の行')
    assert ws.deck_meta('talk')['title'] == '題: "引用"\n次の行'
    assert '# comment\n' in ws.qmd('talk').read_text()
    assert ws.qmd('talk').read_text().endswith('## 本文\nそのまま\n')
    deck_manage.undo(ws, op)
    assert ws.qmd('talk').read_text() == original


@pytest.mark.parametrize('front', [
    '{title: 元の題, topic: test, lang: ja}',
    '{topic: &t test, title: *t, lang: ja}',
    '{title: &t 元の題, topic: test, lang: ja, subtitle: *t}',
    '{topic: test, lang: ja}',
    '&meta {topic: test, lang: ja}',
    '{\n  title: 元の題,\n  topic: test, lang: ja\n}',
])
def test_title_change_preserves_flow_frontmatter(ws, front):
    ws.new_deck('talk', 'test')
    original = f'---\n{front}\n---\n\n## 本文\nそのまま\n'
    write_atomic(ws.qmd('talk'), original)

    op = deck_manage.rename(ws, 'talk', 'talk', '新しい題')

    assert ws.deck_meta('talk')['title'] == '新しい題'
    assert ws.deck_meta('talk')['topic'] == 'test'
    assert ws.deck_meta('talk')['lang'] == 'ja'
    assert ws.qmd('talk').read_text().endswith('## 本文\nそのまま\n')
    deck_manage.undo(ws, op)
    assert ws.qmd('talk').read_text() == original


@pytest.mark.parametrize('front', [
    'topic: &t test\ntitle: *t\nlang: ja',
    'title: &t 元の題\ntopic: test\nlang: ja\nsubtitle: *t',
])
def test_title_change_preserves_block_yaml_anchors(ws, front):
    ws.new_deck('talk', 'test')
    original = f'---\n{front}\n---\n\n## 本文\nそのまま\n'
    write_atomic(ws.qmd('talk'), original)

    op = deck_manage.rename(ws, 'talk', 'talk', '新しい題')

    meta = ws.deck_meta('talk')
    assert meta['title'] == '新しい題'
    assert meta['topic'] == 'test'
    assert meta['lang'] == 'ja'
    assert ws.qmd('talk').read_text().count('\ntitle:') == 1
    if 'subtitle:' in front:
        assert meta['subtitle'] == '新しい題'
    assert ws.qmd('talk').read_text().endswith('## 本文\nそのまま\n')
    deck_manage.undo(ws, op)
    assert ws.qmd('talk').read_text() == original


def test_partial_failure_rolls_back(ws, monkeypatch):
    setup_deck(ws)
    original = deck_manage.Change.write
    def fail(self, path, data):
        if path == ws.qmd('renamed'):
            raise OSError('disk error')
        original(self, path, data)
    monkeypatch.setattr(deck_manage.Change, 'write', fail)
    with pytest.raises(OSError):
        deck_manage.rename(ws, 'talk', 'renamed', '失敗')
    assert ws.has_deck('talk') and not ws.has_deck('renamed')
    assert snapshot.latest(ws, 'talk')
    assert (ws.state / 'chat/talk.json').exists()


def test_api_rejects_running_memo_and_stale_undo(ws):
    ws.new_deck('talk', 'test')
    async def run():
        app = build_app(ws)
        chat = app.state.chat
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            chat.running['run'] = ('talk', 'memo')
            home = (await client.get('/api/home')).json()
            assert home['recent'][0]['running']
            body = {'action': 'rename', 'deck': 'talk', 'name': 'renamed', 'title': '新しい題'}
            assert (await client.post('/api/home/manage', json=body)).status_code == 423
            chat.running.clear()
            app.state.shots.active_deck = 'talk'
            assert (await client.post('/api/home/manage', json=body)).status_code == 409
            app.state.shots.active_deck = None
            app.state.shots.active_job_deck = 'talk'
            assert (await client.post('/api/home/manage', json=body)).status_code == 409
            app.state.shots.active_job_deck = None
            app.state.shots.pending.append('talk')
            # メモリ上の記録も、移動後に新しい名前から読み直せる。
            chat.state('talk')
            response = await client.post('/api/home/manage', json=body)
            assert response.status_code == 200
            assert 'talk' not in app.state.shots.pending
            assert 'talk' not in chat.data
            assert (ws.state / 'chat/renamed.json').exists()
            assert (await client.post('/api/home/manage', json={'action': 'undo', 'token': 'wrong'})).status_code == 400
            assert (await client.post('/api/home/manage', json={'action': 'undo', 'token': response.json()['token']})).status_code == 200
            assert ws.has_deck('talk')
    asyncio.run(run())


def test_symlink_is_rejected(ws, tmp_path):
    setup_deck(ws)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (ws.decks / 'linked').symlink_to(outside, target_is_directory=True)
    with pytest.raises(StudioError):
        deck_manage.rename(ws, 'talk', 'linked', '失敗')
    assert ws.has_deck('talk')


def test_chat_snapshot_restores_after_rename(ws):
    snap = setup_deck(ws)
    original = ws.qmd('talk').read_text()
    write_atomic(ws.qmd('talk'), original + '\nAI の追記\n')
    snapshot.finish(ws, snap)
    deck_manage.rename(ws, 'talk', 'renamed', '新しい題')
    moved = snapshot.find(ws, 'renamed', snap.path.name)
    changes = snapshot.run_changes(ws, moved)
    assert changes['modified'] == ['decks/renamed/slides.qmd']
    assert not changes['added'] and not changes['deleted']
    snapshot.restore_run(ws, moved)
    assert ws.qmd('renamed').read_text() == original
    assert not ws.deck_dir('talk').exists()


def test_rename_undo_does_not_overwrite_new_deck_or_edits(ws):
    setup_deck(ws)
    op = deck_manage.rename(ws, 'talk', 'renamed', '新しい題')
    ws.new_deck('talk', 'test', title='別の発表')
    with pytest.raises(StudioError):
        deck_manage.undo(ws, op)
    assert ws.deck_meta('talk')['title'] == '別の発表'
    write_atomic(ws.qmd('renamed'), ws.qmd('renamed').read_text() + '\n後の編集\n')
    with pytest.raises(StudioError, match='原稿が変わった'):
        deck_manage.undo(ws, op)
    assert '後の編集' in ws.qmd('renamed').read_text()
