// 下書き（左の欄の［下書き］タブ。設計書 §10.7）。decks/<発表>/memo.md を項目別の入力欄で編集する。
// - 保存は原稿と同じく版（sha256）を合わせる。外で変わったら読み直し、書きかけがあれば競合として知らせる
// - このタブが見えている間、チャットは下書きのチャットになる（chat.js の setMode）
// - 下書きのチャットの AI が書いている間は編集しない
import { api, onEvent, toast } from './api.js';
import { S } from './strings.js';
import { leftTabs } from './left-tabs.js';
import { svg } from './icons.js';
import { tip } from './tip.js';
import { copyWithFallback } from './clipboard.js';

const M = S.memo;
const SAVE_DELAY = 400;

export function makeMemo(ctx) {
  const deck = ctx.deck, url = `/api/deck/${encodeURIComponent(deck)}/memo`, file = `decks/${deck}/memo.md`;
  const panel = ctx.root.querySelector('#editor');
  let alive = true, version = null, saved = '', timer = 0, saving = null, conflict = false, locked = false, failed = false;

  const view = document.createElement('div');
  view.className = 'memo-view'; view.setAttribute('role', 'tabpanel'); view.setAttribute('aria-label', S.tabMemo);
  view.innerHTML = `<div class="memo-banner"></div>
    <textarea class="memo-input" spellcheck="false" aria-label="${M.input}"></textarea>
    <div class="memo-foot"><span class="where"></span><span class="grow"></span><span class="state" aria-live="polite"></span></div>`;
  const fields = document.createElement('div');
  fields.className = 'memo-fields';
  fields.innerHTML = `
    <label class="memo-field"><span>${M.audience} <b class="memo-required">${M.required}</b></span><input class="memo-audience" required placeholder="${M.audiencePlaceholder}"></label>
    <label class="memo-field"><span>${M.duration} <b class="memo-required">${M.required}</b></span><input class="memo-duration" required placeholder="${M.durationPlaceholder}"></label>
    <p class="memo-missing" aria-live="polite"></p>
    <label class="memo-field"><span>${M.conclusion}</span><textarea class="memo-conclusion" rows="2" placeholder="${M.conclusionPlaceholder}"></textarea></label>`;
  view.querySelector('.memo-banner').after(fields);
  const bodyLabel = document.createElement('label');
  bodyLabel.className = 'memo-body-label'; bodyLabel.htmlFor = 'memo-body'; bodyLabel.textContent = M.body;
  const bodyHead = document.createElement('div');
  bodyHead.className = 'memo-body-head';
  const reflect = document.createElement('button');
  reflect.type = 'button'; reflect.className = 'ibtn memo-reflect'; reflect.hidden = true;
  reflect.innerHTML = `${svg('slide')}${svg('arrowRight')}${svg('notebookPen')}`; reflect.setAttribute('aria-label', M.reflect); tip(reflect, M.reflect);
  const actions = document.createElement('div');
  actions.className = 'memo-body-actions'; actions.append(reflect);
  bodyHead.append(bodyLabel, actions);
  view.querySelector('.memo-input').before(bodyHead);
  view.querySelector('.memo-input').id = 'memo-body';
  panel.querySelector('#qscroll').after(view);
  const input = view.querySelector('.memo-input');
  input.placeholder = M.placeholder;
  // 本文内にスクロールを作らず、上の項目と一緒に欄全体をスクロールする。
  function fitBody() {
    if (!input.clientWidth) return;
    const top = view.scrollTop;
    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
    view.scrollTop = top;
  }
  const resize = new ResizeObserver(fitBody);
  resize.observe(view);
  input.addEventListener('input', fitBody);
  const audience = view.querySelector('.memo-audience'), duration = view.querySelector('.memo-duration'), conclusion = view.querySelector('.memo-conclusion');
  const controls = [audience, duration, conclusion, input];
  let displayed = '', original = '', headerFields = [];
  const compose = () => {
    const values = { audience: `- 対象読者：${audience.value}`, duration: `- 発表時間：${duration.value}`,
      conclusion: `- 伝えたい結論：${conclusion.value.replace(/\n/g, '\n  ')}` };
    const order = [...headerFields, ...Object.keys(values).filter(key => !headerFields.some(field => field.key === key)).map(key => ({ key }))];
    return `# スライド案\n\n${order.map(field => field.lines ? field.lines.join('\n') : values[field.key]).join('\n')}\n\n${input.value}`;
  };
  // 読み込んだだけでは既存の Markdown を書き換えない。
  const current = () => compose() === displayed ? original : compose();
  function read(text) {
    audience.value = duration.value = conclusion.value = '';
    headerFields = [];
    const lines = text.split('\n'), body = [];
    let header = true, continued = false, hidden = null;
    for (const line of lines) {
      if (/^##\s/.test(line)) header = false;
      if (header && /^# スライド案\s*$/.test(line)) continue;
      const match = header && line.match(/^[-*] (対象読者|想定発表時間|発表時間|伝えたい結論|公開してよい範囲|公開範囲)[：:]\s*(.*)$/);
      if (match) {
        hidden = null;
        continued = match[1] === '伝えたい結論';
        if (match[1] === '対象読者') { audience.value = match[2]; headerFields.push({ key: 'audience' }); }
        else if (['想定発表時間', '発表時間'].includes(match[1])) { duration.value = match[2]; headerFields.push({ key: 'duration' }); }
        else if (continued) { conclusion.value = match[2]; headerFields.push({ key: 'conclusion' }); }
        else { hidden = { lines: [line] }; headerFields.push(hidden); }
      } else if (hidden && /^[ \t]+/.test(line)) hidden.lines.push(line);
      else if (continued && /^  /.test(line)) conclusion.value += '\n' + line.slice(2);
      else { continued = false; hidden = null; body.push(line); }
    }
    // AI・外の変更で読み直しても、カーソル・選択と見ていた位置は保つ（値を入れ直すとカーソルが末尾へ飛ぶ）
    const { selectionStart: from, selectionEnd: to, scrollTop } = input;
    input.value = body.join('\n').replace(/^\n+/, '');
    input.setSelectionRange(Math.min(from, input.value.length), Math.min(to, input.value.length));
    input.scrollTop = scrollTop;
    fitBody();
    original = text; displayed = compose();
  }
  view.querySelector('.where').textContent = file;

  const chat = () => ctx.plugins.find(p => p.setMode);
  const side = leftTabs(ctx);
  // チャットは下書きが見えているときだけ下書きのチャットにする（欄を閉じればスライドのチャット）
  const sync = () => chat()?.setMode(side.shown('memo') ? 'memo' : side.shown('theme') ? 'theme' : 'slides');
  side.add('memo', 'notebookPen', S.tabMemo, (on, how) => { sync(); if (on) checkSlides(); if (on && !how?.key) setTimeout(() => input.focus(), 0); }, { first: true });

  function showState() {
    const el = view.querySelector('.state');
    el.textContent = locked ? M.locked : failed ? M.error : saving ? M.saving : timer || current() !== saved ? M.pending : version ? M.saved : '';
    el.dataset.tone = locked ? 'ai' : failed || conflict ? 'error' : timer || saving ? 'busy' : 'ok';
    panel.classList.toggle('memo-locked', !!locked);
    controls.forEach(control => { control.readOnly = locked || conflict; });
    reflect.disabled = locked || conflict;
    // 見出しだけ・空の下書きからはスライドを作らない
    view.querySelector('.memo-missing').textContent = !audience.value.trim() || !duration.value.trim() ? M.missing : '';
    [audience, duration].forEach(control => control.setAttribute('aria-invalid', String(!control.value.trim())));
  }
  function apply(d) {
    version = d.version; saved = d.text;
    if (current() !== d.text) read(d.text);
    showState();
  }
  async function load() {
    try { const d = await api(url); if (!alive) return; locked = d.locked; reflect.hidden = !d.slides_body; apply(d); } catch (e) { toast(e.message); }
  }
  // 反映できる中身がスライドにあるときだけボタンを出す
  async function checkSlides() {
    try { const d = await api(url); if (alive) reflect.hidden = !d.slides_body; } catch { /* 次の変更で確かめる */ }
  }
  // 入力として置き換える（⌘Z で元の文に戻せる）。戻したときも input で保存される
  function replaceBody(text) {
    const top = view.scrollTop;
    input.focus(); input.select();
    if (!document.execCommand('insertText', false, text)) { input.value = text; input.dispatchEvent(new Event('input')); }
    input.setSelectionRange(0, 0);
    view.scrollTop = top;
  }
  reflect.onclick = async () => {
    if (!await ctx.flush()) { toast(M.reflectSaveFirst); return; }
    try {
      const d = await api(url);
      if (!alive) return;
      reflect.hidden = !d.slides_body;
      if (d.slides_body && d.slides_body !== input.value && !locked && !conflict) replaceBody(d.slides_body);
    } catch (e) { toast(e.message); }
  };
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; save(); }, SAVE_DELAY);
    showState();
  }
  async function save() {
    if (saving) { await saving; }
    if (conflict || locked || version == null || current() === saved) { showState(); return; }
    const text = current();
    saving = (async () => {
      try {
        const r = await api(url, { method: 'PUT', body: { text, base: version } });
        version = r.version; saved = text; failed = false;
      } catch (e) {
        if (e.status === 409) showConflict();
        else if (e.status === 423) locked = true;
        else { failed = true; toast(e.message); }
      }
    })();
    showState();
    await saving; saving = null;
    if (alive && current() !== saved && !conflict && !locked && !timer) schedule();
    showState();
  }
  // 保存待ちを直ちに保存し、版が一致したら true（下書きのチャットで送る前に使う）
  async function flush() {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (saving) await saving;
    if (current() !== saved) await save();
    return !conflict && !failed && current() === saved;
  }
  function showConflict() {
    conflict = true;
    const b = view.querySelector('.memo-banner');
    b.innerHTML = `<div class="banner"><div>${M.conflict}</div><div class="row"><button class="btn sm primary" data-act="reload">${M.reload}</button><button class="ibtn" data-act="discard">${svg('trash')}</button></div></div>`;
    const reload = async () => {
      try {
        const d = await api(url);
        if (!alive) return;
        conflict = false; b.textContent = ''; locked = d.locked;
        apply(d);
      } catch (e) { toast(e.message); }
    };
    tip(b.querySelector('[data-act=discard]'), M.discard).onclick = reload;
    b.querySelector('[data-act=reload]').onclick = async () => {
      if (!await copyWithFallback(current(), b)) return;
      await reload();
    };
    showState();
  }
  // AI・外のエディタ・［この送信の前に戻す］で変わった
  async function external() {
    if (conflict) return;
    try {
      const d = await api(url);
      if (!alive) return;
      locked = d.locked;
      if (d.version === version) { showState(); return; }
      if (timer || saving || current() !== saved) { if (d.text !== current()) showConflict(); else apply(d); return; }
      apply(d);
    } catch { /* 次の変更で読み直す */ }
  }

  controls.forEach(control => {
    control.addEventListener('input', () => { failed = false; schedule(); });
    control.addEventListener('blur', () => { if (timer) { clearTimeout(timer); timer = 0; save(); } });
  });
  const off = onEvent(ev => {
    if (!alive || ev.deck && ev.deck !== deck) return;
    if (ev.type === 'files' && ev.paths.includes(file)) external();
    if (ev.type === 'files' && ev.paths.includes(`decks/${deck}/slides.qmd`)) checkSlides();
    const lock = ev.type === 'chat' ? ev.state.memo_locked : ev.type === 'chat-round' ? ev.memo_locked : undefined;
    if (lock !== undefined && lock !== locked) { locked = lock; if (!locked) external(); showState(); }
  });
  load();

  ctx.memo = { flush, get version() { return version; } };
  return {
    flush,
    // 原稿の欄を開閉したら、チャットを合わせる
    editorToggled: sync,
    destroy() { alive = false; resize.disconnect(); off(); if (timer) { clearTimeout(timer); save(); } },
  };
}
