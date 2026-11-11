"""今回の対象・資料だけを組み立てる。システムプロンプトは読み込まない。"""
import json

from .. import check, materials, memo, source
from ..fsutil import write_atomic
from ..render import render_text
from ..workspace import StudioError, figure_steps, figure_title

PAGE_TEXT_LIMIT = 6000


class Context:
    def conversation_handover(self, deck, tab_id, stopped=None, *, exclude=None):
        """AIを追加実行せず、保存した発言から引き継ぐ。古い全文は読める場所に残す。"""
        rounds = [r for r in self.state(deck)["rounds"] if r["tab"] == tab_id and r.get('id') != exclude]
        history = self.ws.state / "chat" / "history" / f"{deck}-{tab_id}.jsonl"
        entries = [json.dumps({"指示": r["items"], "返答": r.get("summary"), "添付": r.get("attach", [])}, ensure_ascii=False)
                   for r in rounds]
        write_atomic(history, "\n".join(entries) + "\n")
        lines = ["[会話の引き継ぎ]", "現在のファイルを正本とし、過去の依頼は再実行しない。",
                 f"古い会話が必要なら {history.relative_to(self.ws.root)} の該当箇所だけを読む（1行が1送信）。"]
        recent, size = [], 0
        for entry in reversed(entries):
            if size + len(entry) > 16000:
                break
            recent.append(entry)
            size += len(entry)
        lines.extend(reversed(recent))
        if stopped:
            lines += ["[中断した作業を続行] 完了済みの変更を保ち、現在のファイルと照合して残りを進める。返答がない項目は達成未確認。",
                      json.dumps({"元の全指示": stopped["items"], "最新結果": stopped.get("results"),
                                  "検査": stopped.get("check"), "確認": [a for a in stopped.get("agents", []) if a.get("role") == "review"][-1:],
                                  "停止理由": stopped.get("error")}, ensure_ascii=False)]
        return "\n".join(lines)

    def _rendered(self, deck: str, text: str):
        rendered = self.srv.state(deck).rendered
        return rendered if rendered and rendered.doc.text == text else render_text(self.ws, deck, text)

    @staticmethod
    def _slide_of(rendered) -> dict:
        return {s["page"]: s["index"] for s in reversed(rendered.slides)}

    def _target_item(self, deck: str, doc, rendered, item: dict) -> dict:
        key = item["key"]
        page = self._page(doc, key)
        if key.startswith("@"):
            title = item.get("page_title")
            if not isinstance(title, str) or page is None or page.id or page.title != title:
                raise StudioError("ページの並びや見出しが変わったため、どのページへの指示か確認できません。対象を選び直してください")
            item["page_title"] = title
        if page:
            slide = self._slide_of(rendered).get(page.index)
            item["label"] = f"p{slide + 1} {page.title}" if slide is not None else page.title
        if key.startswith("fig:"):
            item["label"] = f"図 {key.split('/')[-1]}"
            if item.get("step") is not None:
                step = item["step"]
                names = figure_steps(self.ws.figure_dir(key[4:], deck))
                # steps を変数などで書いた図は名前を読めないので、番号だけにする
                if type(step) is not int or step < 0 or (names and step >= len(names)):
                    raise StudioError("図の step が見つかりません。対象を選び直してください")
                item["step"] = {"index": step, "count": len(names) or None, "title": names[step] if names else ""}
                item["label"] += f" · {self._step_label(item['step'])}"
        return item

    @staticmethod
    def _step_label(step: dict) -> str:
        return f"step {step['index'] + 1}" + (f"/{step['count']}" if step.get("count") else "") + (f"「{step['title']}」" if step.get("title") else "")

    def prompt(self, deck: str, items: list[dict], attach: list[dict] | None = None, talk: bool = False) -> str:
        """スライドのチャットの依頼。talk は話し合い（ファイルを変えず、答えるだけ）。"""
        ws = self.ws
        text = ws.qmd(deck).read_text()
        doc = source.parse(text)
        rendered = self._rendered(deck, text)
        slide_of = self._slide_of(rendered)
        shelf, theme = ws.deck_shelf(deck), ws.deck_theme(deck)
        qmd = f"decks/{deck}/slides.qmd"
        lines = [
            "Slide Studio のスライドのチャットからの話し合いです（skill：slide-studio-slides）。" if talk
            else "Slide Studio のスライドのチャットからの依頼です（skill：slide-studio-slides）。",
            "",
            f"[発表] {qmd}（トピック: {shelf}, テーマ: {theme}）",
        ]
        if ws.memo(deck).exists():
            lines.append(f"[下書き] {memo.rel(deck)}")
        if talk:
            lines += [
                "[話し合い] この送信ではファイルを変えない（変えられない）。読んで、質問・相談に答える（返事の文は普通の文章）。",
                "分からないこと・資料に無いデータは、推測で埋めずにそう伝える。直すときは何をどう変えるかを答えるだけにする。",
                f"[発言の数] {len(items)} 件。[対象] は利用者が見ていたページ・図。",
            ]
        else:
            lines += [
                f"[指示の数] {len(items)} 件。変えるのは各件の [対象] の範囲だけ。送信後に画面が移動しても対象は変わりません。",
                "指示の意図が分からない・必要なデータが無いときは、推測で変えずにそう伝える（その件の ok は false）。利用者に選んでもらえる確認は questions に入れる。質問だけの件はファイルを変えずに答える。",
            ]
        lines += materials.prompt_lines(ws, deck)
        if attach:
            lines.append(f"[添付] 利用者が添付したファイル {len(attach)} 件（読んで指示に使う。画像はファイルを開いて見る）：")
            for a in attach:
                note = "画像。スライドに使うならこのパスをそのまま参照する" if a["kind"] == "image" else "参考資料。読むだけで変えない"
                path = (ws.asset_root(deck) if a["kind"] == "image" else ws.deck_dir(deck)) / a["path"]
                lines.append(f"- {path.relative_to(ws.root).as_posix()}（{note}）")
        for i, it in enumerate(items, 1):
            lines += ["", f"### {i}"]
            page = self._page(doc, it["key"])
            if it["key"].startswith("fig:"):
                lines += self._figure(deck, doc, it["key"][4:], rendered, it.get("step"))
            elif page is None:
                lines.append("[対象] 発表全体" if it["key"] == "deck" else f"[対象] {it['label']}（原稿に見つかりません。id: {it['key']}）")
            else:
                head = text[:page.start].count("\n") + 1
                tail = text[:page.end].rstrip("\n").count("\n") + 1
                pid = f"id: {page.id}" if page.id else "id なし"
                slide = slide_of.get(page.index)
                number = f"p{slide + 1}" if slide is not None else "（表示なし）"
                lines.append(f"[対象] ページ {number}（{pid}）「{page.title}」")
                lines.append(f"[対象の原文] {qmd} の {head}〜{tail} 行目")
                body = text[page.start:page.end].rstrip("\n")
                if len(body) <= PAGE_TEXT_LIMIT:
                    lines += ["````markdown", body, "````"]
                if slide is not None:
                    shot = ws.build_dir(deck) / "shots" / f"p{slide + 1:02d}-s0.png"
                    if shot.is_file():
                        lines.append(f"[今の表示] {shot.relative_to(ws.root).as_posix()}（必要なら見る。古い場合がある）")
            lines.append(f"[{'発言' if talk else '指示'}] {it['text']}")
        return "\n".join(lines)

    def prompt_memo(self, deck: str, text: str, attach: list[dict] | None = None) -> str:
        """下書きの今回の対象と依頼だけを組み立てる。"""
        ws = self.ws
        cur = memo.read(ws, deck)
        lines = [
            "Slide Studio の「下書き」チャットからの依頼です（skill：slide-studio-memo）。",
            "",
            f"[下書き] {memo.rel(deck)}（変えてよいのはこのファイルだけ）" + ("" if cur["exists"] else "。まだ無いので、書くときは作る"),
            f"[原稿] decks/{deck}/slides.qmd（読むだけ。変えない）",
        ]
        lines += materials.prompt_lines(ws, deck)
        if attach:
            lines.append(f"[添付] 利用者が添付したファイル {len(attach)} 件（読んで依頼に使う。画像はファイルを開いて見る）：")
            for a in attach:
                path = (ws.asset_root(deck) if a["kind"] == "image" else ws.deck_dir(deck)) / a["path"]
                lines.append(f"- {path.relative_to(ws.root).as_posix()}（{'画像' if a['kind'] == 'image' else '参考資料。読むだけで変えない'}）")
        lines += ["", f"[依頼] {text}"]
        return "\n".join(lines)

    def prompt_theme(self, deck: str, text: str, attach: list[dict] | None = None, theme: str | None = None) -> str:
        ws = self.ws
        theme = theme or ws.deck_theme(deck)
        users = [d for d in ws.list_decks() if ws.deck_theme(d) == theme]
        lines = [
            "Slide Studio の「テーマ」チャットからの依頼です（skill：slide-studio-theme）。",
            f"[テーマ] themes/{theme}.css（変えてよいのはこのファイルだけ）",
            f"[使っている発表] {'、'.join(users)}（同じテーマの他の発表も変わります）",
            f"[見本] .slide-studio/themes/{theme}/ の縮小画像（読むだけ。古い場合があります）",
        ]
        for shot in sorted((ws.state / "themes" / theme).glob("*.png")):
            lines.append(f"- {shot.relative_to(ws.root).as_posix()}")
        if attach:
            lines.append("[添付] 読んで依頼に使う。画像はファイルを開いて見る。変えない：")
            for a in attach:
                path = (ws.asset_root(deck) if a["kind"] == "image" else ws.deck_dir(deck)) / a["path"]
                lines.append(f"- {path.relative_to(ws.root).as_posix()}")
        lines += ["", f"[依頼] {text}"]
        return "\n".join(lines)

    def prompt_fix(self, deck: str, r: dict, result: dict, n: int, limit: int) -> str:
        """検査のエラーを同じ会話で直させる依頼（設計書 §8.1.2）。場所・文・問題のあるページの画像のパスだけ。警告は入れない。"""
        ws = self.ws
        theme = r.get("mode") == "theme"
        errors = result["errors"]
        lines = [f"アプリの検査で、エラーが {len(errors)} 件ありました（skill：{'slide-studio-theme' if theme else 'slide-studio-slides'}。"
                 f"直すのは {n}/{limit} 回目）。この会話でした変更を見直して、エラーをなくしてください。"
                 "警告は直さなくてよい。今回の指示の範囲の外は変えない。", ""]
        if theme:
            lines.append(f"[テーマ] themes/{r['theme']}.css")
        else:
            lines.append(f"[発表] decks/{deck}/slides.qmd")
            lines.append(f"[検査の結果] {(ws.build_dir(deck) / 'checks.json').relative_to(ws.root).as_posix()}")
        lines.append("[検査のエラー]")
        for x in errors:
            where = []
            if x.get("slide") is not None:
                where.append(f"p{x['slide'] + 1}" + (f"（id: {x['page_id']}）" if x.get("page_id") else ""))
            if check.step_label(x):
                where.append(check.step_label(x))
            lines.append(f"- {' '.join(where) + '：' if where else ''}{x['message']}")
            if x.get("image"):
                lines.append(f"  [画像] {(ws.build_dir(deck) / x['image']).relative_to(ws.root).as_posix()}（問題の箇所に赤枠）")
        lines.append("")
        lines.append("直したら終える。最後の返事は直したことを短く。" if theme else
                     self._fix_reply(deck, r))
        return "\n".join(lines)

    def _fix_reply(self, deck: str, r: dict) -> str:
        lines = [f"直したら slide-studio check {deck} で確かめてから終える。",
                 "最後の summary と results は、今回の直しだけでなく下の元の全指示について、現在のファイルを基に更新する。"
                 "results の item は元の指示の番号を使い、未達も含め全件を返す。初回の成功をそのまま引き継がない。まだ答えをもらっていない questions は残す。",
                 "[元の指示]"]
        lines += [f"{i}. [{self._review_target(deck, it)}] {it['text']}" for i, it in enumerate(r["items"], 1)]
        return "\n".join(lines)

    def _review_target(self, deck: str, it: dict) -> str:
        """確認役に渡す指示の対象。同じ名前のページ・図を見分けられるよう、ページの id・図のパス（トピック付き）を添える。"""
        key = it["key"]
        if key == "deck":
            return "発表全体"
        if key in ("memo", "theme"):
            return it.get("label") or key
        if key.startswith("fig:"):
            d = self.ws.figure_dir(key[4:], deck)
            rel = d.relative_to(self.ws.root).as_posix() if d.is_relative_to(self.ws.root) else str(d)
            return f"{it.get('label') or '図'}（{rel}、トピック {key[4:].split('/')[0]}）"
        if key.startswith("@"):
            return f"{it.get('label') or 'ページ'}（id なし。{int(key[1:]) + 1} 番目のページ）"
        return f"{it.get('label') or 'ページ'}（id: {key}）"

    def _changed_shots(self, deck: str, snap, changed: set[str]) -> list[str]:
        """この送信で変わったページの画像（検査が撮ったもの）。原文が変わったページと、変わった図を使うページだけ。"""
        ws = self.ws
        text = ws.qmd(deck).read_text()
        doc = source.parse(text)
        old = snap.path / "files" / f"decks/{deck}/slides.qmd" if snap else None
        before = set()
        if old and old.is_file():
            o = source.parse(old.read_text())
            before = {o.text[p.start:p.end] for p in o.pages}
        figs = {n for n in changed if n.startswith("topics/")}

        def uses_changed(p):
            for top in p.chunks:
                for c in top.walk():
                    ref = c.kind == "fig" and (source.fig_args(doc.text[c.start:c.end]) or {}).get("ref")
                    if ref:
                        d = ws.figure_dir(ref, deck)
                        rel = d.relative_to(ws.root).as_posix() + "/" if d.is_relative_to(ws.root) else ""
                        if rel and any(n.startswith(rel) for n in figs):
                            return True
            return False
        pages = {p.index for p in doc.pages if text[p.start:p.end] not in before or uses_changed(p)}
        rendered = self._rendered(deck, text)
        shots = ws.build_dir(deck) / "shots"
        out = []
        for s in rendered.slides:
            if s["page"] in pages:
                out += [f.relative_to(ws.root).as_posix() for f in sorted(shots.glob(f"p{s['index'] + 1:02d}-s*.png"))]
        return out

    def prompt_review(self, deck: str, r: dict, files: dict, images: list[str], again: bool) -> str:
        """確認役への依頼（設計書 §8.1.2）。利用者の指示・変わったファイル・変わったページの画像のパスだけを渡す。"""
        mode = r.get("mode", "slides")
        # 同じ時間に動いた下書き・テーマのタブが変えたファイルは、この送信の変更として見せない
        changed = sorted({n for k in ("modified", "added", "deleted") for n in (files or {}).get(k, [])} - self._overlap_files(r))
        what = {"memo": "下書き", "theme": "テーマ"}.get(mode, "スライド")
        lines = [f"Slide Studio の{what}のチャットの送信の後の確認です（skill：slide-studio-review）。読むだけで、ファイルは変えない。", ""]
        if mode == "theme":
            users = [d for d in self.ws.list_decks() if self.ws.deck_theme(d) == r["theme"]]
            lines += [f"[テーマ] themes/{r['theme']}.css", f"[使っている発表] {'、'.join(users)}"]
        else:
            lines.append(f"[発表] decks/{deck}/slides.qmd（トピック: {self.ws.deck_shelf(deck)}, テーマ: {self.ws.deck_theme(deck)}）")
            if mode == "memo" or self.ws.memo(deck).exists():
                lines.append(f"[下書き] {memo.rel(deck)}")
        if mode == "memo":
            lines.append("[下書きの形式の確認] .agents/skills/slide-studio-memo/SKILL.md の"
                         "「下書きの固定形式」だけを読み、今回の変更が形式に従っているか確認してください。"
                         "下書き担当の作業手順・編集権限・返事の形式は適用しません。")
        lines += ["[機械検査との分担] 構造・参照先・構文・重なり・はみ出しなどはアプリが検査します。"
                  "再検査や検査コマンドの実行は不要です。検査のエラー・警告を issues に再掲せず、"
                  "依頼の達成度・説明の整合・見た目の読みやすさを確認してください。"]
        if r.get("check") is not None:
            c = r["check"]
            lines.append(f"[機械検査済み] エラー {len(c['errors'])} 件・警告 {len(c['warnings'])} 件。")
            lines += [f"- {'エラー' if kind == 'errors' else '警告'}：{x['text']}" for kind in ("errors", "warnings") for x in c[kind]]
        lines.append("[利用者の指示]")
        lines += [f"{i}. [{self._review_target(deck, it)}] {it['text']}" for i, it in enumerate(r["items"], 1)]
        lines.append("[変わったファイル]")
        lines += [f"- {n}" for n in changed]
        if images:
            lines.append("[変わったページの画像]（開いて見る）" if mode != "theme" else "[テーマの見本の画像]（開いて見る）")
            lines += [f"- {p}" for p in images]
        if r.get("overlap"):
            lines += ["", "同じ時間に別のタブも作業していました。利用者の指示と関係のない変更は、その作業のものかもしれないので指摘しない。"]
        if again:
            lines += ["", "この会話で前にも確認しています。前に挙げたところと、新しく変わったところだけ見ればよい。"]
        return "\n".join(lines)

    def _overlap_files(self, r: dict) -> set[str]:
        """同じ時間に動いた下書き・テーマの送信が対象にしたファイル（下書きの memo.md・テーマの CSS）。"""
        out = set()
        for o in r.get("overlap") or []:
            try:
                other = self.round(o["deck"], o["round"])
            except StudioError:
                continue
            if other.get("mode") == "memo":
                out.add(memo.rel(o["deck"]))
            elif other.get("mode") == "theme" and other.get("theme"):
                out.add(f"themes/{other['theme']}.css")
        return out

    def prompt_review_fix(self, deck: str, r: dict, issues: list[dict], n: int, limit: int) -> str:
        """確認役の指摘を、編集担当の同じ会話で直させる依頼。"""
        mode = r.get("mode", "slides")
        skill = {"memo": "slide-studio-memo", "theme": "slide-studio-theme"}.get(mode, "slide-studio-slides")
        lines = [f"確認役が、直すところを {len(issues)} 件挙げました（skill：{skill}。直すのは {n}/{limit} 回目）。"
                 "この会話でした変更を見直して、指摘を直してください。今回の指示の範囲の外は変えない。"
                 "指摘が利用者の指示と食い違うときは、利用者の指示を優先し、直さない理由を返事に書く。", "", "[確認役の指摘]"]
        for x in issues:
            lines.append(f"- {x['target']}：{x['message']}" + (f"（直し方：{x['suggestion']}）" if x.get("suggestion") else ""))
        lines.append("")
        if mode == "memo":
            lines.append("直したら終える。最後の返事の reply には直したことを短く書き、slides と rebuild は最初の返事と同じにする。まだ答えをもらっていない questions は残す。")
        elif mode == "theme":
            lines.append("直したら終える。最後の返事は直したことを短く。")
        else:
            lines.append(self._fix_reply(deck, r))
        return "\n".join(lines)

    def _figure(self, deck: str, doc, ref: str, rendered, step: dict | None = None) -> list[str]:
        """図への指示の [対象]。原文は figure.mjs のパスだけ渡し、使っているページと今の表示を添える。"""
        ws = self.ws
        d = ws.figure_dir(ref, deck)
        rel = d.relative_to(ws.root).as_posix() if d.is_relative_to(ws.root) else str(d)
        place = f"トピック {ref.split('/')[0]}"
        if not (d / "figure.mjs").is_file():
            return [f"[対象] 図 {rel}（{place}。図が見つかりません）"]
        target = self._step_label(step) if step is not None else f"「{figure_title(d)}」"
        lines = [f"[対象] 図 {rel}（{place}）{target}", f"[対象の原文] {rel}/figure.mjs"]
        if step is not None:
            lines.append("[変更範囲] 表示中だった上記の step だけを変更する。他の step の表示・動作は維持する。")
        users = '、'.join(ws.decks_using(ref))
        if ref.split('/')[0] == ws.deck_shelf(deck):
            lines.append(f"[必須] トピックの図はそのまま直す（同じ図を使う他の発表も変わる。使っている発表：{users}）")
        else:
            # 他のトピックには書けない。写した図を直し、原稿の参照を替える。
            lines.append(f"[必須] 他のトピックの図なので元の図は変えない。直すときは、このトピック（{ws.deck_shelf(deck)}）に写してから直し、"
                         f"原稿の参照を写した図に替える（元の図を使っている発表：{users}）")
        slide_of = self._slide_of(rendered)
        used = [p for p in doc.pages if any(c.kind == "fig" and (source.fig_args(doc.text[c.start:c.end]) or {}).get("ref") == ref
                                            for top in p.chunks for c in top.walk())]
        if used:
            where = lambda p: (f"p{slide_of[p.index] + 1}" if p.index in slide_of else "（表示なし）") + (f"（id: {p.id}）" if p.id else "") + f"「{p.title}」"
            lines.append(f"[使っているページ] {'、'.join(where(p) for p in used)}")
            shot = ws.build_dir(deck) / "shots" / f"p{slide_of[used[0].index] + 1:02d}-s0.png" if used[0].index in slide_of else None
            if shot and shot.is_file():
                lines.append(f"[今の表示] {shot.relative_to(ws.root).as_posix()}（必要なら見る。古い場合がある）")
        return lines

    @staticmethod
    def _page(doc, key: str):
        if key == "deck" or key.startswith("fig:"):
            return None
        if key.startswith("@"):
            i = int(key[1:]) if key[1:].isdigit() else -1
            return doc.pages[i] if 0 <= i < len(doc.pages) else None
        return next((p for p in doc.pages if p.id == key), None)
