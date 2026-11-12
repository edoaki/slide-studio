// Slide Studio の図の runtime。元：quarto-html html/shared/runtime.mjs。設計書 §5.3。
// figure.mjs の {id, title, steps, renderStep(k), transition?(from, to)} を #stage に描く。
// window.animation = {steps, step, stepNames, settled, setStep(k, animate), setVisible(v), svg()} を公開する。
// settled は SVG の更新と補間に加え、図の文書のフォントと画像の decode が終わってから解決する。
import {createMotion} from './motion.mjs';

const CHANNEL = 'slide-studio-figure';

// レイアウトを確定させてからフォントを待つ（使われたフォントの読み込みはレイアウトで始まる）
async function assetsReady() {
  void document.body.offsetHeight;
  const images = [...document.images].map(img => img.decode().catch(() => {}));
  await Promise.all([document.fonts.ready, ...images]);
  if ([...document.fonts].some(f => f.status === 'loading')) await document.fonts.ready;
}

// 描かれている範囲を測る対象（入れ物・定義・不可視の要素は除く）
const INK = 'text,circle,ellipse,line,path,polygon,polyline,rect,image,use,foreignObject';
const SKIP = 'defs,clipPath,mask,marker,pattern,symbol,linearGradient,radialGradient,filter,title,desc,style';
const hidden = (e, svg) => {
  for (let a = e; a && a !== svg; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return true;
  }
  const s = getComputedStyle(e);
  return e.tagName !== 'text' && e.tagName !== 'image' && (s.fill === 'none' || s.fillOpacity === '0') && (s.stroke === 'none' || s.strokeOpacity === '0');
};

// 描いた範囲の外に必ず残すバッファ（スライドの px）。動く図が枠の端に触れないようにする。
// 図の枠の角もこの大きさで丸める（base.css の .animation iframe）
const BUFFER = 12;

// 全 step の描画範囲 [x, y, 幅, 高さ]（viewBox の単位）。切り詰められない図は null。
// 非表示のページの iframe はレイアウトされず測れないため、呼ぶ側が表示されてから呼ぶ。
function inkBox(fig, stage) {
  let box = null, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < fig.steps.length; k++) {
    const svg = document.importNode(new DOMParser().parseFromString(fig.renderStep(k), 'image/svg+xml').documentElement, true);
    const vb = svg.viewBox?.baseVal;
    if (!vb || !vb.width || !vb.height) return null;
    box ??= [vb.x, vb.y, vb.width, vb.height];
    // 1単位=1px で置いて測る（#stage の大きさに左右されない）。描画前に外すので隠さない
    svg.style.cssText = `position:absolute;left:0;top:0;width:${vb.width}px;height:${vb.height}px;pointer-events:none`;
    stage.append(svg);
    const r0 = svg.getBoundingClientRect();
    for (const e of svg.querySelectorAll(INK)) {
      if (e.closest(SKIP) || hidden(e, svg)) continue;
      const r = e.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.width >= vb.width * .9 && r.height >= vb.height * .9) continue; // 背景の面
      x0 = Math.min(x0, r.left - r0.left + vb.x); x1 = Math.max(x1, r.right - r0.left + vb.x);
      y0 = Math.min(y0, r.top - r0.top + vb.y); y1 = Math.max(y1, r.bottom - r0.top + vb.y);
    }
    svg.remove();
  }
  if (!box || !(x1 > x0 && y1 > y0)) return null;
  return [x0, y0, x1 - x0, y1 - y0];
}

// 描画範囲にバッファを足した viewBox（文字列）。それより外の余白は列とスライドの配置で取る（図の縦横比は親が列の幅に使う）。
// 図は枠の高さに合わせて描かれるので、BUFFER px を今の枠の高さ H から viewBox の単位に直す。
// 書いた viewBox の外にはみ出してもバッファを残す
function padded([x0, y0, w, h], H) {
  const pad = H > 4 * BUFFER ? BUFFER * h / (H - 2 * BUFFER) : h / 8;
  return [x0 - pad, y0 - pad, w + 2 * pad, h + 2 * pad].map(v => +v.toFixed(1)).join(' ');
}

