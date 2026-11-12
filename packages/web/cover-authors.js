// front matter から描画される名前と所属の選択・移動。
import { svg } from './icons.js';
import { S } from './strings.js';
import { setFront } from './cover-form.js';

export function makeCoverAuthors(host, { ctx, live, select, write }) {
  const bar = document.createElement('div');
  bar.className = 'toolbar cover-authors-tools'; bar.hidden = true;
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', S.coverAuthors.title);
  host.append(bar);
  let win = null, chosen = false, press = null, moved = false;
  const target = () => win?.document.querySelector('.cover-authors');
  const values = () => {
    const el = target();
    return { position: el?.dataset.affiliationPosition || 'bottom',
      ...Object.fromEntries([['font', 'nameFont'], ['affFont', 'affFont'], ['bold', 'nameBold'], ['affBold', 'affBold']]
        .filter(([, attr]) => el?.dataset[attr] !== undefined)
        .map(([key, attr]) => [key, key.endsWith('Bold') || key === 'bold' ? el.dataset[attr] === 'true' : el.dataset[attr]])),
      ...Object.fromEntries([['x', 'left'], ['y', 'top'], ['size', '--cover-name-size'], ['affSize', '--cover-aff-size']]
        .filter(([, prop]) => el?.style.getPropertyValue(prop))
        .map(([key, prop]) => [key, parseFloat(el.style.getPropertyValue(prop))])) };
  };
  const save = patch => { if (live()) write(setFront(ctx.text, 'cover-authors-layout', ` ${JSON.stringify({ ...values(), ...patch })}`)); };
  function place() {
    if (!chosen) { bar.hidden = true; return; }
    const el = target(); if (!el || !el.getBoundingClientRect().width) { bar.hidden = true; return; }
    const r = el.getBoundingClientRect(), fr = ctx.preview.frame.getBoundingClientRect(), hr = host.getBoundingClientRect();
    bar.hidden = false;
    bar.style.left = `${Math.max(4, Math.min(fr.left - hr.left + r.left, hr.width - bar.offsetWidth - 4))}px`;
    bar.style.top = `${Math.max(4, fr.top - hr.top + r.top - bar.offsetHeight - 10)}px`;
  }
  function draw() {
    const el = target(); if (!el) return clear();
    el.classList.toggle('cover-authors-selected', chosen);
    bar.replaceChildren();
    const positionLabel = document.createElement('span');
    positionLabel.className = 'aff-position-label'; positionLabel.textContent = S.coverAuthors.positionLabel;
    bar.append(positionLabel);
    for (const position of ['bottom', 'right', 'left']) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = S.coverAuthors[position]; b.setAttribute('aria-label', S.coverAuthors[position]); b.dataset.tip = `${S.coverAuthors.position}：${S.coverAuthors[position]}`;
      b.setAttribute('aria-pressed', String(values().position === position)); b.disabled = !live();
      b.onclick = () => save({ position }); bar.append(b);
    }
    for (const [key, selector] of [['size', '.cover-name,.cover-names'], ['affSize', '.cover-affiliation']]) {
      const group = document.createElement('div'); group.className = 'cover-author-format';
      const fontKey = key === 'size' ? 'font' : 'affFont', boldKey = key === 'size' ? 'bold' : 'affBold';
      const label = document.createElement('label'), input = document.createElement('input');
      label.innerHTML = svg(key === 'size' ? 'presenter' : 'affiliation'); label.dataset.tip = S.coverAuthors[key]; input.type = 'number'; input.className = 'fmt-size'; input.min = '1'; input.step = '1';
      input.setAttribute('aria-label', S.coverAuthors[key]); input.disabled = !live();
      input.value = Math.round(parseFloat(win.getComputedStyle(el.querySelector(selector) || el).fontSize));
      input.onchange = () => { if (input.value && input.checkValidity()) save({ [key]: input.valueAsNumber }); };
      label.append(input); group.append(label);
      const font = document.createElement('select'); font.setAttribute('aria-label', S.coverAuthors[fontKey]); font.disabled = !live();
      for (const value of ['', 'sans', 'serif', 'mono']) {
        const option = document.createElement('option'); option.value = value; option.textContent = S.coverAuthors.fonts[value]; font.append(option);
      }
      font.value = values()[fontKey] || '';
      font.onchange = () => save({ [fontKey]: font.value });
      const bold = document.createElement('button'); bold.type = 'button'; bold.className = 'btn sm'; bold.innerHTML = svg('bold');
      bold.setAttribute('aria-label', S.coverAuthors[boldKey]); bold.dataset.tip = S.coverAuthors[boldKey]; bold.disabled = !live();
      const isBold = parseInt(win.getComputedStyle(el.querySelector(selector) || el).fontWeight, 10) >= 600;
      bold.setAttribute('aria-pressed', String(isBold)); bold.onclick = () => save({ [boldKey]: !isBold });
      group.append(font, bold); bar.append(group);
    }
    place();
  }
  function clear() { chosen = false; target()?.classList.remove('cover-authors-selected'); bar.hidden = true; }
  function down(e) {
    if (!e.target.closest?.('.cover-authors')) { clear(); return; }
    if (e.button || !live()) return;
    e.preventDefault(); e.stopImmediatePropagation(); select(); chosen = true; draw();
    const el = target(), cs = win.getComputedStyle(el);
    press = { x: e.clientX, y: e.clientY, left: parseFloat(cs.left) || 0, top: parseFloat(cs.top) || 0,
      style: el.getAttribute('style'), scale: win.document.querySelector('#stage').getBoundingClientRect().width / 1280 };
    moved = false; el.setPointerCapture(e.pointerId);
  }
  function move(e) {
    if (!press) return;
    if (!moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) return;
    moved = true; e.preventDefault(); e.stopImmediatePropagation();
    target().style.left = `${Math.round(press.left + (e.clientX - press.x) / press.scale)}px`;
    target().style.top = `${Math.round(press.top + (e.clientY - press.y) / press.scale)}px`; place();
  }
  function end(ok) {
    if (!press) return;
    const p = press; press = null;
    if (ok && moved) save({});
    else if (!ok) { if (p.style == null) target()?.removeAttribute('style'); else target()?.setAttribute('style', p.style); place(); }
  }
  const up = () => end(true), cancel = () => end(false);
  function click(e) {
    if (!e.target.closest?.('.cover-authors')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'dblclick' && !moved && live()) { chosen = true; draw(); }
    moved = false;
  }
  function key(e) { if (chosen && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); end(false); clear(); } }
  const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel, click, dblclick: click, keydown: key, blur: cancel };
  const outside = e => { if (!bar.contains(e.target)) clear(); };
  host.addEventListener('pointerdown', outside);
  window.addEventListener('keydown', key, true);
  const resize = new ResizeObserver(place); resize.observe(host);
  return {
    clear,
    refresh() { if (chosen) { if (target()?.getBoundingClientRect().width) draw(); else clear(); } },
    attach(w) {
      if (win !== w) {
        end(false);
        for (const [name, fn] of Object.entries(events)) win?.removeEventListener(name, fn, true);
        win = w;
        for (const [name, fn] of Object.entries(events)) win?.addEventListener(name, fn, true);
      }
      if (chosen) draw();
    },
    destroy() { this.attach(null); resize.disconnect(); host.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key, true); bar.remove(); },
  };
}
