"""共有テーマの型の変数だけを、元の空白・コメントを保って変更する。"""
import re

from .workspace import THEME_VARIABLES

FONTS = ('"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif',
         '"Hiragino Mincho ProN","Yu Mincho",serif',
         '"Menlo",monospace')


CONTENT_COLORS = {
    '--table-header-bg': ('#stage table th', 'background'),
    '--table-header-ink': ('#stage table th, #stage table th *', 'color'),
    '--table-ink': ('#stage table td, #stage table td *', 'color'),
    '--math-ink': ('#stage :is(.math, math), #stage :is(.math, math) *', 'color'),
}


def content_override(key, value):
    selector, prop = CONTENT_COLORS[key]
    return f'\n/* slide-studio {key[2:]} */\n:root {{ {key}: {value}; }}\n{selector} {{ {prop}: var({key}); }}\n'


CONTENT_RES = {k: re.compile(re.escape(content_override(k, 'VALUE')).replace('VALUE', r'(#[0-9a-fA-F]{6})')) for k in CONTENT_COLORS}
TABLE_HEADER_TEMPLATE = '\n/* slide-studio table header */\n#stage table { --header: %s; }\n'
TABLE_HEADER_RE = re.compile(re.escape(TABLE_HEADER_TEMPLATE).replace('%s', r'(#[0-9a-fA-F]{3,8})'))


FILL = '--header-fill'
TITLE_TEMPLATE = '\n/* slide-studio title header */\n#stage .slide:is(.cover, .section-slide) { --header: %s; }\n'
TITLE_RE = re.compile(re.escape(TITLE_TEMPLATE).replace('%s', r'(#[0-9a-fA-F]{3,8})'))


def preserve_title_header(css, original=None):
    """通常ページの見出しの塗りを変更しても、表紙・章扉の配色を保つ。"""
    if TITLE_RE.search(css):
        return css
    value = read_vars(original or css).get('--header', '')
    if re.fullmatch(r'#[0-9a-fA-F]{3,8}', value):
        css += TITLE_TEMPLATE % value
    return css


INK_OVERRIDE = '\n/* slide-studio heading ink */\n#stage h2, #stage h2 * { color: var(--header-ink); }\n'
INK_RE = re.compile(re.escape(INK_OVERRIDE))
RULE_OVERRIDE = '\n/* slide-studio heading rule */\n#stage h2 { border-color: var(--rule); } #stage h2::after { background-color: var(--rule); }\n'
RULE_RE = re.compile(re.escape(RULE_OVERRIDE))
LINK_RE = re.compile(r'\n/\* slide-studio link ink \*/\n:root \{ --link: [^;{}]+; \}\n')
# 編集で追加する規則だけを undo 時にも識別する。任意の CSS の復元は許可しない。
OVERRIDE = '\n/* slide-studio heading fill */\n:root { --header-fill: %s; }\n#stage h2 { background: var(--header-fill); }\n#stage h2, #stage h2 * { color: var(--header-ink); }\n#stage .cover .cover-title, #stage .cover .cover-title p { color: var(--header); }\n'
OVERRIDE_RE = re.compile(re.escape(OVERRIDE).replace('%s', r'([^;{}]+)').replace(re.escape('#stage h2, #stage h2 * { color: var(--header-ink); }\n'), '(?:' + re.escape('#stage h2, #stage h2 * { color: var(--header-ink); }\n') + ')?'))
ANGLE = r'(?:[0-9]|[1-9][0-9]|[12][0-9]{2}|3[0-5][0-9])'
STOP = r'(?: (?:100|[0-9]{1,2})%)?'
GRADIENT = re.compile(r'linear-gradient\(' + ANGLE + r'deg, var\(--header\)' + STOP + r', (#[0-9a-fA-F]{6})' + STOP + r'\)')


