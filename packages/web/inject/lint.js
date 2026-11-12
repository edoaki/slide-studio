// 編集中のレイアウトの検査（設計書 §9.4）。書き出しの検査と同じ判定（layout-check.js）で全ページを測り、
// 表示中のページの問題をスライドの上に描く（問題の要素の枠・重なった所の斜線・スライドの外に出た量）。色はすべて警告の黄色。
// step で後から出る中身も場所は取るので、隠れている中身も含めて測る。結果は親画面へ slideStudioLint.subscribe で渡す。
import { layoutIssues } from './layout-check.js';

const stage = document.querySelector('#stage');
const slides = [...document.querySelectorAll('#stage > .slide')];
const listeners = new Set();
let issues = [], measured = false, timer = 0;
const layer = document.createElement('div');
layer.id = 'slide-studio-lint'; layer.setAttribute('aria-hidden', 'true');
stage.append(layer);

// 表示していないページも一時的に表示して測る（同じ処理の中で戻すので画面には出ない）
function measure() {
  clearTimeout(timer);
  const out = [];
  slides.forEach((s, i) => {
    const shown = s.classList.contains('active');
    if (!shown) s.classList.add('active');
    try { for (const x of layoutIssues({ root: s, allSteps: true })) out.push({ ...x, slide: i }); }
    finally { if (!shown) s.classList.remove('active'); }
  });
  observer.takeRecords(); // 測るために足し引きした分は変更として扱わない
  issues = out; measured = true;
  draw();
  listeners.forEach(fn => fn(issues));
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(measure, 80); };

const ARROW = { bottom: '↓', top: '↑', left: '←', right: '→' };
function draw() {
  layer.replaceChildren();
  const i = window.deck?.index ?? 0;
  const here = issues.filter(x => x.slide === i);
  const add = (cls, r, text = '') => {
    const d = document.createElement('div');
    d.className = cls; d.textContent = text;
    if (r) Object.assign(d.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    layer.append(d);
    return d;
  };
  for (const x of here) {
    for (const r of x.rects) add('slide-studio-lint-box', r);
    if (x.area) add('slide-studio-lint-area', x.area);
    if (x.kind === 'overflow') {
      // スライドの外に出た分は見えないので、出た辺に量を書く
      const r = x.rects[0], tab = add('slide-studio-lint-tab', null, `${ARROW[x.side]} ${x.amount}px`);
      tab.dataset.side = x.side;
      if (x.side === 'bottom' || x.side === 'top') tab.style.left = `${Math.max(0, Math.min(r.x + r.w / 2, 1280))}px`;
      else tab.style.top = `${Math.max(0, Math.min(r.y + r.h / 2, 720))}px`;
    }
  }
}

// 中身・大きさが変わったら測り直す。選択の枠・step の表示切り替え・ページの切り替えは測り直さない
const plain = v => (v || '').split(/\s+/).filter(c => c && !c.startsWith('slide-studio-') && c !== 'pending' && c !== 'active').sort().join(' ');
const cosmetic = r => r.type === 'attributes' && (
  (r.attributeName === 'class' && plain(r.oldValue) === plain(r.target.getAttribute('class')))
  || ['data-slide-studio-layer', 'contenteditable', 'aria-hidden'].includes(r.attributeName));
const observer = new MutationObserver(records => { if (!records.every(cosmetic)) schedule(); });
slides.forEach(s => observer.observe(s, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true }));
document.addEventListener('load', e => { if (e.target.tagName === 'IMG') schedule(); }, true);
addEventListener('deckchange', draw);
Promise.all([window.deckLoaded, document.fonts.ready]).then(measure);

window.slideStudioLint = {
  get issues() { return issues; },
  // fn(issues) を測るたびに呼ぶ。測り終えていれば今の結果ですぐに呼ぶ。戻り値で止める
  subscribe(fn) { listeners.add(fn); if (measured) fn(issues); return () => listeners.delete(fn); },
  refresh: measure,
};
