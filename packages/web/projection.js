import { AgentClient, capabilityUrl, createNonce } from './bridge/agent-client.js';
import { HOST_KEYS, PRESENTATION_KEYS, validatePointer } from './bridge/protocol.js';
import { pointerPrefs, paintPointer } from './presentation-model.js';
import { S } from './strings.js';
const id = location.hash.slice(1), owner = window.opener;
// 一覧（o）とページ番号の入力（数字・Enter・Backspace）は発表者ビューへ送る。投影には一覧も入力中の番号も出さない。
// 数字を送った直後の Enter は、ボタンにフォーカスがあっても番号の決定として送る
let typing = false;
function toPresenter(type, key, repeat) {
  if (type === 'keydown') typing = /^[0-9]$/.test(key) || key === 'Backspace' && typing;
  send('key', { event: type, key, repeat: !!repeat });
}
let client, ready = false, pending, applying = 0, navigation = Promise.resolve();
function go(d) {
  navigation = navigation.then(async () => {
    applying++;
    try {
      if (client.snapshot.index !== d.index || client.snapshot.step !== d.step) await client.api.go(d.index,d.step);
    } finally { applying--; }
  }).catch(() => send('failure'));
}
const send = (type, data = {}) => owner?.postMessage({ speakerProjection: id, type, ...data }, location.origin);
async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch {} }
// 発表者ビューのカーソルをポインターとして重ねる。スライドの操作は妨げない（pointer-events:none）
const laser = document.createElement('div'); laser.className = 'projection-pointer'; laser.hidden = true; laser.setAttribute('aria-hidden','true');
document.body.append(laser);
let pointerStyle = pointerPrefs(null), pointerAt = {x:0,y:0,visible:false};
function drawPointer() {
  paintPointer(laser,pointerStyle,{...pointerAt,visible:pointerAt.visible},{left:0,top:0,width:innerWidth,height:innerHeight});
}
addEventListener('resize', drawPointer);
const button = document.querySelector('#projectionFullscreen'); button.textContent = S.speaker.fullscreen; button.onclick = fullscreen;
addEventListener('message', async e => {
  if (e.source !== owner || e.origin !== location.origin || e.data?.speakerProjection !== id) return;
  const d = e.data;
  if (d.type === 'init' && !client) {
    const frame = document.createElement('iframe'); frame.title = S.speaker.projectionTitle; frame.allowFullscreen = true;
    const nonce = createNonce();
    client = new AgentClient({ frame, deck: d.deck, version: d.capability.version, generation: d.generation, nonce,
      adminOrigin: location.origin, contentOrigin: d.capability.origin,
      onSnapshot: snapshot => { if (ready && !applying) send('position', { index: snapshot.index, step: snapshot.step }); },
      onFailure: () => send('failure'),
    });
    client.on('key', data => {
      if (HOST_KEYS.includes(data.key)) { toPresenter(data.type, data.key, data.repeat); return; }
      if (data.type !== 'keydown' || data.repeat) return;
      if (data.key === 'Escape') window.close();
      else if (data.key === 'f') void fullscreen();
    });
    client.start(); frame.src = capabilityUrl(d.capability.url, { index:d.index, step:d.step, nonce, mode:'present', generation:d.generation, hostKeys:true }); document.body.prepend(frame);
    try { await client.ready; ready = true; pending ||= d; if (pending) { go(pending); await navigation; } frame.focus(); send('connected'); } catch { send('failure'); }
    new ResizeObserver(() => { if (ready) client.api.resize().catch(() => {}); }).observe(frame);
  } else if (d.type === 'go') {
    pending = d;
    if (ready) go(d);
  } else if (d.type === 'pointer') {
    const point = {x:d.x,y:d.y,visible:d.visible};
    if (validatePointer(point)) { pointerAt = point; drawPointer(); }
  } else if (d.type === 'pointerStyle') {
    pointerStyle = pointerPrefs(d); drawPointer();
  }
});
function keys(e) {
  if (e.target.closest?.('input,textarea,select,[contenteditable="true"]') || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (e.type === 'keydown' && !e.repeat) void fullscreen();
    return;
  }
  if (!PRESENTATION_KEYS.includes(e.key)) return;
  if (e.key === 'Enter' && !typing && e.target.closest?.('button,a')) return;
  if (e.key === ' ' && e.target.closest?.('button,a')) return;
  e.preventDefault();
  if (HOST_KEYS.includes(e.key)) { toPresenter(e.type, e.key, e.repeat); return; }
  if (e.type === 'keydown') typing = false;
  // Route both phases through the player: arrows act on release, and Esc
  // closes its overview before the bridge asks us to close the window.
  if (ready) client.api.presentationKey(e.type,e.key,e.repeat).catch(() => send('failure'));
  else if (e.key === 'Escape' && e.type === 'keydown') window.close();
}
addEventListener('keydown', keys); addEventListener('keyup', keys);
addEventListener('beforeunload', () => send('closed'));
send('ready');
