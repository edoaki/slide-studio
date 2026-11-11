// 書き出し前に全体を検査。エラー一覧を確認してから、そのまま書き出すこともできる。
import { api, esc, onEvent } from './api.js';
import { renderIssues } from './checks.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';

export function makeOutput(ctx) {
  const bar = ctx.root.querySelector('#barExtra');
  const button = tip(Object.assign(document.createElement('button'), {className: 'btn primary', innerHTML: svg('download')}), S.build, 'P');
  button.dataset.tip = S.buildTip;
  button.setAttribute('aria-keyshortcuts', 'P');
  button.dataset.output = 'build'; bar.append(button);
  let dialog = null, busy = false, alive = true;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  function dismiss() {
    if (busy) return;
    dialog?.remove(); dialog = null;
    button.setAttribute('aria-expanded', 'false');
  }
  function position() {
    if (!dialog) return;
    const rect = button.getBoundingClientRect();
    dialog.style.left = `${Math.max(8, Math.min(rect.right - dialog.offsetWidth, innerWidth - dialog.offsetWidth - 8))}px`;
    dialog.style.top = `${rect.bottom + 6}px`;
    dialog.style.maxHeight = `${Math.max(100, innerHeight - rect.bottom - 14)}px`;
  }
  const outside = e => { if (dialog && !dialog.contains(e.target) && !button.contains(e.target)) dismiss(); };
  const escape = e => {
    if (dialog && e.key === 'Escape' && !busy) { e.stopPropagation(); dismiss(); button.focus(); }
  };
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);
  window.addEventListener('resize', position);
  button.onclick = () => {
    if (busy) return;
    if (dialog) { dismiss(); return; }
    dialog = document.createElement('div'); dialog.className = 'output-popover';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', S.build);
    dialog.innerHTML = `<div class="output-actions">
      <button class="btn" data-format="html">${svg('download')}${S.buildHtml}</button>
      <button class="btn" data-format="pdf">${svg('download')}${S.buildPdf}</button>
      </div><div class="output-body" role="status"></div><div class="output-footer"></div>`;
    document.body.append(dialog);
    button.setAttribute('aria-expanded', 'true');
    const body = dialog.querySelector('.output-body'), footer = dialog.querySelector('.output-footer');
    const close = tip(Object.assign(document.createElement('button'), {className: 'ibtn', innerHTML: svg('x')}), S.close);
    close.onclick = () => { dismiss(); button.focus(); }; dialog.querySelector('.output-actions').append(close);
    const choices = [...dialog.querySelectorAll('[data-format]')];
    let format = 'html';
    for (const choice of choices) choice.onclick = () => { format = choice.dataset.format; run(); };
    position();
    async function run(force = false) {
      busy = true; button.disabled = close.disabled = true;
      body.classList.remove('error');
      choices.forEach(choice => { choice.disabled = true; });
      body.innerHTML = `<p>${S.buildPreparing}</p><progress class="output-progress" max="100" aria-label="${S.buildProgress}"></progress>`;
      const progress = body.querySelector('progress'), id = crypto.randomUUID();
      const off = onEvent(ev => {
        if (ev.type !== 'export-progress' || ev.deck !== ctx.deck || ev.id !== id) return;
        body.querySelector('p').textContent = ev.phase === 'check' ? S.buildChecking : S.buildBusy;
        if (Number.isFinite(ev.value)) progress.value = Math.max(progress.value, ev.value);
        else progress.removeAttribute('value');
      });
      footer.querySelector('[data-force]')?.remove();
      try {
        if (!await ctx.flush()) throw new Error(S.saveFirst);
        const result = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/build`, {method: 'POST', body: {base: ctx.version, force, format, id}});
        if (!alive) return;
        if (result.blocked) {
          body.innerHTML = `<p class="error">${S.checks.blocked}</p>`;
          // 問題を押すと、書き出しを閉じてそのページへ
          renderIssues(body, [...result.result.errors, ...result.result.warnings],
            x => { dismiss(); ctx.showIssue?.(x, result.result); });
          // 描画そのものに失敗した場合は続行できない。
          if (!result.result.errors.some(x => x.kind === 'pandoc')) {
            const proceed = tip(Object.assign(document.createElement('button'), {className: 'btn primary', innerHTML: svg('download')}), S.checks.proceed);
            proceed.dataset.force = 'true'; proceed.onclick = () => run(true); footer.prepend(proceed);
          }
          return;
        }
        body.innerHTML = `<p class="done">${svg('check')}${S.buildDone}</p><div class="downloads">${result.files.map(f => `<a class="btn" href="${esc(f.url)}" download="${esc(f.name)}">${svg('download')}${esc(f.name)}</a>`).join('')}</div>`;
        body.querySelector('.downloads a')?.click();
      } catch (err) { if (alive) { body.textContent = err.message; body.classList.add('error'); } }
      finally {
        off();
        busy = false; close.disabled = button.disabled = false;
        choices.forEach(choice => { choice.disabled = false; });
        if (alive) close.focus();
      }
    }
    choices[0].focus();
  };
  function shortcut(e) {
    if (e.key.toLowerCase() !== 'p' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat && !busy && !dialog) button.click();
    return true;
  }
  return { keydown: shortcut, destroy() {
    alive = false; dialog?.remove(); button.remove();
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', escape);
    window.removeEventListener('resize', position);
  } };
}
