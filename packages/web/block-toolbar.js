import { svg } from './icons.js';
import { tip } from './tip.js';
import { S } from './strings.js';

// ボタンには文字を書かず、操作名とキーはカーソルを合わせたときに出す（tip.js）
export function button(icon, label, fn, { disabled = false, cls = '', pressed, keys = '' } = {}) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = `ibtn ${cls}`; b.innerHTML = svg(icon); b.disabled = disabled; b.onclick = fn;
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
  return tip(b, label, keys);
}
export const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });

export function breadcrumbs(items, selected, select) {
  const list = document.createElement('nav');
  list.className = 'crumbs'; list.setAttribute('aria-label', S.crumbs);
  items.forEach((it, i) => {
    if (i) list.append(Object.assign(document.createElement('span'), { className: 'crumb-sep', textContent: '›' }));
    const b = document.createElement(it.key ? 'button' : 'span');
    b.className = 'crumb'; b.textContent = it.label;
    if (it.key) { b.type = 'button'; b.onclick = () => select(it.key); b.dataset.tip = S.crumbSelect(it.label); }
    if (it.key === selected) b.setAttribute('aria-current', 'true');
    list.append(b);
  });
  return list;
}

export function placeToolbar(bar, viewport, frame, r, pointX) {
  // 選んだブロックのすぐ上（入らなければ下）。ブロック自体には被せない。横は押した位置の近く、ブロックの幅の中
  const vr = viewport.getBoundingClientRect(), fr = frame.getBoundingClientRect(), ox = fr.left - vr.left, oy = fr.top - vr.top;
  const top = oy + Math.max(r.top, 0), bottom = oy + Math.min(r.bottom, fr.height);
  const lx = ox + Math.max(r.left, 0) - 4, rx = ox + Math.min(r.right, fr.width) + 4;
  const h = bar.offsetHeight, wd = bar.offsetWidth, GAP = 12;
  let y = top - h - GAP;
  if (y < 4) y = Math.min(bottom + GAP, vr.height - h - 4);
  bar.style.top = `${Math.max(4, y)}px`;
  bar.dataset.tipSide = y + h <= top ? 'above' : 'below';
  const x = pointX == null ? lx : Math.max(lx, Math.min(ox + pointX - wd / 2, rx - wd));
  bar.style.left = `${Math.max(4, Math.min(x, vr.width - wd - 4))}px`;
  for (const box of bar.querySelectorAll('.decoration-tool')) box.positionMenu?.();
}
