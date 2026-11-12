# 開発ガイド

利用方法は [README](README.md) を参照してください。

## 開発環境

リポジトリのルートで実行します。

```sh
uv sync --locked
uv run playwright install chromium
uv run slide-studio doctor
```

Python 3.13 以上を使います。GUI は素の JavaScript（ES module）で、フロントエンドの npm インストールやビルドは不要です。

手元の発表を変更しないよう、開発用のデータは `SLIDE_STUDIO_HOME` または `--root` で分けてください。利用者向けの操作はホームに集約します。以下のCLIは開発・AI連携・自動化用です。

## 開発・自動化用CLI

### Electron移行の描画試作

移行計画は [docs/electron-migration-plan.md](docs/electron-migration-plan.md)、検証結果と残作業は [docs/migration/status.json](docs/migration/status.json) に記録します。現時点ではMac向けのバッチ描画試作です。編集画面や正式配布への切り替えはまだ行っていません。

Nodeは `.nvmrc`、pnpmは `package.json` の版を使います。npmコマンドは使いません。

```sh
pnpm install --frozen-lockfile
pnpm test:renderer
SLIDE_STUDIO_RENDERER_E2E=1 pnpm test:renderer
pnpm render:spike --job /absolute/path/render-job.json
```

ジョブは次のJSON形式です。入力はPython版が生成した単一HTML、出力先はまだ存在しないディレクトリを絶対パスで指定します。

```json
{
  "schemaVersion": 1,
  "inputHtml": "/absolute/path/deck.html",
  "outputDir": "/absolute/path/new-render-output",
  "timeoutMs": 60000,
  "screenshots": true
}
```

成功するとPDF、各出力stepのPNG、検査結果を含む `manifest.json` を保存します。ランチャーは一時プロファイルを作り、Electron終了後に削除します。外部参照のないHTMLを使ってください。`SLIDE_STUDIO_RENDERER_E2E=1` は、POSIX環境で実際にElectronを起動して失敗時の保護・後片付けを検証します。Windows・Intel Mac・署名付き配布の検証は未実施です。

### Python版のCLI

利用者向けの起動は `uv run slide-studio` のみ。以下は検証やAIから呼ぶために残しています。

```sh
uv run slide-studio doctor
uv run slide-studio new my-talk --topic research
uv run slide-studio import tests/fixtures/nco-intro --topic nco
uv run slide-studio open nco-intro
uv run slide-studio check my-talk
uv run slide-studio build my-talk
uv run slide-studio fig new example --shelf research
```

保存場所の優先順位は `--root` → `SLIDE_STUDIO_HOME` → `~/.config/slide-studio/location.json` の選択済みフォルダ → `~/Slides`。GUI は未選択・選択済みフォルダの消失時に初回画面を開きます。`Slides` は候補名で、任意の名前・場所を選べます。開発・自動化用 CLI のみ、未選択時も候補の場所を使います。内部状態は `.slide-studio/`、HTML の属性は `data-slide-studio`、文献の確認状態は `slide-studio-status` を使います。

Codex は `SLIDE_STUDIO_CODEX` → 専用保存先の取得済み実行ファイル → PATH の `codex` を使い、`app-server --listen stdio://` で JSON-RPC 接続します。アカウント確認・モデル一覧・ログイン・会話の実行は App Server 経由です。テストは `tests/fixtures/fake_codex.py`（指示の中の `replace A => B`・`add`・`delete`・`sleep`・`fail` を実行する偽物）を指定し、実際の Codex を呼びません。

Pandoc は `SLIDE_STUDIO_PANDOC`→ `pypandoc_binary` 同梱版 → PATH → 旧 Quarto 同梱版の順で探索します。通常は同梱版を使い、Quarto は不要です。`doctor` は将来のAI連携用にCodexも確認するため、Codex未導入でも終了コード1になります。GUIの環境表示は現在必要なPandoc・Chromiumだけです。

