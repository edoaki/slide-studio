import pytest
from starlette.testclient import TestClient

from slide_studio.bibliography import listing, verify_path, update_path
from slide_studio.check import unverified_keys
from slide_studio.fsutil import write_atomic
from slide_studio.server import build_app


def test_status_parser_and_verification_preserve_other_entries(tmp_path):
    path = tmp_path / 'reference.bib'
    text = '''@article{ready, title={Complete}, note={slide-studio-status = {unverified}}}
  @article(pending, title={Complete}, author={Doe}, year={2025}, doi={10.1/example}, SLIDE-STUDIO-STATUS = "UNVERIFIED")
@article{other, title={Other}, slide-studio-status={unverified-extra}}
'''
    write_atomic(path, text)
    assert unverified_keys(path) == ['pending']
    assert [e['key'] for e in listing(path) if e['unverified']] == ['pending']
    verify_path(path, 'pending')
    assert not unverified_keys(path)
    assert path.read_text() == text.replace('SLIDE-STUDIO-STATUS = "UNVERIFIED"', '')
    with pytest.raises(KeyError):
        verify_path(path, 'absent')


def test_verify_topic_without_any_deck(ws):
    ws.new_topic('empty')
    path = ws.topic_dir('empty') / 'reference.bib'
    write_atomic(path, '@article{paper, title={Paper}, slide-studio-status={unverified}}')
    with TestClient(build_app(ws)) as client:
        assert client.post('/api/topic/empty/bib/verify', json={'key': 'absent'}).status_code == 400
        assert unverified_keys(path) == ['paper']
        assert client.post('/api/topic/empty/bib/verify', json={'key': 'paper'}).status_code == 200
        assert not unverified_keys(path)


def test_edit_fields_preserves_tex_other_fields_and_records(tmp_path):
    path = tmp_path / 'reference.bib'
    raw = '@article{paper, title={{DNA} and \\LaTeX}, year="2020", note=macro, author={Doe, Jane}}'
    other = '\n% Keep this comment\n@book{other, title={Other}}\n'
    write_atomic(path, raw + other)
    assert listing(path)[0]['editable']['title'] == '{DNA} and \\LaTeX'
    update_path(path, 'paper', {'year': '2024', 'doi': '10.1/example', 'author': ''}, raw)
    result = path.read_text()
    assert result.endswith(other)
    assert 'title={{DNA} and \\LaTeX}' in result
    assert 'note=macro' in result
    entry = listing(path)[0]
    assert entry['fields']['year'] == '2024'
    assert entry['fields']['doi'] == '10.1/example'
    assert 'author' not in entry['fields']
    with pytest.raises(ValueError, match='更新'):
        update_path(path, 'paper', {'year': '2025'}, raw)
    with pytest.raises(ValueError):
        update_path(path, 'paper', {'year': '2025}'}, entry['raw'])
    assert path.read_text() == result


def test_edit_bibliography_endpoints(ws):
    ws.new_deck('talk', 'test')
    ws.new_topic('empty')
    path = ws.topic_dir('empty') / 'reference.bib'
    raw = '@article{paper, title={Paper}, year={2020}}'
    write_atomic(path, raw)
    with TestClient(build_app(ws)) as client:
        response = client.patch('/api/topic/empty/bib', json={
            'key': 'paper', 'fields': {'year': '2024'}, 'original': raw,
        })
        assert response.status_code == 200
        assert listing(path)[0]['fields']['year'] == '2024'
        write_atomic(ws.bib('talk'), raw)
        response = client.patch('/api/deck/talk/bib?view=full', json={
            'key': 'paper', 'fields': {'year': '2025'}, 'original': raw,
        })
        assert response.status_code == 200
        assert response.json()['entries'][0]['fields']['year'] == '2025'
        assert client.patch('/api/deck/talk/bib', json={
            'key': 'paper', 'fields': {'year': '2026'}, 'original': raw,
        }).status_code == 400
