import { THEME_KEYS } from './bridge/theme-contract.js';
import { colorPicker } from './color-picker.js';
// 左の欄の［テーマ］タブ（設計書 §10.10）。今のテーマの色・フォントを直す。
// - 欄を動かしている間は見本・スライドの :root に直接当て、確定したらすぐ themes/<テーマ>.css に書く（1回の確定を ⌘Z の1回に）
// - 実スライドを絞り込み、該当がない表現だけ見本に自動で切り替える
// - 欄を押すと、その変数が効いている所を囲む。見本では、その欄のページに移る
import { api, toast } from './api.js';
import { S } from './strings.js';
import { svg } from './icons.js';
import { tip } from './tip.js';
import { leftTabs } from './left-tabs.js';
import { themeCards, resetTheme } from './themes.js';
import { Preview } from './preview.js';

const T = S.themes.tab;
const FILL = '--header-fill';
// 背景はページ・章・タイトル（表紙）で別々。順はタブの並び
const BGS = ['--background-fill', '--section-fill', '--cover-fill'];
const FILLS = [FILL, ...BGS];
const KIND = {
  '--background-fill': s => !s.matches('.cover, .section-slide'),
  '--section-fill': s => s.matches('.section-slide'),
  '--cover-fill': s => s.matches('.cover'),
};
const SAMPLE_URL = '/files/decks/__theme-sample__/sample.html';
// 見本のページ（0 表紙・1 見出しと本文・2 ハイライトと表）。地は今のページのまま
const PAGE = { '--link': 2, '--mark': 2, '--mark-ink': 2, '--rule': 2, '--paper': null, '--table-header-bg': 2, '--table-header-ink': 2, '--table-ink': 2, '--math-ink': 2 };
const CONTENT = {
  '--table-header-bg': ['table th', 'background'],
  '--table-header-ink': ['table th', 'color'],
  '--table-ink': ['table td', 'color'],
  '--math-ink': [':is(.math, math)', 'color'],
};
function hex(value) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = value; c.fillRect(0, 0, 1, 1);
  return '#' + [...c.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
}

