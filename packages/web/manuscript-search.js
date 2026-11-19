import { S } from './strings.js';
import { svg } from './icons.js';
import { toast } from './api.js';
import { manuscriptMatches, replaceManuscriptMatches } from './manuscript-search-model.js';

export function makeManuscriptSearch(ctx) {
  const t = S.manuscriptSearch;
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'ibtn'; toggle.innerHTML = svg('textSearch');
  toggle.dataset.tip = t.title; toggle.setAttribute('aria-label', t.title); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-haspopup', 'dialog'); toggle.setAttribute('aria-controls', 'manuscriptSearch');
  ctx.root.querySelector('#foldToggle').before(toggle);
  const panel = document.createElement('section'); panel.className = 'manuscript-search'; panel.hidden = true;
  panel.id = 'manuscriptSearch'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', t.title);
  panel.innerHTML = `<div class="search-row"><input class="search-query" type="search"><button class="btn sm" data-act="prev">↑</button><button class="btn sm" data-act="next">↓</button><button class="btn sm" data-act="close">×</button></div><div class="search-row"><input class="search-replacement" type="text"><button class="btn sm" data-act="replace"></button><button class="btn sm" data-act="all"></button></div><label class="search-case"><input type="checkbox"> <span></span></label><div class="search-count" role="status" aria-live="polite"></div><div class="search-results"></div>`;
  ctx.root.append(panel);
  const query = panel.querySelector('.search-query'), replacement = panel.querySelector('.search-replacement'), sensitive = panel.querySelector('[type=checkbox]');
  const results = panel.querySelector('.search-results'), count = panel.querySelector('.search-count');
  const button = act => panel.querySelector(`[data-act=${act}]`);
  query.placeholder = t.query; query.setAttribute('aria-label', t.query);
  replacement.placeholder = t.replacement; replacement.setAttribute('aria-label', t.replacement);
  panel.querySelector('.search-case span').textContent = t.caseSensitive;
  for (const act of ['prev', 'next', 'close', 'replace', 'all']) { button(act).setAttribute('aria-label', t[act]); button(act).title = t[act]; }
  for (const [act, icon] of Object.entries({prev:'arrowUp',next:'arrowDown',close:'x',replace:'replaceText',all:'replaceAll'})) { button(act).className = 'ibtn'; button(act).innerHTML = svg(icon); button(act).dataset.tip = t[act]; button(act).removeAttribute('title'); }
  let matches = [], active = -1, busy = false;
  const locked = () => ctx.allLocked || ctx.locked || ctx.conflict || ctx.lock?.pages?.length || ctx.lock?.figures?.length || ctx.presenting;
  function status() {
    button('replace').disabled = button('all').disabled = busy || !!locked() || !matches.length;
    button('prev').disabled = button('next').disabled = !matches.length;
  }
  function draw() {
    count.textContent = query.value ? t.count(active + 1, matches.length) : t.prompt;
    results.replaceChildren();
    const from = Math.max(0, active - 100), to = Math.min(matches.length, from + 200);
    for (let i = from; i < to; i++) {
      const m = matches[i], b = document.createElement('button'); b.type = 'button'; b.className = 'search-result';
      b.setAttribute('aria-current', String(i === active));
      const label = document.createElement('span'); label.className = 'search-page'; label.textContent = m.page < 0 ? t.front : t.page(m.page + 1, m.title);
      const excerpt = document.createElement('span'), mark = document.createElement('mark'); mark.textContent = m.value;
      excerpt.append(m.before, mark, m.after); b.append(label, excerpt); b.onclick = () => visit(i); results.append(b);
    }
    status();
  }
  function refresh(at = matches[active]?.start ?? 0) {
    matches = manuscriptMatches(ctx.text, query.value, { caseSensitive: sensitive.checked });
    active = matches.findIndex(m => m.start >= at); if (active < 0 && matches.length) active = 0;
    draw();
  }
  function visit(index) {
    if (!matches.length) return;
    const origin = document.activeElement, keepFocus = panel.contains(origin);
    active = (index + matches.length) % matches.length; const m = matches[active];
    ctx.showSourceIssue({ source_offset: m.start });
    ctx.editor.unfoldAt(m.end);
    const start = ctx.editor.toDisp(m.start), end = ctx.editor.toDisp(m.end);
    // Cover fields and metadata are managed outside the source textarea.
    // Their result stays highlighted in this panel; do not select unrelated source.
    ctx.editor.ta.setSelectionRange(start, end - start === m.end - m.start ? end : start);
    ctx.editor.highlight();
    const slide = m.page >= 0 ? ctx.preview?.slideOfPage(m.page) : -1;
    if (slide >= 0) ctx.preview.go(slide, 0);
    draw();
    results.querySelector('[aria-current=true]')?.scrollIntoView({ block: 'nearest' });
    if (keepFocus) (origin.isConnected ? origin : query).focus({ preventScroll: true });
  }
  function position() {
    if (panel.hidden) return;
    const r = toggle.getBoundingClientRect(), gap = 8;
    panel.style.width = `${Math.min(360, innerWidth - gap * 2)}px`;
    panel.style.left = `${Math.max(gap, Math.min(r.right - panel.offsetWidth, innerWidth - panel.offsetWidth - gap))}px`;
    panel.style.top = `${r.bottom + gap}px`;
    panel.style.maxHeight = `${Math.max(80, innerHeight - r.bottom - gap * 2)}px`;
  }
  function close(focus = true) { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); if (focus) toggle.focus(); }
  const outside = e => { if (!panel.hidden && !panel.contains(e.target) && !toggle.contains(e.target)) close(false); };
  const resized = new ResizeObserver(position); resized.observe(ctx.root); resized.observe(toggle);
  window.addEventListener('resize', position);
  document.addEventListener('pointerdown', outside, true);
  function open(replace = false) {
    if (ctx.presenting) return;
    if (document.body.classList.contains('editor-off')) ctx.root.querySelector('#editorToggle').click();
    if (!toggle.getClientRects().length) ctx.leftTabs?.show('qmd');
    panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); refresh(); position();
    (replace ? replacement : query).focus(); query.select();
  }
  async function replace(all) {
    if (busy || locked() || !matches.length) return;
    busy = true; status();
    try {
      if (!await ctx.flush() || locked()) return;
      refresh(); const chosen = all ? matches : [matches[active]];
      if (!chosen.length || !chosen[0]) return;
      const text = replaceManuscriptMatches(ctx.text, chosen, replacement.value);
      if (text == null) return;
      const at = chosen[0].start; ctx.setText(text, { caret: at }); refresh(all ? 0 : at + replacement.value.length);
      if (matches.length) visit(active);
    } catch (error) { toast(error.message); }
    finally { busy = false; status(); }
  }
  toggle.onclick = () => panel.hidden ? open() : close();
  query.oninput = () => refresh(0); sensitive.onchange = () => refresh(0);
  button('prev').onclick = () => visit(active - 1); button('next').onclick = () => visit(active + 1);
  button('close').onclick = () => close(); button('replace').onclick = () => replace(false); button('all').onclick = () => replace(true);
  panel.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); visit(active + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  const shortcut = e => {
    if (e.isComposing || ctx.presenting || !(e.metaKey || e.ctrlKey) || e.altKey || !['f', 'h'].includes(e.key.toLowerCase())) return;
    e.preventDefault(); e.stopPropagation(); open(e.key.toLowerCase() === 'h');
  };
  window.addEventListener('keydown', shortcut, true);
  ctx.search = { open };
  return { textChanged() { if (!panel.hidden) refresh(); }, statusChanged: status, destroy() { resized.disconnect(); window.removeEventListener('resize', position); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', shortcut, true); panel.remove(); toggle.remove(); delete ctx.search; } };
}
