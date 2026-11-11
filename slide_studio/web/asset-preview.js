import { S } from './strings.js';
import { svg } from './icons.js';

// 移動・キャンセルで解除し、長押し直後のクリックはカードへ渡さない。
export function longPress(root, selector, enabled, action) {
  let timer, start, held = false;
  const cancel = () => { clearTimeout(timer); start = null; };
  const down = e => {
    held = false; cancel();
    const card = e.target.closest(selector);
    if (e.button !== 0 || !card || e.target.closest('button,input,a') || !enabled()) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => { held = true; action(card); }, 500);
  };
  const move = e => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) cancel(); };
  const click = e => { if (held) { held = false; e.preventDefault(); e.stopImmediatePropagation(); } };
  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('pointerleave', cancel);
  root.addEventListener('click', click, true);
  return () => {
    cancel();
    for (const [type, fn] of [['pointerdown', down], ['pointermove', move], ['pointerup', cancel], ['pointercancel', cancel], ['pointerleave', cancel]]) root.removeEventListener(type, fn);
    root.removeEventListener('click', click, true);
  };
}

export function assetPreview(item, card) {
  const modal = document.createElement('dialog'); modal.className = 'as-preview';
  modal.setAttribute('aria-label', S.as.preview);
  const header = document.createElement('div'); header.className = 'dh';
  const title = document.createElement('h3'); title.textContent = item.name;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'ibtn'; close.setAttribute('aria-label', S.close); close.innerHTML = svg('x');
  header.append(title, close);
  const body = document.createElement('div'); body.className = 'as-preview-body';
  let cleanup = () => {};
  if (item.kind === 'image') {
    const img = document.createElement('img'); img.src = item.url; img.alt = item.name; body.append(img);
  } else {
    const frame = document.createElement('iframe');
    if (item.kind === 'html') frame.sandbox = 'allow-scripts';
    frame.src = item.url; frame.title = item.name; body.append(frame);
    if (item.kind === 'figure') {
      frame.onload = () => frame.contentWindow?.animation?.setVisible(true);
      const controls = document.createElement('div'); controls.className = 'as-preview-controls';
      const step = (direction) => {
        const a = frame.contentWindow?.animation;
        if (a) a.setStep(direction === 'first' ? 0 : Math.max(0, Math.min(a.steps, a.step + direction)), false);
      };
      for (const [direction, label] of [[-1, S.as.previousStep], [1, S.as.nextStep]]) {
        const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', label);
        b.onclick = () => step(direction); controls.append(b);
      }
      // 戻る領域だけ長押しで先頭へ戻す。
      let timer, held = false, start;
      const back = controls.firstChild;
      back.onpointerdown = e => { if (e.button) return; held = false; start = [e.clientX, e.clientY]; timer = setTimeout(() => { held = true; step('first'); }, 500); };
      const cancel = () => clearTimeout(timer);
      back.onpointermove = e => { if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 4) cancel(); };
      back.onpointerup = back.onpointercancel = back.onpointerleave = cancel;
      back.onclick = () => { if (!held) step(-1); held = false; };
      cleanup = cancel;
      body.append(controls);
    }
  }
  modal.append(header, body);
  if (item.kind === 'figure') {
    const hint = document.createElement('p'); hint.className = 'as-preview-hint'; hint.textContent = S.as.previewHint; modal.append(hint);
  }
  document.body.append(modal);
  close.onclick = () => modal.close();
  modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });
  modal.addEventListener('keydown', e => e.stopPropagation());
  modal.addEventListener('close', () => {
    // close は後から届くため、閉じた直後に移したフォーカスを元のカードへ戻さない。
    const restoreFocus = document.activeElement === document.body || modal.contains(document.activeElement);
    cleanup(); modal.remove();
    if (restoreFocus && card?.isConnected) card.focus({preventScroll: true});
  });
  modal.showModal(); close.focus();
  return modal;
}
