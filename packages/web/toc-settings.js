// 自動生成する目次の表示と配置。原稿の変更は履歴・保存の共通経路を通す。
import { S } from './strings.js';
import { structureOf } from './structure.js';
import { makeTextFormat } from './text-format.js';

export function makeTocSettings(ctx) {
  const el = document.createElement('div');
  el.className = 'toc-settings';
  el.innerHTML = `<input type="checkbox" role="switch" aria-label="${S.toc.enabled}">
    <div class="toc-layout" role="group" aria-label="${S.toc.layout}">
      <button type="button" data-layout="vertical" aria-label="${S.toc.vertical}" title="${S.toc.vertical}" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"/></svg></button>
      <button type="button" data-layout="columns" aria-label="${S.toc.columns}" title="${S.toc.columns}" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h7M14 8h7M3 16h7M14 16h7"/></svg></button>
    </div>`;
  ctx.tocSettings = { el };
  // 目次のページへ移らずに、その場で設定できる。
  el.addEventListener('pointerdown', e => e.stopPropagation());
  const toggle = el.querySelector('input'), layouts = [...el.querySelectorAll('[data-layout]')];
  let layout = 'vertical';
  let dead = false, ticket = 0, pendingPadding = false;
  async function refresh() {
    const id = ++ticket, text = ctx.text;
    const st = await structureOf(text);
    if (dead || id !== ticket || ctx.text !== text) return;
    const p = st.pages.find(p => p.generated === 'toc');
    toggle.checked = !!p && !p.classes.includes('toc-off');
    layout = p?.classes.includes('toc-columns') ? 'columns' : 'vertical';
    toggle.disabled = ctx.locked;
    attrs = p?.kv ?? {};
    if (!toggle.checked || ctx.locked) clear();
    format.update();
    if (!pendingPadding && document.activeElement !== padding) updatePadding();
    for (const button of layouts) {
      button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
      button.disabled = ctx.locked || !toggle.checked;
    }
  }
  async function change() {
    const enabled = toggle.checked, columns = layout === 'columns', text = ctx.text;
    const st = await structureOf(text);
    if (dead || ctx.locked || ctx.text !== text) { refresh(); return; }
    const p = st.pages.find(p => p.generated === 'toc');
    const flags = `${enabled ? '' : ' .toc-off'}${columns ? ' .toc-columns' : ''}`;
    let next;
    if (p) {
      const original = text.slice(p.start, p.head_end);
      const updated = original.replace(/(^ {0,3}:{3,}[ \t]*\{)([^}]*)(\})/m, (_, start, attrs, end) => start + attrs.replace(/(^|[ \t]+)\.toc-(?:off|columns)(?=[ \t]|$)/g, '') + flags + end);
      next = text.slice(0, p.start) + updated + text.slice(p.head_end);
    } else {
      const at = st.pages.find(p => p.classes.includes('cover'))?.end ?? st.pages[0]?.start ?? text.length;
      next = text.slice(0, at) + `\n::: {#toc${flags}}\n:::\n\n` + text.slice(at);
    }
    ctx.setText(next);
    refresh();
  }
  toggle.onchange = () => change();
  for (const button of layouts) button.onclick = () => {
    if (button.disabled || button.dataset.layout === layout) return;
    layout = button.dataset.layout;
    change();
  };
  const host = ctx.root.querySelector('#viewport'), bar = document.createElement('div');
  bar.className = 'toolbar toc-text-tools'; bar.hidden = true;
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', S.fmt.bar); host.append(bar);
  let attrs = {}, colors = {}, shown = { px: 30, ink: '' }, chosen = false, chosenSlide = null, client = null, off = null;
  const canEdit = () => !ctx.locked && !ctx.conflict && ctx.renderOk && !ctx.blocks?.editing;
  function clear() { if (pendingPadding) savePadding(); chosen = false; chosenSlide = null; bar.hidden = true; format.close(); }
  function place() { bar.style.left = `${Math.max(4, (host.clientWidth - bar.offsetWidth) / 2)}px`; bar.style.top = '8px'; }
  let pendingSave = Promise.resolve();
  function save(patch) {
    if (!chosen || ctx.locked || ctx.conflict) return;
    pendingSave = pendingSave.then(() => applyPatch(patch)).catch(error => { ctx.hint(error.message); return false; });
  }
  async function applyPatch(patch) {
    let text, st;
    do {
      if (dead || ctx.locked || ctx.conflict) return;
      text = ctx.text;
      st = await structureOf(text);
    } while (text !== ctx.text);
    if (dead || ctx.locked || ctx.conflict) return;
    const p = st.pages.find(p => p.generated === 'toc'); if (!p || p.classes.includes('toc-off')) return;
    const head = text.slice(p.start, p.head_end).replace(/(^ {0,3}:{3,}[ \t]*\{)([^}]*)(\})/m, (_, start, values, end) => {
      for (const [key, value] of Object.entries(patch)) {
        values = values.replace(new RegExp(`\\s+${key}=(?:"[^"]*"|'[^']*'|[^\\s}]+)`, 'g'), '');
        if (value != null) values += ` ${key}="${value}"`;
      }
      return start + values + end;
    });
    ctx.setText(text.slice(0, p.start) + head + text.slice(p.head_end));
    await refresh();
  }
  const px = () => Number(attrs['toc-size']) || shown.px;
  const format = makeTextFormat(() => null, null, {
    formatState: () => ({ px: px(), ink: colors[`--${attrs['toc-color'] === 'highlight' ? 'mark' : attrs['toc-color']}`] || attrs['toc-color'] || shown.ink, color: attrs['toc-color'] }),
    colors: () => colors, align: () => 'left',
    size: value => { if (Number.isFinite(value) && value >= 8 && value <= 200) save({ 'toc-size': value }); },
    stepSize: delta => save({ 'toc-size': Math.min(200, Math.max(8, px() + delta * 2)) }),
    color: value => save({ 'toc-color': value }),
    clearFormat: () => { shown = { px: 30, ink: colors['--ink'] }; save({ 'toc-size': null, 'toc-color': null }); },
    focus() {}, finish: clear,
  });
  format.plain(true); format.cell(true); bar.append(...format.nodes);
  const paddingLabel = document.createElement('label'), padding = document.createElement('input');
  paddingLabel.className = 'toc-padding'; paddingLabel.append(S.toc.paddingLabel);
  padding.type = 'number'; padding.min = '0'; padding.max = '100'; padding.step = '1'; padding.className = 'fmt-size';
  padding.setAttribute('aria-label', S.toc.padding); padding.title = S.toc.padding;
  paddingLabel.append(padding); bar.append(paddingLabel);
  function updatePadding() { padding.value = String(attrs['toc-padding'] ?? 16); }
  function savePadding() {
    if (!pendingPadding) return;
    pendingPadding = false;
    const value = padding.valueAsNumber;
    if (!Number.isFinite(value) || value < 0 || value > 100) { updatePadding(); return; }
    save({ 'toc-padding': value });
  }
  padding.addEventListener('input', () => { pendingPadding = true; });
  padding.addEventListener('change', savePadding);
  padding.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); savePadding(); }
  });
  function attach() {
    const next = ctx.preview.client; if (!next || client === next) return;
    off?.(); client = next;
    const offSelect = client.on('toc.select', event => {
      if (event.sourceVersion !== ctx.preview.sourceVersion) return;
      if (!event.selected || !canEdit()) { clear(); return; }
      ctx.blocks?.select(null); chosen = true; chosenSlide = event.index; colors = event.colors; shown = { px: event.px, ink: event.ink };
      bar.hidden = false; format.update();
      if (!pendingPadding && document.activeElement !== padding) updatePadding();
      place();
    });
    const offKey = client.on('edit.intent', event => {
      if (event.sourceVersion === ctx.preview.sourceVersion && event.kind === 'key' && event.code === 'Escape') clear();
    });
    off = () => { offSelect(); offKey(); };
  }
  const outside = event => { if (!bar.contains(event.target)) clear(); };
  const key = event => { if (event.key === 'Escape') clear(); };
  host.addEventListener('pointerdown', outside); window.addEventListener('keydown', key);
  const resize = new ResizeObserver(place); resize.observe(host);
  refresh();
  return {
    flush() { if (pendingPadding) savePadding(); return pendingSave; },
    textChanged: refresh, previewLoaded() { attach(); refresh(); },
    slideChanged(slide) { if (chosen && slide.index !== chosenSlide) clear(); refresh(); },
    destroy() { dead = true; off?.(); resize.disconnect(); host.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); format.destroy(); bar.remove(); },
  };
}
