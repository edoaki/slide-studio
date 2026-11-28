# 開発ガイド

Slide Studio（TypeScript・Electron）の開発環境、構成、検証、ローカルアプリ更新の手順をまとめています。利用方法は [README.md](README.md) を参照してください。

## 開発環境

Node.js 24.18.x と `package.json` 指定の npm を使用します。

```sh
npm ci
npm run typecheck
npm test
```

`npm run build` は TypeScript をコンパイルし、編集画面・描画・ポータブル実行に必要な資産を `dist/` に生成します。

## コードの配置

| 対象 | 場所 |
|---|---|
| デスクトップ起動・ネイティブダイアログ・自動更新 | `apps/desktop/` |
| ローカル HTTP／SSE サーバー | `apps/server/` |
| CLI | `apps/cli/`、`scripts/cli.mjs` |
| ポータブル保管フォルダ用ビルド | `apps/portable/`、`scripts/portable-launcher.mjs` |
| 原稿・保存・Pandoc 変換・ワークスペース管理 | `packages/core/` |
| 描画エンジン（PDF・レイアウト検査・画像出力） | `packages/renderer/` |
| AI 連携・実行管理・ログイン | `packages/ai/` |
| 編集画面（素の ES module JS／CSS） | `packages/web/` |
| 共通型・契約 | `packages/contracts/` |
| ビルド・パッケージング・ローカル更新スクリプト | `scripts/` |
| 単体・統合・ブリッジ・E2E テスト | `tests/` |

## 検証

```sh
npm run typecheck
npm test
npm run test:desktop:e2e
npm run test:bridge:e2e
```

- 変更に関係するテストから実行します。ビルド済みなら `node --test dist/tests/<対象>.test.js` で最小範囲を検証できます。
- `npm run test:desktop:e2e` はヘッドレス Chrome を使ったブラウザー版 E2E テストを実行します。
- 画面を表示するデスクトップ操作テスト（`npm run test:desktop:e2e:headed` や E2E ファイルの直接実行）はウィンドウを前面に出すため、明示的な指示がある場合のみ実行してください。
- 描画ランタイムの実機テスト（POSIX）：
  ```sh
  SLIDE_STUDIO_RENDERER_E2E=1 npm run test:renderer
  ```
- インストール済みアプリに対する E2E 検証：
  ```sh
  SLIDE_STUDIO_TEST_APP="$HOME/Applications/Slide Studio.app" node --test dist/tests/e2e/workflow.test.js dist/tests/e2e/desktop.test.js
  ```
- テストはすべて一時フォルダに原稿とプロファイルを作成し、通常の保管フォルダや設定を変更しません。通常のテストで実 AI への推論リクエストは送信しません。

## 編集後のアプリ更新（macOS）

編集と関連する検証を終えたら、次のコマンドでインストール済みのローカルアプリを更新します。

```sh
npm run update:app
```

現在の作業ツリーをビルド・署名検証し、起動中のアプリを通常終了してから安全に置き換え、バックグラウンドで起動確認を行います（未コミットの変更も反映されます）。更新先が複数ある場合は `--app "/absolute/path/Slide Studio.app"` で指定します。依存関係を変更した場合は `--install-deps` を付けるか、先に `npm ci` を実行してください。

## 変更時の約束

- **正本は `.qmd`**：未編集の原文を勝手に正規化しない。
- **フロントエンド構成**：GUI は素の JavaScript（ES module）を維持し、UI 文言（日本語）は `packages/web/strings.js` に集約する。
- **安全な書き込み**：ファイル書き込みは一時ファイルからの atomic rename を使う（描画処理では `atomicWriteFile`）。
- **UI テキスト**：画面上の説明は端的に保ち、仕組みの説明はドキュメントに書く。
- **選択欄**：OS 標準の `<select>` は使わず、`packages/web/custom-select.js` の `<studio-select>` を使う（`tests/desktop/no-native-select.test.ts` で検査）。

## リリース手順

1. `package.json` と `package-lock.json` のバージョンをそろえ、検証済みのコミットに `vX.Y.Z` タグを付けて push します。
2. [リリースワークフロー](.github/workflows/desktop-release.yml) が macOS（Apple Silicon／Intel）と Windows（x64）のインストーラーをビルドします。各ファイルの SHA-256 を検証してから、3 つの配布物と `SHA256SUMS` を GitHub Releases の下書きにまとめます。
3. リリース本文に変更内容とインストール手順を記載し、下書きを公開します。
4. [公開サイトのリポジトリ](https://github.com/edoaki/slide-studio-web)で、ダウンロードリンクを公開したタグのファイルに合わせます。公開サイトから各ファイルを取得できることを確認してください。
