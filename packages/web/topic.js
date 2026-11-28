// トピックに割り当てた発表と、中の HTML・文献。
import { api, esc, onEvent, toast } from './api.js';
import { card, newDeckDialog } from './home.js';
import { svg } from './icons.js';
import { bibView } from './bib-view.js';
import { S } from './strings.js';
import { dialog } from './themes.js';
import { assetPreview } from './asset-preview.js';
import { navigate } from './app.js';

export function mountTopic(root, shelf) {
  document.title = `${shelf} · ${S.appName}`;
  document.body.className = 'home-page';
  root.innerHTML = `<div class="home">
    <header class="home-bar">
      <a class="ibtn" href="/" data-nav aria-label="${S.home}" data-tip="${S.home}">${svg('home')}</a>
      <h1 class="topic-title">${esc(shelf)}</h1><span class="grow"></span>
      <button class="btn danger" data-act="remove">${S.topic.remove}</button>
      <button class="btn primary" data-act="new">${S.topic.newDeck}</button>
    </header>
    <main class="home-main">
      <section><div class="sec-head"><h2>${S.decks}</h2></div><div class="cards"></div></section>
      <section><div class="sec-head"><h2>${S.topic.html}</h2></div><div class="topic-html"></div><p class="shared empty-note" hidden></p></section>
      <section class="topic-bib"></section>
    </main></div>`;
  let alive = true, generation = 0, preview = null;
  const bib = bibView(root.querySelector('.topic-bib'), {verify: async key => {
    await api(`/api/topic/${encodeURIComponent(shelf)}/bib/verify`, {method: 'POST', body: {key}});
    await load();
  }, save: async (key, fields, original) => {
    await api(`/api/topic/${encodeURIComponent(shelf)}/bib`, {method: 'PATCH', body: {key, fields, original}});
    await load();
  }});
  const html = root.querySelector('.topic-html');
  const fit = new ResizeObserver(entries => entries.forEach(e => e.target.style.setProperty('--s', e.contentRect.width / 960)));
  const visible = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) {
      const f = e.target.querySelector('iframe');
      f.src = f.dataset.src;
      visible.unobserve(e.target);
    }
  });
  async function load() {
    const current = ++generation;
    const data = await api(`/api/topic/${encodeURIComponent(shelf)}`);
    if (!alive || current !== generation) return;
    fit.disconnect(); visible.disconnect();
    const cards = root.querySelector('.cards');
    cards.replaceChildren(...data.recent.map(card));
    if (!data.recent.length) cards.innerHTML = `<p class="empty-note">${S.topic.noDecks}</p>`;
    html.replaceChildren();
    for (const item of data.html) {
      const entry = document.createElement('article');
      entry.className = 'card';
      const openLabel = esc(S.topic.htmlOpen(item.name));
      const deleteLabel = esc(S.topic.deleteHtml(item.name));
      entry.innerHTML = `<div class="topic-preview">
          <iframe ${item.kind === 'html' ? 'sandbox="allow-scripts"' : ''} tabindex="-1" aria-hidden="true" title="${esc(item.name)}" data-src="${esc(item.url)}"></iframe>
        </div>
        <button type="button" class="topic-item-open" aria-label="${openLabel}" aria-haspopup="dialog"></button>
        <div class="topic-item-info">
          <div><span class="name">${esc(item.name)}</span><div class="meta">${esc(item.decks.length ? S.topic.used(item.decks) : S.topic.unused)}</div></div>
          ${item.decks.length ? '' : `<button type="button" class="ibtn topic-item-delete" aria-label="${deleteLabel}" data-tip="${deleteLabel}">${svg('trash')}</button>`}
        </div>`;
      const opener = entry.querySelector('.topic-item-open');
      opener.onclick = () => { preview?.close(); preview = assetPreview(item, opener); };
      const remove = entry.querySelector('.topic-item-delete');
      if (remove) remove.onclick = () => deleteHtml(item);
      const frame = entry.querySelector('iframe');
      if (item.kind === 'figure') frame.onload = () => {
        const origin = new URL(item.url, location.href).origin;
        frame.contentWindow?.postMessage({channel: 'slide-studio-asset-preview', action: 'visible'}, origin);
      };
      const thumbnail = entry.querySelector('.topic-preview');
      html.append(entry);
      fit.observe(thumbnail); visible.observe(thumbnail);
    }
    if (!data.html.length) html.innerHTML = `<p class="empty-note">${S.topic.noHtml}</p>`;
    bib.update(data);
    const shared = root.querySelector('.shared');
    shared.hidden = !data.shared_count;
    shared.textContent = data.shared_count ? S.topic.shared(data.shared_count) : '';
  }
  function deleteHtml(item) {
    const d = dialog(S.topic.deleteHtml(item.name));
    d.content.innerHTML = `<p>${esc(S.topic.deleteHtmlConfirm(item.name))}</p><div class="df"><button type="button" class="btn" data-cancel>${S.cancel}</button><button class="btn danger" type="submit">${S.as.remove}</button></div>`;
    d.content.querySelector('[data-cancel]').onclick = d.close;
    d.form.onsubmit = async e => {
      e.preventDefault();
      const button = d.form.querySelector('[type=submit]'); button.disabled = true;
      try {
        await api(`/api/topic/${encodeURIComponent(shelf)}/html/delete`, {method: 'POST', body: {paths: [item.path]}});
        d.close(); await load();
      } catch (err) { d.form.querySelector('.error').textContent = S.topic.errors[err.message] || err.message; }
      finally { button.disabled = false; }
    };
  }
  root.querySelector('[data-act=remove]').onclick = () => {
    const d = dialog(S.topic.remove);
    d.content.innerHTML = `<p>${esc(S.topic.removeConfirm(shelf))}</p><div class="df"><button type="button" class="btn" data-cancel>${S.cancel}</button><button class="btn danger" type="submit">${S.topic.remove}</button></div>`;
    d.content.querySelector('[data-cancel]').onclick = d.close;
    d.form.onsubmit = async e => {
      e.preventDefault();
      const button = d.form.querySelector('[type=submit]');
      button.disabled = true;
      try {
        await api(`/api/topic/${encodeURIComponent(shelf)}`, { method: 'DELETE' });
        d.close();
        if (alive) { navigate('/'); toast(S.topic.removed); }
      } catch (err) {
        d.form.querySelector('.error').textContent = S.topic.errors[err.message] || err.message;
      } finally { button.disabled = false; }
    };
  };
  root.querySelector('[data-act=new]').onclick = async e => {
    const button = e.currentTarget; button.disabled = true;
    try {
      const data = await api('/api/home');
      if (alive) newDeckDialog(data, { shelf });
    } catch (err) { if (alive) toast(err.message); }
    finally { button.disabled = false; }
  };
  const refresh = () => load().catch(e => { if (alive) toast(e.message); });
  const off = onEvent(e => { if (e.type === 'files') refresh(); });
  refresh();
  return () => {
    alive = false; preview?.close(); off(); fit.disconnect(); visible.disconnect();
    document.querySelectorAll('.dialog-back').forEach(d => d.remove());
  };
}
