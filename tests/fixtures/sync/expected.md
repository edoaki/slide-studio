# 同期の回帰用 qmd の期待結果

手順 1（分割と描画）と手順 3（書き戻しと直接編集）の正解です。`tests/test_source.py` がこの表を読みます。

- ページは qmd の順に 0 から数えます。`ID` が `-` のページは ID なしです。
- チャンクは `パス:種類` を空白で並べます。囲み（columns・column・box）の中身は `[ ]` の中に書きます。
- 種類：text・image・fig・columns・column・box・opaque・def（参照リンクと脚注の定義。スライドに対応する要素はない）
- 原文のみ：閉じていない `:::` があるページから最後まで。チャンクに分けません。
- 直接編集できない：text のうち、スライド上で文字を直接編集できないもの（別行立ての数式）。text 以外（image・fig・opaque・def と囲み）は、スライド上の文字の直接編集の対象外です。

| ファイル | ページ数 | ページ | ID | チャンク | 原文のみ | 直接編集できない |
|---|---|---|---|---|---|---|
| callout.qmd | 1 | 0 | a | 0:text 1:opaque 2:text | いいえ | |
| chapter.qmd | 4 | 0 | ch1 | | いいえ | |
| chapter.qmd | 4 | 1 | one | 0:text | いいえ | |
| chapter.qmd | 4 | 2 | ch2 | | いいえ | |
| chapter.qmd | 4 | 3 | two | 0:text | いいえ | |
| cite-multi.qmd | 1 | 0 | a | 0:text | いいえ | |
| code-heading.qmd | 2 | 0 | a | 0:text 1:text | いいえ | |
| code-heading.qmd | 2 | 1 | b | 0:text | いいえ | |
| data-step.qmd | 1 | 0 | a | 0:text 1:box[1.0:text] 2:text | いいえ | |
| duplicate-id.qmd | 2 | 0 | same | 0:text | いいえ | |
| duplicate-id.qmd | 2 | 1 | same | 0:text | いいえ | |
| fig-width.qmd | 1 | 0 | a | 0:fig 1:fig | いいえ | |
| footnote-def.qmd | 1 | 0 | a | 0:text 1:def 2:text | いいえ | |
| formatting.qmd | 1 | 0 | a | 0:text 1:text | いいえ | |
| letter-spacing.qmd | 1 | 0 | a | 0:text 1:text | いいえ | |
| link-def.qmd | 1 | 0 | a | 0:text 1:def 2:text | いいえ | |
| math-blank.qmd | 1 | 0 | a | 0:text 1:text 2:text | いいえ | 1 |
| math.qmd | 1 | 0 | a | 0:text 1:text 2:text | いいえ | 1 2 |
| mid-paragraph-hash.qmd | 1 | 0 | a | 0:text 1:text | いいえ | |
| nested-columns.qmd | 1 | 0 | a | 0:columns[0.0:column[0.0.0:text 0.0.1:text] 0.1:column[0.1.0:text 0.1.1:box[0.1.1.0:text 0.1.1.1:text]]] 1:text | いいえ | |
| no-id.qmd | 2 | 0 | - | 0:text | いいえ | |
| no-id.qmd | 2 | 1 | b | 0:text | いいえ | |
| raw-html.qmd | 1 | 0 | a | 0:opaque 1:text | いいえ | |
| two-footnotes.qmd | 1 | 0 | a | 0:text 1:def | いいえ | |
| unclosed-div.qmd | 3 | 0 | a | 0:text | いいえ | |
| unclosed-div.qmd | 3 | 1 | b | | はい | |
| unclosed-div.qmd | 3 | 2 | c | | はい | |
| unknown-attrs.qmd | 1 | 0 | a | 0:text | いいえ | |

## 直接編集の対象外

- math 1・2、math-blank 1：別行立ての数式。数式の編集画面で直す。
- 空白や書式の記法、参照リンクなどの往復変換による違いは、直接編集を制限する理由にしない。
