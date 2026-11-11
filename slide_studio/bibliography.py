"""トピックごとの文献。衝突の検出を済ませてから、元を控えに移す。"""
from __future__ import annotations

import re
import json
import time
from pathlib import Path

from .fsutil import write_atomic

VENUE_FIELDS = {'journal', 'journaltitle', 'booktitle', 'howpublished', 'publisher'}


def entries(text: str) -> list[tuple[str | None, str]]:
    """入れ子の波括弧・引用符・コメントを保って BibTeX のレコードを分ける。"""
    result = []
    pos = 0
    pattern = re.compile(r"@([\w-]+)\s*([({])")
    def next_entry(start):
        match = pattern.search(text, start)
        while match and '%' in text[text.rfind('\n', 0, match.start()) + 1:match.start()]:
            newline = text.find('\n', match.end())
            if newline < 0:
                return None
            match = pattern.search(text, newline + 1)
        return match

    for_start = next_entry(pos)
    while for_start:
        m = for_start
        if text[pos:m.start()].strip():
            result.append((None, text[pos:m.start()].strip()))
        opening = m[2]
        depth, quoted, escaped = 1, False, False
        i = m.end()
        brace = 0
        while i < len(text):
            c = text[i]
            if escaped:
                escaped = False
            elif c == '\\':
                escaped = True
            elif c == '"' and (depth == 1 if opening == '{' else brace == 0):
                quoted = not quoted
            elif not quoted:
                if opening == '{':
                    if c == '{': depth += 1
                    elif c == '}': depth -= 1
                else:
                    if c == '{': brace += 1
                    elif c == '}': brace -= 1
                    elif c == ')' and brace == 0: depth -= 1
            i += 1
            if depth == 0: break
        if depth:
            raise ValueError("BibTeX")
        raw = text[m.start():i].strip()
        kind = m[1].lower()
        key_match = re.match(r"\s*([^,\s]+)\s*,", text[m.end():i-1])
        if kind in ('comment', 'preamble'):
            key = None
        elif kind == 'string':
            macro = re.match(r"\s*([^=\s]+)\s*=", text[m.end():i-1])
            if not macro: raise ValueError("BibTeX")
            key = '@string:' + macro[1].lower()
        else:
            if not key_match: raise ValueError("BibTeX")
            key = key_match[1]
        result.append((key, raw))
        pos = i
        for_start = next_entry(pos)
    if text[pos:].strip(): result.append((None, text[pos:].strip()))
    return result


def fields(raw: str):
    """通常のレコードのフィールド名・値・元の範囲。値の中のカンマは区切らない。"""
    i, end = raw.index(',') + 1, len(raw) - 1
    while i < end:
        while i < end and (raw[i].isspace() or raw[i] == ','):
            i += 1
        if i >= end:
            break
        if raw[i] == '%':
            i = raw.find('\n', i)
            if i < 0:
                break
            continue
        start = i
        match = re.match(r'([\w-]+)\s*=\s*', raw[i:])
        if not match:
            raise ValueError('BibTeX')
        i += match.end()
        value_start = i
        depth, quote, escape = 0, False, False
        while i < end:
            c = raw[i]
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == '"' and depth == 0:
                quote = not quote
            elif not quote:
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                elif c == ',' and depth == 0:
                    break
            i += 1
        yield match[1].lower(), raw[value_start:i].strip(), start, min(i + 1, end)
        i += 1


def identity(key, raw):
    if key is None or key.startswith('@string:'):
        return raw
    kind = re.match(r'@(\w+)', raw)[1].lower()
    def value_identity(value):
        if (value.startswith('{') and value.endswith('}')) or (value.startswith('"') and value.endswith('"')):
            return 'literal', value[1:-1]
        if value.isdecimal():
            return 'literal', value
        return 'expression', value
    return kind, sorted((name, value_identity(value)) for name, value, _, _ in fields(raw))


