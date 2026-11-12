// 表を選んだときのツールバーの部品：文字サイズ（⊖ px ⊕）・太字・戻す。列の幅は表の上のつまみ（block-handles.js）。
import { S } from './strings.js';
import { tip } from './tip.js';

const MIN = 8, MAX = 200, STEP = 2;
export const clampSize = v => Math.min(MAX, Math.max(MIN, Math.round(v)));

// size：今の文字サイズ（px）。bold・custom：太字か・書いた値があるか。
// step(±1)：大きさを一段変える。setSize(px か null)、setBold(on)、reset()
export function tableTools(button, { size, bold, custom, disabled, step, setSize, setBold, reset }) {
  const input = document.createElement('input');
  input.type = 'number'; input.min = String(MIN); input.max = String(MAX); input.step = '1'; input.className = 'fmt-size';
  input.value = size ? String(Math.round(size)) : ''; input.disabled = disabled;
  tip(input, S.fmt.size);
  input.addEventListener('change', () => {
    if (!input.value) { setSize(null); return; }
    if (input.checkValidity()) setSize(clampSize(input.valueAsNumber));
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  const group = document.createElement('div');
  group.className = 'tb-group';
  group.append(button('sizeDown', S.fmt.smaller, () => step(-STEP), { disabled }), input, button('sizeUp', S.fmt.larger, () => step(STEP), { disabled }));
  const box = document.createDocumentFragment();
  box.append(group, button('bold', S.table.bold, () => setBold(!bold), { disabled, pressed: bold }));
  if (custom) box.append(button('clearFmt', S.table.reset, reset, { disabled }));
  return box;
}
