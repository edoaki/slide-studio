# Slide Studio

従来のSlide Studioを、見た目・全機能・操作を保ったままElectronへ移植しています。現在は移植作業中で、従来版の代替として使える状態には達していません。途中で作成した簡易画面は採用せず、旧版の画面資産を引き継ぐ構成に修正しています。新しい作業ツリーにはPython・uvを必要としません。

## アプリ版

- macOS（Apple Silicon）：`Slide-Studio-0.1.0-mac-arm64.dmg` を開き、`Slide Studio.app` を Applications にコピーします。
- Windows（x64）：`Slide-Studio-0.1.0-win-x64-Setup.exe` を実行します。

インストーラーは下記のビルドコマンドで `release/` に生成します。現時点の生成物は簡易画面を含む途中の検証用で、完成版ではありません。macOSはアドホック署名、Windowsは未署名です。Apple Developer ID・公証、Windows署名、正式Releaseでの配布は未対応です。Windowsでの実行確認とIntel Macの検証はまだ行っていません。

アプリにはPandocを同梱します。利用者によるNode.js・Python・uv・Pandocのインストールは不要です。

## ソースから起動

Node.js 24.18.xとnpmを使います。移行中のコードは `migration/electron` ブランチにあります。

```sh
git clone --branch migration/electron https://github.com/edoaki/slide-studio.git
cd slide-studio
npm install
npm start
```

初回起動時にPandoc 3.9を公式配布元からダウンロードし、固定したSHA-256と照合します。依存関係とPandocの取得にはネット接続が必要です。その後の基本編集はローカルで動作します。

起動後はサンプルを開くか、タイトルを入力して新しい発表を作成します。原稿を編集して保存し、HTML／PDFボタンから書き出せます。「保管フォルダ」で別の保存先に切り替えられます。

既存フォルダを指定する場合：

```sh
npm start -- --root /absolute/path/to/workspace
```

現在のソース版と検証用アプリは同じ試作の編集処理を使います。従来版との同等性は未達です。既定の保存先は別で、macOSではそれぞれ `~/Library/Application Support/Slide Studio Dev` と `~/Library/Application Support/Slide Studio` の下に作成します。同じ保管フォルダを指定すれば原稿を共有できますが、同時に開くことはできません。

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
```

描画用CLIは、素材を埋め込んだSlide Studio形式の単一HTMLを入力に取ります。ジョブJSONの入力・出力は絶対パス、出力先は未作成のディレクトリを指定します。

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

PDF、各stepのPNG、検査結果の `manifest.json` を保存します。旧版のCLIコマンドすべてが使える状態ではありません。

## 移行の状況とライセンス

PDFの旧版との差分検証は継続中です。AI連携、履歴・復元、旧版の直接編集UIなども今回の完了条件に含めて移植を進めています。従来のPython版は `../slide-studio-old` の `legacy/python` ブランチ（基準コミット `ca1f148`）に保存しています。

ソースは公開リポジトリで提供しますが、現行ライセンスはPolyForm Noncommercial 1.0.0で、OSI定義のOSSではありません。ライセンス変更は行っていません。同梱するPandocのライセンスとソース参照は [NOTICE.md](NOTICE.md) を参照してください。

- [開発ガイド](CONTRIBUTING.md)
- [移行計画](docs/electron-migration-plan.md)
- [検証結果と残作業](docs/migration/status.json)