Pandoc はアプリ起動時に描画用の常駐プロセスを準備し、HTML → Markdown の逆変換用は必要に応じて最大4プロセスを再利用します。通信は標準入出力だけで、追加のHTTPポートは開きません。終了時に子プロセスを停止します。非対応版や通信失敗時は単発起動にフォールバックします。比較・切り分け時は `SLIDE_STUDIO_PANDOC_MODE=process uv run slide-studio` で常駐化を無効にできます。

## コードの入口

| 対象 | 主なファイル |
|---|---|
| CLI・保存場所 | `slide_studio/cli.py`、`slide_studio/workspace.py`、`slide_studio/location.py`（初回画面） |
| 単独ビルドの同梱 | `slide_studio/portable.py`、`slide_studio/templates/portable/` |
| 原稿の解析と部分的な書き戻し | `slide_studio/source.py` |
| Pandoc による描画 | `slide_studio/render.py`、`slide_studio/lua/slide-studio.lua` |
| Pandoc の常駐・通信 | `slide_studio/pandoc_worker.py`、`slide_studio/lua/worker.lua` |
| 直接編集の往復判定・HTML → Markdown | `slide_studio/edit.py` |
| HTTP・SSE・ファイル監視 | `slide_studio/server.py` |
| 編集画面・原稿エディタ | `slide_studio/web/editor.js`、`slide_studio/web/qmd-editor.js` |
| スライド上の編集 | `slide_studio/web/blocks.js`（選択・キー・ツールバー）、`block-nav.js`（WASD・QE・パンくず）、`block-handles.js`（大きさ・余白のつまみ）、`block-drag.js`（持って動かす）、`block-ops.js`（原文の書き換え）、`slide_studio/web/inject/`、`slide_studio/deckstyle.py`（余白の「すべてに」） |
| AI チャット・Codex | `slide_studio/ai/chat.py`、`slide_studio/ai/app_server.py`、`slide_studio/ai/bridge.py`、`slide_studio/web/chat.js` |
| 検査・書き出し | `slide_studio/check.py`、`slide_studio/bundle.py`、`slide_studio/export.py` |
| プレビューと配布 HTML の共通部分 | `slide_studio/runtime/` |
| 雛形 | `slide_studio/templates/` |

変更箇所に関係するコード・テストを先に特定し、小さい範囲から読んでください。

## 検証

普段は、変えたところに関係するテストだけを実行します。全体（`uv run pytest -q`）は約900件で、並べて流して4〜5分かかります（順に流すと15分ほど）。

テストは pytest-xdist で並べて流します（`pyproject.toml` の `-n auto`）。並べる数は論理コアの半分です（`tests/conftest.py` の `pytest_xdist_auto_num_workers`。Chromium と Pandoc を同時に動かすので、全部のコアを使うと待ち時間切れが出ます）。ファイルを2つまで指定したときは並べません（ワーカーを起動するほうが長いため）。並べずに流すときは `-n0`、数を決めるときは `-n 2` などを付けます。同じファイルのテストは同じワーカーで流し、e2e の Chromium はワーカーの中で使い回します（テストごとに新しいコンテキスト）。

```sh
# 例：原稿の解析・書き戻し・直接編集の判定を変えたとき
uv run pytest tests/test_source.py tests/test_edit.py -q

# 例：画面の操作を変えたとき（その機能の e2e だけ）
uv run pytest tests/e2e/test_links.py -q

# 全体（描画・検査・HTML/PDF 出力も含む。並べて4〜5分）
uv run pytest -q
```

GUI テストは Python の Playwright から Chromium を起動します。JavaScript の検証もブラウザ内で行い、npm のテスト環境は使いません。テストは一時的な保存場所を作成します。

環境によっては sandbox の制約で Chromium が起動できません。`TargetClosedError` などが出た場合は、まずブラウザを起動できる実行環境か確認してください。実行できなかった検証は、成功したものと区別して報告します。

## 変更するときの約束

- 正本は `.qmd`。GUI で触っていない原文を勝手に正規化しない。
- UI の文言は日本語とし、`slide_studio/web/strings.js` にまとめる。
- UI の説明（ツールチップ・ラベル・案内）はなるべく端的にする。名詞句＋要点1つ程度にとどめ、動作の詳しい説明は README に回す（例：「会話モード（ファイル編集なし）」）。
- アプリからのファイル書き込みは `slide_studio.fsutil.write_atomic` を使う。
- 見た目に関わる変更は、ユーザーの確認前に「完了」にせず「確認待ち」にする。
- 利用者に見える機能やコマンドを変えたら README も更新する。

