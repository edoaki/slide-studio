# Slide Studio

Electron版の開発用リポジトリです。現在は、単一HTMLからPDF・画像を書き出し、レイアウトを検査する描画試作を実装しています。編集画面、原稿の変換、AI連携、配布用アプリは移植中です。

この作業ツリーの開発・実行にPythonやuvは不要です。従来のPython版は `../slide-studio-old` の `legacy/python` ブランチ（基準コミット `ca1f148`）に保存しています。

## セットアップと検証

Nodeは `.nvmrc`、pnpmは `package.json` の指定バージョンを使います。

```sh
pnpm install --frozen-lockfile
pnpm test:renderer
```

macOSなどのPOSIX環境で、実際にElectronを起動する検証も実行できます。

```sh
SLIDE_STUDIO_RENDERER_E2E=1 pnpm test:renderer
```

## HTMLから書き出す

入力は必要な素材を埋め込んだSlide Studio形式の単一HTMLです。比較用の入力を `tests/fixtures/render/nco-intro.html` に同梱しています。新しいHTMLの生成には現在も旧版を使います。同梱HTMLも旧版で生成した固定fixtureです。

次の形式でジョブJSONを用意します。入力と出力先は絶対パス、出力先はまだ存在しないディレクトリを指定してください。

```json
{
  "schemaVersion": 1,
  "inputHtml": "/absolute/path/slide-studio/tests/fixtures/render/nco-intro.html",
  "outputDir": "/absolute/path/new-output",
  "timeoutMs": 60000,
  "screenshots": true
}
```

```sh
pnpm render:spike --job /absolute/path/render-job.json
```

成功するとPDF、各出力stepの1280×720のPNG、レイアウト検査結果を含む `manifest.json` を保存します。ランチャーは一時プロファイルを作り、Electron終了後に削除します。

## 移行の状況

Macで20ページの出力を確認しています。Python基準とのPDF抽出文字の差は未解決で、品質合格は保留です。Windows・Intel Mac・署名付き配布は未検証です。

- [開発ガイド](CONTRIBUTING.md)
- [移行計画](docs/electron-migration-plan.md)
- [検証結果と残作業](docs/migration/status.json)

旧版の利用方法は `../slide-studio-old/README.md` を参照してください。
