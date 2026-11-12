// 段と図内の step を、操作バーと同じ通し番号で表示する。初期表示の動く図にも範囲を付ける。
import { S } from '../strings.js';
import { figureSteps, stepLabel } from '../step-badge.js';

const stage = document.querySelector('#stage');
const layer = document.createElement('div');
layer.id = 'slide-studio-steps';
stage.append(layer);

// 1項目ずつの包みは、包みではなく中の各項目に出す
const marked = page => [
  ...[...page.querySelectorAll('[data-step], [data-highlight-step]')]
    .filter(el => !el.querySelector('[data-slide-studio-step-generated]')),
  ...[...page.querySelectorAll('.animation')].filter(el => !el.closest('[data-step]') && figureSteps([el]) > 0),
];

// 文字と画像・図・数式が実際に占める範囲（無ければ要素の箱）
function contentRect(el) {
  const rs = [], range = document.createRange(), walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.data.trim()) { range.selectNodeContents(n); rs.push(...range.getClientRects()); }
  el.querySelectorAll('img, iframe, svg, math, video, canvas').forEach(x => rs.push(x.getBoundingClientRect()));
  if (el.matches('img, iframe, .animation')) rs.push(el.getBoundingClientRect());
  const box = rs.filter(r => r.width || r.height);
  if (!box.length) { const r = el.getBoundingClientRect(); return r.width || r.height ? r : null; }
  return { top: Math.min(...box.map(r => r.top)), right: Math.max(...box.map(r => r.right)) };
}
function draw() {
  layer.replaceChildren();
  const page = stage.querySelector(':scope > .slide.active'); if (!page) return;
  const s = stage.getBoundingClientRect(), k = s.width / 1280 || 1;
  for (const el of marked(page)) {
    // 中身（文字・画像・図）の範囲の右に置く。項目や段落の箱は横に広いので、箱の右端だと離れてしまう
    const r = contentRect(el);
    if (!r) continue;
    const highlight = el.dataset.highlightStep != null && el.dataset.step == null;
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'slide-studio-step-badge';
    b.classList.toggle('pending', highlight ? !el.classList.contains('is-highlighted') : el.classList.contains('pending'));
    const stage = Number((highlight ? el.dataset.highlightStep : el.dataset.step) || 0), n = highlight ? 0 : figureSteps([el]);
    const first = window.deck?.stageNumber(stage) ?? stage + 1;
    b.dataset.range = String(n > 0);
    b.textContent = stepLabel(first, first + n);
    b.dataset.slideStudio = el.closest('[data-slide-studio]')?.dataset.slideStudio || el.querySelector('[data-slide-studio]')?.dataset.slideStudio || '';
    b.title = S.qb.stepBadge(stage, stage, n, b.classList.contains('pending'));
    b.setAttribute('aria-label', b.title);
    layer.append(b);
    // スライドの右の外に出るときは中身の右上の内側に寄せる
    const x = Math.min((r.right - s.left) / k + 10, 1280 - b.offsetWidth - 6);
    Object.assign(b.style, { left: `${x}px`, top: `${(r.top - s.top) / k}px` });
  }
}
let frame = 0;
const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); };
// 印の層を描き直した分（自分の変更）では描き直さない
const observer = new MutationObserver(records => { if (records.some(r => !layer.contains(r.target))) schedule(); });
observer.observe(stage, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'data-step', 'data-highlight-step'] });
new ResizeObserver(schedule).observe(stage);
addEventListener('resize', schedule);
addEventListener('deckchange', schedule);
document.addEventListener('load', e => { if (e.target.tagName === 'IMG') schedule(); }, true);
Promise.resolve(window.deckLoaded).then(() => document.fonts.ready).then(schedule);
