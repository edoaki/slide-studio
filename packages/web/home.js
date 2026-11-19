// ホーム：発表の一覧・新しい発表・トピック・動作環境。
import { api, esc, onEvent, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { navigate } from './app.js';
import { themeCards, dialog } from './themes.js';
import { homeManage } from './home-manage.js';
import { trashDialog } from './home-trash.js';
import { presentationList } from './home-list.js';

const ago = t => {
  if (!t) return '';
  const d = new Date(t * 1000), now = new Date(), min = Math.floor((now - d) / 60000);
  if (min < 1) return S.ago.now;
  if (min < 60) return S.ago.min(min);
  const day = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (day === 0) return S.ago.hour(Math.floor(min / 60));
  if (day === 1) return S.ago.yesterday;
  if (day < 7) return S.ago.day(day);
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

export function card(d) {
  const b = document.createElement('button');
  b.className = 'card'; b.dataset.tip = S.topic.open(d.deck);
  const shots = d.shots || [], n = shots.length, track = n > 30;
  b.innerHTML = `<div class="thumb">${n ? `<img alt="" src="${esc(shots[0])}">`
    : `<div class="cover"><i></i><span>${esc(d.title)}</span></div>`}</div>
    <div class="ticks${track ? ' track' : ''}">${track ? '<b></b>' : n > 1 ? '<i class="on"></i>' + '<i></i>'.repeat(n - 1) : '<i></i>'}</div>
    <div class="name">${esc(d.title)}</div>
    <div class="meta">${d.shelf ? `<span>${esc(d.shelf)}</span><span class="sep">·</span>` : ''}<span>${esc(ago(d.modified))}</span></div>`;
  b.onclick = () => navigate(`/deck/${encodeURIComponent(d.deck)}`);
  if (n < 2) return b;
  // カーソルを左右に動かすとページがめくれる（サムネイルの幅をページ数で等分）
  const img = b.querySelector('img'), ticks = [...b.querySelectorAll('.ticks i')], bar = b.querySelector('.ticks b');
  let cur = -1;
  const show = i => {
    if (i === cur) return;
    cur = i; img.src = shots[i];
    ticks.forEach((t, k) => t.classList.toggle('on', k === i));
    if (bar) Object.assign(bar.style, { left: `${i / n * 100}%`, width: `${100 / n}%` });
  };
  show(0);
  b.addEventListener('pointerenter', () => shots.forEach(s => { new Image().src = s; }), { once: true });
  b.addEventListener('pointermove', e => {
    const r = b.querySelector('.thumb').getBoundingClientRect();
    show(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left) / r.width * n))));
  });
  b.addEventListener('pointerleave', () => show(0));
  return b;
}

// 見出しの横の［＋］。一覧の読み込み後に表示する（load）。
const add = (act, label) => `<button class="ibtn sec-add" data-act="${act}" aria-label="${label}" data-tip="${label}" hidden>${svg('plus')}</button>`;

