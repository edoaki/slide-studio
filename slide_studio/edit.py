"""GUI の往復変換。mock/gui/server.mjs の toMarkdown と index.html の fmtStyle を移植。"""
from __future__ import annotations

import re
from functools import lru_cache

from bs4 import BeautifulSoup

from . import pandoc_worker
from . import source


def _protect_atoms(soup, atoms: dict[str, str]) -> None:
    """引用・脚注・数式を目印の文字に替え、原文を atoms に控える。"""
    for el in soup.select('[data-slide-studio-atom]'):
        token = f"SLIDESTUDIOATOM{len(atoms)}END"
        atoms[token] = el['data-slide-studio-atom']
        el.replace_with(token)


def _clean(soup) -> None:
    """描画時に付いた属性を落とし、原稿に書ける要素と書式だけにする。"""
    for el in soup.select('script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select'):
        el.decompose()
    for el in soup.find_all(True):
        if el.has_attr('data-slide-studio-step-generated'):
            el.attrs.pop('data-step', None)
            if el.has_attr('class'):
                el['class'] = [c for c in el['class'] if c != 'pending']
        if el.name == 'a':
            # 描画時に足す属性は原稿へ書き戻さない。
            for attr in ('target', 'rel'):
                el.attrs.pop(attr, None)
        if el.has_attr('class'):
            classes = [c for c in el['class'] if c not in ('slide-studio-selected', 'slide-studio-editing')]
            del el['class']
            if classes:
                el['class'] = classes
        for attr in list(el.attrs):
            if attr.startswith(('data-slide-studio', 'on')) or attr in ('contenteditable', 'srcdoc'):
                del el[attr]
        if el.has_attr('style'):
            styles = dict((k.strip().lower(), v.strip()) for d in el['style'].split(';') if ':' in d for k, v in [d.split(':', 1)])
            keep = {}
            if re.fullmatch(r'#[0-9a-fA-F]{3,8}', styles.get('color', '')):
                keep['color'] = styles['color']
            if re.fullmatch(r'\d*\.?\d+em', styles.get('font-size', '')):
                keep['font-size'] = styles['font-size']
            del el['style']
            if keep:
                el['style'] = '; '.join(f'{k}: {v}' for k, v in keep.items())
    for el in reversed(soup.select('span')):
        if not el.attrs:
            el.unwrap()


@lru_cache(maxsize=1024)
def to_markdown(html: str, original: str = '') -> str:
    soup = BeautifulSoup(html, "html.parser")
    atoms = {}
    _protect_atoms(soup, atoms)
    _clean(soup)
    result = pandoc_worker.run(str(soup), ['--from', 'html-native_divs', '--to',
                             'markdown-raw_html-simple_tables-multiline_tables-grid_tables', '--wrap=none'],
                             timeout=30)
    result.check_returncode()
    md = re.sub(r'^(\s*)([-*+]|\d+[.)])\s{2,}(?=\S)', r'\1\2 ', result.stdout, flags=re.M).strip()
    for token, raw in atoms.items():
        md = md.replace(token, raw)
    # ブロック末尾の空白は HTML に残らないので、原文から戻す。
    # 途中の行末空白（Markdown の改行）などは正規化しない。
    return md + original[len(original.rstrip(' \t')):]


CELL_SEP = 'SLIDESTUDIOCELLSEP'
CELL_BREAK = 'SLIDESTUDIOCELLBREAK'


@lru_cache(maxsize=1024)
def cells_to_markdown(cells: tuple[str, ...]) -> tuple[str, ...]:
    """セルの中身の HTML を、パイプ表の1行に書ける Markdown にする（表ごとに Pandoc を1回だけ呼ぶ）。"""
    atoms: dict[str, str] = {}
    parts = []
    for html in cells:
        soup = BeautifulSoup(html.replace('\xa0', ' '), 'html.parser')
        _protect_atoms(soup, atoms)
        _clean(soup)
        for br in soup.find_all('br'):
            br.replace_with(CELL_BREAK)
        parts.append(f'<div>{soup}</div>')
    # 原文の — … をそのまま残すので、smart は使わない。パイプ表の | は Pandoc が \| にする
    result = pandoc_worker.run(f'<p>{CELL_SEP}</p>'.join(parts), ['--from', 'html-native_divs', '--to',
                             'markdown-raw_html-simple_tables-multiline_tables-grid_tables-smart', '--wrap=none'],
                             timeout=30)
    result.check_returncode()
    out = []
    for md in re.split(rf'\n*^{CELL_SEP}$\n*', result.stdout.strip(), flags=re.M):
        # 打った改行の末尾（入力欄のための br）は書かない。段落が分かれて貼り付けられたら改行にする
        md = re.sub(rf'(?:\s*{CELL_BREAK})+\s*$', '', md.strip())
        md = re.sub(rf'\s*{CELL_BREAK}\s*', '<br>', md)
        md = re.sub(r'\s*\n\s*\n\s*', '<br>', md)
        md = re.sub(r'\s*\n\s*', ' ', md)
        for token, raw in atoms.items():
            md = md.replace(token, raw)
        out.append(md)
    if len(out) != len(cells):
        raise ValueError('セルを変換できません')
    return tuple(out)


def cell_markdown(html: str) -> str:
    """編集したセル（td・th の outerHTML）を Markdown にする。"""
    cell = BeautifulSoup(html, 'html.parser').find(['td', 'th'])
    return cells_to_markdown(((cell.decode_contents() if cell else html),))[0]


