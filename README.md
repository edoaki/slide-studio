# Slide Studio

従来のSlide Studioの画面を使う、TypeScript・Electron版です。ソース起動、ブラウザー起動、インストール版で同じ編集画面と保存処理を使います。Python・uvは必要ありません。従来版との全機能・全操作の照合は継続中です。確認済みの範囲と残作業は [検証記録](docs/migration/full-parity-progress.json) に記録しています。

## アプリ版

- macOS（Apple Silicon）：`Slide-Studio-0.1.0-mac-arm64.dmg` を開き、`Slide Studio.app` を Applications にコピーします。
- Windows（x64）：`Slide-Studio-0.1.0-win-x64-Setup.exe` を実行します。

インストーラーは下記のビルドコマンドで `release/` に生成します。従来画面を組み込んだDMGをこのMacにインストールし、発表作成、下書き保存、直接編集、プレビュー、HTML／PDF書き出しを確認しています。macOSはアドホック署名、Windowsは未署名です。Apple Developer ID・公証、Windows署名、正式Releaseでの配布は未対応です。Windowsでの実行確認とIntel Macの検証はまだ行っていません。

アプリにはPandocを同梱します。利用者によるNode.js・Python・uv・Pandocのインストールは不要です。

## ソースから起動

Node.js 24.18.xとnpmを使います。TS・Electron版のソースは、GitHubの `migration/electron` ブランチから取得できます。

```sh
git clone --branch migration/electron https://github.com/edoaki/slide-studio.git
cd slide-studio
npm install
npm start
```

初回起動時にPandoc 3.9を公式配布元からダウンロードし、固定したSHA-256と照合します。依存関係とPandocの取得にはネット接続が必要です。その後の基本編集はローカルで動作します。

ホーム画面の「新しい発表」から、タイトル、トピック、テーマを選んで作成します。原稿やスライド上の文字を編集すると保存され、上部の書き出しボタンからHTML／PDFを書き出せます。「保管フォルダ」で別の保存先に切り替えられます。

既存フォルダを指定する場合：

```sh
npm start -- --root /absolute/path/to/workspace
```

ソース版とインストール版で同じ保管フォルダを指定すれば原稿を共有できます。同じフォルダの書き込みは一つのホストが管理します。起動中のアプリへのCLI検査・相談は、保管フォルダ内の要求ファイルを介して実行します。

ブラウザーで同じ画面を開く場合：

```sh
npm run browser -- --root /absolute/path/to/workspace
```

描画・検査・PDF生成には同梱のElectronを使います。別のChromiumをダウンロードする必要はありません。

## インストーラーを作る

```sh
npm run dist:mac
npm run dist:win
```

`release/` にDMG／EXEと `SHA256SUMS` を生成します。OS別のPandocを自動で取得し、アプリに同梱します。これらのコマンドは公開やRelease作成を行いません。GitHub Actionsの `desktop-build` は手動実行用です。

## 検証とCLI

```sh
npm test
npm run typecheck
npm run test:desktop:e2e
npm run test:bridge:e2e
```

発表の作成、従来原稿の取り込み、検査、書き出しには次のCLIを使います。

```sh
npm run cli -- new intro --topic research --root /absolute/path/to/workspace
npm run cli -- import /absolute/path/to/slides --topic research --root /absolute/path/to/workspace
npm run cli -- check intro --root /absolute/path/to/workspace
npm run cli -- check --figure research/chart --root /absolute/path/to/workspace
npm run cli -- build intro --root /absolute/path/to/workspace
npm run cli -- --help
```

`build` はHTMLとPDFを書き出します。`--html-only` はHTMLだけを選び、`--force` は検査エラーがあっても書き出します。ただし、素材の欠落などで単一HTMLを作れない場合は停止します。AI用の `consult` と、画像・指摘の確認を記録する `audit` も同じCLIに含まれます。

描画サービス単体の検証には、素材を埋め込んだSlide Studio形式の単一HTMLを使います。ジョブJSONの入力・出力は絶対パス、出力先は未作成のディレクトリを指定します。

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
npm run render:spike -- --job /absolute/path/render-job.json
```

PDF、各stepのPNG、検査結果の `manifest.json` を保存します。

## 移行の状況とライセンス

PDFの旧版との差分検証と、既存テスト全件との照合は継続中です。AI連携、履歴・復元、直接編集、素材・参考資料・文献・テーマ管理は同じホストに接続しています。実AIの全プロバイダーでの疎通を、テスト用の応答による検証だけで合格にはしていません。従来のPython版は `../slide-studio-old` の `legacy/python` ブランチ（基準コミット `ca1f148`）に保存しています。

ソースは公開リポジトリで提供しますが、現行ライセンスはPolyForm Noncommercial 1.0.0で、OSI定義のOSSではありません。ライセンス変更は行っていません。同梱するPandocのライセンスとソース参照は [NOTICE.md](NOTICE.md) を参照してください。

- [開発ガイド](CONTRIBUTING.md)
- [移行計画](docs/electron-migration-plan.md)
- [検証結果と残作業](docs/migration/status.json)
