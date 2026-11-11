"""共有テーマの一覧・登録・変数の編集・デフォルトに戻す・削除と、テーマのタブの見本。"""
import asyncio
import json
import re

from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Route

from . import source, theme_edit, theme_shots
from .fsutil import sha256_text, write_atomic
from .workspace import TEMPLATES, StudioError, check_name, set_front

# テーマのタブの見本（設計書 §10.10）。置き場の発表名に使えない名前のフォルダに置いたことにし、テーマの CSS を相対参照で読む
SAMPLE = 'theme-editor-sample.qmd'
SAMPLE_URL = '/files/decks/__theme-sample__/sample.html'


def reset_cover_positions(text):
    """表紙の移動分だけを消し、選んだテーマの配置に戻す。"""
    doc = source.parse(text)
    edits = []
    for page in doc.pages:
        if 'cover' not in page.attrs.classes:
            continue
        for chunk in page.walk():
            if not chunk.open or not chunk.attrs or not {'cover-title', 'cover-subtitle'} & set(chunk.attrs.classes):
                continue
            start, end = chunk.open
            opening = text[start:end]
            def clean(match):
                if match[3] != 'style':
                    return match[0]
                value = match[4] if match[4] is not None else match[5] if match[5] is not None else match[6]
                parts = value.split(';')
                kept = [p for p in parts if p.split(':', 1)[0].strip().lower() not in {'left', 'top', 'right', 'bottom', 'position', 'transform', 'translate'}]
                if kept == parts:
                    return match[0]
                return 'style="' + ';'.join(kept) + '"' if any(p.strip() for p in kept) else ''
            edits.append((start, end, source.ATTR_TOKEN.sub(clean, opening)))
    layout = doc.meta.get('cover-authors-layout')
    if isinstance(layout, dict) and ('x' in layout or 'y' in layout):
        layout = {k: v for k, v in layout.items() if k not in ('x', 'y')}
        head = text[:doc.front[1]]
        match = re.search(r'^cover-authors-layout[^\n]*\n(?:[ \t]+[^\n]*\n)*', head, re.M)
        if match:
            edits.append((match.start(), match.end(), 'cover-authors-layout: ' + json.dumps(layout, ensure_ascii=False) + '\n'))
    for start, end, value in sorted(edits, reverse=True):
        text = text[:start] + value + text[end:]
    return text