def merge(paths: list[Path]) -> str:
    seen = {}
    out = []
    collisions = set()
    for path in paths:
        if not path.exists(): continue
        for key, raw in entries(path.read_text()):
            content = identity(key, raw)
            if key in seen and seen[key] != content:
                collisions.add(key)
            if key is None or key not in seen:
                out.append(raw)
            if key is not None: seen[key] = content
    if collisions:
        raise ValueError(', '.join(sorted(collisions)))
    return '\n\n'.join(out) + ('\n' if out else '')


def plans(ws):
    from .workspace import StudioError
    groups = {}
    for deck in ws.list_decks():
        try:
            target = ws.bib(deck)
        except (ValueError, OSError, StudioError):
            continue  # front matter の不備は原稿の検査で通知する
        if target.parent == ws.state:
            continue
        groups.setdefault(target, [])
        old = ws.deck_dir(deck) / 'reference.bib'
        if old.exists(): groups[target].append(old)
    return groups


def conflicts(ws) -> list[str]:
    errors = []
    for target, old in plans(ws).items():
        try:
            merge([target, *old])
        except ValueError as exc:
            errors.append(f'{target.parent.name}: {exc} ({", ".join(p.parent.name for p in old)})')
    return errors


def migrate(ws):
    if (ws.root / 'figures').exists(): return
    for target, old in plans(ws).items():
        try:
            text = merge([target, *old])
        except ValueError:
            continue
        if old or not target.exists(): write_atomic(target, text)
        for path in old:
            dest = ws.state / 'trash' / f'bib-{time.time_ns()}' / path.parent.name / path.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            path.rename(dest)


def verify(ws, deck: str, key: str) -> None:
    """選んだレコードの未確認の印だけを取り除く。"""
    require_ready(ws, deck)
    verify_path(ws.bib(deck), key)


def verify_path(path: Path, key: str) -> None:
    """選択した文献の確認待ち指定だけを解除する。"""
    text = path.read_text()
    for entry_key, raw in entries(text):
        if entry_key == key:
            updated = raw
            for name, value, start, end in reversed(list(fields(raw))):
                if name == 'slide-studio-status' and value.strip('{}\" ').lower() == 'unverified':
                    updated = updated[:start] + updated[end:]
            write_atomic(path, text.replace(raw, updated, 1))
            return
    raise KeyError(key)


def update_path(path: Path, key: str, changes: dict, original: str) -> None:
    """選択した文献の変更欄だけを書き換える。編集中の外部変更は上書きしない。"""
    if not isinstance(changes, dict) or any(
        not isinstance(k, str) or not re.fullmatch(r'[\w-]+', k) or k != k.lower() or k == 'slide-studio-status'
        or not isinstance(v, str) for k, v in changes.items()
    ):
        raise ValueError('文献の入力が正しくありません')
    text = path.read_text()
    for entry_key, raw in entries(text):
        if entry_key != key:
            continue
        if raw != original:
            raise ValueError('文献が更新されています。開き直してから編集してください')
        updated = raw
        remaining = dict(changes)
        for name, _, start, end in reversed(list(fields(raw))):
            if name in changes:
                value = changes[name].strip()
                updated = updated[:start] + (f'{name} = {{{value}}},' if value else '') + updated[end:]
                remaining.pop(name, None)
        added = ''.join(f'\n  {k} = {{{v.strip()}}},' for k, v in remaining.items() if v.strip())
        if added:
            prefix = updated[:-1].rstrip()
            updated = prefix + ('' if prefix.endswith(',') else ',') + added + '\n' + updated[-1]
        parsed = entries(updated)
        found = {name: value for name, value, _, _ in fields(updated)}
        if len(parsed) != 1 or parsed[0][0] != key or any(
            found.get(k) != ('{' + v.strip() + '}' if v.strip() else None) for k, v in changes.items()
        ):
            raise ValueError('文献の入力を確認してください（括弧の対応など）')
        write_atomic(path, text.replace(raw, updated, 1))
        return
    raise KeyError(key)


