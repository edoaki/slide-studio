// 自動生成する目次の表示と配置。原稿の変更は履歴・保存の共通経路を通す。
import { S } from './strings.js';
import { structureOf } from './structure.js';

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
  let dead = false, ticket = 0;
  async function refresh() {
    const id = ++ticket, text = ctx.text;
    const st = await structureOf(text);
    if (dead || id !== ticket || ctx.text !== text) return;
    const p = st.pages.find(p => p.generated === 'toc');
    toggle.checked = !!p && !p.classes.includes('toc-off');
    layout = p?.classes.includes('toc-columns') ? 'columns' : 'vertical';
    toggle.disabled = ctx.locked;
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
  toggle.onchange = change;
  for (const button of layouts) button.onclick = () => {
    if (button.disabled || button.dataset.layout === layout) return;
    layout = button.dataset.layout;
    change();
  };
  refresh();
  return { textChanged: refresh, slideChanged: refresh, destroy() { dead = true; } };
}