HEADING_OPTIONS = {
    '--heading-mode': ('theme', 'fill', 'rule'),
    '--heading-rule-style': ('solid', 'dashed', 'dotted', 'double'),
    '--heading-rule-width': tuple(f'{n}px' for n in range(1, 7)),
    '--heading-rule-inset': ('0px', '44px'),
}
HEADING_DEFAULTS = dict(zip(HEADING_OPTIONS, ('theme', 'solid', '2px', '44px')))
HEADING_LAYOUT = """#stage .slide > h2 { margin-inline:calc(-1 * var(--content-inset)); width:auto; max-width:none; padding-inline:calc(var(--content-inset) + var(--text-pad)); border-radius:0; }
"""
HEADING_RULE = """#stage .slide > h2 { position:relative; background:none; border:0; box-shadow:none; }
#stage .slide > h2::after { content:''; display:block; position:absolute; left:var(--heading-rule-inset); right:var(--heading-rule-inset); bottom:0; width:auto; height:0; margin:0; background:none; border:0; border-bottom:var(--heading-rule-width) var(--heading-rule-style) var(--rule); }
"""
# 帯の文字は［見出しの文字］の色。テーマの h2 が --header で書いていても帯と同じ色にならない
HEADING_FILL = """#stage .slide > h2 { background:var(--header-fill, var(--header)); border:0; box-shadow:none; }
#stage .slide > h2, #stage .slide > h2 * { color:var(--header-ink); }
#stage .slide > h2::after { display:none; }
"""

def heading_options(values):
    mode = values['--heading-mode']
    return ('\n/* slide-studio heading options */\n:root { ' + ' '.join(f'{k}: {values[k]};' for k in HEADING_OPTIONS) + ' }\n' + HEADING_LAYOUT + (HEADING_RULE if mode == 'rule' else HEADING_FILL if mode == 'fill' else '') + '/* end heading options */\n')

HEADING_RE = re.compile(r'\n/\* slide-studio heading options \*/\n.*?/\* end heading options \*/\n', re.S)


def refresh_heading_options(css):
    """前の版で書いた見出しの装飾を、今の版の書き方に揃える（値はそのまま）。"""
    match = HEADING_RE.search(css)
    if not match:
        return css
    options = {k: read_vars(css)[k] for k in HEADING_OPTIONS}
    if any(v not in HEADING_OPTIONS[k] for k, v in options.items()):
        return css
    return css[:match.start()] + heading_options(options) + css[match.end():]


def heading_fill(css):
    match = OVERRIDE_RE.search(css)
    if match:
        return match[1]
    # 以前の default の直接指定も、初回の見出し編集から変数につなぐ。
    if 'linear-gradient(105deg,#123c62,#205c8b)' in css:
        return 'linear-gradient(105deg, var(--header), #205c8b)'
    return 'theme'


BACKGROUND = '--background-fill'
# 背景はページ・章扉・表紙で別々。以前の1つの指定（全ページ）は、どれかを編集したときに3つへ分ける。
KINDS = {
    BACKGROUND: ('page', '#stage .slide:not(.cover):not(.section-slide)'),
    '--section-fill': ('section', '#stage .slide.section-slide'),
    '--cover-fill': ('cover', '#stage .slide.cover'),
}
KIND_TEMPLATE = '\n/* slide-studio %s background */\n:root { %s: %s; }\n%s { background: var(%s); box-shadow: none; }\n'

def kind_override(key, value):
    name, selector = KINDS[key]
    return KIND_TEMPLATE % (name, key, value, selector, key)

KIND_RES = {k: re.compile(re.escape(kind_override(k, 'VALUE')).replace('VALUE', r'([^;{}]+)')) for k in KINDS}
BG_OVERRIDE = '\n/* slide-studio background fill */\n:root { --background-fill: %s; }\n#stage .slide { background: var(--background-fill); box-shadow: none; }\n'
# 以前保存した背景指定も読み取り・取り消しできる。
BG_RE = re.compile(re.escape(BG_OVERRIDE).replace('%s', r'([^;{}]+)').replace(re.escape(' box-shadow: none;'), '(?:' + re.escape(' box-shadow: none;') + ')?'))
HEX = r'#[0-9a-fA-F]{6}'
# 点の位置はページの外（テーマのにじみは -10% や 112% に置かれる）も受け付ける。大きさは任意。
POS = r'-?(?:150|1[0-4][0-9]|[1-9]?[0-9])%'
SIZE = r'(?:200|1[0-9]{2}|[1-9][0-9]?)%'
SPOT = r'radial-gradient\(ellipse (?:' + SIZE + ' ' + SIZE + r' )?at ' + POS + ' ' + POS + r', color-mix\(in srgb, ' + HEX + r' (?:100|[0-9]{1,2})%, transparent\), transparent (?:1[0-4][0-9]|150|[1-9][0-9]?)%\)'
# テーマから読み取った点の下地（章扉の斜めの色など）
GROUND = r'linear-gradient\(' + ANGLE + r'deg, ' + HEX + STOP + ', ' + HEX + STOP + r'\), '
BG_VALUE = re.compile(r'(?:var\(--paper\)|' + HEX + r'|linear-gradient\(' + ANGLE + r'deg, var\(--paper\)' + STOP + ', ' + HEX + STOP + r'\)|(?:' + SPOT + r', ){1,8}(?:' + GROUND + r')?var\(--paper\))')
HEADING_POINTS = re.compile(r'(?:' + SPOT + r', ){1,8}var\(--header\)')


