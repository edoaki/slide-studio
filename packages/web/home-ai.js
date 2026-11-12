// ホームの AI 準備。チャットと同じ取得・認証 API を使う。
import { api, esc } from './api.js';
import { S } from './strings.js';

const T = S.ai, R = T.runtime;
const active = state => ['preparing', 'pending'].includes(state?.status);
const finished = state => ['ready', 'completed'].includes(state?.status);
const percent = progress => progress?.total ? Math.round(progress.done / progress.total * 100) : null;

export function homeAi(host) {
  let alive = true, timer = 0, generation = 0, rows = [], providers = [], states = new Map(), shown = '', error = '', statusError = '';
  let detecting = false, detected = false, detectAgain = false;
  const pending = new Map(), failures = new Map();
  const ids = Object.keys(T.onboard);

  function row(a) {
    const p = providers.find(p => p.id === a.id), l = states.get(a.id) || {};
    const missing = !a.version && !a.terminal && !p?.ok, working = ['install', 'login'].includes(pending.get(a.id)) || active(l), busy = pending.has(a.id) || working || a.busy;
    const retry = l.status === 'pending' && l.retry && !pending.has(a.id);
    const detail = a.busy ? missing ? T.installing : R.updating(percent(a.progress)) : a.terminal ? R.terminal(a.version || R.unknown) : !a.version ? R.none : a.update ? `${a.version} → ${a.latest}` : a.version;
    const button = (act, label, tip = label, primary = false, disabled = busy) => `<button class="btn sm${primary ? ' primary' : ''}" data-act="ai-${act}" data-id="${esc(a.id)}" aria-label="${esc(tip)}" data-tip="${esc(tip)}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
    const setup = missing
      ? (a.fixed ? '' : button('install', T.install, T.install, true))
      : !p && !working && l.status !== 'ready' ? `<span class="muted">${T.modelLoading}</span>`
      : !p?.ok || working ? button('login', retry ? T.loginRetry : T.onboard[a.id].login, retry ? T.loginRetry : T.onboard[a.id].login, true, a.busy || pending.has(a.id) || (working && !retry))
      : `<span class="env-ai-ready">${T.loggedIn}</span>`;
    const actions = a.fixed || missing ? '' : (a.update ? button('update', R.updateShort, a.version && !a.terminal ? R.update(a.latest) : R.install(a.latest)) : '')
      + (a.previous ? button('rollback', R.rollbackShort, R.rollback(a.previous)) : '');
    const auto = a.fixed ? '' : `<label class="env-ai-auto"><input type="checkbox" data-act="ai-auto" data-id="${esc(a.id)}" aria-label="${esc(`${a.name}：${R.auto}`)}" ${a.auto ? 'checked' : ''} ${busy ? 'disabled' : ''}>${R.auto}</label>`;
    const failure = failures.get(a.id) || (l.status === 'failed' ? l.error || T.loginFailed : '');
    const status = failure || (l.status === 'pending' ? T.loginPending : working ? (percent(l.progress) == null ? pending.get(a.id) === 'login' ? T.loginOpening : T.loginPreparing : T.loginDownloading(percent(l.progress))) : p?.reason === 'error' ? p.message || T.connectionRetry : '');
    return `<li data-ai="${esc(a.id)}"><div class="env-ai-head"><b>${esc(a.name)}</b><span class="detail" title="${esc(detail)}">${esc(detail)}</span></div>
      <div class="env-ai-acts">${setup}${actions}${auto}</div>
      <p class="env-ai-status${failure ? ' error' : ''}" role="status" ${status ? '' : 'hidden'}>${esc(status)}</p>
      ${a.error ? `<p class="fix">${esc(a.error)}</p>` : ''}</li>`;
  }

  function render() {
    if (!alive) return;
    const message = error || statusError;
    const html = rows.map(row).join('') + (message ? `<li class="env-ai-error" role="alert">${esc(message)}</li>` : '');
    if (html === shown) return;
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const selector = focused?.dataset.act ? `[data-act="${focused.dataset.act}"][data-id="${CSS.escape(focused.dataset.id)}"]` : null;
    shown = html; host.innerHTML = html;
    if (selector) host.querySelector(selector)?.focus({ preventScroll: true });
  }

  // AI の接続確認には時間がかかるため、取得ボタンや進捗の更新を待たせない。
  async function detect(force = false) {
    if (!alive) return;
    if (detecting) { detectAgain ||= force; return; }
    detecting = true; detected = true;
    try {
      const status = await api('/api/ai/status' + (force ? '?refresh=1' : ''));
      if (alive) { providers = status.providers; statusError = ''; render(); }
    } catch (e) { if (alive) { statusError = e.message; render(); } }
    finally {
      detecting = false;
      if (detectAgain) { detectAgain = false; detect(true); }
    }
  }

  async function refresh(force = false, recheck = false) {
    clearTimeout(timer);
    const current = ++generation;
    if (!detected || force || recheck) detect(force || recheck);
    try {
      const [runtime, logins] = await Promise.all([
        api('/api/ai/runtimes' + (force ? '?refresh=1' : '')),
        Promise.all(ids.map(async id => [id, await api(`/api/ai/${id}/login`)])),
      ]);
      if (!alive || current !== generation) return;
      // 取得・認証の完了後は、最大5分の検出キャッシュを更新する。
      const completed = logins.some(([id, state]) => finished(state) && states.get(id)?.status !== state.status);
      const changed = runtime.ai.some(a => rows.some(old => old.id === a.id && (old.version !== a.version || old.busy && !a.busy)));
      rows = runtime.ai; states = new Map(logins); error = '';
      render();
      if ((completed || changed) && !force && !recheck) detect(true);
      if (rows.some(a => a.busy) || logins.some(([, state]) => active(state))) timer = setTimeout(() => refresh(), 1000);
    } catch (e) {
      if (!alive || current !== generation) return;
      error = e.message; render();
      if (rows.some(a => a.busy) || [...states.values()].some(active)) timer = setTimeout(() => refresh(), 1500);
    }
  }

  async function act(el) {
    const id = el.dataset.id, action = el.dataset.act.slice(3);
    if (el.disabled || pending.has(id)) return;
    clearTimeout(timer); generation++;
    failures.delete(id); pending.set(id, action);
    if (action === 'install' || action === 'login') states.set(id, { status: 'preparing' });
    render();
    let recheck = false;
    try {
      if (action === 'install' || action === 'login') {
        const state = await api(`/api/ai/${id}/login`, { method: 'POST', body: { download: action === 'install' } });
        if (alive) { states.set(id, state); recheck = finished(state); }
      } else {
        await api(`/api/ai/${id}/runtime`, { method: 'POST', body: action === 'auto' ? { auto: el.checked } : { action } });
        recheck = action === 'rollback';
      }
    } catch (e) {
      if (alive) {
        failures.set(id, e.message);
        if (action === 'install' || action === 'login') states.set(id, { status: 'failed', error: e.message });
      }
    }
    finally {
      pending.delete(id);
      if (alive) { render(); await refresh(false, recheck); }
    }
  }

  return { refresh, act, destroy() { alive = false; clearTimeout(timer); generation++; } };
}
