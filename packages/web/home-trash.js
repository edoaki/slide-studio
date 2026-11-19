import { api, esc, toast } from './api.js';
import { S } from './strings.js';
import { dialog } from './themes.js';

export function trashDialog(reload) {
  const d = dialog(S.homeTrash.title);
  d.form.classList.add('home-trash-dialog');
  d.content.innerHTML = `<p role="status">${S.homeTrash.loading}</p>`;
  d.form.onsubmit = e => e.preventDefault();
  async function load() {
    const { items } = await api('/api/home/trash');
    if (!d.back.isConnected) return;
    d.content.innerHTML = items.length ? '<ul class="home-trash-list"></ul>' : `<p role="status">${S.homeTrash.empty}</p>`;
    for (const item of items) {
      const row = document.createElement('li');
      row.innerHTML = `<div><b>${esc(item.title)}</b><small>${esc(S.homeTrash.kinds[item.kind])} · ${esc(item.name)} · ${esc(S.homeTrash.deleted)} ${esc(new Date(item.deleted * 1000).toLocaleString('ja-JP'))}</small></div><button type="button" class="btn">${S.homeTrash.restore}</button>`;
      row.querySelector('button').onclick = async () => {
        const buttons = [...d.content.querySelectorAll('button')];
        buttons.forEach(b => { b.disabled = true; });
        d.form.querySelector('.error').textContent = '';
        try {
          await api('/api/home/trash', { method: 'POST', body: { id: item.id } });
          toast(S.homeTrash.restored); await reload(); await load();
        } catch (error) { d.form.querySelector('.error').textContent = error.message; }
        finally { buttons.forEach(b => { b.disabled = false; }); }
      };
      d.content.querySelector('ul').append(row);
    }
  }
  load().catch(error => { d.content.textContent = ''; d.form.querySelector('.error').textContent = error.message; });
  d.form.querySelector('[data-close]').focus();
  return d;
}
