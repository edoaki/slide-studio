# Slide Studio

Markdown（`.qmd`）をベースに、スライド作成・直接編集・発表・HTML／PDF書き出しまでをローカル環境で完結できるデスクトップアプリです。

[アプリをダウンロード](https://edoaki.github.io/slide-studio-web/#app-start) · [ソースから起動](#ソースから起動) · [スライドの実例](https://edoaki.github.io/slide-studio-web/#slides)

## 特徴

- **`.qmd` を正本とした編集**：原稿編集とスライド上の直接編集が同期し、未編集の原文を壊さずに保存します。
- **単一 HTML／PDF 書き出し**：アニメーションを含むオフライン再生可能な単一 HTML と、各ステップの確定状態を収めた PDF を書き出せます。
- **発表者ビューと投影ウィンドウ**：現在・次のスライド、発表メモ、持ち時間・経過時間を確認しながら、別ウィンドウでスライドのみを投影できます（投影ウィンドウは `F` キーで全画面切替）。外部ディスプレイがあれば、投影ウィンドウはそのディスプレイに全画面で開きます。発表者ビューの現在のスライド上のカーソルは、投影画面にポインターとして表示されます（見出しのポインターのボタンを押すと ON/OFF を切り替え、カーソルを合わせると下に出る設定で形・色・大きさを変更）。
- **ポータブルな保管フォルダ**：保管フォルダには原稿・図・テーマ・再ビルド用スクリプトをまとめて保存し、アプリなしでも再ビルドできます。
- **環境構築不要のアプリ版**：Pandoc と描画ランタイムを同梱しており、利用者が Node.js や Pandoc を別途インストールする必要はありません。

## アプリ版

[ダウンロードページ](https://edoaki.github.io/slide-studio-web/#app-start)で、お使いのパソコンに合うファイルを選んでください。Mac の種類は Apple メニューの「この Mac について」で確認できます。

- **macOS（Apple Silicon）**：`Slide-Studio-<version>-mac-arm64.dmg` を開き、`Slide Studio.app` を `Applications` にコピーします。
- **macOS（Intel）**：`Slide-Studio-<version>-mac-x64.dmg` を使用します。
- **Windows（x64）**：`Slide-Studio-<version>-win-x64-Setup.exe` を実行します。

更新は手動で行います。アプリは起動時と4時間ごとに公開版を確認し、新しいバージョンがあれば設定ボタンに通知します。設定の「ダウンロードページを開く」から [GitHub Releases](https://github.com/edoaki/slide-studio/releases) を開き、自分の OS・CPU に合うファイルを取得してください。アプリを終了してから、macOS ではアプリを入れ替え、Windows では新版のインストーラーを実行します。保管フォルダの原稿や設定を削除する必要はありません。

配布版には Apple の Developer ID 署名・公証や Windows の配布用署名を付けていないため、OS が起動時に警告を表示する場合があります。

## ソースから起動

対応環境は macOS（Apple Silicon／Intel）と Windows（x64）です。Git と Node.js 24 系（24.18.0 以降）を用意し、ターミナルで次のコマンドを実行してください。

```sh
git clone https://github.com/edoaki/slide-studio.git
cd slide-studio
npm ci
npm start
```

初回はインターネット接続が必要です。起動時に Electron と Pandoc 3.9 を取得し、Pandoc のアーカイブを固定の SHA-256 と照合します。依存関係と Pandoc の取得後は、基本編集をローカルで行えます。

既存の保管フォルダを指定する場合：

```sh
npm start -- --root /absolute/path/to/workspace
```

ブラウザーで同じ編集画面を開く場合：

```sh
npm run browser -- --root /absolute/path/to/workspace
```

## 基本的な使い方

- **発表の作成と編集**：ホーム画面の「新しい発表」からタイトル・トピック・テーマを選んで作成します。原稿やスライド上の文字を編集すると自動保存され、上部の書き出しボタンから HTML／PDF を書き出せます。「保管フォルダ」から別の保存先へ切り替えられます。
- **発表メモ**：スライド上部の開閉欄ではページのメモと全体のメモを切り替えて、発表者ビューでは上下に並べて編集でき、`.qmd` 内の `.note` ブロックに自動保存されます。メモは投影や HTML／PDF 出力には含まれません。スライドが完成したら、スライドのチャットで発表全体を対象に `/発表原稿` と送ると、空欄のページの発表メモに原稿が入ります。持ち時間や口調は `/発表原稿` の後に書き添えます。個別に直すときは、スライドのチャットで対象ページを選びます。
- **持ち時間と進捗**：発表者ビューの上部の時間表示を押すと持ち時間（分）を入力でき、計測を開始すると残り時間と経過時間を表示します。進捗の分母は `##` のページ数で、初期設定では参考文献までを数えます。「進捗 ◯ / ◯」を押すと、数えるページ数を数字で入力するか、ページの一覧から数え終わりのページを選べます（章扉と参考文献は数えません）。

## CLI

発表の作成、既存原稿の取り込み、検査、書き出しをコマンドラインからも実行できます。

```sh
npm run cli -- new intro --topic research --root /absolute/path/to/workspace
npm run cli -- import /absolute/path/to/slides --topic research --root /absolute/path/to/workspace
npm run cli -- check intro --root /absolute/path/to/workspace
npm run cli -- check --figure research/chart --root /absolute/path/to/workspace
npm run cli -- build intro --root /absolute/path/to/workspace
npm run cli -- --help
```

- `build` は HTML と PDF を書き出します。`--html-only` で HTML のみ出力、`--force` で検査警告があっても書き出します。
- 保管フォルダ内では、アプリを使わずに Node.js から直接再ビルドすることもできます（初回のみ `--setup` にネット接続が必要）。

```sh
node build.mjs --setup
node build.mjs --list
node build.mjs <発表名>
```

## インストーラーのビルド

```sh
npm run dist:mac
node scripts/package-desktop.mjs --mac --arch x64
npm run dist:win
```

OS 別の Pandoc を自動で取得・同梱し、`release/` に DMG／EXE と `SHA256SUMS` を生成します。

## ライセンス

- 本体ライセンス：[PolyForm Noncommercial 1.0.0](LICENSE)。本体のソースコードと配布アプリは非商用目的で利用できます。変更・再配布の条件はライセンス本文をご確認ください。
- 同梱 Pandoc のライセンスおよびソース参照：[NOTICE.md](NOTICE.md)
- 開発・テスト・コントリビュート方法：[CONTRIBUTING.md](CONTRIBUTING.md)
