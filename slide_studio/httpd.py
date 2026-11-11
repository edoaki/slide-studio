"""検査・書き出し用の小さな静的サーバー（置き場を配信し、生成した HTML を差し込む）。

図の ES module は file:// では読めないため、検査はプレビューと同じく HTTP で開く。
"""
from __future__ import annotations

import mimetypes
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")


# テスト用：パス → 応答を遅らせる秒数（読み込みの遅いフォントなど）
DELAYS: dict[str, float] = {}


class StaticServer:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.overrides: dict[str, bytes] = {}
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # noqa: D401 - 静かにする
                pass

            def do_GET(self):  # noqa: N802
                path = unquote(urlparse(self.path).path)
                if path in DELAYS:
                    time.sleep(DELAYS[path])
                body = server.overrides.get(path)
                ctype = (mimetypes.guess_type(path)[0] or "text/html") + "; charset=utf-8"
                if body is None:
                    file = (server.root / path.lstrip("/")).resolve()
                    if not file.is_relative_to(server.root) or not file.is_file():
                        self.send_error(404)
                        return
                    body = file.read_bytes()
                    ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
                    if ctype.startswith("text/"):
                        ctype += "; charset=utf-8"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def origin(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def url(self, path: str) -> str:
        return self.origin + "/" + path.lstrip("/")

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
