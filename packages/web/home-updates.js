import { api, toast } from './api.js';
import { S } from './strings.js';

export function homeUpdates(root) {
  const text = S.updates;
  root.innerHTML = `<div class="sec-head"><h2>${text.title}</h2><span class="update-version"></span></div>
    <div class="update-panel">
      <label class="update-choice"><input type="checkbox">${text.automatic}</label>
      <p class="muted">${text.hint}</p>
      <p class="update-status" role="status" aria-live="polite"></p>
      <div class="update-actions"><button class="btn" data-update="check">${text.check}</button>
      <button class="btn primary" data-update="download" hidden>${text.download}</button>
      <button class="btn primary" data-update="install" hidden>${text.install}</button></div>
    </div>`;
  const checkbox = root.querySelector('input');
  let alive = true, pending = false, timer;
  function draw(state) {
    if (!alive) return;
    checkbox.checked = state.automatic;
    checkbox.disabled = pending || state.phase === 'disabled';
    root.querySelector('.update-version').textContent = state.version ? text.version(state.version) : '';
    root.querySelector('.update-status').textContent = state.phase === 'downloading' ? text.progress(state.progress)
      : state.phase === 'available' ? text.available(state.availableVersion)
      : state.phase === 'error' ? text.error
      : state.phase === 'ready' ? (state.automatic ? text.readyAutomatic : text.ready)
      : text[state.phase] || text.idle;
    root.querySelector('[data-update=check]').disabled = pending || ['disabled', 'checking', 'downloading', 'ready'].includes(state.phase);
    root.querySelector('[data-update=download]').hidden = state.phase !== 'available';
    root.querySelector('[data-update=install]').hidden = state.phase !== 'ready';
    root.querySelector('[data-update=download]').disabled = pending;
    root.querySelector('[data-update=install]').disabled = pending;
  }
  async function refresh() {
    try { if (!pending) draw(await api('/api/updates')); }
    catch { if (alive) root.querySelector('.update-status').textContent = text.error; }
    if (alive) timer = setTimeout(refresh, 2000);
  }
  async function act(action, value) {
    if (pending) return;
    pending = true;
    root.querySelectorAll('button,input').forEach(el => { el.disabled = true; });
    try { const state = await api('/api/updates', { method: 'POST', body: { action, value } }); pending = false; draw(state); }
    catch (error) { pending = false; toast(error.message); if (alive) draw(await api('/api/updates')); }
  }
  checkbox.onchange = () => { void act('automatic', checkbox.checked).catch(error => toast(error.message)); };
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-update]')?.dataset.update;
    if (action) void act(action).catch(error => toast(error.message));
  });
  void refresh();
  return () => { alive = false; clearTimeout(timer); };
}
