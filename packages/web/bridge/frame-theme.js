import { THEME_KEYS } from './theme-contract.js';
const FILL = '--header-fill';
// 背景はページ・章・タイトル（表紙）で別々。順はタブの並び
const BGS = ['--background-fill', '--section-fill', '--cover-fill'];
const FILLS = [FILL, ...BGS];
const KIND = {
  '--background-fill': s => !s.matches('.cover, .section-slide'),
  '--section-fill': s => s.matches('.section-slide'),
  '--cover-fill': s => s.matches('.cover'),
};
const LIVE_ID = { '--background-fill': 'theme-live-background', '--section-fill': 'theme-live-background-section', '--cover-fill': 'theme-live-background-cover' };
const KIND_CSS = { '--background-fill': '#stage .slide:not(.cover):not(.section-slide)', '--section-fill': '#stage .slide.section-slide', '--cover-fill': '#stage .slide.cover' };
const SAMPLE_URL = '/files/decks/__theme-sample__/sample.html';
// 見本のページ（0 表紙・1 見出しと本文・2 ハイライトと表）。地は今のページのまま
const PAGE = { '--link': 2, '--mark': 2, '--mark-ink': 2, '--rule': 2, '--paper': null, '--table-header-bg': 2, '--table-header-ink': 2, '--table-ink': 2, '--math-ink': 2 };
const CONTENT = {
  '--table-header-bg': ['table th', 'background'],
  '--table-header-ink': ['table th', 'color'],
  '--table-ink': ['table td', 'color'],
  '--math-ink': [':is(.math, math)', 'color'],
};
const TEXT = ['color', '-webkit-text-fill-color', 'font-family'];
// 地・枠など。枠・下線の色は文字の色に付いて変わるので、描かれているものだけを比べる
const box = (s, svgEl) => [s.backgroundColor, s.backgroundImage, s.boxShadow,
  ...['top', 'right', 'bottom', 'left'].map(d => s.getPropertyValue(`border-${d}-style`) !== 'none' && parseFloat(s.getPropertyValue(`border-${d}-width`)) ? s.getPropertyValue(`border-${d}-color`) : ''),
  s.outlineStyle !== 'none' ? s.outlineColor : '', s.textDecorationLine !== 'none' ? s.textDecorationColor : '',
  svgEl ? s.fill + s.stroke : ''].join('|');

function hex(value) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = value; c.fillRect(0, 0, 1, 1);
  return '#' + [...c.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
}

