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

## リリース手順

公開リリースは `.github/workflows/desktop-release.yml` と `scripts/electron-builder.config.cjs`（`SLIDE_STUDIO_RELEASE=1`）で行います。

1. リポジトリの Actions Secrets に署名・公証用の認証情報（`CSC_LINK`、`CSC_KEY_PASSWORD`、`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`）を設定する。
2. `package.json` と `package-lock.json` のバージョンを更新し、一致する `vX.Y.Z` タグを push する。
3. ワークフローが macOS（arm64／x64）と Windows（x64）の署名済みインストーラーおよび `electron-updater` メタデータ（`latest-mac.yml`、`latest.yml`）を GitHub の Draft Release に生成する。
4. アップグレード動作を確認したうえで Draft Release を公開する。
