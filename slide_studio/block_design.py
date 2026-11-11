"""ブロックのデザイン。原稿には種類だけを書き、色と太さはテーマの変数を参照する。

書き方は web/block-design.js の designValues と同じ。以前の版はブロックごとに色を書いていたので、
発表を開いたときに種類だけの形へ直す（色はテーマの値になる）。"""
from __future__ import annotations

import re

DECORATION = ('border', 'background-color', '--block-design', 'border-top', 'border-left', 'border-radius', 'box-shadow')
KINDS = ('plain', 'top', 'left', 'quote', 'bracket', 'fold')
# 古い種類も読む。既存原稿の見た目は維持し、新規選択からだけ外す。
DESIGNS = dict.fromkeys(KINDS, {})
DESIGNS.update({
    'shadow': {'border': '0 solid transparent', 'border-radius': '10px', 'background-color': 'var(--block-shadow-fill)', 'box-shadow': '0 4px 14px var(--block-shadow-color)'},
    'corner': {'border': '0 solid transparent', 'border-radius': '10px', 'border-top': 'var(--block-corner-top)', 'border-left': 'var(--block-corner-left)', 'background-color': 'var(--block-corner-fill)'},
})
# 以前の GUI が書いた形だけを直す。手で書いた CSS（#ccc など）はそのまま
_COLOR = r'#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?'
_BORDER = re.compile(r'[\d.]+px (?:solid|dashed|dotted|double) ' + _COLOR)
# Pandoc の属性（{…}）とショートコード（{{< … >}}）の中の style。生の HTML は対象にしない
_STYLE = re.compile(r'(\{[^{}\n]*?\bstyle=")([^"]*)(")')


def design_values(kind: str | None) -> dict[str, str]:
    return {'--block-design': kind, **DESIGNS[kind]} if kind else {}


def _props(style: str) -> list[tuple[str, str]]:
    pairs = (p.split(':', 1) for p in style.split(';') if ':' in p)
    return [(k.strip(), v.strip()) for k, v in pairs]


def _kind(props: dict[str, str]) -> str | None | bool:
    """直した後の種類（None は枠線なし）。直さないものは False"""
    if props.get('--block-design') in DESIGNS:
        return props['--block-design']
    border, fill = props.get('border'), props.get('background-color')
    if border is None and fill is None or any(k in props for k in DECORATION[2:]):
        return False
    if border is not None and not (border == 'none' or _BORDER.fullmatch(border)):
        return False
    if fill is not None and not (fill == 'transparent' or re.fullmatch(_COLOR, fill)):
        return False
    # 背景だけのブロックも、色が付いていたものは「枠線」にする（背景だけのデザインは無い）
    return 'plain' if (border and border != 'none') or (fill and fill != 'transparent') else None


def migrate(text: str) -> str:
    def fix(m: re.Match) -> str:
        props = _props(m[2])
        kind = _kind(dict(props))
        if kind is False:
            return m[0]
        rest = [(k, v) for k, v in props if k not in DECORATION] + list(design_values(kind).items())
        # すでに今の形のもの（並び順だけ違う）と、何も残らないもの（枠線なしのままで見た目は同じ）は書き換えない
        if not rest or dict(rest) == dict(props):
            return m[0]
        return m[1] + ';'.join(f'{k}:{v}' for k, v in rest) + m[3]
    return normalize_columns(_STYLE.sub(fix, text))


def normalize_columns(text: str) -> str:
    """列の唯一の無名の箱を列へ統合する。本文・名前付きの囲みには触れない。"""
    from . import source

    decoration = {*DECORATION, '--block-shadow'}
    # 内側から1つずつ直して解析し直す。入れ子の位置も、2回目以降の結果も安定する。
    while True:
        edits = None
        for page in source.parse(text).pages:
            for col in page.walk():
                if col.kind != 'column' or len(col.children) != 1 or not col.open:
                    continue
                box = col.children[0]
                if (box.kind != 'box' or not box.open or not box.close or not box.attrs
                        or box.attrs.id or box.attrs.classes):
                    continue
                # 二重の装飾や段階表示には別々の意味があるので統合しない。
                outer = dict(_props(col.attrs.kv.get('style', '')))
                inner = dict(_props(box.attrs.kv.get('style', '')))
                if outer.keys() & decoration and inner.keys() & decoration:
                    continue
                # 同値でも font-size や opacity は入れ子の各階層で効くので、重なる指定は残す。
                if any(k not in {'padding', 'text-box', '--block-space'} and k in outer for k in inner):
                    continue
                if any(k != 'style' and k in col.attrs.kv and col.attrs.kv[k] != v for k, v in box.attrs.kv.items()):
                    continue
                kv = {**col.attrs.kv, **box.attrs.kv}
                if outer or inner:
                    style = outer | inner
                    # 外側余白は列、内側余白とデザインは箱から引き継ぐ。
                    if '--block-space' in outer:
                        style['--block-space'] = outer['--block-space']
                    kv['style'] = ';'.join(f'{k}:{v}' for k, v in style.items())
                attrs = ([f'#{col.attrs.id}'] if col.attrs.id else []) + [f'.{c}' for c in col.attrs.classes]
                attrs += [k + '="' + v.replace('\\', '\\\\').replace('"', '\\"') + '"' for k, v in kv.items()]
                fence = re.match(r'\s*:{3,}', text[col.open[0]:col.open[1]])[0]
                edits = [(col.open[0], col.open[1], fence + ' {' + ' '.join(attrs) + '}'),
                         (box.open[0], box.open[1], ''), (box.close[0], box.close[1], '')]
                break
            if edits:
                break
        if not edits:
            return text
        for start, end, replacement in sorted(edits, reverse=True):
            text = text[:start] + replacement + text[end:]


