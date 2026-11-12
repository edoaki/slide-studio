// 段階表示・揃えのツールバー。原稿の書き換えは block-ops に任せる。
import { S } from './strings.js';
import { tip } from './tip.js';
import { svg } from './icons.js';
import { circledStep } from './step-badge.js';

// 現在の揃えをアイコンで示し、押すたびに次の揃えへ進む。
export function alignButton(button, value, change, disabled = false, label = S.textAlign) {
  const values = ['left', 'center', 'right'];
  let current;
  const next = () => values[(values.indexOf(current) + 1) % values.length];
  const b = button('alignLeft', label, () => change(next()), { disabled });
  b.setAlign = value => {
    current = values.includes(value) ? value : value === 'end' ? 'right' : 'left';
    b.dataset.align = current;
    b.innerHTML = svg(`align${current[0].toUpperCase() + current.slice(1)}`);
    b.dataset.tip = S.alignCycle(label, S.align[current], S.align[next()]);
  };
  b.setAlign(value);
  return b;
}
// 段の番号は原稿の data-step のまま（0 は最初から出ている）。ほかのものが使っている段には点を付け、
// カーソルを合わせるとその段のものをスライドで示す（mark）。最後の番号は新しい段（破線）
export function stepTools(button, choices, change, disabled, mark = () => {}) {
  const box = document.createElement('div'); box.className = 'fmt-colorbox';
  const menu = document.createElement('div'); menu.className = 'fmt-menu'; menu.hidden = true;
  const show = open => { if (disabled) return; menu.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); if (!open) mark(null); };
  box.openStepMenu = () => show(true);
  box.classList.add('step-tools');
  const toggle = button('rows', S.stepReveal, () => show(menu.hidden), { disabled });
  toggle.setAttribute('aria-haspopup', 'true'); toggle.setAttribute('aria-expanded', 'false');
  const row = document.createElement('div'); row.className = 'fmt-row step-chips'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', S.stepReveal);
  for (let k = 0; k <= Math.max(choices.max, choices.step); k++) {
    const n = choices.others.get(k) || 0, fresh = k === choices.max && !n;
    const b = document.createElement('button');
    b.type = 'button'; b.className = `step-chip${fresh ? ' new' : ''}`; b.textContent = String(k); b.disabled = disabled;
    const number = choices.number?.(k);
    if (number != null) {
      const label = document.createElement('small');
      label.textContent = S.stepNumber(circledStep(number));
      b.append(label);
    }
    b.setAttribute('aria-pressed', String(k === choices.step)); b.dataset.others = String(Math.min(n, 3));
    b.onclick = () => { mark(null); change({ step: k }); };
    b.onpointerenter = b.onfocus = () => mark(k);
    b.onpointerleave = b.onblur = () => mark(null);
    row.append(tip(b, fresh ? S.stepNew(k) : S.stepAt(k, n)));
  }
  menu.append(row);
  if (choices.list) {
    const label = document.createElement('label'), check = document.createElement('input');
    check.type = 'checkbox'; check.checked = choices.incremental;
    check.onchange = () => change({ incremental: check.checked });
    label.append(check, document.createTextNode(S.stepEach)); menu.append(label);
  }
  box.append(toggle, menu); return box;
}
