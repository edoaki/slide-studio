import { api, esc, toast } from './api.js';
import { S } from './strings.js';
import { svg } from './icons.js';
import './custom-select.js';
import { homeUpdates, installUpdateNotifications } from './home-updates.js';
import { homeAi } from './home-ai.js';
import { openLocationDialog } from './location.js';
import { preferences, savePreferences } from './preferences.js';
import { navigate, flushBeforeLeave } from './app.js';
const T = S.settings;
let currentDialog;
const row = (title, hint, control) => `<div class="setting-row"><div><b>${title}</b>${hint ? `<p>${hint}</p>` : ''}</div><div class="setting-control">${control}</div></div>`;
const toggle = key => row(T[key], T[key + 'Hint'], `<input type="checkbox" role="switch" data-setting="${key}" aria-label="${T[key]}">`);
export function openSettings(tab = 'general') {
  if (currentDialog?.open) { currentDialog.focus(); return; }
  const d = document.createElement('dialog'); currentDialog = d;
  d.className = 'settings-dialog'; d.setAttribute('aria-labelledby', 'settings-title');
  d.innerHTML = `<aside class="settings-nav"><h2 id="settings-title">${T.title}</h2><nav aria-label="${T.title}">${Object.entries(T.tabs).map(([key,label]) => `<button data-tab="${key}" aria-current="false">${label}${key === 'general' ? `<span class="update-badge" aria-hidden="true">${S.updates.notice}</span>` : ''}</button>`).join('')}</nav></aside><main class="settings-main"><header><h2></h2><button class="ibtn settings-close" data-close aria-label="${S.close}">${svg('x')}</button></header><div class="settings-content"></div><p class="settings-status" role="status"></p></main>`;
  document.body.append(d);
  const content = d.querySelector('.settings-content');
  let stop = () => {}, generation = 0;
  const sync = () => d.querySelectorAll('[data-setting]').forEach(el => {
    const v = preferences()[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  });
  const sections = {
    general: {
      html: () => row(T.location, T.locationHint, `<button class="btn" data-location>${S.location.manage}</button>`) + `<p class="setting-path"></p><div class="home-updates"></div><details class="settings-environment"><summary>${T.environment}</summary><p class="settings-intro">${T.environmentHint}</p><div class="settings-actions"><button class="btn" data-refresh>${S.refresh}</button><button class="btn" data-copy disabled>${T.copy}</button></div><ul class="settings-diagnostics"></ul></details>` + row(T.license,T.licenseText,''),
      mount: async () => {
        stop = homeUpdates(content.querySelector('.home-updates'));
        const mine = generation;
        await Promise.all([
          api('/api/location').then(data => { if (mine === generation && d.open) content.querySelector('.setting-path').textContent = data.current; }),
          loadEnvironment(),
        ]);
      },
    },
    appearance: { html: () => `<p class="settings-intro">${T.appearanceHint}</p>` + row(T.theme, '', `<studio-select variant="segmented" data-setting="theme" aria-label="${T.theme}">${Object.entries(T.themes).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}</studio-select>`) + row(T.zoom, T.zoomHint, `<studio-select data-setting="zoom" aria-label="${T.zoom}">${Array.from({length:16},(_,i)=>75+i*5).map(n=>`<option value="${n}">${n}%</option>`).join('')}</studio-select><button class="btn" data-reset>${T.reset}</button>`) + toggle('keyHints') + toggle('tooltips') + toggle('tooltipKeys') },
    shortcuts: { html: () => `<p class="settings-intro">${T.shortcutHint}</p>` + T.shortcutGroups.map((group,i)=> `<h3>${group}</h3>` + T.shortcuts.filter(r=>r[0]===i).map(([,key,label])=>`<div class="setting-row shortcut-row"><b>${label}</b><kbd>${key}</kbd></div>`).join('')).join('') },
    ai: { html: () => `<p class="settings-intro">${T.aiHint}</p><ul class="env-list env-ai"></ul>` + row(S.agents.title,T.agentsHint,`<button class="btn" data-agents>${S.agents.open}</button>`), mount: () => {
      const ai = homeAi(content.querySelector('.env-ai')); stop = () => ai.destroy();
      content.onclick = e => { const el = e.target.closest('[data-act]'); if(el?.dataset.act.startsWith('ai-')) void ai.act(el).catch(e=>toast(e.message)); };
      void ai.refresh();
    } },
  };
  let environmentText = '';
  async function loadEnvironment(refresh = false) {
    const mine = generation;
    const env = await api('/api/env' + (refresh ? '?refresh=1' : ''));
    if (!d.open || mine !== generation) return;
    const list = [...env.items, {name:T.platform, detail:navigator.userAgent, ok:true}];
    environmentText = list.map(i=>`${i.ok ? 'OK' : 'NG'} ${i.name}: ${i.detail}`).join('\n');
    content.querySelector('.settings-diagnostics').innerHTML = list.map(i=>`<li><div class="diagnostic-head"><b>${esc(i.name)}</b><span class="${i.ok?'ok':'ng'}">${i.ok ? T.ready : T.needsAttention}</span></div><p class="diagnostic-detail">${esc(i.detail)}</p>${!i.ok && i.fix ? `<p class="diagnostic-fix">${esc(i.fix)}</p>`:''}</li>`).join('');
    content.querySelector('[data-copy]').disabled = false;
  }
  function show(key) {
    stop(); stop = () => {}; content.onclick = null; generation++; tab = key;
    d.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.tab===tab)));
    d.querySelector('.settings-main h2').textContent = T.tabs[tab];
    content.innerHTML = `<section data-section="${tab}">${sections[tab].html()}</section>`;
    content.scrollTop = 0; sync();
    Promise.resolve(sections[tab].mount?.()).catch(e=>{ if(d.open) toast(e.message); });
  }
  const outside = e => {
    const r = d.getBoundingClientRect();
    return e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  let backdropDown = false;
  d.addEventListener('pointerdown', e => { backdropDown = outside(e); });
  d.addEventListener('cancel', e => { e.preventDefault(); d.close(); });
  d.addEventListener('click', async e => {
    if (backdropDown && outside(e)) { d.close(); return; }
    backdropDown = false;
    const b = e.target.closest('button'); if(!b) return;
    try {
      if (b.dataset.tab) show(b.dataset.tab);
      if (b.hasAttribute('data-close')) d.close();
      if (b.hasAttribute('data-location') && await flushBeforeLeave()) openLocationDialog();
      if (b.hasAttribute('data-reset')) await savePreferences({zoom:100});
      if (b.hasAttribute('data-refresh')) { b.disabled=true; try { await loadEnvironment(true); } finally { b.disabled=false; } }
      if (b.hasAttribute('data-copy')) { await navigator.clipboard.writeText(environmentText); toast(T.copied); }
      if (b.hasAttribute('data-agents')) { d.close(); await navigate('/agents'); }
    } catch(e) { toast(e.message); }
  });
  d.addEventListener('change', async e => {
    const el = e.target.closest('[data-setting]'); if (!el) return;
    if (!el.checkValidity()) { el.reportValidity(); sync(); return; }
    const key = el.dataset.setting, v = el.type==='checkbox' ? el.checked : key==='theme' ? el.value : Number(el.value);
    const status = d.querySelector('.settings-status'); status.textContent = T.saving;
    try { await savePreferences({[key]:v}); status.textContent = T.saved; } catch { status.textContent = ''; sync(); }
  });
  addEventListener('studio-settings-change', sync);
  d.addEventListener('close', () => { stop(); generation++; removeEventListener('studio-settings-change',sync); d.remove(); currentDialog=null; }, {once:true});
  d.showModal(); show(tab); d.querySelector('[data-tab][aria-current=true]').focus();
}
export function installSettings() {
  installUpdateNotifications();
  addEventListener('studio-settings-command', e => {
    if (document.querySelector('.speaker-screen,.present-screen')) return;
    if (e.detail === 'open') { openSettings(); return; }
    if (!['in','out','reset'].includes(e.detail)) return;
    void savePreferences(current => ({zoom: e.detail === 'reset' ? 100 : Math.max(75,Math.min(150,current.zoom + (e.detail === 'out' ? -5 : 5)))})).catch(()=>{});
  });
  document.addEventListener('click', e => { if(e.target.closest('[data-open-settings]')) openSettings(); });
  addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Escape' && currentDialog?.open && [...document.querySelectorAll('dialog[open]')].at(-1) === currentDialog) {
      e.preventDefault(); e.stopImmediatePropagation(); currentDialog.close(); return;
    }
    const modifier = e.metaKey || e.ctrlKey;
    // Native modal dialogs isolate editor and presentation shortcuts.
    if (modifier && !e.altKey && e.key===',' && !document.querySelector('.speaker-screen,.present-screen')) {
      e.preventDefault(); e.stopImmediatePropagation(); openSettings(); return;
    }
    if (modifier && !e.altKey && ['+','=','-','0'].includes(e.key) && !document.querySelector('.speaker-screen,.present-screen')) {
      e.preventDefault(); e.stopImmediatePropagation();
      const key = e.key;
      void savePreferences(current => ({zoom: key==='0' ? 100 : Math.max(75,Math.min(150,current.zoom + (key==='-' ? -5 : 5)))})).catch(()=>{}); return;
    }
    if (currentDialog?.open) e.stopImmediatePropagation();
  }, true);
  addEventListener('keyup', e => { if(currentDialog?.open) e.stopImmediatePropagation(); },true);
}