PALETTE_MARK = '/* block palette v4:'
_PALETTE = re.compile(r'/\* block palette v\d+:.*?\*/\n:root \{\n.*?\n\}\n', re.S)
_KEPT = re.compile(r'(--block-\w+-shadow|--block-unframed-radius)\s*:\s*([^;\s]+)')
# 帯が主役の種類は線を太くする。枠で囲む種類は太いと重いので細いまま
_LINE_WIDTH = {'top': '8px', 'left': '10px'}
# 地との明るさの比。これ以上離れるまで面の色を濃くする
_FILL_CONTRAST = {'light': 1.22, 'dark': 1.55}


def theme_palette(colors: dict[str, str], keep: dict[str, str] | None = None) -> str:
    """テーマの色から6種類のブロックの配色を作る。keep は引き継ぐ影などの値。"""
    import colorsys

    def rgb(value):
        if not re.fullmatch(r'#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?', value):
            return None
        return tuple(int(value[i:i + 2], 16) / 255 for i in (1, 3, 5))

    ink, paper, accent = (rgb(colors.get(k, '')) for k in ('--ink', '--paper', '--accent'))
    if any(c is None for c in (ink, paper, accent)):
        return ''
    keep = keep or {}

    def luminance(c):
        return sum((v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4) * w
                   for v, w in zip(c, (.2126, .7152, .0722)))

    def contrast(a, b):
        low, high = sorted((luminance(a), luminance(b)))
        return (high + .05) / (low + .05)

    def hex_color(c):
        return '#' + ''.join(f'{round(v * 255):02x}' for v in c) + 'ff'

    def mix(a, b, weight):
        return tuple(x * weight + y * (1 - weight) for x, y in zip(a, b))

    dark = luminance(paper) < .2

    def tint(line):
        """線と同じ色相で、地からはっきり離れる面の色。"""
        hue, _, saturation = colorsys.rgb_to_hls(*line)
        _, level, _ = colorsys.rgb_to_hls(*paper)
        strength = max(.12, min(.2 if dark else .36, saturation * .6))
        target = _FILL_CONTRAST['dark' if dark else 'light']
        step = .01 if dark else -.01
        fill = colorsys.hls_to_rgb(hue, level, strength)
        while contrast(fill, paper) < target and 0 < level + step < 1:
            level += step
            fill = colorsys.hls_to_rgb(hue, level, strength)
        return fill

    def bold(line, fill):
        """線を面に対して十分濃く（暗い地では明るく）する。"""
        hue, level, saturation = colorsys.rgb_to_hls(*line)
        step = .01 if dark else -.01
        while contrast(line, fill) < 3 and 0 < level + step < 1:
            level += step
            line = colorsys.hls_to_rgb(hue, level, saturation)
        return line

    def legible(fill):
        """本文の色をなるべく保ち、足りない分だけ黒か白へ寄せる。"""
        end = (1, 1, 1) if luminance(fill) < .2 else (0, 0, 0)
        return next(c for c in (mix(end, ink, k / 50) for k in range(51)) if contrast(c, fill) >= 5 or c == end)

    hue, _, saturation = colorsys.rgb_to_hls(*accent)
    light = .72 if dark else .38
    good = rgb(colors.get('--good', '')) or colorsys.hls_to_rgb((hue + .17) % 1, light, max(.2, saturation * .55))
    memo = rgb(colors.get('--mark-line', '')) or colorsys.hls_to_rgb(.09, light, .5)
    lines = [mix(ink, paper, .6), accent, good,
             rgb(colors.get('--muted', '')) or colorsys.hls_to_rgb(hue, light, .12),
             colorsys.hls_to_rgb((hue + .09) % 1, light, max(.28, saturation * .55)),
             memo]
    css = [f'{PALETTE_MARK} 整理・結論・補足・引用・定義・メモ */', ':root {']
    for kind, line in zip(KINDS, lines):
        fill = paper if kind == 'plain' else tint(line)
        line = bold(line, fill)
        width = _LINE_WIDTH.get(kind, '3.5px')
        radius = '0px' if kind == 'bracket' else '10px'  # 括弧は角の印があるので角張ったまま
        shadow = keep.get(f'--block-{kind}-shadow', '0.18')
        line_key = '--block-border' if kind == 'plain' else f'--block-{kind}-line'
        fill_key = '--block-background' if kind == 'plain' else f'--block-{kind}-fill'
        css.extend([f'  {line_key}:{width} solid {hex_color(line)};',
                    f'  {fill_key}:{hex_color(fill)};',
                    f'  --block-{kind}-ink:{hex_color(legible(fill))};',
                    f'  --block-{kind}-radius:{radius};',
                    f'  --block-{kind}-shadow:{shadow};'])
        if kind in ('quote', 'bracket', 'fold'):
            css.extend([f'  --block-{kind}-accent:{hex_color(line)};', f'  --block-{kind}-width:{width};'])
    css.extend([f"  --block-unframed-radius:{keep.get('--block-unframed-radius', '0px')}; "
                f"--block-unframed-shadow:{keep.get('--block-unframed-shadow', '0.18')};", '}'])
    return '\n'.join(css) + '\n'


def with_current_palette(css: str, colors: dict[str, str]) -> str:
    """配色の層だけを今の版にする。影と、後ろに書かれた GUI の個別調整はそのまま。"""
    if PALETTE_MARK in css:
        return css
    old = _PALETTE.search(css)
    palette = theme_palette(colors, dict(_KEPT.findall(old[0])) if old else None)
    if not palette:
        return css
    if old:
        return css[:old.start()] + palette + css[old.end():]
    marker = css.find('/* slide-studio block ')
    return css[:marker] + palette + css[marker:] if marker >= 0 else css + '\n' + palette
