import { colorPicker } from './color-picker.js';
import { gradientEditor } from './gradient-editor.js';
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
const LIVE_ID = { '--background-fill': 'theme-live-background', '--section-fill': 'theme-live-background-section', '--cover-fill': 'theme-live-background-cover' };
const KIND_CSS = { '--background-fill': '#stage .slide:not(.cover):not(.section-slide)', '--section-fill': '#stage .slide.section-slide', '--cover-fill': '#stage .slide.cover' };
const SAMPLE_URL = '/files/decks/__theme-sample__/sample.html';
// 見本のページ（0 表紙・1 見出しと本文・2 ハイライトと表）。地は今のページのまま
const PAGE = { '--link': 2, '--mark': 2, '--mark-ink': 2, '--rule': 2, '--paper': null, '--table-header-bg': 2, '--table-header-ink': 2, '--table-ink': 2, '--math-ink': 2 };
const CONTENT = {
  '--table-header-bg': ['table th', 'background'],
  '--table-header-ink': ['table th', 'color'],
  '--table-ink': ['table td', 'color'],
  '--math-ink': [':is(.math, math)', 'color'],
};
const TEXT = ['color', '-webkit-text-fill-color', 'font-family'];
// 地・枠など。枠・下線の色は文字の色に付いて変わるので、描かれているものだけを比べる
const box = (s, svgEl) => [s.backgroundColor, s.backgroundImage, s.boxShadow,
  ...['top', 'right', 'bottom', 'left'].map(d => s.getPropertyValue(`border-${d}-style`) !== 'none' && parseFloat(s.getPropertyValue(`border-${d}-width`)) ? s.getPropertyValue(`border-${d}-color`) : ''),
  s.outlineStyle !== 'none' ? s.outlineColor : '', s.textDecorationLine !== 'none' ? s.textDecorationColor : '',
  svgEl ? s.fill + s.stroke : ''].join('|');

function hex(value) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = value; c.fillRect(0, 0, 1, 1);
  return '#' + [...c.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
}

// その変数で見た目が変わる所（変数を一瞬だけ別の値にして、計算後のスタイルを比べる）。
// 文字の色・フォントはその文字だけ、地・枠などは要素、ページの地はページ全体
function partsOf(w, slide, key) {
  const root = w.document.documentElement;
  // 色のプローブを transition の途中値で比較しない。復元まで無効化する。
  const probe = w.document.createElement('style');
  probe.textContent = '#stage *, #stage *::before, #stage *::after { transition: none !important; }';
  w.document.head.append(probe);
  const active = slide.classList.contains('active');
  slide.classList.add('active');
  // 自動生成のページ番号は本文・見出しの見本には数えない。
  // 見本表示中は実スライドの iframe 自体が隠れるので、矩形ではなく内部の CSS で判定する。
  const visible = e => {
    if (w.getComputedStyle(e).visibility !== 'visible') return false;
    for (let n = e; n && n !== slide.parentElement; n = n.parentElement)
      if (w.getComputedStyle(n).display === 'none') return false;
    return true;
  };
  const els = [slide, ...slide.querySelectorAll('*')].filter(e => !e.closest('.page-number') && visible(e));
  const snap = () => els.map(e => {
    const s = w.getComputedStyle(e), svgEl = e instanceof w.SVGElement;
    return { text: TEXT.map(p => s.getPropertyValue(p)).join('|'), box: box(s, svgEl),
      pseudo: ['::before', '::after'].map(p => {
        const ps = w.getComputedStyle(e, p);
        return ps.content === 'none' || ps.content === 'normal' || ps.display === 'none' ? '' : box(ps, false);
      }).join('|') };
  });
  // 見出しの背景・文字は、テーマ標準の変数の使い方によらず編集対象を示す。
  if (key === '--header' || key === '--header-ink') {
    const headings = [...slide.querySelectorAll('h2')].filter(visible);
    const parts = key === '--header' ? headings : headings.flatMap(h => {
      const walker = w.document.createTreeWalker(h, NodeFilter.SHOW_TEXT), nodes = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim()) nodes.push(n);
      return nodes;
    });
    if (!active) slide.classList.remove('active');
    probe.remove();
    return parts;
  }
  if (CONTENT[key]) {
    const parts = [...slide.querySelectorAll(CONTENT[key][0])].filter(visible);
    if (!active) slide.classList.remove('active');
    probe.remove();
    return parts;
  }
  const before = snap(), old = root.style.getPropertyValue(key);
  root.style.setProperty(key, key.startsWith('--font-') ? 'slide-studio-probe, monospace' : 'rgb(1, 2, 3)');
  const after = snap();
  if (old) root.style.setProperty(key, old); else root.style.removeProperty(key);
  const texts = new Set(), list = [], loose = [];
  els.forEach((e, i) => {
    if (before[i].text !== after[i].text) texts.add(e);
    if (before[i].box !== after[i].box) list.push(e);
    else if (before[i].pseudo !== after[i].pseudo) {
      // 疑似要素（ページの下の線など）。位置を決めてあるものはその所だけ、ほかは持ち主を囲む（ページ自体は、ほかに何も無いときだけ）
      const placed = ['::before', '::after'].filter(which => ['absolute', 'fixed'].includes(w.getComputedStyle(e, which).position));
      if (placed.length) placed.forEach(which => list.push({ host: e, which }));
      else (e === slide ? loose : list).push(e);
    }
  });
  const walk = w.document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.data.trim() && texts.has(n.parentElement)) list.push(n);
  if (!active) slide.classList.remove('active');
  // 復元後の値を確定してから transition を戻す。
  snap(); probe.remove();
  return list.length ? list : loose;
}

