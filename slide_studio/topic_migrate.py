"""旧置き場をコピーして検証してから切り替える。完了前の記録は再起動時に再開する。"""
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

from .fsutil import sha256_bytes, write_atomic


def message(key, **values):
    from .workspace import PKG
    text = (PKG / 'web/strings.js').read_text()
    strings, _ = json.JSONDecoder().raw_decode(text.split('export const MIGRATION_PREPARATION = ', 1)[1])
    return strings[key].format(**values)


def hashes(path: Path) -> dict[str, str]:
    if path.is_file():
        return {'': sha256_bytes(path.read_bytes())}
    return {p.relative_to(path).as_posix(): sha256_bytes(p.read_bytes())
            for p in sorted(path.rglob('*')) if p.is_file()}


def inventory(root: Path) -> dict[str, str]:
    """移行記録自身と退避先を除く、置き場の全ファイルの一覧。"""
    result = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        parent = Path(directory)
        if parent == root / '.slide-studio':
            dirs[:] = [name for name in dirs if name not in ('migrate', 'trash')]
        for name in sorted(names):
            path = parent / name
            if path.is_file() and not path.is_symlink():
                result[path.relative_to(root).as_posix()] = sha256_bytes(path.read_bytes())
    return dict(sorted(result.items()))


def signature(path: Path) -> dict:
    """同じコードでも、参照する部品・画像が違うものはまとめない。"""
    base = path if path.is_dir() else path.parent
    allowed = path.parent.parent.resolve()
    result = hashes(path)
    pending = list(path.rglob('*')) if path.is_dir() else [path]
    seen = set()
    while pending:
        file = pending.pop().resolve()
        if file in seen or not file.is_file():
            continue
        seen.add(file)
        if file.suffix.lower() not in ('.html', '.htm', '.css', '.mjs', '.js', '.svg'):
            continue
        try:
            text = file.read_text()
        except UnicodeDecodeError:
            continue
        for match in re.finditer(r"[\"'(]([^\s\"'()<>]+)[\"')]", text):
            value = match[1].split('#')[0].split('?')[0]
            if not value or re.match(r'^(?:[\w+-]+:|/)', value):
                continue
            dep = (file.parent / value).resolve()
            if dep.is_relative_to(allowed) and dep.is_file():
                result['dependency:' + os.path.relpath(dep, base)] = sha256_bytes(dep.read_bytes())
                pending.append(dep)
    return result


def reserve(src: Path, target: Path, original=None) -> Path:
    """同じ内容は再利用。ディレクトリは一単位、_lib と images はファイル単位で呼ぶ。"""
    candidate, n = target, 2
    while candidate.exists():
        if src.is_dir() == candidate.is_dir() and signature(src) == signature(original(candidate) if original else candidate):
            return candidate
        candidate = target.with_name(f'{target.stem}-{n}{target.suffix}')
        n += 1
    if src.is_dir():
        candidate.mkdir(parents=True, exist_ok=True)
        for path in sorted(src.rglob('*')):
            if path.is_file():
                write_atomic(candidate / path.relative_to(src), path.read_bytes())
    else:
        write_atomic(candidate, src.read_bytes())
    return candidate


def copy_group(src: Path, target: Path, mapping: dict[Path, Path], final: Path | None = None):
    """共有の名前を予約し、全ファイルの元と行き先を記録する。"""
    if not src.is_dir():
        return
    final = final or target
    target.mkdir(parents=True, exist_ok=True)
    def original(candidate):
        destination = final / candidate.relative_to(target)
        for owner, placed in mapping.items():
            if placed == destination:
                return owner
            if placed.is_relative_to(destination):
                result = owner
                for _ in placed.relative_to(destination).parts:
                    result = result.parent
                return result
        return candidate
    for item in sorted(src.iterdir()):
        if item.name == '_lib' or target.name == 'images':
            files = sorted(item.rglob('*')) if item.is_dir() else [item]
            for path in files:
                if path.is_file():
                    out = reserve(path, target / path.relative_to(src), original)
                    mapping[path.resolve()] = final / out.relative_to(target)
        else:
            out = reserve(item, target / item.name, original)
            files = sorted(item.rglob('*')) if item.is_dir() else [item]
            for path in files:
                if path.is_file():
                    mapping[path.resolve()] = final / out.relative_to(target) / path.relative_to(item) if item.is_dir() else final / out.relative_to(target)


