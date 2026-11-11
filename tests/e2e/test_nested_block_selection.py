"""枠と横並びが入れ子になったブロックの選択・追加。"""
import pytest
from playwright.sync_api import expect

from e2e.test_block_ops import setup, frame, click, selected, settled
from slide_studio import source


NESTED = '''---
topic: test
theme: default
---

## 入れ子

::::: {style="--block-design:plain"}
説明。

:::: {.columns}
::: {.column}
左。
:::
::: {.column}
右。
:::
::::
:::::
'''

NESTED_IN_COLUMN = NESTED.replace(
    '::::: {style="--block-design:plain"}',
    '::::::: {.columns}\n:::::: {.column}\n列の前置き。\n\n::::: {style="--block-design:plain"}',
    1,
) + '::::::\n:::::: {.column}\n隣の列。\n::::::\n:::::::\n'


@pytest.mark.parametrize('direction', ['W', 'S'])
@pytest.mark.parametrize('text, key', [(NESTED, 'p0/0'), (NESTED_IN_COLUMN, 'p0/0.0.1')])
def test_vertical_add_stays_inside_selected_frame(gui, page, direction, text, key):
    ws, _ = setup(gui, page, text)
    click(page, key + '.0')
    page.keyboard.press('KeyQ')
    selected(page, key)
    page.keyboard.press(f'Alt+Key{direction}')
    new = frame(page).locator('.slide-studio-new.slide-studio-editing')
    expect(new).to_have_count(1)
    assert new.evaluate("el => el.parentElement.dataset.slideStudio") == key
    page.keyboard.insert_text('追加。')
    page.keyboard.press('Escape')
    settled(page, ws, '追加。')
    text = ws.qmd('talk').read_text()
    chunks = source.parse(text).pages[0].chunks
    assert len(chunks) == 1
    box = next(c for chunk in chunks for c in chunk.walk() if c.path == key.split('/')[1])
    assert box.kind == 'box'
    child = box.children[0 if direction == 'W' else -1]
    assert text[child.start:child.end] == '追加。'
    assert sum(c.kind == 'columns' for c in box.children) == 1
    assert not page.errors