def valid_heading(value):
    return isinstance(value, str) and (value in ('theme', 'var(--header)') or bool(GRADIENT.fullmatch(value) or HEADING_POINTS.fullmatch(value)))



# ブロックのデザイン（6種類）の色と太さ。ブロックの style が var で参照する。値はコメントの名前
BLOCK_KEYS = {'--block-border': 'border', '--block-background': 'background-color',
              '--block-top-line': 'top-line', '--block-top-fill': 'top-fill',
              '--block-left-line': 'left-line', '--block-left-fill': 'left-fill',
              '--block-shadow-fill': 'shadow-fill', '--block-shadow-color': 'shadow-color',
              '--block-corner-top': 'corner-top', '--block-corner-left': 'corner-left', '--block-corner-fill': 'corner-fill'}
BLOCK_LINES = {'--block-border', '--block-top-line', '--block-left-line', '--block-corner-top', '--block-corner-left'}
BLOCK_RADII = {f'--block-{kind}-radius' for kind in ('unframed', 'plain', 'top', 'left', 'quote', 'bracket', 'fold')}
BLOCK_SHADOWS = {f'--block-{kind}-shadow' for kind in ('unframed', 'plain', 'top', 'left', 'quote', 'bracket', 'fold')}
for kind in ('plain', 'top', 'left', 'quote', 'bracket', 'fold'):
    for part in ('ink', 'line', 'fill') if kind in ('quote', 'bracket', 'fold') else ('ink',):
        key = f'--block-{kind}-{part}'
        BLOCK_KEYS[key] = f'{kind}-{part}'
        if part == 'line':
            BLOCK_LINES.add(key)
BLOCK_KEYS.update({f'--block-{kind}-accent': f'{kind}-accent' for kind in ('quote', 'fold')})
BLOCK_KEYS.update({key: key.removeprefix('--block-') for key in BLOCK_RADII | BLOCK_SHADOWS})
BLOCK_TEMPLATE = '\n/* slide-studio block %s */\n:root { %s: %s; }\n'
# 以前は全ブロックへ適用する規則も続けて書いていた。読み取り・取り消しのため受け付ける。
LEGACY_BLOCK_SELECTOR = '#stage :is(p, ul, ol, h3, h4, blockquote, table, pre, img, .animation):not(:is(ul, ol, blockquote, table, .cover, .section-slide) *):not(p:has(img)):not([style*="border:"] *):not([style*="background-color:"] *)'

def block_override(key, value):
    css = BLOCK_TEMPLATE % (BLOCK_KEYS[key], key, value)
    if key in ('--block-quote-line', '--block-bracket-line', '--block-fold-line'):
        m = re.fullmatch(r'([\d.]+px) (?:solid|dashed|dotted|double) (#[0-9a-fA-F]{8})', value)
        if m:
            stem = key.removesuffix('-line')
            css += f'/* block detail {stem} */\n:root {{ {stem}-accent:{m[2]}; {stem}-width:{m[1]}; }}\n'
    return css

BLOCK_RES = {k: re.compile(re.escape(block_override(k, 'VALUE')).replace('VALUE', r'([^;{}]+)')
                           + '(?:' + re.escape('%s { %s: var(%s); }\n' % (LEGACY_BLOCK_SELECTOR, p, k)) + ')?'
                           + r'(?:/\* block detail ' + re.escape(k.removesuffix('-line')) + r' \*/\n:root \{[^{}]*\}\n)?')
             for k, p in BLOCK_KEYS.items()}

def valid_block(key, value):
    if not isinstance(value, str):
        return False
    if value == 'theme':
        return True
    if key in BLOCK_RADII:
        return bool(re.fullmatch(r'(?:[0-9]|[1-3][0-9]|40)px', value))
    if key in BLOCK_SHADOWS:
        return bool(re.fullmatch(r'(?:0(?:\.[0-9]{1,2})?|1(?:\.0{1,2})?)', value))
    if key in BLOCK_LINES:
        return value == 'none' or bool(re.fullmatch(r'(?:(?:[1-9]|1[0-9])(?:\.5)?|20)px (?:solid|dashed|dotted|double) #[0-9a-fA-F]{8}', value))
    return value == 'transparent' or bool(re.fullmatch(r'#[0-9a-fA-F]{8}', value))


