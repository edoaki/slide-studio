"""ファイルの書き込み（一時ファイルに書いてから rename）とハッシュ。"""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path


def write_atomic(path: Path, data: str | bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data.encode() if isinstance(data, str) else data)
        # mkstemp は 600 で作るので、元のファイルの権限（無ければ umask に従う既定）にそろえる
        try:
            mode = path.stat().st_mode & 0o777
        except FileNotFoundError:
            mode = 0o666 & ~_umask()
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode())


def sha256_file(path: Path) -> str:
    return sha256_bytes(Path(path).read_bytes())


def _umask() -> int:
    mask = os.umask(0)
    os.umask(mask)
    return mask
