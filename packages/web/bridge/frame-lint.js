import {layoutIssues} from '../inject/layout-check.js';
export function createFrameLint(window,document,{sendEvent,getSourceVersion}) {
const stage = document.querySelector('#stage');
const slides = [...document.querySelectorAll('#stage > .slide')];
let issues = [], timer = 0;
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
  issues = out;
  draw();
  sendEvent('edit.lint',{sourceVersion:getSourceVersion(),issues:portable()});
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
document.addEventListener('load', e => { if (['IMG','LINK'].includes(e.target.tagName)) schedule(); }, true);
window.addEventListener('deckchange', () => {draw();schedule();});
window.addEventListener('resize', schedule);
Promise.all([window.deckLoaded, document.fonts.ready]).then(measure);

function portable(){return issues.slice(0,2048).map(x=>({slide:x.slide,block:x.block??null,message:String(x.message).slice(0,16384),short:String(x.short??x.message).slice(0,16384),side:x.side??null,rects:(x.rects||[]).slice(0,256),area:x.area??null}));}
return {refresh:schedule,get issues(){return portable();}};

}