# declarations が読む変数（:root の変数ごとに組み立て直さない）
KNOWN_VARS = frozenset((*THEME_VARIABLES, *CONTENT_COLORS, '--link', FILL, *KINDS, *BLOCK_KEYS, *HEADING_OPTIONS))


def declarations(css):
    # 同じ長さの空白でコメントを隠し、元の文字位置を保つ。
    masked = re.sub(r'/\*.*?\*/', lambda m: ' ' * len(m[0]), css, flags=re.S)
    # 波かっこだけを拾い、前の波かっことの間をセレクタとして読む（([^{}]*)\{ は位置をずらして読み直し、長い CSS で遅い）
    depth, prev = 0, 0
    for block in re.finditer(r'[{}]', masked):
        selector, prev = masked[prev:block.start()], block.end()
        if block[0] == '}':
            depth -= 1
            continue
        if depth == 0 and selector.strip() == ':root':
            end = masked.find('}', block.end())
            for m in re.finditer(r'(--[\w-]+)\s*:\s*([^;{}]+)', masked[block.end():end]):
                if m[1] in KNOWN_VARS:
                    start, stop = block.end() + m.start(2), block.end() + m.end(2)
                    while stop > start and css[stop - 1].isspace():
                        stop -= 1
                    priority = re.search(r'\s*!important\s*$', masked[start:stop], re.I)
                    if priority:
                        stop = start + priority.start()
                    # コメントを値の一部として消さない。
                    comment = css.find('/*', start, stop)
                    if comment >= 0:
                        stop = comment
                        while stop > start and css[stop - 1].isspace():
                            stop -= 1
                    yield m[1], start, stop
        depth += 1


def kind_fill(css, key):
    match = KIND_RES[key].search(css) or BG_RE.search(css)
    return match[1] if match else 'theme'


def valid_background(value):
    return isinstance(value, str) and (value == 'theme' or bool(BG_VALUE.fullmatch(value)))


def read_vars(css):
    colors = {k: css[a:b] for k, a, b in declarations(css)}
    return {**HEADING_DEFAULTS, '--link': '#2167a8', **dict.fromkeys(CONTENT_COLORS, '#000000'), **colors, FILL: heading_fill(css),
            **{k: kind_fill(css, k) for k in KINDS},
            **{k: regex.search(css)[1] if regex.search(css) else colors.get(k, 'theme') for k, regex in BLOCK_RES.items()}}