def install(app, srv, routes):
    ws = srv.ws
    sample = {}  # 見本の原稿の sha256 → HTML（起動中に1回だけ描く）
    restore_point = {}  # テーマ名 → デフォルトに戻す前の CSS（⌘Z で戻すため。起動中だけ）

    def detail(name):
        check_name(name, 'テーマ')
        css = (ws.themes / f'{name}.css').read_bytes().decode('utf-8')
        default = ws.theme_default(name)
        decks = [d for d in ws.list_decks() if ws.deck_theme(d) == name]
        return {'name': name, 'vars': theme_edit.read_vars(css), 'version': sha256_text(css),
                # デフォルト（登録したときの CSS）から変わっているか。無ければ戻せない（None）
                'modified': None if default is None else css != default,
                'removable': name != 'default' and not decks,
                'shots': theme_shots.listing(ws, name),
                'locked': locked(name),
                'decks': decks}

    def locked(name):
        return any(getattr(h, 'theme_locked', lambda n: False)(name) for h in srv.hooks)

    async def collection(request):
        try:
            if request.method == 'POST':
                # 新しいテーマは、今のテーマ（直したもの）を元に登録する。型からは作らない
                body = await request.json()
                name = check_name(body.get('name', ''), 'テーマ')
                origin = check_name(body.get('from', ''), 'テーマ')
                css = (ws.themes / f'{origin}.css').read_bytes().decode('utf-8')
                if body.get('base') != sha256_text(css):
                    return JSONResponse({'error': 'テーマが外で変更されました'}, 409)
                if (ws.themes / f'{name}.css').exists():
                    return JSONResponse({'error': '同じ名前のテーマがあります'}, 409)
                ws.register_theme(name, css)
                return JSONResponse(detail(name), 201)
            return JSONResponse({'themes': [detail(n) for n in ws.themes_list()], 'fonts': theme_edit.FONTS,
                                 'recent': ws.prefs().get('recent_themes', [])})
        except (StudioError, ValueError, TypeError) as e:
            return JSONResponse({'error': str(e)}, 400)

    async def item(request):
        try:
            name = check_name(request.path_params['name'], 'テーマ')
            path = ws.themes / f'{name}.css'
            if request.method == 'GET':
                return JSONResponse(detail(name))
            if request.method == 'DELETE':
                if locked(name):
                    return JSONResponse({'error': 'AI の実行中は削除できません'}, 423)
                trash = ws.remove_theme(name)
                return JSONResponse({'trash': trash.relative_to(ws.root).as_posix()})
            body = await request.json()
            css = path.read_bytes().decode('utf-8')
            if body.get('base') != sha256_text(css):
                return JSONResponse({'error': 'テーマが外で変更されました'}, 409)
            if locked(name):
                return JSONResponse({'error': 'AI の実行中は編集できません'}, 423)
            if body.get('reset'):
                updated = ws.theme_default(name)
                if updated is None:
                    raise ValueError('このテーマにはデフォルトがありません')
            elif 'css' in body:
                # デフォルトに戻したことの取り消し・やり直しは、テーマの変数以外が違っても通す
                updated = body['css'] if body['css'] == ws.theme_default(name) or (
                    css == ws.theme_default(name) and body['css'] == restore_point.get(name)) else theme_edit.restore(css, body['css'])
            else:
                updated = theme_edit.set_vars(css, body.get('vars'))
            if body.get('reset'):
                if 'save_as' in body:
                    saved_name = check_name(body['save_as'], 'テーマ')
                    if (ws.themes / f'{saved_name}.css').exists():
                        return JSONResponse({'error': '同じ名前のテーマがあります'}, 409)
                    ws.register_theme(saved_name, css)
                restore_point[name] = css
            write_atomic(path, updated)
            # テーマはどの送信の控えにも入るので、実行中のすべての送信の［戻す］で戻さない
            for h in srv.hooks:
                for d in ws.list_decks():
                    getattr(h, 'user_wrote', lambda d, n: None)(d, f'themes/{name}.css')
            return JSONResponse({**detail(name), 'before': css, 'css': updated})
        except FileNotFoundError:
            return JSONResponse({'error': 'テーマがありません'}, 404)
        except (StudioError, ValueError, TypeError) as e:
            return JSONResponse({'error': str(e)}, 400)

    async def select(request):
        try:
            body = await request.json()
            name = check_name(body.get('theme', ''), 'テーマ')
            if name not in ws.themes_list():
                raise ValueError('テーマがありません')
            # 保存はしない。フロント側の通常の原稿履歴・保存を通す。選んだ順だけ残す（テーマのタブの並び）
            ws.set_prefs(recent_themes=[name, *[n for n in ws.prefs().get('recent_themes', []) if n != name]][:30])
            text = body['text']
            if (source.parse(text).meta.get('theme') or 'default') != name:
                text = reset_cover_positions(text)
            return JSONResponse({'text': set_front(text, {'theme': name})})
        except (StudioError, ValueError, KeyError, TypeError) as e:
            return JSONResponse({'error': str(e)}, 400)

    async def sample_page(request):
        try:
            name = check_name(request.query_params.get('theme') or 'default', 'テーマ')
            if name not in ws.themes_list():
                raise ValueError('テーマがありません')
            key = sha256_text((TEMPLATES / SAMPLE).read_text())
            if key not in sample:
                sample.clear()
                sample[key] = (await asyncio.to_thread(theme_shots.render_sample, ws, SAMPLE, 3)).html
            html = sample[key].replace('href="../../themes/default.css"', f'href="../../themes/{name}.css"', 1)
            return HTMLResponse(html, headers={'Cache-Control': 'no-store'})
        except (StudioError, ValueError) as e:
            return JSONResponse({'error': str(e)}, 400)

    app.router.routes[0:0] = [Route(SAMPLE_URL, sample_page),
                              Route('/api/themes', collection, methods=['GET', 'POST']),
                              Route('/api/themes/select', select, methods=['POST']),
                              Route('/api/themes/{name}', item, methods=['GET', 'PUT', 'DELETE'])]
