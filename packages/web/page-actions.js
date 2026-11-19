import { S } from './strings.js';
import { toast } from './api.js';
import { structureOf } from './structure.js';
import { movePage, removePage } from './block-ops.js';
import { duplicatePage, togglePageSkip } from './page-operations.js';

export function makePageActions(ctx) {
  let dialog = null, alive = true, busy = false, follow = null;
  const blocked = () => busy || ctx.locked || ctx.allLocked || ctx.lock.pages?.length || ctx.conflict || ctx.historyBusy || ctx.presenting;
  function close() { dialog?.close(); dialog?.remove(); dialog = null; }
  async function open(index) {
    if (blocked() || index == null) return;
    if (ctx.dirty || ctx.saving || ctx.preview.version !== ctx.version) { toast(S.saveFirst); return; }
    close();
    const text = ctx.text;
    const st = await structureOf(text);
    if (!alive || text !== ctx.text || blocked()) return;
    const p = st.pages[index]; if (!p) return;
    const d = document.createElement('dialog'); dialog = d; d.className = 'page-actions-dialog';
    d.setAttribute('aria-label', S.pageActions.title);
    const title = document.createElement('h2'); title.textContent = S.pageActions.page(index + 1, p.title); d.append(title);
    const act = (label, fn, disabled = false) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = label; b.disabled = disabled;
      b.onclick = async () => {
        if (blocked() || text !== ctx.text) { close(); return; }
        busy = true;
        try {
          if (!await ctx.flush() || text !== ctx.text || ctx.locked || ctx.allLocked || ctx.lock.pages?.length) return;
          const r = fn(); if (!r) return;
          ctx.setText(r.text); follow = {text: r.text, page: r.page ?? Math.min(index, st.pages.length - 2)};
        } catch (e) { toast(e.message); }
        finally { busy = false; close(); }
      }; d.append(b);
    };
    act(S.pageActions.duplicate, () => duplicatePage(text, st, index), !!p.generated || p.raw_only);
    act(p.skipped ? S.pageActions.unskip : S.pageActions.skip, () => togglePageSkip(text, st, index), p.raw_only);
    act(S.pageActions.previous, () => movePage(text, st, index, index - 1), index === 0);
    act(S.pageActions.next, () => movePage(text, st, index, index + 2), index === st.pages.length - 1);
    act(S.pageActions.remove, () => removePage(text, st, index));
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
  function decorate(container) {
    for (const thumb of container.querySelectorAll('button[data-index]')) {
      const index = ctx.preview.pageOfSlide(+thumb.dataset.index), p = ctx.structure?.pages[index];
      thumb.classList.toggle('page-skipped', !!p?.skipped);
      let badge = thumb.querySelector('.page-skip-label');
      if (p?.skipped && !badge) { badge = document.createElement('span'); badge.className = 'page-skip-label'; badge.textContent = S.pageActions.skipped; thumb.append(badge); }
      if (!p?.skipped) badge?.remove();
      if (thumb.querySelector('.page-actions-trigger') || index == null) continue;
      const more = document.createElement('span'); more.className = 'page-actions-trigger'; more.textContent = '⋯';
      more.setAttribute('role', 'button'); more.tabIndex = 0; more.setAttribute('aria-label', S.pageActions.title);
      const launch = e => { e.preventDefault(); e.stopPropagation(); open(ctx.preview.pageOfSlide(+thumb.dataset.index)); };
      more.addEventListener('click', launch);
      more.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') launch(e); });
      thumb.append(more);
    }
  }
  return { open, attach, decorate, previewLoaded() {
    if (!follow) return; const wanted = follow; follow = null;
    if (ctx.text !== wanted.text) return;
    const index = ctx.preview.slideOfPage(wanted.page); if (index >= 0) ctx.preview.go(index, 0);
  }, destroy() { alive = false; close(); } };
}
