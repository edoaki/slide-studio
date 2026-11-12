// トピックに割り当てた発表と、中の HTML・文献。
import { api, esc, onEvent, toast } from './api.js';
import { card, newDeckDialog } from './home.js';
import { svg } from './icons.js';
import { bibView } from './bib-view.js';
import { S } from './strings.js';
import { dialog } from './themes.js';
import { assetPreview, longPress } from './asset-preview.js';
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
      <section><div class="sec-head"><h2>${S.topic.html}</h2><span class="grow"></span><span class="topic-selected"></span><button class="btn" data-act="select-html">${S.as.startSelection}</button><button class="btn danger" data-act="delete-html" disabled>${S.topic.deleteHtml}</button></div><div class="topic-html"></div><p class="shared empty-note"></p></section>
      <section class="topic-bib"></section>
    </main></div>`;
  let alive = true, generation = 0, selecting = false, preview = null;
  const selected = new Set();
  const updateSelection = () => {
    root.querySelector('[data-act=select-html]').textContent = selecting ? S.as.selectNone : S.as.startSelection;
    root.querySelector('[data-act=delete-html]').hidden = !selecting;
    root.querySelectorAll('.topic-html .card').forEach(c => {
      const check = c.querySelector('input'); check.hidden = !selecting; check.checked = selected.has(c.dataset.path);
      c.classList.toggle('sel', check.checked);
    });
    root.querySelector('.topic-selected').textContent = selected.size ? S.topic.selected(selected.size) : '';
    root.querySelector('[data-act=delete-html]').disabled = !selected.size;
  };
  const bib = bibView(root.querySelector('.topic-bib'), {verify: async key => {
    await api(`/api/topic/${encodeURIComponent(shelf)}/bib/verify`, {method: 'POST', body: {key}});
    await load();
  }, save: async (key, fields, original) => {
    await api(`/api/topic/${encodeURIComponent(shelf)}/bib`, {method: 'PATCH', body: {key, fields, original}});
    await load();
  }});
  // HTML は3段まで。入りきらない分は横にスクロールする（列の幅は折り返すときと同じ）
  const html = root.querySelector('.topic-html');
  const MIN = 280, GAP = 22;
  const rows = () => {
    const n = html.querySelectorAll('.card').length, w = html.parentElement.clientWidth;
    const fits = Math.max(1, Math.floor((w + GAP) / (MIN + GAP)));
    html.classList.toggle('scroll', n > fits * 3);
    html.style.setProperty('--cols', Math.ceil(n / 3));
    html.style.setProperty('--col', `${(w - GAP * (fits - 1)) / fits}px`);
  };
  const resize = new ResizeObserver(rows);
  resize.observe(html.parentElement);
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
      const a = document.createElement('article');
      a.className = 'card'; a.tabIndex = 0; a._item = item;
      a.dataset.path = item.path;
      a.innerHTML = `<div class="topic-item-head"><div><input type="checkbox" aria-label="${esc(S.topic.selectHtml(item.name))}"> <span class="name">${esc(item.name)}</span></div></div>
        <div class="meta topic-usage">${esc(item.decks.length ? S.topic.used(item.decks) : S.topic.unused)}</div>
        <div class="topic-steps"></div>`;
      const activate = () => {
        if (selecting) { selected.has(item.path) ? selected.delete(item.path) : selected.add(item.path); updateSelection(); }
        else { preview?.close(); preview = assetPreview(item, a); }
      };
      a.onclick = e => { if (e.target.tagName !== 'INPUT') activate(); };
      a.onkeydown = e => { if (e.target === a && ['Enter', ' '].includes(e.key)) { e.preventDefault(); activate(); } };
      const check = a.querySelector('input');
      check.checked = selected.has(item.path);
      check.onchange = () => { if (check.checked) selected.add(item.path); else selected.delete(item.path); updateSelection(); };
      const strip = a.querySelector('.topic-steps');
      for (let step = 0; step < Math.max(1, item.steps); step++) {
        const thumb = document.createElement('div');
        thumb.className = 'topic-step';
        thumb.innerHTML = `<div class="topic-preview"><iframe ${item.kind === 'html' ? 'sandbox="allow-scripts"' : ''} tabindex="-1" aria-hidden="true" title="${esc(item.name)}" data-src="${esc(item.url)}"></iframe></div>${item.steps ? `<div class="meta">${S.topic.step(step + 1)}</div>` : ''}`;
        const frame = thumb.querySelector('iframe');
        if (item.kind === 'figure') frame.onload = () => {
          const animation = frame.contentWindow?.animation;
          animation?.setVisible(true);
          animation?.setStep(step, false);
        };
        strip.append(thumb);
        const preview = thumb.querySelector('.topic-preview');
        fit.observe(preview); visible.observe(preview);
      }
      html.append(a);
    }
    if (!data.html.length) html.innerHTML = `<p class="empty-note">${S.topic.noHtml}</p>`;
    const paths = new Set(data.html.map(item => item.path));
    for (const path of selected) if (!paths.has(path)) selected.delete(path);
    updateSelection();
    rows();
    bib.update(data);
    root.querySelector('.shared').textContent = S.topic.shared(data.shared_count);
  }
  const stopHold = longPress(html, '.card', () => !selecting, c => { selecting = true; selected.add(c.dataset.path); updateSelection(); });
  root.querySelector('[data-act=select-html]').onclick = () => { selecting = !selecting; selected.clear(); updateSelection(); };
  html.addEventListener('keydown', e => { if (e.key === 'Escape') { selecting = false; selected.clear(); updateSelection(); } });
  root.querySelector('[data-act=delete-html]').onclick = () => {
    const paths = [...selected];
    const d = dialog(S.topic.deleteHtml);
    d.content.innerHTML = `<p>${S.topic.deleteHtmlConfirm}</p><ul>${paths.map(p => `<li>${esc(p)}</li>`).join('')}</ul><div class="df"><button type="button" class="btn" data-cancel>${S.cancel}</button><button class="btn danger" type="submit">${S.topic.deleteHtml}</button></div>`;
    d.content.querySelector('[data-cancel]').onclick = d.close;
    d.form.onsubmit = async e => {
      e.preventDefault();
      const button = d.form.querySelector('[type=submit]'); button.disabled = true;
      try {
        await api(`/api/topic/${encodeURIComponent(shelf)}/html/delete`, {method: 'POST', body: {paths}});
        paths.forEach(p => selected.delete(p));
        d.close(); await load();
      } catch (err) { d.form.querySelector('.error').textContent = S.topic.errors[err.message] || err.message; }
      finally { button.disabled = false; }
    };
  };
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
    alive = false; stopHold(); preview?.close(); off(); fit.disconnect(); visible.disconnect(); resize.disconnect();
    document.querySelectorAll('.dialog-back').forEach(d => d.remove());
  };
}