## skills の作成・更新

対象は `slide_studio/templates/workspace/.agents/skills/` の `SKILL.md` と、その補助資料です。

- skills には、発表や題材に依存しない作業手順・判断基準・システムの形式や制約を書く。
- 特定の発表の本文、研究内容、固有の図名・素材名・数値・パスを、例としても埋め込まない。個別の内容は対象の下書き・原稿・参考資料や今回の依頼から読む。
- 記法の説明に例が必要なら、`<図の名前>`・`<deck>` などのプレースホルダーで最小限の構造だけを示す。システムで固定されたファイル名・API・コマンド・設定値は具体的に書いてよい。
- 個別の事例からルールを足すときは、他の題材にも適用できる条件と手順に直し、元の事例の文章や固有名を残さない。更新時は本文・コード例・補助資料を見直す。

## 役割別 AI の検証

役割は `slide_studio/ai/roles.py`、今回の入力は `context.py`、1送信の実行は `workflow.py`。編集担当（スライド・下書き・テーマ）は `native.py` で置き場を作業フォルダにして AI 本体の道具で動かし、指示は置き場の `AGENTS.md`・skill（雛形は `templates/workspace/`）。確認役（`review`）も `native.py` で置き場の skill `slide-studio-review` を使い、読むだけ（Codex は sandbox を read-only、Claude Code は書き込みの道具を渡さない）で動く。確認の指摘を同じ会話で直させるループは `chat.py` の `_review_fixes`。AI のプロセスは `live.py` の `Pool`（Chat が1つ持つ）が起動したままにする：Codex は起動の設定ごとに app-server を1つ、Claude Code はタブ・担当ごとに `--input-format stream-json` で1つ。`audit_tools.py`（`tools/audit.py`）は `slide-studio audit` の CLI 用です。相談役（`consult`）は skill を持たない読むだけの担当で、編集担当が `slide-studio consult --tab <タブ>` を呼ぶと `bridge.py` 経由で `Chat.run_consult` が質問だけを依頼文にして動かす（呼び方は `workflow.consult_line` が編集担当の依頼に添える）。

境界と継承は `tests/test_roles.py`、App Serverは `tests/test_app_server.py`、閲覧画面は `tests/e2e/test_agents.py`、モデル追加と担当設定は `tests/e2e/test_ai_model.py`・`tests/e2e/test_chat.py`。実AIのテストは通常のpytestに含めません。確かめるときは、一時の保存場所（`SLIDE_STUDIO_HOME`）でアプリを起動し、HTTP の `/api/deck/<発表>/chat/tabs/<タブ>/send` から送ります。Claude Code の中から試すときは、`CLAUDECODE` などの `CLAUDE*` の環境変数を外して起動します（入れ子の起動と区別するため）。置き場の守り（sandbox）を確かめるときは、AI が置き場の AGENTS.md に従って書き込みを断ることがあるので、AGENTS.md の無い一時の置き場で、`native.py` と同じ起動の引数を使います。

未導入の場合はダウンロードボタンで公式配布元から取得し、完了後にログインボタンを表示します（`ai/runtimes.py`。通常の状態確認ではダウンロードしません）。配布元が示すハッシュで照合し、`--version` と検出が通ってからバージョンを切り替え、一つ前のバージョンを残します。ログインは `ai/login.py` が各 CLI の公式の手順を起動するだけで、アプリはトークンに触りません。Claude は未改変の Claude Code 本体だけを動かします。

Antigravity CLI のログインは `agy acp` の `authenticate` で起動します。`ai/providers.py` で `agy models` の一覧と stream-json を扱い、`native.py` で担当の権限を設定します。編集担当は sandbox 内、確認・相談担当はファイル書き込みとコマンドを拒否します。会話は `--conversation` で再開し、送信ごとにプロセスを起動します。通常のテストでは `SLIDE_STUDIO_AGY=none` にして実 AI を呼びません。