def rewrite(text: str, old: Path, new: Path, mapping: dict[Path, Path], root: Path) -> str:
    """HTML/CSS/JS の静的な相対参照を、予約したファイルへ付け替える。"""
    def replace(match):
        value = match[2]
        if not value or re.match(r'^(?:[\w+-]+:|/|#)', value):
            return match[0]
        path, *suffix = re.split(r'(?=[?#])', value, maxsplit=1)
        resolved = (old.parent / path).resolve()
        dest = mapping.get(resolved)
        if dest is None and resolved.is_relative_to(root) and (resolved.is_file() or resolved.is_relative_to(root / ".slide-studio" / "runtime")):
            dest = resolved
        if dest is None:
            return match[0]
        rel = os.path.relpath(dest, new.parent).replace(os.sep, '/')
        if value.startswith('./') and not rel.startswith('.'):
            rel = './' + rel
        return match[1] + rel + ''.join(suffix) + match[3]
    return re.sub(r'''(["'(])([^\s"'()<>]+)(["')])''', replace, text)


def migrate(ws):
    legacy = ws.root / 'figures'
    journal = ws.state / 'migrate' / 'topics-v1'
    record = journal / 'manifest.json'
    if record.is_file():
        plan = json.loads(record.read_text())
        if plan['phase'] == 'done':
            return
        finish(ws, journal, plan)
        return
    if not legacy.is_dir() or ws.topics.exists():
        return
    all_before = inventory(ws.root)
    stage = journal / 'stage' / 'topics'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    mapping = {}
    originals = [legacy, *(ws.deck_dir(deck) / name for deck in ws.list_decks()
                           for name in ('images', 'html', 'figures') if (ws.deck_dir(deck) / name).exists())]
    before = {}
    for src in originals:
        from .workspace import StudioError
        for file in [src, *src.rglob('*')]:
            if file.is_symlink():
                raise StudioError(message('symlink', path=file))
        for rel, digest in hashes(src).items():
            before[(src / rel).relative_to(ws.root).as_posix()] = digest
    for topic in sorted(legacy.iterdir()):
        if topic.is_dir():
            copy_group(topic, stage / topic.name / 'html', mapping, ws.topic_dir(topic.name) / 'html')
        elif topic.is_file():
            write_atomic(stage / topic.name, topic.read_bytes())
            mapping[topic.resolve()] = ws.topics / topic.name
    qmds = {}
    for deck in ws.list_decks():
        shelf = ws.deck_shelf(deck)
        folder = ws.deck_dir(deck)
        for name in ('images', 'html', 'figures'):
            src = folder / name
            if src.exists():
                kind = 'images' if name == 'images' else 'html'
                copy_group(src, stage / shelf / kind, mapping, ws.topic_dir(shelf) / kind)
    for deck in ws.list_decks():
        shelf = ws.deck_shelf(deck)
        folder = ws.deck_dir(deck)
        path = ws.qmd(deck)
        text = path.read_text()
        from .figures import FIG_REF
        def figure(match):
            ref = match[3]
            src = folder / 'figures' / ref[2:] if ref.startswith('./') else legacy / ref
            dest = mapping.get((src / 'figure.mjs').resolve())
            if dest is None:
                return match[0]
            parts = dest.relative_to(ws.topics).parts
            return f'{match[1]}{match[2]}{parts[0]}/{"/".join(parts[2:-1])}{match[2]}'
        updated = FIG_REF.sub(figure, text)
        # qmd の画像は images/... を維持し、衝突した名前だけ直す。
        def image_ref(match):
            src = (folder / match[1]).resolve()
            dest = mapping.get(src)
            return match[0].replace(match[1], dest.relative_to(ws.topic_dir(shelf)).as_posix()) if dest else match[0]
        updated = re.sub(r'!?\[[^\]]*\]\(<?(images/[^\s)>]+)>?', image_ref, updated)
        # HTML の直接参照・共有図の直書きパス。
        updated = rewrite(updated, path, path, mapping, ws.root)
        for src, dest in mapping.items():
            if src.is_relative_to(legacy):
                updated = updated.replace('../../figures/' + src.relative_to(legacy).as_posix(),
                                          '../../topics/' + dest.relative_to(ws.topics).as_posix())
        updated = updated.replace(f"../../topics/{shelf}/images/", "images/")
        from .workspace import set_front
        updated = set_front(updated, {})
        qmds[path.relative_to(ws.root).as_posix()] = {'before': text, 'after': updated}
    # 全コピーを元の一覧と照合してから、コピー側の参照を書き換える。
    from .workspace import StudioError
    for src, dest in mapping.items():
        copied = stage / dest.relative_to(ws.topics)
        if sha256_bytes(copied.read_bytes()) != before[src.relative_to(ws.root).as_posix()]:
            raise StudioError(message('copyFailed'))
    # コピー完了後に参照を直す。コピー先が同じものは一度だけ処理する。
    changed = set()
    for src, dest in mapping.items():
        if dest in changed or src.suffix.lower() not in ('.html', '.htm', '.css', '.js', '.mjs', '.svg'):
            continue
        changed.add(dest)
        try:
            text = src.read_text()
        except UnicodeDecodeError:
            continue
        write_atomic(stage / dest.relative_to(ws.topics), rewrite(text, src, dest, mapping, ws.root))
    plan = {'phase': 'prepared', 'all_before': all_before, 'before': before, 'after': hashes(stage),
            'mapping': {src.relative_to(ws.root).as_posix(): dest.relative_to(ws.root).as_posix() for src, dest in mapping.items()},
            'originals': [p.relative_to(ws.root).as_posix() for p in originals], 'qmd': qmds,
            'source_hashes': {**before, **{p: sha256_bytes(v['before'].encode()) for p, v in qmds.items()}},
            'result_hashes': {**{'topics/' + p: h for p, h in hashes(stage).items()},
                              **{p: sha256_bytes(v['after'].encode()) for p, v in qmds.items()}}}
    write_atomic(record, json.dumps(plan, ensure_ascii=False, indent=2))
    finish(ws, journal, plan)