export function mountHome(root) {
  document.title = 'Slide Studio';
  document.body.className = 'home-page';
  root.innerHTML = `
  <div class="home">
    <header class="home-bar">
      <div class="brand">${svg('logo')}${S.appName}</div>
      <span class="grow"></span>
      <button class="ibtn" data-act="trash" aria-label="${S.homeTrash.title}" data-tip="${S.homeTrash.title}">${svg('trash')}</button>
      <button class="ibtn" data-open-settings aria-haspopup="dialog" aria-label="${S.settings.title}" data-tip="${S.settings.title}">${svg('settings')}</button>
    </header>
    <main class="home-main">
      <section>
        <div class="sec-head"><h2>${S.decks}</h2><button type="button" class="ibtn home-sort-trigger" aria-label="${S.homeList.sort}" data-tip="${S.homeList.sort}" aria-haspopup="menu" aria-expanded="false">${svg('sort')}</button>${add('new', S.newDeck)}<div class="home-sort-menu" popover="auto" role="menu" aria-label="${S.homeList.sort}">${Object.entries(S.homeList.sorts).map(([value,label]) => `<button type="button" role="menuitemradio" data-sort="${value}" aria-checked="${value === 'opened'}">${svg('check')}<span>${label}</span></button>`).join('')}</div></div>
        <p class="empty-note home-no-results" role="status" hidden>${S.homeList.empty}</p><div class="cards"></div>
      </section>
      <section>
        <div class="sec-head"><h2>${S.libraries}</h2>${add('topic', S.topic.create)}</div>
        <div class="libs"></div>
      </section>
      <section><div class="sec-head"><h2>${S.agents.title}</h2></div><a class="agent-home-card" href="/agents" data-nav data-tip="${S.agents.open}">${svg('sparkles')}<span><b>${S.agents.open}</b><small>${S.agents.homeHint}</small></span>${svg('chevR')}</a></section>
      <section><div class="sec-head"><h2>${S.themes.title}</h2></div><div class="theme-cards"></div></section>

    </main>
  </div>`;
  const $ = s => root.querySelector(s);
  let data = null, alive = true, loadSequence = 0, sort = 'opened';
  const sortButton = $('.home-sort-trigger'), sortMenu = $('.home-sort-menu');
  sortButton.onclick = () => {
    if (sortMenu.matches(':popover-open')) { sortMenu.hidePopover(); return; }
    const r = sortButton.getBoundingClientRect();
    sortMenu.style.top = `${r.bottom + 6}px`; sortMenu.style.left = `${Math.max(8, r.right - 180)}px`;
    sortMenu.showPopover(); sortMenu.querySelector('[aria-checked=true]').focus();
  };
  sortMenu.addEventListener('toggle', () => sortButton.setAttribute('aria-expanded', String(sortMenu.matches(':popover-open'))));
  sortMenu.onclick = e => {
    const option = e.target.closest('[data-sort]'); if (!option) return;
    sort = option.dataset.sort;
    sortMenu.querySelectorAll('[data-sort]').forEach(b => b.setAttribute('aria-checked', String(b === option)));
    sortButton.dataset.tip = `${S.homeList.sort} · ${S.homeList.sorts[sort]}`;
    drawPresentations(); sortMenu.hidePopover(); sortButton.focus();
  };
  sortMenu.onkeydown = e => {
    if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
    e.preventDefault(); const items = [...sortMenu.querySelectorAll('button')], i = items.indexOf(document.activeElement);
    items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  };
  const actions = homeManage(root, load);



  async function load() {
    const sequence=++loadSequence;
    const [d, themes] = await Promise.all([api('/api/home'), api('/api/themes')]);
    if (!alive || sequence!==loadSequence) return;
    data = d;
    data.themeDetails = themes.themes;
    themeCards($('.theme-cards'), themes.themes, theme => newDeckDialog(data, { theme }), undefined, () => load());
    $('[data-act=new]').hidden = false;
    $('[data-act=topic]').hidden = data.shelves.some(s => s.empty);
    drawPresentations();
    const libs = $('.libs');
    libs.innerHTML = data.shelves.length ? '' : `<p class="empty-note">${S.noLibraries}</p>`;
    for (const s of data.shelves) {
      const used = data.recent.filter(r => r.shelf === s.name).length;
      const el = document.createElement('button');
      el.className = 'lib';
      el.dataset.tip = S.topic.open(s.name);
      el.onclick = () => navigate(`/topic/${encodeURIComponent(s.name)}`);
      el.innerHTML = `<span class="lib-icon">${svg('shapes')}</span><div class="body"><div class="name">${esc(s.name)}</div>
        <div class="counts"><span>${svg('shapes')}${esc(S.figuresCount(s.count))}</span><span>${svg('presentation')}${esc(S.decksCount(used))}</span></div></div>`;
      libs.append(el);
    }
  }
  function drawPresentations() {
    if (!data) return;
    const rows = presentationList(data.recent, '', sort);
    $('.cards').replaceChildren(...rows.map(d => actions.card(card(d), d)));
    $('.home-no-results').hidden = rows.length > 0;
  }
  root.onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'new' && data) newDeckDialog(data);
      if (act === 'topic') newTopic(load);
      if (act === 'trash') trashDialog(async () => { actions.clearUndo(); await load(); });
    } catch (err) { toast(err.message); }
  };
  load().catch(e => toast(e.message));
  const off = onEvent(ev => { if (['files', 'theme-shots', 'chat', 'chat-round'].includes(ev.type)) load().catch(e => toast(e.message)); });
  return () => { alive = false; actions.destroy(); off(); root.onclick = null; document.querySelector('dialog.location-dialog')?.close(); document.querySelectorAll('.dialog-back').forEach(d => d.remove()); };
}

function newTopic(done) {
  const d = dialog(S.topic.create);
  d.content.innerHTML = `<label>${S.topic.name}<input name="name" required pattern="[a-z0-9][a-z0-9-]*" autocomplete="off" spellcheck="false"></label><div class="df"><button class="btn primary">${S.create}</button></div>`;
  d.form.onsubmit = async e => {
    e.preventDefault(); const b = d.form.querySelector('button.btn'); b.disabled = true;
    try { await api('/api/topics', { method: 'POST', body: { name: d.form.elements.name.value } }); d.close(); await done(); }
    catch (err) { d.form.querySelector('.error').textContent = err.message; }
    finally { b.disabled = false; }
  };
  d.form.elements.name.focus();
}

