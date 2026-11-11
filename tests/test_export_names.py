from urllib.parse import unquote

import pytest
from starlette.testclient import TestClient

from slide_studio import export, server
from slide_studio.fsutil import write_atomic


@pytest.mark.parametrize('title, expected', [
    ('日本語のスライド名', '日本語のスライド名'),
    ('研究 / 比較:結果?', '研究 _ 比較_結果_'),
    ('改行\nした題名', '改行 した題名'),
    ('../', '_'),
    ('...', 'talk'),
    ('あ' * 100, 'あ' * 80),
])
def test_output_name(ws, title, expected):
    ws.new_deck('talk', 'test', title=title)
    assert export.output_path(ws, 'talk', 'html') == ws.deck_dir('talk') / f'{expected}.html'


@pytest.mark.parametrize('kind', ['html', 'pdf'])
def test_download_uses_japanese_title(ws, kind):
    ws.new_deck('talk', 'test', title='日本語のスライド名')
    path = export.output_path(ws, 'talk', kind)
    write_atomic(path, b'exported')
    client = TestClient(server.build_app(ws))
    response = client.get(f'/api/deck/talk/download/{kind}')
    assert response.status_code == 200
    assert response.content == b'exported'
    assert unquote(response.headers['content-disposition']) == f"attachment; filename*=utf-8''日本語のスライド名.{kind}"


def test_legacy_pagetitle_filename(ws):
    ws.new_deck('talk', 'test', title='以前の形式の題名')
    qmd = ws.qmd('talk')
    write_atomic(qmd, qmd.read_text().replace('title:', 'pagetitle:', 1))
    assert export.output_path(ws, 'talk', 'html').name == '以前の形式の題名.html'
