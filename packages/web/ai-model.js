// チャットの入力欄のモデルと思考量（Codex の入力欄と同じ形。設計書 §10.2）。
// ボタンにはモデルの名前と思考量の1文字を常に出す。押すと上に Codex と Claude Code の2列のモデル一覧、下に思考量とサブエージェント。
// 一覧のモデルを1回押すと決まる。担当のモデル名を押すと、同じ一覧でその担当のモデルを選ぶ。
// 一覧が誰のモデルを選ぶかは、下のモデル名の押された見た目で示す。チャットのモデル名を押すか、サブエージェントを畳むとチャットに戻る。
// 思考量を選んでも閉じない。入力欄の上に開くので、開いたままでも入力欄は隠れず、入力欄を押せば閉じる。
// 見つからない・ログインしていない AI は、その列にダウンロード・ログインの案内を出す。
import { api, esc, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';

const T = S.ai;
const logins = new Map();  // AI ごとのログインの進み具合 { busy, status, error, retry }
const loginOf = id => logins.get(id) || {};
const polling = new Set();  // 完了待ちの見回りをしている AI
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
      if (r.status === 'ready') { state(T.installDone, false, false); await onRecheck(); toast(T.installDone); return; }
      if (r.status === 'completed') { await onRecheck(); state('', false, false); toast(T.onboard[id].done); return; }
      if (r.status === 'failed' || r.status === 'idle') throw new Error(r.error || T.loginFailed);
      state(r.status === 'pending' ? T.loginPending : r.progress?.total ? T.loginDownloading(Math.round(r.progress.done / r.progress.total * 100)) : T.loginPreparing, false, !r.retry);
    }
  } catch (e) { state(e.message, true, false); }
  finally { if (!restart) polling.delete(id); }
}


