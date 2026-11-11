from conftest import add_deck
from slide_studio import check, render
import pytest
from bs4 import BeautifulSoup


@pytest.mark.parametrize('mode', ['process', 'worker'])
@pytest.mark.parametrize('style, expected', [
    ('padding:12px;--block-space:0px', 'width:51%'),
    ('width:60%;padding:12px', 'width:60%'),
    ('', 'width:51%'),
])
def test_column_width_and_style_do_not_generate_duplicate_warning(tmp_path, monkeypatch, mode, style, expected):
    monkeypatch.setenv('SLIDE_STUDIO_PANDOC_MODE', mode)
    text = f'::: {{.column width="51%" style="{style}"}}\nText\n:::\n'
    html, warnings = render.run_pandoc(text, tmp_path, ['--lua-filter', str(render.LUA)])
    assert not warnings
    column = BeautifulSoup(html, 'html.parser').select_one('.column')
    assert expected in column['style']
    assert column['style'].count('width:') == 1
    if style:
        assert 'padding:12px' in column['style']


def test_duplicate_attributes_have_source_locations(ws):
    text = '''---
title: Test
topic: test
theme: default
---
## One {#one}

😀

```text
::: {.column style="color:red" style="width:51%;"}
```

::: {.column style="color:red" style="width:51%;"}
Text
:::

## Two {#two}

::: {.column style="color:blue" style="width:51%;"}
Text
:::
'''
    add_deck(ws, 'talk', text)
    result = render.render_deck(ws, 'talk')
    issues = [x for x in check.static_issues(ws, 'talk', result) if x['kind'] == 'duplicate-attribute']
    assert len(issues) == 2
    assert [x['page'] for x in issues] == [0, 1]
    assert all(x['slide'] is not None for x in issues)
    for x in issues:
        tail = text.encode('utf-16-le')[x['source_offset'] * 2:].decode('utf-16-le')
        assert tail.startswith('style="width:51%;"')
        assert text.splitlines()[x['source_line'] - 1].startswith(':::')


def test_unknown_warning_remains_visible(ws):
    from slide_studio import source
    result = render.Rendered('', [], source.parse('## Test {#test}\n'), '', warnings=['Other warning'])
    assert render.warning_issues(result) == [dict(level='warning', kind='pandoc', message='Other warning')]
