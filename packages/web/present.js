import { installExternalLinks } from './external-links.js';
// 発表（設計書 §10.8）。読み込んだ HTML は終了まで差し替えない。
import { toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';

export function makePresent(ctx) {
  const host = document.createElement('span'); host.className = 'present-tools';
  host.setAttribute('role', 'group'); host.setAttribute('aria-label', S.present.title);
  const buttons = [];
  for (const [mode, icon] of [['first', 'playFirst'], ['current', 'play']]) {
    const b = tip(document.createElement('button'), S.present[mode], mode === 'first' ? '⇧ F' : 'F');
    b.setAttribute('aria-keyshortcuts', mode === 'first' ? 'Shift+F' : 'F');
    b.className = 'ibtn'; b.innerHTML = svg(icon);
    b.onclick = () => start(mode, b); host.append(b); buttons.push(b);
  }
  ctx.root.querySelector('#barExtra').before(host);
  let alive = true, busy = false, session = null, trigger = null;
  function shortcut(e) {
    if (e.key.toLowerCase() !== 'f' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (ctx.blocks?.selected) return; // 選択中の F はブロックの外側余白。
    if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) start(e.shiftKey ? 'first' : 'current', buttons[e.shiftKey ? 0 : 1]);
    return true;
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (session) await document.documentElement.requestFullscreen();
    } catch { /* 拒否・非対応なら、同じタブ内の全画面を使う */ }
  }
  function finish(sync = true) {
    const s = session; if (!s) return;
    session = null;
    const deck = s.frame.contentWindow?.deck;
    if (sync && alive && deck) {
      const id = deck.slides[deck.index]?.id;
      const index = ctx.preview.slides.findIndex(slide => slide.id === id);
      ctx.preview.go(index >= 0 ? index : deck.index, deck.step);
    }
    s.abort.abort(); s.box.remove(); ctx.root.inert = s.wasInert;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (alive) trigger?.focus();
  }
  const fullscreenChanged = () => {
    if (!session) return;
    if (document.fullscreenElement) session.fullscreen = true;
    else if (session.fullscreen) finish();
  };
  document.addEventListener('fullscreenchange', fullscreenChanged);
  // 編集画面にフォーカスが戻っても、発表中は編集側のキーを動かさない。
  const keys = e => {
    if (!session) { if (e.type === 'keydown') shortcut(e); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(); }
    else if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === 'keydown' && !e.repeat) toggleFullscreen();
    } else if (e.currentTarget === window) e.stopImmediatePropagation();
  };
  addEventListener('keydown', keys, true); addEventListener('keyup', keys, true);

  async function start(mode, button) {
    if (busy || session) return;
    trigger = button; busy = true; buttons.forEach(b => { b.disabled = true; });
    try {
      if (!await ctx.flush()) throw new Error(S.saveFirst);
      if (!alive) return;
      const index = mode === 'first' ? 0 : ctx.preview.index;
      const step = 0;
      const url = new URL(`/files/decks/${encodeURIComponent(ctx.deck)}/__slide-studio_preview__.html?edit=0`, location.href);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(S.present.error);
      const html = await response.text();
      if (!alive) return;
      const box = document.createElement('div'); box.className = 'present-screen';
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', S.present.title);
      const frame = document.createElement('iframe'); frame.title = S.present.title; frame.allowFullscreen = true;
      const s = { box, frame, fullscreen: false, abort: new AbortController(), wasInert: ctx.root.inert };
      session = s; ctx.root.inert = true;
      // srcdoc に元の配信先を渡し、相対参照をそのまま解決する。編集用コードは含めない。
      frame.srcdoc = html.replace(/<head>/i, `<head><base href="${url.href}"><script>window.__slideStudioNoHash=true;</script>`);
      box.append(frame); document.body.append(box);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(S.present.error)), 30000);
        s.abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        frame.addEventListener('load', () => {
          const w = frame.contentWindow;
          const ready = () => { clearTimeout(timer); resolve(); };
          if (w.deckReady) ready(); else w.addEventListener('deckready', ready, { once: true });
        }, { once: true });
      });
      if (session !== s || !alive) return;
      const w = frame.contentWindow;
      installExternalLinks(w.document);
      await w.deck.go(index, step);
      if (session !== s || !alive) return;
      w.addEventListener('keydown', keys, { capture: true, signal: s.abort.signal });
      // 図へフォーカスを移しても Esc・全画面の操作を受け取る。
      for (const f of w.document.querySelectorAll('iframe')) {
        try { f.contentWindow.addEventListener('keydown', keys, { capture: true, signal: s.abort.signal }); } catch { /* 外部の図 */ }
      }
      const fs = w.document.querySelector('#fullscreen');
      if (fs) fs.onclick = toggleFullscreen;
      if (document.fullscreenElement) s.fullscreen = true;
      else await toggleFullscreen();
      if (session === s) frame.contentWindow.focus();
    } catch (e) { finish(false); if (alive) toast(e.message); }
    finally { busy = false; buttons.forEach(b => { b.disabled = false; }); }
  }
  return {
    keydown: shortcut,
    destroy() {
      alive = false; finish(false); host.remove();
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      removeEventListener('keydown', keys, true); removeEventListener('keyup', keys, true);
    },
  };
}
