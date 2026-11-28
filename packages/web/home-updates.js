import { api, toast } from './api.js';
import { S } from './strings.js';

export function showUpdateNotification(state) {
  const available = state.phase !== 'disabled' && Boolean(state.availableVersion);
  document.documentElement.dataset.updateAvailable = String(available);
  const description = document.getElementById('update-notification');
  if (description) description.textContent = available ? S.updates.available(state.availableVersion) : '';
}

export function installUpdateNotifications() {
  const description = document.createElement('span');
  description.id = 'update-notification';
  description.hidden = true;
  document.body.append(description);
  let timer, stopped = false;
  async function refresh() {
    try { const state = await api('/api/updates'); if (!stopped) showUpdateNotification(state); }
    catch { /* Keep a known update visible while the connection is unavailable. */ }
    if (!stopped) timer = setTimeout(refresh, 5000);
  }
  void refresh();
  addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); }, { once: true });
}

export function homeUpdates(root) {
  const text = S.updates;
  root.innerHTML = `<div class="sec-head"><h2>${text.title}</h2><span class="update-version"></span></div>
    <div class="update-panel">
      <p class="muted">${text.hint}</p>
      <p class="update-status" role="status" aria-live="polite"></p>
      <div class="update-actions"><button class="btn" data-update="check">${text.check}</button>
      <a class="btn primary" href="https://github.com/edoaki/slide-studio/releases" target="_blank" rel="noopener noreferrer">${text.download}</a></div>
    </div>`;
  let alive = true, pending = false, timer;
  function draw(state) {
    if (!alive) return;
    showUpdateNotification(state);
    root.querySelector('.update-version').textContent = state.version ? text.version(state.version) : '';
    root.querySelector('.update-status').textContent = state.phase === 'available' ? text.available(state.availableVersion)
      : state.phase === 'error' ? text.error : text[state.phase] || text.idle;
    root.querySelector('[data-update=check]').disabled = pending || ['disabled', 'checking'].includes(state.phase);
  }
  async function refresh() {
    try { if (!pending) draw(await api('/api/updates')); }
    catch { if (alive) root.querySelector('.update-status').textContent = text.error; }
    if (alive) timer = setTimeout(refresh, 2000);
  }
  async function act(action) {
    if (pending) return;
    pending = true;
    root.querySelectorAll('button,input').forEach(el => { el.disabled = true; });
    try { const state = await api('/api/updates', { method: 'POST', body: { action } }); pending = false; draw(state); }
    catch (error) { pending = false; toast(error.message); if (alive) draw(await api('/api/updates')); }
  }
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-update]')?.dataset.update;
    if (action) void act(action).catch(error => toast(error.message));
  });
  void refresh();
  return () => { alive = false; clearTimeout(timer); };
}