def finish(ws, journal, plan):
    from .workspace import StudioError
    stage = journal / 'stage' / 'topics'
    trash = ws.state / 'trash' / 'topics-v1'
    for rel in plan['originals']:
        src = ws.root / rel
        original = src if src.exists() else trash / rel
        expected = {p[len(rel) + 1:]: h for p, h in plan['before'].items() if p.startswith(rel + '/')}
        if hashes(original) != expected:
            raise StudioError(message('sourceChanged', path=rel))
    for rel, values in plan['qmd'].items():
        if (ws.root / rel).read_text() not in (values['before'], values['after']):
            raise StudioError(message('qmdChanged', path=rel))
    copied = ws.topics if ws.topics.exists() else stage
    if hashes(copied) != plan['after']:
        raise StudioError(message('copyChanged'))
    if not ws.topics.exists():
        stage.rename(ws.topics)
    for rel, values in plan['qmd'].items():
        path = ws.root / rel
        if path.read_text() not in (values['before'], values['after']):
            raise StudioError(message('qmdChanged', path=rel))
        if path.read_text() != values['after']:
            write_atomic(path, values['after'])
    trash = ws.state / 'trash' / 'topics-v1'
    for rel in plan['originals']:
        src, dest = ws.root / rel, trash / rel
        if src.exists():
            expected = {p[len(rel) + 1:]: h for p, h in plan['before'].items() if p.startswith(rel + '/')}
            if hashes(src) != expected:
                raise StudioError(message('sourceChanged', path=rel))
            dest.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dest)
    plan['all_after'] = inventory(ws.root)
    plan['phase'] = 'done'
    write_atomic(journal / 'manifest.json', json.dumps(plan, ensure_ascii=False, indent=2))


def copy_topic_assets(ws, source_deck: str, deck: str, shelf: str, text: str) -> str:
    """別トピックへの発表複製でも、元の引用先の図・画像を保つ。"""
    previous = ws.deck_shelf(source_deck)
    if previous == shelf:
        return text
    mapping = {}
    for kind in ('html', 'images'):
        copy_group(ws.topic_dir(previous) / kind, ws.topic_dir(shelf) / kind, mapping)
    for src, dest in mapping.items():
        if src.suffix.lower() in ('.html', '.htm', '.css', '.js', '.mjs', '.svg'):
            write_atomic(dest, rewrite(src.read_text(), src, dest, mapping, ws.root))
    from .figures import FIG_REF
    def figure(match):
        if not match[3].startswith(previous + '/'):
            return match[0]
        dest = mapping.get((ws.figure_dir(match[3]) / 'figure.mjs').resolve())
        if dest is None:
            return match[0]
        return f'{match[1]}{match[2]}{shelf}/{dest.parent.relative_to(ws.shelf_dir(shelf)).as_posix()}{match[2]}'
    text = FIG_REF.sub(figure, text)
    def image(match):
        dest = mapping.get((ws.topic_dir(previous) / match[1]).resolve())
        return match[0].replace(match[1], dest.relative_to(ws.topic_dir(shelf)).as_posix()) if dest else match[0]
    return re.sub(r'!?\[[^\]]*\]\(<?(images/[^\s)>]+)>?', image, text)
