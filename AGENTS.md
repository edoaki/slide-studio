# AGENTS.md（Slide Studio の開発用）

この文書は開発作業時のルールと索引です。

検証は変更に関係する最小範囲で行い、成功済みの検証を理由なく繰り返さない。画面を表示する操作テスト（`test:desktop:e2e:headed`、`update:app -- --e2e`、E2E ファイルの直接実行など）は、利用者が明示的に依頼した場合に限る。通常の UI 検証にはヘッドレスの `test:desktop:e2e` を使う。

このリポジトリを編集したら、関連する検証を終えた後、`npm run update:app` を実行して利用者のインストール済みアプリまで更新する。更新・再起動が成功したことを確認してから完了を報告する。失敗した場合は原因と未反映であることを報告する。詳細は [CONTRIBUTING.md](CONTRIBUTING.md) の「編集後のアプリ更新（macOS）」を参照。

- 利用方法：[README.md](README.md)
- 開発環境・構成・検証・規約：[CONTRIBUTING.md](CONTRIBUTING.md)
- コード：`apps/`、`packages/`、`scripts/`
- テスト：`tests/`（`npm test`）
