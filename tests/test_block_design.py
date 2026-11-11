from slide_studio.block_design import migrate
from slide_studio.source import parse

TOP = '--block-design:top'
PLAIN = '--block-design:plain'


def test_old_colors_become_design_only():
    old = ('::: {#a style="padding:24px;--block-design:top;border:0 solid transparent;border-radius:10px;'
           'border-top:4px solid #2b8da3ff;background-color:#edf6faff"}\n本文\n:::\n')
    assert migrate(old) == f'::: {{#a style="padding:24px;{TOP}"}}\n本文\n:::\n'
    # 画像・図のショートコードも同じ
    assert migrate('![](a.png){style="border:2px dashed #65758bff"}') == f'![](a.png){{style="{PLAIN}"}}'
    assert migrate('{{< fig x style="border:1px solid #65758bff;background-color:#e8eff7ff" >}}') == f'{{{{< fig x style="{PLAIN}" >}}}}'


def test_background_only_becomes_plain_and_cleared_becomes_unframed():
    assert migrate('::: {style="padding:8px;background-color:#eef5faff"}') == f'::: {{style="padding:8px;{PLAIN}"}}'
    assert migrate('::: {style="padding:8px;border:none;background-color:transparent"}') == '::: {style="padding:8px"}'
    # 何も残らない style はそのまま
    assert migrate('::: {style="border:none"}') == '::: {style="border:none"}'


def test_new_form_handwritten_css_and_raw_html_are_kept():
    reordered = f'::: {{style="--block-design:top;padding:4px"}}'
    for text in [f'::: {{style="{TOP}"}}', reordered, '::: {.row style="border: 1px solid #ccc;"}',
                 '<div style="border:1px solid #65758bff">x</div>', '::: {style="border-top:4px solid #2b8da3ff;background-color:#edf6fa"}']:
        assert migrate(text) == text


def test_shorthand_and_shadow_and_explicit_text_color_survive():
    for kind in ('plain', 'top', 'left', 'quote', 'bracket', 'fold'):
        text = f'::: {{style="--block-design:{kind};--block-shadow:on;color:#123456"}}\n[指定]{{.warn}}\n:::'
        assert migrate(text) == text
        assert migrate(migrate(text)) == text


def test_single_box_in_column_is_promoted_without_changing_body():
    text = '## A\n\n:::: {.columns}\n::: {.column width="40%"}\n::: {style="--block-design:plain;padding:12px"}\n名前。\n\n説明。\n:::\n:::\n::: {.column width="60%"}\n右。\n:::\n::::\n'
    result = migrate(text)
    columns = parse(result).pages[0].chunks[0].children
    assert columns[0].attrs.kv == {'width': '40%', 'style': '--block-design:plain;padding:12px'}
    assert [c.kind for c in columns[0].children] == ['text', 'text']
    assert '名前。\n\n説明。' in result
    assert columns[1].attrs.kv['width'] == '60%'
    assert migrate(result) == result


def test_column_normalization_preserves_distinct_containers():
    for outer, box, body in [
        ('', '#named style="--block-design:plain"', '名前。'),
        ('style="--block-design:top"', 'style="--block-design:plain"', '名前。'),
        ('style="--block-design:plain"', 'style="--block-design:plain"', '名前。'),
        ('style="--block-shadow:on"', 'style="--block-design:plain"', '名前。'),
        ('style="font-size:1.2em"', 'style="font-size:1.2em"', '名前。'),
        ('style="opacity:0.5"', 'style="opacity:0.5"', '名前。'),
        ('', 'style="--block-design:plain"', '名前。\n:::\n\n説明。\n::: {}\n別。'),
    ]:
        text = f'## A\n\n:::: {{.columns}}\n::: {{.column {outer}}}\n::: {{{box}}}\n{body}\n:::\n:::\n::::\n'
        assert migrate(text) == text


def test_column_normalization_keeps_width_and_outer_spacing_and_box_padding():
    text = '## A\n\n:::: {.columns}\n::: {.column width="49%" style="padding:0px 0px 20px 0px;--block-space:0px"}\n::: {style="--block-design:plain;padding:12px;--block-space:20px"}\n名前。\n\n説明。\n:::\n:::\n::::\n'
    col = parse(migrate(text)).pages[0].chunks[0].children[0]
    assert col.attrs.kv['width'] == '49%'
    assert col.attrs.kv['style'] == 'padding:12px;--block-space:0px;--block-design:plain'
    assert [c.kind for c in col.children] == ['text', 'text']
