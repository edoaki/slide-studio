// ホーム：発表の一覧・新しい発表・トピック・動作環境。
import { api, esc, onEvent, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { navigate } from './app.js';
import { themeCards, dialog } from './themes.js';
import { homeManage } from './home-manage.js';
import { homeAi } from './home-ai.js';

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

// 見出しのすぐ横の［＋］。作ったまま手を入れていないものがある欄では隠す（load）
const add = (act, label) => `<button class="ibtn sec-add" data-act="${act}" aria-label="${label}" data-tip="${label}" hidden>${svg('plus')}</button>`;

export function mountHome(root) {
  document.title = 'Slide Studio';
  document.body.className = 'home-page';
  root.innerHTML = `
  <div class="home">
    <header class="home-bar">
      <div class="brand">${svg('logo')}${S.appName}</div>
      <span class="grow"></span>
      <button class="btn" data-act="location">${S.location.manage}</button>
      <div class="env-wrap">
        <button class="env-btn" data-act="env" aria-label="${S.env}" data-tip="${S.envOk}" aria-haspopup="dialog" aria-expanded="false">${svg('activity')}<span>${S.env}</span>${svg('chevD')}</button>
        <div class="env-pop" role="dialog" aria-label="${S.env}" hidden>
          <div class="pop-head"><b>${S.env}</b><button class="ibtn" data-act="refresh" aria-label="${S.refresh}" title="${S.refresh}">${svg('refresh')}</button></div>
          <h3 class="env-section">${S.envTools}</h3>
          <ul class="env-list"><li class="muted">${S.status.loading}</li></ul>
          <h3 class="env-section env-ai-title">${S.envAi}</h3>
          <ul class="env-list env-ai"><li class="muted">${S.status.loading}</li></ul>
          <div class="env-root"><span>${S.root}</span><code></code></div>
        </div>
      </div>
    </header>
    <main class="home-main">
      <section>
        <div class="sec-head"><h2>${S.decks}</h2>${add('new', S.newDeck)}</div>
        <div class="cards"></div>
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
  let data = null, alive = true;
  const actions = homeManage(root, load);
  const ai = homeAi($('.env-ai'));


  async function load() {
    const [d, themes] = await Promise.all([api('/api/home'), api('/api/themes')]);
    if (!alive) return;
    data = d;
    data.themeDetails = themes.themes;
    themeCards($('.theme-cards'), themes.themes, theme => newDeckDialog(data, { theme }), undefined, () => load());
    $('[data-act=new]').hidden = data.recent.some(d => d.blank);
    $('[data-act=topic]').hidden = data.shelves.some(s => s.empty);
    $('.env-root code').textContent = data.root;
    const cards = $('.cards');
    cards.textContent = '';
    for (const d of data.recent) cards.append(actions.card(card(d), d));
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
  async function loadEnv(refresh = false) {
    const env = await api('/api/env' + (refresh ? '?refresh=1' : ''));
    if (!alive) return;
    const ng = env.items.filter(i => !i.ok);
    $('.env-list').innerHTML = env.items.map(i => `<li><span class="${i.ok ? 'ok' : 'ng'}">${svg(i.ok ? 'check' : 'x')}</span><b>${esc(i.name)}</b><span class="detail" title="${esc(i.detail)}">${esc(i.detail)}</span>
      ${!i.ok && i.name === 'Chromium' ? `<button class="btn sm primary" data-act="setup">${S.setup}</button>` : !i.ok && i.fix ? `<p class="fix">${esc(i.fix)}</p>` : ''}</li>`).join('');
    const btn = $('.env-btn');
    btn.classList.toggle('warn', ng.length > 0);
    btn.innerHTML = `${svg(ng.length ? 'alert' : 'circleCheck')}<span>${S.env}</span>${ng.length ? `<small>${S.envNeeded}</small>` : ''}${svg('chevD')}`;
    btn.dataset.tip = ng.length ? S.envNg : S.envOk;
  }
  const pop = () => $('.env-pop');
  function togglePop(open = pop().hidden) {
    pop().hidden = !open;
    $('.env-btn').setAttribute('aria-expanded', String(open));
  }
  root.onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!pop().hidden && !e.target.closest('.env-wrap')) togglePop(false);
    try {
      if (act === 'location') location.assign('/location');
      if (act === 'env') togglePop();
      if (act === 'refresh') await Promise.all([loadEnv(true), ai.refresh(true)]);
      if (act?.startsWith('ai-')) await ai.act(e.target.closest('[data-act]'));
      if (act === 'new' && data) newDeckDialog(data);
      if (act === 'topic') newTopic(load);
      if (act === 'setup') {
        const button = e.target.closest('button');
        button.disabled = true; button.textContent = S.setupBusy;
        try { await api('/api/setup', {method: 'POST'}); toast(S.setupDone); }
        finally { if (alive) await loadEnv(true); }
      }
    } catch (err) { toast(err.message); }
  };
  const keydown = e => { if (e.key === 'Escape' && !pop().hidden) { togglePop(false); $('.env-btn').focus(); } };
  addEventListener('keydown', keydown);
  load().catch(e => toast(e.message)); loadEnv().catch(e => toast(e.message)); ai.refresh();
  const off = onEvent(ev => { if (['files', 'theme-shots', 'chat', 'chat-round'].includes(ev.type)) load().catch(e => toast(e.message)); });
  return () => { alive = false; ai.destroy(); actions.destroy(); off(); root.onclick = null; removeEventListener('keydown', keydown); document.querySelectorAll('.dialog-back').forEach(d => d.remove()); };
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
