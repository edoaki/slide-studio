# スライドの保管フォルダ

このフォルダは、Slide Studio アプリなしでも編集・再ビルドできます。フォルダ名と置き場所は自由です。共有する際は、隠しフォルダ `.slide-studio/` も含めてフォルダ全体をコピーしてください。

- `decks/<発表名>/slides.qmd`：原稿。テキストエディタで編集できます。
- `decks/<発表名>/styles/`：発表のスタイル。
- `topics/<トピック>/`：共有する `html/`・`images/`・`reference.bib`。`themes/`：テーマ。
- `.slide-studio/compiler/`：このフォルダ用に同梱した変換コード・Lua・スタイル・ランタイム。
- `.slide-studio/runtime/`：図が相対パスで読み込む共通コード。

## コンパイル

Python 3.13 以上と `uv` を用意し、ターミナルでこのフォルダに移動して実行します。初回は依存パッケージの取得にネットワークが必要です。Slide Studio のリポジトリ・インストールは不要です。

```sh
uv run build.py --list
uv run build.py 発表名 --html-only
```

検査して HTML と PDF を生成するには、初回に Chromium を準備します。

```sh
uv run build.py --setup
uv run build.py 発表名
```

出力は `decks/<発表名>/<発表名>.html` と `.pdf`。HTML はアニメーションを含む単一ファイルで、アプリなし・オフラインでブラウザで開けます。`--html-only` は検査を省略します。PDF は各ページの各 step の動きが終わった状態を1枚ずつ出力します。アニメーションの途中のフレームは含めません。

依存パッケージと Chromium の準備後は、外部素材を含まない原稿をオフラインでビルドできます。QMD の図参照などは同梱の変換コードが処理するため、Pandoc 単体での実行では同じ結果になりません。