export function makeThemeTab(ctx) {
  const panel = ctx.root.querySelector('#editor'), stage = ctx.root.querySelector('#stage');
  let alive = true, name = null, version = null, vars = {}, fonts = [], modified = null, shown = false, mode = 'real';
  let focusKey = null, markedAt = null, sample = null;
  let sampleReady = null;
  const remoteColors = new WeakMap();
  const live = new Map(); // 確定前・書き込み中の値（見本とスライドの :root に当てる）

  const view = document.createElement('div');
  view.className = 'theme-view'; view.setAttribute('role', 'tabpanel'); view.setAttribute('aria-label', S.tabTheme);
  view.dataset.undoKeys = '';
  view.innerHTML = `<div class="tv-themes" role="group" aria-label="${T.list}"></div>
    <div class="tv-selection-lock" role="status" hidden>${svg('lock')}<span>${T.selectionLocked}</span></div>
    <div class="theme-fields"></div><div class="theme-fonts"></div>
    <div class="tv-actions"><button type="button" class="ibtn tv-default">${svg('rotateCcw')}</button></div>
    <div class="memo-foot"><span class="where"></span></div>`;
  panel.querySelector('#qscroll').after(view);
  // テーマの一覧（最近選んだ順に横に並べる）。並びはタブを開いたときに決め、開いている間は押しても動かさない
  const strip = view.querySelector('.tv-themes');
  let themes = [], order = [];
  async function loadThemes(reorder) {
    const r = await api('/api/themes'); if (!alive) return;
    themes = r.themes; fonts = r.fonts;
    const all = themes.map(t => t.name), now = ctx.structure?.meta.theme || 'default';
    order = [...new Set([...(reorder ? [now, ...r.recent] : order), ...all])].filter(n => all.includes(n));
    drawThemes();
    if (reorder) strip.scrollLeft = 0;
  }
  function drawThemes() {
    const byName = new Map(themes.map(t => [t.name, t]));
    themeCards(strip, order.map(n => byName.get(n)), n => ctx.selectTheme(n).catch(e => toast(e.message)), name); // 削除はホームの一覧だけ
    syncSelectionLock();
  }
  function syncSelectionLock() {
    const blocked = !!ctx.locked;
    view.querySelector('.tv-selection-lock').hidden = !blocked;
    strip.querySelectorAll('.theme-thumb').forEach(button => {
      button.disabled = blocked;
      button.dataset.tip = blocked ? T.selectionLocked : S.themes.choose(button.dataset.theme);
    });
  }
  const defaultButton = view.querySelector('.tv-default');
  defaultButton.onclick = () => {
    const targetName = name;
    resetTheme(name, saveAs => {
      const task = saving.then(async () => {
        if (locked || name !== targetName) throw new Error(S.locked);
        live.clear();
        await put({ reset: true, ...(saveAs ? { save_as: saveAs } : {}) }, [], r => ctx.recordHistory({ undo: () => put({ css: r.before }, []), redo: () => put({ css: r.css }, []) }));
        if (saveAs) await loadThemes(false);
      });
      saving = task.catch(() => { fill(); });
      pending.add(task); task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    });
  };

  // 見本は該当ページがない場合のみ自動表示。全ページへの解除だけを用意する。
  const bar = document.createElement('div'); bar.className = 'theme-stagebar';
  bar.innerHTML = `<span class="tv-status"></span><button type="button" class="btn tv-reset">${T.all}</button>`;
  stage.prepend(bar);
  bar.querySelector('button').onclick = () => { focusKey = null; mode = 'real'; clearMarks(); sync(); fill(); };
  let matches = null, selection = 0;
  function filter() {
    const indices = shown && mode === 'real' ? matches : null;
    ctx.preview.api?.setFilter(indices);
    ctx.root.querySelectorAll('#pagestrip button[data-index]').forEach(b => { b.hidden = !!indices && !indices.includes(+b.dataset.index); });
    bar.querySelector('.tv-status').textContent = sampleOn() ? (matches === null ? T.sample : T.fallback(S.themes.vars[focusKey])) : indices ? T.matches(S.themes.vars[focusKey], indices.length) : '';
    bar.hidden = !sampleOn() && !focusKey;
    bar.querySelector('button').hidden = !focusKey;
  }
  const box = document.createElement('div'); box.className = 'slide-box theme-sample'; box.hidden = true;
  ctx.root.querySelector('#viewport').append(box);

  const side = leftTabs(ctx);
  side.add('theme', 'palette', S.tabTheme, () => sync());

  const sampleOn = () => shown && mode === 'sample';
  const target = () => sampleOn() ? sample : ctx.preview;
  function sync() {
    const wasShown = shown;
    shown = side.shown('theme');
    if (shown && !wasShown) { focusKey = null; matches = null; mode = 'real'; }
    ctx.plugins.find(p => p.setMode)?.setMode(shown ? 'theme' : side.shown('memo') ? 'memo' : 'slides');
    stage.classList.toggle('theme-on', shown);
    for (const p of previews()) p.client.request('theme.configure',{shown,sample:p===sample}).catch(()=>{});
    ctx.blocks?.setReadOnly(sampleOn());
    stage.classList.toggle('theme-sample-on', sampleOn());
    box.hidden = !sampleOn();
    if (!focusKey) matches = null;
    filter();
    if (shown && !name) load();
    else if (shown && !wasShown) loadThemes(true).catch(e => toast(e.message));
    if (sampleOn() && !sample && name) {
      sample = new Preview(box, null, {
        url: () => `${SAMPLE_URL}?theme=${encodeURIComponent(name)}`,
        onLoad: () => { attachClicks(sample); paint(); if (focusKey) show(focusKey); },
        onChange: d => { if (d.index !== markedAt) clearMarks(); },
      });
      sampleReady = sample.load();
    }
    if (!shown) { clearMarks(); }
    else if (focusKey && !wasShown) show(focusKey);
  }


  // ------------------------------------------------------------ 値を当てる・書く
  const previews = () => [sample, ctx.preview].filter(p => p?.client);
  function previewValue(key, value) {
    live.set(key, value); paint();
  }
  function paint() {
    const pick = values => Object.fromEntries(Object.entries(values).filter(([k,v])=>THEME_KEYS.includes(k)&&typeof v==='string'));
    for(const p of previews()){
      const client=p.client;
      client.request('theme.preview',{vars:pick(vars),values:pick(Object.fromEntries(live)),shown}).then(r=>{
        if(alive&&p.client===client&&r?.colors){remoteColors.set(p,r.colors);if(name)fill();}
      }).catch(()=>{});
    }
    sample?.backdrop();ctx.preview.backdrop();
  }
  // テーマの CSS を読み直し、読み終えたら当てていた値を外す
  function reloadCss(keys) {
    return Promise.all([sample, ctx.preview].filter(Boolean).map(p => p.setTheme(name))).then(() => {
      keys.forEach(([k, v]) => { if (live.get(k) === v) live.delete(k); }); paint();
    });
  }

  let locked = false, failed = false;
  const pending = new Set();
  // この画面で書いた回数。読み直しの返事が届くまでに書いていたら、その返事（古い状態）で上書きしない
  let edits = 0;
  // saved は書けたらすぐ呼ぶ（取り消しの履歴は CSS の読み直しを待たずに積む。待つ間に欄が先に変わり、⌘Z が1つ前を戻すため）
  async function put(body, keys, saved) {
    const r = await api(`/api/themes/${encodeURIComponent(name)}`, { method: 'PUT', body: { ...body, base: version } });
    edits++;
    version = r.version; vars = r.vars; modified = r.modified;
    if (r.before !== r.css) saved?.(r);
    await reloadCss(keys); fill();
    return r;
  }
  let saving = Promise.resolve();
  function commit(key, value, extra = {}) {
    saving = saving.then(() => commitNow(key, value, extra));
    return saving;
  }
  async function commitNow(key, value, extra) {
    // 同じ値の確定は書かない。後から当てた別の値（次の確定を待っている）は消さない
    if (!CONTENT[key] && !['--header', '--header-ink'].includes(key) && value === hexOf(key) && Object.entries(extra).every(([k,v]) => v === vars[k])) { if (live.get(key) === value) live.delete(key); paint(); return; }
    if (locked) { toast(S.locked); live.delete(key); paint(); fill(); return; }
    failed = false;
    try {
      const updates = { [key]: value, ...extra };
      if (live.has('--heading-mode')) updates['--heading-mode'] = live.get('--heading-mode');
      if ((key === '--header' || key === FILL) && live.has('--header-ink')) updates['--header-ink'] = live.get('--header-ink');
      const at = n => async () => { await put({ css: n }, []); show(key === FILL ? '--header' : key === BGS[0] ? '--paper' : key); };
      await put({ vars: updates }, Object.entries(updates), r => ctx.recordHistory({ undo: at(r.before), redo: at(r.css) }));
    } catch (e) { failed = true; live.delete(key); paint(); fill(); toast(e.message); }
  }
  const hexOf = k => k.startsWith('--block-') || k.startsWith('--heading-') ? vars[k] : k.startsWith('--font-') || FILLS.includes(k) ? vars[k] : hex(vars[k]);
  // テーマ標準では変数と描画色が一致しないことがある。単色の欄は実際の色に合わせる。
  const contentColor = key => live.get(key) ?? remoteColors.get(target())?.[key] ?? hexOf(key);
  const headingColor = contentColor;
  function openColor(key, input) {
    view.querySelector('.tv-inline-color')?.remove();
    const box = colorPicker({
      title: S.themes.vars[key], value: input.value,
      palette: ['--paper', '--ink', '--accent', '--header', '--good', '--warn'].map(hexOf),
      preview: value => { input.value = value; input.oninput(); },
      commit: value => { input.value = value; input.onchange(); },
      close: () => { box.remove(); input.focus(); },
    });
    box.dataset.key = key;
    input.closest('label').after(box);
  }

  // 欄はテーマを開いたときに作り、書いた後は値だけ合わせる（色の選択中に欄を作り直さない）
  function build() {
    const colors = view.querySelector('.theme-fields'), faces = view.querySelector('.theme-fonts');

    colors.replaceChildren(); faces.replaceChildren();
    for (const [key, value] of Object.entries(vars)) {
      if (['--paper','--header','--rule','--font-head'].includes(key) || key === '--mark-line' || FILLS.includes(key) || key.startsWith('--block-') || key.startsWith('--heading-')) continue;
      const label = document.createElement('label'); label.dataset.tip = T.field(S.themes.vars[key]);
      label.dataset.key = key;
      const text = document.createElement('span'); text.textContent = S.themes.vars[key];
      let input;
      if (key.startsWith('--font-')) {
        const choices = document.createElement('div'); choices.className = 'tv-font-choices';
        choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', S.themes.vars[key]);
        fonts.forEach(v => {
          const button = document.createElement('button'); button.type = 'button'; button.dataset.font = v;
          const title = document.createElement('span'); title.textContent = S.themes.fonts[fonts.indexOf(v)] || v;
          const preview = document.createElement('span'); preview.className = 'tv-font-sample';
          preview.style.fontFamily = v; preview.textContent = T.fontSample;
          button.append(title, preview);
          button.onclick = () => { show(key); live.set(key, v); paint(); fill(); const task = commit(key, v); pending.add(task); task.finally(() => pending.delete(task)); };
          choices.append(button);
        });
        label.append(text, choices); faces.append(label);
        continue;
      } else {
        input = document.createElement('input'); input.type = 'color'; input.setAttribute('aria-label', S.themes.vars[key]);
        input.addEventListener('click', e => { e.preventDefault(); openColor(key, input); });
        label.append(input, text); colors.append(label);
      }
      input.name = key;
      // 通常の色欄は単色。グラデーションの各ポイントは独立して編集する。
      const solid = () => key === '--header' ? { [FILL]: 'var(--header)' } : {};
      const previewSolid = () => { previewValue(key, input.value); Object.entries(solid()).forEach(([k,v]) => previewValue(k,v)); };
      input.oninput = previewSolid;
      input.onchange = () => { previewSolid(); const task = commit(key, input.value, solid()); pending.add(task); task.finally(() => pending.delete(task)); };
      label.addEventListener('pointerdown', () => show(key));
      input.addEventListener('focus', () => show(key));
    }
    function section(title, nodes) {
      const section = document.createElement('section'); section.className = 'tv-section';
      const heading = document.createElement('h3'); heading.textContent = title;
      section.append(heading, ...nodes); colors.append(section); return section;
    }
    section(S.themes.controls.text, ['--ink', '--muted', '--accent', '--link'].map(k => colors.querySelector(`[data-key="${k}"]`)));
    section(S.themes.controls.emphasis, ['--good', '--warn', '--mark', '--mark-ink', ...Object.keys(CONTENT)].map(k => colors.querySelector(`[data-key="${k}"]`)));
    const heading = section(S.themes.controls.heading, [colors.querySelector('[data-key="--header-ink"]')]);
    const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = S.themes.controls.headingHint; heading.append(hint);
    fill();
  }
  function fill() {
    view.querySelector('.where').textContent = T.file(name);
    defaultButton.disabled = !modified || locked;
    tip(defaultButton, modified ? S.themes.reset(name) : modified === false ? S.themes.resetNone(name) : S.themes.resetMissing(name));
    view.querySelectorAll('label[data-key]').forEach(l => {
      const key = l.dataset.key, input = l.querySelector('input, select');
      l.classList.toggle('on', key === focusKey);
      if (!input) {
        l.querySelectorAll('[data-font]').forEach(b => { b.disabled = locked; b.setAttribute('aria-pressed', String(b.dataset.font === (live.get(key) ?? vars[key]))); });
        return;
      }
      input.disabled = locked;
      input.value = CONTENT[key] ? contentColor(key) : ['--header', '--header-ink'].includes(key) ? headingColor(key) : live.get(key) ?? (key.startsWith('--heading-') ? vars[key] : hexOf(key));
      const picker = view.querySelector('.tv-inline-color');
      if (picker?.dataset.key === key) { picker.refresh(input.value); picker.querySelectorAll('input, button').forEach(e => { e.disabled = locked; }); picker.inert = !!locked; }
    });
  }
  function saveField(key, value) {
    previewValue(key, value);
    const task = commit(key, value); pending.add(task); task.finally(() => pending.delete(task));
  }
  async function load() {
    const want = ctx.structure?.meta.theme || 'default', asked = edits;
    try {
      const t = await api(`/api/themes/${encodeURIComponent(want)}`);
      if (!alive || (name === want && (edits !== asked || pending.size))) return;
      if (!fonts.length) await loadThemes(!order.length);
      const changed = name !== want;
      name = want; locked = t.locked; version = t.version; vars = t.vars; modified = t.modified;
      if (changed) { live.clear(); focusKey = null; matches = null; mode = 'real'; clearMarks(); sample?.load(); }
      build(); paint(); if (themes.length) drawThemes();
      if (shown) sync();
    } catch (e) { toast(e.message); }
  }

  // 色の欄を選びつつ、実スライドのクリックは通常の編集にも渡す。
  const clickClients = new Map();
  function attachClicks(p) {
    const client=p?.client;if(!client||clickClients.get(p)?.client===client)return;
    clickClients.get(p)?.off();
    const off=client.on('theme.select',event=>{
      if(!shown||p.client!==client||event.sourceVersion!==p.sourceVersion||!view.querySelector(`label[data-key="${event.key}"]`))return;
      ++selection;focusKey=event.key;matches=null;filter();fill();reveal(focusKey);markedAt=p.index;
    });
    clickClients.set(p,{client,off});
    client.request('theme.configure',{shown,sample:p===sample}).catch(()=>{});
  }
  attachClicks(ctx.preview);
  function clearMarks(){for(const p of previews())p.client.request('theme.mark',{key:null}).catch(()=>{});markedAt=null;}
  // 閉じた［見出し］の中の欄を選んだら開く
  function reveal(key) {
    const field = view.querySelector(`label[data-key="${key === BGS[0] ? '--paper' : key === FILL ? '--header' : key}"]`);
    const details = field?.closest('details.tv-section-toggle');
    if (details) details.open = true;
    return field;
  }
  async function show(key) {
    focusKey=key;view.querySelectorAll('label[data-key]').forEach(l=>l.classList.toggle('on',l.dataset.key===key));reveal(key);
    const ticket=++selection;if(!shown||!ctx.preview.client)return;clearMarks();
    const real=await ctx.preview.client.request('theme.inspect',{key});
    if(ticket!==selection||!shown)return;remoteColors.set(ctx.preview,real.colors);matches=real.matches;mode=matches.length?'real':'sample';sync();
    if(sampleOn())await sampleReady;
    const p=target();if(!p?.client||ticket!==selection||!shown)return;
    if(p===ctx.preview&&!matches.includes(p.index))await p.go(matches[0],0);
    if(p===sample){
      const data=await p.client.request('theme.inspect',{key});remoteColors.set(p,data.colors);
      const preferred=key in PAGE?PAGE[key]??p.index:KIND[key]?data.matches[0]:1;
      const index=data.matches.includes(preferred)?preferred:data.matches[0];
      if(index==null){toast(T.nowhere(S.themes.vars[key]));return;}
      await p.go(index,0);
    }
    if(ticket!==selection||!shown)return;
    const count=await p.client.request('theme.mark',{key});markedAt=p.index;
    if(!count&&!KIND[key])toast(T.unused(S.themes.vars[key]));fill();
  }
  ctx.theme = {
    async flush() {
      await Promise.all([...pending]);
      if (!await ctx.flush()) return false;
      return !!version && !failed && !live.size && name === (ctx.structure?.meta.theme || 'default');
    },
    get version() { return version; },
  };

  return {
    keydown(e) {
      // 見本を出している間は ↑↓ で見本をめくる
      if (!sampleOn() || !sample?.api || e.metaKey || e.ctrlKey || e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return false;
      e.preventDefault(); sample.go(Math.max(0, Math.min(2, sample.index + (e.key === 'ArrowDown' ? 1 : -1))), 0); return true;
    },
    previewLoaded() { attachClicks(ctx.preview); paint(); if (name) fill(); if (focusKey && shown && matches !== null) show(focusKey); },
    // 欄の色は描いた見出しから読む（default の見出しはグラデーションなど）。テーマの CSS が替わったら読み直す
    previewThemed() { paint(); if (name) fill(); },
    stripRendered() { filter(); },
    slideChanged(d) { if (shown && focusKey && !KIND[focusKey] && !sampleOn() && d.index !== markedAt) {
      clearMarks();ctx.preview.client?.request('theme.mark',{key:focusKey}).catch(()=>{});markedAt=d.index;
    } },
    rendered() { if (name && (ctx.structure?.meta.theme || 'default') !== name) load(); },
    editorToggled() { sync(); },
    statusChanged: syncSelectionLock,
    event(ev) {
      if (shown && ev.type === 'theme-shots') loadThemes(false).catch(() => {});
      if (name && ev.type === 'theme-lock') {
        api(`/api/themes/${encodeURIComponent(name)}`).then(t => { if (alive) { locked = t.locked; fill(); } }).catch(() => {});
      }
      // 外（AI・別の画面）でテーマが変わったら読み直す
      if (name && ev.type === 'files' && ev.paths.includes(`themes/${name}.css`)) {
        // 待っている間にこの画面で保存した（保存待ちがある）なら、届いた古い状態で上書きしない
        const asked = edits;
        api(`/api/themes/${encodeURIComponent(name)}`).then(t => {
          if (!alive || t.version === version || edits !== asked || pending.size) return;
          version = t.version; vars = t.vars; modified = t.modified; build(); sample?.setTheme(name);
          if (focusKey) setTimeout(() => show(focusKey), 100);
        }).catch(() => {});
      }
    },
    destroy() { for(const p of previews())p.client.request('theme.configure',{shown:false,sample:p===sample}).catch(()=>{});alive=false;for(const {off} of clickClients.values())off();clickClients.clear();clearMarks();sample?.destroy();bar.remove();box.remove();view.remove(); },
  };
}
