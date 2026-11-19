# Slide Studio

Markdown（`.qmd`）をベースに、スライド作成・直接編集・発表・HTML／PDF書き出しまでをローカル環境で完結できるデスクトップアプリです。

## 特徴

- **`.qmd` を正本とした編集**：原稿編集とスライド上の直接編集が同期し、未編集の原文を壊さずに保存します。
- **単一 HTML／PDF 書き出し**：アニメーションを含むオフライン再生可能な単一 HTML と、各ステップの確定状態を収めた PDF を書き出せます。
- **発表者ビューと投影ウィンドウ**：現在・次のスライド、発表メモ、リハーサルの持ち時間・経過時間を確認しながら、別ウィンドウでスライドのみを投影できます（投影ウィンドウは `F` キーで全画面切替）。
- **ポータブルな保管フォルダ**：保管フォルダには原稿・図・テーマ・再ビルド用スクリプトをまとめて保存し、アプリなしでも再ビルドできます。
- **環境構築不要のアプリ版**：Pandoc と描画ランタイムを同梱しており、利用者が Node.js や Pandoc を別途インストールする必要はありません。

## アプリ版

- **macOS（Apple Silicon）**：`Slide-Studio-<version>-mac-arm64.dmg` を開き、`Slide Studio.app` を `Applications` にコピーします。
- **macOS（Intel）**：`Slide-Studio-<version>-mac-x64.dmg` を使用します。
- **Windows（x64）**：`Slide-Studio-<version>-win-x64-Setup.exe` を実行します。

## ソースから起動

Node.js 24.18.x と npm を使用します。

```sh
git clone https://github.com/edoaki/slide-studio.git
cd slide-studio
npm ci
npm start
```

初回起動時に Pandoc 3.9 を公式配布元から取得し、固定した SHA-256 と照合します。依存関係と Pandoc の取得後は、基本編集をローカルで行えます。

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
- **発表メモ**：スライド上部の開閉欄または発表者ビューで「このスライド」「全体」を切り替えて編集でき、`.qmd` 内の `.note` ブロックに自動保存されます。メモは投影や HTML／PDF 出力には含まれません。
- **リハーサル**：「リハーサル」で持ち時間を設定して計測を開始すると、残り時間と経過時間を表示します。進捗の分母は `##` のページ数で、初期設定では参考文献の手前までを数えます（最後まで・指定ページまでに変更可能）。

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

- 本体ライセンス：[PolyForm Noncommercial 1.0.0](LICENSE)（非商用利用向けライセンスであり、OSI 定義の OSS ではありません）
- 同梱 Pandoc のライセンスおよびソース参照：[NOTICE.md](NOTICE.md)
- 開発・テスト・コントリビュート方法：[CONTRIBUTING.md](CONTRIBUTING.md)