def table_cells(table, raw: str) -> list[list[dict]] | None:
    """描画された表のセルごとの直接編集の可否と、編集用の HTML。0 行目が見出し（全部空の見出しは描画されない）。"""
    rows = source.table_rows(raw)
    trs = table.find_all('tr')
    first = 0 if table.find('thead') else 1
    if not rows or len(trs) + first != len(rows):
        return None
    out: list[list[dict]] = [[] for _ in range(first)]
    for i, tr in enumerate(trs):
        row = []
        for c, cell in enumerate(tr.find_all(['th', 'td'], recursive=False)):
            info = {'direct': False, 'html': ''}
            row.append(info)
            if c < len(rows[i + first]):
                a, b = rows[i + first][c]
                source_text = raw[a:b].strip()
                info['html'] = prepared_html(cell.decode_contents(), source_text)
                info['direct'] = True
        out.append(row)
    return out


INLINE_MATH = re.compile(r'(?<!\$)\$(?![\s$])(?:\\[^\n]|[^\\$\n])+(?<!\s)\$(?![\d$])')


def _atom_source(raw: str) -> str:
    """コード表記とエスケープを空白にし、原文の位置を保つ。"""
    text = list(raw)
    pos = 0
    while pos < len(raw):
        if raw[pos] == '\\' and pos + 1 < len(raw):
            text[pos] = ' '
            if raw[pos + 1] != '\n':
                text[pos + 1] = ' '
            pos += 2
        elif raw[pos] == '$' and (math := INLINE_MATH.match(raw, pos)):
            # 数式内のバッククォートはコードの囲みではない。
            pos = math.end()
        elif raw[pos] == '`':
            ticks = re.match(r'`+', raw[pos:])[0]
            end = pos + len(ticks)
            close = re.search(rf'(?<!`){ticks}(?!`)', raw[end:])
            if close:
                end += close.end()
                text[pos:end] = ['\n' if c == '\n' else ' ' for c in raw[pos:end]]
            pos = end
        else:
            pos += 1
    return ''.join(text)


def _citation_source(atom_source: str) -> str:
    """数式とリンク先の @ を除き、引用の原文位置を保つ。"""
    text = list(atom_source)
    for pattern in (INLINE_MATH, r'<[A-Za-z][A-Za-z0-9+.-]*:[^<>\n]*>'):
        for match in re.finditer(pattern, atom_source):
            text[match.start():match.end()] = ' ' * len(match[0])
    # リンクのラベルは残す。リンク先の括弧と、引用符付きタイトル内の括弧を区別する。
    brackets = []
    for pos, char in enumerate(text):
        if char == '[':
            brackets.append(pos)
        elif char == ']' and brackets:
            brackets.pop()
            if pos + 1 >= len(text) or text[pos + 1] != '(':
                continue
            depth, quote = 1, ''
            for end in range(pos + 2, len(text)):
                char = text[end]
                if quote:
                    if char == quote:
                        quote = ''
                elif char in ('"', "'") and text[end - 1].isspace():
                    quote = char
                elif char == '(':
                    depth += 1
                elif char == ')':
                    depth -= 1
                    if not depth:
                        text[pos + 2:end] = ' ' * (end - pos - 2)
                        break
    return ''.join(text)


def prepared_html(html: str, raw: str) -> str:
    """描画された引用・脚注・インライン数式に原文の目印を付ける。

    数が合う場合に、描画された要素と原文を対応付ける。
    """
    soup = BeautifulSoup(html, 'html.parser')
    atom_source = _atom_source(raw)
    groups = [
        (soup.select('.citation'),
         r'\[[^\]\n]*@[^\]\n]+\]|(?<![\w@])-?@\w+(?:[:.-]+\w+)*(?:[ \t]+\[(?!\^)[^\]\n]*\](?!\())?',
         _citation_source(atom_source)),
        (soup.select('a.footnote-ref, sup[data-slide-studio-footnote]'), r'\[\^[^\]]+\]', atom_source),
        (soup.select('span.math.inline, math:not([display=block])'), INLINE_MATH, atom_source),
    ]
    for elements, pattern, match_source in groups:
        originals = [raw[m.start():m.end()] for m in re.finditer(pattern, match_source)]
        if len(elements) != len(originals) and match_source != atom_source:
            # 括弧が対応していてもリンクが成立せず、リンク先の @ が引用になる場合がある。
            fallback = [raw[m.start():m.end()] for m in re.finditer(pattern, atom_source)]
            if len(elements) == len(fallback):
                originals = fallback
        if len(elements) == len(originals):
            for el, original in zip(elements, originals):
                el['data-slide-studio-atom'] = original
                el['contenteditable'] = 'false'
    return str(soup)


def chunk_info(rendered) -> dict:
    soup = BeautifulSoup(rendered.html, 'html.parser')
    elements = {el['data-slide-studio']: el for el in soup.select('[data-slide-studio]')}
    info = {}
    for page in rendered.doc.pages:
        for chunk in page.walk():
            key = f'p{page.index}/{chunk.path}'
            info[key] = {'direct': False, 'html': ''}
            if chunk.kind != 'text':
                continue
            el = elements.get(key)
            raw = rendered.doc.text[chunk.start:chunk.end]
            # パイプ表は表全体ではなくセルごとに直す
            # （表だけのブロックは、描画で目印が table 自体に移る）
            found = ([el] if el.name == 'table' else el.find_all('table')) if el is not None and source.table_rows(raw) else []
            if len(found) == 1:
                cells = table_cells(found[0], raw)
                if cells is not None:
                    info[key]['cells'] = cells
                continue
            html = prepared_html(str(el), raw) if el else ''
            # display:contents の描画用の囲みだけを外す。
            fragment = BeautifulSoup(html, 'html.parser')
            for wrapper in list(fragment.select('.slide-studio-c')):
                wrapper.unwrap()
            html = str(fragment)
            direct = chunk.kind == 'text' and bool(html) and not fragment.select('span.math.display, math[display=block]')
            info[key] = {'direct': direct, 'html': html if direct else ''}
    return info
