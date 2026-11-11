// ホームから開く、担当別の指示。必須の指示（置き場の AGENTS.md と skill）は読むだけ、追加指示は書ける。
import { api, esc } from './api.js';
import { S } from './strings.js';
import { svg } from './icons.js';
import { tip } from './tip.js';

export function mountAgents(root) {
  const T = S.agents;
  document.title = `${T.title} · ${S.appName}`;
  document.body.className = 'home-page';
  root.innerHTML = `<div class="home agents-home"><header class="home-bar"><a class="ibtn" href="/" data-nav>${svg('chevL')}</a><span class="grow"></span><span>${S.appName}</span></header>
    <main class="home-main"><h1>${T.title}</h1><p class="muted">${T.intro}</p><div class="agents-layout"><nav class="agents-nav" aria-label="${T.roles}"></nav><section class="agent-detail" aria-live="polite"><p>${S.status.loading}</p></section></div></main></div>`;
  let alive = true, data, selected = 'chat', timer = 0, pending = null;
  const nav = root.querySelector('.agents-nav'), detail = root.querySelector('.agent-detail');
  tip(root.querySelector('[data-nav]'), T.home);
  const name = id => T.names[id] || id;
  // 追加指示は書くと少し待って保存する。担当を移る・画面を離れるときは待たずに保存する。
  async function save() {
    clearTimeout(timer);
    const job = pending;
    pending = null;
    if (!job) return;
    const { role, text, status } = job;
    status.textContent = T.extraSaving;
    try {
      role.extra = (await api(`/api/ai/roles/${role.id}/extra`, { method: 'PUT', body: { text } })).extra;
      if (alive && !pending) status.textContent = T.extraSaved;
    } catch (e) { status.textContent = e.message; }
  }
  function draw() {
    if (!alive || !data) return;
    nav.innerHTML = data.roles.map(r => `<div class="agent-role ${selected === r.id ? 'on' : ''}"><button class="ibtn" data-role="${r.id}" aria-current="${selected === r.id ? 'page' : 'false'}">${svg('eye')}</button><div>${esc(name(r.id))}<span>${esc(T.kinds[r.id] || (r.readonly ? T.specialist : T.conversation))}</span></div></div>`).join('');
    nav.querySelectorAll('button').forEach(b => { tip(b, T.show(name(b.dataset.role))); b.onclick = () => { save(); selected = b.dataset.role; draw(); }; });
    const role = data.roles.find(r => r.id === selected), max = data.extra_limit;
    detail.innerHTML = `<div class="agent-heading"><h2>${esc(name(role.id))}</h2></div><p>${esc(T.descriptions[role.id])}</p>
      <p class="agent-native">${esc(T.native(role.skill))}${role.readonly ? ` ${esc(T.readonlyWork)}` : ''}</p>
      <h3>${T.extra}</h3><p class="agent-hint">${esc(T.extraHint)}${esc(T.extraTip)}</p>
      <textarea class="agent-extra" rows="5" maxlength="${max}" aria-label="${T.extra}" placeholder="${esc(T.extraPlaceholder)}">${esc(role.extra)}</textarea>
      <div class="agent-extra-foot"><span class="agent-extra-status" role="status"></span><span class="agent-extra-count"></span></div>
      <h3>${T.base}</h3><p class="agent-hint">${esc(T.baseHint)}</p>
      ${role.base.map(f => `<div class="agent-base"><code>${esc(f.path)}</code><pre class="agent-prompt">${esc(f.text)}</pre></div>`).join('')}`;
    const box = detail.querySelector('.agent-extra'), status = detail.querySelector('.agent-extra-status'), count = detail.querySelector('.agent-extra-count');
    const counted = () => { count.textContent = T.extraCount(box.value.length, max); };
    counted();
    box.oninput = () => {
      counted();
      pending = { role, text: box.value, status };
      status.textContent = '';
      clearTimeout(timer);
      timer = setTimeout(save, 700);
    };
    box.onblur = save;
  }
  api('/api/ai/roles').then(result => { if (alive) { data = result; draw(); } }).catch(e => { if (alive) detail.textContent = e.message; });
  return () => { save(); alive = false; };
}
