import { structureOf } from './structure.js';
import { isPresentationNote, noteText, replaceNote } from './presentation-model.js';
import { S } from './strings.js';
import { toast } from './api.js';
const N = S.speaker;
export async function noteModel(text) {
  const st = await structureOf(text);
  const start = Array.from(text).slice(0, st.front[1]).join('').length;
  const end = st.pages[0]?.start ?? text.length;
  const prefix = '## speaker-notes\n';
  const preamble = await structureOf(prefix + text.slice(start, end));
  const global = (preamble.pages[0]?.chunks || []).filter(isPresentationNote).map(c => ({...c, start:c.start-prefix.length+start, end:c.end-prefix.length+start, openEnd:c.openEnd-prefix.length+start, closeStart:c.closeStart-prefix.length+start}));
  return { st, global, start };
}
export function makeSpeakerNotes(ctx) {
  const views = new Set(); let alive = true, chain = Promise.resolve();
  const panel = document.createElement('details'); panel.className = 'speaker-notes';
  const summary = document.createElement('summary'); summary.textContent = N.notes; panel.append(summary);
  // スライドの上に重ねる。#viewport の配置に関わらないので、開閉や行の増減でスライドが動かない
  const viewport = ctx.root.querySelector('#viewport'); viewport.prepend(panel);
  // scope を渡すと、タブを出さずにページか全体のどちらか一方だけを表示する（発表者ビューの上下 2 段用）
  function createView(host, pageGetter, { slideNumber = () => ctx.preview.index + 1, autoGrow = true, scope: fixed = null } = {}) {
    const box = document.createElement('div'); box.className = 'speaker-note-fields';
    const tabs = document.createElement('div'); tabs.className = fixed ? 'speaker-note-head' : 'speaker-note-tabs';
    const local = document.createElement('button'), global = document.createElement('button');
    local.type = global.type = 'button'; local.textContent = N.pageNumber(slideNumber()); global.textContent = N.globalNote;
    const label = document.createElement('span'); label.className = 'speaker-note-label';
    const field = document.createElement('textarea'); field.setAttribute('aria-label', N.pageNote); field.spellcheck = false; field.disabled = true; field.rows = 1;
    const status = document.createElement('span'); status.className = 'speaker-note-status'; status.setAttribute('role', 'status');
    const title = () => fixed === 'global' ? N.globalNoteTitle : N.pageNoteTitle(slideNumber());
    if (fixed) { label.textContent = title(); tabs.append(label, status); } else tabs.append(local, global, status);
    box.append(tabs, field); host.append(box);
    function fit() {
      if (!autoGrow || !field.clientWidth) return;
      const style = getComputedStyle(field), line = parseFloat(style.lineHeight);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const scroll = field.scrollTop;
      field.style.height = '0px';
      const height = Math.min(field.scrollHeight, line * 6 + padding);
      field.style.height = `${Math.max(line + padding, height)}px`;
      field.style.overflowY = field.scrollHeight > field.clientHeight + 1 ? 'auto' : 'hidden';
      field.scrollTop = scroll;
    }
    const resize = new ResizeObserver(fit); if (autoGrow) resize.observe(field);
    const view = { box, field, scope: fixed || 'page', seq: 0, revision: 0, target: null, busy: false, error: false, wantFocus: false };
    // 入力カーソルを本文の末尾に置く。欄が読み込み中で使えないときは、読み込み後に置く
    function focusField() {
      if (field.disabled) { view.wantFocus = true; refresh(); return; }
      view.wantFocus = false; field.focus({ preventScroll: true });
      const end = field.value.length; field.setSelectionRange(end, end); field.scrollTop = field.scrollHeight;
    }
    views.add(view);
    function pageAt(st) {
      const target = pageGetter();
      if (target && typeof target === 'object') return target.id ? st.pages.find(p => p.id === target.id) : st.pages.find(p => p.index === target.index && p.title === target.title);
      return st.pages[target];
    }
    async function refresh() {
      local.textContent = N.pageNumber(slideNumber()); if (fixed) label.textContent = title();
      const desired = pageGetter();
      const desiredIndex = desired && typeof desired === 'object' ? desired.index : desired;
      if (view.scope === 'page' && desiredIndex !== view.target?.index) field.disabled = true;
      const seq = ++view.seq, text = ctx.text, revision = view.revision;
      try {
        const m = await noteModel(text); if (!alive || seq !== view.seq || text !== ctx.text || revision !== view.revision || view.busy || view.error) return;
        const page = pageAt(m.st); view.target = page ? { id: page.id, index: page.index, title: page.title } : null;
        const chunks = view.scope === 'global' ? m.global : (page?.chunks || []).filter(isPresentationNote);
        const value = noteText(text, chunks); if (field.value !== value) field.value = value; fit(); field.disabled = view.scope === 'page' && (!page || !!page.generated);
        local.setAttribute('aria-pressed', String(view.scope === 'page')); global.setAttribute('aria-pressed', String(view.scope === 'global'));
        field.setAttribute('aria-label', fixed ? title() : view.scope === 'global' ? N.globalNote : N.pageNumber(slideNumber()));
        if (view.wantFocus) { view.wantFocus = false; if (!field.disabled) focusField(); }
      } catch(e) { view.wantFocus = false; status.textContent = N.noteError; }
    }
    async function select(scope) {
      await chain;
      if (view.error) { toast(N.noteError); return; }
      view.scope = scope;
      view.wantFocus = panel.open;
      field.disabled = true;
      await refresh();
    }
    local.onclick = () => select('page'); global.onclick = () => select('global');
    field.addEventListener('input', () => {
      fit();
      const value = field.value, target = view.target, scope = view.scope, revision = ++view.revision;
      view.busy = true; status.textContent = N.saving;
      chain = chain.then(async () => {
        for (;;) {
          const text = ctx.text, m = await noteModel(text); if (text !== ctx.text) continue;
          if (ctx.locked || ctx.allLocked || ctx.conflict || ctx.lock.pages?.length) throw Error(N.noteError);
          const p = target?.id ? m.st.pages.find(p => p.id === target.id) : m.st.pages[target?.index];
          if (scope === 'page' && (!p || !target || (!target.id && p.title !== target.title))) throw Error(N.noteError);
          const chunks = scope === 'global' ? m.global : p.chunks.filter(isPresentationNote);
          const next = replaceNote(text, chunks, scope === 'global' ? m.start : p.end, value, scope === 'global');
          ctx.setText(next); if (ctx.text !== next) throw Error(N.noteError);
          view.error = false; break;
        }
      }).catch(e => { view.error = true; status.textContent = N.noteError; toast(e.message); }).finally(() => {
        if (view.revision === revision) { view.busy = false; if (!view.error) { status.textContent = N.pending; if (scope === 'page') { const current = pageGetter(); const index = typeof current === 'object' ? current?.index : current; if (index !== target?.index) refresh(); } } }
        for (const other of views) if (other !== view && !other.busy) other.refresh();
      });
    });
    view.refresh = refresh; refresh();
    return { head: tabs, refresh, fit, focus: focusField, cancelFocus() { view.wantFocus = false; }, destroy() { resize.disconnect(); views.delete(view); box.remove(); } };
  }
  const editorView = createView(panel, () => ctx.preview?.pageOfSlide(ctx.preview.index));
  // 開いたらページのメモ欄に入力カーソルを置き、すぐ書き始められるようにする
  panel.addEventListener('toggle', () => { editorView.fit(); if (panel.open) editorView.focus(); else editorView.cancelFocus(); });
  // Esc か、スライドの周りの余白を押すと畳む
  const collapse = e => { if (!panel.open) return; if (e.type === 'keydown') { if (e.key !== 'Escape' || e.isComposing) return; e.preventDefault(); e.stopPropagation(); summary.focus(); } panel.open = false; };
  const blank = e => { if (e.target === viewport) collapse(e); };
  panel.addEventListener('keydown', collapse); viewport.addEventListener('pointerdown', blank);
  const refresh = () => { for (const v of views) if (!v.busy) v.refresh(); };
  const service = { createView, flush: async () => { await chain; return ![...views].some(v => v.error); } }; ctx.speakerNotes = service;
  return { ...service, slideChanged: refresh, previewLoaded: refresh, textChanged: refresh,
    saved() { for (const v of views) if (!v.error && !v.busy) v.box.querySelector('[role=status]').textContent = ctx.text === ctx.saved ? N.saved : N.pending; },
    destroy() { alive = false; viewport.removeEventListener('pointerdown', blank); editorView.destroy(); panel.remove(); delete ctx.speakerNotes; } };
}
