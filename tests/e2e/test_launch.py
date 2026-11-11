"""実サーバーの起動・再読み込み・最後のウィンドウを閉じた後の終了。"""
import os
import socket
import subprocess
import sys
import time

import httpx
import pytest


@pytest.mark.parametrize('initial_setup', [False, True])
def test_last_window_exits_promptly_but_reload_and_other_windows_do_not(ws, page, initial_setup):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    # 普段の Chrome を開かず、Playwright の画面で同じ SSE を使う。
    # サムネイル作成などのバックグラウンド処理は通常どおり動かす。
    code = '''
import sys
from slide_studio import server
from slide_studio.workspace import Workspace
server.open_window = lambda url: None
server.serve(None if sys.argv[1] == "setup" else Workspace.open(sys.argv[1]), port=int(sys.argv[2]))
'''
    proc = subprocess.Popen(
        [sys.executable, '-c', code, 'setup' if initial_setup else str(ws.root), str(port)],
        env=dict(os.environ, PYTHONUNBUFFERED='1'),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        deadline = time.monotonic() + 10
        with httpx.Client(timeout=0.5, trust_env=False) as client:
            while True:
                assert proc.poll() is None, proc.communicate()[0]
                try:
                    if client.get(url).status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                assert time.monotonic() < deadline, 'サーバーが起動しません'
                time.sleep(0.05)

        with page.expect_response('**/api/events'):
            page.goto(url)
        with page.expect_response('**/api/events'):
            page.reload()
        other = page.context.browser.new_page()
        with other.expect_response('**/api/events'):
            other.goto(url)
        page.close()
        other.wait_for_timeout(1300)  # 終了の猶予より長く、もう一方の画面を開いておく。
        assert proc.poll() is None
        with other.expect_response('**/api/events'):
            other.reload()
        other.wait_for_timeout(1300)
        assert proc.poll() is None
        other.close()
        # 従来の固定5秒待ちに戻ったら失敗する。実測は約1.3秒。
        output = proc.communicate(timeout=4.5)[0]
        assert proc.returncode == 0, output
        assert 'Traceback' not in output
        assert '窓が閉じたので終了します' in output
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
