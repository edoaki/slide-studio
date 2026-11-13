/* Slide Studio のプレイヤー。元：quarto-html shared/player.js。設計書 §7.3。
   ↑↓ ページ、←→ step（端で隣のページ）、←→ 長押しで最初・最後の step、一覧（o）・全画面・#ページ/step。
   deck.go(i, step) は Promise を返し、そのページの図の settled・フォント・画像の decode を待って解決する。
   data-step は「段」の番号。段は小さい順に出し、図のある段は図の step を最後まで送ってから次の段へ進む
   （step はページの中の通し番号。空いた番号は飛ばす）。 */
(async () => {
// 外側余白の囲みには装飾も編集用のキーも付けない。列は flex item なので margin が相殺されない。
// 同じ処理を編集画面のドラッグ中にも使い、保存前後で配置を一致させる。
// 通常の段落間隔は囲みの外へ移し、外側余白を足しただけで二重にならないようにする。
const collapsedMargin = (el, side) => {
  const cs = getComputedStyle(el), own = parseFloat(cs[`margin${side}`]) || 0;
  if (cs.display !== 'block' || cs.cssFloat !== 'none' || cs.overflow !== 'visible'
      || parseFloat(cs[`border${side}Width`]) || parseFloat(cs[`padding${side}`])
      || (side === 'Bottom' && (el.style.height || parseFloat(cs.minHeight)))) return own;
  const child = side === 'Top' ? el.firstElementChild : el.lastElementChild;
  if (!child || [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return own;
  const sub = getComputedStyle(child);
  if (!['block', 'flow-root', 'flex', 'grid'].includes(sub.display) || sub.position === 'absolute' || sub.cssFloat !== 'none') return own;
  const nested = collapsedMargin(child, side);
  return Math.max(0, own, nested) + Math.min(0, own, nested);
};
// iframe を含む要素を DOM の中で動かすと、図が読み直しになる（最初の読み込みは中断され、検査が「読み込めない素材」と誤って出す）。
// moveBefore が使えるブラウザでは状態を保ったまま動かす
const relocate = (parent, el, before = null) => parent.moveBefore ? parent.moveBefore(el, before) : parent.insertBefore(el, before);
window.slideStudioSpacing = (el, value) => {
  if (value == null) el.style.removeProperty('--block-space');
  else el.style.setProperty('--block-space', value);
  if (el.classList.contains('column')) return el;
  let wrap = el.parentElement?.classList.contains('slide-studio-space') ? el.parentElement : null;
  if (value == null) { if (wrap) { relocate(wrap.parentNode, el, wrap); wrap.remove(); } return el; }
  if (!wrap) {
    wrap = document.createElement('div'); wrap.className = 'slide-studio-space';
    const cs = getComputedStyle(el);
    for (const side of ['Top', 'Bottom']) {
      const margin = parseFloat(cs[`margin${side}`]) || 0, collapsed = collapsedMargin(el, side);
      wrap.style[`margin${side}`] = `${collapsed}px`;
      wrap.style.setProperty(`--space-child-${side.toLowerCase()}`, `${margin - collapsed}px`);
    }
    el.before(wrap); relocate(wrap, el);
  }
  wrap.style.setProperty('--space-inset', value);
  return wrap;
};
// 小さい文字だけの段落では、親の元サイズによる行の最低高も縮める。
// 元の指定を戻してから測るので、編集・テーマ変更を繰り返しても縮み続けない。
const textLineHeights = new WeakMap();
window.slideStudioRefreshTextSpacing = (root = document.querySelector('#stage')) => {
  const paragraphs = [...root.querySelectorAll('p,li')];
  if (root.matches('p,li')) paragraphs.unshift(root);
  for (const el of paragraphs) {
    const original = textLineHeights.get(el);
    if (original) {
      if (original.value) el.style.setProperty('line-height', original.value, original.priority);
      else el.style.removeProperty('line-height');
      textLineHeights.delete(el);
    }
    if (!el.querySelector('span[style*="font-size"]') || el.querySelector('p,ul,ol,table,math,img')) continue;
    const cs = getComputedStyle(el), base = parseFloat(cs.fontSize), height = parseFloat(cs.lineHeight);
    if (!Number.isFinite(height)) continue;
    let largest = 0;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (t.textContent.trim()) largest = Math.max(largest, parseFloat(getComputedStyle(t.parentElement).fontSize));
    }
    if (!largest || largest >= base) continue;
    textLineHeights.set(el, { value: el.style.getPropertyValue('line-height'), priority: el.style.getPropertyPriority('line-height') });
    el.style.setProperty('line-height', `${height * largest / base}px`);
  }
};
window.slideStudioRefreshTextSpacing();
document.querySelectorAll('#stage [style*="--block-space"]').forEach(el => window.slideStudioSpacing(el, el.style.getPropertyValue('--block-space')));
// テーマを差し替えたら、囲みに移したテーマ由来の余白も測り直す。
// 外側の囲みから外し、内側から戻して入れ子の余白も新しい CSS で測る。
window.slideStudioRefreshSpacing = () => {
  window.slideStudioRefreshTextSpacing();
  const entries = [...document.querySelectorAll('#stage .slide-studio-space > *')]
    .map(el => [el, el.style.getPropertyValue('--block-space')]);
  for (const [el] of entries) window.slideStudioSpacing(el, null);
  for (const [el, value] of entries.reverse()) window.slideStudioSpacing(el, value);
};
// 文献件数ではなく、テーマとフォントを適用した後の本文領域で改ページする。
async function paginateReferences() {
  const originals = [...document.querySelectorAll('#stage > .references-slide')];
  if (!originals.length) return;
  for (const first of originals) {
    first.style.display = 'block'; first.style.visibility = 'hidden';
    const entries = [...first.querySelectorAll('.csl-entry')];
    await Promise.all([first.querySelector('h2'), ...entries].filter(Boolean).map(el => {
      const cs = getComputedStyle(el);
      return document.fonts.load(`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, el.textContent).catch(() => []);
    }));
    const title = first.querySelector('h2').textContent;
    entries.forEach(e => e.remove());
    let current = first, count = 0, number = 1;
    const finish = () => { current.style.removeProperty('display'); current.style.removeProperty('visibility'); };
    for (const entry of entries) {
      current.insertBefore(entry, current.querySelector('.page-number'));
      const bounds = current.getBoundingClientRect(), scale = bounds.height / current.offsetHeight;
      const bottom = bounds.bottom - parseFloat(getComputedStyle(current).paddingBottom) * scale;
      if (count && entry.getBoundingClientRect().bottom > bottom + .5) {
        const next = first.cloneNode(true);
        next.querySelectorAll('.csl-entry').forEach(e => e.remove());
        next.id = `${first.id}-${++number}`;
        next.querySelector('h2').textContent = `${title}（${number}）`;
        next.style.display = 'block'; next.style.visibility = 'hidden';
        current.after(next); finish(); current = next; count = 0;
        current.insertBefore(entry, current.querySelector('.page-number'));
      }
      count++;
    }
    finish();
  }
  const pages = [...document.querySelectorAll('#stage > .slide')];
  pages.forEach((s, i) => { s.querySelector('.page-number').textContent = `${i + 1} / ${pages.length}`; });
}
await paginateReferences();
const slides = [...document.querySelectorAll('#stage > .slide')], stage = document.querySelector('#stage'), overview = window.__slideStudioNoOverview ? null : document.querySelector('#overview'); // 編集画面は GUI 側の一覧を使う
let index = 0, step = 0, held = null, timer = null, long = false, lastInput = -Infinity;
// ページの構造は読み込み中に確定する。step 移動では現在ページだけを触る。
const stageOf = v => Math.max(0, Math.floor(Number(v)) || 0);
const partsOf = s => {
  const frames = [...s.querySelectorAll('iframe')];
  return {
    frames, frameStages: frames.map(f => stageOf(f.closest('[data-step]')?.dataset.step)),
    reveals: [...s.querySelectorAll('[data-step]')],
    highlights: [...s.querySelectorAll('[data-highlight-step]')],
  };
};
const parts = new Map(slides.map(s => [s, partsOf(s)]));
const frames = s => parts.get(s).frames;
let paintedIndex = -1, paintVersion = 0;
const anim = f => { try { return f.contentWindow && f.contentWindow.animation; } catch { return null; } };
// 段ごとの最初の step。図の step の数は読み込み後に分かるので、毎回数え直す
function timeline(s) {
  const p = parts.get(s), size = new Map([[0, 0]]);
  const add = (k, n = 0) => size.set(k, Math.max(size.get(k) ?? 0, n));
  p.reveals.forEach(e => add(stageOf(e.dataset.step)));
  p.highlights.forEach(e => add(stageOf(e.dataset.highlightStep)));
  p.frames.forEach((f, i) => add(p.frameStages[i], anim(f)?.steps || 0));
  const start = new Map(); let n = 0;
  for (const k of [...size.keys()].sort((a, b) => a - b)) { start.set(k, n); n += size.get(k) + 1; }
  return { start, count: n, stages: [...start.keys()] };
}
function maxStep(i = index) { return slides[i] ? timeline(slides[i]).count - 1 : 0; }
// PDF に載せる印（見出しの pdf="2 4"。画面の表示と同じ 1 始まり）
function pdfMarks(i = index) { return [...new Set((slides[i]?.dataset.pdf || '').split(/[\s,]+/).map(Number).filter(n => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b); }
// PDF に載せる step（0 始まり）：最後の step と、印を付けた step
function pdfSteps(i = index) { const last = maxStep(i); return [...new Set([...pdfMarks(i).map(n => n - 1).filter(n => n < last), last])].sort((a, b) => a - b); }
// step k で出ている最後の段
function stageAt(k = step, i = index) {
  const t = slides[i] && timeline(slides[i]); if (!t) return 0;
  return t.stages.filter(s => t.start.get(s) <= k).at(-1) ?? 0;
}

// ページ（または一覧の複製）を step k の見た目にする
function paintStep(p, t, k, animate = false) {
  const from = v => t.start.get(stageOf(v));
  p.frames.forEach((f, i) => { const a = anim(f); a?.setStep(Math.max(0, Math.min(a.steps || 0, k - t.start.get(p.frameStages[i]))), animate); });
  p.reveals.forEach(e => e.classList.toggle('pending', from(e.dataset.step) > k));
  p.highlights.forEach(e => { e.classList.toggle('animate-highlight', animate); e.classList.toggle('is-highlighted', from(e.dataset.highlightStep) <= k); });
}

// 図にテーマの変数（--theme-*）を渡す。図は var(--theme-accent, 既定値) のように使う
let themeVars = null;
function collectThemeVars() {
  const names = new Set();
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) if (r.style) for (const n of r.style) if (n.startsWith('--theme-')) names.add(n);
  }
  const cs = getComputedStyle(document.documentElement);
  return [...names].map(n => [n, cs.getPropertyValue(n).trim()]).filter(([, v]) => v);
}
function passTheme(f) {
  try {
    const root = f.contentDocument?.documentElement; if (!root) return;
    themeVars ??= collectThemeVars();
    for (const [k, v] of themeVars) root.style.setProperty(k, v);
  } catch { /* 別オリジンの iframe には渡さない */ }
}
// 図の縦横比を図の枠に渡す。枠の幅は「高さ × 縦横比」になり、列の幅は中身の図で決まる。
// 図はページが表示されてから測るので、表示のたびに渡し直す（同じ処理の中なので描画前に反映される）
function passRatio(f) {
  const r = anim(f)?.ratio, box = f.closest('.animation');
  if (!r || !box) return;
  // 高さを希望サイズとして記憶し、実寸は幅から決める。max-width で列に
  // 制限されたときも高さだけが残って枠が縦に伸びないようにする。
  if (!box.style.getPropertyValue('--fig-height')) {
    box.style.setProperty('--fig-height', box.style.height || getComputedStyle(box).height);
  }
  box.style.setProperty('--fig-ratio', r);
}
const loaded = new WeakMap();
const completed = new WeakSet();
function frameReady(f) {
  if (!loaded.has(f)) loaded.set(f, new Promise(resolve => {
    const done = () => {
      completed.add(f);
      passTheme(f); passRatio(f);
      anim(f)?.setVisible?.(f.closest('.slide') === slides[index]);
      resolve();
    };
    let doc = null; try { doc = f.contentDocument; } catch { /* 別オリジン */ }
    if (doc && doc.readyState === 'complete' && (anim(f) || doc.URL !== 'about:blank')) done();
    else f.addEventListener('load', done, { once: true });
  }));
  return loaded.get(f);
}

function settle(i = index) {
  const s = slides[i]; if (!s) return Promise.resolve();
  void stage.offsetHeight;
  const imgs = [...s.querySelectorAll('img')].map(img => img.complete && !img.naturalWidth ? null : img.decode().catch(() => {}));
  // fonts.ready は文書全体の load（他ページの iframe）まで待つことがある。
  // レイアウトで必要になったフォント自体の読み込みを待つ。
  const fonts = [...document.fonts].filter(f => f.status === 'loading').map(f => f.loaded.catch(() => {}));
  return Promise.all([
    ...frames(s).map(f => frameReady(f).then(() => anim(f)?.settled).then(() => passRatio(f))),
    ...fonts, ...imgs,
  ]).then(() => undefined);
}
function paint(animate = false) {
  if (paintedIndex !== index) {
    const changed = paintedIndex < 0 ? slides : [slides[paintedIndex], slides[index]];
    changed.forEach(s => {
      const active = s === slides[index];
      s.classList.toggle('active', active); s.setAttribute('aria-hidden', String(!active));
      frames(s).forEach(f => { anim(f)?.setVisible?.(active); if (active) passRatio(f); });
    });
    paintedIndex = index;
  }
  paintStep(parts.get(slides[index]), timeline(slides[index]), step, animate);
  if (!window.__slideStudioNoHash) history.replaceState(null, '', `#${index + 1}/${step}`);
  dispatchEvent(new CustomEvent('deckchange', { detail: { index, step, maxStep: maxStep() } }));
  const version = ++paintVersion, target = index;
  // 同じ処理内の連続移動では、古い位置のレイアウト・画像待ちを積まない。
  return Promise.resolve().then(() => version === paintVersion ? settle(target) : undefined);
}
let pageFilter = null;
function setFilter(indices) { pageFilter = indices?.length ? indices : null; }
function go(i, n = 0, animate = false) {
  if (pageFilter && !pageFilter.includes(i)) {
    i = i > index ? pageFilter.find(k => k >= i) ?? pageFilter.at(-1) : [...pageFilter].reverse().find(k => k <= i) ?? pageFilter[0];
  }
  index = Math.max(0, Math.min(slides.length - 1, i));
  const loading = slides[index] && frames(slides[index]).some(f => !completed.has(f));
  step = Math.max(0, Math.min(maxStep(), n));
  const result = paint(animate), version = paintVersion;
  // 遅れて届いた図の段数を反映する。待っている間のページ・step 移動は巻き戻さない。
  return loading ? result.then(() => {
    if (version !== paintVersion) return;
    step = Math.max(0, Math.min(maxStep(), n));
    return paint(false);
  }) : result;
}
function move(dir) {
  const now = performance.now(), animate = now - lastInput > 300; lastInput = now;
  if (dir > 0) return step < maxStep() ? go(index, step + 1, animate) : go(index + 1);
  return step > 0 ? go(index, step - 1, animate) : index > 0 ? go(index - 1) : Promise.resolve();
}
function jump(dir) { return go(index, dir > 0 ? Infinity : 0); }
let previewSize = null;
function resize(size) {
  if (size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0) previewSize = size;
  if (document.body.classList.contains('export')) return;
  // iframe の innerWidth/Height は整数に丸められるため、端に白い隙間が出る。
  // GUI のプレビューは実際の枠の小数を含む寸法で合わせる。
  const frame = window.__slideStudioFill ? previewSize ?? window.frameElement?.getBoundingClientRect() : null;
  const width = frame?.width ?? innerWidth, height = frame?.height ?? innerHeight;
  // 操作のボタンはカーソルを合わせたときだけ出すので、画面いっぱいに描く
  const scale = Math.min(width / 1280, height / 720);
  stage.style.transform = `scale(${scale})`;
  stage.style.left = `${(width - 1280 * scale) / 2}px`; stage.style.top = `${(height - 720 * scale) / 2}px`;
}
function close() { overview.hidden = true; document.querySelector('#menu')?.focus(); }
function menu() {
  thumbs(); overview.hidden = false;
  overview.querySelectorAll('.thumb').forEach((b, i) => b.setAttribute('aria-current', String(i === index)));
  overview.querySelector('#close').focus();
  overview.querySelector('.thumb[aria-current=true]')?.scrollIntoView({ block: 'center', inline: 'center' });
}
const grouped = slides.some(s => s.dataset.sectionStart === 'true');
let row;
slides.forEach((s, i) => {
  if (!overview) return;
  if (!row || s.dataset.sectionStart === 'true') {
    if (grouped) { const h = document.createElement('h2'); h.textContent = s.dataset.group || '表紙'; overview.append(h); }
    row = document.createElement('div'); row.className = grouped ? 'overview-row' : 'overview-grid'; overview.append(row);
  }
  const b = document.createElement('button'); b.className = 'thumb'; b.dataset.index = i;
  const num = document.createElement('span'); num.textContent = String(i + 1).padStart(2, '0');
  const title = s.querySelector('h1,h2')?.textContent || 'Slide', caption = document.createElement('div');
  caption.className = 'thumb-caption'; caption.append(num, title); b.title = title;
  b.append(caption);
  b.onclick = () => { go(i); close(); }; row.append(b);
});
// 一覧の縮小画像：初めて開いたときにページを複製して縮める。カーソルの横の位置の step を出し、離れると最後の step に戻す。
// 複製にも #stage・.reveal を付け、テーマと発表の CSS をそのまま効かせる（player は最初の #stage だけを使う）
let thumbsMade = false;
const copies = new Map();
function showThumb(b, k) {
  const i = +b.dataset.index, p = copies.get(b), t = timeline(slides[i]), n = t.count > 1 ? t.count : 0;
  if (!p) return;
  k = Math.max(0, Math.min(t.count - 1, k));
  paintStep(p, t, k);
  const bar = b.querySelector('.thumb-steps');
  if (bar.childElementCount !== n) bar.innerHTML = '<i></i>'.repeat(n);
  [...bar.children].forEach((e, j) => e.classList.toggle('on', j === k));
}
const restThumb = b => showThumb(b, b.dataset.step != null ? +b.dataset.step : Infinity);
function thumbs() {
  if (thumbsMade || !overview) return; thumbsMade = true;
  const fit = new ResizeObserver(es => es.forEach(e => e.target.style.setProperty('--thumb-scale', e.contentRect.width / 1280)));
  overview.querySelectorAll('.thumb').forEach((b, i) => {
    const s = slides[i].cloneNode(true);
    s.classList.add('active'); s.removeAttribute('aria-hidden');
    copies.set(b, partsOf(s));
    s.querySelectorAll('iframe').forEach(f => {
      f.loading = 'lazy'; f.tabIndex = -1;
      frameReady(f).then(() => {
        const a = anim(f); if (!a) return;
        a.setVisible?.(true); restThumb(b);
        return Promise.resolve(a.settled).then(() => passRatio(f));
      });
    });
    const view = document.createElement('div'); view.className = 'thumb-view'; view.setAttribute('aria-hidden', 'true');
    const reveal = document.createElement('div'); reveal.className = 'reveal';
    const copy = document.createElement('div'); copy.id = 'stage'; copy.className = 'slides';
    const bar = document.createElement('div'); bar.className = 'thumb-steps';
    copy.append(s); reveal.append(copy); view.append(reveal, bar); b.prepend(view); fit.observe(view);
    restThumb(b);
  });
}
overview?.addEventListener('pointermove', e => {
  const b = e.target.closest('.thumb'); if (!b) return;
  const n = maxStep(+b.dataset.index) + 1; if (n < 2) return;
  const r = b.getBoundingClientRect(), k = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left) / r.width * n)));
  if (b.dataset.step !== String(k)) { b.dataset.step = k; showThumb(b, k); }
});
overview?.addEventListener('pointerout', e => {
  const b = e.target.closest('.thumb');
  if (!b || b.contains(e.relatedTarget)) return;
  delete b.dataset.step; restThumb(b);
});
const menuButton = document.querySelector('#menu'), closeButton = document.querySelector('#close'), fsButton = document.querySelector('#fullscreen');
if (menuButton) menuButton.onclick = menu;
if (closeButton) closeButton.onclick = close;
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else fsButton.textContent = '全画面非対応';
  } catch { fsButton.textContent = '全画面非対応'; }
}
if (fsButton) fsButton.onclick = fullscreen;
function cancel() { clearTimeout(timer); held = null; long = false; }
// 横スワイプは段を飛ばして1ページずつ。慣性と、続けて行った操作を区別する。
let wheelTime = -Infinity, wheelDistance = 0, wheelMoved = false;
let wheelPeak = 0, wheelLast = 0, wheelDirection = 0, wheelReverse = 0, wheelMovedAt = -Infinity;
function pageWheel(e) {
  if (e.ctrlKey || (overview && !overview.hidden) || document.body.classList.contains('export')) return;
  if (!e.deltaX || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  const now = performance.now();
  const dx = e.deltaX * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerWidth : 1);
  const strength = Math.abs(dx), direction = Math.sign(dx);
  if (now - wheelTime > 200) {
    wheelDistance = 0; wheelMoved = false; wheelPeak = 0; wheelLast = 0; wheelReverse = 0;
  }
  wheelTime = now;
  if (wheelMoved) {
    if (direction !== wheelDirection) {
      // 小さい揺り戻しは無視し、逆方向の操作が十分に続いたら受け付ける。
      wheelReverse += strength;
      if (wheelReverse < 40) return;
      wheelDistance = direction * wheelReverse;
    } else {
      wheelReverse = 0;
      // 慣性が弱まった後の立ち上がりは、新しいスワイプとして扱う。
      const restarted = now - wheelMovedAt > 120 && wheelLast < wheelPeak * 0.35
        && strength >= Math.max(8, wheelLast * 2);
      wheelPeak = Math.max(wheelPeak, strength); wheelLast = strength;
      if (!restarted) return;
      wheelDistance = dx;
    }
    wheelMoved = false; wheelPeak = 0; wheelReverse = 0;
  } else {
    wheelDistance += dx;
  }
  wheelPeak = Math.max(wheelPeak, strength); wheelLast = strength;
  if (Math.abs(wheelDistance) < 40) return;
  wheelMoved = true; wheelMovedAt = now; wheelDirection = Math.sign(wheelDistance);
  const target = Math.max(0, Math.min(slides.length - 1, index + Math.sign(wheelDistance)));
  if (target !== index) go(target);
}
addEventListener('wheel', pageWheel, { passive: false, capture: true });
// 図の iframe 内の wheel は親へ伝わらないので、同じジェスチャー状態で扱う。
for (const f of document.querySelectorAll('#stage iframe')) {
  const connect = () => {
    try { f.contentWindow.addEventListener('wheel', pageWheel, { passive: false, capture: true }); }
    catch { /* 別オリジンの図 */ }
  };
  connect(); f.addEventListener('load', connect);
}
addEventListener('keydown', e => {
  if (window.__slideStudioKeysOff || e.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
  if (overview && !overview.hidden) {
    if (e.key === 'Escape' || (e.key === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey)) close();
    if (e.key === 'Tab') { const items = [...overview.querySelectorAll('button')]; if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); } }
    return;
  }
  if (e.target.closest?.('button,a') && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault(); if (held) return; held = e.key; long = false;
    timer = setTimeout(() => { long = true; jump(e.key === 'ArrowRight' ? 1 : -1); }, 450); return;
  }
  if (e.repeat) return;
  if (['ArrowDown', 'ArrowUp', ' ', 'Escape', 'o', 'f'].includes(e.key)) e.preventDefault();
  if (e.key === 'ArrowDown') go(index + 1);
  if (e.key === 'ArrowUp') go(index - 1);
  if (e.key === ' ') move(1);
  if ((e.key === 'Escape' || e.key === 'o') && overview) menu();
  if (e.key === 'f') fullscreen();
});
addEventListener('keyup', e => { if (e.key === held) { if (!long) move(e.key === 'ArrowRight' ? 1 : -1); cancel(); } });
addEventListener('blur', cancel); document.addEventListener('visibilitychange', cancel);
stage.addEventListener('click', e => {
  if (window.__slideStudioClickOff || e.target.closest('a,button,input') || (overview && !overview.hidden)) return;
  const r = stage.getBoundingClientRect(); move(e.clientX - r.left < r.width * .3 ? -1 : 1);
});
// 図の中で押したキーは図の runtime が親へ送る
addEventListener('message', e => {
  const d = e.data; if (!d || d.channel !== 'slide-studio-figure') return;
  // 枠の高さに合わせて図が縦横比を変えた
  if (d.type === 'ratio') { const f = [...document.querySelectorAll('.animation iframe')].find(f => f.contentWindow === e.source); if (f) passRatio(f); return; }
  if (d.type !== 'navigate') return;
  if (d.direction === 'next') move(1); else if (d.direction === 'prev') move(-1);
  else if (d.direction === 'page-next') go(index + 1); else if (d.direction === 'page-prev') go(index - 1);
  else if (d.direction === 'last') jump(1); else if (d.direction === 'first') jump(-1);
});
// 段の最初の step へ（編集画面で段を選んだとき）
function goStage(k, i = index) { const t = slides[i] && timeline(slides[i]); return go(i, t?.start.get(k) ?? 0); }
// 編集用の通し番号。未使用の段は、その位置に挿入したときの開始番号を返す。
function stageNumber(k, i = index) {
  const t = slides[i] && timeline(slides[i]);
  if (!t) return null;
  const next = t.stages.find(s => s >= k);
  return (next == null ? t.count : t.start.get(next)) + 1;
}
window.deck = { go, pageWheel, setFilter, move, jump, maxStep, pdfMarks, pdfSteps, stageAt, stageNumber, goStage, settle, slides, resize, get index() { return index; }, get step() { return step; }, get count() { return slides.length; } };
addEventListener('resize', resize); resize();
// 整数の viewport 寸法が変わらない、小数だけのリサイズも追従する。
if (window.__slideStudioFill && window.frameElement) new ResizeObserver(resize).observe(window.frameElement);
const ready = Promise.all([...document.querySelectorAll('iframe')].map(frameReady));
window.deckLoaded = ready;
const domReady = document.readyState === 'loading'
  ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true })) : Promise.resolve();
domReady.then(() => {
  const m = location.hash.match(/^#(\d+)(?:\/(\d+))?$/);
  return go(m ? Number(m[1]) - 1 : 0);
}).then(() => {
  window.deckReady = true; dispatchEvent(new Event('deckready'));
  // 親 iframe の load は全ページの図を待つため、表示可能になった時点でも知らせる。
  if (parent !== window) parent.postMessage({ channel: 'slide-studio-deck', type: 'ready' }, '*');
});
})();
