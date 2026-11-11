// 一覧：全ページを # ごとの横の列に並べる。縮小画像は帯と同じで、カーソルで step をめくり、押すとそのページの最初へ移る。
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';
import { shotThumbs } from './shot-thumbs.js';

const OPEN_KEY = 'O';
const plain = e => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing && !e.repeat;
const isKey = e => e.code === `Key${OPEN_KEY}` && plain(e);

// shots()：ページごとの画像の URL。changed()：見えているページが変わった（撮影の順番を伝える）
export function makeOverview(ctx, { shots, changed, reorder }) {
  const trigger = tip(Object.assign(document.createElement('button'), { type: 'button', className: 'ibtn', innerHTML: svg('grid') }), S.overview.open, OPEN_KEY);
  trigger.onclick = () => open();
  ctx.root.querySelector('#stripTools').append(trigger);
  let box = null, thumbs = null, returnTo = null, wasInert = false;
  let stopReorder = null;
  const sampleOn = () => ctx.root.querySelector('#stage').classList.contains('theme-sample-on');

  function group(title) {
    const section = document.createElement('section'); section.className = 'overview-group';
    if (title != null) section.append(Object.assign(document.createElement('h2'), { textContent: title }));
    const row = document.createElement('div'); row.className = title == null ? 'pagestrip wrap' : 'pagestrip';
    section.append(row);
    return { section, row };
  }
  function makeThumb() {
    const b = document.createElement('button'); b.type = 'button';
    b.innerHTML = '<span class="t"></span><span class="num"></span>';
    return b;
  }
  // AI の編集などで描き直されたら開いたまま更新する。スクロールの位置と読み込み済みの画像は残す
  function render() {
    if (!box) return;
    const old = new Map([...box.querySelectorAll('button[data-index]')].map(b => [+b.dataset.index, b])), top = box.scrollTop;
    const lefts = [...box.querySelectorAll('.pagestrip')].map(r => r.scrollLeft);
    const inStrip = ctx.root.querySelectorAll('#pagestrip button[data-index]');
    const slides = [...inStrip].map(b => ctx.preview.slides[+b.dataset.index]), grouped = slides.some(s => s.sectionStart), groups = [];
    slides.forEach((s, i) => {
      if (!groups.length || s.sectionStart) groups.push(group(grouped ? s.group || S.overview.cover : null));
      const b = old.get(s.index) || makeThumb();
      b.dataset.index = s.index; b.dataset.tip = S.gotoSlide(i + 1);
      b.classList.toggle('chapter', s.chapter);
      b.querySelector('.t').textContent = s.title;
      b.querySelector('.num').textContent = i + 1;
      b.setAttribute('aria-current', String(s.index === ctx.preview.index));
      b.hidden = !!inStrip[i]?.hidden; // テーマのタブで絞り込んでいるページだけを出す
      groups.at(-1).row.append(b);
    });
    groups.forEach(g => { g.section.hidden = [...g.row.children].every(b => b.hidden); });
    box.replaceChildren(box.querySelector('.overview-close'), ...groups.map(g => g.section));
    box.querySelectorAll('.pagestrip').forEach((r, i) => { r.scrollLeft = lefts[i] || 0; });
    box.scrollTop = top;
    thumbs.decorate();
    reorder?.decorate(box);
    changed();
  }
  function open() {
    if (box || sampleOn() || !ctx.preview.slides.length) return;
    returnTo = document.activeElement; wasInert = ctx.root.inert;
    box = document.createElement('div'); box.className = 'overview-screen';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', S.overview.title);
    const closer = tip(Object.assign(document.createElement('button'), { type: 'button', className: 'ibtn overview-close', innerHTML: svg('x') }), S.overview.close, OPEN_KEY);
    closer.onclick = close;
    box.append(closer);
    // カーソルが乗っていないときは最後の step（そのページの全部）を出す
    thumbs = shotThumbs(box, shots, () => Infinity);
    stopReorder = reorder?.attach(box);
    box.addEventListener('click', e => {
      const b = e.target.closest('button[data-index]');
      if (!b) return;
      ctx.preview.go(+b.dataset.index);
      close();
    });
    box.addEventListener('scroll', changed, { capture: true, passive: true });
    document.body.append(box); ctx.root.inert = true;
    render();
    closer.focus();
    box.querySelector('button[aria-current="true"]')?.scrollIntoView({ block: 'center', inline: 'center' });
  }
  function close() {
    if (!box) return;
    stopReorder?.(); stopReorder = null;
    box.remove(); box = null; thumbs = null; ctx.root.inert = wasInert;
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    returnTo = null;
    changed();
  }
  // 開いている間は編集画面のキーを動かさない
  const keys = e => {
    if (!box) return;
    if (e.key === 'Escape' || isKey(e)) { e.preventDefault(); close(); }
    e.stopImmediatePropagation();
  };
  addEventListener('keydown', keys, true);

  return {
    get box() { return box; },
    render,
    decorate() { thumbs?.decorate(); },
    keydown(e) {
      if (!isKey(e) || e.target.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], .dialog') || ctx.root.querySelector('.dialog, dialog[open]')) return false;
      if (sampleOn()) return false;
      e.preventDefault(); open();
      return true;
    },
    destroy() { close(); trigger.remove(); removeEventListener('keydown', keys, true); },
  };
}
