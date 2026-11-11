# AGENTS.md（Slide Studio の開発用）

この文書は索引です。中身は書かず、どこを読めばよいかだけを示します。

- 利用方法：[README.md](README.md)。開発環境・検証：[CONTRIBUTING.md](CONTRIBUTING.md)
- コード：`slide_studio/`（モジュールの役割は CONTRIBUTING.md）。テストは `tests/`（`uv run pytest`）

## コマンド

```sh
uv sync                      # 依存
uv run slide-studio doctor             # 環境の確認
uv run pytest tests/test_x.py -q  # テスト。普段は変えたところに関係するものだけ（全体は並べて4〜5分。CONTRIBUTING.md）
SLIDE_STUDIO_HOME=$(mktemp -d) uv run slide-studio import tests/fixtures/nco-intro --topic nco
```

## 規約（要点）

- UI の文言は日本語で、`slide_studio/web/strings.js` の1か所にまとめる。
- UI の説明（ツールチップ・ラベル・案内）は端的に。名詞句＋要点1つ程度にし、仕組みの説明は書かない（例：「会話モード（ファイル編集なし）」）。
- ファイルの書き込みは `slide_studio.fsutil.write_atomic`（一時ファイル → rename）。
- 決まった作業（雛形のコピー、参照の書き換え、検査）はコードで行い、AI には中身だけを考えさせる。
- npm は使わない。GUI は素の JavaScript（ES module）。
