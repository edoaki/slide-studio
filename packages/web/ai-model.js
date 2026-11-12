// チャットの入力欄のモデルと思考量（Codex の入力欄と同じ形。設計書 §10.2）。
// ボタンにはモデルの名前と思考量の1文字を常に出す。押すと思考量のスライダー、モデルの名前を押すとモデルの一覧。
// モデル一覧上部の＋から候補へ切り替え、表示モデルだけをチェックで登録する。
// 見つからない・ログインしていない AI は、注意の行を開くとログインのボタンを出す。
import { api, esc, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';

const T = S.ai;
const logins = new Map();  // AI ごとのログインの進み具合 { busy, status, error, retry }
const loginOf = id => logins.get(id) || {};
const polling = new Set();  // 完了待ちの見回りをしている AI
const searchText = text => text.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
const splitKey = key => { const i = (key || '').indexOf(':'); return i < 0 ? ['', key || ''] : [key.slice(0, i), key.slice(i + 1)]; };

// 検出した AI とモデル（無ければ null）
export function lookup(ai, key) {
  const [pid, mid] = splitKey(key);
  const p = ai?.providers?.find(x => x.id === pid) || null;
  return { p, m: p?.models.find(x => x.id === mid) || null };
}

// 未取得ならダウンロード、取得済みならログインを案内する。
export function helpHtml(p) {
  const o = T.onboard[p.id], l = loginOf(p.id), missing = p.reason === 'missing';
  return `<section class="ai-onboarding" data-ai="${esc(p.id)}" aria-label="${o.title}">
    <div class="ai-mark" aria-hidden="true">${svg('logo')}</div>
    <h3>${o.title}</h3><p>${missing ? T.downloadBody : o.body}</p>
    <button class="btn ai-login" data-mact="login" data-id="${esc(p.id)}" data-download="${missing}" ${l.retry ? `data-tip="${T.loginRetryTip}"` : ''} ${l.busy ? 'disabled' : ''}>${missing ? T.download : l.retry ? T.loginRetry : o.login}</button>
    <p class="ai-login-status${l.error ? ' error' : ''}" role="status">${esc(l.status || (p.reason === 'error' ? T.connectionRetry : ''))}</p>
    <button class="ai-recheck" data-mact="recheck">${T.alreadyLoggedIn}</button></section>`;
}

export async function loginAi(id, onRecheck) {
  if (loginOf(id).busy) return;
  const state = (status, error = false, busy = true) => {
    const retry = !busy && status === T.loginPending;
    logins.set(id, { busy, status, error, retry });
    document.querySelectorAll(`.ai-onboarding[data-ai="${id}"]`).forEach(el => {
      const button = el.querySelector('.ai-login');
      button.disabled = busy;
      if (button.dataset.download !== 'true') button.textContent = retry ? T.loginRetry : T.onboard[id].login;
      if (retry) button.dataset.tip = T.loginRetryTip; else delete button.dataset.tip;
      const line = el.querySelector('.ai-login-status');
      line.textContent = status; line.classList.toggle('error', error);
    });
  };
  const url = `/api/ai/${id}/login`;
  const download = document.querySelector(`.ai-onboarding[data-ai="${id}"] .ai-login`)?.dataset.download === 'true';
  state(download ? T.loginPreparing : T.loginOpening);
  // 待っている間の押し直し：サーバーのログインを置き換えるだけで、見回りは動いているものが続ける
  const restart = polling.has(id);
  polling.add(id);
  try {
    await api(url, { method: 'POST', body: { download } });
    if (restart) return;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const r = await api(url);
      if (r.status === 'ready') { state('', false, false); await onRecheck(); return; }
      if (r.status === 'completed') { await onRecheck(); state('', false, false); toast(T.onboard[id].done); return; }
      if (r.status === 'failed' || r.status === 'idle') throw new Error(r.error || T.loginFailed);
      state(r.status === 'pending' ? T.loginPending : r.progress?.total ? T.loginDownloading(Math.round(r.progress.done / r.progress.total * 100)) : T.loginPreparing, false, !r.retry);
    }
  } catch (e) { state(e.message, true, false); }
  finally { if (!restart) polling.delete(id); }
}


