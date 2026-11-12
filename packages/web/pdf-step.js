// step の帯の「PDF に入れる」。PDF には各ページの最後の step が必ず入り、ほかの step は印を付けたものだけが入る。
// 印は原稿の見出しの pdf="2 4"（画面の表示と同じ 1 始まり）に書く。
import { toast } from './api.js';
import { S } from './strings.js';
import * as op from './block-ops.js';
import { structureOf } from './structure.js';

export function makePdfStep(ctx) {
  const preview = ctx.preview, wrap = ctx.root.querySelector('#pdfStepWrap'), box = wrap.querySelector('input');
  // 書き換えた直後は、描き直したスライドが届くまで書いた印を出す（原稿が同じ間だけ）
  let written = null, busy = false;
  const marks = i => written && written.text === ctx.text && written.slide === i ? written.marks : preview.api?.pdfMarks?.(i) ?? [];

  function update() {
    const i = preview.index, k = preview.step, n = (preview.api?.maxStep(i) ?? 0) + 1, last = k >= n - 1;
    const page = preview.pageOfSlide(i), editable = page != null && !ctx.structure?.pages?.[page]?.generated;
    wrap.classList.toggle('off', n <= 1 || !editable);
    // 書き換え中は押した状態のまま待つ
    if (!busy) box.checked = last || marks(i).includes(k + 1);
    box.disabled = last || busy;
    wrap.dataset.tip = last ? S.pdfStepLast : S.pdfStep;
    box.setAttribute('aria-label', wrap.dataset.tip);
  }

  box.onchange = async () => {
    const i = preview.index, k = preview.step, page = preview.pageOfSlide(i), on = box.checked, text = ctx.text;
    if (page == null) { update(); return; }
    busy = true; update();
    try {
      // 見出しの位置は今の原稿から取り直す（保存前の入力があっても正しい行を書き換える）
      const st = await structureOf(text);
      if (text !== ctx.text) return;
      // プレビューが保存前の版でも、今の原稿にある印を残して変更する。
      const next = new Set((st.pages[page]?.kv.pdf || '').split(/[\s,]+/).map(Number)
        .filter(n => Number.isInteger(n) && n >= 1));
      if (on) next.add(k + 1); else next.delete(k + 1);
      const list = [...next].sort((a, b) => a - b), r = op.setPageAttr(text, st, page, 'pdf', list.join(' '));
      if (!r) return;
      ctx.setText(r.text);
      if (ctx.text === r.text) written = { text: r.text, slide: i, marks: list };
    } catch (e) { toast(e.message); }
    finally { busy = false; update(); }
  };

  update();
  return { slideChanged: update, previewLoaded: update, textChanged: update, destroy() { box.onchange = null; } };
}