def require_ready(ws, deck: str, meta: dict | None = None):
    """未解決の衝突がある状態で引用を欠落させたまま書き出さない。"""
    from .workspace import PKG, StudioError
    strings = (PKG / 'web' / 'strings.js').read_text()
    messages, _ = json.JSONDecoder().raw_decode(strings.split('export const MIGRATION_PREPARATION = ', 1)[1])
    if (ws.root / 'figures').exists() and ws.topics.exists():
        raise StudioError(messages['folders'])
    target = ws.bib(deck, meta)
    old = plans(ws).get(target, [])
    if old:
        try:
            merge([target, *old])
        except ValueError as exc:
            raise StudioError(f"{messages['bib']}: {target.parent.name}: {exc}. {messages['bibFix']}") from exc


def clean(value: str) -> str:
    """表示用の値：外側の括弧・引用符、波括弧、よく使う TeX の記号を外す。"""
    if value[:1] in '{"' and len(value) > 1:
        value = value[1:-1]
    value = re.sub(r'\\([&%$#_{}])', r'\1', value)
    value = value.replace('{', '').replace('}', '').replace('---', '—').replace('--', '–').replace('~', ' ')
    return re.sub(r'\s+', ' ', value).strip()


def with_arxiv_venue(text: str) -> str:
    """発表先の無い arXiv の文献に、引用に出す arXiv 番号を足した BibTeX を返す。読めない bib はそのまま返す。"""
    out = text
    try:
        for key, raw in entries(text):
            if key is None or key.startswith('@string:'):
                continue
            found = {name: clean(value) for name, value, _, _ in fields(raw)}
            archive = found.get('archiveprefix') or found.get('eprinttype') or ''
            if archive.lower() != 'arxiv' or not found.get('eprint') or found.keys() & VENUE_FIELDS:
                continue
            number = re.sub(r'^arxiv:', '', found['eprint'], flags=re.I)
            body = raw[:-1].rstrip()
            separator = '' if body.endswith(',') else ','
            out = out.replace(raw, f'{body}{separator}\n  howpublished = {{arXiv:{number}}}\n{raw[-1]}', 1)
    except ValueError:
        return text
    return out


def listing(path: Path) -> list[dict]:
    """トピックの文献を画面で見るための一覧。読めない bib は ValueError。"""
    try:
        text = path.read_text()
    except OSError:
        return []
    out = []
    for key, raw in entries(text):
        if key is None or key.startswith('@string:'):
            continue
        found = {name: value for name, value, _, _ in fields(raw)}
        values = {name: clean(value) for name, value in found.items()}
        out.append({'key': key, 'type': re.match(r'@([\w-]+)', raw)[1].lower(), 'fields': values,
                    'authors': authors(found.get('author', '')),
                    'unverified': values.get('slide-studio-status', '').lower() == 'unverified', 'raw': raw,
                    'editable': {name: value[1:-1] if value[:1] in '{"' else value for name, value in found.items()}})
    return out


def authors(value: str) -> list[dict]:
    """author を人ごとに分け、表示名と姓を返す。{{Gurobi Optimization}} のように括った名前は分けない。"""
    if value[:1] in '{"' and len(value) > 1:
        value = value[1:-1]
    people, depth, start = [], 0, 0
    for m in re.finditer(r'[{}]|\s+and\s+', value):
        if m[0] == '{': depth += 1
        elif m[0] == '}': depth -= 1
        elif depth == 0:
            people.append(value[start:m.start()]); start = m.end()
    people.append(value[start:])
    out = []
    for person in (p.strip() for p in people):
        if not person:
            continue
        name = clean(person)
        if person.startswith('{') and person.endswith('}'):
            family = name
        elif ',' in name:
            family = name.split(',')[0].strip()
        else:
            family = name.split(' ')[-1]
        out.append({'name': name, 'family': family})
    return out


def cites(text: str, key: str) -> bool:
    """原稿が [@key] で引用しているか。末尾の句読点はキーに含めない（Pandoc と同じ）。"""
    k = re.escape(key)
    return re.search(r'(?<![\w.])@(?:\{' + k + r'\}|' + k + r'(?![\w:.#$%&+?<>~/-]*\w))', text) is not None