// 新しい発表（空から・既存の発表を複製）。メモからは、空から作って下書きに書き「スライドにして」と頼む（設計書 §8.5）
export function newDeckDialog(data, extra = {}) {
  const back = document.createElement('div');
  back.className = 'dialog-back';
  const prefs = data.prefs || {};
  const shelves = data.shelves.map(s => s.name);
  const selected = [extra.shelf, prefs.shelf, ...data.recent.map(d => d.shelf), shelves[0]].find(s => shelves.includes(s));
  back.innerHTML = `<form class="dialog" role="dialog" aria-modal="true" aria-label="${S.newDeck}">
    <div class="dh"><h3>${S.newDeck}</h3><button type="button" class="ibtn" data-act="cancel" aria-label="${S.close}" data-tip="${S.close}">${svg('x')}</button></div>
    <div class="seg" role="group">
      <button type="button" data-mode="empty" aria-pressed="true">${S.newEmpty}</button>
      <button type="button" data-mode="copy" aria-pressed="false" ${data.recent.length ? '' : 'disabled'}>${S.newCopy}</button>
      ${extra.modes || ''}
    </div>
    <label class="from" hidden>${S.copyFrom}<select name="from" aria-label="${S.copyFrom}">${data.recent.map(d => `<option value="${esc(d.deck)}">${esc(d.title)}（${esc(d.deck)}）</option>`).join('')}</select></label>
    <label>${S.deckTitle}<input name="title" autocomplete="off"></label>
    <div class="two">
      <div>
        <label ${shelves.length ? '' : 'hidden'}>${S.library}<select name="shelf">${shelves.map(s => `<option value="${esc(s)}"${s === selected ? ' selected' : ''}>${esc(s)}</option>`).join('')}<option value=""${shelves.length ? '' : ' selected'}>${S.topic.new}</option></select></label>
        <label class="new-shelf">${S.topic.name}<input name="newShelf" required pattern="[a-z0-9][a-z0-9-]*" autocomplete="off" spellcheck="false"></label>
      </div>
      <label>${S.deckName}<input name="name" pattern="[a-z0-9][a-z0-9-]*" autocomplete="off" spellcheck="false"></label>
      <input type="hidden" name="theme" value="${esc(extra.theme || prefs.theme || 'default')}">
    </div>
    <div>${S.theme}<div class="theme-row"></div>
    </div>
    ${extra.fields || ''}
    <div class="error" role="alert"></div>
    <div class="df"><button type="button" class="btn ghost" data-act="cancel">${S.cancel}</button><button class="btn primary">${S.create}</button></div>
  </form>`;
  document.body.append(back);
  const form = back.querySelector('form');
  const drawThemes = themes => themeCards(form.querySelector('.theme-row'), themes, name => {
    form.elements.theme.value = name; drawThemes(themes);
  }, form.elements.theme.value);
  drawThemes(data.themeDetails || data.themes.map(name => ({ name })));
  api('/api/themes').then(d => { if (back.isConnected) drawThemes(d.themes); }).catch(e => toast(e.message));
  const shelfSelect = form.elements.shelf, newShelf = form.elements.newShelf;
  const updateShelf = () => {
    const creating = !shelfSelect.value;
    form.querySelector('.new-shelf').hidden = !creating;
    newShelf.disabled = !creating;
  };
  // フォルダ名は「作った日-トピック」を入れておく（同じものがあれば番号を足す）。書き換えたらそのまま使い、消すと戻す
  const folder = form.elements.name, taken = new Set(data.recent.map(d => d.deck));
  let autoFolder = true;
  const suggestFolder = () => {
    const now = new Date(), topic = shelfSelect.value || (newShelf.validity.valid ? newShelf.value : '');
    const base = [`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, topic].filter(Boolean).join('-');
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    folder.placeholder = name;
    if (autoFolder) folder.value = name;
  };
  folder.addEventListener('input', () => { autoFolder = !folder.value; });
  shelfSelect.addEventListener('change', () => { updateShelf(); suggestFolder(); });
  newShelf.addEventListener('input', suggestFolder);
  updateShelf(); suggestFolder();
  let mode = 'empty';
  const setMode = m => {
    mode = m;
    form.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    form.querySelector('.from').hidden = m !== 'copy';
    extra.onMode?.(form, m);
  };
  const offThemes = onEvent(ev => {
    if (ev.type === 'theme-shots') api('/api/themes').then(d => { if (back.isConnected) drawThemes(d.themes); }).catch(e => toast(e.message));
  });
  const close = () => { offThemes(); back.remove(); removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', onKey);
  form.addEventListener('click', e => {
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (m) setMode(m);
    if (e.target.closest('[data-act="cancel"]')) close();
  });
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    const submit = form.querySelector('button:not([type])');
    submit.disabled = true;
    const f = new FormData(form);
    const body = { name: f.get('name') || folder.placeholder, title: f.get('title'), shelf: f.get('shelf') || f.get('newShelf'), theme: f.get('theme'), from: mode === 'copy' ? f.get('from') : null };
    try {
      if (extra.submit) await extra.submit(mode, body, f);
      else await api('/api/new', { method: 'POST', body });
      close();
      if (!extra.submit) navigate(`/deck/${encodeURIComponent(body.name)}`);
    } catch (err) { form.querySelector('.error').textContent = err.message; }
    finally { delete form.dataset.busy; submit.disabled = false; }
  });
  setMode('empty');
  form.querySelector('input[name=title]').focus();
  return back;
}