// その変数で見た目が変わる所（変数を一瞬だけ別の値にして、計算後のスタイルを比べる）。
// 文字の色・フォントはその文字だけ、地・枠などは要素、ページの地はページ全体
function partsOf(w, slide, key) {
  const root = w.document.documentElement;
  // 色のプローブを transition の途中値で比較しない。復元まで無効化する。
  const probe = w.document.createElement('style');
  probe.textContent = '#stage *, #stage *::before, #stage *::after { transition: none !important; }';
  w.document.head.append(probe);
  const active = slide.classList.contains('active');
  slide.classList.add('active');
  // 自動生成のページ番号は本文・見出しの見本には数えない。
  // 見本表示中は実スライドの iframe 自体が隠れるので、矩形ではなく内部の CSS で判定する。
  const visible = e => {
    if (w.getComputedStyle(e).visibility !== 'visible') return false;
    for (let n = e; n && n !== slide.parentElement; n = n.parentElement)
      if (w.getComputedStyle(n).display === 'none') return false;
    return true;
  };
  const els = [slide, ...slide.querySelectorAll('*')].filter(e => !e.closest('.page-number') && visible(e));
  const snap = () => els.map(e => {
    const s = w.getComputedStyle(e), svgEl = e instanceof w.SVGElement;
    return { text: TEXT.map(p => s.getPropertyValue(p)).join('|'), box: box(s, svgEl),
      pseudo: ['::before', '::after'].map(p => {
        const ps = w.getComputedStyle(e, p);
        return ps.content === 'none' || ps.content === 'normal' || ps.display === 'none' ? '' : box(ps, false);
      }).join('|') };
  });
  // 見出しの背景・文字は、テーマ標準の変数の使い方によらず編集対象を示す。
  if (key === '--header' || key === '--header-ink') {
    const headings = [...slide.querySelectorAll('h2')].filter(visible);
    const parts = key === '--header' ? headings : headings.flatMap(h => {
      const walker = w.document.createTreeWalker(h, NodeFilter.SHOW_TEXT), nodes = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim()) nodes.push(n);
      return nodes;
    });
    if (!active) slide.classList.remove('active');
    probe.remove();
    return parts;
  }
  if (CONTENT[key]) {
    const parts = [...slide.querySelectorAll(CONTENT[key][0])].filter(visible);
    if (!active) slide.classList.remove('active');
    probe.remove();
    return parts;
  }
  const before = snap(), old = root.style.getPropertyValue(key);
  root.style.setProperty(key, key.startsWith('--font-') ? 'slide-studio-probe, monospace' : 'rgb(1, 2, 3)');
  const after = snap();
  if (old) root.style.setProperty(key, old); else root.style.removeProperty(key);
  const texts = new Set(), list = [], loose = [];
  els.forEach((e, i) => {
    if (before[i].text !== after[i].text) texts.add(e);
    if (before[i].box !== after[i].box) list.push(e);
    else if (before[i].pseudo !== after[i].pseudo) {
      // 疑似要素（ページの下の線など）。位置を決めてあるものはその所だけ、ほかは持ち主を囲む（ページ自体は、ほかに何も無いときだけ）
      const placed = ['::before', '::after'].filter(which => ['absolute', 'fixed'].includes(w.getComputedStyle(e, which).position));
      if (placed.length) placed.forEach(which => list.push({ host: e, which }));
      else (e === slide ? loose : list).push(e);
    }
  });
  const walk = w.document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.data.trim() && texts.has(n.parentElement)) list.push(n);
  if (!active) slide.classList.remove('active');
  // 復元後の値を確定してから transition を戻す。
  snap(); probe.remove();
  return list.length ? list : loose;
}

// 位置を決めた疑似要素の画面上の四角（ページは縮小して出しているので、その倍率を掛ける）
function pseudoRect(w, e, which) {
  const s = w.getComputedStyle(e, which), r = e.getBoundingClientRect(), k = r.width / (e.offsetWidth || r.width) || 1;
  const px = v => parseFloat(v) || 0;
  const width = px(s.width) + px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth);
  const height = px(s.height) + px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth);
  const left = s.left !== 'auto' ? px(s.left) : (e.offsetWidth || 0) - px(s.right) - width;
  const top = s.top !== 'auto' ? px(s.top) : (e.offsetHeight || 0) - px(s.bottom) - height;
  return new DOMRect(r.left + left * k, r.top + top * k, width * k, height * k);
}


