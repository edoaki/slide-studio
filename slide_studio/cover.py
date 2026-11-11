"""表紙の発表者と所属（設計書 §5.5）。

front matter の author を Quarto と同じ形で読む（文字列・文字列の並び・name と affiliations を持つ辞書の並び。
所属は文字列か、name／ref を持つ辞書。ref は最上位の affiliations の id）。
同じ所属を2人以上が持つときは、名前に *1 のような印を付けて所属を下にまとめる。
"""
from __future__ import annotations

import html


def _text(v) -> str:
    if isinstance(v, dict):
        if v.get("literal"):
            return str(v["literal"]).strip()
        return " ".join(str(v[k]).strip() for k in ("family", "given") if v.get(k))
    return "" if v is None else str(v).strip()


def authors(meta: dict) -> list[dict]:
    """[{name, affiliations: [所属名]}]。名前の無い人は除く。"""
    raw = meta.get("author")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raw = [raw]
    table = {}
    for a in meta.get("affiliations") or []:
        if isinstance(a, dict) and a.get("id") is not None:
            table[str(a["id"])] = _text(a.get("name"))
    out = []
    for item in raw:
        if isinstance(item, dict):
            name = _text(item.get("name"))
            affs = item.get("affiliations", item.get("affiliation"))
        else:
            name, affs = _text(item), None
        if not name:
            continue
        if affs is None:
            affs = []
        elif not isinstance(affs, list):
            affs = [affs]
        names = []
        for a in affs:
            n = (table.get(str(a.get("ref")), "") if a.get("ref") is not None else _text(a.get("name"))) if isinstance(a, dict) else _text(a)
            if n and n not in names:
                names.append(n)
        out.append({"name": name, "affiliations": names})
    return out


def html_block(people: list[dict], layout=None) -> str:
    body = _html_block(people)
    if not body:
        return body
    layout = layout if isinstance(layout, dict) else {}
    position = layout.get("position", "bottom")
    if position not in ("bottom", "right", "left"):
        position = "bottom"
    styles = []
    for key, prop in [("x", "left"), ("y", "top"), ("size", "--cover-name-size"), ("affSize", "--cover-aff-size")]:
        value = layout.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and -10000 <= value <= 10000 and (key in ("x", "y") or value >= 1):
            styles.append(f"{prop}:{value}px")
    attrs = [f'data-affiliation-position="{position}"']
    for key, attr in [("font", "name-font"), ("affFont", "aff-font")]:
        if layout.get(key) in ("sans", "serif", "mono"):
            attrs.append(f'data-{attr}="{layout[key]}"')
    for key, attr in [("bold", "name-bold"), ("affBold", "aff-bold")]:
        if isinstance(layout.get(key), bool):
            attrs.append(f'data-{attr}="{str(layout[key]).lower()}"')
    return body.replace('<div class="cover-authors', f'<div {" ".join(attrs)} style="{";".join(styles)}" class="cover-authors', 1)


def _html_block(people: list[dict]) -> str:
    """表紙に置く発表者の HTML。発表者がいなければ空。"""
    if not people:
        return ""
    e = html.escape
    order = []
    for p in people:
        for a in p["affiliations"]:
            if a not in order:
                order.append(a)
    sets = {tuple(p["affiliations"]) for p in people}
    # 全員の所属が同じ：名前を並べ、所属を1行（印は付けない）
    if len(people) > 1 and len(sets) == 1:
        names = "".join(f'<span class="cover-author">{e(p["name"])}</span>' for p in people)
        affs = "".join(f'<span class="cover-affiliation">{e(a)}</span>' for a in order)
        return f'<div class="cover-authors"><p class="cover-names">{names}</p>' + (f'<p class="cover-affiliations">{affs}</p>' if affs else '') + '</div>'
    shared = any(sum(a in p["affiliations"] for p in people) > 1 for a in order)
    # 所属が重ならない：人ごとに名前と所属
    if not shared:
        rows = "".join(f'<p class="cover-author"><span class="cover-name">{e(p["name"])}</span>'
                       + (f'<span class="cover-affiliation">{e("・".join(p["affiliations"]))}</span>' if p["affiliations"] else '') + '</p>'
                       for p in people)
        return f'<div class="cover-authors each">{rows}</div>'
    # 重なる：名前に印、所属は下にまとめる
    mark = {a: f"*{i + 1}" for i, a in enumerate(order)}
    names = "".join(f'<span class="cover-author">{e(p["name"])}'
                    + (f'<sup>{",".join(mark[a] for a in p["affiliations"])}</sup>' if p["affiliations"] else '') + '</span>'
                    for p in people)
    affs = "".join(f'<span class="cover-affiliation"><sup>{mark[a]}</sup>{e(a)}</span>' for a in order)
    return f'<div class="cover-authors marked"><p class="cover-names">{names}</p><p class="cover-affiliations">{affs}</p></div>'
