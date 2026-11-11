// 原稿・サムネイル・一覧で共用するページのドラッグ。
import { S } from './strings.js';
import { toast } from './api.js';
import { structureOf } from './structure.js';
import { movePage } from './block-ops.js';

export function makePageReorder(ctx, { optimisticMove = () => () => {} } = {}) {
  let drag = null, marker = null, busy = false, follow = null, alive = true;
  const cleanups = new Set();
  let stopScroll = () => {};
  const blocked = () => busy || ctx.locked || ctx.allLocked || ctx.lock.pages?.length || ctx.conflict || ctx.historyBusy;
  let hint = null;
  const clearMark = () => { hint?.remove(); hint = null; marker?.removeAttribute('data-page-drop'); marker = null; };
  function cancel() {
    stopScroll();
    drag?.element.classList.remove('page-dragging'); drag = null; clearMark();
  }
  async function move(saved, before) {
    if (blocked() || saved.text !== ctx.text) return;
    busy = true;
    const rollback = optimisticMove(saved.page, before);
    let applied = false;
    try {
      if (!await ctx.flush() || saved.text !== ctx.text) return;
      const st = await structureOf(saved.text);
      if (!alive || saved.text !== ctx.text || ctx.locked || ctx.allLocked || ctx.lock.pages?.length) return;
      const result = movePage(saved.text, st, saved.page, before);
      if (!result) return;
      ctx.setText(result.text);
      if (ctx.text === result.text) { applied = true; follow = { text: result.text, page: result.page }; }
    } catch (e) { toast(e.message); }
    finally { if (!applied) rollback(); busy = false; }
  }
  function attach(container, vertical = false) {
    const selector = vertical ? '.page[data-page]' : 'button[data-index]';
    const pageOf = el => vertical ? Number(el.dataset.page) : ctx.preview.pageOfSlide(Number(el.dataset.index));
    const target = e => e.target.closest(selector);
    function start(e) {
      const el = target(e);
      if (!el || (vertical && !e.target.closest('.page-num'))) return;
      const page = pageOf(el);
      if (page == null || blocked() || ctx.dirty || ctx.saving || ctx.preview.version !== ctx.version) { e.preventDefault(); return; }
      drag = { page, text: ctx.text, element: el };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-slide-studio-page', String(page));
      el.classList.add('page-dragging');
      e.stopPropagation();
    }
    let frame = null, pointer = null, lastTime = null;
    function stop() {
      if (frame != null) cancelAnimationFrame(frame);
      frame = null; pointer = null; lastTime = null;
    }
    function tick(time) {
      frame = null;
      if (!drag || drag.text !== ctx.text || blocked() || !pointer) { stop(); return; }
      const scroll = container.closest('.ed-scroll');
      if (!scroll) { stop(); return; }
      const box = scroll.getBoundingClientRect();
      const edge = Math.min(140, box.height / 3);
      const { x, y } = pointer;
      const speed = y < box.top + edge ? -Math.min(1, (box.top + edge - y) / edge)
        : y > box.bottom - edge ? Math.min(1, (y - box.bottom + edge) / edge) : 0;
      const elapsed = lastTime == null ? 16 : Math.min(32, time - lastTime);
      lastTime = time;
      scroll.scrollTop += speed * 700 * elapsed / 1000;
      mark(document.elementFromPoint(x, y)?.closest(selector), y, x);
      frame = requestAnimationFrame(tick);
    }
    function mark(el, y, x) {
      clearMark();
      const page = el && container.contains(el) && pageOf(el);
      if (page == null || page === false) return;
      const r = el.getBoundingClientRect();
      const after = vertical ? y > r.top + r.height / 2 : x > r.left + r.width / 2;
      const before = page + Number(after);
      if (before === drag.page || before === drag.page + 1) return;
      marker = el; marker.dataset.pageDrop = vertical ? (after ? 'bottom' : 'top') : (after ? 'right' : 'left');
      hint = document.createElement('div'); hint.className = 'page-drop-hint';
      const number = vertical ? page + 1 : Number(el.querySelector('.num')?.textContent);
      hint.textContent = S.pageDrop(number, after);
      document.body.append(hint);
      const h = hint.getBoundingClientRect();
      hint.style.left = `${Math.max(8, Math.min(innerWidth - h.width - 8, r.left))}px`;
      hint.style.top = `${Math.max(8, r.top - h.height - 8)}px`;
      return before;
    }
    function over(e) {
      if (!drag) return;
      clearMark();
      if (drag.text !== ctx.text || blocked()) { stopScroll(); return; }
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
      const el = target(e);
      if (vertical) {
        if (stopScroll !== stop) { stopScroll(); stopScroll = stop; }
        pointer = { x: e.clientX, y: e.clientY };
        if (frame == null) frame = requestAnimationFrame(tick);
      }
      const before = mark(el, e.clientY, e.clientX);
      if (!vertical && el && before != null) {
        const scroll = el.parentElement, box = scroll.getBoundingClientRect();
        scroll.scrollLeft += e.clientX < box.left + 36 ? -24 : e.clientX > box.right - 36 ? 24 : 0;
      }
      return before;
    }
    function drop(e) {
      if (!drag) return;
      const before = over(e), saved = drag;
      e.preventDefault(); e.stopPropagation(); cancel();
      if (before != null) void move(saved, before);
    }
    function leave(e) { if (!container.contains(e.relatedTarget)) { clearMark(); stop(); } }
    const handlers = { dragstart: start, dragover: over, drop, dragend: cancel, dragleave: leave };
    for (const [name, fn] of Object.entries(handlers)) container.addEventListener(name, fn);
    const cleanup = () => {
      cancel();
      for (const [name, fn] of Object.entries(handlers)) container.removeEventListener(name, fn);
      cleanups.delete(cleanup);
    };
    cleanups.add(cleanup);
    return cleanup;
  }
  return {
    attach,
    decorate(container) {
      container.querySelectorAll('button[data-index]').forEach(b => {
        b.draggable = ctx.preview.pageOfSlide(Number(b.dataset.index)) != null;
      });
    },
    previewLoaded() {
      if (!follow) return;
      const wanted = follow; follow = null;
      if (ctx.text !== wanted.text) return;
      const index = ctx.preview.slideOfPage(wanted.page);
      if (index >= 0) ctx.preview.go(index, 0);
    },
    destroy() { alive = false; for (const cleanup of [...cleanups]) cleanup(); },
  };
}
