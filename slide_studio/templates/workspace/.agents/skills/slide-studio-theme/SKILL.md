---
name: slide-studio-theme
description: Slide Studio の共有テーマ（CSS）を直す。「テーマ」チャットからの依頼で使う。
---

# Slide Studio テーマの作業

- 質問・相談には答えるだけにし、変更を頼まれたら `[テーマ]` の `themes/<テーマ>.css` を直す。色・フォントだけでなく、見出しの形など CSS 全体を直せる。情報が足りなければ質問する。
- 変えるのはその CSS だけ。原稿（`slides.qmd`）・`styles/slides.css`・下書き・図・文献・添付は変えない。発表専用のコピーは作らない。
- テーマは共有なので、同じテーマを使う他の発表（`[使っている発表]`）も変わる。
- `[見本]` の `.slide-studio/themes/<テーマ>/` の画像で今の見た目を見られる（古い場合がある）。
- 変えたら、`[使っている発表]` のそれぞれで `slide-studio check <発表>` を流す。原稿や図の直しが要るなら、変えずに伝える。使っている発表がなければ、実際のスライドでは確かめていないと伝える。

## テーマの型

- `:root` の次の変数は消さない：`--ink`・`--accent`・`--header`・`--header-ink`・`--muted`・`--warn`・`--good`・`--mark`・`--mark-ink`・`--mark-line`・`--paper`・`--rule`・`--font-body`・`--font-head`。
- 図へ色を渡す `--theme-ink:var(--ink)` などの行も残す。
- ブロックは6種類：`plain`（整理）、`top`（結論・要点）、`left`（補足）、`quote`（引用）、`bracket`（定義・条件）、`fold`（メモ）。テーマの雰囲気を保ちつつ、役割ごとに装飾色と背景の色味を変える。暗いテーマにも明るい背景を流用せず、背景と標準文字色を対で設定する。
- `:root` の `--block-<種類>-line`（線）、`--block-<種類>-fill`（背景）、`--block-<種類>-ink`（文字）、`--block-<種類>-radius`（角丸）、`--block-<種類>-shadow`（影の強さ）で調整する。plain の線と背景のみ既存名 `--block-border`・`--block-background` を使う。線の太さの初期値は top が8px、left が10px、ほかは3.5px（最小1px）。例：`8px solid #2167a8ff`。色は16進8桁、角丸は0〜40px、影は0〜1。quote・fold の装飾色は `--block-<種類>-accent` で直接設定する（線幅の設定はない）。bracket は `--block-bracket-accent`（横の短線の色）と `--block-bracket-width`（線幅）も線とそろえる。bracket の GUI/API の変更ではこの2つは自動でそろう。影の有無は原稿の `--block-shadow:on` で決まり、影の強さだけをテーマが持つ。

## 最後の返事

`summary` に日本語の普通の文章（Markdown 可）で、変えた点と、同じテーマの他の発表も変わることを短く伝える。

- 利用者に決めてもらう確認で選択肢を挙げられるものは `questions` に入れる（1回に3つまで、選択肢は2〜4個）。チャットにボタンで出る。同じ質問を`summary`に重ねて書かない。選択肢を挙げられない質問は普通に文章で聞く。答えが来るまで、その件は推測で変えない。
