import { api, esc } from './api.js';
import { S } from './strings.js';
const T = S.location;
const root = document.querySelector('#root');
root.className = 'location-page';
root.innerHTML = `<div class="brand">${S.appName}</div><h1>${T.title}</h1><p>${T.hint}</p>
  <div class="location-current"></div><div class="location-recent"></div>
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
const form = root.querySelector('form'), input = form.elements.path;
let mode = 'new', current = null, busy = false;
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
    location.assign(data.url);
  } catch (e) { error(e); }
  finally { busy = false; button.disabled = false; button.textContent = T.start; }
});
browse().catch(error);

api('/api/location').then(data => {
  if (data.current) {
    root.querySelector('.location-current').innerHTML = `<p>${T.current}: ${esc(data.current)}</p><a class="btn" href="/">${T.back}</a>`;
  }
  const recent = root.querySelector('.location-recent');
  if (data.recent.length) {
    recent.innerHTML = `<h2>${T.recent}</h2><div class="folder-list">${data.recent.map(path => `<button type="button" class="btn ghost" data-path="${esc(path)}">${esc(path)}</button>`).join('')}</div>`;
    recent.onclick = e => {
      const path = e.target.closest('[data-path]')?.dataset.path;
      if (!path || busy) return;
      form.querySelector('[data-mode=existing]').click();
      input.value = path;
      form.requestSubmit();
    };
  }
}).catch(error);
