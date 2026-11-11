from slide_studio import check, source
from slide_studio.page_templates import PLACEHOLDERS, placeholder_blocks
from slide_studio.render import Rendered
from conftest import add_deck


def test_placeholder_words_and_nested_blocks():
    p = PLACEHOLDERS
    doc = source.parse(f'''## {{#page-1}}

{p['body']}

:::: {{.columns}}
::: {{.column}}
{p['image']}
:::
::: {{.column}}
**{p['subhead']}**

- 書き換えた項目
- {p['item']}
:::
::::

| A | B | C |
| --- | --- | --- |
| 完成 | {p['cell']} | 完成 |

### {p['subhead']}
''')
    blocks = list(placeholder_blocks(doc))
    assert len(blocks) == 6
    assert all(page.index == 0 for page, _ in blocks)


def test_finished_prose_and_code_are_not_placeholders():
    doc = source.parse('''## 本文 {#page-1}

本文についての説明。項目を追加する。図・画像を使う。

```text
本文
項目
```

$$
本文
$$

    本文

![図・画像](a.png)
''')
    assert not list(placeholder_blocks(doc))


def test_static_check_reports_placeholder_location(ws):
    text = '''---
title: テスト
topic: test
theme: default
---

## {#page-1}

本文

## 完成 {#page-2}

書き換え済み。
'''
    add_deck(ws, 'templates', text)
    rendered = Rendered('', [], source.parse(text), 'version')
    issues = [x for x in check.static_issues(ws, 'templates', rendered) if x['kind'] == 'placeholder']
    assert len(issues) == 1
    assert issues[0]['level'] == 'warning'
    assert issues[0]['page'] == 0
    assert issues[0]['block'] == 'p0/0'
    rendered.doc = source.parse(text.replace('\n本文\n', '\n完成した文章。\n'))
    assert not [x for x in check.static_issues(ws, 'templates', rendered) if x['kind'] == 'placeholder']
