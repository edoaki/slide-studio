import { api, esc } from './api.js';
import { S } from './strings.js';
const T = S.location;
export function mountLocation(root, close) {
root.classList.add('location-page');
root.innerHTML = `<header class="location-head"><h1 id="location-title">${T.title}</h1>${close ? `<button type="button" class="btn" data-close autofocus>${S.close}</button>` : `<a class="btn" href="/">${T.back}</a>`}</header><p>${T.hint}</p>
  <div class="location-recent"></div>
  <form><div class="seg" role="group">
    <button type="button" data-mode="new" aria-pressed="true">${T.new}</button>
    <button type="button" data-mode="existing" aria-pressed="false">${T.existing}</button>
  </div><label>${T.path}<input name="path" required autocomplete="off" spellcheck="false"></label>
  <div class="folders" hidden><div class="actions"><button type="button" data-act="up" class="btn">${T.up}</button></div>
    <div class="folder-path"></div><div class="folder-list"></div>
    <button type="button" data-act="select" class="btn">${T.select}</button></div>
  <div class="error" role="alert"></div><div class="actions">
    <button type="button" data-act="browse" class="btn">${T.browse}</button>
    <button type="submit" class="btn primary">${T.start}</button></div></form>`;
root.querySelector('[data-close]')?.addEventListener('click', close);
const form = root.querySelector('form'), input = form.elements.path;
let mode = 'new', current = null, busy = false;
// Keep async recent-folder rendering from moving the form during its first click.
form.inert = true; input.disabled = true;
const error = e => { root.querySelector('.error').textContent = e.message; };
async function browse(path) {
  const data = await api('/api/location/folders' + (path ? `?path=${encodeURIComponent(path)}` : ''));
  current = data;
  if (!input.value) input.value = data.suggested;
  root.querySelector('.folder-path').textContent = data.path;
  root.querySelector('.folders .folder-list').innerHTML = data.folders.map(name => `<button type="button" class="btn ghost" data-folder="${esc(name)}">${esc(name)}/</button>`).join('');
}
form.addEventListener('click', async e => {
  if (busy) return;
  try {
    const button = e.target.closest('button');
    if (button?.dataset.mode) {
      mode = button.dataset.mode;
      form.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
      root.querySelector('.error').textContent = '';
    }
    if (button?.dataset.folder) await browse(`${current.path}/${button.dataset.folder}`);
    const act = button?.dataset.act;
    if (act === 'browse') { await browse(current?.path); root.querySelector('.folders').hidden = false; }
    if (act === 'up') await browse(current.parent);
    if (act === 'select') {
      // 新規作成では選んだ親フォルダの下へ。入力済みの名前は維持する。
      const name = input.value.split('/').filter(Boolean).pop() || 'Slides';
      input.value = current.path + (mode === 'new' ? `/${name}` : '');
      root.querySelector('.folders').hidden = true;
      input.focus();
    }
  } catch (e) { error(e); }
});
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  const button = form.querySelector('[type=submit]');
  button.disabled = true; button.textContent = T.busy;
  try {
    const data = await api('/api/location', { method: 'POST', body: {mode, path: input.value} });
    if (!data.cancelled) location.assign(data.url);
  } catch (e) { error(e); }
  finally { busy = false; button.disabled = false; button.textContent = T.start; }
});
const initialBrowse = browse().catch(error);

const initialLocations = api('/api/location').then(data => {
  const recent = root.querySelector('.location-recent');
  const paths = data.recent.filter(path => path !== data.current);
  if (paths.length) {
    recent.innerHTML = `<h2>${T.recent}</h2><div class="folder-list">${paths.map(path => `<button type="button" class="btn ghost" data-path="${esc(path)}">${esc(path)}</button>`).join('')}</div>`;
    recent.onclick = e => {
      const path = e.target.closest('[data-path]')?.dataset.path;
      if (!path || busy) return;
      form.querySelector('[data-mode=existing]').click();
      input.value = path;
      form.requestSubmit();
    };
  }
}).catch(error);

Promise.allSettled([initialBrowse, initialLocations]).then(() => {form.inert = false; input.disabled = false;});

}

export function openLocationDialog() {
  if (document.querySelector('dialog.location-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'location-dialog';
  dialog.setAttribute('aria-labelledby', 'location-title');
  document.body.append(dialog);
  mountLocation(dialog, () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

if (location.pathname === '/location') mountLocation(document.querySelector('#root'));