// 位置を決めた疑似要素の画面上の四角（ページは縮小して出しているので、その倍率を掛ける）
function pseudoRect(w, e, which) {
  const s = w.getComputedStyle(e, which), r = e.getBoundingClientRect(), k = r.width / (e.offsetWidth || r.width) || 1;
  const px = v => parseFloat(v) || 0;
  const width = px(s.width) + px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth);
  const height = px(s.height) + px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth);
  const left = s.left !== 'auto' ? px(s.left) : (e.offsetWidth || 0) - px(s.right) - width;
  const top = s.top !== 'auto' ? px(s.top) : (e.offsetHeight || 0) - px(s.bottom) - height;
  return new DOMRect(r.left + left * k, r.top + top * k, width * k, height * k);
}

export function makeThemeTab(ctx) {
  const panel = ctx.root.querySelector('#editor'), stage = ctx.root.querySelector('#stage');
  let alive = true, name = null, version = null, vars = {}, fonts = [], modified = null, shown = false, mode = 'real';
  let focusKey = null, marks = [], markedAt = null, sample = null;
  let markFrame = 0, pendingFill = null;
  const openToggles = new Set();
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
        fillEditor.close(); live.clear();
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
    for (const w of [ctx.preview.win, sample?.win].filter(Boolean)) w.document.documentElement.classList.toggle('slide-studio-theme-preview', shown);
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
        onLoad: async () => { attachClicks(sample.win); paint(); if (focusKey) await show(focusKey); if (pendingFill && shown) { fillEditor.open(pendingFill); pendingFill = null; } },
        onChange: d => { if (d.index !== markedAt) clearMarks(); },
      });
      sample.load();
    }
    if (!shown) { pendingFill = null; clearMarks(); fillEditor.close(); }
    else if (focusKey && !wasShown) show(focusKey);
  }


  // ------------------------------------------------------------ 値を当てる・書く
  const wins = () => [sample?.win, ctx.preview.win].filter(Boolean);
  function previewValue(key, value) {
    // 帯のないテーマで背景を初めて設定するときは、表示中の文字色を保つ。
    if ((key === '--header' || key === FILL && value !== 'theme') && vars[FILL] === 'theme' && !live.has('--header-ink')) {
      const w = target()?.win;
      const h = [...(w?.document.querySelectorAll('#stage .slide h2') || [])].find(h => w.getComputedStyle(h).display !== 'none' && !h.closest('.cover'));
      if (h) live.set('--header-ink', hex(w.document.getElementById('gradient-preview-style')?.dataset.headingInk || w.getComputedStyle(h).color));
    }
    if (key === '--header' || key === FILL && value !== 'theme') live.set('--heading-mode', 'fill');
    if (key === FILL && value === 'theme') live.set('--heading-mode', 'theme');
    if (key === '--rule') live.set('--heading-mode', 'rule');
    live.set(key, value); paint();
  }
  function paint() {
    for (const w of wins()) {
      const root = w.document.documentElement;
      // 保存前の色面操作でも表紙・章扉を通常ページの見出しから独立させる。
      let titleColors = w.document.getElementById('theme-live-title-colors');
      if (live.has('--header')) {
        if (!titleColors) {
          titleColors = w.document.createElement('style'); titleColors.id = 'theme-live-title-colors';
          const title = w.document.querySelector('#stage .slide:is(.cover,.section-slide)');
          const value = title ? w.getComputedStyle(title).getPropertyValue('--header').trim() : vars['--header'];
          titleColors.textContent = `#stage .slide:is(.cover,.section-slide) { --header:${value}; }`;
          w.document.head.append(titleColors);
        }
      } else titleColors?.remove();
      let tableColors = w.document.getElementById('theme-live-table-header');
      if (live.has('--header')) {
        if (!tableColors) {
          tableColors = w.document.createElement('style'); tableColors.id = 'theme-live-table-header';
          const table = w.document.querySelector('#stage table');
          const value = table ? w.getComputedStyle(table).getPropertyValue('--header').trim() : vars['--header'];
          tableColors.textContent = `#stage table { --header:${value}; }`;
          w.document.head.append(tableColors);
        }
      } else tableColors?.remove();
      for (const [key, [selector, prop]] of Object.entries(CONTENT)) {
        let style = w.document.getElementById(`theme-live${key}`);
        if (live.has(key)) {
          if (!style) { style = w.document.createElement('style'); style.id = `theme-live${key}`; w.document.head.append(style); }
          style.textContent = `#stage ${selector}${prop === 'color' ? `, #stage ${selector} *` : ''} { ${prop}:var(${key}); }`;
        } else style?.remove();
      }
      root.classList.toggle('slide-studio-theme-preview', shown);
      for (const k of Object.keys(vars)) if (!live.has(k)) { if (k.startsWith('--heading-')) root.style.setProperty(k, vars[k]); else root.style.removeProperty(k); }
      live.forEach((v, k) => root.style.setProperty(k, v));
      let override = w.document.getElementById('theme-live-heading');
      if ((live.has('--header') || live.has('--header-ink') || live.has(FILL)) && (live.has('--header') || (live.get(FILL) ?? vars[FILL]) !== 'theme')) {
        if (!override) { override = w.document.createElement('style'); override.id = 'theme-live-heading'; w.document.head.append(override); }
        root.style.setProperty(FILL, live.get(FILL) ?? (vars[FILL] === 'theme' ? 'var(--header)' : vars[FILL]));
        override.textContent = '#stage h2 { background: var(--header-fill); } #stage h2, #stage h2 * { color: var(--header-ink); } #stage .cover .cover-title, #stage .cover .cover-title p { color: var(--header); }';
      } else override?.remove();
      let ink = w.document.getElementById('theme-live-heading-ink');
      if (live.has('--header-ink')) {
        if (!ink) { ink = w.document.createElement('style'); ink.id = 'theme-live-heading-ink'; w.document.head.append(ink); }
        ink.textContent = '#stage h2, #stage h2 * { color: var(--header-ink); }';
      } else ink?.remove();
      let rule = w.document.getElementById('theme-live-heading-rule');
      if (live.has('--rule')) {
        if (!rule) { rule = w.document.createElement('style'); rule.id = 'theme-live-heading-rule'; w.document.head.append(rule); }
        rule.textContent = '#stage h2 { border-color: var(--rule); } #stage h2::after { background-color: var(--rule); }';
      } else rule?.remove();
      let options = w.document.getElementById('theme-live-options');
      if ([...live.keys()].some(k => k.startsWith('--heading-'))) {
        if (!options) { options = w.document.createElement('style'); options.id = 'theme-live-options'; w.document.head.append(options); }
        const mode = live.get('--heading-mode') ?? vars['--heading-mode'];
        options.textContent = mode === 'rule' ? `#stage .slide > h2 {position:relative;background:none;border:0;box-shadow:none} #stage .slide > h2::after {content:'';display:block;position:absolute;left:var(--heading-rule-inset);right:var(--heading-rule-inset);bottom:0;width:auto;height:0;margin:0;background:none;border:0;border-bottom:var(--heading-rule-width) var(--heading-rule-style) var(--rule)}` : mode === 'fill' ? '#stage .slide > h2 {background:var(--header-fill, var(--header));border:0;box-shadow:none} #stage .slide > h2, #stage .slide > h2 * {color:var(--header-ink)} #stage .slide > h2::after {display:none}' : '';
      } else options?.remove();
      for (const key of BGS) {
        let background = w.document.getElementById(LIVE_ID[key]);
        if (live.has(key) && live.get(key) !== 'theme') {
          if (!background) { background = w.document.createElement('style'); background.id = LIVE_ID[key]; w.document.head.append(background); }
          background.textContent = `${KIND_CSS[key]} { background: var(${key}); box-shadow: none; }`;
        } else background?.remove();
      }
    }
    sample?.backdrop(); ctx.preview.backdrop();
    if (marks.length) place();
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
    saved?.(r);
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
      const at = n => async () => { await put({ css: n }, []); if (!fillEditor.isOpen()) show(key === FILL ? '--header' : key === BGS[0] ? '--paper' : key); };
      await put({ vars: updates }, Object.entries(updates), r => ctx.recordHistory({ undo: at(r.before), redo: at(r.css) }));
    } catch (e) { failed = true; live.delete(key); paint(); fill(); toast(e.message); }
  }
  const hexOf = k => k.startsWith('--block-') || k.startsWith('--heading-') ? vars[k] : k.startsWith('--font-') || FILLS.includes(k) ? vars[k] : hex(vars[k]);
  // テーマ標準では変数と描画色が一致しないことがある。単色の欄は実際の色に合わせる。
  function contentColor(key) {
    if (live.has(key)) return live.get(key);
    const w = target()?.win;
    const el = w?.document.querySelector(`#stage .slide.active ${CONTENT[key][0]}`) || w?.document.querySelector(`#stage ${CONTENT[key][0]}`);
    if (!el) return hexOf(key);
    if (CONTENT[key][1] === 'color') return hex(w.getComputedStyle(el).color);
    for (let n = el; n; n = n.parentElement) {
      const color = w.getComputedStyle(n).backgroundColor;
      if (color !== 'transparent' && !/,\s*0\)$/.test(color)) return hex(color);
    }
    return hexOf('--paper');
  }
  function headingColor(key) {
    if (live.has(key)) return live.get(key);
    for (const w of [target()?.win, ...wins()].filter(Boolean)) {
      const h = [...w.document.querySelectorAll('#stage .slide:not(.cover):not(.section-slide) > h2')]
        .find(h => w.getComputedStyle(h).display !== 'none');
      if (!h) continue;
      const style = w.getComputedStyle(h);
      if (key === '--header-ink') return hex(style.color);
      // グラデーションは単色に置き換えず、その基準色を表示する。
      if (style.backgroundImage !== 'none') return hexOf(key);
      for (let el = h; el; el = el.parentElement) {
        const color = w.getComputedStyle(el).backgroundColor;
        if (color !== 'transparent' && !/,\s*0\)$/.test(color)) return hex(color);
      }
      return hexOf('--paper');
    }
    return hexOf(key);
  }
  async function openFill(key) {
    view.querySelector('.tv-inline-color')?.remove(); pendingFill = key;
    await show(key === FILL ? '--header' : key);
    if (pendingFill === key && target()?.win) { fillEditor.open(key); pendingFill = null; }
  }

  // ------------------------------------------------------------ 欄
  function optionField(key, title, values, names = values) {
    const label = document.createElement('label'); label.dataset.key = key;
    const text = document.createElement('span'); text.textContent = title;
    const select = document.createElement('select'); select.name = key; select.setAttribute('aria-label', title);
    values.forEach((v, i) => select.add(new Option(names[i], v)));
    select.onchange = () => saveField(key, select.value);
    label.append(text, select); return label;
  }
  function openColor(key, input) {
    view.querySelector('.tv-inline-color')?.remove();
    fillEditor.close();
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
      if (key === '--paper' || key === '--mark-line' || FILLS.includes(key) || key.startsWith('--block-') || key.startsWith('--heading-')) continue;
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
    for (const [field, key] of [['--header', FILL]]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ibtn tv-fill-open';
      tip(button, S.themes.gradient.title);
      button.innerHTML = '<i class="tv-fill-icon" aria-hidden="true"></i>';
      const caption = document.createElement('span'); caption.textContent = S.themes.controls.gradient; button.append(caption);
      button.addEventListener('pointerdown', e => e.stopPropagation());
      button.onclick = e => { e.preventDefault(); e.stopPropagation(); openFill(key); };
      colors.querySelector(`[data-key="${field}"]`).append(button);
    }
    const heading = colors.querySelector('[data-key="--header"]');
    const group = document.createElement('div'); group.className = 'tv-heading-colors';
    heading.before(group); group.append(heading, colors.querySelector('[data-key="--header-ink"]'));
    const mode = document.createElement('div'); mode.className = 'tv-heading-modes';
    mode.setAttribute('role', 'group'); mode.setAttribute('aria-label', S.themes.heading.mode);
    ['theme', 'fill', 'rule'].forEach((value, i) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.headingMode = value;
      tip(button, S.themes.heading.modes[i]);
      const sample = document.createElement('i'); sample.className = 'tv-heading-example'; sample.setAttribute('aria-hidden', 'true');
      sample.textContent = S.themes.controls.heading;
      const caption = document.createElement('span'); caption.textContent = S.themes.heading.modes[i];
      button.append(sample, caption);
      button.onclick = () => { view.querySelector('.tv-inline-color')?.remove(); saveField('--heading-mode', value); fill(); show('--header-ink'); };
      mode.append(button);
    });
    group.prepend(mode);
    const rules = document.createElement('div'); rules.className = 'tv-heading-rule';
    rules.append(colors.querySelector('[data-key="--rule"]'));
    rules.append(optionField('--heading-rule-style', S.decoration.style, ['solid','dashed','dotted','double'], ['solid','dashed','dotted','double'].map(k => S.decoration[k])), optionField('--heading-rule-width', S.themes.heading.width, ['1px','2px','3px','4px','5px','6px']), optionField('--heading-rule-inset', S.themes.heading.length, ['0px','44px'], S.themes.heading.lengths));
    group.append(rules);
    function section(title, nodes) {
      const section = document.createElement('section'); section.className = 'tv-section';
      const heading = document.createElement('h3'); heading.textContent = title;
      section.append(heading, ...nodes); colors.append(section); return section;
    }
    // 見出しは下に置き、開閉できるようにする（スライドで選んだときは開く。テーマを替えても開閉は保つ）
    function toggle(title, nodes) {
      const details = document.createElement('details'); details.className = 'tv-section-toggle';
      details.open = openToggles.has(title);
      details.ontoggle = () => { if (details.open) openToggles.add(title); else openToggles.delete(title); };
      const summary = document.createElement('summary'); summary.textContent = title;
      const body = document.createElement('div'); body.className = 'tv-section';
      body.append(...nodes); details.append(summary, body); colors.append(details); return details;
    }
    section(S.themes.controls.text, ['--ink', '--muted', '--accent', '--link'].map(k => colors.querySelector(`[data-key="${k}"]`)));
    section(S.themes.controls.emphasis, ['--good', '--warn', '--mark', '--mark-ink', ...Object.keys(CONTENT)].map(k => colors.querySelector(`[data-key="${k}"]`)));
    toggle(S.themes.controls.heading, [group]);
    fill();
  }
  function fill() {
    const mode = live.get('--heading-mode') ?? vars['--heading-mode'];
    const rules = view.querySelector('.tv-heading-rule');
    if (rules) rules.hidden = mode !== 'rule';
    view.querySelectorAll('[data-heading-mode]').forEach(b => { b.disabled = locked; b.setAttribute('aria-pressed', String(b.dataset.headingMode === mode)); });
    const headingField = view.querySelector('[data-key="--header"]');
    if (headingField) headingField.hidden = mode === 'rule';
    fillEditor.refresh();
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
  const fillEditor = gradientEditor({
    root: ctx.root, host: view, target, read: key => live.get(key) ?? vars[key],
    color: key => live.get(key) ?? hexOf(key),
    palette: () => ['--paper', '--ink', '--accent', '--header', '--good', '--warn'].map(hexOf),
    preview: previewValue,
    save: saveField, locked: () => locked,
  });
  async function load() {
    const want = ctx.structure?.meta.theme || 'default', asked = edits;
    try {
      const t = await api(`/api/themes/${encodeURIComponent(want)}`);
      if (!alive || (name === want && (edits !== asked || pending.size))) return;
      if (!fonts.length) await loadThemes(!order.length);
      const changed = name !== want;
      name = want; locked = t.locked; version = t.version; vars = t.vars; modified = t.modified;
      if (changed) { fillEditor.close(); live.clear(); focusKey = null; matches = null; mode = 'real'; clearMarks(); sample?.load(); }
      build(); paint(); if (themes.length) drawThemes();
      if (shown) sync();
    } catch (e) { toast(e.message); }
  }

  // 色の欄を選びつつ、実スライドのクリックは通常の編集にも渡す。
  const clickWindows = new Set();
  function attachClicks(w) {
    if (!w || clickWindows.has(w)) return;
    clickWindows.add(w);
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown']) w.addEventListener(type, themeClick, true);
  }
  function themeClick(e) {
    if (!shown) return;
    if (fillEditor.isOpen()) {
      if (e.type === 'keydown') fillEditor.keydown(e);
      e.preventDefault(); e.stopImmediatePropagation();
      return;
    }
    if (e.type === 'keydown') return;
    const el = e.target.closest?.('#stage > .slide.active *') || e.target.closest?.('#stage > .slide.active');
    if (!el) { if (e.type === 'click') fillEditor.close(); return; }
    if (sampleOn()) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (e.type !== 'click') return;
    if (el.closest('[contenteditable="true"]')) return;
    const w = e.currentTarget, slide = el.closest('.slide');
    const keys = Object.keys(vars).filter(k => !k.startsWith('--font-') && !FILLS.includes(k) && k !== '--mark-line' && k !== '--paper');
    // 背景つき文字は背景色を入口にし、その隣で文字色も編集できる。
    keys.sort((a, b) => (a === '--mark' ? -1 : b === '--mark' ? 1 : 0));
    const candidates = keys.map(key => ({ key, parts: partsOf(w, slide, key) }));
    let chosen, node;
    for (let at = el; at && !chosen; at = at === slide ? null : at.parentElement) {
      for (const c of candidates) {
        node = c.parts.find(n => (n.nodeType === 3 ? n.parentElement : n.host || n) === at);
        if (node) { chosen = c.key; break; }
      }
    }
    if (el.closest('h2')) { chosen = '--header'; node = el.closest('h2'); }
    else if (el.closest('.math, math')) { chosen = '--math-ink'; node = el.closest('.math, math'); }
    else if (el.closest('th')) { chosen = '--table-header-bg'; node = el.closest('th'); }
    else if (el.closest('td')) { chosen = '--table-ink'; node = el.closest('td'); }
    else if (el === slide) return;
    if (!chosen) return;
    ++selection; clearMarks(); focusKey = chosen;
    // 押したページ・段・要素を維持する（同色の最初の要素へ飛ばさない）。
    matches = null; filter(); fill();
    const field = reveal(chosen);
    field?.scrollIntoView({ block: 'nearest' });
    marks = [{ n: node || el, w, page: (node || el) === slide }]; markedAt = target().index; place();
    if (chosen === '--header' && sampleOn()) fillEditor.open(FILL);
  }
  attachClicks(ctx.preview.win);

  // ------------------------------------------------------------ どこかを示す
  function clearMarks() {
    cancelAnimationFrame(markFrame); markFrame = 0;
    marks = []; markedAt = null;
    for (const w of wins()) w.document.getElementById('slide-studio-theme-marks')?.remove();
  }
  // 閉じた［見出し］の中の欄を選んだら開く
  function reveal(key) {
    const field = view.querySelector(`label[data-key="${key === BGS[0] ? '--paper' : key === FILL ? '--header' : key}"]`);
    const details = field?.closest('details.tv-section-toggle');
    if (details) details.open = true;
    return field;
  }
  async function show(key) {
    focusKey = key;
    view.querySelectorAll('label[data-key]').forEach(l => l.classList.toggle('on', l.dataset.key === key));
    reveal(key);
    const ticket = ++selection;
    if (!shown || !ctx.preview.win) return;
    clearMarks();
    const real = ctx.preview.win;
    matches = [...real.document.querySelectorAll('#stage > .slide')].flatMap((slide, i) => (KIND[key] ? KIND[key](slide) : ['--header', '--header-ink'].includes(key) ? [...slide.querySelectorAll('h2')].some(h => real.getComputedStyle(h).display !== 'none') : partsOf(real, slide, key).length) ? [i] : []);
    mode = matches.length ? 'real' : 'sample';
    sync();
    const p = target(); if (!p?.win) return;
    if (p === ctx.preview && !matches.includes(p.index)) await p.go(matches[0], 0);
    if (ticket !== selection || !shown) return;
    const w = p.win, slides = [...w.document.querySelectorAll('#stage > .slide')];
    if (p === sample) {
      // 決めたページにその変数が出ていなければ、出ているページへ（ハイライトなどは出したページでしか色が付かないので、先に移る）
      const pref = KIND[key] ? Math.max(0, slides.findIndex(KIND[key])) : key in PAGE ? PAGE[key] ?? p.index : 1;
      if (pref !== p.index) await p.go(pref, 0);
      if (focusKey !== key || ticket !== selection || !shown) return;
      if (!KIND[key] && !partsOf(w, slides[pref], key).length) {
        const i = [...slides.keys()].find(i => i !== pref && partsOf(w, slides[i], key).length);
        if (i == null) { clearMarks(); toast(T.nowhere(S.themes.vars[key])); return; }
        await p.go(i, 0);
      }
    }
    if (focusKey !== key || ticket !== selection || !shown) return;
    const slide = w.document.querySelector('#stage > .slide.active');
    clearMarks();
    if (!slide) return;
    // 背景の種類はページそのものなので囲まない
    marks = KIND[key] ? [] : partsOf(w, slide, key).slice(0, 1).map(n => ({ n, w, page: n === slide })); markedAt = p.index;
    if (!marks.length && !KIND[key]) toast(T.unused(S.themes.vars[key]));
    place();
  }
  function place(resize = true) {
    const w = marks[0]?.w; if (!w) return;
    // 外枠の ResizeObserver と順序が前後しても、最新の縮尺で囲みを測る。
    if (resize) w.deck?.resize();
    let layer = w.document.getElementById('slide-studio-theme-marks');
    if (!layer) {
      layer = w.document.createElement('div'); layer.id = 'slide-studio-theme-marks';
      layer.innerHTML = `<style>#slide-studio-theme-marks>i{position:fixed;pointer-events:none;z-index:2147483647;border:1px solid #748baa99;border-radius:3px}</style>`;
      w.document.body.append(layer);
    }
    let placed = false;
    for (const { n, page } of marks) {
      let rects;
      if (n.nodeType === 3) { const r = w.document.createRange(); r.selectNodeContents(n); rects = [...r.getClientRects()]; }
      else if (n.which) rects = [pseudoRect(w, n.host, n.which)];
      else rects = [n.getBoundingClientRect()];
      for (const r of rects) {
        if (!r.width || !r.height) continue;
        const pad = page ? -3 : 3, i = layer.querySelector('i') || w.document.createElement('i');
        const geometry = [r.left - pad, r.top - pad, r.width + pad * 2, r.height + pad * 2].join(',');
        if (i.dataset.geometry !== geometry) {
          Object.assign(i.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
          i.dataset.geometry = geometry;
        }
        if (!i.isConnected) layer.append(i);
        placed = true;
        break;
      }
    }
    if (!placed) layer.querySelector('i')?.remove();
    // フォント・図の遅延読み込みなど、外枠のサイズが変わらない再配置にも追従する。
    // 強調は1か所だけ測り、位置が変わったときだけ DOM を更新する。
    if (!markFrame) markFrame = requestAnimationFrame(() => { markFrame = 0; if (alive && marks.length) place(false); });
  }
  // 見本の大きさが変わったら囲みも合わせる
  const fit = new ResizeObserver(() => { if (marks.length) place(); });
  fit.observe(ctx.root.querySelector('#slideBox'));
  fit.observe(box);

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
    previewLoaded() { attachClicks(ctx.preview.win); paint(); if (name) fill(); if (focusKey && shown && matches !== null) show(focusKey); },
    // 欄の色は描いた見出しから読む（default の見出しはグラデーションなど）。テーマの CSS が替わったら読み直す
    previewThemed() { if (name) fill(); },
    stripRendered() { filter(); },
    slideChanged(d) { if (shown && focusKey && !KIND[focusKey] && !sampleOn() && d.index !== markedAt) {
      clearMarks(); const w = ctx.preview.win, slide = w.document.querySelector('#stage > .slide.active');
      marks = partsOf(w, slide, focusKey).slice(0, 1).map(n => ({ n, w, page: n === slide })); markedAt = d.index; place();
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
    destroy() { for (const w of wins()) w.document.documentElement.classList.remove('slide-studio-theme-preview'); fillEditor.destroy(); alive = false; for (const w of clickWindows) for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown']) w.removeEventListener(type, themeClick, true); clickWindows.clear(); clearMarks(); fit.disconnect(); sample?.destroy(); bar.remove(); box.remove(); view.remove(); },
  };
}
