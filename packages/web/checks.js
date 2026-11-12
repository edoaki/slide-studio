// 保存後の検査の状態と、問題があるページ・step の案内（設計書 §9.4）。
import { api, esc } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';

export function makeChecks(ctx) {
  let state = {}, alive = true, received = false;
  const strip = ctx.root.querySelector('#pagestrip');
  const nextIssue = new Map();
  const issues = () => [...(state.result?.errors || []), ...(state.result?.warnings || [])];
  function clear() { ctx.preview.client?.request('edit.issues', {rects:[],level:'warning'}).catch(() => {}); }
  // 問題のページ・step を開き、場所を枠（エラーは赤・警告は黄）で囲む（場所が無ければ撮った画像を出す）。
  // 書き出しの一覧から開くときは、その検査の結果を result で渡す
  async function show(x, result = state.result) {
    if (x.citation_key) { await ctx.bibliography?.open(x.citation_key); return; }
    if (x.source_offset != null) {
      if (result?.version?.qmd !== ctx.version || ctx.dirty || result === state.result && state.stale) return;
      if (x.slide != null) await ctx.preview.go(x.slide, x.step || 0);
      ctx.showSourceIssue?.(x);
      return;
    }
    await ctx.preview.go(x.slide, x.step || 0);
    if (!alive || result?.version?.qmd !== ctx.version || result === state.result && state.stale) return;
    clear();
    await ctx.preview.client?.request('edit.issues', {rects:x.rects || [],level:x.level === 'error' ? 'error' : 'warning'});
    if (x.image && !x.rects?.length) {
      const img = document.createElement('img'); img.className = 'check-issue-image'; img.alt = x.message;
      img.src = `/files/.slide-studio/build/${encodeURIComponent(ctx.deck)}/${x.image}?v=${result.checked_at}`;
      const back = document.createElement('div'); back.className = 'dialog-back';
      const box = document.createElement('div'); box.className = 'dialog';
      const close = tip(Object.assign(document.createElement('button'), {className: 'ibtn', innerHTML: svg('x')}), S.close);
      close.onclick = () => back.remove(); box.append(img, close); back.append(box); document.body.append(back);
    }
  }
  ctx.showIssue = show;
  // 上のバーの検査の状態を押すと、問題の一覧を出す（ページの無い問題も読めるように）。ページのある問題は押すとそこへ
  let dialog = null;
  function list() {
    dialog?.remove();
    const result = state.result;
    dialog = document.createElement('div'); dialog.className = 'dialog-back';
    dialog.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${S.checks.title}">
      <div class="dh"><h3>${S.checks.title}</h3></div><div class="output-body"></div><div class="df"></div></div>`;
    renderIssues(dialog.querySelector('.output-body'), issues(), x => { dialog?.remove(); dialog = null; show(x, result); });
    const close = tip(Object.assign(document.createElement('button'), {className: 'ibtn', innerHTML: svg('x')}), S.close);
    close.onclick = () => { dialog?.remove(); dialog = null; };
    dialog.querySelector('.df').append(close);
    dialog.addEventListener('click', e => { if (e.target === dialog) close.onclick(); });
    dialog.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close.onclick(); } });
    document.body.append(dialog);
    (dialog.querySelector('.issue-link') || close).focus();
  }
  function mark() {
    strip.querySelectorAll('.check-mark').forEach(n => n.remove());
    if (state.stale || state.result?.version?.qmd !== ctx.version) return;
    strip.querySelectorAll('button[data-index]').forEach(b => {
      const xs = issues().filter(x => x.slide === +b.dataset.index);
      if (!xs.length) return;
      const flag = document.createElement('span');
      flag.className = `check-mark ${xs.some(x => x.level === 'error') ? 'error' : 'warning'}`;
      flag.tabIndex = 0; flag.setAttribute('role', 'button');
      tip(flag, xs.map(x => x.message).join('\n'));
      const open = e => {
        e.preventDefault(); e.stopPropagation();
        const i = +b.dataset.index, at = nextIssue.get(i) || 0;
        nextIssue.set(i, at + 1); show(xs[at % xs.length]);
      };
      flag.addEventListener('click', open);
      flag.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(e); });
      b.append(flag);
    });
  }
  function update(ev) {
    state = {...state, ...ev};
    if (ev.stale || ev.result) clear();
    if (ev.result) nextIssue.clear();
    const stale = state.stale || (state.result && state.result.version.qmd !== ctx.version);
    ctx.checkStatus = state.busy ? [S.checks.busy, 'busy'] : stale ? [S.checks.stale, 'busy'] : state.result ?
      [state.result.errors.length || state.result.warnings.length ? S.checks.count(state.result.errors.length, state.result.warnings.length) : S.checks.ok, state.result.errors.length ? 'error' : 'ok',
        issues().length ? list : null] : null;
    ctx.showStatus(); mark();
  }
  api(`/api/deck/${encodeURIComponent(ctx.deck)}/checks`).then(d => { if (alive && !received) update(d); }).catch(() => {});
  return {
    event(ev) {
      if (ev.type === 'checks') { received = true; update(ev); }
      if (ev.type === 'render-start' && (state.result || state.busy)) { received = true; update({stale: true}); }
    },
    stripRendered: mark,
    slideChanged: clear,
    destroy() { alive = false; clear(); dialog?.remove(); strip.querySelectorAll('.check-mark').forEach(n => n.remove()); document.querySelectorAll('.check-issue-image').forEach(n => n.closest('.dialog-back')?.remove()); },
  };
}

// 検査の問題の一覧（上のバーの検査の状態・書き出しの両方で使う）。エラーを先に、ページの順に並べる。
// ページのある問題はボタンにして、押すと open(問題) を呼ぶ
export function issueMessage(x) {
  return x.kind === 'duplicate-attribute' ? S.checks.duplicateAttribute(x.attribute, x.value, x.source_line) : x.message;
}

export function renderIssues(body, xs, open) {
  const order = x => [x.level === 'error' ? 0 : 1, x.slide ?? Infinity, x.step || 0];
  const sorted = [...xs].sort((a, b) => { const p = order(a), q = order(b); return p[0] - q[0] || p[1] - q[1] || p[2] - q[2]; });
  const ul = document.createElement('ul'); ul.className = 'issue-list';
  ul.innerHTML = sorted.map((x, i) => {
    const steps = x.steps || (x.step != null ? [x.step] : []);
    const at = steps.length ? ` · ${steps.length > 1 ? `${steps[0] + 1}〜${steps.at(-1) + 1}` : steps[0] + 1}` : '';
    const where = x.page_id ? `${esc(x.page_id)}${at}：` : x.slide != null ? `${S.checks.page(x.slide + 1)}${at}：` : '';
    const level = x.level === 'error' ? 'error' : 'warning';
    const text = `<span class="issue-level ${level}">${S.checks.level[level]}</span>${where}${esc(issueMessage(x))}`;
    return `<li>${x.slide != null || x.citation_key || x.source_offset != null ? `<button type="button" class="issue-link" data-i="${i}">${text}</button>` : text}</li>`;
  }).join('');
  ul.querySelectorAll('.issue-link').forEach(b => { const x = sorted[+b.dataset.i]; tip(b, x.citation_key ? S.topic.bibOpen : x.source_offset != null ? S.checks.openSource : S.checks.open); b.onclick = () => open(x); });
  body.append(ul);
}