export function createFrameTheme(win, doc, {sendEvent,getSourceVersion}) {
 let vars={},live=new Map(),shown=false,sample=false,marks=[],markFrame=0,gradient=null;
 const w=win;
 const slides=()=>Array.from(doc.querySelectorAll('#stage > .slide'));
 const active=()=>doc.querySelector('#stage > .slide.active');
 const keys=()=>Object.keys(vars).filter(k=>THEME_KEYS.includes(k));
 function clear(){cancelAnimationFrame(markFrame);markFrame=0;marks=[];doc.getElementById('slide-studio-theme-marks')?.remove();}
 function mark(key){clear();const slide=active();if(slide&&key&&!KIND[key])marks=partsOf(win,slide,key).slice(0,1).map(n=>({n,w:win,page:n===slide}));place();return marks.length;}
  const hexOf = k => k.startsWith('--block-') || k.startsWith('--heading-') ? vars[k] : k.startsWith('--font-') || FILLS.includes(k) ? vars[k] : hex(vars[k]);
  // テーマ標準では変数と描画色が一致しないことがある。単色の欄は実際の色に合わせる。
  function contentColor(key) {
    if (live.has(key)) return live.get(key);
    const w = win;
    const el = w?.document.querySelector(`#stage .slide.active ${CONTENT[key][0]}`) || w?.document.querySelector(`#stage ${CONTENT[key][0]}`);
    if (!el) return hexOf(key);
    if (CONTENT[key][1] === 'color') return hex(w.getComputedStyle(el).color);
    for (let n = el; n; n = n.parentElement) {
      const color = w.getComputedStyle(n).backgroundColor;
      if (color !== 'transparent' && !/,\s*0\)$/.test(color)) return hex(color);
    }
    return hexOf('--paper');
  }
  function headingColor(key) {
    if (live.has(key)) return live.get(key);
    for (const w of [win]) {
      const h = [...w.document.querySelectorAll('#stage .slide:not(.cover):not(.section-slide) > h2')]
        .find(h => w.getComputedStyle(h).display !== 'none');
      if (!h) continue;
      const style = w.getComputedStyle(h);
      if (key === '--header-ink') return hex(style.color);
      // グラデーションは単色に置き換えず、その基準色を表示する。
      if (style.backgroundImage !== 'none') return hexOf(key);
      for (let el = h; el; el = el.parentElement) {
        const color = w.getComputedStyle(el).backgroundColor;
        if (color !== 'transparent' && !/,\s*0\)$/.test(color)) return hex(color);
      }
      return hexOf('--paper');
    }
    return hexOf(key);
  }

 function colors(){return Object.fromEntries(keys().filter(k=>!k.startsWith('--font-')&&!k.startsWith('--block-')&&!k.startsWith('--heading-')&&!FILLS.includes(k)).map(k=>[k,CONTENT[k]?contentColor(k):['--header','--header-ink'].includes(k)?headingColor(k):hexOf(k)]));}
 function inspect(key){return {colors:colors(),matches:key?slides().flatMap((slide,i)=>(KIND[key]?KIND[key](slide):partsOf(win,slide,key).length)?[i]:[]):[],index:win.deck?.index??0};}
 function paint(){
      const root = w.document.documentElement;
      // 保存前の色面操作でも表紙・章扉を通常ページの見出しから独立させる。
      let titleColors = w.document.getElementById('theme-live-title-colors');
      if (live.has('--header')) {
        if (!titleColors) {
          titleColors = w.document.createElement('style'); titleColors.id = 'theme-live-title-colors';
          const title = w.document.querySelector('#stage .slide:is(.cover,.section-slide)');
          const value = title ? w.getComputedStyle(title).getPropertyValue('--header').trim() : vars['--header'];
          titleColors.textContent = `#stage .slide:is(.cover,.section-slide) { --header:${value}; }`;
          w.document.head.append(titleColors);
        }
      } else titleColors?.remove();
      let tableColors = w.document.getElementById('theme-live-table-header');
      if (live.has('--header')) {
        if (!tableColors) {
          tableColors = w.document.createElement('style'); tableColors.id = 'theme-live-table-header';
          const table = w.document.querySelector('#stage table');
          const value = table ? w.getComputedStyle(table).getPropertyValue('--header').trim() : vars['--header'];
          tableColors.textContent = `#stage table { --header:${value}; }`;
          w.document.head.append(tableColors);
        }
      } else tableColors?.remove();
      for (const [key, [selector, prop]] of Object.entries(CONTENT)) {
        let style = w.document.getElementById(`theme-live${key}`);
        if (live.has(key)) {
          if (!style) { style = w.document.createElement('style'); style.id = `theme-live${key}`; w.document.head.append(style); }
          style.textContent = `#stage ${selector}${prop === 'color' ? `, #stage ${selector} *` : ''} { ${prop}:var(${key}); }`;
        } else style?.remove();
      }
      root.classList.toggle('slide-studio-theme-preview', shown);
      for (const k of Object.keys(vars)) if (!live.has(k)) { if (k.startsWith('--heading-')) root.style.setProperty(k, vars[k]); else root.style.removeProperty(k); }
      live.forEach((v, k) => root.style.setProperty(k, v));
      let override = w.document.getElementById('theme-live-heading');
      if ((live.has('--header') || live.has('--header-ink') || live.has(FILL)) && (live.has('--header') || (live.get(FILL) ?? vars[FILL]) !== 'theme')) {
        if (!override) { override = w.document.createElement('style'); override.id = 'theme-live-heading'; w.document.head.append(override); }
        root.style.setProperty(FILL, live.get(FILL) ?? (vars[FILL] === 'theme' ? 'var(--header)' : vars[FILL]));
        override.textContent = '#stage h2 { background: var(--header-fill); } #stage h2, #stage h2 * { color: var(--header-ink); } #stage .cover .cover-title, #stage .cover .cover-title p { color: var(--header); }';
      } else override?.remove();
      let ink = w.document.getElementById('theme-live-heading-ink');
      if (live.has('--header-ink')) {
        if (!ink) { ink = w.document.createElement('style'); ink.id = 'theme-live-heading-ink'; w.document.head.append(ink); }
        ink.textContent = '#stage h2, #stage h2 * { color: var(--header-ink); }';
      } else ink?.remove();
      let rule = w.document.getElementById('theme-live-heading-rule');
      if (live.has('--rule')) {
        if (!rule) { rule = w.document.createElement('style'); rule.id = 'theme-live-heading-rule'; w.document.head.append(rule); }
        rule.textContent = '#stage h2 { border-color: var(--rule); } #stage h2::after { background-color: var(--rule); }';
      } else rule?.remove();
      let options = w.document.getElementById('theme-live-options');
      if ([...live.keys()].some(k => k.startsWith('--heading-'))) {
        if (!options) { options = w.document.createElement('style'); options.id = 'theme-live-options'; w.document.head.append(options); }
        const mode = live.get('--heading-mode') ?? vars['--heading-mode'];
        options.textContent = mode === 'rule' ? `#stage .slide > h2 {position:relative;background:none;border:0;box-shadow:none} #stage .slide > h2::after {content:'';display:block;position:absolute;left:var(--heading-rule-inset);right:var(--heading-rule-inset);bottom:0;width:auto;height:0;margin:0;background:none;border:0;border-bottom:var(--heading-rule-width) var(--heading-rule-style) var(--rule)}` : mode === 'fill' ? '#stage .slide > h2 {background:var(--header-fill, var(--header));border:0;box-shadow:none} #stage .slide > h2, #stage .slide > h2 * {color:var(--header-ink)} #stage .slide > h2::after {display:none}' : '';
      } else options?.remove();
      for (const key of BGS) {
        let background = w.document.getElementById(LIVE_ID[key]);
        if (live.has(key) && live.get(key) !== 'theme') {
          if (!background) { background = w.document.createElement('style'); background.id = LIVE_ID[key]; w.document.head.append(background); }
          background.textContent = `${KIND_CSS[key]} { background: var(${key}); box-shadow: none; }`;
        } else background?.remove();
      }

 if(marks.length)place();return {colors:colors()};
 }
  function place(resize = true) {
    const w = marks[0]?.w; if (!w) return;
    // 外枠の ResizeObserver と順序が前後しても、最新の縮尺で囲みを測る。
    if (resize) w.deck?.resize();
    let layer = w.document.getElementById('slide-studio-theme-marks');
    if (!layer) {
      layer = w.document.createElement('div'); layer.id = 'slide-studio-theme-marks';
      layer.innerHTML = `<style>#slide-studio-theme-marks>i{position:fixed;pointer-events:none;z-index:2147483647;border:1px solid #748baa99;border-radius:3px}</style>`;
      w.document.body.append(layer);
    }
    let placed = false;
    for (const { n, page } of marks) {
      let rects;
      if (n.nodeType === 3) { const r = w.document.createRange(); r.selectNodeContents(n); rects = [...r.getClientRects()]; }
      else if (n.which) rects = [pseudoRect(w, n.host, n.which)];
      else rects = [n.getBoundingClientRect()];
      for (const r of rects) {
        if (!r.width || !r.height) continue;
        const pad = page ? -3 : 3, i = layer.querySelector('i') || w.document.createElement('i');
        const geometry = [r.left - pad, r.top - pad, r.width + pad * 2, r.height + pad * 2].join(',');
        if (i.dataset.geometry !== geometry) {
          Object.assign(i.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
          i.dataset.geometry = geometry;
        }
        if (!i.isConnected) layer.append(i);
        placed = true;
        break;
      }
    }
    if (!placed) layer.querySelector('i')?.remove();
    // フォント・図の遅延読み込みなど、外枠のサイズが変わらない再配置にも追従する。
    // 強調は1か所だけ測り、位置が変わったときだけ DOM を更新する。
    if (!markFrame) markFrame = requestAnimationFrame(() => { markFrame = 0; if (marks.length) place(false); });
  }

 function click(e){
  if(!shown||!e.isTrusted||gradient)return;
  const el=e.target.closest?.('#stage > .slide.active *')||e.target.closest?.('#stage > .slide.active');
  if(!el||el.closest('[contenteditable="true"]'))return;
  if(sample){e.preventDefault();e.stopImmediatePropagation();}
  if(e.type!=='click')return;
  const slide=el.closest('.slide'),candidates=keys().filter(k=>!k.startsWith('--font-')&&!FILLS.includes(k)&&k!=='--mark-line'&&k!=='--paper');
  candidates.sort((a,b)=>a==='--mark'?-1:b==='--mark'?1:0);
  const choices=candidates.map(key=>({key,parts:partsOf(win,slide,key)}));let chosen,node;
  for(let at=el;at&&!chosen;at=at===slide?null:at.parentElement)for(const c of choices){node=c.parts.find(n=>(n.nodeType===3?n.parentElement:n.host||n)===at);if(node){chosen=c.key;break;}}
  if(el.closest('h2')){chosen='--header';node=el.closest('h2');}
  else if(el.closest('.math, math')){chosen='--math-ink';node=el.closest('.math, math');}
  else if(el.closest('th')){chosen='--table-header-bg';node=el.closest('th');}
  else if(el.closest('td')){chosen='--table-ink';node=el.closest('td');}
  else if(el===slide)return;
  if(!chosen)return;clear();marks=[{n:node||el,w:win,page:(node||el)===slide}];place();
  sendEvent('theme.select',{key:chosen,index:win.deck.index,sourceVersion:getSourceVersion(),trusted:true});
 }
 for(const type of ['pointerdown','pointerup','click','dblclick'])doc.addEventListener(type,click,true);
 function geometry(){const slide=active(),el=gradient?.key==='--header-fill'?slide?.querySelector('h2'):slide;if(!el||!slide)return null;const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};const cs=win.getComputedStyle(slide);return {...rect(el),slide:rect(slide),backgroundImage:cs.backgroundImage,backgroundColor:cs.backgroundColor,headingInk:slide.querySelector('h2')?win.getComputedStyle(slide.querySelector('h2')).color:null,index:win.deck.index};}
 function closeGradient(){doc.getElementById('gradient-preview-style')?.remove();const stage=doc.querySelector('#stage');if(stage&&gradient)stage.inert=gradient.oldInert;gradient=null;}
 function gradientCommand(p){
  if(p.action==='close'){closeGradient();return null;}
  if(p.action==='open'){closeGradient();const stage=doc.querySelector('#stage');gradient={key:p.key,oldInert:stage.inert};const result=geometry();stage.inert=true;return result;}
  if(!gradient)return null;
  if(p.action==='geometry')return geometry();
  let style=doc.getElementById('gradient-preview-style');if(!style){style=doc.createElement('style');style.id='gradient-preview-style';style.dataset.headingInk=geometry()?.headingInk||'';doc.head.append(style);}
  style.textContent='#slide-studio-theme-marks {display:none!important} #stage,#stage * {pointer-events:none!important;user-select:none!important}';
  if(!p.showContent){style.textContent+='#stage > .slide.active *,#stage > .slide.active::before,#stage > .slide.active::after {visibility:hidden!important}';if(gradient.key==='--header-fill')style.textContent+='#stage > .slide.active h2 {visibility:visible!important;color:transparent!important;-webkit-text-fill-color:transparent!important}';}
  return null;
 }
 return {inspect,mark,gradient:gradientCommand,configure(p){shown=p.shown;sample=p.sample;doc.documentElement.classList.toggle('slide-studio-theme-preview',shown);if(!shown){clear();closeGradient();}},preview(p){vars=p.vars;live=new Map(Object.entries(p.values));shown=p.shown;return paint();}};
}
