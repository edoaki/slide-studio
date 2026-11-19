import { AgentClient, capabilityUrl, createNonce } from './bridge/agent-client.js';
import { S } from './strings.js';
const id = location.hash.slice(1), owner = window.opener;
let pendingInputs = 0;
let client, ready = false, pending, applying = 0, navigation = Promise.resolve();
function go(d) {
  navigation = navigation.then(async () => {
    applying++;
    try {
      if (!!client.snapshot.blackout !== !!d.blackout) await client.api.setBlackout(!!d.blackout);
      if (client.snapshot.index !== d.index || client.snapshot.step !== d.step) await client.api.go(d.index,d.step);
    } finally { applying--; }
  }).catch(() => send('failure'));
}
const send = (type, data = {}) => owner?.postMessage({ speakerProjection: id, type, ...data }, location.origin);
async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch {} }
const button = document.querySelector('#projectionFullscreen'); button.textContent = S.speaker.fullscreen; button.onclick = fullscreen;
addEventListener('message', async e => {
  if (e.source !== owner || e.origin !== location.origin || e.data?.speakerProjection !== id) return;
  const d = e.data;
  if (d.type === 'init' && !client) {
    const frame = document.createElement('iframe'); frame.title = S.speaker.projectionTitle; frame.allowFullscreen = true;
    const nonce = createNonce();
    client = new AgentClient({ frame, deck: d.deck, version: d.capability.version, generation: d.generation, nonce,
      adminOrigin: location.origin, contentOrigin: d.capability.origin,
      onSnapshot: snapshot => { if (ready && !applying) send('position', { index: snapshot.index, step: snapshot.step, blackout:!!snapshot.blackout }); },
      onFailure: () => send('failure'),
    });
    client.on('key', data => {
      if (data.type !== 'keydown' || data.repeat) return;
      if (data.key === 'Escape') window.close();
      else if (data.key === 'f') void fullscreen();
    });
    client.start(); frame.src = capabilityUrl(d.capability.url, { index:d.index, step:d.step, nonce, mode:'present', generation:d.generation }); document.body.prepend(frame);
    try { await client.ready; ready = true; pending ||= d; if (pending) { go(pending); await navigation; } frame.focus(); send('connected'); } catch { send('failure'); }
    new ResizeObserver(() => { if (ready) client.api.resize().catch(() => {}); }).observe(frame);
  } else if (d.type === 'go') {
    pending = d;
    if (ready) go(d);
  }
});
function keys(e) {
  if (e.target.closest?.('input,textarea,select,[contenteditable="true"]') || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (e.type === 'keydown' && !e.repeat) void fullscreen();
    return;
  }
  if (!['Escape','ArrowRight','ArrowDown','ArrowLeft','ArrowUp',' ','o','b','B','Enter','Backspace'].includes(e.key) && !/^[0-9]$/.test(e.key)) return;
  if (e.key === 'Enter' && !pendingInputs && !client?.snapshot?.pageInput && e.target.closest?.('button,a')) return;
  if (e.key === ' ' && e.target.closest?.('button,a')) return;
  e.preventDefault();
  // Route both phases through the player: arrows act on release, and Esc
  // closes its overview before the bridge asks us to close the window.
  if (ready) {
    const pendingInput = e.type === 'keydown' && !e.repeat && /^[0-9]$/.test(e.key);
    if (pendingInput) pendingInputs++;
    client.api.presentationKey(e.type,e.key,e.repeat).catch(() => send('failure')).finally(() => { if (pendingInput) pendingInputs--; });
  }
  else if (e.key === 'Escape' && e.type === 'keydown') window.close();
}
addEventListener('keydown', keys); addEventListener('keyup', keys);
addEventListener('beforeunload', () => send('closed'));
send('ready');
