"""同じ版の処理共有と、原稿以外の変更時の再描画。"""
import asyncio
import time
from types import SimpleNamespace

from conftest import add_deck
from slide_studio.server import CHUNK_VERSIONS, StudioServer


def test_render_coalesces_source_but_invalidates_assets(ws, monkeypatch):
    add_deck(ws, 'talk', '---\ntopic: test\n---\n## A\n\nText.\n')
    calls = []

    def render(workspace, deck, text):
        calls.append(text)
        time.sleep(.05)
        return SimpleNamespace(html='html', timing={}, slides=[], warnings=[], unsupported=[], missing_cites=[])

    monkeypatch.setattr('slide_studio.server.render_text', render)

    async def run():
        srv = StudioServer(ws)
        await asyncio.gather(srv.render('talk'), srv.render('talk'), srv.render('talk'))
        assert len(calls) == 1
        await srv.render('talk')
        assert len(calls) == 1
        await srv.render('talk', force=True)
        assert len(calls) == 2
        ws.qmd('talk').write_text('## A\n\nChanged.\n')
        await srv.render('talk')
        assert calls[-1].endswith('Changed.\n')
        assert len(calls) == 3

    asyncio.run(run())


def test_chunk_requests_share_work_and_invalidate(ws, monkeypatch):
    calls = []

    def info(rendered):
        calls.append(rendered)
        time.sleep(.02)
        return {'result': len(calls)}

    monkeypatch.setattr('slide_studio.edit.chunk_info', info)

    async def run():
        srv = StudioServer(ws)
        st = srv.state('talk')
        first, second = SimpleNamespace(version='a'), SimpleNamespace(version='b')
        results = await asyncio.gather(*(srv.chunk_info(st, first) for _ in range(3)))
        assert results == [{'result': 1}] * 3
        assert await srv.chunk_info(st, first) == {'result': 1}
        assert await srv.chunk_info(st, second) == {'result': 2}
        assert calls == [first, second]
        # スライドで編集中の版は、描画が進んでも残る（直近の数版まで）
        assert st.chunks['a'][0] is first
        for i in range(CHUNK_VERSIONS):
            await srv.chunk_info(st, SimpleNamespace(version=str(i)))
        assert 'a' not in st.chunks and len(st.chunks) == CHUNK_VERSIONS

    asyncio.run(run())


def test_watcher_keeps_asset_changes_in_source_batch(ws, monkeypatch):
    add_deck(ws, 'talk', '---\ntopic: test\n---\n## A\n\nText.\n')
    calls = []

    async def watch(*args, **kwargs):
        yield {(2, str(ws.qmd('talk'))), (2, str(ws.asset_root('talk') / 'images/a.svg'))}

    monkeypatch.setattr('watchfiles.awatch', watch)

    async def run():
        srv = StudioServer(ws)
        srv.state('talk')

        async def render(deck, *, force=False):
            calls.append((deck, force))

        monkeypatch.setattr(srv, 'render', render)
        await srv.watch()
        await asyncio.sleep(0)
        assert calls == [('talk', True)]

    asyncio.run(run())
