// スライドの下のページの帯（設計書 §10.2）：縮小画像（shot-thumbs.js）、上の縁のつまみで大きさを変える、一覧（overview.js）を開く。
import { api, toast } from './api.js';
import { S } from './strings.js';
import { tip } from './tip.js';
import { makeOverview } from './overview.js';
import { shotThumbs } from './shot-thumbs.js';
import { makePageReorder } from './page-reorder.js';

const MIN_W = 80, DEFAULT_W = 200;

export function makePageStrip(ctx) {
  const root = ctx.root, strip = root.querySelector('#pagestrip'), grip = root.querySelector('#stripGrip');
  const stage = root.querySelector('#stage'), viewport = root.querySelector('#viewport');
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('slide-studio.' + k); localStorage.setItem('slide-studio.' + k, v); } catch { /* 保存できなくても動く */ } return null; };
  let shots = [], want = Number(pref('stripW')) || DEFAULT_W, alive = true;

  // 帯に実際に見えているページを撮影側へ伝える。通信は直列にし、古い順序が後着しないようにする。
  let priorityFrame = 0, sendingPriority = false, wantedPriority = '[]', sentPriority = null;
  async function sendPriority() {
    if (sendingPriority) return;
    sendingPriority = true;
    try {
      while (sentPriority !== wantedPriority) {
        const value = wantedPriority;
        await api(`/api/deck/${encodeURIComponent(ctx.deck)}/shots/priority`, { method: 'POST', body: { indices: JSON.parse(value) } });
        sentPriority = value;
      }
    } catch { /* 次のスクロール・描画で再送する。表示自体は止めない */ }
    finally { sendingPriority = false; }
  }
  function prioritize() {
    if (!alive || priorityFrame) return;
    priorityFrame = requestAnimationFrame(() => {
      priorityFrame = 0;
      // 一覧を開いている間は、一覧に見えているページを先に撮る
      const box = overview.box, screen = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const visible = [...(box ?? strip).querySelectorAll('button[data-index]')].filter(b => {
        const rect = b.getBoundingClientRect();
        return rect.width && rect.height && [screen, ...(box ? [box, b.parentElement] : [strip]).map(c => c.getBoundingClientRect())]
          .every(c => rect.right > c.left && rect.left < c.right && rect.bottom > c.top && rect.top < c.bottom);
      }).map(b => +b.dataset.index);
      // 選択中のページが見えていれば先にする。
      visible.sort((a, b) => Number(b === ctx.preview.index) - Number(a === ctx.preview.index));
      wantedPriority = JSON.stringify(visible);
      sendPriority();
    });
  }
  strip.addEventListener('scroll', prioritize, { passive: true });
  const visibility = new MutationObserver(prioritize);
  visibility.observe(strip, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  const stripFit = new ResizeObserver(prioritize);
  stripFit.observe(strip);

  // ------------------------------------------------------------ 大きさ（上の縁のつまみ）
  // 一番大きくて実際のスライドの 1/4 の幅。スライドは帯が高くなるほど縮むので、両方を満たす幅を求める
  function maxW() {
    const vs = getComputedStyle(viewport), cur = strip.querySelector('button')?.offsetHeight || want * 9 / 16;
    const availW = viewport.clientWidth - parseFloat(vs.paddingLeft) - parseFloat(vs.paddingRight);
    // 帯の画像の高さを 0 にしたときにスライドに使える高さ。画像の幅 w ではスライドの幅は (それ - w × 9/16) × 16/9 になる
    const availH = viewport.offsetHeight + cur - parseFloat(vs.paddingTop) - parseFloat(vs.paddingBottom);
    return Math.max(MIN_W, Math.min(availW / 4, availH * 16 / 45));
  }
  function size() {
    const w = Math.round(Math.max(MIN_W, Math.min(maxW(), want)));
    strip.style.setProperty('--thumb-w', `${w}px`);
    return w;
  }
  tip(grip, S.stripResize);
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId); grip.classList.add('on'); document.body.classList.add('resizing-y');
    const y0 = e.clientY, w0 = size();
    const move = ev => { want = Math.max(MIN_W, Math.min(maxW(), w0 + (y0 - ev.clientY) * 16 / 9)); size(); };
    const up = () => { grip.removeEventListener('pointermove', move); grip.classList.remove('on'); document.body.classList.remove('resizing-y'); want = size(); pref('stripW', want); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, { once: true });
  });
  grip.addEventListener('keydown', e => {
    const d = { ArrowUp: 16, ArrowDown: -16 }[e.key];
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    want = size() + d; want = size(); pref('stripW', want);
  });
  const fit = new ResizeObserver(() => size());
  fit.observe(stage);

  // ------------------------------------------------------------ 縮小画像と step めくり
  const thumbs = shotThumbs(strip, () => shots, i => i === ctx.preview.index ? ctx.preview.step : 0);
  // 再描画までは元の index を維持し、画像とクリック先を同じページに結び付ける。
  const reorder = makePageReorder(ctx, { optimisticMove(page, before) {
    const original = [...strip.querySelectorAll('button[data-index]')];
    const source = original.find(b => ctx.preview.pageOfSlide(+b.dataset.index) === page);
    const target = original.find(b => {
      const p = ctx.preview.pageOfSlide(+b.dataset.index);
      return p != null && p >= before;
    });
    if (!source) return () => {};
    const renumber = () => {
      strip.querySelectorAll('button[data-index]').forEach((b, i) => {
        b.querySelector('.num').textContent = i + 1;
        b.dataset.tip = S.gotoSlide(i + 1);
      });
      overview.render(); prioritize();
    };
    strip.insertBefore(source, target || null);
    renumber();
    return () => {
      if (!alive || !original.every(b => b.isConnected)) return;
      original.forEach(b => strip.append(b)); renumber();
    };
  } });
  reorder.attach(strip);
  reorder.attach(root.querySelector('#qblocks'), true);
  const overview = makeOverview(ctx, { shots: () => shots, changed: prioritize, reorder });
  const decorate = () => { thumbs.decorate(); overview.decorate(); };

  async function load() {
    const d = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/shots`);
    if (!alive) return;
    shots = d.slides; decorate();
  }
  size(); prioritize();
  load().catch(e => toast(e.message));

  return {
    stripRendered() { thumbs.decorate(); reorder.decorate(strip); overview.render(); size(); prioritize(); },
    previewLoaded() { reorder.previewLoaded(); },
    // 今のページの縮小画像は今の step にそろえる
    slideChanged() {
      thumbs.rest();
      prioritize();
    },
    keydown: e => overview.keydown(e),
    event(ev) { if (ev.type === 'shots') { shots = ev.slides; decorate(); } },
    destroy() {
      alive = false; fit.disconnect(); stripFit.disconnect(); visibility.disconnect();
      strip.removeEventListener('scroll', prioritize); cancelAnimationFrame(priorityFrame);
      wantedPriority = '[]'; sendPriority(); overview.destroy(); reorder.destroy();
    },
  };
}