export function makeModelPicker({ host, onModel, onEffort, onFavorites, onRole, onRecheck }) {
  let st = { ai: null, key: null, effort: null, locked: false, busy: false, roleSettings: {} };
  // サブエージェントを開いたかは覚えておく（開くたびに畳まない）
  const SUBS_KEY = 'slide-studio.ai-subs';
  let expanded = (() => { try { return localStorage.getItem(SUBS_KEY) === '1'; } catch { return false; } })();
  let view = null, target = null, query = '', opened = null, saving = false, epoch = 0, drag = null, pending = null, shown = null;
  const queuedEfforts = new Map();
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'ai-mbtn'; btn.setAttribute('aria-haspopup', 'dialog'); btn.dataset.tip = T.modelPick;
  const pop = document.createElement('div');
  pop.className = 'ai-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', T.model); pop.hidden = true;
  host.append(btn, pop);
  const roles = () => onRole ? st.roles || [] : [];
  // タブで決めていなければ担当の既定（相談役は既定でオフ）
  const roleOn = role => st.roleSettings?.[role]?.enabled ?? st.roleDefaults?.[role] ?? true;
  const value = role => role && st.roleSettings?.[role]?.model && st.roleSettings[role] || { model: st.key, effort: role ? null : st.effort };
  // 保存中も最後に選んだ思考量を出す（保存前の値に戻ってちらつかないように）
  const resolved = role => { const v = value(role), { p, m } = lookup(st.ai, v.model), e = queuedEfforts.get(role) ?? (pending && pending.role === role ? pending.effort : v.effort); return { p, m, key: v.model, effort: m?.efforts.includes(e) ? e : m?.effort }; };
  const modelName = role => { const v = resolved(role); return v.m?.name || splitKey(v.key)[1] || T.noModel; };
  const effortName = e => T.effortName[e] || e || '';
  // 薄くするのは送信中だけ。保存中の思考量変更は待ち行列に入れる。
  const dimmed = () => st.busy;
  const keyOf = (p, m) => `${p.id}:${m.id}`;

  function renderButton() {
    const { effort } = resolved(null);
    btn.innerHTML = st.ai ? `<span class="nm">${esc(modelName(null))}</span>${effort ? `<span class="ef">${esc(T.effortChar[effort] || effort)}</span>` : ''}${svg('chevD')}` : `<span class="nm muted">${T.modelLoading}</span>`;
    btn.disabled = !st.ai;
    btn.setAttribute('aria-label', `${T.model}：${modelName(null)} ${effortName(effort)}`);
    btn.setAttribute('aria-expanded', !!view);
  }
  function slider(role) {
    const { m, effort } = resolved(role), list = m?.efforts || [], i = Math.max(0, list.indexOf(effort));
    if (!list.length) return role ? '' : `<p class="ai-none">${T.effortNone}</p>`;
    return `<div class="ai-effort-control"><div class="ai-effort-value">${esc(effortName(effort))}</div><div class="ai-slider" data-role="${role || ''}" role="slider" tabindex="0" aria-label="${esc(role ? `${S.agents.names[role]} · ${T.effortLabel}` : T.effortLabel)}"
      aria-disabled="${dimmed() || list.length < 2}" aria-valuemin="0" aria-valuemax="${list.length - 1}" aria-valuenow="${i}" aria-valuetext="${esc(effortName(effort))}"
      data-tip-off style="--n:${list.length};--i:${i}">
      <div class="ai-track">${list.map((_, j) => `<i class="ai-stop${j <= i ? ' filled' : ''}"></i>`).join('')}<b class="ai-thumb"></b><b class="ai-preview" hidden></b></div></div></div>`;
  }
  function modelButton(role) {
    return `<button type="button" class="ai-mname${role && !st.roleSettings?.[role]?.model ? ' inherited' : ''}" data-mact="models" data-role="${role || ''}" data-tip="${esc(role && !st.roleSettings?.[role]?.model ? T.roleInherited : T.chooseModel)}"><span>${esc(modelName(role))}</span>${svg('chevR')}</button>`;
  }
  // サブエージェント：閉じていても各担当のオン・オフが見える。行の見出し全体がスイッチ
  function subsHtml() {
    const list = roles(); if (!list.length) return '';
    const name = role => S.agents.names[role];
    const sum = list.map(role => `<span class="ai-sub-chip${roleOn(role) ? ' on' : ''}">${esc(name(role))}</span>`).join('');
    const label = `${T.subagents}：${list.map(role => `${name(role)} ${roleOn(role) ? T.roleOn : T.roleOff}`).join('、')}`;
    return `<button type="button" class="ai-sub-head" data-mact="subs" aria-expanded="${expanded}" aria-label="${esc(label)}">${svg(expanded ? 'chevD' : 'chevR')}<span class="ai-sub-title">${T.subagents}</span>${expanded ? '' : `<span class="ai-sub-sum">${sum}</span>`}</button>
      ${expanded ? `<div class="ai-sub-rows">${list.map(role => `<div class="ai-sub-row${roleOn(role) ? '' : ' off'}">
        <button type="button" class="ai-sub-switch" role="switch" data-mact="role-toggle" data-role="${role}" aria-label="${esc(T.roleToggle(name(role)))}" aria-checked="${roleOn(role)}" aria-disabled="${dimmed()}"><span class="ai-role">${esc(name(role))}</span><span class="ai-switch" aria-hidden="true"></span></button>
        ${roleOn(role) ? `<div class="ai-mrow">${modelButton(role)}${slider(role)}</div>` : ''}</div>`).join('')}</div>` : ''}`;
  }
  function mainHtml() {
    return `${subsHtml()}<div class="ai-mrow ai-main-model">${modelButton(null)}${slider(null)}</div>`;
  }
  function rowHtml(p, m, catalog = false) {
    const key = keyOf(p, m), selected = resolved(target).key === key, checked = (st.ai.favorites || []).includes(key);
    const full = catalog && !checked && (st.ai.favorites || []).length >= (st.ai.favorites_limit || Infinity);
    const locked = !catalog && dimmed();
    return `<div class="ai-row${selected && !catalog ? ' on' : ''}"><button type="button" class="pick" data-mact="${catalog ? 'favorite' : 'pick'}" data-key="${esc(key)}"
      ${catalog ? `role="checkbox" aria-checked="${checked}"` : `aria-pressed="${selected}"`} aria-disabled="${catalog ? full : locked}"
      data-tip="${esc(catalog ? (full ? T.favoriteLimit(st.ai.favorites_limit) : checked ? T.removeFavorite : T.addFavorite) : locked ? T.sendBusy : target && key === st.key ? T.roleInherited : T.chooseModel)}">
      ${catalog ? `<span class="ai-check" aria-hidden="true">${checked ? svg('check') : ''}</span>` : ''}<span class="nm">${esc(m.name)}</span><span class="pv">${esc(p.name)}</span>${!catalog && selected ? '<span class="ai-selected-dot" aria-hidden="true"></span>' : ''}</button></div>`;
  }
  function listHtml() {
    const favs = (st.ai.favorites || []).map(k => lookup(st.ai, k)).filter(x => x.m && x.p.ok && (!target || st.roleProviders?.includes(x.p.id)));
    // 引き継ぎに戻す選択肢もモデル名で表示する。表示リストには追加しない。
    if (target && !favs.some(x => keyOf(x.p, x.m) === st.key)) { const parent = lookup(st.ai, st.key); if (parent.p?.ok && parent.m) favs.unshift(parent); }
    return `<div class="ai-shead"><button type="button" class="ibtn" data-mact="back" data-tip="${T.back}" aria-label="${T.back}">${svg('chevL')}</button><span class="ai-sec">${target ? S.agents.names[target] : T.modelList}</span>
      ${!target ? `<button type="button" class="ibtn ai-add" data-mact="add" data-tip="${T.addModel}" aria-label="${T.addModel}">${svg('plus')}</button>` : ''}</div>
      <div class="ai-list">${favs.length ? favs.map(x => rowHtml(x.p, x.m)).join('') : `<p class="ai-empty">${T.noFavorites}</p>`}</div>`;
  }
  function catalogHtml() {
    const q = searchText(query), ai = st.ai;
    const hits = ai.providers.filter(p => p.ok).flatMap(p => p.models.filter(m => !q || [m.name, m.id, p.name, p.id].some(t => searchText(t).includes(q))).map(m => [p, m]));
    const bad = ai.providers.filter(p => !p.ok);
    const stale = (ai.favorites || []).filter(key => { const { p, m } = lookup(ai, key); return !p?.ok || !m; });
    const staleHtml = stale.length ? `<div class="ai-sec sep">${T.unavailableFavorites}</div>${stale.map(key => {
      const { p, m } = lookup(ai, key);
      return `<div class="ai-row"><button type="button" class="pick" data-mact="favorite" data-key="${esc(key)}" role="checkbox" aria-checked="true" data-tip="${T.removeFavorite}"><span class="ai-check" aria-hidden="true">${svg('check')}</span><span class="nm">${esc(m?.name || splitKey(key)[1])}</span><span class="pv">${esc(p?.name || splitKey(key)[0])}</span></button></div>`;
    }).join('')}` : '';
    return `<div class="ai-catalog"><div class="ai-shead"><button type="button" class="ibtn" data-mact="back" data-tip="${T.back}" aria-label="${T.back}">${svg('chevL')}</button>
      <label class="ai-search">${svg('search')}<input type="search" placeholder="${T.search}" aria-label="${T.search}" value="${esc(query)}"></label></div>
      <div class="ai-list">${hits.length ? hits.map(([p, m]) => rowHtml(p, m, true)).join('') : `<p class="ai-empty">${T.noMatch}</p>`}
      ${staleHtml}${bad.length ? `<div class="ai-sec sep">${T.unavailable}</div>${bad.map(p => `<div class="ai-bad${opened === p.id ? ' open' : ''}"><button type="button" class="pick" data-mact="help" data-id="${esc(p.id)}" aria-expanded="${opened === p.id}">${svg('alert')}<span class="nm">${esc(p.name)}</span><span class="pv">${esc(T.reason[p.reason] || p.reason)}</span>${svg(opened === p.id ? 'chevD' : 'chevR')}</button>${opened === p.id ? helpHtml(p) : ''}</div>`).join('')}` : ''}</div></div>`;
  }
  function position() {
    pop.style.transform = '';
    const r = pop.getBoundingClientRect(), gap = 8;
    if (r.left < gap) pop.style.transform = `translateX(${gap - r.left}px)`;
    else if (r.right > innerWidth - gap) pop.style.transform = `translateX(${innerWidth - gap - r.right}px)`;
  }
  function renderPop() {
    if (!view || drag) return;
    // 同じ内容なら作り直さない（押している途中の行が消えるとクリックが失われる）
    const html = view === 'main' ? mainHtml() : view === 'catalog' ? catalogHtml() : listHtml();
    if (html === shown) return;
    shown = html;
    const focused = pop.contains(document.activeElement) ? document.activeElement : null;
    const selector = focused?.matches('input') ? 'input' : focused?.dataset.mact ? `[data-mact="${focused.dataset.mact}"]${focused.dataset.key ? `[data-key="${CSS.escape(focused.dataset.key)}"]` : ''}${focused.dataset.role != null ? `[data-role="${focused.dataset.role}"]` : ''}` : focused?.matches('.ai-slider') ? `.ai-slider[data-role="${focused.dataset.role}"]` : null;
    const caret = focused?.matches('input') ? focused.selectionStart : null;
    const scroll = pop.querySelector('.ai-list')?.scrollTop || 0;
    pop.innerHTML = html;
    pop.classList.toggle('models', view !== 'main'); pop.classList.toggle('catalog', view === 'catalog');
    if (selector) { const el = pop.querySelector(selector); el?.focus({ preventScroll: true }); if (el?.matches('input') && caret != null) el.setSelectionRange(caret, caret); }
    const list = pop.querySelector('.ai-list'); if (list) list.scrollTop = scroll;
    position();
  }
  function open(to = 'main', role = null) {
    if (!st.ai) return;
    view = to; target = role; query = ''; opened = null; shown = null; pop.hidden = false;
    renderButton(); renderPop();
    pop.querySelector(to === 'catalog' ? 'input' : to === 'models' ? '.pick, .ai-add' : '.ai-main-model .ai-mname')?.focus();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', position);
  }
  function close(focus = true) {
    drag = null; view = null; pop.hidden = true; renderButton();
    document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', position);
    if (focus) btn.focus();
  }
  const outside = e => { if (!host.contains(e.target)) close(false); };
  // 画面は呼び出し先がすぐ変える。保存の完了は待たず、次の操作も受け付ける。
  const fire = async fn => { try { await fn(); } catch (e) { toast(e.message); } };
  async function perform(fn) {
    if (saving) return;
    const generation = epoch; saving = true; renderPop();
    try { await fn(); } catch (e) { toast(e.message); }
    finally {
      if (generation === epoch) {
        saving = false; pending = null;
        // 保存中の操作は担当ごとに最後の選択を残し、順番に保存する。
        while (!saving && queuedEfforts.size) {
          const [role, effort] = queuedEfforts.entries().next().value;
          queuedEfforts.delete(role);
          setEffort(role, effort);
        }
        renderButton(); renderPop();
      }
    }
  }
  function setEffort(role, effort) {
    const { m, key, effort: old } = resolved(role);
    if (st.busy || !m || old === effort || !m.efforts.includes(effort)) return;
    if (saving) { queuedEfforts.set(role, effort); renderButton(); renderPop(); return; }
    pending = { role, effort };
    if (role) return perform(() => onRole(role, { model: key, effort }));
    return perform(() => onEffort(effort === m.effort ? null : effort));
  }
  function back() {
    view = view === 'catalog' ? 'models' : 'main'; renderPop();
    pop.querySelector(view === 'models' ? '.ai-add' : `.ai-mname[data-role="${target || ''}"]`)?.focus();
  }
  btn.addEventListener('click', () => view ? close() : open());
  pop.addEventListener('click', e => {
    const el = e.target.closest('[data-mact]'); if (!el || el.getAttribute('aria-disabled') === 'true') return;
    const act = el.dataset.mact;
    if (act === 'subs') { expanded = !expanded; try { localStorage.setItem(SUBS_KEY, expanded ? '1' : '0'); } catch { /* 覚えられなくても動く */ } renderPop(); }
    else if (act === 'role-toggle') {
      if (st.busy) return;
      const role = el.dataset.role;
      fire(() => onRole(role, { ...st.roleSettings?.[role], enabled: !roleOn(role) }));
    }
    else if (act === 'models') { target = el.dataset.role || null; view = 'models'; renderPop(); pop.querySelector('.pick[aria-pressed="true"], .pick, .ai-add')?.focus(); }
    else if (act === 'add' && !target) { view = 'catalog'; query = ''; renderPop(); pop.querySelector('input')?.focus(); }
    else if (act === 'back') back();
    else if (act === 'pick') {
      if (st.busy) return;
      const role = target, key = el.dataset.key;
      // 前のモデルの思考量を、選び直したモデルに持ち込まない
      queuedEfforts.delete(role); if (pending?.role === role) pending = null;
      view = 'main'; renderPop();
      pop.querySelector(`.ai-mname[data-role="${role || ''}"]`)?.focus();
      if (role) fire(() => onRole(role, key === st.key ? null : { model: key, effort: null }));
      else if (key !== st.key) fire(() => onModel(key));
    } else if (act === 'favorite' && !target) {
      const key = el.dataset.key, favs = st.ai.favorites || [];
      fire(() => onFavorites(favs.includes(key) ? favs.filter(k => k !== key) : [...favs, key]));
    } else if (act === 'help') {
      opened = opened === el.dataset.id ? null : el.dataset.id; renderPop();
      const panel = pop.querySelector('.ai-bad.open'), list = pop.querySelector('.ai-list');
      if (panel && list) {
        const r = panel.getBoundingClientRect(), box = list.getBoundingClientRect();
        // 展開した案内を一覧の中で見せる。長い案内は先頭に合わせる。
        const delta = r.height > list.clientHeight || r.top < box.top ? r.top - box.top : Math.max(0, r.bottom - box.bottom);
        list.scrollBy({ top: delta, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      }
    }
    else if (act === 'login') fire(() => loginAi(el.dataset.id, onRecheck));  // 待っている間も押し直しと再確認を受け付ける
    else if (act === 'recheck') perform(onRecheck);
  });
  pop.addEventListener('input', e => { if (e.target.matches('input')) { query = e.target.value; renderPop(); } });
  const label = el => el.closest('.ai-effort-control').querySelector('.ai-effort-value');
  const indexAt = (el, x, list) => {
    const r = el.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (x - r.left - 11) / Math.max(1, r.width - 22))) * (list.length - 1));
  };
  const paint = (el, i, list) => { el.style.setProperty('--i', i); el.setAttribute('aria-valuenow', i); el.setAttribute('aria-valuetext', effortName(list[i])); label(el).textContent = effortName(list[i]); el.querySelector('.ai-preview').hidden = true; el.querySelectorAll('.ai-stop').forEach((stop, j) => stop.classList.toggle('filled', j <= i)); };
  const point = e => { if (!drag) return; drag.index = indexAt(drag.el, e.clientX, drag.list); paint(drag.el, drag.index, drag.list); };
  pop.addEventListener('pointerdown', e => {
    const el = e.target.closest('.ai-slider'); if (!el || e.button !== 0 || st.busy || el.getAttribute('aria-disabled') === 'true') return;
    e.preventDefault(); el.focus(); el.setPointerCapture(e.pointerId);
    const role = el.dataset.role || null;
    shown = null;  // ドラッグ中は DOM を直接塗るので、終わったら作り直す
    drag = { el, role, list: resolved(role).m.efforts, index: 0, epoch }; point(e);
  });
  pop.addEventListener('pointermove', e => {
    if (drag) { point(e); return; }
    const el = e.target.closest('.ai-slider');
    if (!el || el.getAttribute('aria-disabled') === 'true') return;
    const { m, effort } = resolved(el.dataset.role || null), i = indexAt(el, e.clientX, m.efforts);
    const preview = el.querySelector('.ai-preview');
    el.style.setProperty('--preview', i); preview.hidden = m.efforts[i] === effort;
    label(el).textContent = m.efforts[i] === effort ? effortName(effort) : T.effortPreview(effortName(m.efforts[i]));
  });
  pop.addEventListener('pointerout', e => {
    const el = e.target.closest('.ai-slider');
    if (!el || el.contains(e.relatedTarget) || drag) return;
    el.querySelector('.ai-preview').hidden = true;
    label(el).textContent = effortName(resolved(el.dataset.role || null).effort);
  });
  pop.addEventListener('pointerup', e => { if (!drag) return; const d = drag; point(e); drag = null; if (d.el.hasPointerCapture(e.pointerId)) d.el.releasePointerCapture(e.pointerId); if (d.epoch === epoch) setEffort(d.role, d.list[d.index]); renderPop(); });
  pop.addEventListener('pointercancel', () => { drag = null; renderPop(); });
  pop.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); drag = null; if (view !== 'main') back(); else close(); return; }
    const slider = e.target.closest('.ai-slider');
    if (slider && ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      const role = slider.dataset.role || null, { m, effort } = resolved(role), list = m?.efforts || [], i = list.indexOf(effort);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : i + (['ArrowRight', 'ArrowUp'].includes(e.key) ? 1 : -1);
      if (list[j]) setEffort(role, list[j]); return;
    }
    const picks = [...pop.querySelectorAll('[data-mact=pick], [data-mact=favorite]')];
    if (picks.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && !e.target.matches('input')) {
      e.preventDefault(); const i = picks.indexOf(e.target), j = e.key === 'Home' ? 0 : e.key === 'End' ? picks.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length; picks[j]?.focus();
    } else if (e.target.matches('input') && e.key === 'ArrowDown') { e.preventDefault(); picks[0]?.focus(); }
  });
  return {
    render(next) {
      if (next.contextKey !== undefined && next.contextKey !== st.contextKey) { epoch++; saving = false; pending = null; queuedEfforts.clear(); close(false); }
      st = { ...st, ...next }; renderButton(); renderPop();
    }, open, close, isOpen: () => !!view,
    destroy() { epoch++; queuedEfforts.clear(); close(false); },
  };
}
