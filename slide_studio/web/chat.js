// AI チャット（設計書 §8.2・§10.2、作業手順書 手順6）。案 C2「ためてまとめて送る」：
// 指示はタブ・ページごとに書きためて（未送信の指示）、［送信］でまとめて1回の実行にする。
// タブごとに AI のモデル・思考量・会話を持ち、タブどうしは並行して動く。どれかの実行中は発表の編集をロックする。
// 入力欄は Codex と同じ形：添付（＋・貼り付け・落とす）、コンテキストの円、モデルと思考量、送信。
// 左の欄で［下書き］を見ている間は「下書きのチャット」（mode "memo"。設計書 §8.8）：タブ・会話を分け、対象を選ばず、
// 書いて送るとすぐ1回の実行になる。AI は memo.md だけを直し、返事は普通の文章（検査も ✓／✗ も無い）。
import { makeModelPicker, lookup, helpHtml, loginAi } from './ai-model.js';
import { api, locationHeaders, esc, onEvent, toast as showToast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';

const roleError = message => String(message || '').replace(/^\[([a-z_]+)\] /, (_, role) => `${S.agents.names[role] || role}：`);
const toast = message => showToast(roleError(message));
const T = S.ai;
const ACTIVE = new Set(['run', 'check', 'review']);
const DRAFT_DELAY = 400;
const TARGET_KEYS = { Digit1: 'fig', Digit2: 'page', Digit3: 'deck' }; // ⌥1 図・⌥2 ページ・⌥3 発表全体
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const fmtTokens = n => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
// 下書きのチャットの返事（Markdown）の一部だけを表示に使う：見出し・箇条書き・太字・コード。ほかは文字のまま
function mdLite(text) {
  const inline = s => (s.includes(T.decisionMarker) ? `<span class="decision-needed">${format(s)}</span>` : format(s));
  const format = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = null;
  for (const line of String(text || '').split('\n')) {
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) { (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) out.push(`<p class="h">${inline(h[1])}</p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

export function makeChat(ctx) {
  const deck = ctx.deck;
  const base = `/api/deck/${encodeURIComponent(deck)}/chat`;
  const panel = ctx.root.querySelector('#chat');
  const side = ctx.root.querySelector('#stepSide');
  const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(`slide-studio.chat.${deck}.${k}`)); localStorage.setItem(`slide-studio.chat.${deck}.${k}`, JSON.stringify(v)); } catch { return null; } return null; };
  let alive = true, st = null, ai = null, histOpen = false, sending = false, shownKey = null, dialog = null, settingSaves = 0, favoritesWanted = null, favoritesSaving = false;
  let submission = null; // HTTP の応答前も、送ろうとしている内容を会話欄に表示する
  const submitting = t => !!t && submission?.tab === t.id;
  const pending = {}; // タブごとの、まだ送っていない添付（送信のときに保存する）
  let mode = 'slides'; // slides / memo / theme は別のタブ・会話
  const tabIds = { slides: store('tab'), memo: store('tab.memo'), theme: store('tab.theme') };
  let tabId = tabIds.slides;
  const pins = store('pins') || {};
  const fixedPages = new Map(); // 閲覧中のページとは別に、会話ごとの指示先を保持する
  const fixedPage = () => fixedPages.get(tabId);
  const talks = store('talk') || {}; // タブごとの「話し合い」（スライドのタブだけ。AI はファイルを変えない）
  const timers = {}, patches = {}, rolePatches = {}, roleSeq = {};

  panel.innerHTML = `
    <div class="chat-tabs">
      <div class="chat-tablist" role="tablist" aria-label="${T.tabs}"></div>
      <div class="chat-actions">
        <button class="ibtn" data-act="add" aria-label="${T.newTab}" title="${T.newTab}">${svg('plus')}</button>
        <button class="btn sm ghost" data-act="hist" aria-expanded="false" data-tip="${T.openHistory}">${svg('clock')}${T.history}</button>
      </div>
      <div class="chat-hist" role="dialog" aria-label="${T.historyTitle}" hidden></div>
    </div>
    <div class="chat-mode" hidden data-tip="${T.memoModeTip}">${svg('notebookPen')}<span>${T.memoMode}</span></div>
    <div class="chat-main">
      <div class="chat-log"><div class="chat-log-in" aria-live="polite"></div></div>
      <div class="chat-drafts"></div>
      <div class="chat-compose">
        <div class="chat-notice"></div>
        <div class="chat-target"></div>
        <div class="chat-field">
          <div class="chat-attach"></div>
          <textarea class="chat-input" rows="3" disabled></textarea>
          <div class="chat-bar">
            <button class="ibtn" data-act="attach">${svg('plus')}</button>
            <button class="ibtn" data-act="talk" aria-pressed="false">${svg('messages')}</button>
            <span class="grow"></span>
            <span class="chat-ctx" tabindex="0" hidden></span>
            <div class="chat-model"></div>
            <button class="chat-send" data-act="send">${svg('arrowUp')}</button>
          </div>
        </div>
        <input class="chat-file" type="file" multiple hidden>
      </div>
    </div>`;
  const $ = s => panel.querySelector(s);
  const input = $('.chat-input');
  // 入力欄は内容に合わせて伸ばす（上限は CSS の max-height＝10行）
  const fit = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
  tip($('[data-act=attach]'), T.attach);
  const picker = makeModelPicker({
    host: $('.chat-model'),
    onModel: key => { const t = tab(); if (t) return patchTab(t, { model: key, effort: null }).then(() => loadAi()); },
    onEffort: effort => { const t = tab(); if (t) return patchTab(t, { effort }); },
    onRole: (role, value) => { const t = tab(); if (t) return patchRole(t, role, value); },
    onFavorites: saveFavorites,
    onRecheck: () => loadAi(true),
  });

  // ------------------------------------------------------------ ページ・対象
  const pages = () => ctx.structure?.pages || [];
  const keyOf = p => p.id || '@' + p.index;
  const pageByKey = key => pages().find(p => keyOf(p) === key);
  const viewKey = () => { const i = ctx.preview.pageOfSlide(ctx.preview.index); const p = i == null ? null : pages()[i]; return p ? keyOf(p) : 'deck'; };
  const isFig = key => key.startsWith('fig:');
  // 編集用のブロック選択が外れても、同じページでは図への指示を維持する。
  const selFig = () => figurePage === viewKey() ? lastFig : null;
  let stepOnly = false;
  const figureStep = key => stepOnly ? visibleFigureStep(key) : null;
  function visibleFigureStep(key) {
    if (key !== selFig()) return null;
    const block = ctx.preview.win?.document.querySelector(`.slide.active [data-slide-studio="${CSS.escape(figureBlock)}"]`);
    const frame = block?.querySelector('iframe');
    const a = frame?.contentWindow?.animation;
    return a && a.stepNames?.length > 1 ? { index: a.step, count: a.stepNames.length, title: a.stepNames[a.step] } : null;
  }
  function shortOf(key) {
    if (key === 'deck') return T.wholeShort;
    if (isFig(key)) return key.slice(4).split('/').pop();
    const p = pageByKey(key);
    if (!p) return key;
    const i = ctx.preview.slideOfPage(p.index);
    return 'p' + ((i >= 0 ? i : p.index) + 1);
  }
  const labelOf = (key, step = figureStep(key)) => key === 'theme' ? S.tabTheme : key === 'memo' ? T.memoLabel : key === 'deck' ? T.wholeDeck : isFig(key) ? `${T.figure} ${shortOf(key)}${step ? T.figureStep(step) : ''}` : `${shortOf(key)} ${pageByKey(key)?.title || ''}`.trim();
  const modeOf = t => t.mode || 'slides';
  const plain = () => mode !== 'slides';
  const plainText = key => T[`${mode === 'theme' ? 'theme' : 'memo'}${key}`];
  const talkOf = t => !!t && !plain() && !!talks[t.id];
  const allTabs = () => st?.tabs || [];
  const tabs = () => allTabs().filter(t => modeOf(t) === mode); // 今のチャット（スライド・下書き）のタブ
  const slideTabs = () => allTabs().filter(t => modeOf(t) === 'slides'); // ページの印・帯はスライドのタブだけ
  const openTabs = () => tabs().filter(t => t.open);
  const tab = () => openTabs().find(t => t.id === tabId) || null;
  const roundsOf = id => (st?.rounds || []).filter(r => r.tab === id);
  // 何も始めていないタブ（会話・書きかけ・添付が無い）。最後の1つがこれなら閉じるボタンを出さない
  const fresh = t => !roundsOf(t.id).length && !submitting(t) && !draftsOf(t).length && !(t.attach || []).length && !pendingOf(t).length;
  const questionOpen = r => !!r?.questions?.length && roundsOf(r.tab).at(-1)?.id === r.id
    && !r.restored && !['error', 'cancelled'].includes(r.state);
  const busy = id => roundsOf(id).some(r => ACTIVE.has(r.state));
  const runningKeys = id => roundsOf(id).filter(r => ACTIVE.has(r.state)).flatMap(r => r.items.map(i => i.key));
  const draftText = value => typeof value === 'string' ? value : value?.text || '';
  const draftValue = (key, text, before) => key.startsWith('@') && typeof before !== 'string' && pageByKey(key)
    ? { text, page_title: before?.page_title ?? (fixedPage()?.key === key ? fixedPage().title : pageByKey(key).title) } : text;
  const uncertain = (t, key) => key.startsWith('@') && (typeof t.drafts[key]?.page_title !== 'string' || t.drafts[key].page_title !== pageByKey(key)?.title);
  const draftsOf = t => Object.entries(t?.drafts || {}).map(([k, v]) => [k, draftText(v)]).filter(([, v]) => v.trim())
    .sort(([a], [b]) => (a === 'deck' ? -1 : pageByKey(a)?.index ?? 1e9) - (b === 'deck' ? -1 : pageByKey(b)?.index ?? 1e9));
  const hasDraft = (t, key) => !submitting(t) && !!draftText(t.drafts?.[key]).trim();
  // 対象は表示中のページ。スライドで図を選んでいればその図（［ページ］でページにする）。［全体］を押したタブだけ発表全体
  let pageOnly = false, lastFig = null, figurePage = null, figureBlock = null;
  const pinOf = () => (tab() && pins[tab().id] === 'deck' && 'deck') || null;
  const curKey = () => plain() ? mode : fixedPage()?.key || pinOf() || (!pageOnly && selFig()) || viewKey();
  const isPage = key => key !== 'deck' && !isFig(key);

  function chooseDraftTarget(t, key) {
    dialog?.remove();
    const choices = pages().filter(p => ctx.preview.slideOfPage(p.index) >= 0);
    dialog = document.createElement('div'); dialog.className = 'dialog-back';
    dialog.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${T.chooseDraftTarget}">
      <div class="dh"><h3>${T.chooseDraftTarget}</h3><button class="ibtn" data-close>${svg('x')}</button></div>
      <div class="chat-dialog-body"><p>${T.targetChanged}</p>${typeof t.drafts[key]?.page_title === 'string' ? `<p>${esc(T.originalTarget(t.drafts[key].page_title))}</p>` : ''}<p>${esc(draftText(t.drafts[key]))}</p>
      ${choices.map((p, i) => `<div class="row"><span class="grow">${esc(labelOf(keyOf(p)))}</span><button class="ibtn" data-choice="${i}">${svg('check')}</button></div>`).join('')}</div></div>`;
    document.body.append(dialog);
    tip(dialog.querySelector('[data-close]'), S.cancel);
    dialog.querySelectorAll('[data-choice]').forEach(b => tip(b, T.useDraftTarget(labelOf(keyOf(choices[Number(b.dataset.choice)])))));
    const close = () => { dialog?.remove(); dialog = null; input.focus(); };
    dialog.onclick = e => {
      if (e.target === dialog || e.target.closest('[data-close]')) { close(); return; }
      const b = e.target.closest('[data-choice]'); if (!b) return;
      const p = choices[Number(b.dataset.choice)], next = keyOf(p);
      if (pageByKey(next)?.title !== p.title) { chooseDraftTarget(t, key); return; }
      const text = draftText(t.drafts[key]);
      const other = next === key ? '' : draftText(t.drafts[next]);
      if (other && uncertain(t, next)) { toast(T.targetChanged); return; }
      delete t.drafts[key];
      t.drafts[next] = draftValue(next, other ? `${other}\n${text}` : text);
      close(); pageOnly = true; setPin(null); goKey(next); shownKey = null; saveDrafts(t); render();
    };
    dialog.onkeydown = e => { if (e.key === 'Escape') close(); };
    dialog.querySelector('[data-close]').focus();
  }

  function goKey(key) {
    if (key === 'deck') { setPin('deck'); return; }
    if (isFig(key)) {
      // その図を置いたページへ移って、図を選ぶ
      const f = ctx.blocks?.figureAt(key.slice(4)); if (!f) return;
      const i = ctx.preview.slideOfPage(f.page);
      if (i >= 0 && ctx.preview.pageOfSlide(ctx.preview.index) !== f.page) ctx.preview.go(i, 0);
      ctx.blocks.select(f.key);
      return;
    }
    const p = pageByKey(key);
    const i = p ? ctx.preview.slideOfPage(p.index) : -1;
    if (i >= 0) ctx.preview.go(i, 0);
  }
  function setPin(v) {
    const t = tab(); if (!t) return;
    fixedPages.delete(t.id);
    if (v) pins[t.id] = v; else delete pins[t.id];
    store('pins', pins); render();
  }
  function toggleFixedPage() {
    if (!tab() || plain()) return;
    if (fixedPage()) fixedPages.delete(tabId);
    else {
      const key = curKey(), p = pageByKey(key);
      if (!p || !isPage(key)) return;
      fixedPages.set(tabId, { key, title: p.title });
    }
    pageOnly = true; stepOnly = false; render();
  }
  // 対象を図・ページ・発表全体にする（⌥1・⌥2・⌥3）。図は選んでいるときだけ
  function setTarget(to) {
    if (!tab() || plain() || (to === 'fig' && !selFig())) return;
    stepOnly = false;
    pageOnly = to === 'page';
    setPin(to === 'deck' ? 'deck' : null);
  }
  // ［ページ］［全体］は押すたびに入れ替える。外すと、選んでいる図（なければページ）に戻る
  function toggle(what) {
    const cur = curKey();
    if (what === 'deck') setPin(cur === 'deck' ? null : 'deck');
    else setTarget(isPage(cur) ? 'fig' : 'page');
  }
  function targetKey(e) {
    // ⌥C は入力欄の中でも開け閉めする
    if (e.code === 'KeyC' && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.isComposing && !e.repeat
        && !e.target.closest?.('[role="dialog"], .dialog') && !ctx.root.querySelector('.dialog, dialog[open]')) {
      e.preventDefault();
      const opening = document.body.classList.contains('chat-off');
      ctx.root.querySelector('#chatToggle')?.click();
      if (opening) input.focus();
      return true;
    }
    if (e.code === 'KeyC' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
        && !e.isComposing && !e.repeat && !ctx.blocks?.selected
        && !e.target.closest?.('input, textarea, select, [contenteditable], [role="dialog"], .dialog')
        && !ctx.root.querySelector('.dialog, dialog[open]')) {
      e.preventDefault();
      if (document.body.classList.contains('chat-off')) ctx.root.querySelector('#chatToggle')?.click();
      input.focus();
      return true;
    }
    const to = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && TARGET_KEYS[e.code];
    if (!to || !tab() || plain()) return false;
    e.preventDefault(); setTarget(to);
    return true;
  }
  function selectTab(id) { tabId = tabIds[mode] = id; store(plain() ? `tab.${mode}` : 'tab', id); render(); }
  // 左の欄で［下書き］を見ているかどうかで、チャットを切り替える（memo.js・theme-tab.js が呼ぶ）
  // 切り替えたことはチャットが見えていれば知らせる（開いたときの切り替えは知らせない）
  let modeSet = false;
  setTimeout(() => { modeSet = true; }); // 下書きの機能（memo.js）が開いたときに切り替える分までは知らせない
  function setMode(m) {
    if (m === mode) return;
    tabIds[mode] = tabId; mode = m; tabId = tabIds[m];
    histOpen = false; shownKey = null;
    if (st && !tab()) tabId = openTabs()[0]?.id || null;
    render();
    if (modeSet && !document.body.classList.contains('chat-off')) toast(mode === 'theme' ? T.toTheme : plain() ? T.toMemo : T.toSlides);
  }
  // タブのモデル（選んでいなければ既定）と、その AI が使えるか
  const modelKey = t => {
    if (t?.model) return t.model;
    // モデルを選べるようになる前のタブ（Codex の会話だけを持つ）は Codex のまま
    const codex = t?.session && ai?.providers.find(x => x.id === 'codex');
    return codex?.default ? `codex:${codex.default}` : ai?.default || null;
  };
  const started = t => !!t && (!!t.session || roundsOf(t.id).length > 0);
  function aiOf(t) {
    const key = modelKey(t);
    // どの AI も使えないと既定のモデルが無い。そのときは既定の Codex の案内を出す
    const { p, m } = key ? lookup(ai, key) : { p: ai?.providers.find(x => x.id === 'codex') || null, m: null };
    return { p, m, ok: !!(p?.ok && m) };
  }

  // ------------------------------------------------------------ サーバー
  function applyState(s, opening = false) {
    // 書きかけの指示は、この画面の入力を正とする（保存の往復で打った文字を消さない）
    const local = new Map(allTabs().map(t => [t.id, t.drafts]));
    for (const t of s.tabs) if (local.has(t.id)) t.drafts = local.get(t.id);
    st = s;
    if (opening) {
      for (const m of Object.keys(tabIds)) {
        tabIds[m] = allTabs().find(t => modeOf(t) === m && t.open && !busy(t.id) && fresh(t))?.id || null;
      }
      tabId = tabIds[mode];
    }
    if (!tab()) { tabId = openTabs()[0]?.id || null; }
    setLock(s.locked, s.lock);
    render();
  }
  function setLock(locked, lock) {
    const n = new Set((st?.rounds || []).filter(r => r.state === 'run' && (r.mode || 'slides') === 'slides' && !r.talk).map(r => r.tab)).size;
    const any = () => ctx.allLocked || !!(ctx.lock.pages?.length || ctx.lock.figures?.length);
    const was = any();
    ctx.allLocked = !!locked; ctx.lock = lock || {}; ctx.aiTabs = n;
    if (ctx.lock.pages?.length || ctx.lock.figures?.length) ctx.mergeable = true;
    ctx.showStatus();
    if (was && !any()) ctx.reloadText?.();
  }
  function saveDrafts(t) {
    clearTimeout(timers[t.id]);
    timers[t.id] = setTimeout(() => {
      timers[t.id] = 0;
      patches[t.id] = (patches[t.id] || Promise.resolve()).then(() => api(`${base}/tabs/${t.id}`, { method: 'PATCH', body: { drafts: t.drafts } })).catch(e => toast(e.message));
    }, DRAFT_DELAY);
  }
  async function flushDrafts(t) {
    if (timers[t.id]) { clearTimeout(timers[t.id]); timers[t.id] = 0; patches[t.id] = (patches[t.id] || Promise.resolve()).then(() => api(`${base}/tabs/${t.id}`, { method: 'PATCH', body: { drafts: t.drafts } })); }
    await patches[t.id];
  }
  async function patchTab(t, body) {
    const before = Object.fromEntries(Object.keys(body).map(k => [k, t[k]]));
    const config = 'model' in body || 'effort' in body;
    if (config) settingSaves++;
    Object.assign(t, body); render();
    // 画面は先に変える。同じタブの保存は押した順に行う
    const job = (patches[t.id] || Promise.resolve()).catch(() => {}).then(async () => {
      try { await api(`${base}/tabs/${t.id}`, { method: 'PATCH', body }); }
      catch (e) {
        const current = allTabs().find(x => x.id === t.id);
        // 後の操作で選び直した項目は戻さない
        if (current) for (const k of Object.keys(body)) if (current[k] === body[k]) current[k] = before[k];
        toast(e.message);
      }
      finally { if (config) settingSaves--; if (alive) render(); }
    });
    patches[t.id] = job;
    return job;
  }
  // 表示するモデル：チェックは先に変え、保存は最後の状態だけを順に送る
  async function saveFavorites(favorites) {
    ai = { ...ai, favorites }; favoritesWanted = favorites; render();
    if (favoritesSaving) return;
    favoritesSaving = true;
    try {
      while (favoritesWanted) {
        const body = { favorites: favoritesWanted };
        favoritesWanted = null;
        const a = await api('/api/ai/favorites', { method: 'PUT', body });
        if (alive && !favoritesWanted) { ai = a; render(); }
      }
    } catch (e) { favoritesWanted = null; toast(e.message); favoritesSaving = false; await loadAi(); }
    finally { favoritesSaving = false; }
  }
  function patchRole(t, role, value) {
    settingSaves++;
    const assign = v => {
      const latest = allTabs().find(x => x.id === t.id);
      if (!latest) return;
      latest.ai_roles = { ...latest.ai_roles };
      if (v == null) delete latest.ai_roles[role]; else latest.ai_roles[role] = v;
    };
    const before = t.ai_roles?.[role], seqKey = `${t.id}:${role}`, seq = (roleSeq[seqKey] || 0) + 1;
    roleSeq[seqKey] = seq;
    // 画面は先に変える。オン・オフはモデルと別に保つ（サーバーと同じ）
    assign(before?.enabled == null || (value && 'enabled' in value) ? value : { ...value, enabled: before.enabled }); render();
    // タブを離れて戻っても、同じタブの保存は順番に行う。後の操作があれば、前の応答では画面を戻さない。
    const job = (rolePatches[t.id] || Promise.resolve()).then(async () => {
      if (!allTabs().some(x => x.id === t.id)) return;
      try { const saved = await api(`${base}/tabs/${t.id}`, { method: 'PATCH', body: { ai_roles: { [role]: value } } });
        if (roleSeq[seqKey] === seq) assign(saved.ai_roles[role]);
      } catch (e) { if (roleSeq[seqKey] === seq) assign(before); toast(e.message); }
    }).finally(() => { settingSaves--; if (alive) render(); });
    rolePatches[t.id] = job.catch(() => {});
    return job;
  }
  async function load(opening = false) {
    try { const s = await api(opening ? `${base}/open` : base, opening ? { method: 'POST' } : undefined); if (alive) { if (s.ai && !ai) ai = s.ai; applyState(s, opening); } } catch (e) { toast(e.message); }
  }
  // AI の検出（CLI・ログイン・モデル）。数秒かかるので、チャットの状態とは別に読む
  async function loadAi(refresh = false) {
    try {
      const a = await api(`/api/ai/status${refresh ? '?refresh=1' : ''}`);
      if (alive) { ai = favoritesSaving ? { ...a, favorites: ai.favorites } : a; render(); }
    } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------ 添付（写真は images/、ほかは materials/）
  // 添付した時点では画面が持っておき、送信するときに置く（送らなかったものは保存しない）
  let pendingSeq = 0;
  const pendingOf = t => (t && pending[t.id]) || [];
  async function upload(file) {
    const name = file.name || '';
    const image = (file.type || '').startsWith('image/') && (IMAGE.test(name) || !/\.\w+$/.test(name));
    const url = image ? `/api/deck/${encodeURIComponent(deck)}/assets?name=${encodeURIComponent(name)}`
      : `/api/deck/${encodeURIComponent(deck)}/materials?path=${encodeURIComponent(name || 'file')}`;
    const r = await fetch(url, { method: 'POST', headers: { ...locationHeaders(), 'Content-Type': (image && file.type) || 'application/octet-stream' }, body: file });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${name || T.attachUnnamed}：${out.error || r.status}`);
    return image ? { path: out.path, name: out.name, kind: 'image' } : { path: `materials/${out.path}`, name: out.path.split('/').pop(), kind: 'file' };
  }
  function attach(files) {
    const t = tab(); files = [...files];
    if (!t || submitting(t) || !files.length) return;
    const list = pending[t.id] ||= [];
    for (const file of files) {
      const name = file.name || '';
      const image = (file.type || '').startsWith('image/') && (IMAGE.test(name) || !/\.\w+$/.test(name));
      list.push({ id: `p${++pendingSeq}`, file, name: name || T.attachUnnamed, kind: image ? 'image' : 'file', url: image ? URL.createObjectURL(file) : null });
    }
    render();
    input.focus();
  }
  function dropPending(t, id) {
    const list = pending[t.id] || [];
    for (const p of list) if (id == null || p.id === id) { if (p.url) URL.revokeObjectURL(p.url); }
    pending[t.id] = id == null ? [] : list.filter(p => p.id !== id);
  }
  const fileUrl = path => `/files/${path.startsWith('images/') ? `topics/${encodeURIComponent(st?.topic || '')}` : `decks/${encodeURIComponent(deck)}`}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const attachChip = (a, removable) => `<span class="chat-att${a.kind === 'image' ? ' img' : ''}" data-tip="${esc(`${a.name} — ${a.kind === 'image' ? T.attachImage : T.attachFile}`)}">
    ${a.kind === 'image' ? `<img src="${esc(fileUrl(a.path))}" alt="">` : svg('file')}<span class="nm">${esc(a.name)}</span>
    ${removable ? `<button class="x" data-act="unattach" data-path="${esc(a.path)}" aria-label="${esc(T.removeAttach(a.name))}" data-tip="${esc(T.removeAttach(a.name))}">${svg('x')}</button>` : ''}</span>`;
  const pendingChip = (p, removable = true) => `<span class="chat-att${p.kind === 'image' ? ' img' : ''}" data-tip="${esc(`${p.name} — ${p.kind === 'image' ? T.attachImagePending : T.attachFilePending}`)}">
    ${p.kind === 'image' ? `<img src="${esc(p.url)}" alt="">` : svg('file')}<span class="nm">${esc(p.name)}</span>
    ${removable ? `<button class="x" data-act="unattach" data-pending="${p.id}" aria-label="${esc(T.removePending(p.name))}" data-tip="${esc(T.removePending(p.name))}">${svg('x')}</button>` : ''}</span>`;

  // ------------------------------------------------------------ 操作
  let continueId = null;
  const interruptedReview = r => r.agents?.at(-1)?.role === 'review' && ['error', 'cancelled'].includes(r.agents.at(-1).state);
  function continueButton(r) {
    const last = st.rounds.filter(x => x.tab === r.tab).at(-1);
    if (last?.id !== r.id || r.restored || (!['error', 'cancelled'].includes(r.state) && !interruptedReview(r))) return '';
    return `<button class="btn sm" data-act="${continueId === r.id ? 'continue-send' : 'continue-model'}" data-round="${r.id}" ${busy(r.tab) || settingSaves || sending ? 'disabled' : ''}>${continueId === r.id ? T.continueSelected : interruptedReview(r) ? T.continueReview : T.continueModel}</button>`;
  }
  async function continueRound(r) {
    if (sending || settingSaves || busy(r.tab)) return;
    sending = true; render();
    try {
      if (mode === 'theme' ? !await ctx.theme?.flush() : plain() ? !await ctx.memo?.flush() : !await ctx.flush()) return;
      await flushDrafts(tab());
      await api(`${base}/rounds/${r.id}/continue`, { method: 'POST', body: { base: mode === 'theme' ? ctx.theme.version : mode === 'memo' ? ctx.memo.version : ctx.version } });
      continueId = null; picker.close();
    } catch (e) { toast(e.message); }
    finally { sending = false; if (alive) render(); }
  }
  const continuationNote = r => (r.model_change ? `<p class="chat-note">${esc(T.modelChange(r.model_change.from, r.model_change.to))}</p>` : '') + (r.continued_from ? `<p class="chat-note">${T.continued}</p>` : '');

  const flushFor = m => m === 'theme' ? ctx.theme?.flush() : m === 'memo' ? ctx.memo?.flush() : ctx.flush();
  const versionFor = m => m === 'theme' ? ctx.theme.version : m === 'memo' ? ctx.memo.version : ctx.version;
  // AI の確認への回答：選んだ番号（回答を送るまで画面だけで持つ）
  const answers = new Map();
  const picked = (rid, q) => { const k = `${rid}:${q}`; if (!answers.has(k)) answers.set(k, new Set()); return answers.get(k); };
  const canAnswer = t => !!t && !settingSaves && !sending && !busy(t.id) && aiOf(t).ok;
  // 質問と答えを1つの指示にする。同じ対象への答えは1件にまとめる
  function answerItems(r) {
    const byKey = new Map();
    r.questions.forEach((q, i) => {
      const it = r.items[q.item - 1] || r.items[0];
      const line = `${q.text} → ${[...picked(r.id, i)].sort((a, b) => a - b).map(o => q.options[o].label).join('、')}`;
      if (byKey.has(it.key)) byKey.get(it.key).text += `\n${line}`;
      else byKey.set(it.key, { ...it, text: line, ...(it.step ? { step: it.step.index } : {}) });
    });
    return [...byKey.values()];
  }
  async function sendAnswers(r) {
    const t = tab();
    if (!canAnswer(t) || t.id !== r.tab || r.questions.some((_, i) => !picked(r.id, i).size)) return;
    const sendMode = modeOf(t), items = answerItems(r);
    submission = { tab: t.id, rounds: new Set(roundsOf(t.id).map(x => x.id)), items, attach: [], pending: [] };
    sending = true; render();
    $('.chat-log').scrollTop = $('.chat-log').scrollHeight;
    try {
      if (!await flushFor(sendMode)) { toast(sendMode === 'slides' ? T.saveFirst : T[`${sendMode}SaveFirst`]); return; }
      const sent = await api(`${base}/tabs/${t.id}/send`, { method: 'POST', body: { base: versionFor(sendMode), items, attach: [], talk: talkOf(t) } });
      if (!st.rounds.some(x => x.id === sent.id)) st.rounds.push(sent);
      Object.assign(t, { model: sent.model });
      r.questions.forEach((_, i) => answers.delete(`${r.id}:${i}`));
    } catch (e) { toast(e.message); }
    finally { submission = null; sending = false; shownKey = null; if (alive) render(); }
  }
  function pickAnswer(r, q, o) {
    if (!canAnswer(tab())) return;
    const set = picked(r.id, q);
    if (r.questions[q].multiple) { if (!set.delete(o)) set.add(o); }
    else { set.clear(); set.add(o); }
    if (r.questions.length === 1 && !r.questions[0].multiple) { sendAnswers(r); return; }
    renderLog();
    $('.chat-log-in').querySelector(`[data-act=answer][data-round="${r.id}"][data-q="${q}"][data-o="${o}"]`)?.focus();
  }
  async function send() {
    const t = tab();
    if (!t || settingSaves || sending || busy(t.id) || !draftsOf(t).length || !aiOf(t).ok) return;
    const figure = selFig(), step = figure ? figureStep(figure) : null;
    const sendMode = modeOf(t), talk = talkOf(t);
    submission = { tab: t.id, rounds: new Set(roundsOf(t.id).map(r => r.id)),
      items: draftsOf(t).map(([key, text]) => ({ key, label: labelOf(key, key === figure ? step : null), text: text.trim(),
        ...(key.startsWith('@') ? { page_title: t.drafts[key].page_title } : {}),
        ...(key === figure && step ? { step: step.index } : {}) })),
      attach: [...(t.attach || [])], pending: [...pendingOf(t)] };
    sending = true; shownKey = null; render();
    $('.chat-log').scrollTop = $('.chat-log').scrollHeight;
    try {
      // 保存待ちの入力を確定してから送る（設計書 §6.4）。AI はその版から始める（下書きのチャットは下書きの版）
      if (!await flushFor(sendMode)) { toast(sendMode === 'slides' ? T.saveFirst : T[`${sendMode}SaveFirst`]); return; }
      const list = draftsOf(t);
      const stale = list.find(([key]) => uncertain(t, key));
      if (stale) { chooseDraftTarget(t, stale[0]); return; }
      const items = submission.items;
      await flushDrafts(t);
      // 添付はここで初めて置く。同じ中身はすでにあるものを使うので、送り直しても増えない
      const waiting = pendingOf(t), files = [...(t.attach || [])];
      try { for (const p of waiting) { const a = await upload(p.file); if (!files.some(x => x.path === a.path)) files.push(a); } }
      catch (e) { toast(e.message); return; }
      const backup = { drafts: t.drafts, attach: t.attach };
      const assign = values => { Object.assign(t, values); const current = allTabs().find(x => x.id === t.id); if (current) Object.assign(current, values); };
      assign({ drafts: {}, attach: [] }); shownKey = null;
      try {
        const r = await api(`${base}/tabs/${t.id}/send`, { method: 'POST', body: { base: versionFor(modeOf(t)), items, attach: files, talk } });
        if (!st.rounds.some(x => x.id === r.id)) st.rounds.push(r);
        assign({ model: r.model });
        dropPending(t);
      } catch (e) { assign(backup); throw e; }
    } catch (e) { toast(e.message); }
    finally { submission = null; sending = false; shownKey = null; if (alive) render(); }
  }
  async function addTab() {
    try {
      const empty = openTabs().find(t => fresh(t));
      if (empty) { histOpen = false; selectTab(empty.id); input.focus(); return empty; }
      const t = await api(`${base}/tabs`, { method: 'POST', body: { mode } });
      if (!tabs().some(x => x.id === t.id)) st.tabs.push(t);
      histOpen = false; selectTab(t.id);
      input.focus();
      return t;
    } catch (e) { toast(e.message); return null; }
  }
  function confirmDialog(title, body, ok) {
    return new Promise(resolve => {
      dialog?.remove();
      dialog = document.createElement('div'); dialog.className = 'dialog-back';
      dialog.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="dh"><h3>${esc(title)}</h3></div><div class="chat-dialog-body">${body}</div>
        <div class="df"><button class="btn" data-a="no">${S.cancel}</button><button class="btn primary" data-a="yes">${esc(ok)}</button></div></div>`;
      document.body.append(dialog);
      const done = v => { dialog?.remove(); dialog = null; resolve(v); };
      dialog.onclick = e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) done(a === 'yes'); else if (e.target === dialog) done(false); };
      dialog.onkeydown = e => { if (e.key === 'Escape') done(false); };
      dialog.querySelector('[data-a=yes]').focus();
    });
  }
  const fileList = names => `<ul class="chat-filelist">${names.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
  async function restore(r) {
    // 保存待ちを先に保存し、戻すと消える変更（送信の後・同じ時間のほかの作業）を確認に出す
    if (!await ctx.flush()) { toast(T.saveFirst); return; }
    let plan;
    try { plan = await api(`${base}/rounds/${r.id}/restore`); } catch (e) { toast(e.message); return; }
    const warn = (title, names) => names.length ? `<div class="chat-box warn"><strong>${esc(title)}</strong>${fileList(names)}</div>` : '';
    const body = fileList(plan.files) + warn(T.restoreLater, plan.later)
      + warn(T.restoreShared(plan.shared.tabs), plan.shared.files) + warn(T.restoreKept, plan.kept);
    if (!await confirmDialog(T.restore, body, T.restore)) return;
    try {
      const res = await api(`${base}/rounds/${r.id}/restore`, { method: 'POST' });
      Object.assign(r, res); render();
      toast(T.restoreDone(res.restored.files.length));
      ctx.reloadText?.();
    } catch (e) { toast(e.message); }
  }
  async function cancel(r) {
    r.stopping = true; render();
    try { await api(`${base}/rounds/${r.id}/cancel`, { method: 'POST' }); } catch (e) { r.stopping = false; render(); toast(e.message); }
  }
  function retry(r) {
    const t = allTabs().find(x => x.id === r.tab); if (!t) return;
    const byKey = new Map();
    for (const x of newErrors(r)) byKey.set(x.key, [...(byKey.get(x.key) || []), x.text]);
    t.drafts = { ...t.drafts };
    for (const [key, list] of byKey) {
      const text = T.retryText(list);
      const before = t.drafts[key], old = draftText(before);
      t.drafts[key] = draftValue(key, old.trim() ? `${old}\n${text}` : text, before);
    }
    if (!t.open) patchTab(t, { open: true });
    selectTab(t.id); saveDrafts(t); toast(T.retryAdded);
  }
  // 上限まで直させても残った確認役の指摘を、未送信の指示に加える。指摘の場所は文なので、スライドは発表全体への指示にする
  function retryReview(r) {
    const t = allTabs().find(x => x.id === r.tab); if (!t) return;
    const key = r.mode === 'memo' ? 'memo' : r.mode === 'theme' ? 'theme' : 'deck';
    const text = T.retryReviewText(reviewLeft(r).map(i => `${i.target}：${i.message}${i.suggestion ? `（${i.suggestion}）` : ''}`));
    t.drafts = { ...t.drafts };
    const before = t.drafts[key], old = draftText(before);
    t.drafts[key] = draftValue(key, old.trim() ? `${old}\n${text}` : text, before);
    if (!t.open) patchTab(t, { open: true });
    selectTab(t.id); saveDrafts(t); toast(T.retryReviewAdded);
  }

  const sentActions = (r, i) => `<span class="chat-message-actions">
    <button class="ibtn" data-act="copy-message" data-round="${r.id}" data-item="${i}" aria-label="${T.copyMessage}" data-tip="${T.copyMessage}">${svg('copy')}</button>
    <button class="ibtn" data-act="edit-message" data-round="${r.id}" data-item="${i}" aria-label="${T.editMessage}" data-tip="${T.editMessage}" ${busy(r.tab) || sending ? 'disabled' : ''}>${svg('pencil')}</button></span>`;
  function editMessage(r, i) {
    const t = allTabs().find(t => t.id === r.tab), item = r.items[i];
    if (!t || !item || busy(t.id) || sending) return;
    const old = draftText(t.drafts?.[item.key]);
    t.drafts = { ...t.drafts, [item.key]: draftValue(item.key, old.trim() ? `${old}\n${item.text}` : item.text, item) };
    selectTab(t.id);
    if (!plain()) {
      if (item.key === 'deck') setPin('deck');
      else { pageOnly = isPage(item.key); setPin(null); goKey(item.key); }
    }
    if (r.talk) talks[t.id] = true; else delete talks[t.id];
    store('talk', talks); saveDrafts(t); shownKey = null; render(); input.focus();
  }

  // ------------------------------------------------------------ 表示
  const chipCls = key => key === 'deck' ? ' deck' : isFig(key) ? ' fig' : '';
  const chip = (key, label) => `<button class="chat-chip${chipCls(key)}" data-act="go" data-key="${esc(key)}" data-tip="${esc(key === 'deck' ? T.deckTarget : T.goPage(label || labelOf(key)))}" aria-label="${esc(key === 'deck' ? T.deckTarget : T.goPage(label || labelOf(key)))}">${esc(key === 'deck' || isFig(key) ? shortOf(key) : (label || '').split(' ')[0] || shortOf(key))}</button>`;
  const two = n => String(n).padStart(2, '0');
  function fmtTime(t) {
    const d = new Date(t * 1000), now = new Date(), hm = `${d.getHours()}:${two(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }
  const fmtDay = t => { const d = new Date(t * 1000); return d.toDateString() === new Date().toDateString() ? T.today : `${d.getMonth() + 1}/${d.getDate()}`; };
  function filesText(f) {
    const names = [...(f?.modified || []), ...(f?.added || []), ...(f?.deleted || [])].map(n => n.replace(`decks/${deck}/`, ''));
    if (!names.length) return T.noFiles;
    return names.slice(0, 2).join('、') + (names.length > 2 ? ` ${T.more(names.length - 2)}` : '');
  }
  function stepsHtml(steps, last) {
    const shown = last ? steps.slice(-last) : steps;
    return shown.map(s => `<div class="chat-step k-${esc(s.kind)}${s.exit ? ' bad' : ''}">${s.role ? esc(S.agents.names[s.role]) + '：' : ''}${esc(s.text)}</div>`).join('');
  }
  // 主の担当（チャット・テーマ編集・下書き）の返事には名前を付けない。HTML 実装や確認役の返事だけ誰のものか示す
  const MAIN_ROLES = new Set(['chat', 'theme', 'draft']);
  const replyHtml = s => `<div class="chat-reply">${s.role && !MAIN_ROLES.has(s.role) ? `<p class="h">${esc(S.agents.names[s.role])}</p>` : ''}${mdLite(s.text)}</div>`;
  // 作業中：AI の返事はそのまま出し、その間の作業（コマンド・ファイル・考え）はまとめて畳む。最後の作業の新しい3行だけ見せる
  // 終わった後：途中の返事も作業も1つにまとめて畳む（最後の返事と結果だけ見せる）
  function workHtml(r, active) {
    if (!active) {
      // 最後の返事（r.summary）と同じ文は、別に出すので重ねない
      const steps = r.steps.filter(s => s.kind !== 'message' || s.text !== r.summary);
      if (!steps.length) return '';
      const body = [];
      for (const s of steps) {
        if (s.kind === 'message') body.push(replyHtml(s));
        else if (typeof body[body.length - 1] === 'object') body[body.length - 1].push(s);
        else body.push([s]);
      }
      return `<details class="chat-log-steps chat-log-all" data-key="w"><summary data-tip="${esc(T.stepsTip)}">${T.steps(steps.length)}</summary>
        <div class="chat-log-body">${body.map(x => typeof x === 'string' ? x : `<div class="chat-steps">${stepsHtml(x)}</div>`).join('')}</div></details>`;
    }
    const out = [];
    let run = [];
    const flush = last => {
      if (!run.length) return;
      out.push(`<details class="chat-log-steps" data-key="w${out.length}"><summary data-tip="${esc(T.stepsTip)}">${T.steps(run.length)}</summary><div class="chat-steps">${stepsHtml(run)}</div></details>`
        + (active && last ? `<div class="chat-steps chat-tail">${stepsHtml(run, 3)}</div>` : ''));
      run = [];
    };
    for (const s of r.steps) {
      if (s.kind !== 'message') { run.push(s); continue; }
      flush(false);
      out.push(replyHtml(s));
    }
    flush(true);
    return out.join('');
  }
  // 検査のエラーを同じ会話で直させている途中・終わった後（設計書 §8.1.2）
  // 確認役の指摘を直させているときは r.fixing === 'review'（指摘は r.review_fixes）
  const fixingHtml = r => {
    if (r.fixing === 'review') { const f = r.review_fixes || [], x = f[f.length - 1]; return x ? `<p class="chat-note">${esc(T.reviewFixing(x.issues, f.length, x.limit))}</p>` : ''; }
    const f = r.fixes || [], x = f[f.length - 1]; return x ? `<p class="chat-note">${esc(T.fixing(x.errors, f.length, x.limit))}</p>` : '';
  };
  // 上限まで直させても残った確認役の指摘（最後の確認）
  const lastReview = r => (r.agents || []).find(a => a.id === r.final_review) || [...(r.agents || [])].reverse().find(a => !a.parent && a.role === 'review');
  const reviewLeft = r => r.state === 'fail' && !r.restored && lastReview(r)?.state === 'needs_fix' ? lastReview(r).issues.filter(i => !i.message.startsWith(T.decisionMarker)) : [];
  // 送信の前からあった検査のエラー（old）は直させず、要修正にもしない
  const newErrors = r => (r.check?.errors || []).filter(x => !x.old);
  function fixesHtml(r) {
    const f = r.fixes || [];
    if (!f.length) return '';
    const rows = f.map((x, i) => `<p class="chat-note">${esc(T.fixed(x.errors, i + 1, x.limit))}${x.summary ? `：${esc(x.summary)}` : ''}</p>`).join('');
    return rows + (r.state === 'fail' && newErrors(r).length && f.length >= f[0].limit ? `<p class="chat-note">${esc(T.fixGaveUp(f[0].limit))}</p>` : '');
  }
  function reviewFixesHtml(r) {
    const f = r.review_fixes || [];
    if (!f.length || !reviewLeft(r).length) return '';
    const rows = f.map((x, i) => `<p class="chat-note">${esc(T.reviewFixed(x.issues, i + 1, x.limit))}${x.summary ? `：${esc(x.summary)}` : ''}</p>`).join('');
    return rows + (reviewLeft(r).length && f.length >= f[0].limit ? `<p class="chat-note">${esc(T.reviewGaveUp(f[0].limit))}</p>` : '');
  }
  const changedOf = r => ['added', 'modified', 'deleted'].some(k => r.files?.[k]?.length);
  // 戻すは変わったファイルの隣に置く。変わっていなければ出さない
  const filesRow = (r, text, changed) => {
    const undo = r.restored ? `<span class="chat-note">${svg('undo')}${T.restored}</span>`
      : r.snapshot && changed ? `<button class="ibtn" data-act="restore" data-round="${r.id}" data-tip="${esc(T.restoreTip)}" aria-label="${esc(T.restore)}">${svg('undo')}</button>` : '';
    return `<div class="chat-files">${svg('files')}<span>${esc(text)}</span>${undo}</div>`;
  };
  const retryReviewButton = r => reviewLeft(r).length ? `<button class="btn sm" data-act="retry-review" data-round="${r.id}">${T.retryReview}</button>` : '';
  // AI の確認。最後の送信のときだけ選べる。後ろに送信が続いたら質問の文だけ残す
  function questionsHtml(r) {
    const qs = r.questions || [];
    if (!qs.length) return '';
    const open = questionOpen(r);
    const off = canAnswer(tab()) ? '' : 'disabled';
    const instant = qs.length === 1 && !qs[0].multiple;
    const cards = qs.map((q, i) => {
      if (!open) return `<div class="chat-question"><p class="chat-question-text">${esc(q.text)}</p></div>`;
      const set = picked(r.id, i);
      return `<div class="chat-question"><p class="chat-question-text">${esc(q.text)}</p>
        <div class="chat-options">${q.options.map((o, j) => `<button class="chat-option" data-act="answer" data-round="${r.id}" data-q="${i}" data-o="${j}" aria-pressed="${set.has(j)}" data-tip="${esc(instant ? T.answerSendTip : T.answerPick)}" ${off}><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`).join('')}</div>
        <div class="chat-question-acts"><button class="ibtn" data-act="answer-other" data-round="${r.id}" data-q="${i}" data-tip="${esc(T.answerOther)}" aria-label="${esc(T.answerOther)}">${svg('pencil')}</button></div></div>`;
    }).join('');
    const ready = qs.every((_, i) => picked(r.id, i).size);
    const submit = open && !instant ? `<div class="chat-question-acts"><button class="ibtn" data-act="answer-send" data-round="${r.id}" data-tip="${esc(T.answerSendAll)}" aria-label="${esc(T.answerSendAll)}" ${ready && !off ? '' : 'disabled'}>${svg('arrowUp')}</button></div>` : '';
    return cards + submit;
  }
  // 編集担当から相談役への質問と答え
  const consultHtml = a => `<div class="chat-box agent-result${a.state === 'error' || a.state === 'cancelled' ? ' warn' : ''}"><strong>${esc(S.agents.names.consult)} · ${esc(a.state === 'complete' ? S.agents.states.consulted : S.agents.states[a.state] || a.state)}</strong>
    <p><b>${S.agents.states.question}</b>：${esc(a.question || '')}</p>${a.error ? `<p>${esc(roleError(a.error))}</p>` : a.summary ? `<p><b>${S.agents.states.answer}</b>：${esc(a.summary)}</p>` : ''}</div>`;
  function reviewsHtml(r) {
    const current = lastReview(r), rows = (r.agents || []).filter(a => !a.parent && a.role !== 'review');
    // 確認結果は現在の要修正・エラーだけを表示する。問題なし・古い結果は履歴に残すだけ。
    if (current && ['needs_fix', 'error'].includes(current.state)) rows.push(current);
    return (r.session_reset ? `<p class="chat-note">${S.agents.sessionReset}</p>` : '') + rows.map(a => a.role === 'consult' ? consultHtml(a) : `<div class="chat-box agent-result ${a.issues?.some(i => i.message.startsWith(T.decisionMarker)) ? 'decision-needed' : a.state === 'complete' ? 'confirmed' : 'warn'}"><strong>${esc(S.agents.names[a.role])} · ${esc(a.issues?.some(i => i.message.startsWith(T.decisionMarker)) ? T.decisionTitle : a.state === 'complete' && a.role === 'html' ? S.agents.implemented : S.agents.states[a.state] || a.state)}</strong><p>${esc(a.error ? roleError(a.error) : a.summary)}</p>${(a.issues || []).map(i => `<p>${esc(i.target)}：${esc(i.message)} ${esc(i.suggestion)}</p>`).join('')}</div>`).join('');
  }
  // 下書き・テーマ：自分の発言 → AI の返事。テーマは最後にテーマの検査だけを表示
  function memoRoundHtml(r, model) {
    const words = key => T[`${r.mode === 'theme' ? 'theme' : 'memo'}${key}`];
    const head = `<div class="chat-sent memo"><div class="chat-sent-head">${svg('send')}${esc(T.sentAt(fmtTime(r.time)))}${model}</div>
      <div class="chat-said">${esc(r.items[0]?.text || '')}</div>${sentActions(r, 0)}
      ${r.attach?.length ? `<div class="chat-attach sent">${r.attach.map(a => attachChip(a, false)).join('')}</div>` : ''}</div>`;
    let ai;
    if (r.state === 'check') {
      ai = `<div class="chat-run"><span class="spinner"></span>${T.checking}</div>`;
    } else if (ACTIVE.has(r.state)) {
      ai = `${r.state === 'run' ? fixingHtml(r) : ''}${workHtml(r, true)}<div class="chat-run"><span class="spinner"></span>${esc(r.state === 'review' ? S.agents.reviewing : T.memoWorking)}</div>
        <div><button class="btn sm ghost" data-act="cancel" data-round="${r.id}" ${r.stopping ? 'disabled' : ''}>${svg('stop')}${r.stopping ? T.stopping : T.stop}</button></div>`;
    } else {
      const parts = [reviewsHtml(r), continueButton(r)];
      parts.push(workHtml(r, false));
      if (r.summary) parts.push(`<div class="chat-reply">${mdLite(r.summary)}</div>`);
      if (r.handoff) parts.push(handoffHtml(r));
      if (r.error && r.state !== 'cancelled') parts.push(`<div class="chat-box bad"><strong>${T.failed}</strong><span>${esc(roleError(r.error))}</span></div>`);
      const changed = changedOf(r);
      parts.push(filesRow(r, changed ? words('Changed') : words('Unchanged'), changed));
      if (r.memo_diff) parts.push(`<details class="chat-diff"><summary data-tip="${esc(T.memoDiffTip)}">${T.memoDiff}</summary><pre>${diffHtml(r.memo_diff)}</pre></details>`);
      if (r.stray?.length) parts.push(`<div class="chat-box warn"><strong>${words('Stray')}</strong>${fileList(r.stray)}</div>`);
      parts.push(fixesHtml(r), reviewFixesHtml(r));
      if (r.check && changed) parts.push(`<div class="chat-box ${newErrors(r).length ? 'bad' : 'chat-ok'}">${newErrors(r).length ? esc(newErrors(r).map(x => x.text).join('\n')) : T.checkOk}</div>`);
      if (!r.restored) parts.push(`<div class="chat-acts">${retryReviewButton(r)}</div>`);
      parts.push(questionsHtml(r));
      ai = parts.join('');
    }
    return `<div class="chat-round" data-round="${r.id}">${continuationNote(r)}${head}<div class="chat-ai">${ai}</div></div>`;
  }
  // 下書きのチャットの「スライドにして」：スライドのチャットに引き渡した送信（設計書 §8.8）
  function handoffHtml(r) {
    const h = r.handoff;
    if (h.deferred) return `<p class="chat-note">${T.handoffDeferred}</p>`;
    if (!h.round) {
      // 必ずユーザーがボタンで選ぶまで待つ
      const [title, tipText] = h.blocked ? [T.handoffBlocked, T.handoffForce] : h.error ? [T.handoffFail, T.handoffRetry] : [T.handoffPending, T.handoffStart];
      return `<div class="chat-box ${h.blocked || h.error ? 'warn' : 'chat-handoff'}"><strong>${title}</strong>${h.error ? `<span>${esc(h.error)}</span>` : ''}<p>${esc(h.text)}</p>
        <button class="btn sm ghost" data-act="handoff-start" data-round="${r.id}" data-tip="${esc(tipText)}">${svg('presentation')}${T.handoffCreate}</button>
        <button class="btn sm ghost" data-act="handoff-defer" data-round="${r.id}">${T.handoffContinue}</button></div>`;
    }
    const go = h.tab && !h.error ? `<button class="btn sm ghost" data-act="handoff" data-tab="${esc(h.tab)}" data-tip="${esc(T.handoffGo)}" aria-label="${esc(T.handoffGo)}">${svg('presentation')}</button>` : '';
    return `<div class="chat-box ${h.error ? 'bad' : 'chat-handoff'}"><strong>${h.error ? T.handoffFail : T.handoffStarted}</strong>
      ${h.error ? `<span>${esc(h.error)}</span>` : ''}<p>${esc(h.text)}</p>${go}</div>`;
  }
  const diffHtml = text => text.split('\n').map(l => `<span class="${l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''}">${esc(l)}</span>`).join('\n');
  // 作成ボタンが押されたら、スライドの保存待ちを確定してから始める。
  async function startHandoff(r, force = false) {
    if (!await ctx.flush()) { toast(T.saveFirst); return; }
    try {
      Object.assign(r, await api(`${base}/rounds/${r.id}/handoff`, { method: 'POST', body: { base: ctx.version, force } }));
      render();
    } catch (e) { toast(e.message); }
  }
  // 話し合い：ファイルを変えないので、変更・検査・戻すは出さない
  function talkHtml(r) {
    if (ACTIVE.has(r.state)) return `${workHtml(r, true)}<div class="chat-run"><span class="spinner"></span>${T.talkWorking}</div>
        <div><button class="btn sm ghost" data-act="cancel" data-round="${r.id}" ${r.stopping ? 'disabled' : ''}>${svg('stop')}${r.stopping ? T.stopping : T.stop}</button></div>`;
    const parts = [continueButton(r)];
    parts.push(workHtml(r, false));
    if (r.summary) parts.push(`<div class="chat-reply">${mdLite(r.summary)}</div>`);
    if (r.error && r.state !== 'cancelled') parts.push(`<div class="chat-box bad"><strong>${T.failed}</strong><span>${esc(roleError(r.error))}</span></div>`);
    parts.push(questionsHtml(r));
    return parts.join('');
  }
  function roundHtml(r) {
    const model = r.model_name ? `<span class="chat-sent-model">${esc(r.model_name)}${r.effort ? ` · ${esc(T.effortChar[r.effort] || r.effort)}` : ''}</span>` : '';
    if (['memo', 'theme'].includes(r.mode)) return memoRoundHtml(r, model);
    const head = `<div class="chat-sent"><div class="chat-sent-head">${svg(r.talk ? 'messages' : 'send')}${esc(r.talk ? T.talkSent(fmtTime(r.time)) : T.sent(fmtTime(r.time), r.items.length))}${model}</div>
      ${r.items.map((it, i) => `<div class="chat-item">${chip(it.key, it.label)}<span>${esc(it.text)}</span></div>${sentActions(r, i)}`).join('')}
      ${r.attach?.length ? `<div class="chat-attach sent">${r.attach.map(a => attachChip(a, false)).join('')}</div>` : ''}</div>`;
    let ai;
    if (r.talk) ai = talkHtml(r);
    else if (r.state === 'run' || r.state === 'review') {
      ai = `${r.state === 'run' ? fixingHtml(r) : ''}${workHtml(r, true)}<div class="chat-run"><span class="spinner"></span>${esc(r.state === 'review' ? S.agents.reviewing : T.working(r.items.length))}</div>
        <div><button class="btn sm ghost" data-act="cancel" data-round="${r.id}" ${r.stopping ? 'disabled' : ''}>${svg('stop')}${r.stopping ? T.stopping : T.stop}</button></div>`;
    } else if (r.state === 'check') {
      ai = `<div class="chat-run"><span class="spinner"></span>${T.checking}</div>`;
    } else {
      const parts = [reviewsHtml(r), continueButton(r)];
      parts.push(workHtml(r, false));
      if (r.summary) parts.push(`<p class="chat-summary">${esc(r.summary)}</p>`);
      if (r.error && r.state !== 'cancelled') parts.push(`<div class="chat-box bad"><strong>${T.failed}</strong><span>${esc(roleError(r.error))}</span></div>`);
      if (r.results?.length) {
        const mark = (x, i) => x.ok ? ['ok', T.resultOk, '<path d="M20 6 9 17l-5-5"/>']
          : r.questions?.some(q => q.item === i + 1) ? ['ask', T.resultAsk, '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>']
          : ['ng', T.resultNg, '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>'];
        parts.push(`<div class="chat-results">${r.results.map((x, i) => { const [cls, label, path] = mark(x, i); return `<div class="chat-item">${chip(x.key, x.label)}
          <svg class="i ${cls}" viewBox="0 0 24 24" role="img" aria-label="${label}">${path}</svg>
          <span>${esc(x.text)}</span></div>`; }).join('')}</div>`);
      }
      const changed = changedOf(r);
      parts.push(filesRow(r, filesText(r.files), changed));
      parts.push(fixesHtml(r), reviewFixesHtml(r));
      // ファイルが変わっていなければ検査の結果は出さない
      const c = changed ? r.check : null, errs = c ? newErrors(r) : [], old = (c?.errors || []).filter(x => x.old);
      const errorList = list => `${list.slice(0, 8).map(x => `<div class="chat-item">${chip(x.key, x.label)}<span>${esc(x.text)}</span></div>`).join('')}
          ${list.length > 8 ? `<span>${T.more(list.length - 8)}</span>` : ''}`;
      if (c && !errs.length) parts.push(`<div class="chat-ok">${svg('check')}${c.warnings.length ? T.checkWarn(c.warnings.length) : T.checkOk}</div>`);
      if (errs.length) parts.push(`<div class="chat-box bad"><strong>${svg('alert')}${T.checkFail(errs.length)}</strong>${errorList(errs)}</div>`);
      if (old.length) parts.push(`<details class="chat-box warn"><summary>${T.checkOld(old.length)}</summary>${errorList(old)}</details>`);
      const outside = r.restored?.outside || r.files?.outside || [];
      if (outside.length) parts.push(`<div class="chat-box warn"><strong>${T.outside}</strong>${fileList(outside)}</div>`);
      const acts = [];
      if (r.state === 'fail' && errs.length && !r.restored) acts.push(`<button class="btn sm" data-act="retry" data-round="${r.id}">${T.retry}</button>`);
      acts.push(retryReviewButton(r));
      parts.push(`<div class="chat-acts">${acts.join('')}</div>`);
      parts.push(questionsHtml(r));
      ai = parts.join('');
    }
    return `<div class="chat-round" data-round="${r.id}">${continuationNote(r)}${head}<div class="chat-ai">${ai}</div></div>`;
  }

  function renderTabs() {
    const list = openTabs();
    $('.chat-tablist').innerHTML = list.map(t => {
      if (t.auto_name) {
        const first = submitting(t) ? submission.items[0]?.text : draftsOf(t)[0]?.[1];
        t.name = first?.trim().split(/\r?\n/)[0].slice(0, 40) || T.newTab;
      }
      const n = plain() || submitting(t) ? 0 : draftsOf(t).length, sel = t.id === tabId;
      const working = submitting(t) || busy(t.id);
      const awaiting = !working && questionOpen(roundsOf(t.id).at(-1));
      const tabLabel = awaiting ? `${T.showTab(t.name)} · ${T.tabAwaiting}` : T.showTab(t.name);
      const closable = !working && (list.length > 1 || !fresh(t));
      return `<div class="chat-tab${sel ? ' on' : ''}${awaiting ? ' awaiting-answer' : ''}">
        <button role="tab" aria-selected="${sel}" data-act="tab" data-tab="${t.id}" data-tip="${esc(tabLabel)}" aria-label="${esc(tabLabel)}"><span class="chat-tab-name" style="--tab-color:${esc(t.color)}">${esc(t.name)}</span>${n ? `<span class="count">${n}</span>` : ''}</button>
        ${working ? `<span class="chat-tab-status" role="status">${submitting(t) ? T.tabSending : T.busy}</span>` : ''}
        ${closable ? `<button class="x" data-act="close" data-tab="${t.id}" aria-label="${esc(T.closeTab(t.name))}" title="${esc(T.closeTab(t.name))}">${svg('x')}</button>` : ''}</div>`;
    }).join('');
    panel.querySelectorAll('[data-act=hist]').forEach(b => b.setAttribute('aria-expanded', String(histOpen)));
  }
  let historyQuery = "";
  function renderHist() {
    const h = $('.chat-hist');
    h.hidden = !histOpen;
    if (!histOpen) return;
    const focused = h.querySelector('.chat-history-search') === document.activeElement;
    const selection = focused ? h.querySelector('.chat-history-search').selectionStart : null;
    const updated = t => roundsOf(t.id).at(-1)?.time || t.created;
    const query = historyQuery.trim().toLocaleLowerCase();
    const list = (st?.tabs || []).filter(t => !fresh(t)).filter(t => !query ||
      [t.name, ...Object.values(t.drafts || {}).map(draftText),
        ...roundsOf(t.id).flatMap(r => [r.summary, ...(r.items || []).map(i => i.text)])]
        .join('\n').toLocaleLowerCase().includes(query)).sort((a, b) => updated(b) - updated(a));
    h.innerHTML = `<div class="chat-hhead"><span>${T.historyTitle}</span><button class="ibtn" data-act="hist" aria-label="${T.closeHistory}">${svg('x')}</button></div>
      <input class="chat-history-search" type="text" aria-label="${T.searchHistory}" placeholder="${T.searchHistory}" value="${esc(historyQuery)}">
      <div class="chat-history-list">${list.map(t => `<button class="chat-hrow${t.open ? ' is-open' : ''}" data-act="reopen" data-tab="${t.id}">
        ${t.open ? `<span class="dot${busy(t.id) ? ' pulse' : ''}" style="background:${esc(t.color)}" aria-label="${busy(t.id) ? T.busy : T.tabOpen}"></span>` : ''}
        <span class="name">${esc(t.name)}</span><span class="meta">${esc(fmtDay(updated(t)))}</span>
        ${t.open ? `<span class="chat-hstate">${T.tabOpen}</span>` : ''}
      </button>`).join('') || `<p class="empty-note">${T.none}</p>`}</div>`;
    if (focused) {
      const search = h.querySelector('.chat-history-search');
      search.focus(); search.setSelectionRange?.(selection, selection);
    }
  }

  function renderLog() {
    const t = tab();
    const rounds = t ? roundsOf(t.id) : [];
    const box = $('.chat-log-in');
    // 途中経過を開いていたら、作り直しても開いたままにする
    const opened = [...box.querySelectorAll('.chat-round details[open]')].map(d => [d.closest('.chat-round').dataset.round, d.dataset.key]);
    const intro = plain() ? plainText('Intro') : T.intro;
    const waiting = submitting(t) && !rounds.some(r => !submission.rounds.has(r.id));
    const pendingHtml = waiting ? `<div class="chat-round chat-pending"><div class="chat-sent">
      <div class="chat-run" role="status"><span class="spinner" aria-hidden="true"></span>${T.sending}</div>
      ${submission.items.map(it => `<div class="chat-item">${plain() ? '' : chip(it.key, it.label)}<span>${esc(it.text)}</span></div>`).join('')}
      <div class="chat-attach sent">${submission.attach.map(a => attachChip(a, false)).join('')}${submission.pending.map(p => pendingChip(p, false)).join('')}</div>
      </div></div>` : '';
    box.innerHTML = rounds.length || waiting ? rounds.map(roundHtml).join('') + pendingHtml : `<div class="chat-intro">${svg('chat')}${intro.map(x => `<p>${esc(x)}</p>`).join('')}</div>`;
    opened.forEach(([id, key]) => { const d = box.querySelector(`.chat-round[data-round="${id}"] details${key ? `[data-key="${key}"]` : ':not([data-key])'}`); if (d) d.open = true; });
  }
  function renderDrafts() {
    const t = tab(), list = submitting(t) ? [] : draftsOf(t), cur = curKey();
    // 未送信の指示が無いときは何も出さない（仕組みはチャットの説明に書く）
    $('.chat-drafts').innerHTML = !list.length ? '' : `<div class="chat-dhead"><span data-tip="${T.draftsTip}">${T.drafts(list.length)}</span><button class="btn sm ghost" data-act="clear">${T.clearDrafts}</button></div>
      ${list.length ? `<div class="chat-dlist">${list.map(([key, text]) => `<div class="chat-draft${key === cur ? ' on' : ''}">
        <button class="pick" data-act="draft" data-key="${esc(key)}" data-tip="${esc(T.openDraft(labelOf(key)))}" aria-label="${esc(T.openDraft(labelOf(key)))}"><span class="chat-chip${chipCls(key)}">${esc(shortOf(key))}</span>
          <span class="text">${esc(text)}</span>${key === cur ? `<span class="typing">${T.typing}</span>` : ''}</button>
        <button class="x" data-act="rm" data-key="${esc(key)}" aria-label="${T.removeDraft}" title="${T.removeDraft}">${svg('x')}</button></div>`).join('')}</div>`
        : ''}`;
  }
  // コンテキストの円。ツールチップには、アカウントの5時間・1週間の上限の使用率も出す。どちらも分からない AI では出さない
  function renderContext(t) {
    const el = $('.chat-ctx');
    const last = [...roundsOf(t?.id)].reverse().find(r => r.context?.window);
    const c = last?.context || (!started(t) && aiOf(t).m?.context ? { used: 0, window: aiOf(t).m.context } : null);
    const lim = ai?.limits?.[aiOf(t).p?.id];
    const kinds = ['five_hour', 'weekly'].filter(k => lim?.[k]);
    el.hidden = !c && !kinds.length;
    if (el.hidden) return;
    const pct = c ? Math.min(100, Math.round(c.used / c.window * 100)) : 0, R = 7, L = 2 * Math.PI * R;
    el.innerHTML = `<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="${R}" class="bg"/>${c ? `<circle cx="9" cy="9" r="${R}" class="fg" stroke-dasharray="${L * pct / 100} ${L}" transform="rotate(-90 9 9)"/>` : ''}</svg>`;
    el.classList.toggle('high', pct >= 80);
    const now = Date.now(), lines = c ? [T.context(pct, fmtTokens(c.used), fmtTokens(c.window))] : [];
    if (kinds.length) {
      // リセットの時刻を過ぎた上限は 0% に戻っている
      lines.push(kinds.map(k => {
        const w = lim[k], reset = w.resets ? new Date(w.resets * 1000) : null, past = reset && reset <= now;
        return T.limit(k, past ? 0 : w.used, reset && !past ? T.resetAt(reset, reset.toDateString() === new Date(now).toDateString()) : '');
      }).join('\n') + (lim.at && now - lim.at * 1000 > 5 * 60e3 ? `\n${T.limitsAt(Math.round((now - lim.at * 1000) / 60e3))}` : ''));
    }
    tip(el, lines.join('\n\n'));
    el.setAttribute('role', 'img');
  }
  function renderCompose() {
    const t = tab(), cur = curKey();
    const a = aiOf(t);
    $('.chat-notice').innerHTML = ai && t && !a.ok && a.p ? helpHtml(a.p) : '';
    $('.chat-target').innerHTML = `
      <div class="chat-trow"><span class="lbl">${T.target}</span>
        <span class="chat-tlabel${chipCls(cur)}"><span>${esc(labelOf(cur))}</span></span>
        <span class="grow"></span>${toggles(cur)}</div>
      ${isFig(cur) && st?.figure_users?.[cur.slice(4)]?.some(d => d !== ctx.deck) ? `<div class="chat-figure-users">${esc(T.figureUsers(st.figure_users[cur.slice(4)]))}</div>` : ''}`;
    if (submitting(t) || shownKey !== `${t?.id}:${cur}` || document.activeElement !== input) {
      const want = submitting(t) ? '' : draftText(t?.drafts?.[cur]);
      if (input.value !== want) { input.value = want; fit(); }
      shownKey = `${t?.id}:${cur}`;
    }
    const intro = $('.chat-intro');
    if (intro) intro.hidden = !!input.value || draftsOf(t).length > 0;
    $('.chat-target').hidden = plain();
    input.setAttribute('aria-label', plain() ? plainText('Input') : T.input(labelOf(cur)));
    input.placeholder = plain() ? plainText('Placeholder') : talkOf(t) ? T.talkPlaceholder(labelOf(cur)) : T.placeholder(labelOf(cur));
    const talkBtn = $('[data-act=talk]');
    talkBtn.hidden = plain();
    talkBtn.disabled = !t || submitting(t);
    talkBtn.setAttribute('aria-pressed', String(talkOf(t)));
    talkBtn.setAttribute('aria-label', T.talk);
    tip(talkBtn, talkOf(t) ? T.talkOff : T.talkOn);
    input.disabled = !t || submitting(t);
    $('.chat-field > .chat-attach').innerHTML = submitting(t) ? '' : (t?.attach || []).map(x => attachChip(x, true)).join('') + pendingOf(t).map(p => pendingChip(p)).join('');
    $('[data-act=attach]').disabled = !t || submitting(t);
    picker.render({ ai, key: modelKey(t), effort: t?.effort || null, locked: started(t), busy: !t || submitting(t) || busy(t.id),
      contextKey: t?.id || mode, mode, roles: st?.role_modes?.[mode] || [], roleProviders: st?.role_providers || [], roleDefaults: st?.role_defaults || {}, roleSettings: t?.ai_roles || {} });
    renderContext(t);
    const n = draftsOf(t).length, running = t && busy(t.id);
    const b = $('.chat-send');
    const working = submitting(t) || !!running;
    b.innerHTML = working ? '<span class="spinner" aria-hidden="true"></span>' : svg('arrowUp');
    b.setAttribute('aria-busy', String(working));
    b.disabled = !t || running || !n || sending || !!settingSaves || !a.ok;
    const ready = plain() ? T.memoSend : talkOf(t) ? T.talkSend(n) : T.send(n), none = plain() ? T.memoSendNone : T.sendNone;
    const why = settingSaves ? T.savingSettings : sending ? T.sending : running ? T.sendBusy : !ai ? T.sendLoading : !a.ok ? T.sendNoAi(a.p?.name || 'AI') : n ? ready : none;
    tip(b, why, n && a.ok && !running ? '⌘ Enter' : '');
  }
  // ［ページ］は図を選んでいるときだけ出す。説明（tip.js）には、押したときの行き先とそのキーを出す
  function toggles(cur) {
    const fig = selFig(), back = !pageOnly && fig ? 'fig' : 'page';
    const one = (act, label, on, [tipText, keys]) => `<button class="chat-toggle" data-act="${act}" aria-pressed="${on}" aria-label="${esc(tipText)}" data-tip="${esc(tipText)}" data-keys="${keys}">${label}</button>`;
    const to = { fig: [T.toFig, '⌥ 1'], page: [T.toPage, '⌥ 2'], deck: [T.toDeck, '⌥ 3'] };
    return (isFig(cur) && visibleFigureStep(cur) ? one('step', T.stepOnly, stepOnly, [T.toStep, '']) : '')
      + (fig ? one('page', T.page, isPage(cur), isPage(cur) ? to.fig : to.page) : '')
      + (isPage(cur) ? one('fix-page', fixedPage() ? T.pageFixed : T.fixPage, !!fixedPage(), [fixedPage() ? T.unfixPage : T.fixPageTip, '']) : '')
      + one('whole', T.whole, cur === 'deck', cur === 'deck' ? to[back] : to.deck);
  }
  function renderSide() {
    if (!side) return;
    if (mode === 'theme') {
      side.innerHTML = `<button class="chat-pwrite" data-write data-tip="${T.themeInput}">${svg('chat')}${T.themeInput}</button>`;
      return;
    }
    side.textContent = '';
  }
  function renderDots(strip = ctx.root.querySelector('#pagestrip')) {
    if (!strip) return;
    strip.querySelectorAll('button').forEach((b, i) => {
      b.querySelector('.chat-dots')?.remove();
      const p = pages()[ctx.preview.pageOfSlide(i)];
      if (!p) return;
      const key = keyOf(p);
      const dots = slideTabs().map(t => hasDraft(t, key) ? `<span style="background:${esc(t.color)}${t.id === tabId ? `;box-shadow:0 0 0 1.5px #fff,0 0 0 2.5px ${esc(t.color)}` : ''}"></span>`
        : runningKeys(t.id).includes(key) ? `<span class="pulse" style="background:${esc(t.color)}"></span>` : '').join('');
      if (dots) b.insertAdjacentHTML('beforeend', `<span class="chat-dots" aria-hidden="true">${dots}</span>`);
    });
  }
  function render() {
    if (!alive || !st) return;
    const has = !!tab();
    $('.chat-main').hidden = !has;
    panel.classList.toggle('memo-mode', plain());
    $('.chat-mode').innerHTML = `${svg(mode === 'theme' ? 'palette' : 'notebookPen')}<span>${plainText('Mode')}</span>`;
    $('.chat-mode').dataset.tip = plainText('ModeTip');
    $('.chat-mode').hidden = !plain(); $('.chat-drafts').hidden = plain() || submitting(tab());
    renderTabs(); renderHist();
    if (has) { renderLog(); renderDrafts(); renderCompose(); }
    renderSide(); renderDots();
  }
  // 入力のたびに書き直すのは、件数と帯の印だけ（ログは作り直さない）
  function renderTyping() { renderTabs(); renderDrafts(); renderCompose(); renderSide(); renderDots(); }

  // ------------------------------------------------------------ 入力
  input.addEventListener('input', () => {
    const t = tab(); if (!t) return;
    const key = curKey();
    t.drafts = { ...t.drafts, [key]: draftValue(key, input.value, t.drafts?.[key]) };
    if (!input.value.trim()) delete t.drafts[key];
    shownKey = `${t.id}:${key}`;
    saveDrafts(t); renderTyping(); fit();
  });
  input.addEventListener('keydown', e => {
    if (targetKey(e)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  });
  // ⌘Z はスライドと別。チャットの中では、消した指示と入力中の文字だけを戻す
  panel.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
    e.stopPropagation();
    if ((e.target === input || !e.target.closest('input, textarea, select, [contenteditable="true"]')) && stepErase(!e.shiftKey)) e.preventDefault();
  });
  // 消した指示の履歴（タブごと）。消した後に打った文字があれば、先にブラウザの取り消しで戻す
  const erased = new Map();
  const draftSig = drafts => JSON.stringify(Object.entries(drafts || {}).sort());
  function putDrafts(t, drafts) { t.drafts = { ...drafts }; shownKey = null; saveDrafts(t); render(); }
  function erase(t, drafts) {
    const log = erased.get(t.id) || { past: [], future: [] };
    log.past.push({ before: t.drafts, after: drafts }); log.future = [];
    erased.set(t.id, log);
    putDrafts(t, drafts); input.focus();
  }
  function stepErase(back) {
    const t = tab(), log = t && erased.get(t.id);
    if (!log) return false;
    const from = back ? log.past : log.future, to = back ? log.future : log.past;
    const entry = from.at(-1);
    if (!entry || draftSig(t.drafts) !== draftSig(back ? entry.after : entry.before)) return false;
    from.pop(); to.push(entry);
    putDrafts(t, back ? entry.before : entry.after);
    return true;
  }
  panel.addEventListener('input', e => {
    if (e.target.matches('.chat-history-search')) { historyQuery = e.target.value; renderHist(); }
  });
  panel.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el || !st) return;
    const act = el.dataset.act, t = tab();
    const r = el.dataset.round && st.rounds.find(x => x.id === el.dataset.round);
    if (act === 'tab') selectTab(el.dataset.tab);
    else if (act === 'add') addTab();
    else if (act === 'close') {
      const ct = tabs().find(x => x.id === el.dataset.tab);
      if (!ct || submitting(ct) || busy(ct.id)) return;
      const rest = openTabs().find(x => x.id !== ct.id);
      // 最後のタブを閉じたら、新しいタブに入れ替える（タブの無い画面は出さない）
      if (!rest) { if (fresh(ct) || !await addTab()) return; }
      else if (ct.id === tabId) selectTab(rest.id);
      patchTab(ct, { open: false });
    } else if (act === 'hist') { histOpen = !histOpen; render(); }
    else if (act === 'reopen') {
      const ot = st.tabs.find(x => x.id === el.dataset.tab);
      if (ot) {
        histOpen = false;
        if (!ot.open) await patchTab(ot, { open: true });
        if (modeOf(ot) !== mode) { ctx.leftTabs?.show(modeOf(ot) === 'slides' ? 'qmd' : modeOf(ot)); setMode(modeOf(ot)); }
        selectTab(ot.id);
      }
    } else if (act === 'go') goKey(el.dataset.key);
    else if (act === 'draft') {
      const key = el.dataset.key;
      if (uncertain(t, key)) { chooseDraftTarget(t, key); return; }
      if (key === 'deck') setPin('deck');
      else { pageOnly = isPage(key); setPin(null); goKey(key); }
      input.focus();
    } else if (act === 'rm' && t) { const d = { ...t.drafts }; delete d[el.dataset.key]; erase(t, d); }
    else if (act === 'clear' && t) erase(t, {});
    else if (act === 'fix-page') toggleFixedPage();
    else if (act === 'whole') toggle('deck');
    else if (act === 'page') toggle('page');
    else if (act === 'step') { stepOnly = !stepOnly; render(); }
    else if (act === 'send') send();
    else if (act === 'attach') $('.chat-file').click();
    else if (act === 'talk') { const t = tab(); if (t) { if (talks[t.id]) delete talks[t.id]; else talks[t.id] = true; store('talk', talks); renderCompose(); } }
    else if (act === 'unattach' && t && el.dataset.pending) { dropPending(t, el.dataset.pending); render(); }
    else if (act === 'unattach' && t) patchTab(t, { attach: (t.attach || []).filter(x => x.path !== el.dataset.path) });
    else if (act === 'copy-message' && r) {
      try { await navigator.clipboard.writeText(r.items[+el.dataset.item].text); toast(S.copied); }
      catch {
        const field = document.createElement('textarea');
        field.readOnly = true; field.value = r.items[+el.dataset.item].text;
        field.setAttribute('aria-label', S.copyManual);
        el.closest('.chat-message-actions').append(field);
        field.focus(); field.select(); toast(S.copyFailed);
      }
    }
    else if (act === 'edit-message' && r) editMessage(r, +el.dataset.item);
    else if (act === 'cancel' && r) cancel(r);
    else if (act === 'restore' && r) restore(r);
    else if (act === 'continue-model' && r) { selectTab(r.tab); continueId = r.id; render(); picker.open('models', interruptedReview(r) ? 'review' : null); }
    else if (act === 'continue-send' && r) continueRound(r);
    else if (act === 'retry' && r) retry(r);
    else if (act === 'retry-review' && r) retryReview(r);
    else if (act === 'answer' && r) pickAnswer(r, +el.dataset.q, +el.dataset.o);
    else if (act === 'answer-send' && r) sendAnswers(r);
    else if (act === 'answer-other' && r) { if (!plain()) goKey((r.items[r.questions[+el.dataset.q].item - 1] || r.items[0]).key); input.focus(); }
    else if (act === 'handoff-defer' && r) {
      try {
        Object.assign(r, await api(`${base}/rounds/${r.id}/handoff`, { method: 'POST', body: { defer: true } }));
        render(); input.focus();
      } catch (e) { toast(e.message); }
    }
    else if (act === 'handoff-start' && r) startHandoff(r, !!r.handoff?.blocked);
    else if (act === 'handoff') {
      const ht = allTabs().find(x => x.id === el.dataset.tab);
      if (!ht) return;
      ctx.leftTabs?.show('qmd'); setMode('slides');
      if (!ht.open) patchTab(ht, { open: true });
      selectTab(ht.id);
    }
  });
  // 「確かめ直す」は使えない AI の案内（入力欄の上・モデルの一覧）にある
  panel.addEventListener('input', e => {
    if (e.target.matches('.chat-history-search')) { historyQuery = e.target.value; renderHist(); }
  });
  panel.addEventListener('click', async e => {
    const login = e.target.closest('.chat-notice [data-mact=login]');
    if (login) { await loginAi(login.dataset.id, () => loadAi(true)); return; }
    const b = e.target.closest('.chat-notice [data-mact=recheck]'); if (!b) return;
    b.disabled = true; b.lastChild.textContent = T.rechecking; await loadAi(true);
  });
  $('.chat-file').addEventListener('change', e => { attach(e.target.files); e.target.value = ''; });
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); attach(files); }
  });
  const field = $('.chat-field');
  field.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); field.classList.add('drop'); } });
  field.addEventListener('dragleave', e => { if (!field.contains(e.relatedTarget)) field.classList.remove('drop'); });
  field.addEventListener('drop', e => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); field.classList.remove('drop'); attach(e.dataTransfer.files); });
  side?.addEventListener('click', e => {
    if (e.target.closest('[data-write]')) {
      if (mode === 'theme') {
        if (document.body.classList.contains('chat-off')) ctx.root.querySelector('#chatToggle')?.click();
        input.focus(); return;
      }
      // チャットを開いて、このページへの指示を書く
      if (plain()) ctx.leftTabs?.show('qmd');
      if (document.body.classList.contains('chat-off')) ctx.root.querySelector('#chatToggle')?.click();
      pageOnly = true; setPin(null); input.focus(); return;
    }
    const b = e.target.closest('[data-tab]'); if (!b || !st) return;
    if (plain()) ctx.leftTabs?.show('qmd'); // スライドのタブなので、原稿に戻してスライドのチャットにする
    const t = tabs().find(x => x.id === b.dataset.tab);
    if (t) { if (!t.open) patchTab(t, { open: true }); selectTab(t.id); }
  });

  const off = onEvent(ev => {
    if (alive && ev.type === 'files') { load(); return; }
    if (alive && ev.type === 'ai-limits' && ai) { ai.limits = ev.limits; renderContext(tab()); return; }
    if (!alive || ev.deck !== deck || !st) return;
    if (ev.type === 'chat') applyState(ev.state);
    if (ev.type === 'chat-round') {
      const i = st.rounds.findIndex(x => x.id === ev.round.id);
      if (i >= 0) st.rounds[i] = { ...ev.round, stopping: st.rounds[i].stopping && ev.round.state === 'run' };
      else st.rounds.push(ev.round);
      setLock(ev.locked, ev.lock);
      render();
    }
  });
  load(true); loadAi();

  return {
    setMode,
    slideChanged() {
      if (figurePage !== viewKey()) {
        lastFig = null; figurePage = null; figureBlock = null;
        pageOnly = false; stepOnly = false;
      }
      render();
    },
    // スライドで別の図を選んだら、その図への指示にする（［全体］を押していても）
    blockSelected() {
      if (fixedPage()) return;
      const ref = ctx.blocks?.figure;
      if (!ref) return;
      const f = 'fig:' + ref;
      const same = f === selFig() && figureBlock === ctx.blocks.selected;
      figurePage = viewKey(); figureBlock = ctx.blocks.selected;
      if (same) return;
      lastFig = f; pageOnly = false; stepOnly = false;
      if (f && tab() && pinOf()) { delete pins[tab().id]; store('pins', pins); }
      render();
    },
    keydown: targetKey,
    // 素材の画面などから、発表全体への未送信の指示を足す（送るのは利用者）
    draft(text) {
      const t = tab(); if (!t || plain()) { toast(T.noTab); return false; }
      t.drafts = { ...t.drafts, deck: t.drafts?.deck?.trim() ? `${t.drafts.deck}\n${text}` : text };
      if (document.body.classList.contains('chat-off')) ctx.root.querySelector('#chatToggle')?.click();
      setPin('deck'); saveDrafts(t); render();
      return true;
    },
    stripRendered(strip) { renderDots(strip); },
    rendered() { render(); },
    destroy() {
      alive = false; off(); dialog?.remove(); picker.destroy();
      for (const t of allTabs()) if (timers[t.id]) { clearTimeout(timers[t.id]); api(`${base}/tabs/${t.id}`, { method: 'PATCH', body: { drafts: t.drafts } }).catch(() => {}); }
      if (side) side.textContent = '';
    },
  };
}
