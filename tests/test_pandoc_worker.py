"""常駐/単発変換の一致と、プロセスの再利用・復旧。"""
import concurrent.futures

import pytest

from conftest import SYNC, add_deck
from slide_studio import pandoc_worker as worker
from slide_studio import render

ARGS = ['--from', 'markdown', '--to', 'html5', '--wrap=none']


@pytest.mark.parametrize('path', sorted(SYNC.glob('*.qmd')), ids=lambda p: p.stem)
def test_render_matches_process(ws, monkeypatch, path):
    add_deck(ws, 'test', '')
    text = path.read_text()
    monkeypatch.setenv('SLIDE_STUDIO_PANDOC_MODE', 'process')
    expected = render.render_text(ws, 'test', text)
    monkeypatch.delenv('SLIDE_STUDIO_PANDOC_MODE')
    actual = render.render_text(ws, 'test', text)
    assert worker._render.workers[0].process is not None
    assert worker._render.workers[0].process.poll() is None
    assert actual.html == expected.html
    assert actual.warnings == expected.warnings
    assert actual.missing_cites == expected.missing_cites


def test_nco_matches_process(nco_ws, monkeypatch):
    monkeypatch.setenv('SLIDE_STUDIO_PANDOC_MODE', 'process')
    expected = render.render_deck(nco_ws, 'nco-intro')
    monkeypatch.delenv('SLIDE_STUDIO_PANDOC_MODE')
    actual = render.render_deck(nco_ws, 'nco-intro')
    assert worker._render.workers[0].process is not None
    assert worker._render.workers[0].process.poll() is None
    assert actual.html == expected.html
    assert actual.warnings == expected.warnings


def test_reuses_process_and_recovers_after_exit(tmp_path):
    w = worker.Worker()
    try:
        assert w.convert('First', ARGS, tmp_path, 5).stdout == '<p>First</p>\n'
        pid = w.process.pid
        assert w.convert('Second', ARGS, tmp_path, 5).stdout == '<p>Second</p>\n'
        assert w.process.pid == pid
        w.process.kill(); w.process.wait()
        assert w.convert('Third', ARGS, tmp_path, 5).stdout == '<p>Third</p>\n'
        assert w.process.pid != pid
    finally:
        w.close()
    assert w.process is None


def test_error_and_warnings_do_not_leak(tmp_path):
    w = worker.Worker()
    try:
        bad = w.convert('---\na: [b\n---\n', ARGS, tmp_path, 5)
        assert bad.returncode == 1 and 'line' in bad.stderr
        pid = w.process.pid
        warning = w.convert('[@missing]', [*ARGS, '--citeproc'], tmp_path, 5)
        assert 'missing' in warning.stderr
        good = w.convert('Fine', ARGS, tmp_path, 5)
        assert good.returncode == 0 and good.stderr == ''
        assert w.process.pid == pid
    finally:
        w.close()


def test_parallel_requests_and_cwd_isolation(tmp_path):
    pool = worker.Pool(2)
    args = [*ARGS, '--citeproc', '--bibliography', 'refs.bib']
    for i in range(8):
        folder = tmp_path / str(i); folder.mkdir()
        (folder / 'refs.bib').write_text(f'@book{{ref, title={{Book{i}}}, author={{Author{i}}}, year={{2020}}}}')
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda i: pool.convert('[@ref]', args, tmp_path / str(i), 5), range(8)))
        for i, result in enumerate(results):
            assert result.returncode == 0
            assert f'Book{i}' in result.stdout
            assert f'Book{(i+1)%8}' not in result.stdout
    finally:
        pool.close()


def test_reads_changed_bibliography_in_same_directory(tmp_path):
    w = worker.Worker()
    args = [*ARGS, '--citeproc', '--bibliography', 'refs.bib']
    try:
        for title in ('Before', 'After'):
            (tmp_path / 'refs.bib').write_text(f'@book{{ref, title={{{title}}}, author={{Someone}}, year={{2020}}}}')
            result = w.convert('[@ref]', args, tmp_path, 5)
            assert result.returncode == 0 and title in result.stdout
    finally:
        w.close()


def test_timeout_kills_worker_and_next_request_recovers(tmp_path, monkeypatch):
    script = tmp_path / 'stuck.lua'
    script.write_text('io.stdout:setvbuf("no"); io.write(\'{"ready":true}\\n\'); for line in io.lines() do while true do end end')
    w = worker.Worker()
    try:
        with monkeypatch.context() as m:
            m.setattr(worker, 'SCRIPT', script)
            with pytest.raises(ValueError):
                w.convert('Text', ARGS, tmp_path, .2)
        assert w.process is None
        assert w.convert('Recovered', ARGS, tmp_path, 5).stdout == '<p>Recovered</p>\n'
    finally:
        w.close()


def test_unavailable_worker_falls_back(tmp_path, monkeypatch):
    def unavailable(*args):
        raise OSError('worker unavailable')
    monkeypatch.setattr(worker._render, 'convert', unavailable)
    result = worker.run('Fallback', ARGS, cwd=tmp_path)
    assert result.returncode == 0 and result.stdout == '<p>Fallback</p>\n'


def test_server_lifespan_warms_and_stops_workers(ws):
    import asyncio
    from slide_studio.server import build_app

    async def run():
        app = build_app(ws)
        async with app.router.lifespan_context(app):
            process = worker._render.workers[0].process
            assert process is not None and process.poll() is None
        assert process.poll() is not None
        assert all(w.process is None for w in worker._render.workers + worker._edit.workers)

    asyncio.run(run())