export function mount(fig) {
  if (!fig || !Array.isArray(fig.steps) || !fig.steps.length || typeof fig.renderStep !== 'function')
    throw Error('figure.mjs は {steps: [...], renderStep(k)} を export default してください');
  const embedded = window.parent !== window, stage = document.querySelector('#stage');
  // スライドの中では外周の余白を切り詰める（fit: false の図は書いたままの viewBox）。
  // 表示されて初めて測れるので表示時に測り、測った時点でフォントが読み込み中なら、読み込み後に測り直す
  let fit = null, ink = null, fitHeight = 0, fitState = embedded ? 'todo' : 'done'; // todo → measured（仮）→ done
  const fitted = markup => fit ? markup.replace(/viewBox="[^"]*"/, `viewBox="${fit}"`) : markup;
  function measureFit() {
    if (fitState === 'done' || !innerWidth) return;
    ink = fig.fit === false ? null : inkBox(fig, stage);
    fitState = document.fonts.status === 'loaded' ? 'done' : 'measured';
    applyFit();
  }
  function applyFit() {
    fitHeight = innerHeight;
    fit = ink && padded(ink, fitHeight);
    if (fit) stage.querySelector('svg')?.setAttribute('viewBox', fit);
    // 最初に測るときはまだ描いていないので、切り詰めた viewBox から求める
    if (fit) { const [, , w, h] = fit.split(' ').map(Number); api.ratio = w / h; } else setRatio();
  }
  // 縦横比を渡すと枠の高さが変わる（列の幅で決まる図など）。今の高さでバッファを取り直し、親に縦横比を渡し直してもらう
  addEventListener('resize', () => {
    if (!ink || !innerHeight || Math.abs(innerHeight - fitHeight) <= 1) return;
    applyFit(); post('ratio');
  });
  function setRatio() {
    const vb = stage.querySelector('svg')?.viewBox?.baseVal;
    if (vb?.width && vb.height) api.ratio = vb.width / vb.height;
  }
  let holdTimer, lastStepInput = -Infinity;
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  let step = 0, visible = !embedded, pointer = null, generation = 0, transitioning = false;
  const motion = createMotion(stage);
  document.title = fig.title || fig.id || document.title;
  const h = document.querySelector('header h1'); if (h) h.textContent = document.title;
  const label = document.querySelector('header .slide-studio-step');
  const post = (type, data = {}) => { try { parent.postMessage({channel: CHANNEL, type, figureId: fig.id, ...data}, '*'); } catch { /* 親が無い */ } };
  let cancelWait = null;
  const wait = ms => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); cancelWait = null; resolve(); };
    const timer = setTimeout(finish, ms); cancelWait = finish;
  });
  const stop = () => { cancelWait?.(); generation++; transitioning = false; motion.cancel(); fig.stop?.(); };
  async function render(k, animate = true) {
    if (!Number.isInteger(k) || k < 0 || k >= fig.steps.length) return;
    const from = step, interrupted = transitioning; stop(); const ticket = generation; step = k; stage.dataset.step = k;
    if (label) label.textContent = `${k + 1} / ${fig.steps.length}　${fig.steps[k] ?? ''}`;
    const duration = animate && !interrupted && visible && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 650 : 0;
    const frames = duration && fig.transition ? fig.transition(from, k) : null;
    transitioning = duration > 0;
    if (frames?.length) {
      for (const f of frames) {
        if (ticket !== generation) return;
        if (f.hold) { await wait(f.hold); if (ticket !== generation) return; }
        await motion.update(fitted(f.markup), f.duration ?? duration);
      }
      // 遷移の最後は renderStep(k) と同じ表示にそろえる（直接 k に飛んだ場合と一致させる）
      if (ticket === generation) await motion.update(fitted(fig.renderStep(k)), 0);
    } else await motion.update(fitted(fig.renderStep(k)), duration);
    if (ticket === generation) transitioning = false;
  }
  const settle = p => {
    const ticket = generation;
    return p.then(() => { if (ticket === generation) return assetsReady().then(() => { if (fitState === 'measured') measureFit(); if (!api.ratio) setRatio(); }); });
  };
  function action(a) {
    if (document.hidden) return;
    if (embedded) { if (visible) post('navigate', {direction: a}); return; }
    const now = performance.now(), isStep = a === 'next' || a === 'prev', instant = isStep && now - lastStepInput <= 300;
    lastStepInput = isStep ? now : -Infinity;
    if (a === 'page-next' || a === 'page-prev') return;
    if (a === 'last' || a === 'first') { api.setStep(a === 'last' ? fig.steps.length - 1 : 0, false); return; }
    api.setStep(Math.max(0, Math.min(fig.steps.length - 1, step + (a === 'next' ? 1 : -1))), !instant);
  }
  const interactive = t => t.closest('a,button,input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="button"]');
  document.addEventListener('keydown', e => {
    const keys = {ArrowLeft: 'prev', ArrowRight: 'next', ArrowUp: 'page-prev', ArrowDown: 'page-next'};
    if (interactive(e.target) || !keys[e.key] || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) {
      cancelHold(); action(keys[e.key]);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') holdTimer = setTimeout(() => action(e.key === 'ArrowRight' ? 'last' : 'first'), 500);
    }
  });
  document.addEventListener('keyup', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') cancelHold(); });
  window.addEventListener('blur', cancelHold);
  document.addEventListener('pointerdown', e => { pointer = e.button === 0 && !interactive(e.target) ? {x: e.clientX, y: e.clientY, dragged: false} : null; });
  document.addEventListener('pointermove', e => { if (pointer && Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 5) pointer.dragged = true; });
  document.addEventListener('pointercancel', () => { pointer = null; });
  document.addEventListener('click', e => {
    const start = pointer; pointer = null;
    if (embedded || e.button !== 0 || interactive(e.target) || getSelection().toString() || !start || start.dragged) return;
    action('next');
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelHold(); stop(); motion.update(fitted(fig.renderStep(step)), 0); } });
  window.addEventListener('pagehide', stop);
  const api = window.animation = {
    steps: fig.steps.length - 1, stepNames: [...fig.steps], step: 0, id: fig.id, title: fig.title || '',
    // 図の縦横比（幅÷高さ）。表示されて測れてから入る。親は列の幅をこれで決める
    ratio: null,
    settled: Promise.resolve(),
    setVisible(value) {
      if (value) measureFit();
      if (visible === value) return;
      visible = value;
      if (!value && transitioning) this.settled = settle(render(step, false));
      // 非表示中には未使用だったフォントも、ページを開いた時点で待つ。
      if (value) this.settled = settle(Promise.resolve());
    },
    setStep(k, animate = false) {
      k = Math.max(0, Math.min(this.steps, k));
      if (!Number.isInteger(k)) return this.settled;
      if (k === step && (!transitioning || animate)) return this.settled;
      this.step = k;
      this.settled = settle(render(k, animate)); return this.settled;
    },
    svg() { return stage.innerHTML; },
    render: k => fitted(fig.renderStep(k)),
  };
  if (embedded) document.body.classList.add('embedded');
  measureFit();
  api.settled = settle(render(0, false));
}
