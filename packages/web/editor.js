// 発表の編集画面（設計書 §10.2）：上のバー・原稿・スライド・チャット。
// 正本は slides.qmd。GUI は保存の版（sha256）を持ち、違えば 409 として扱う（§6.4）。
import { $, api, esc, onEvent, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';
import { copyWithFallback } from './clipboard.js';
import { QmdEditor } from './qmd-editor.js';
import { makeQmdBlocks } from './qmd-blocks.js';
import { makeBlocks } from './blocks.js';
import { makeOutput } from './output.js';
import { makeChecks, issueMessage } from './checks.js';
import { makePresent } from './present.js';
import { makeChat } from './chat.js';
import { makeBibliography } from './bibliography.js';
import { makeAssets } from './assets.js';
import { makeMaterials } from './materials.js';
import { makeMemo } from './memo.js';
import { makeLeftTabs } from './left-tabs.js';
import { makeInsert } from './insert.js';
import { makeLayoutLint } from './layout-lint.js';
import { makePageStrip } from './page-strip.js';
import { makePdfStep } from './pdf-step.js';
import { Preview } from './preview.js';
import { navigate } from './app.js';
import { makeThemes } from './themes.js';
import { makeThemeTab } from './theme-tab.js';
import { makeHistory } from './history.js';
import { makeTocSettings } from './toc-settings.js';

const SAVE_DELAY = 120;
// 編集画面に機能を登録する（下書きはチャットの後：開いたときにチャットを下書きのチャットにするため）
export const plugins = [makeThemes, makeTocSettings, makeQmdBlocks, makeBlocks, makeOutput, makePresent, makeChat, makeMemo, makeAssets, makeMaterials, makeThemeTab, makeBibliography, makeLeftTabs, makeInsert, makeLayoutLint, makePageStrip, makePdfStep, makeChecks];

export function mountEditor(root, deck) {
  let alive = true;
  document.title = `${deck} · Slide Studio`;
  const pref = k => { try { return localStorage.getItem('slide-studio.' + k); } catch { return null; } };
  const setPref = (k, v) => { try { localStorage.setItem('slide-studio.' + k, v); } catch { /* 保存できなくても動く */ } };
  document.body.className = '';
  const ew = pref('editorW'); if (ew) document.documentElement.style.setProperty('--editor-w', ew);
  const cw = pref('chatW'); if (cw) document.documentElement.style.setProperty('--chat-w', cw);
  root.innerHTML = `
  <div class="app editing">
    <header class="bar">
      <a class="ibtn" href="/" data-nav title="${S.home}" aria-label="${S.home}">${svg('back')}</a>
      <button class="ibtn" id="editorToggle"></button>
      <h1 id="deckTitle">${esc(deck)}</h1>
      <span class="status" id="status" data-tone="busy">${S.status.loading}</span>
      <span class="grow"></span>
      <button class="ibtn" id="undo" data-tip="${S.undo}" data-keys="⌘ Z" aria-label="${S.undo}">${svg('undo')}</button>
      <button class="ibtn" id="redo" data-tip="${S.redo}" data-keys="⇧ ⌘ Z" aria-label="${S.redo}">${svg('redo')}</button>
      <span id="barExtra"></span>
      <button class="ibtn" id="chatToggle"></button>
    </header>
    <main class="work">
      <section class="panel editor" id="editor" aria-label="原稿">
        <div class="panel-head"><span class="grow"></span>
          <button class="ibtn" id="foldToggle"></button>
          <div class="seg icons" role="group" aria-label="${S.qmdView}">
            <button id="blocksMode" aria-pressed="true" title="${S.hideSyntax}" aria-label="${S.hideSyntax}">${svg('blocks')}</button>
            <button id="syntaxToggle" aria-pressed="false" title="${S.showSyntax}" aria-label="${S.showSyntax}">${svg('code')}</button>
          </div>
        </div>
        <div id="edBanner"></div>
        <div class="ed-scroll" id="qscroll"><div id="qblocks"></div><div id="qhost" hidden></div></div>
        <footer class="ed-status" id="qstatus" aria-live="polite"></footer>
      </section>
      <div class="splitter" id="splitter" role="separator" aria-orientation="vertical" tabindex="0" data-tip="${S.splitEditor}" aria-label="${S.splitEditor}"></div>
      <section class="stage" id="stage">
        <div class="viewport" id="viewport"><div class="slide-box" id="slideBox"></div></div>
        <div class="stepbar">
          <div class="step-side" id="stepSide"></div>
          <div class="stepper"><button class="ibtn" id="stepPrev" title="${S.prevStep}" aria-label="${S.prevStep}">${svg('chevL')}</button><span class="count"><span class="page-count" id="pageCount"></span><span class="step-count" id="stepCount" hidden></span></span><label class="pdf-step off" id="pdfStepWrap" data-tip="${S.pdfStep}"><input type="checkbox" id="pdfStep" aria-label="${S.pdfStep}"></label><button class="ibtn" id="stepNext" title="${S.nextStep}" aria-label="${S.nextStep}">${svg('chevR')}</button></div>
          <div class="strip-tools" id="stripTools"></div>
        </div>
        <div class="strip-grip" id="stripGrip" role="separator" aria-orientation="horizontal" tabindex="0"></div>
        <nav class="pagestrip" id="pagestrip" aria-label="ページ"></nav>
      </section>
      <footer class="hint"><div class="msg" id="hintMsg"></div><div class="keys" id="hintKeys"></div></footer>
    </main>
    <div class="splitter" id="chatSplitter" role="separator" aria-orientation="vertical" tabindex="0" data-tip="${S.splitChat}" aria-label="${S.splitChat}"></div>
    <section class="panel" id="chat" aria-label="${S.chat}"></section>
  </div>`;

  const ctx = {
    deck, root, version: null, saved: '', text: '', structure: null, render: null, check: null,
    dirty: false, saving: null, conflict: null, allLocked: false, lock: {}, renderOk: true, rendering: false,
    history: [], future: [], lastPush: 0, plugins: [],
  };
  // locked：今いるページか選んでいる図を AI が編集中（全体への指示なら常に）。保存の可否は allLocked とサーバーで決める
  Object.defineProperty(ctx, 'locked', { get: () => ctx.allLocked || lockedPages().has(ctx.editor?.page) || (ctx.lock.figures || []).includes(ctx.blocks?.figure) });
  function lockedPages() {
    const pages = ctx.structure?.pages || [];
    return new Set((ctx.lock.pages || []).map(l => {
      if (!l.key.startsWith('@')) return pages.find(p => p.id === l.key)?.index;
      const i = +l.key.slice(1), same = pages.filter(p => !p.id && p.title === l.title);
      return same.length ? same.reduce((a, b) => Math.abs(b.index - i) < Math.abs(a.index - i) ? b : a).index : pages[i]?.index;
    }).filter(i => i != null));
  }
  function lockNames() {
    const slide = i => ctx.preview?.slideOfPage(i);
    const pages = [...lockedPages()].map(i => (slide(i) >= 0 ? `p${slide(i) + 1}` : ctx.structure.pages[i].title));
    const names = [...pages, ...(ctx.lock.figures || []).map(r => r.split('/').pop())];
    return names.length > 3 ? `${names.slice(0, 3).join('・')} ほか${names.length - 3}件` : names.join('・');
  }
  function paintLock() {
    const pages = lockedPages(), figs = ctx.lock.figures || [], here = pages.has(ctx.editor?.page);
    $('.app', root).classList.toggle('ai-locked', !!ctx.allLocked);
    $('#stage', root).classList.toggle('lock-here', here);
    $('#editor', root).classList.toggle('lock-here', here);
    root.querySelectorAll('#qblocks .page[data-page]').forEach(el => el.classList.toggle('ai-lock', pages.has(+el.dataset.page)));
    root.querySelectorAll('#qblocks .chip[data-fig]').forEach(c => c.closest('.card')?.classList.toggle('ai-lock', figs.includes(c.dataset.fig)));
    root.querySelectorAll('#pagestrip button[data-index]').forEach(b => b.classList.toggle('ai-lock', pages.has(ctx.preview?.pageOfSlide(+b.dataset.index))));
    const color = getComputedStyle(document.documentElement).getPropertyValue('--locked').trim();
    const client = ctx.preview?.client;
    if (client) client.editLocks(figs, color).catch(() => {});
  }
  ctx.paintLock = paintLock;
  const statusEl = $('#status', root);
  statusEl.addEventListener('keydown', e => {
    if (statusEl.onclick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); statusEl.onclick(e); }
  });

  // ------------------------------------------------------------ 状態の表示（§6.5）
  function showStatus() {
    if (!alive) return;
    let text, tone, act = null;
    const partial = !ctx.allLocked && lockNames();
    if (ctx.allLocked) [text, tone] = [S.status.ai(ctx.aiTabs || 1), 'ai'];
    else if (ctx.conflict) [text, tone] = [S.status.conflict, 'error'];
    else if (partial) [text, tone] = [S.status.aiPart(ctx.aiTabs || 1, partial), ctx.lock.pages?.length ? 'ai' : 'ai-soft'];
    else if (ctx.dirty || ctx.timer || ctx.blocks?.pending) [text, tone] = [S.status.pending, 'busy'];
    else if (ctx.saving) [text, tone] = [S.status.saving, 'busy'];
    else if (ctx.rendering) [text, tone] = [S.status.rendering, 'busy'];
    else if (!ctx.renderOk) [text, tone] = [S.status.stale, 'error'];
    else if (ctx.checkStatus) [text, tone, act] = ctx.checkStatus;
    else [text, tone] = [S.status.saved, 'ok'];
    statusEl.textContent = text; statusEl.dataset.tone = tone;
    paintLock();
    ctx.plugins.forEach(p => p.statusChanged?.());
    // 検査で問題があれば、押すと問題の一覧
    statusEl.onclick = act; statusEl.classList.toggle('act', !!act);
    if (act) { statusEl.tabIndex = 0; statusEl.setAttribute('role', 'button'); tip(statusEl, S.checks.list); statusEl.setAttribute('aria-label', `${text}・${S.checks.list}`); }
    else { statusEl.removeAttribute('tabindex'); statusEl.removeAttribute('role'); statusEl.removeAttribute('aria-label'); delete statusEl.dataset.tip; }
    $('#undo', root).disabled = ctx.history.length === 0 || ctx.locked || ctx.historyBusy;
    $('#redo', root).disabled = ctx.future.length === 0 || ctx.locked || ctx.historyBusy;
  }
  ctx.showStatus = showStatus;
  // 下のヒントの文（選んでいるもの・できる操作）
  ctx.hint = text => { if (alive) $('#hintMsg', root).textContent = text; };
  // 下のヒントのキー操作（null で既定に戻す）
  ctx.keys = list => { if (alive) $('#hintKeys', root).innerHTML = (list || S.keys).map(([k, v]) => `<span><kbd>${esc(k)}</kbd>${esc(v)}</span>`).join(''); };
  ctx.keys(null);

  // ------------------------------------------------------------ 原稿
  const editor = new QmdEditor($('#qhost', root), {
    onInput: text => changed(text, { typing: true }),
    onFold: () => syncFold(),
    onCaret: (page) => { if (!ctx.fromSlide) followPage(page); ctx.plugins.forEach(p => p.caret?.()); ctx.showStatus(); },
    onLocked: () => toast(S.frontLocked),
  });
  ctx.editor = editor;

  // 原稿の入力は1秒ごとにまとめ、ほかの操作と同じ履歴に積む。
  function pushHistory(prevText, typing) {
    const now = Date.now();
    ctx.future = [];
    if (typing && now - ctx.lastPush < 1000 && ctx.history.length) { ctx.lastPush = now; return; }
    ctx.recordHistory({ text: prevText, caret: editor.caretOffset() });
    ctx.lastPush = typing ? now : 0;
  }
  // history：false なら履歴に積まない（スライドでの1回の編集を ⌘Z の1回分にまとめる）
  function changed(text, { typing = false, caret, history = true } = {}) {
    if (text === ctx.text) return;
    if (ctx.locked) { editor.setText(ctx.text); toast(S.locked); return; }
    if (history) pushHistory(ctx.text, typing); else ctx.future = [];
    ctx.text = text;
    if (!typing) editor.setText(text, { caret });
    scheduleSave();
    ctx.plugins.forEach(p => p.textChanged?.(text));
  }
  // GUI の操作（ブロックの移動など）から原稿を変える
  ctx.setText = (text, opts = {}) => changed(text, opts);
  const { undo, redo } = makeHistory(ctx,
    () => ({ text: ctx.text, caret: editor.caretOffset() }), h => {
    ctx.text = h.text; editor.setText(h.text, { caret: h.caret }); scheduleSave();
    ctx.plugins.forEach(p => p.textChanged?.(h.text));
  });
  ctx.undo = undo; ctx.redo = redo;
  ctx.applyStyle = async (vars, text) => {
    if (ctx.locked || !await ctx.flush()) return;
    const before = ctx.text, caret = editor.caretOffset();
    const put = async body => {
      ctx.styleSavingText = body.text;
      ctx.styleSaving = (async () => {
        const r = await api(`/api/deck/${encodeURIComponent(deck)}/style`, { method: 'PUT', body });
        ctx.version = r.version; ctx.saved = r.text; ctx.text = r.text;
        editor.setText(r.text, { caret });
        ctx.plugins.forEach(p => p.textChanged?.(r.text));
        return r;
      })();
      try { return await ctx.styleSaving; }
      finally { ctx.styleSaving = null; ctx.styleSavingText = null; }
    };
    const r = await put({ vars, text, base: ctx.version });
    if (r.before === r.css && before === r.text) return;
    ctx.recordHistory({
      source: true,
      undo: () => put({ css: r.before, css_base: r.css, text: before, base: ctx.version }),
      redo: () => put({ css: r.css, css_base: r.before, text: r.text, base: ctx.version }),
    });
  };

  // ------------------------------------------------------------ 保存（最後の操作から 120ms 後）
  function scheduleSave() {
    ctx.dirty = true;
    clearTimeout(ctx.timer);
    ctx.timer = setTimeout(() => { ctx.timer = 0; save(); }, SAVE_DELAY);
    showStatus();
  }
  // 保存待ちを直ちに保存し、版が一致したら true（AI に送る前に使う：§6.4）
  ctx.flush = async () => {
    const results = await Promise.all(ctx.plugins.map(p => p.flush?.()));
    if (ctx.styleSaving) await ctx.styleSaving;
    clearTimeout(ctx.timer); ctx.timer = 0;
    if (ctx.saving) await ctx.saving;
    if (ctx.dirty) await save();
    return results.every(result => result !== false) && !ctx.conflict && !ctx.dirty;
  };
  root.querySelector('a[data-nav]').onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    if (await ctx.flush()) navigate('/');
    else toast(S.saveFirst);
  };
  const beforeUnload = e => {
    if (ctx.dirty || ctx.saving || ctx.styleSaving || ctx.conflict || ctx.blocks?.pending) { e.preventDefault(); e.returnValue = ''; }
  };
  addEventListener('beforeunload', beforeUnload);
  async function save() {
    if (ctx.saving) return ctx.saving;
    if (ctx.conflict || ctx.allLocked || !ctx.dirty) return;
    const text = ctx.text;
    ctx.dirty = false;
    ctx.savingText = text;
    ctx.saving = (async () => {
      try {
        const r = await api(`/api/deck/${encodeURIComponent(deck)}/source`, { method: 'PUT', body: { text, base: ctx.version, ...(ctx.mergeable ? { base_text: ctx.saved } : {}) } });
        if (r.text != null && r.text !== text) {
          // AI の変更と合流した
          dropTextHistory();
          if (ctx.text === text) acceptText(r.text, r.version);
          else { ctx.saved = text; ctx.version = 'rebase'; ctx.dirty = true; }
        } else {
          ctx.version = r.version; ctx.saved = text;
          if (ctx.text !== text) ctx.dirty = true;
          else if (!lockNames()) ctx.mergeable = false;
        }
      } catch (e) {
        if (e.status === 409) showConflict(e.data);
        else if (e.status === 423 && e.data?.partial) { toast(S.locked); ctx.dirty = false; applyServerText(await api(`/api/deck/${encodeURIComponent(deck)}`)); }
        else if (e.status === 423) { ctx.allLocked = true; ctx.dirty = true; }
        else { ctx.dirty = true; toast(e.message); }
      }
    })();
    showStatus();
    await ctx.saving;
    ctx.saving = null; ctx.savingText = null;
    ctx.plugins.forEach(p => p.saved?.());
    if (ctx.dirty && !ctx.conflict && !ctx.timer && !ctx.allLocked) scheduleSave();
    showStatus();
  }

  // ------------------------------------------------------------ 外での変更（§6.4）
  function showConflict(data) {
    ctx.conflict = data;
    if (!alive) return;
    const b = $('#edBanner', root);
    b.innerHTML = `<div class="banner"><div>${S.conflictText}</div><div class="row">
      <button class="btn sm" data-act="discard">${S.reloadDiscard}</button>
      <button class="btn sm primary" data-act="copy">${S.reloadCopy}</button></div></div>`;
    b.querySelector('[data-act=discard]').onclick = () => reload(false);
    b.querySelector('[data-act=copy]').onclick = () => reload(true);
    showStatus();
  }
  async function reload(copy) {
    if (copy && !await copyWithFallback(ctx.text, $('#edBanner', root))) return;
    const d = await api(`/api/deck/${encodeURIComponent(deck)}`);
    if (!alive) return;
    ctx.conflict = null; ctx.dirty = false; clearTimeout(ctx.timer); ctx.timer = 0;
    $('#edBanner', root).textContent = '';
    applyServerText(d);
  }
  function dropTextHistory() {
    ctx.history = ctx.history.filter(h => !('text' in h) && !h.source);
    ctx.future = []; ctx.lastPush = 0;
  }
  // AI が別の場所を書いても、カーソルは同じ文字の位置に残す
  function movedCaret(before, after) {
    const c = editor.caretOffset();
    return before.slice(0, c) === after.slice(0, c) ? c : Math.max(0, after.length - (before.length - c));
  }
  function acceptText(text, version) {
    const before = ctx.text, caret = movedCaret(before, text);
    ctx.version = version; ctx.saved = text; ctx.text = text;
    editor.setText(text, { caret });
    ctx.plugins.forEach(p => p.textRebased?.(before, text));
    ctx.plugins.forEach(p => p.textChanged?.(text));
  }
  function applyServerText(d) {
    // 外部変更・AI の結果は GUI の履歴に入れない。古い原稿を復元しない。
    if (ctx.text && d.text !== ctx.text) dropTextHistory();
    const before = ctx.text, caret = ctx.mergeable ? movedCaret(before, d.text) : undefined;
    ctx.version = d.version; ctx.saved = d.text; ctx.text = d.text; ctx.structure = d.structure;
    editor.setText(d.text, { caret });
    ctx.plugins.forEach(p => p.textRebased?.(before, d.text));
    showTitle();
    showStatus();
    ctx.plugins.forEach(p => p.textChanged?.(d.text));
  }
  let externalGeneration = 0;
  async function externalChange() {
    const ticket = ++externalGeneration;
    const d = await api(`/api/deck/${encodeURIComponent(deck)}`);
    if (!alive) return;
    if (ticket !== externalGeneration) return;
    if (d.version === ctx.version || (ctx.saving && d.text === ctx.savingText) || (ctx.styleSaving && d.text === ctx.styleSavingText)) return;
    if (d.text === ctx.text) { ctx.version = d.version; ctx.saved = d.text; ctx.dirty = false; showStatus(); return; }
    // 入力が残っている（保存待ち・保存中）なら上書きせず競合を出す
    if (ctx.dirty || ctx.timer || ctx.saving || ctx.text !== ctx.saved) {
      if (!ctx.mergeable) { showConflict(d); return; }
      // AI が別のページを書いた。書きかけは保存のときに合流する
      if (!ctx.saving) { clearTimeout(ctx.timer); ctx.timer = 0; ctx.dirty = true; save(); }
      return;
    }
    applyServerText(d);
  }
  ctx.reloadText = externalChange;

  // ------------------------------------------------------------ スライド
  const preview = new Preview($('#slideBox', root), deck, {
    onChange: d => { syncFromSlide(d); updateStepbar(d); ctx.plugins.forEach(p => p.slideChanged?.(d)); ctx.showStatus(); },
    onLoad: w => { renderStrip(); ctx.plugins.forEach(p => p.previewLoaded?.(w)); paintLock(); },
  });
  ctx.preview = preview;
  function followPage(page) {
    const i = preview.slideOfPage(page);
    if (i >= 0 && i !== preview.index) { ctx.fromEditor = true; preview.go(i, 0); setTimeout(() => { ctx.fromEditor = false; }, 0); }
  }
  function syncFromSlide(d) {
    markStrip(d.index);
    if (ctx.fromEditor) return;
    const page = preview.pageOfSlide(d.index);
    if (page == null || page === editor.page) return;
    ctx.fromSlide = true;
    // ブロック表示のときは原稿欄のスクロールをブロック表示に任せる
    editor.revealPage(page, rawMode ? $('#qscroll', root) : null);
    ctx.fromSlide = false;
  }
  function updateStepbar(d) {
    if (!alive) return;
    const n = (d.maxStep ?? preview.api?.maxStep() ?? 0) + 1;
    $('#pageCount', root).textContent = S.pageNumber(d.index + 1);
    const stepCount = $('#stepCount', root);
    stepCount.hidden = n <= 1;
    stepCount.textContent = n > 1 ? S.step(d.step + 1, n) : '';
    $('#stepPrev', root).disabled = !(d.step > 0 || d.index > 0);
    $('#stepNext', root).disabled = !(d.step < n - 1 || d.index < preview.slides.length - 1);
  }
  function renderStrip() {
    if (!alive) return;
    const strip = $('#pagestrip', root);
    // 撮影済みの画像を外すと、無関係なページまで読み直しでちらつく。
    // 画像の配列と同じページ番号でボタンを再利用する。
    const buttons = [...strip.querySelectorAll('button')];
    preview.slides.forEach((s, i) => {
      const b = buttons[i] || document.createElement('button');
      if (!buttons[i]) {
        b.innerHTML = '<span class="t"></span><span class="num"></span>';
        strip.append(b);
      }
      b.classList.toggle('chapter', s.chapter);
      const title = b.querySelector('.t'), num = b.querySelector('.num');
      if (title.textContent !== s.title) title.textContent = s.title;
      if (num.textContent !== String(i + 1)) num.textContent = i + 1;
      b.dataset.tip = S.gotoSlide(i + 1);
      // 縮小画像の表示位置にかかわらず、ページの最初から開く。
      b.onclick = () => preview.go(i);
      b.dataset.index = i;
    });
    buttons.slice(preview.slides.length).forEach(b => b.remove());
    markStrip(preview.index);
    ctx.plugins.forEach(p => p.stripRendered?.(strip));
    paintLock();
    ctx.plugins.forEach(p => p.statusChanged?.());
  }
  function markStrip(index) {
    $('#pagestrip', root).querySelectorAll('button').forEach((b, i) => {
      b.setAttribute('aria-current', String(i === index));
      if (i === index) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  ctx.renderStrip = renderStrip;
  $('#stepPrev', root).onclick = () => preview.move(-1);
  $('#stepNext', root).onclick = () => preview.move(1);

  // ------------------------------------------------------------ 変換の結果
  function showRender(ev) {
    if (!alive) return;
    const st = $('#qstatus', root);
    st.textContent = '';
    if (!ev.ok) {
      const d = document.createElement('div'); d.className = 'err'; d.textContent = `${S.renderError}\n${ev.error}`; st.append(d);
    }
    const unsupported = (ev.unsupported || []).map(u => `p${u.page + 1}：${u.message}`);
    for (const w of [...unsupported, ...(ev.warning_issues ? [] : ev.warnings || [])]) {
      const d = document.createElement('div'); d.className = 'warn'; d.textContent = w; st.append(d);
    }
    for (const x of ev.warning_issues || []) {
      const d = document.createElement(x.source_offset != null ? 'button' : 'div');
      d.className = 'warn'; d.textContent = issueMessage(x);
      if (x.source_offset != null) {
        d.type = 'button'; tip(d, S.checks.openSource);
        d.onclick = () => { if (!ctx.dirty && ev.version === ctx.version) ctx.showIssue(x, { version: { qmd: ev.version } }); };
      }
      st.append(d);
    }
    const raw = ctx.structure?.pages?.find(p => p.raw_only);
    if (raw) { const d = document.createElement('div'); d.className = 'warn'; d.textContent = S.rawOnly(raw.index + 1); st.append(d); }
    let badge = $('.stale-badge', root);
    if (!ev.ok && !badge) { badge = document.createElement('div'); badge.className = 'stale-badge'; badge.textContent = S.staleBadge; $('#slideBox', root).append(badge); }
    if (ev.ok) badge?.remove();
  }
  // 上のバーの題名は原稿の front matter から（AI や原稿の編集で変わったら合わせる）
  const showTitle = () => { $('#deckTitle', root).textContent = ctx.structure?.meta?.title || deck; };
  async function refreshStructure() {
    try {
      const text = ctx.text;
      const structure = await api('/api/structure', { method: 'POST', body: { text } });
      if (!alive || text !== ctx.text) return;
      ctx.structure = structure;
      showStatus();
      showTitle();
      editor.rawOnlyFrom = ctx.structure.pages.find(p => p.raw_only)?.start ?? null;
      editor.highlight();
    } catch { /* 次の変換で直る */ }
  }

  const off = onEvent(async ev => {
    if (!alive) return;
    if (ev.deck && ev.deck !== deck) return;
    if (ev.type === 'render-start') { ctx.rendering = true; showStatus(); }
    if (ev.type === 'render') {
      ctx.rendering = false; ctx.renderOk = ev.ok; ctx.render = ev;
      if (ev.ok) {
        // CSS だけ差し替えたときは読み込み直さないので、差し替え後に描いた色を読む機能へ知らせる
        if (ev.theme_only && preview.frame && !preview.pending && preview.client?.snapshot?.hasReferences === false) preview.setTheme(ev.theme, ev.version).then(() => ctx.plugins.forEach(p => p.previewThemed?.()));
        else preview.load(ev.version);
      }
      await refreshStructure();
      if (!alive) return;
      showRender(ev);
      showStatus();
      ctx.plugins.forEach(p => p.rendered?.(ev));
    }
    if (ev.type === 'files' && ev.paths.includes(`decks/${deck}/slides.qmd`)) externalChange();
    ctx.plugins.forEach(p => p.event?.(ev));
  });

  // ------------------------------------------------------------ 上のバーと配置
  function toggles() {
    const eOff = document.body.classList.contains('editor-off'), cOff = document.body.classList.contains('chat-off');
    const e = $('#editorToggle', root), c = $('#chatToggle', root);
    e.innerHTML = svg('panelLeft'); e.setAttribute('aria-pressed', String(!eOff)); tip(e, eOff ? S.editorOff : S.editorOn, eOff ? '' : '0');
    c.innerHTML = svg(cOff ? 'chat' : 'panelRightClose'); tip(c, cOff ? S.chatOff : S.chatOn, cOff ? 'C' : '⌥ C');
  }
  $('#editorToggle', root).onclick = () => {
    document.body.classList.toggle('editor-off'); toggles();
    ctx.plugins.forEach(p => p.editorToggled?.());
  };
  $('#chatToggle', root).onclick = () => { document.body.classList.toggle('chat-off'); toggles(); };
  toggles();
  $('#undo', root).onclick = undo; $('#redo', root).onclick = redo;
  let rawMode = false;
  // 原稿のページの開け閉めは1つのボタン：2ページ以上開いていれば今のページ以外を閉じ、1ページ以下ならすべて開く
  const foldMany = () => (rawMode ? editor.openPages() : ctx.qmdBlocks?.openPages() ?? 0) >= 2;
  function syncFold() {
    if (!alive) return;
    const b = $('#foldToggle', root), many = foldMany();
    b.innerHTML = svg(many ? 'othersFolded' : 'allOpen');
    tip(b, many ? S.foldOthers : S.unfoldAll);
  }
  ctx.foldChanged = syncFold;
  $('#foldToggle', root).onclick = () => {
    const many = foldMany();
    if (rawMode) editor.foldAll(many); else ctx.qmdBlocks?.fold(many);
  };
  syncFold();
  // 今のページの見出しの、原稿欄の上端からの位置
  function pageTop() {
    const el = rawMode ? editor.headEl(editor.page) : ctx.qmdBlocks?.headEl();
    return el ? el.getBoundingClientRect().top - $('#qscroll', root).getBoundingClientRect().top : null;
  }
  // 切り替えても今のページの見出しが同じ高さに残るようにスクロールを合わせる
  function setMode(raw) {
    if (raw === rawMode) return;
    const scroller = $('#qscroll', root), before = pageTop();
    rawMode = raw;
    $('#qhost', root).hidden = !rawMode; $('#qblocks', root).hidden = rawMode;
    $('#syntaxToggle', root).setAttribute('aria-pressed', String(rawMode));
    $('#blocksMode', root).setAttribute('aria-pressed', String(!rawMode));
    if (rawMode) editor.highlight(); else ctx.qmdBlocks?.render();
    syncFold();
    const after = pageTop();
    if (before != null && after != null) scroller.scrollTop += after - before;
    else if (rawMode) editor.revealPage(editor.page, scroller);
    else ctx.qmdBlocks?.reveal();
  }
  $('#syntaxToggle', root).onclick = () => setMode(true);
  ctx.showSourceIssue = x => {
    if (document.body.classList.contains('editor-off')) $('#editorToggle', root).click();
    ctx.leftTabs?.show('qmd');
    setMode(true);
    editor.setCaretOffset(x.source_offset);
    editor.caret();
    editor.revealOffset(x.source_offset, $('#qscroll', root));
  };
  $('#blocksMode', root).onclick = () => setMode(false);
  // 境界のドラッグ（原稿とスライド、作業域とチャット）。dir は右へ動かしたときに広がるなら 1、狭まるなら -1
  function dragWidth(splitter, prop, key, dir, min) {
    splitter.addEventListener('pointerdown', e => {
      splitter.setPointerCapture(e.pointerId); splitter.classList.add('on'); document.body.classList.add('resizing');
      const style = document.documentElement.style, w0 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(prop)), x0 = e.clientX;
      const move = ev => {
        const scroller = $('#qscroll', root), before = pageTop();
        style.setProperty(prop, Math.max(min, Math.min(innerWidth * .6, w0 + dir * (ev.clientX - x0))) + 'px');
        // 折り返しで前のページの高さが変わっても、現在の見出しを表示範囲に保つ。
        const head = rawMode ? editor.headEl(editor.page) : ctx.qmdBlocks?.headEl();
        if (before == null || !head?.getClientRects().length || !scroller.clientHeight) return;
        const top = Math.max(4, Math.min(before, scroller.clientHeight - head.getBoundingClientRect().height - 4));
        scroller.scrollTop += pageTop() - top;
      };
      const up = () => { splitter.removeEventListener('pointermove', move); splitter.classList.remove('on'); document.body.classList.remove('resizing'); setPref(key, getComputedStyle(document.documentElement).getPropertyValue(prop).trim()); };
      splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', up, { once: true });
    });
  }
  dragWidth($('#splitter', root), '--editor-w', 'editorW', 1, 260);
  dragWidth($('#chatSplitter', root), '--chat-w', 'chatW', -1, 300);

  // ------------------------------------------------------------ キー（↑↓ ページ、←→ step、長押しで最初・最後）
  let held = null, holdTimer = 0, long = false;
  const inField = t => t.closest?.('input, textarea, select, [contenteditable="true"]');
  function keydown(e) {
    // [data-undo-keys] の中の欄（テーマの色など）は、欄ではなく共通の履歴を戻す
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !(inField(e.target) && e.target !== editor.ta && !e.target.closest('[data-undo-keys]'))) {
      e.preventDefault();
      e.shiftKey ? redo() : undo(); return;
    }
    if (inField(e.target) || !preview.api) return;
    // ブロックの操作は ⇧・⌥ との組み合わせも使う（§10.4）
    if (ctx.plugins.some(p => p.keydown?.(e))) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); preview.go(preview.index + (e.key === 'ArrowDown' ? 1 : -1)); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); if (held) return; held = e.key; long = false;
      holdTimer = setTimeout(() => { long = true; preview.jump(e.key === 'ArrowRight' ? 1 : -1); }, 450);
    }
  }
  function keyup(e) {
    if (e.key !== held) return;
    clearTimeout(holdTimer);
    if (!long) preview.move(e.key === 'ArrowRight' ? 1 : -1);
    held = null;
  }
  addEventListener('keydown', keydown); addEventListener('keyup', keyup);

  // ------------------------------------------------------------ 読み込み
  (async () => {
    try {
      const d = await api(`/api/deck/${encodeURIComponent(deck)}`);
      if (!alive) return;
      ctx.version = d.version; ctx.saved = d.text; ctx.text = d.text; ctx.structure = d.structure; ctx.blank = d.blank;
      showTitle();
      editor.setText(d.text, { caret: 0 });
      ctx.renderOk = d.render.ok;
      preview.load(d.render.version);
      showRender({ ...d.render, warnings: [], unsupported: [] });
      await refreshStructure();
      if (!alive) return;
      showStatus();
      for (const make of plugins) ctx.plugins.push(make(ctx));
    } catch (e) {
      statusEl.textContent = e.message; statusEl.dataset.tone = 'error';
      if (e.status === 404) setTimeout(() => { if (alive) navigate('/', true); }, 1500);
    }
  })();

  const cleanup = () => {
    alive = false;
    preview.destroy();
    clearTimeout(holdTimer);
    removeEventListener('beforeunload', beforeUnload);
    off(); removeEventListener('keydown', keydown); removeEventListener('keyup', keyup);
    clearTimeout(ctx.timer);
    if (ctx.dirty) ctx.flush();
    ctx.plugins.forEach(p => p.destroy?.());
  };
  cleanup.flush = async () => {
    try {
      document.activeElement?.blur?.();
      if (!await ctx.flush()) { toast(S.saveFirst); return false; }
      await ctx.blocks?.finish();
      const saved = await ctx.flush();
      if (!saved) toast(S.saveFirst);
      return saved;
    } catch { toast(S.saveFirst); return false; }
  };
  return cleanup;
}
