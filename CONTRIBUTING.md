# 開発ガイド

この作業ツリーはElectron専用です。利用方法と描画ジョブの指定は [README.md](README.md) を参照してください。

## 開発環境

Nodeは `.nvmrc`、pnpmは `package.json` の指定バージョンを使います。npmコマンドは使いません。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:renderer
```

`pnpm build:renderer` はTypeScriptをコンパイルし、描画に必要な資産を `dist/` にコピーします。Python・uv・旧版の作業ツリーは必要ありません。

## コードの配置

| 対象 | 場所 |
|---|---|
| 描画ジョブと結果の型 | `packages/renderer/src/contracts.ts` |
| Electronの起動と終了 | `packages/renderer/src/cli.ts` |
| 検査・画像・PDF | `packages/renderer/src/render.ts` |
| レイアウト検査用JS | `packages/renderer/assets/layout-check.js` |
| 通信制限 | `packages/renderer/src/protocol.ts` |
| 出力先の保護・atomic write | `packages/renderer/src/output.ts` |
| 一時プロファイルを管理するランチャー | `scripts/migration/render-spike.mjs` |
| ビルド資産のコピー | `scripts/build-renderer.mjs` |
| 単体・実機テスト | `tests/renderer/` |
| 比較用の原稿・図・単一HTML | `tests/fixtures/` |

## 検証

変更に関係するテストから実行します。実機テストはPOSIX環境で有効にできます。

```sh
SLIDE_STUDIO_RENDERER_E2E=1 pnpm test:renderer
```

既存出力の保護、タイムアウト、キャンセル、外部通信の拒否、一時領域の後片付けを検証します。通常のテストで実AIは呼びません。

描画の確認には `tests/fixtures/render/nco-intro.html` を使います。生成元とハッシュは同じディレクトリの `manifest.json` に記録しています。PDFの抽出文字に残る差を、見た目の一致だけで合格にしないでください。

## 変更するときの約束

- 正本は `.qmd`。未編集の原文を勝手に正規化しない。
- GUIは素のJavaScript（ES module）を維持する。UI文言は日本語で、UI移植時に `packages/web/strings.js` へ集約する。
- UIの説明は端的にし、仕組みの説明は利用案内に書く。
- ファイルの書き込みは一時ファイルからrenameする。描画処理では `atomicWriteFile` を使う。
- 雛形のコピー、参照の書き換え、検査はコードで行う。
- 見た目に関わる変更は利用者の確認前に「確認待ち」とする。
- 実装担当・レビュー担当の運用は [移行計画](docs/electron-migration-plan.md) に従う。

## Python版との比較

旧実装と旧テストは `../slide-studio-old` の `legacy/python` ブランチを参照します。旧版に移行ブランチをマージしないでください。新旧の実行環境とテスト用データは分けます。

`docs/migration/feature-map.json` と `contracts.json` の旧コード参照は、記録された基準コミットに対するパスです。新しい作業ツリーに旧コードが存在することを意味しません。

基準計測用のPythonスクリプトはGit履歴に保存しています。再計測が必要な場合は整理前のコミット `5075930` を別の比較用worktreeに展開し、その環境で `scripts/migration/baseline.py` を実行します。同じコミットに隔離CLIハーネスとテストも含まれます。既存の基準計測結果の生成元は `7c59623` です。Python環境を新しい `slide-studio` に再作成しないでください。

`slide-studio-old/.git` は各worktreeの共有Git管理情報を保持しています。旧版ディレクトリ全体を削除する場合は、先にGit管理情報の配置を整理する必要があります。
