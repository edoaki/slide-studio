"""CSS と原稿を同じ履歴操作として保存する。両方の版を検査してから書く。"""
from . import deckstyle
from .fsutil import sha256_text, write_atomic


class Conflict(ValueError):
    pass


def style(ws, deck, body):
    path = ws.deck_dir(deck) / "styles" / "slides.css"
    before = path.read_text() if path.exists() else None
    text = ws.qmd(deck).read_text()
    if "css" in body:
        if body.get("css_base") != before:
            raise Conflict("外で変更されました")
        after = body["css"]
        if after is not None and not isinstance(after, str):
            raise ValueError("操作が正しくありません")
    else:
        values = body.get("vars")
        if not isinstance(values, dict):
            raise ValueError("操作が正しくありません")
        after = deckstyle.set_vars(before or "", values)
    result = body.get("text", text)
    if not isinstance(result, str):
        raise ValueError("原稿がありません")
    if "text" in body and body.get("base") != sha256_text(text):
        raise Conflict("外で変更されました")
    if after != before:
        if after is None:
            path.unlink(missing_ok=True)
        else:
            write_atomic(path, after)
    if result != text:
        write_atomic(ws.qmd(deck), result)
    return {"before": before, "css": after, "text": result, "version": sha256_text(result),
            "vars": deckstyle.read_vars(after or "")}