def set_vars(css, values):
    if not isinstance(values, dict):
        raise ValueError('テーマの値が正しくありません')
    values = dict(values)
    if '--header' in values:
        if not TABLE_HEADER_RE.search(css):
            value = read_vars(css).get('--header', '')
            if re.fullmatch(r'#[0-9a-fA-F]{3,8}', value):
                css += TABLE_HEADER_TEMPLATE % value
        css = preserve_title_header(css)
    for key, regex in CONTENT_RES.items():
        if key in values:
            value = values.pop(key)
            if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
                raise ValueError('表・数式の色が正しくありません')
            css = regex.sub('', css) + content_override(key, value)
    options = {k: read_vars(css)[k] for k in HEADING_OPTIONS}
    if values.get(FILL) == 'theme' and '--heading-mode' not in values:
        options['--heading-mode'] = 'theme'
    changed = any(k in values for k in HEADING_OPTIONS)
    for k, choices in HEADING_OPTIONS.items():
        if k in values:
            v = values.pop(k)
            if v not in choices:
                raise ValueError('見出しの装飾が正しくありません')
            options[k] = v
    if '--header' in values or values.get(FILL, 'theme') != 'theme':
        options['--heading-mode'] = 'fill'
        changed = True
    elif '--rule' in values:
        options['--heading-mode'] = 'rule'
        changed = True
    if values.get(FILL) == 'theme' and options['--heading-mode'] == 'theme':
        changed = False
        css = HEADING_RE.sub('', css)
    if changed:
        css = HEADING_RE.sub('', css) + heading_options(options)
    for key, regex in BLOCK_RES.items():
        if key in values:
            value = values.pop(key)
            if not valid_block(key, value):
                raise ValueError('ブロックの装飾が正しくありません')
            css = regex.sub('', css)
            if value != 'theme':
                css += block_override(key, value)
    if any(k in values for k in KINDS):
        legacy = BG_RE.search(css)
        current = {k: kind_fill(css, k) for k in KINDS}
        css = BG_RE.sub('', css)
        for key, regex in KIND_RES.items():
            if key not in values and not legacy:
                continue
            background = values.pop(key, current[key])
            if not valid_background(background):
                raise ValueError('背景のグラデーションが正しくありません')
            css = regex.sub('', css)
            if background != 'theme':
                css += kind_override(key, background)
    if FILL in values and values[FILL] is None:
        raise ValueError('見出しのグラデーションが正しくありません')
    fill = values.pop(FILL, None)
    if fill is not None and not valid_heading(fill):
        raise ValueError('見出しのグラデーションが正しくありません')
    if fill is not None or '--header' in values or '--header-ink' in values:
        fill = fill or heading_fill(css)
        if fill == 'theme' and '--header' in values:
            fill = 'var(--header)'
        css = OVERRIDE_RE.sub('', css)
        if fill != 'theme':
            css += OVERRIDE % fill
    if '--rule' in values:
        css = RULE_RE.sub('', css) + RULE_OVERRIDE
    if '--header-ink' in values:
        css = INK_RE.sub('', css) + INK_OVERRIDE
    for k, v in values.items():
        if k not in (*THEME_VARIABLES, '--link') or not isinstance(v, str) or not (
            re.fullmatch(r"[\w\s,\"'-]+", v) if k.startswith('--font-') else
            re.fullmatch(r'#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]+|(?:rgba?|hsla?|var)\([\w\s.,%#+/-]+\)', v)
        ):
            raise ValueError(f'テーマの値が正しくありません: {k}')
    if '--link' in values and '--link' not in dict((k, css[a:b]) for k, a, b in declarations(css)):
        css += '\n/* slide-studio link ink */\n:root { --link: %s; }\n' % values['--link']
    spans = list(declarations(css))
    if set(values) - {k for k, _, _ in spans}:
        raise ValueError('テーマの :root に変数がありません')
    for k, a, b in reversed(spans):
        if k in values:
            css = css[:a] + values[k] + css[b:]
    return css


# 以前の版がスライドで表紙を動かしたときに書いた位置と大きさ。今は書かず、テーマを用意するときに取り除く
COVER_RE = re.compile(r'\n/\* slide-studio cover layout \*/\n(?:#stage \.slide\.cover > \.cover-(?:title|subtitle|authors) \{[^{}\n]*\}\n)*')


def drop_cover_layout(css):
    return COVER_RE.sub('', css)


def restore(css, previous):
    """取り消しも型の変数の値だけ。重複宣言の元の値も個別に復元する。"""
    if not isinstance(previous, str):
        raise ValueError('テーマの値が正しくありません')

    def skeleton(text):
        text = TABLE_HEADER_RE.sub('', TITLE_RE.sub('', text))
        for regex in CONTENT_RES.values():
            text = regex.sub('', text)
        text = HEADING_RE.sub('', text)
        text = RULE_RE.sub('', LINK_RE.sub('', INK_RE.sub('', BG_RE.sub('', OVERRIDE_RE.sub('', text)))))
        for regex in (*BLOCK_RES.values(), *KIND_RES.values()):
            text = regex.sub('', text)
        for _, a, b in reversed(list(declarations(text))):
            text = text[:a] + '\0' + text[b:]
        return text

    for key, regex in BLOCK_RES.items():
        match = regex.search(previous)
        if match and not valid_block(key, match[1]):
            raise ValueError('ブロックの装飾が正しくありません')
    option_match = HEADING_RE.search(previous)
    if option_match:
        options = {k: read_vars(previous)[k] for k in HEADING_OPTIONS}
        if any(v not in HEADING_OPTIONS[k] for k, v in options.items()) or heading_options(options) != option_match[0]:
            raise ValueError('見出しの装飾が正しくありません')
    for regex in (BG_RE, *KIND_RES.values()):
        background = regex.search(previous)
        if background and not BG_VALUE.fullmatch(background[1]):
            raise ValueError('背景のグラデーションが正しくありません')
    match = OVERRIDE_RE.search(previous)
    if match and not valid_heading(match[1]):
        raise ValueError('見出しのグラデーションが正しくありません')
    if skeleton(css) != skeleton(previous):
        raise ValueError('テーマの変数以外は変更できません')
    return previous
