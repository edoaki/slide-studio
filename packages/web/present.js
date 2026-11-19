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
  const menu = tip(document.createElement('button'), S.present.menu);
  menu.type = 'button'; menu.className = 'ibtn present-menu';
  menu.setAttribute('aria-haspopup', 'dialog');
  menu.innerHTML = svg('speakerView');
  const chevron = document.createElement('span'); chevron.className = 'present-menu-chevron'; chevron.innerHTML = svg('chevD');
  menu.append(chevron); menu.onclick = () => chooseStart(menu);
  const current = tip(document.createElement('button'), S.present.current, 'F');
  current.type = 'button'; current.className = 'ibtn'; current.innerHTML = svg('play');
  current.setAttribute('aria-keyshortcuts', 'F'); current.onclick = () => start('current', current);
  host.append(menu, current); buttons.push(menu, current);
  ctx.root.querySelector('#barExtra').before(host);
  let alive = true, busy = false, session = null, trigger = null, chooser = null;
  function chooseStart(button) {
    if (busy || session || ctx.presenting || chooser) return;
    const dialog = document.createElement('dialog'); chooser = dialog;
    dialog.className = 'presentation-launcher'; dialog.setAttribute('aria-label', S.speaker.launchTitle);
    const heading = document.createElement('h2'); heading.textContent = S.speaker.launchTitle;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'ibtn'; close.innerHTML = svg('x'); close.setAttribute('aria-label', S.speaker.close); close.onclick = () => dialog.close();
    const header = document.createElement('header'); header.append(heading, close); dialog.append(header);
    const choices = [
      [S.speaker.normal, S.speaker.normalHelp, 'play', () => start('first',button)],
      [S.speaker.title, S.speaker.presenterHelp, 'speakerView', () => ctx.openPresenter?.(false)],
      [S.speaker.rehearsal, S.speaker.rehearsalHelp, 'stopwatch', () => ctx.openPresenter?.(true)],
    ];
    for (const [title, description, icon, action] of choices) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'presentation-choice'; row.setAttribute('aria-label', title);
      const mark = document.createElement('span'); mark.className = 'presentation-choice-icon'; mark.innerHTML = svg(icon);
      const text = document.createElement('span'), name = document.createElement('strong'), help = document.createElement('small'); name.textContent = title; help.textContent = description; text.append(name,help);
      const arrow = document.createElement('span'); arrow.className = 'presentation-choice-arrow'; arrow.innerHTML = svg('chevR'); row.append(mark,text,arrow);
      row.onclick = () => { dialog.close(); void action(); }; dialog.append(row);
    }
    dialog.addEventListener('keydown', e => e.stopPropagation()); dialog.addEventListener('keyup', e => e.stopPropagation());
    dialog.onclick = e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } };
    dialog.onclose = () => { dialog.remove(); if (chooser === dialog) chooser = null; };
    document.body.append(dialog); dialog.showModal(); dialog.querySelector('.presentation-choice').focus();
  }
  function shortcut(e) {
    if (chooser?.open) return;
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
    if (!session) { if (ctx.presenting) return; if (e.type === 'keydown') shortcut(e); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(); }
    else if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === 'keydown' && !e.repeat) toggleFullscreen();
    } else if (['ArrowRight','ArrowDown','ArrowLeft','ArrowUp',' ','o','b','B','Enter','Backspace'].includes(e.key) || /^[0-9]$/.test(e.key)) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      e.preventDefault(); e.stopImmediatePropagation();
      session.client.api.presentationKey(e.type,e.key,e.repeat).catch(() => {});
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
    if (busy || session || ctx.presenting) return;
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
      // Native fullscreen entry can remain pending after Esc closes the player.
      // The presentation is ready; do not hold its startup lock on that promise.
      else void toggleFullscreen();
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
      alive = false; chooser?.remove(); chooser = null; finish(false); host.remove();
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      removeEventListener('keydown', keys, true); removeEventListener('keyup', keys, true);
    },
  };
}
