import { api, esc, toast } from './api.js';
import { S } from './strings.js';
import { svg } from './icons.js';
import { tip } from './tip.js';

// remove を渡すと、使っている発表の無いテーマのカードに［削除］を出す
export function themeCards(host, themes, choose, selected, remove) {
  host.replaceChildren();
  for (const t of themes) {
    const card = document.createElement('div'); card.className = 'theme-card';
    const b = document.createElement('button'); b.type = 'button'; b.dataset.theme = t.name;
    b.className = 'theme-thumb'; b.dataset.tip = S.themes.choose(t.name); b.setAttribute('aria-label', S.themes.choose(t.name));
    b.setAttribute('aria-pressed', String(t.name === selected));
    if (t.name === selected) card.classList.add('current');
    b.innerHTML = t.shots?.length ? `<img alt="" src="${esc(t.shots[0])}">` : `<div class="cover"><i></i>${svg('presentation')}</div>`;
    b.onclick = () => choose(t.name);
    if (t.shots?.length) {
      b.onpointermove = e => {
        const r = b.getBoundingClientRect();
        b.querySelector('img').src = t.shots[Math.max(0, Math.min(t.shots.length - 1, Math.floor((e.clientX - r.left) / r.width * t.shots.length)))];
      };
      b.onpointerleave = () => { b.querySelector('img').src = t.shots[0]; };
    }
    card.append(b);
    if (t.name === selected) card.insertAdjacentHTML('beforeend', `<span class="theme-current" data-tip="${S.themes.inUse}" aria-label="${S.themes.inUse}">${svg('check')}</span>`);
    const label = document.createElement('div'); label.className = 'name'; label.textContent = t.name; card.append(label);
    if (t.decks) { const count = document.createElement('small'); count.textContent = S.decksCount(t.decks.length); card.append(count); }
    if (remove && t.removable) {
      const del = document.createElement('button'); del.type = 'button'; del.className = 'ibtn theme-remove'; del.innerHTML = svg('trash');
      tip(del, S.themes.remove(t.name)); del.onclick = e => { e.stopPropagation(); removeTheme(t.name, remove); };
      card.append(del);
    }
    host.append(card);
  }
}

export function dialog(title) {
  const back = document.createElement('div'); back.className = 'dialog-back';
  back.innerHTML = `<form class="dialog theme-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="dh"><h3>${esc(title)}</h3><button type="button" class="ibtn" data-close data-tip="${S.close}" aria-label="${S.close}">${svg('x')}</button></div><div class="theme-content"></div><div class="error" role="alert"></div></form>`;
  document.body.append(back);
  const cleanups = [];
  const close = () => { cleanups.forEach(f => f()); back.remove(); removeEventListener('keydown', key); };
  const key = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } };
  addEventListener('keydown', key);
  back.querySelector('[data-close]').onclick = close;
  back.onmousedown = e => { if (e.target === back) close(); };
  return { back, form: back.querySelector('form'), content: back.querySelector('.theme-content'), close, cleanups };
}

// 現在の内容を残すか選んでから、使用中のテーマをデフォルトへ戻す。
export function resetTheme(name, reset) {
  const d = dialog(S.themes.resetTitle); d.form.classList.add('small');
  d.content.innerHTML = `<p>${esc(S.themes.resetConfirm(name))}</p><label>${S.themes.name}<input name="name" required pattern="[a-z0-9][a-z0-9-]*" autocomplete="off" spellcheck="false"></label><div class="df"><button type="button" class="btn" data-cancel>${S.cancel}</button><button type="button" class="btn" data-discard>${S.themes.resetDiscard}</button><button class="btn primary">${S.themes.resetSave}</button></div>`;
  const buttons = [...d.form.querySelectorAll('button')];
  let busy = false;
  async function run(saveAs) {
    if (busy) return;
    busy = true; buttons.forEach(b => { b.disabled = true; });
    try { await reset(saveAs); d.close(); }
    catch (err) { d.form.querySelector('.error').textContent = err.message; }
    finally { busy = false; buttons.forEach(b => { b.disabled = false; }); }
  }
  d.form.querySelector('[data-cancel]').onclick = d.close;
  d.form.querySelector('[data-discard]').onclick = () => run(null);
  d.form.onsubmit = e => { e.preventDefault(); run(d.form.elements.name.value); };
  d.form.elements.name.focus();
  return d;
}

// 確かめてから消す（CSS は .slide-studio/trash/themes/ へ移す）
export function removeTheme(name, done) {
  const d = dialog(S.themes.removeTitle); d.form.classList.add('small');
  d.content.innerHTML = `<p>${esc(S.themes.removeConfirm(name))}</p><div class="df"><button type="button" class="ibtn" data-cancel>${svg('x')}</button><button class="ibtn danger">${svg('trash')}</button></div>`;
  const cancel = d.form.querySelector('[data-cancel]'), yes = d.form.querySelector('.danger');
  tip(cancel, S.cancel); tip(yes, S.themes.remove(name));
  cancel.onclick = d.close;
  d.form.onsubmit = async e => {
    e.preventDefault(); yes.disabled = true;
    try { await api(`/api/themes/${encodeURIComponent(name)}`, { method: 'DELETE' }); d.close(); toast(S.themes.removed(name)); await done(name); }
    catch (err) { d.form.querySelector('.error').textContent = err.message; yes.disabled = false; }
  };
  cancel.focus();
  return d;
}

export function makeThemes(ctx) {
  let current = ctx.structure?.meta.theme || 'default', alive = true;
  // 選ぶのは左の欄の［テーマ］タブ（theme-tab.js）の一覧から
  ctx.selectTheme = async name => {
    if (name === current || ctx.locked || !await ctx.flush()) return false;
    const before = ctx.text;
    const r = await api('/api/themes/select', { method: 'POST', body: { text: before, theme: name } });
    if (!alive || ctx.text !== before) return false;
    ctx.setText(r.text); await ctx.flush(); current = name; return true;
  };
  return {
    rendered() { current = ctx.structure?.meta.theme || 'default'; },
    event(ev) { if (ev.type === 'files' && ev.paths.includes(`themes/${current}.css`)) ctx.preview.setTheme(current); },
    destroy() { alive = false; },
  };
}
