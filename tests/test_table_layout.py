from pathlib import Path

import pytest

from conftest import shared_browser
from slide_studio.render import LUA, run_pandoc
from slide_studio.workspace import RUNTIME, TEMPLATES


@pytest.mark.parametrize('theme', ['default', 'graphite', 'terracotta',
                                 'solarized', 'night', 'mist'])
def test_tables_use_content_width_and_readable_text(theme):
    markdown = '''| 項目 | 値 |
|---|---:|
| 件数 | 100 |

| 方式 | 成功率 | 再試行からの成功 | 平均時間 | 失敗問題での平均時間 | 平均費用（基準との比） |
|---|--:|--:|--:|--:|--:|
| 標準 K=256 | 100.0%（256問） | 33/36 | 0.188 s | 0.238 s | +6.0% |
'''
    tables, _ = run_pandoc(markdown, Path.cwd(), ['--lua-filter', str(LUA)])
    assert '<colgroup>' not in tables
    css = (RUNTIME / 'base.css').read_text()
    css += (TEMPLATES / 'themes' / f'{theme}.css').read_text()
    page = shared_browser().new_page(viewport={'width': 1280, 'height': 720})
    try:
        page.set_content(f'<style>{css}</style><div class="reveal">'
                         '<main id="stage" class="slides"><section class="slide active">'
                         f'<h2>表の配置</h2>{tables}</section></main></div>')
        sizes = page.evaluate('''() => [...document.querySelectorAll('table')].map(t => {
            const s = t.parentElement, cs = getComputedStyle(s);
            return {width:t.offsetWidth, font:parseFloat(getComputedStyle(t).fontSize),
                padding:parseFloat(getComputedStyle(t.querySelector('td')).paddingLeft),
                right:t.getBoundingClientRect().right,
                limit:s.getBoundingClientRect().right - parseFloat(cs.paddingRight)};
        })''')
        assert sizes[0]['width'] < 300, sizes
        for size in sizes:
            assert size['font'] >= 24, size
            assert size['padding'] <= 8, size
            assert size['right'] <= size['limit'] + 1, size
    finally:
        page.close()


def test_explicit_unequal_column_widths_are_preserved():
    markdown = '| Long heading for the first column | Second heading |\n|----------|---|\n| ' + 'value ' * 20 + '| 1 |\n'
    tables, _ = run_pandoc(markdown, Path.cwd(), ['--lua-filter', str(LUA)])
    assert '<colgroup>' in tables


def test_table_style_wrapper_sets_size_weight_and_exact_column_widths():
    markdown = '''::: {style="--table-size:22px;--table-weight:700;--table-cols:120 300"}

| 見出し | 値 |
|:---|---:|
| 長い本文 | 1 |

:::
'''
    html, _ = run_pandoc(markdown, Path.cwd(), ['--lua-filter', str(LUA)])
    assert 'font-size:22px' in html and 'width:420px;table-layout:fixed' in html
    assert '<colgroup>' not in html
    assert html.count('font-weight: 700') == 4
    head = html[html.index('<thead>'):html.index('</thead>')]
    assert 'width: 120px' in head and 'width: 300px' in head and 'text-align: right' in head


def test_table_style_ignores_values_that_do_not_fit():
    markdown = '''::: {style="--table-size:1;--table-weight:x;--table-cols:120 300 400"}

| 見出し | 値 |
|---|---|
| 本文 | 1 |

:::
'''
    html, _ = run_pandoc(markdown, Path.cwd(), ['--lua-filter', str(LUA)])
    assert '<table>' in html and 'font-weight' not in html


def test_nested_table_settings_prefer_the_nearest_wrapper():
    markdown = ''':::: {style="--table-cols:200 400;--table-size:30px;--table-weight:700"}
::: {style="--table-cols:350 250;--table-size:27px"}
| Left | Right |
|---|---|
| Value | Text |
:::

Another paragraph.
::::
'''
    html, _ = run_pandoc(markdown, Path.cwd(), ['--lua-filter', str(LUA)])
    head = html[html.index('<thead>'):html.index('</thead>')].replace(': ', ':')
    assert 'width:350px' in head and 'width:250px' in head
    assert 'width:200px' not in head and 'width:400px' not in head
    assert 'font-size:27px' in html and 'font-size:30px' not in html
    assert html.replace(': ', ':').count('font-weight:700') == 4
