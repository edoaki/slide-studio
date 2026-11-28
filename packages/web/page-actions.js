// ページの操作（複製・発表と PDF から外す・削除）。縮小画像の上には操作を置かない。
// 今のページは、外す・戻すをページ番号の横、削除を一覧のボタンの横で操作する。並べ替えは縮小画像を持って動かす（page-reorder.js）。
// 縮小画像と原稿のページを右クリックすると、そのページの操作を出す。
import { S } from './strings.js';
import { toast } from './api.js';
import { svg } from './icons.js';
import { tip } from './tip.js';
import { structureOf } from './structure.js';
import { removePage } from './block-ops.js';
import { duplicatePage, togglePageSkip } from './page-operations.js';

export function makePageActions(ctx) {
  let dialog = null, alive = true, busy = false, follow = null;
  const blocked = () => busy || ctx.locked || ctx.allLocked || ctx.lock.pages?.length || ctx.conflict || ctx.historyBusy || ctx.presenting;
  // プレビューのページ番号が今の原稿と同じ版のときだけ操作する
  const stale = () => ctx.dirty || ctx.saving || ctx.preview.version !== ctx.version;
  function close() { dialog?.close(); dialog?.remove(); dialog = null; }

  // 原稿を書き換え、描き直した後で結果のページへ移る
  async function run(index, text, st, edit) {
    if (blocked() || text !== ctx.text) return false;
    busy = true; refresh();
    try {
      if (!await ctx.flush() || !alive || text !== ctx.text || ctx.locked || ctx.allLocked || ctx.lock.pages?.length) return false;
      const r = edit(text, st, index); if (!r) return false;
      ctx.setText(r.text);
      if (ctx.text !== r.text) return false;
      follow = { text: r.text, page: r.page ?? Math.min(index, st.pages.length - 2) };
      return true;
    } catch (e) { toast(e.message); return false; }
    finally { busy = false; refresh(); }
  }

  // ------------------------------------------------------------ 今のページ（ページ番号の横と一覧のボタンの横）
  const skipButton = Object.assign(document.createElement('button'), { type: 'button', className: 'ibtn page-skip' });
  const removeButton = tip(Object.assign(document.createElement('button'), { type: 'button', className: 'ibtn page-remove', innerHTML: svg('trash') }), S.pageActions.remove);
  ctx.root.querySelector('#pageCount')?.before(skipButton);
  ctx.root.querySelector('#stripTools')?.append(removeButton);
  const currentPage = () => ctx.preview.pageOfSlide(ctx.preview.index);
  async function onCurrent(edit) {
    const index = currentPage();
    if (blocked() || stale() || index == null) return false;
    const text = ctx.text, st = await structureOf(text);
    if (!alive || !st.pages[index]) return false;
    return run(index, text, st, edit);
  }
  skipButton.onclick = () => onCurrent(togglePageSkip);
  removeButton.onclick = async () => { if (await onCurrent(removePage)) toast(S.qb.deleted); };
  let shownSkip = null;
  function refresh() {
    if (!alive) return;
    const index = currentPage(), p = index == null ? null : ctx.structure?.pages[index];
    const skipped = !!p?.skipped, off = !p || blocked() || stale();
    if (shownSkip !== skipped) {
      shownSkip = skipped;
      skipButton.innerHTML = svg(skipped ? 'eyeOff' : 'eye');
      skipButton.classList.toggle('on', skipped);
      skipButton.parentElement?.classList.toggle('skipped', skipped);
      tip(skipButton, skipped ? S.pageActions.unskip : S.pageActions.skip);
    }
    skipButton.disabled = off || !!p.raw_only;
    removeButton.disabled = off;
  }

  // ------------------------------------------------------------ 右クリック
  async function open(index) {
    if (blocked() || index == null) return;
    if (stale()) { toast(S.saveFirst); return; }
    close();
    const text = ctx.text;
    const st = await structureOf(text);
    if (!alive || text !== ctx.text || blocked()) return;
    const p = st.pages[index]; if (!p) return;
    const d = document.createElement('dialog'); dialog = d; d.className = 'page-actions-dialog';
    d.setAttribute('aria-label', S.pageActions.title);
    const title = document.createElement('h2'); title.textContent = S.pageActions.page(index + 1, p.title); d.append(title);
    const act = (label, edit, disabled = false) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = label; b.disabled = disabled;
      b.onclick = async () => {
        if (blocked() || text !== ctx.text) { close(); return; }
        try { await run(index, text, st, edit); } finally { close(); }
      }; d.append(b);
    };
    act(S.pageActions.duplicate, duplicatePage, !!p.generated || p.raw_only);
    act(p.skipped ? S.pageActions.unskip : S.pageActions.skip, togglePageSkip, p.raw_only);
    act(S.pageActions.remove, removePage);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = S.pageActions.close; cancel.onclick = close; d.append(cancel);
    d.addEventListener('cancel', e => { e.preventDefault(); close(); });
    document.body.append(d); d.showModal();
  }
  function attach(container, vertical = false) {
    const onContext = e => {
      if (vertical && e.target.closest('.qtree, input, textarea, [contenteditable="true"]')) return;
      const el = e.target.closest(vertical ? '.page[data-page]' : 'button[data-index]');
      if (!el || !container.contains(el)) return;
      e.preventDefault(); e.stopPropagation();
      open(vertical ? +el.dataset.page : ctx.preview.pageOfSlide(+el.dataset.index));
    };
    container.addEventListener('contextmenu', onContext);
    return () => container.removeEventListener('contextmenu', onContext);
  }
  // 外したページは縮小画像を暗くするだけにする（画像の上に文字を重ねない）
  function decorate(container) {
    for (const thumb of container.querySelectorAll('button[data-index]')) {
      const index = ctx.preview.pageOfSlide(+thumb.dataset.index), p = ctx.structure?.pages[index];
      thumb.classList.toggle('page-skipped', !!p?.skipped);
    }
  }
  return {
    open, attach, decorate, refresh,
    previewLoaded() {
      refresh();
      if (!follow) return; const wanted = follow; follow = null;
      if (ctx.text !== wanted.text) return;
      const index = ctx.preview.slideOfPage(wanted.page); if (index >= 0) ctx.preview.go(index, 0);
    },
    destroy() { alive = false; close(); skipButton.remove(); removeButton.remove(); },
  };
}
