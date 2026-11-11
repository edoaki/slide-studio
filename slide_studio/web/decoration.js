// ブロックのデザインの入力。種類はブロックに、色と太さはテーマに書く。透明度は色だけに掛ける。
import { S } from './strings.js';
import { DESIGNS, designOf, designValues, parseRegion, regionValue } from './block-design.js';
import { colorPicker } from './color-picker.js';

export function popup(button, icon, title, content, disabled, state = {}, key = null) {
  let restoreScroll = true;
  const box = document.createElement('div'); box.className = 'fmt-colorbox';
  const menu = document.createElement('div'); menu.className = 'fmt-menu'; menu.setAttribute('popover', 'manual'); menu.hidden = state.open !== key || key === null;
  const close = () => { if (key && state.open === key) state.open = null; menu.hidden = true; if (menu.matches(':popover-open')) menu.hidePopover(); toggle.setAttribute('aria-expanded', 'false'); state.changed?.(); };
  const toggle = button(icon, title, () => {
    menu.hidden = !menu.hidden; if (key) { state.open = menu.hidden ? null : key; for (const other of box.parentElement?.querySelectorAll('.decoration-tool') || []) if (other !== box) { const otherMenu = other.querySelector('.fmt-menu'); otherMenu.hidden = true; if (otherMenu.matches(':popover-open')) otherMenu.hidePopover(); other.querySelector('button').setAttribute('aria-expanded', 'false'); } } toggle.setAttribute('aria-expanded', String(!menu.hidden));
    position(); state.changed?.();
  }, { disabled });
  function position() {
    if (!box.isConnected) return;
    if (menu.hidden) { if (menu.matches(':popover-open')) menu.hidePopover(); return; }
    if (!menu.matches(':popover-open')) menu.showPopover();
    const origin = box.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight, keep = state.avoid?.();
    const fit = ([x, y]) => [Math.max(8, Math.min(x, innerWidth - w - 8)), Math.max(8, Math.min(y, innerHeight - h - 8))];
    // keep（選んだブロックとツールバー）に重ならない所を下・上・右・左の順に探す。どこも重なるなら重なりのいちばん小さい所
    const spots = (keep ? [[origin.left, keep.bottom + 8], [origin.left, keep.top - h - 8], [keep.right + 8, keep.top], [keep.left - w - 8, keep.top]] : [[origin.left, origin.bottom + 8]]).map(fit);
    const cover = ([x, y]) => keep ? Math.max(0, Math.min(x + w, keep.right) - Math.max(x, keep.left)) * Math.max(0, Math.min(y + h, keep.bottom) - Math.max(y, keep.top)) : 0;
    const [left, top] = spots.reduce((a, b) => cover(b) < cover(a) ? b : a);
    menu.style.left = `${left}px`; menu.style.top = `${top}px`;
    if (key && restoreScroll) { menu.scrollTop = state.scrollTop?.[key] || 0; restoreScroll = false; }
  }
  box.positionMenu = position;
  content.addEventListener("toggle", position, true);
  menu.addEventListener('scroll', () => { if (key && menu.isConnected) (state.scrollTop ??= {})[key] = menu.scrollTop; });
  requestAnimationFrame(() => { if (box.isConnected) position(); });
  toggle.setAttribute('aria-expanded', String(!menu.hidden)); toggle.setAttribute('aria-haspopup', 'true');
  box.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); toggle.focus(); } });
  box.addEventListener('focusout', e => { if (e.relatedTarget && !box.contains(e.relatedTarget)) close(); });
  menu.append(content); box.append(toggle, menu); return box;
}
// 入口は1つ。デザインを選ぶとブロックの原稿へ、色・透明度・太さを確定するとテーマへそのまま書く。
// theme：{ name, values（テーマ変数の今の値）, locked, preview(更新)（動かしている間の見た目だけ）, save(更新) }
export function decorationTools(button, values, change, disabled, state, theme) {
  const d = S.decoration, current = designOf(values), regions = DESIGNS[current].regions;
  const colorsOff = disabled || theme.locked;
  const alphaOf = pct => Math.round(255 * (1 - pct / 100)).toString(16).padStart(2, '0');
  const pctOf = a => Math.round(100 - parseInt(a || 'ff', 16) / 255 * 100);
  const panel = document.createElement('div'); panel.className = 'decoration-compact';
  const add = (host, label, icon, fn, off = disabled) => { const b = button(icon, label, fn, { disabled: off }); host.append(b); return b; };
  // 色の◯を1行に並べる（色1 ◯ 色2 ◯）。押すと下に色の編集を出し、透明度と線の太さもそこで変える。
  // item：{ id, short, label（何の色か）, name（色の編集の見出し）, alphaLabel, widthLabel（線だけ）, color, width, set(color, width, final) }
  const colorGroup = (items, palette) => {
    const group = document.createElement('div'); group.className = 'decoration-color-group';
    const dots = document.createElement('div'); dots.className = 'decoration-regions'; group.append(dots);
    let editor = null;
    const open = id => {
      state.colorOpen = id; editor?.remove(); editor = null;
      dots.querySelectorAll('button').forEach(b => b.setAttribute('aria-expanded', String(b.dataset.region === id)));
      const n = items.findIndex(it => it.id === id);
      if (n >= 0) { editor = colorEditor(items[n], dots.children[n], palette, () => { open(null); dots.children[n].focus(); }); group.append(editor); }
      group.closest('.decoration-tool')?.positionMenu?.();
    };
    for (const it of items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'decoration-region'; b.dataset.region = it.id; b.disabled = colorsOff;
      const text = document.createElement('span'); text.textContent = it.short;
      const dot = document.createElement('i'); dot.className = 'decoration-dot'; dot.setAttribute('aria-hidden', 'true'); dot.style.setProperty('--c', it.color);
      b.append(text, dot); b.setAttribute('aria-label', it.label); b.dataset.tip = it.label; b.setAttribute('aria-haspopup', 'true');
      b.onclick = () => open(state.colorOpen === it.id ? null : it.id);
      dots.append(b);
    }
    // 描き直したあとも開いていた色の編集を開く
    if (!colorsOff && items.some(it => it.id === state.colorOpen)) open(state.colorOpen);
    return group;
  };
  const colorEditor = (it, dotButton, palette, close) => {
    const box = document.createElement('div'); box.className = 'decoration-color-editor';
    let c = it.color.slice(0, 7), a = it.color.slice(7) || 'ff', w = it.width;
    const send = final => { dotButton.querySelector('i').style.setProperty('--c', c + a); it.set(c + a, w, final); };
    box.append(colorPicker({ title: it.name, value: c, palette, close, preview: v => { c = v; if (a === '00') a = 'ff'; send(false); }, commit: v => { c = v; if (a === '00') a = 'ff'; send(true); } }));
    const slider = (text, label, min, max, step, start, unit, set) => {
      const field = document.createElement('label'); field.className = 'decoration-slider';
      const name = document.createElement('span'); name.textContent = text;
      const range = document.createElement('input'); range.type = 'range'; range.min = min; range.max = max; range.step = step; range.value = start; range.disabled = colorsOff; range.setAttribute('aria-label', label);
      const output = document.createElement('output'); output.textContent = `${start}${unit}`;
      range.oninput = () => { output.textContent = `${range.value}${unit}`; set(+range.value); send(false); };
      range.onchange = () => send(true);
      field.append(name, range, output); box.append(field);
    };
    slider(d.opacity, it.alphaLabel, 0, 100, 1, pctOf(a), '%', v => { a = alphaOf(v); });
    if (it.widthLabel) slider(d.thickness, it.widthLabel, 1, 20, .5, w, 'px', v => { w = v; });
    return box;
  };
  // 見本はテーマの今の色で描き、スライドの地に近い明るい下地に置く。名前はツールチップに出す
  const choices = document.createElement('div'); choices.className = 'decoration-designs';
  choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', d.design);
  for (const kind of Object.keys(DESIGNS).filter(k => k !== 'unframed')) {
    const b = add(choices, d[kind], 'square', () => { const next = designValues(kind === current ? 'unframed' : kind); next['--block-shadow'] = values['--block-shadow'] || null; change(next); });
    b.setAttribute('aria-pressed', String(current === kind)); b.dataset.design = kind;
    const sample = document.createElement('span'); sample.className = 'decoration-design-sample'; sample.setAttribute('aria-hidden', 'true');
    sample.dataset.kind = kind; sample.textContent = d.sample;
    const parts = DESIGNS[kind].regions.map(r => parseRegion(theme.values[r.var]));
    sample.style.setProperty('--sample-line', parts[0].color);
    if (kind === 'plain') sample.style.borderStyle = parts[0].style;
    sample.style.backgroundColor = parts[1].color;
    sample.style.color = parts[2].color;
    sample.style.borderRadius = theme.values[`--block-${kind}-radius`] || '0px';
    b.style.setProperty('--sample-paper', theme.values['--paper'] || '#fff');
    b.replaceChildren(sample);
  }
  panel.append(choices);
  if (regions.length) {
    const parsed = regions.map(r => parseRegion(theme.values[r.var]));
    const set = (r, value, final) => (final ? theme.save : theme.preview)({ [r.var]: value });
    if (current === 'plain') {
      const row = document.createElement('div'); row.className = 'decoration-choices';
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', d.style);
      for (const line of ['solid', 'dashed', 'dotted', 'double']) {
        const b = add(row, d[line], 'square', () => set(regions[0], regionValue(regions[0], { ...parsed[0], style: line }), true), colorsOff);
        const mark = document.createElement('span'); mark.className = 'decoration-line'; mark.style.borderTopStyle = line;
        b.replaceChildren(mark); b.setAttribute('aria-pressed', String(parsed[0].style === line));
      }
      panel.append(row);
    }
    // 先頭の見本はテーマの今の色。そのあとに定番の色
    const preset = ['#65758b', '#326fa8', '#a85c42', '#5c8068', '#292c35', '#e8eff7', '#f3e5cf', '#ffffff'];
    const own = [...new Set(parsed.map(p => p.color.slice(0, 7)))];
    const palette = [...own, ...preset.filter(c => !own.includes(c))].slice(0, preset.length);
    panel.append(colorGroup(regions.map((r, i) => ({
      id: `${current}:${i}`, short: r.accent ? d.regionShort(i + 1) : d[r.name], label: r.accent ? d.region(i + 1, d[r.name]) : d[r.name], name: d[r.name],
      alphaLabel: r.accent ? d.regionOpacity(i + 1) : `${d[r.name]}${d.opacity}（%）`, widthLabel: r.line ? d.regionWidth(i + 1) : null, color: parsed[i].color, width: parsed[i].width,
      set: (c, w, final) => set(r, regionValue(r, { ...parsed[i], color: c, width: w }), final),
    })), palette));
  }
  const setting = (label, key, min, max, step, scale = 1, unit = '') => {
    const row = document.createElement('label'); row.className = 'decoration-slider';
    const title = document.createElement('span'); title.textContent = label;
    const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step;
    input.value = (parseFloat(theme.values[key]) || 0) * scale; input.disabled = colorsOff; input.setAttribute('aria-label', label);
    const output = document.createElement('output'); output.textContent = `${input.value}${unit}`;
    const value = () => key.endsWith('-radius') ? `${input.value}px` : String(+input.value / scale);
    input.oninput = () => { output.textContent = `${input.value}${unit}`; theme.preview({ [key]: value() }); };
    input.onchange = () => theme.save({ [key]: value() });
    row.append(title, input, output); panel.append(row);
  };
  setting(d.radius, `--block-${current}-radius`, 0, 40, 1, 1, 'px');
  const shadowRow = document.createElement('label'); shadowRow.className = 'decoration-shadow';
  const shadow = document.createElement('input'); shadow.type = 'checkbox'; shadow.checked = values['--block-shadow'] === 'on' || values['--block-design'] === 'shadow'; shadow.disabled = disabled;
  shadow.onchange = () => change({ ...(['shadow', 'corner'].includes(values['--block-design']) ? designValues(current) : {}), '--block-shadow': shadow.checked ? 'on' : null });
  shadowRow.append(shadow, document.createTextNode(d.shadow)); panel.append(shadowRow);
  if (shadow.checked) setting(d.shadowStrength, `--block-${current}-shadow`, 0, 100, 1, 100, '%');
  const box = popup(button, 'square', d.design, panel, disabled, state, 'design');
  box.classList.add('decoration-tool'); box.dataset.decoration = 'design';
  return box;
}
