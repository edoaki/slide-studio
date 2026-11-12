import { S } from './strings.js';
import { tip } from './tip.js';

const T = S.themes.colorPicker;
const clamp = (v, max = 1) => Math.max(0, Math.min(max, v));
function hsv(color, fallbackHue = 0) {
  const [r, g, b] = color.slice(1).match(/../g).map(v => parseInt(v, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = !d ? fallbackHue : ((max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return [h, max ? d / max : 0, max];
}
function hex(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, '0'); };
  return `#${f(5)}${f(3)}${f(1)}`;
}

// 欄内の色選択。ドラッグ中はプレビューだけ、離したときに1回保存する。
export function colorPicker({ title, value, palette, preview, commit, close }) {
  let [h, s, v] = hsv(value), dragging = false, codeDirty = false;
  const box = document.createElement('div'); box.className = 'tv-inline-color';
  box.setAttribute('role', 'group'); box.setAttribute('aria-label', T.edit(title));
  const head = document.createElement('div'); head.className = 'tv-color-head';
  const name = document.createElement('strong'); name.textContent = T.edit(title);
  const done = document.createElement('button'); done.type = 'button'; done.textContent = '×'; tip(done, S.close);
  done.onclick = close; head.append(name, done);
  const swatches = document.createElement('div'); swatches.className = 'tv-color-swatches';
  swatches.setAttribute('role', 'group'); swatches.setAttribute('aria-label', T.palette);
  [...new Set([...palette, '#ffffff', '#f1f5f9', '#94a3b8', '#334155', '#111827', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6'])].forEach(color => {
    const b = document.createElement('button'); b.type = 'button'; b.style.background = color; b.dataset.color = color;
    tip(b, T.choose(color));
    b.onclick = () => { [h, s, v] = hsv(color, h); update(); preview(color); commit(color); };
    swatches.append(b);
  });
  const field = document.createElement('div'); field.className = 'tv-color-plane'; field.tabIndex = 0;
  field.setAttribute('role', 'group'); field.setAttribute('aria-label', T.plane);
  field.title = T.plane;
  const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true'); field.append(dot);
  const hueLabel = document.createElement('label'); hueLabel.className = 'tv-color-hue';
  const hueName = document.createElement('span'); hueName.textContent = T.hue;
  const hue = document.createElement('input'); hue.type = 'range'; hue.min = 0; hue.max = 360;
  hue.setAttribute('aria-label', T.hue); hueLabel.append(hueName, hue);
  const codeLabel = document.createElement('label'); codeLabel.className = 'tv-color-code';
  const codeName = document.createElement('span'); codeName.textContent = S.themes.heading.hex;
  const code = document.createElement('input'); code.type = 'text'; code.spellcheck = false;
  code.maxLength = 7; code.setAttribute('aria-label', S.themes.heading.hex);
  const sample = document.createElement('i'); sample.setAttribute('aria-hidden', 'true'); codeLabel.append(codeName, sample, code);
  function update() {
    value = hex(h, s, v); code.value = value; codeDirty = false; code.setCustomValidity('');
    sample.style.background = value; hue.value = h;
    field.style.setProperty('--hue', h); dot.style.left = `${s * 100}%`; dot.style.top = `${(1 - v) * 100}%`;
    swatches.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === value)));
  }
  function point(e) {
    const r = field.getBoundingClientRect(); s = clamp((e.clientX - r.left) / r.width); v = 1 - clamp((e.clientY - r.top) / r.height);
    update(); preview(value);
  }
  field.onpointerdown = e => { if (e.button !== 0) return; e.preventDefault(); field.focus(); field.setPointerCapture(e.pointerId); dragging = true; point(e); };
  field.onpointermove = e => { if (dragging) point(e); };
  field.onpointerup = e => { if (!dragging) return; point(e); dragging = false; field.releasePointerCapture(e.pointerId); commit(value); };
  field.onpointercancel = () => { if (dragging) { dragging = false; commit(value); } };
  field.onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation(); const step = e.shiftKey ? .1 : .01;
    if (e.key === 'ArrowLeft') s = clamp(s - step);
    if (e.key === 'ArrowRight') s = clamp(s + step);
    if (e.key === 'ArrowUp') v = clamp(v + step);
    if (e.key === 'ArrowDown') v = clamp(v - step);
    update(); preview(value); commit(value);
  };
  hue.oninput = () => { h = Number(hue.value); update(); preview(value); };
  hue.onchange = () => commit(value);
  code.oninput = () => { codeDirty = true; code.setCustomValidity(''); };
  code.onchange = () => {
    let color = code.value.trim().replace(/^#?([0-9a-f]{3})$/i, (_, short) => '#' + [...short].map(c => c + c).join(''));
    if (/^[0-9a-f]{6}$/i.test(color)) color = '#' + color;
    if (!/^#[0-9a-f]{6}$/i.test(color)) { code.setCustomValidity(T.invalid); code.reportValidity(); return; }
    [h, s, v] = hsv(color, h); update(); preview(value); commit(value);
  };
  code.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); code.onchange(); } };
  box.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  box.append(head, swatches, field, hueLabel, codeLabel);
  box.refresh = color => { if (!dragging && (!codeDirty || document.activeElement !== code)) { [h, s, v] = hsv(color, h); update(); } };
  update(); return box;
}
