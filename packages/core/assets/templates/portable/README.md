# スライドの保管フォルダ

原稿・図・テーマと再ビルド用のコードを含むフォルダです。共有するときは、隠しフォルダ `.slide-studio/` と `build.mjs` も含めてコピーしてください。

- `decks/<発表名>/slides.qmd`：原稿。
- `decks/<発表名>/styles/`：発表のスタイル。
- `topics/<トピック>/`：共有する図・画像・文献。
- `themes/`：テーマ。
- `.slide-studio/compiler/`：Node/Electron版の変換コード。
- `.slide-studio/runtime/`：図が読み込む共通コード。

## アプリなしで書き出す

Node.js 24.18以降の24系とnpmを用意し、このフォルダで実行します。初回の準備にはネットワークが必要です。Slide Studioのアプリやリポジトリは不要です。

```sh
node build.mjs --setup
node build.mjs --list
node build.mjs 発表名 --html-only
node build.mjs 発表名
```

`--setup` は依存パッケージ、Electron、Pandocをこのフォルダ内に準備します。別のOSへ移した場合も、移動先で実行してください。準備後は、外部素材を含まない原稿をオフラインでビルドできます。

`--html-only` は検査を省略して単一HTMLを書き出します。指定しない場合は検査後にHTMLとPDFを書き出します。検査の問題を承知して続行する場合は `--force` を指定します。出力先は各発表のフォルダで、ファイル名には発表のタイトルを使います。HTMLはアプリなしで開けます。

アプリからも編集・書き出しができます。ソース版からは、そのリポジトリで `npm run cli -- build <発表名> --root <このフォルダの絶対パス>` を実行できます。