export function makeModelPicker({ host, onModel, onEffort, onRole, onRecheck, onOpen }) {
  let st = { ai: null, key: null, effort: null, locked: false, busy: false, roleSettings: {} };
  // サブエージェントを開いたかは覚えておく（開くたびに畳まない）
  const SUBS_KEY = 'slide-studio.ai-subs';
  let expanded = (() => { try { return localStorage.getItem(SUBS_KEY) === '1'; } catch { return false; } })();
  // open：表示中か。target：一覧で選ぶモデルの持ち主（null はチャット、ほかは担当）
  let open_ = false, target = null, saving = false, epoch = 0, drag = null, pending = null, shown = null;
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
  // 左に Codex、右に Claude Code。担当には担当が使える AI だけを出す
  const ORDER = ['codex', 'claude'];
  const columns = () => (st.ai?.providers || []).filter(p => !target || !st.roleProviders || st.roleProviders.includes(p.id))
    .map((p, i) => [p, ORDER.includes(p.id) ? ORDER.indexOf(p.id) : ORDER.length + i]).sort((a, b) => a[1] - b[1]).map(([p]) => p);

  function renderButton() {
    const { effort } = resolved(null);
    btn.innerHTML = st.ai ? `<span class="nm">${esc(modelName(null))}</span>${effort ? `<span class="ef">${esc(T.effortChar[effort] || effort)}</span>` : ''}${svg('chevD')}` : `<span class="nm muted">${T.modelLoading}</span>`;
    btn.disabled = !st.ai;
    btn.setAttribute('aria-label', `${T.model}：${modelName(null)} ${effortName(effort)}`);
    btn.setAttribute('aria-expanded', open_);
  }
  function slider(role) {
    const { m, effort } = resolved(role), list = m?.efforts || [], i = Math.max(0, list.indexOf(effort));
    if (!list.length) return role ? '' : `<p class="ai-none">${T.effortNone}</p>`;
    return `<div class="ai-effort-control"><div class="ai-effort-value">${esc(effortName(effort))}</div><div class="ai-slider" data-role="${role || ''}" role="slider" tabindex="0" aria-label="${esc(role ? `${S.agents.names[role]} · ${T.effortLabel}` : T.effortLabel)}"
      aria-disabled="${dimmed() || list.length < 2}" aria-valuemin="0" aria-valuemax="${list.length - 1}" aria-valuenow="${i}" aria-valuetext="${esc(effortName(effort))}"
      data-tip-off style="--n:${list.length};--i:${i}">
      <div class="ai-track">${list.map((_, j) => `<i class="ai-stop${j <= i ? ' filled' : ''}"></i>`).join('')}<b class="ai-thumb"></b><b class="ai-preview" hidden></b></div></div></div>`;
  }
  // 担当のモデル名を押すと、上の一覧がその担当のモデル選びになる（もう一度押すとチャットに戻る）
  function roleModelButton(role) {
    const inherited = !st.roleSettings?.[role]?.model;
    return `<button type="button" class="ai-mname${inherited ? ' inherited' : ''}" data-mact="target" data-role="${role}" aria-pressed="${target === role}" data-tip="${esc(inherited ? T.roleInherited : T.chooseModel)}"><span>${esc(modelName(role))}</span>${svg('chevR')}</button>`;
  }
  // チャットのモデル名。担当があるときは押せて、一覧をチャットのモデル選びに戻す
  function mainModelHtml() {
    if (!roles().length) return `<span class="ai-mcur">${esc(modelName(null))}</span>`;
    return `<button type="button" class="ai-mname ai-mcur" data-mact="target" data-role="" aria-pressed="${!target}" aria-label="${esc(`${T.chatModel}：${modelName(null)}`)}" data-tip="${T.chooseModel}"><span>${esc(modelName(null))}</span></button>`;
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
        ${roleOn(role) ? `<div class="ai-mrow">${roleModelButton(role)}${slider(role)}</div>` : ''}</div>`).join('')}</div>` : ''}`;
  }
  function rowHtml(p, m) {
    const key = keyOf(p, m), selected = resolved(target).key === key, locked = dimmed();
    return `<button type="button" class="ai-row pick${selected ? ' on' : ''}" data-mact="pick" data-key="${esc(key)}" aria-pressed="${selected}" aria-disabled="${locked}"
      data-tip="${esc(locked ? T.sendBusy : target && key === st.key ? T.roleInherited : T.chooseModel)}"><span class="nm">${esc(m.name)}</span>${selected ? svg('check') : ''}</button>`;
  }
  // AI ごとの列。使えない AI は列の中にダウンロード・ログインの案内を出す
  function columnHtml(p) {
    const state = p.ok ? T.loggedIn : T.reason[p.reason] || p.reason;
    const body = !p.ok ? helpHtml(p) : p.models.length ? p.models.map(m => rowHtml(p, m)).join('') : `<p class="ai-empty">${T.noModels}</p>`;
    return `<section class="ai-col${p.ok ? '' : ' bad'}" data-ai="${esc(p.id)}" aria-label="${esc(p.name)}">
      <div class="ai-chead"><span class="ai-cname">${esc(p.name)}</span><span class="ai-cstate">${esc(state)}</span></div>
      <div class="ai-clist">${body}</div></section>`;
  }
  function popHtml() {
    const cols = columns();
    const head = target ? `<div class="ai-ghead"><span class="ai-sec">${esc(T.roleModel(S.agents.names[target]))}</span><button type="button" class="ai-gback" data-mact="target" data-role="">${T.backToChat}</button></div>` : '';
    return `<div class="ai-pick${target ? ' role' : ''}">${head}<div class="ai-grid">${cols.length ? cols.map(columnHtml).join('') : `<p class="ai-empty">${T.noModel}</p>`}</div></div>
      <div class="ai-settings">${subsHtml()}<div class="ai-mrow ai-main-model">${mainModelHtml()}${slider(null)}</div></div>`;
  }
  function position() {
    pop.style.transform = '';
    // 入力欄（基準の箱）の上に開くので、その上の余白に収める
    pop.style.setProperty('--room', `${Math.max(240, (pop.offsetParent || host).getBoundingClientRect().top - 16)}px`);
    const r = pop.getBoundingClientRect(), gap = 8;
    if (r.left < gap) pop.style.transform = `translateX(${gap - r.left}px)`;
    else if (r.right > innerWidth - gap) pop.style.transform = `translateX(${innerWidth - gap - r.right}px)`;
  }
  function renderPop() {
    if (!open_ || drag) return;
    // 同じ内容なら作り直さない（押している途中の行が消えるとクリックが失われる）
    const html = popHtml();
    if (html === shown) return;
    shown = html;
    const focused = pop.contains(document.activeElement) ? document.activeElement : null;
    const selector = focused?.dataset.mact ? `[data-mact="${focused.dataset.mact}"]${focused.dataset.key ? `[data-key="${CSS.escape(focused.dataset.key)}"]` : ''}${focused.dataset.role != null ? `[data-role="${focused.dataset.role}"]` : ''}${focused.dataset.id ? `[data-id="${CSS.escape(focused.dataset.id)}"]` : ''}` : focused?.matches('.ai-slider') ? `.ai-slider[data-role="${focused.dataset.role}"]` : null;
    const scroll = pop.querySelector('.ai-grid')?.scrollTop || 0;
    pop.innerHTML = html;
    if (selector) pop.querySelector(selector)?.focus({ preventScroll: true });
    const grid = pop.querySelector('.ai-grid'); if (grid) grid.scrollTop = scroll;
    position();
  }
  // 選んでいるモデルを見える位置に出して、そこに入力の位置を置く
  function focusPick() {
    const el = pop.querySelector('.pick[aria-pressed="true"]') || pop.querySelector('.pick') || pop.querySelector('.ai-login'), grid = pop.querySelector('.ai-grid');
    if (!el) return;
    if (grid?.contains(el)) {
      // 列の見出しは上に残るので、その下に見えるようにする
      const g = grid.getBoundingClientRect(), r = el.getBoundingClientRect(), head = el.closest('.ai-col')?.querySelector('.ai-chead')?.offsetHeight || 0;
      if (r.top < g.top + head) grid.scrollTop -= g.top + head - r.top; else if (r.bottom > g.bottom) grid.scrollTop += r.bottom - g.bottom;
    }
    el.focus({ preventScroll: true });
  }
  function setTarget(role) {
    target = role && roles().includes(role) ? role : null; renderPop(); focusPick();
  }
  // to は以前の画面名（'main' / 'models'）。どちらでも一覧をすぐに出す
  function open(to = 'main', role = null) {
    if (!st.ai) return;
    open_ = true; target = role && roles().includes(role) ? role : null; shown = null; pop.hidden = false;
    if (target) expanded = true;  // 担当のモデル名が見えるように（覚えている開閉は変えない）
    renderButton(); renderPop(); focusPick();
    onOpen?.();  // 古い一覧なら裏で取り直す（届いたら render で描き直す）
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', position);
  }
  function close(focus = true) {
    drag = null; open_ = false; target = null; pop.hidden = true; renderButton();
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
  btn.addEventListener('click', () => open_ ? close() : open());
  pop.addEventListener('click', e => {
    const el = e.target.closest('[data-mact]'); if (!el || el.getAttribute('aria-disabled') === 'true') return;
    const act = el.dataset.mact;
    if (act === 'subs') {
      expanded = !expanded; try { localStorage.setItem(SUBS_KEY, expanded ? '1' : '0'); } catch { /* 覚えられなくても動く */ }
      // 畳むと担当のモデル名が見えなくなるので、一覧はチャットのモデル選びに戻す
      if (!expanded) target = null;
      renderPop();
    }
    else if (act === 'role-toggle') {
      if (st.busy) return;
      const role = el.dataset.role;
      if (roleOn(role) && target === role) target = null;
      fire(() => onRole(role, { ...st.roleSettings?.[role], enabled: !roleOn(role) }));
    }
    else if (act === 'target') { const role = el.dataset.role || null; setTarget(role === target ? null : role); }
    else if (act === 'pick') {
      if (st.busy) return;
      const role = target, key = el.dataset.key;
      // 前のモデルの思考量を、選び直したモデルに持ち込まない
      queuedEfforts.delete(role); if (pending?.role === role) pending = null;
      // 担当のモデルを選んだらチャットのモデル選びに戻す
      target = null; renderPop();
      (role ? pop.querySelector(`.ai-mname[data-role="${role}"]`) : pop.querySelector(`.pick[data-key="${CSS.escape(key)}"]`))?.focus({ preventScroll: true });
      if (role) fire(() => onRole(role, key === st.key ? null : { model: key, effort: null }));
      else if (key !== st.key) fire(() => onModel(key));
    }
    else if (act === 'login') fire(() => loginAi(el.dataset.id, onRecheck));  // 待っている間も押し直しと再確認を受け付ける
    else if (act === 'recheck') perform(onRecheck);
  });
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
  pop.addEventListener('pointerup', e => {
    if (!drag) return; const d = drag; point(e); drag = null; if (d.el.hasPointerCapture(e.pointerId)) d.el.releasePointerCapture(e.pointerId);
    if (d.epoch === epoch) setEffort(d.role, d.list[d.index]);
    renderPop();
  });
  pop.addEventListener('pointercancel', () => { drag = null; renderPop(); });
  pop.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); drag = null; if (target) { const role = target; setTarget(null); pop.querySelector(`.ai-mname[data-role="${role}"]`)?.focus(); } else close(); return; }
    const slider = e.target.closest('.ai-slider');
    if (slider && ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      const role = slider.dataset.role || null, { m, effort } = resolved(role), list = m?.efforts || [], i = list.indexOf(effort);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : i + (['ArrowRight', 'ArrowUp'].includes(e.key) ? 1 : -1);
      if (list[j]) setEffort(role, list[j]); return;
    }
    // 一覧の矢印キー：上下は列の中、左右は隣の列の同じ高さへ
    const pick = e.target.closest('.pick');
    if (!pick || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const cols = [...pop.querySelectorAll('.ai-col')].map(c => [...c.querySelectorAll('.pick')]).filter(c => c.length);
    const ci = cols.findIndex(c => c.includes(pick)); if (ci < 0) return;
    const col = cols[ci], i = col.indexOf(pick);
    let next = null;
    if (e.key === 'Home') next = col[0];
    else if (e.key === 'End') next = col.at(-1);
    else if (e.key === 'ArrowDown') next = col[(i + 1) % col.length];
    else if (e.key === 'ArrowUp') next = col[(i + col.length - 1) % col.length];
    else { const other = cols[ci + (e.key === 'ArrowRight' ? 1 : -1)]; next = other?.[Math.min(i, other.length - 1)]; }
    if (next) { e.preventDefault(); next.focus(); }
  });
  return {
    render(next) {
      if (next.contextKey !== undefined && next.contextKey !== st.contextKey) { epoch++; saving = false; pending = null; queuedEfforts.clear(); close(false); }
      st = { ...st, ...next }; renderButton(); renderPop();
    }, open, close, isOpen: () => open_,
    destroy() { epoch++; queuedEfforts.clear(); close(false); },
  };
}
