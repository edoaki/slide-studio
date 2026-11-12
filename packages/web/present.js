import { installExternalLinks } from './external-links.js';
// 発表（設計書 §10.8）。読み込んだ HTML は終了まで差し替えない。
import { api, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';
import {
  AgentClient,
  capabilityUrl,
  createGeneration,
  createNonce,
  registerFrameClient,
  requestPreviewCapability,
  unregisterFrameClient,
} from './bridge/agent-client.js';

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
    const snapshot = s.client?.snapshot;
    if (sync && alive && snapshot) {
      const id = snapshot.slides[snapshot.index]?.id;
      const index = ctx.preview.slides.findIndex(slide => slide.id === id);
      Promise.resolve(ctx.preview.go(index >= 0 ? index : snapshot.index, snapshot.step)).catch(() => {});
    }
    for (const off of s.unsub || []) off();
    s.client?.destroy();
    unregisterFrameClient(s.frame, s.client);
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

  // Keys and the #fullscreen button are intercepted by the content agent and
  // forwarded as validated events. Nested same-origin figure frames are wired
  // there too, so the parent never reaches into the presentation document.
  const bridgeKeys = data => {
    if (!session || (data?.type !== 'keydown' && data?.type !== 'keyup')) return;
    if (data.key === 'Escape') { finish(); return; }
    const mods = data.mods || {};
    if (data.key === 'f' && !mods.meta && !mods.ctrl && !mods.alt) {
      if (data.type === 'keydown' && !data.repeat) toggleFullscreen();
    }
  };

  async function start(mode, button) {
    if (busy || session) return;
    trigger = button; busy = true; buttons.forEach(b => { b.disabled = true; });
    let started = null;
    try {
      if (!await ctx.flush()) throw new Error(S.saveFirst);
      if (!alive) return;
      const index = mode === 'first' ? 0 : ctx.preview.index;
      const step = 0;
      const generation = createGeneration();
      const nonce = createNonce();
      const capability = await requestPreviewCapability(api, {
        deck: ctx.deck,
        // ctx.version is the freshest committed revision after flush(); the
        // preview may still be showing the previous frame until its reload.
        version: ctx.version ?? ctx.preview.version ?? '',
        mode: 'present',
        generation,
      });
      if (!alive) return;
      const box = document.createElement('div'); box.className = 'present-screen';
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', S.present.title);
      const frame = document.createElement('iframe'); frame.title = S.present.title; frame.allowFullscreen = true;
      const client = new AgentClient({
        frame,
        deck: ctx.deck,
        version: capability.version,
        generation,
        adminOrigin: location.origin,
        contentOrigin: capability.origin,
        nonce,
      });
      const s = started = {
        box, frame, client, fullscreen: false, connected: false,
        abort: new AbortController(), wasInert: ctx.root.inert, unsub: [],
      };
      session = s; ctx.root.inert = true;
      s.unsub.push(client.on('key', bridgeKeys));
      s.unsub.push(client.on('failure', () => {
        if (session === s && s.connected) finish();
      }));
      installExternalLinks(client);
      s.abort.signal.addEventListener('abort', () => client.destroy(), { once: true });
      client.start();
      registerFrameClient(frame, client);
      frame.src = capabilityUrl(capability.url, { index, step, nonce, mode: 'present', generation });
      box.append(frame); document.body.append(box);
      await client.ready;
      if (session !== s || !alive) return;
      s.connected = true;
      await client.api.go(index, step);
      if (session !== s || !alive) return;
      if (document.fullscreenElement) s.fullscreen = true;
      else await toggleFullscreen();
      if (session === s) frame.focus();
    } catch (e) {
      // A normal Esc/fullscreen exit destroys the client while ready is still
      // pending; that is not an error to report.
      const cancelled = !!started && session !== started;
      finish(false);
      if (alive && !cancelled) toast(e?.message === S.saveFirst ? S.saveFirst : S.present.error);
    }
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
