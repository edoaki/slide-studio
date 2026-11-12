import { isPlaceholder } from '../page-templates.js';
import { makeLink } from '../inject/link.js';

// Frame-local editing engine. The parent exchanges only bounded text and typed commands.
export function installTextEditing(handlersForBridge) {
 const listen = (target, name, fn, options) => target.addEventListener(name, event => { if (event.isTrusted) fn(event); }, options);
// 親画面からコールバックを登録する。同一オリジンのプレビューだけで使用。
const link = makeLink(() => active, () => range, () => changedNow());
listen(window, 'keydown', e => {
  // 表紙のタイトル・副題（plain）では太字・斜体・下線・リンクのキーを使わない
  if (active && plain && (e.metaKey || e.ctrlKey) && ['b', 'i', 'u', 'k'].includes(e.key.toLowerCase())) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (active && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); e.stopImmediatePropagation();
    handlers?.link?.();
  }
}, true);
listen(document, 'click', e => {
  const a = e.target.closest('a[href]');
  if (!handlers || !a) return;
  if (!active && a.target === '_blank') { e.stopImmediatePropagation(); return; }
  e.preventDefault();
}, true);
// touched：編集を始めてから文字を変えたか。created：⌥WASD で足した、まだ原稿に無いブロック（終えたら元に戻す）
// finishing：編集の外を押して編集を終えている途中（その押した所は、終わってから選ぶ）
// plain：太字・斜体・リンクを使わない編集（表紙のタイトル・副題）
let handlers = null, active = null, original = '', touched = false, created = null, swallow = false, finishing = null, plain = false;
const inHeading = () => !!active?.matches('.slide > h1, .slide > h2');
const elements = key => [...document.querySelectorAll('[data-slide-studio]:not(.slide-studio-step-badge)')].filter(el => el.dataset.slideStudio === key);
// event.target のいちばん近いブロックを使う。箱の枠・余白から子へ選択を飛ばさない。
// 非表示の段も含めた矩形の探索はせず、ブラウザの当たり判定をクリック・ホバー・ドラッグで共有する。
const leafAt = el => el;
// 行の高さや段落の余白ではなく、文字の描画範囲＋画面上の3pxを判定する。
const textMeasure = document.createElement('canvas').getContext('2d');
function onText(el, x, y, precise = false) {
  if (!precise && el.closest('.cover-title,.cover-subtitle')) return true;
  const hit = q => x >= q.left - 3 && x <= q.right + 3 && y >= q.top - 3 && y <= q.bottom + 3;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), r = document.createRange();
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.data.trim() || n.parentElement.closest('[data-slide-studio-atom],math')) continue;
    const style = getComputedStyle(n.parentElement);
    textMeasure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const m = textMeasure.measureText(n.data.trim());
    r.setStart(n, n.data.length - n.data.trimStart().length);
    r.setEnd(n, n.data.trimEnd().length);
    for (const q of r.getClientRects()) {
      const height = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
      const scale = height > 0 ? q.height / height : 1;
      const baseline = q.top + (m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent) * scale;
      if (hit({ left: q.left, right: q.right, top: baseline - m.actualBoundingBoxAscent * scale, bottom: baseline + m.actualBoundingBoxDescent * scale })) return true;
    }
  }
  return [...el.querySelectorAll('[data-slide-studio-atom],math,img')].some(k => hit(k.getBoundingClientRect()));
}
// 押した位置のカーソル（caretPositionFromPoint の無いブラウザは caretRangeFromPoint）
function caretAt(x, y) {
  const pos = document.caretPositionFromPoint?.(x, y);
  if (!pos) return document.caretRangeFromPoint?.(x, y) ?? null;
  const r = document.createRange(); r.setStart(pos.offsetNode, pos.offset); r.collapse(true);
  return r;
}
// 余白を押したときは、縦位置が最も近い表示行の末尾へ。折り返しやインライン書式も含める。
function lineEndAt(el, y) {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let best = null, distance = Infinity;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.data.trim() || n.parentElement.closest('[contenteditable="false"]')) continue;
    for (let i = 0; i < n.length; i++) {
      r.setStart(n, i); r.setEnd(n, i + 1);
      for (const q of r.getClientRects()) {
        if (!q.width || !q.height) continue;
        const d = Math.abs(y - (q.top + q.bottom) / 2);
        if (d <= distance + 1) {
          distance = Math.min(distance, d);
          best = r.cloneRange(); best.collapse(false);
        }
      }
    }
  }
  if (best) return best;
  r.selectNodeContents(el); r.collapse(false); return r;
}
// 表のセルの位置（0 行目が見出し。全部空の見出しは描画されないので 1 行目から）
const cellPos = td => { const t = td.closest('table'); return { r: td.parentElement.rowIndex + (t.tHead ? 0 : 1), c: td.cellIndex }; };
// 表だけのブロックは、描画で目印が table 自体に移っている
const tableOf = key => { const el = elements(key)[0]; return el?.matches('table') ? el : el?.querySelector('table') ?? null; };
const cellOf = (key, { r, c }) => { const t = tableOf(key); return t?.rows[t.tHead ? r : r - 1]?.cells[c] ?? null; };
const inCell = () => !!active?.matches('td,th');
const emptyCell = target => { const td = target.closest?.('td,th'); return !!td && !td.textContent.trim() && !td.querySelector('img,math'); };
// html：編集用の中身（引用・数式の原文の目印付き）。同じ編集の中で直したセルは今の中身のまま続ける
function openCell(td, html) {
  original = td.innerHTML;
  if (!td.hasAttribute('data-slide-studio-cell-edited')) td.innerHTML = html;
  editable(td);
}
function closeActive(el) {
  if (!touched) el.innerHTML = original;
  else if (el.matches('td,th')) el.setAttribute('data-slide-studio-cell-edited', '');
  el.removeAttribute('contenteditable'); el.classList.remove('slide-studio-editing');
}
// 同じ表の別のセルへ移る。親が移ってよいと答えたら（編集用の中身が返る）切り替える
function moveToCell(td, notify) {
  const html = handlers.cell?.(cellPos(td), notify);
  if (html == null) return false;
  closeActive(active); openCell(td, html);
  return true;
}
// Tab・⇧Tab：隣のセルへ（中を全部選ぶ）。端まで行ったら編集を終える
function tabCell(delta) {
  const cells = [...active.closest('table').querySelectorAll('th,td')];
  for (let i = cells.indexOf(active) + delta; cells[i]; i += delta) {
    if (!moveToCell(cells[i], false)) continue;
    const r = document.createRange(); r.selectNodeContents(active);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return;
  }
  editor.finish();
}
function editable(el) {
  active = el; touched = false; range = null; el.contentEditable = 'true'; el.classList.add('slide-studio-editing');
  el.querySelectorAll('[data-slide-studio-atom],math,pre,table').forEach(k => k.contentEditable = 'false');
  el.focus();
}
const changedNow = () => { window.slideStudioRefreshTextSpacing?.(active); touched = true; if (!created) handlers.input(active.outerHTML); };

// ---------------------------------------------------------------- 文字の書式（設計書 §10.5）
// 選んだ文字（選んでいなければブロック全体）の文字ノードごとに、同じ書式を持つ外側の span から切り離してから付け直す。
// 色はテーマの色のクラス（[語]{.accent}）か自由に選んだ色（style の color）、大きさは周りに対する em。
const SIZES = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2, 2.5, 3]; // ⊖⊕ の段（ブロックの文字の大きさに対する倍率）
let range = null; // 編集中のブロックの中で最後に選んでいた範囲（書式バーを押してもここに適用する）
listen(document, 'selectionchange', () => {
  const s = getSelection();
  if (!active || !s.rangeCount || !active.contains(s.getRangeAt(0).commonAncestorContainer)) return;
  range = s.getRangeAt(0).cloneRange(); handlers.selection?.();
});
const colorClasses = () => handlers?.colorClasses ?? [];
// style は文字列のまま読み書きする（style.color に入れると rgb() に変わり、原稿に16進で書けない）
const readStyle = s => Object.fromEntries((s.getAttribute('style') || '').split(';').map(d => d.split(':')).filter(p => p.length > 1).map(([k, ...v]) => [k.trim().toLowerCase(), v.join(':').trim()]));
function writeStyle(s, o) { const t = Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('; '); if (t) s.setAttribute('style', t); else s.removeAttribute('style'); }
const without = (s, k) => { const o = readStyle(s); delete o[k]; writeStyle(s, o); };
const PROPS = {
  color: { has: s => readStyle(s).color || !s.hasAttribute('data-highlight-step') && colorClasses().some(c => s.classList.contains(c)), strip: s => { without(s, 'color'); s.classList.remove(...colorClasses()); } },
  size: { has: s => readStyle(s)['font-size'], strip: s => without(s, 'font-size') },
};
// 編集中のブロックの文字の位置（数字）と文字ノードの位置を行き来する。書式を変えると文字ノードが分かれたりまとまったりするため
function offsetOf(node, off) { const r = document.createRange(); r.setStart(active, 0); r.setEnd(node, off); return r.toString().length; }
function pointAt(n) {
  const walk = document.createTreeWalker(active, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let t = walk.nextNode(); t; t = walk.nextNode()) { if (n <= t.length) return [t, n]; n -= t.length; last = t; }
  return last ? [last, last.length] : [active, 0];
}
function targets() {
  const r = range && !range.collapsed && active.contains(range.commonAncestorContainer) ? range : null;
  if (r) {
    if (r.endContainer.nodeType === 3 && r.endOffset < r.endContainer.length) r.endContainer.splitText(r.endOffset);
    if (r.startContainer.nodeType === 3 && r.startOffset > 0) r.setStart(r.startContainer.splitText(r.startOffset), 0);
  }
  const out = [], walk = document.createTreeWalker(active, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (r && !r.intersectsNode(t)) continue;
    if (t.parentElement.closest('[data-slide-studio-atom],math,pre,table') && active.contains(t.parentElement.closest('[data-slide-studio-atom],math,pre,table'))) continue;
    // 段落・項目の間の改行だけの文字は飾らない
    if (!t.data.trim() && getComputedStyle(t.parentElement).display !== 'inline') continue;
    out.push(t);
  }
  return out;
}
// span の中から t だけを、同じ属性の span に入れて切り出す（前後は元の属性のまま残す）
function isolate(s, t) {
  const before = document.createRange(), after = document.createRange();
  before.setStart(s, 0); before.setEndBefore(t); after.setStartAfter(t); after.setEnd(s, s.childNodes.length);
  for (const [r, pos] of [[before, 'beforebegin'], [after, 'afterend']]) {
    if (r.collapsed) continue;
    const part = s.cloneNode(false); part.append(r.extractContents());
    if (part.textContent || part.querySelector('img,br')) s.insertAdjacentElement(pos, part);
  }
}
function bare(s) { if (!s.classList.length) s.removeAttribute('class'); return !s.attributes.length; }
// 属性の無くなった span を外し、隣り合う同じ属性の span をまとめる（原稿に [a]{.x}[b]{.x} と書かないため）
function tidy() {
  for (const s of [...active.querySelectorAll('span')].reverse()) if (bare(s)) s.replaceWith(...s.childNodes);
  const spans = () => [...active.querySelectorAll('span:not([data-slide-studio-atom])')].filter(s => !s.parentElement.closest('[data-slide-studio-atom],math'));
  // 色だけの span を大きさだけの span の外側にそろえる（隣の同じ色とまとまるように）
  for (const s of spans()) {
    const c = s.firstChild;
    if (s.childNodes.length !== 1 || c.nodeType !== 1 || c.tagName !== 'SPAN' || c.hasAttribute('data-slide-studio-atom')) continue;
    const only = (e, p, q) => PROPS[p].has(e) && !PROPS[q].has(e) && [...e.attributes].every(a => a.name === 'class' || a.name === 'style');
    if (!only(s, 'size', 'color') || !only(c, 'color', 'size')) continue;
    const outer = [...s.attributes].map(a => [a.name, a.value]), inner = [...c.attributes].map(a => [a.name, a.value]);
    outer.forEach(([n]) => s.removeAttribute(n)); inner.forEach(([n]) => c.removeAttribute(n));
    inner.forEach(([n, v]) => s.setAttribute(n, v)); outer.forEach(([n, v]) => c.setAttribute(n, v));
  }
  for (const s of spans()) {
    const prev = s.previousSibling;
    if (prev?.nodeType === 1 && prev.tagName === 'SPAN' && prev.cloneNode(false).isEqualNode(s.cloneNode(false))) { prev.append(...s.childNodes); s.remove(); }
  }
  active.normalize();
}
// prop の書式を targets に付け直す。value(t)：付ける span を作る関数（null なら外すだけ）
function restyle(prop, value) {
  if (!active) return;
  const r = range && active.contains(range.commonAncestorContainer) ? range : null;
  const a = r ? offsetOf(r.startContainer, r.startOffset) : null, b = r ? offsetOf(r.endContainer, r.endOffset) : null;
  const { has, strip } = PROPS[prop];
  for (const t of targets()) {
    const outer = [];
    for (let s = t.parentElement; s && s !== active; s = s.parentElement) if (s.tagName === 'SPAN' && has(s)) outer.push(s);
    for (const s of outer) { isolate(s, t); strip(s); if (bare(s)) s.replaceWith(...s.childNodes); }
    const span = value?.(t);
    if (span) { t.replaceWith(span); span.append(t); }
  }
  tidy();
  if (a != null) {
    const s = getSelection(), nr = document.createRange();
    nr.setStart(...pointAt(a)); nr.setEnd(...pointAt(b));
    s.removeAllRanges(); s.addRange(nr); range = nr.cloneRange();
  }
  active.focus({ preventScroll: true });
  changedNow();
}
const px = node => parseFloat(getComputedStyle(node.nodeType === 1 ? node : node.parentElement).fontSize);
function setSize(target) {
  restyle('size', target && (t => {
    const em = Math.round(target / px(t) * 1000) / 1000;
    if (Math.abs(em - 1) < 0.01) return null;
    const s = document.createElement('span'); writeStyle(s, { 'font-size': `${em}em` }); return s;
  }));
}
// ⊖⊕：選んだ文字の最初の大きさから、ブロックの文字の大きさに対する次の段へ。
// 段は整数の px にそろえる（小数になるのは打ち込んだときだけ）
function stepSize(dir) {
  const first = targets()[0]; if (!first) return;
  const base = px(active), now = px(first);
  const steps = [...new Set(SIZES.map(z => Math.round(z * base)))];
  const next = dir > 0 ? steps.find(v => v > now + 0.5) ?? steps.at(-1) : steps.findLast(v => v < now - 0.5) ?? steps[0];
  setSize(next);
}
// 選んでいなければブロック全体に（太字・斜体はブラウザの編集操作に任せる）
function command(cmd) {
  if (!active) return;
  active.focus({ preventScroll: true });
  const s = getSelection();
  if (range && !range.collapsed && active.contains(range.commonAncestorContainer)) { s.removeAllRanges(); s.addRange(range); }
  else { const all = document.createRange(); all.selectNodeContents(active); s.removeAllRanges(); s.addRange(all); }
  document.execCommand(cmd);
  changedNow();
}
const editor = {
  ready: true,
  // 編集画面ではスライドを押しても次へ送らない（送るのはキーと一覧）
  configure(h) { handlers = h; window.__slideStudioClickOff = true; },
  elements,
  leafAt,
  // frame：枠を出す外側の要素（余白の包みの中の段落を選んだときは、その包み）
  select(key, frame = null) {
    document.querySelectorAll('.slide-studio-selected, .slide-studio-frame').forEach(el => el.classList.remove('slide-studio-selected', 'slide-studio-quiet', 'slide-studio-frame'));
    elements(key).forEach(el => el.classList.add('slide-studio-selected', ...frame ? ['slide-studio-quiet'] : []));
    if (frame) elements(frame).forEach(el => el.classList.add('slide-studio-frame'));
  },
  // 装飾のメニューを開いている間（選択の枠を消す）
  designing(on) { document.documentElement.classList.toggle('slide-studio-designing', !!on); },
  // 段階表示のメニューで段 k にカーソルを合わせている間、今のページでその段に出るものを示す（null で消す）
  markStep(k) {
    document.querySelectorAll('.slide-studio-step-mark').forEach(el => el.classList.remove('slide-studio-step-mark'));
    if (k == null) return;
    const at = v => (Math.max(0, Math.floor(Number(v)) || 0)) === k;
    const page = document.querySelector('#stage > .slide.active');
    page?.querySelectorAll('[data-step], [data-highlight-step]').forEach(el => {
      if (at(el.dataset.step ?? el.dataset.highlightStep) && !el.parentElement.closest('.slide-studio-step-mark')) el.classList.add('slide-studio-step-mark');
    });
  },
  // 枠の色の層（1〜3）。原稿のブロック表示の線の色と合わせる
  layers(map) { document.querySelectorAll('[data-slide-studio]').forEach(el => { el.dataset.slideStudioLayer = map[el.dataset.slideStudio] ?? ''; }); },
  // 原稿のブロックにカーソルを合わせている間、スライドの同じブロックを示す
  hover(key) {
    document.querySelectorAll('.slide-studio-hover').forEach(el => el.classList.remove('slide-studio-hover'));
    if (key) elements(key).forEach(el => el.classList.add('slide-studio-hover'));
  },
  start(key, html, opts = {}) {
    if (active) return;
    const el = opts.cell ? cellOf(key, opts.cell) : elements(key)[0]; if (!el) return;
    plain = !!opts.plain;
    if (opts.cell) openCell(el, html);
    else {
      original = el.innerHTML;
      const t = document.createElement('template'); t.innerHTML = html;
      const prepared = t.content.firstElementChild;
      if (prepared?.tagName === el.tagName) el.innerHTML = prepared.innerHTML;
      editable(el);
    }
    if (opts.point) {
      const r = opts.point.lineEnd ? lineEndAt(el, opts.point.y) : caretAt(opts.point.x, opts.point.y);
      if (r && el.contains(r.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    } else if (isPlaceholder(el.innerText)) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  },
  startHeading(point) {
    if (active) return;
    const el = document.querySelector('.slide.active > h1, .slide.active > h2');
    if (!el) return;
    plain = true; original = el.innerHTML; editable(el);
    const r = caretAt(point.x, point.y);
    if (r && el.contains(r.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  },
  table: tableOf,
  // 押した所の表のセル
  cellAt(key, p) {
    const td = document.elementFromPoint(p.x, p.y)?.closest('td,th');
    return td && elements(key).some(el => el.contains(td)) ? cellPos(td) : null;
  },
  // 空の段落を出して編集する。where：before・after（ブロックの前後）、start・end（列の中）、
  // col-before・col-after（列の隣）、wrap-left・wrap-right（横並びで包む）
  create(key, where) {
    if (active) return false;
    plain = false;
    const els = elements(key); if (!els.length) return false;
    const p = document.createElement('p'); p.className = 'slide-studio-new';
    const first = els[0], last = els.at(-1), undo = [];
    const put = (ref, pos, node) => { ref.insertAdjacentElement(pos, node); undo.push(() => node.remove()); };
    const column = kids => { const c = document.createElement('div'); c.className = 'column'; c.append(...kids); return c; };
    if (where === 'before') put(first, 'beforebegin', p);
    else if (where === 'after') put(last, 'afterend', p);
    else if (where === 'start') put(first, 'afterbegin', p);
    else if (where === 'end') put(first, 'beforeend', p);
    else if (where === 'col-before' || where === 'col-after') put(where === 'col-before' ? first : last, where === 'col-before' ? 'beforebegin' : 'afterend', column([p]));
    else {
      const row = document.createElement('div'); row.className = 'columns';
      first.insertAdjacentElement('beforebegin', row);
      const own = column(els), add = column([p]);
      row.append(...(where === 'wrap-left' ? [add, own] : [own, add]));
      undo.push(() => { row.before(...els); row.remove(); });
    }
    created = () => undo.reverse().forEach(f => f());
    original = ''; editable(p);
    return true;
  },
  // 入力は打つたびに親へ渡して原稿に反映している。終えるときは最後の内容を渡す（戻すのは ⌘Z）
  async finish() {
    if (!active) return;
    const el = active; active = null;
    if (created) {
      const html = touched && el.textContent.trim() ? el.outerHTML : null;
      created(); created = null;
      await handlers.finished(html, { created: true });
      return;
    }
    const html = touched ? el.outerHTML : null;
    closeActive(el);
    await handlers.finished(html);
  },
  // 持って動かしたあとのクリックは選択にしない
  swallowClick() { swallow = true; setTimeout(() => { swallow = false; }, 0); },
  // 文字の書式（編集中だけ）。color：テーマの色のクラス名か '#rrggbb'、null で元の色
  color(value) {
    restyle('color', value && (() => {
      const s = document.createElement('span');
      if (value.startsWith('#')) writeStyle(s, { color: value }); else s.className = value;
      return s;
    }));
  },
  linkState: link.state, setLink: link.apply,
  size: setSize, stepSize, command,
  // 書式バーの欄から文字へ戻る（選んでいた範囲のまま）
  focus() {
    if (!active) return;
    active.focus({ preventScroll: true });
    if (range && active.contains(range.commonAncestorContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
  },
  clearFormat() { restyle('color', null); restyle('size', null); },
  // 書式バーに出す今の状態（選んだ範囲の始まりの文字）
  formatState() {
    if (!active) return null;
    const r = range && active.contains(range.commonAncestorContainer) ? range : null;
    const node = r ? r.startContainer : targets()[0] ?? active, at = node.nodeType === 1 ? node : node.parentElement;
    let color = null;
    for (let s = at; s && s !== active; s = s.parentElement) {
      if (s.tagName !== 'SPAN' || !PROPS.color.has(s)) continue;
      const c = colorClasses().find(c => s.classList.contains(c)) ?? readStyle(s).color;
      if (c) { color = c; break; }
    }
    const inside = sel => { const e = at.closest(sel); return !!e && active.contains(e); };
    return { px: Math.round(px(at) * 10) / 10, color, ink: getComputedStyle(at).color, bold: inside('b,strong'), italic: inside('i,em') };
  },
};
// 変換中（IME）の文字は送らず、決まったところで送る。足したばかりのブロックは終えたときにまとめて書く
const changed = e => {
  if (!active || e.isComposing || !active.contains(e.target)) return;
  touched = true; if (!created) handlers.input(active.outerHTML);
};
listen(document, 'input', changed, true);
listen(document, 'compositionend', changed, true);
// ページ見出しは1行。貼り付け元の書式は持ち込まない。
listen(document, 'paste', e => {
  if (!inHeading() || !active.contains(e.target)) return;
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/[\r\n]+/g, ' '));
}, true);
// 本文は Enter で行内改行。改行の直後でもう一度押したときだけ段落を分ける。
listen(document, 'beforeinput', e => {
  if (inHeading() && !e.isComposing && ['insertParagraph', 'insertLineBreak'].includes(e.inputType)) { e.preventDefault(); return; }
  if (!active || plain || e.isComposing || e.inputType !== 'insertParagraph' || !active.contains(e.target)) return;
  // セルの中は段落に分けられないので、いつも改行にする
  if (inCell()) { e.preventDefault(); document.execCommand('insertLineBreak'); return; }
  const selection = getSelection();
  if (!selection.rangeCount) return;
  const caret = selection.getRangeAt(0);
  const parent = caret.startContainer.nodeType === 1 ? caret.startContainer : caret.startContainer.parentElement;
  if (parent.closest('li,pre')) return;
  const before = caret.cloneRange(); before.selectNodeContents(active); before.setEnd(caret.startContainer, caret.startOffset);
  const fragment = before.cloneContents();
  const walk = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let last = null;
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node.nodeName === 'BR' || node.nodeType === Node.TEXT_NODE && node.textContent) last = node;
  }
  if (caret.collapsed && last?.nodeName === 'BR') {
    const after = caret.cloneRange(); after.selectNodeContents(active); after.setStart(caret.endContainer, caret.endOffset);
    const tail = after.cloneContents();
    // 文末の改行には、カーソル表示用の余分な br が付く。
    const placeholder = !tail.textContent && tail.querySelector('br') ? [...active.querySelectorAll('br')].at(-1) : null;
    // ブラウザの削除・段落分割を使い、文字の書式と編集履歴を保つ。
    document.execCommand('delete');
    placeholder?.remove();
    return;
  }
  e.preventDefault();
  document.execCommand('insertLineBreak');
}, true);
// 印は選択・ドラッグ・プレイヤーのクリックへ流さない。編集中なら保存後にメニューを開く。
listen(document, 'pointerdown', e => {
  if (active && !active.contains(e.target)) {
    const next = inCell() ? e.target.closest('td,th') : null;
    if (next && next.closest('table') === active.closest('table')) { moveToCell(next, true); return; }
    e.preventDefault(); editor.finish();
  }
}, true);
listen(window, 'keydown', e => {
  if (!handlers) return;
  // 印の Enter／Space はボタン本来のクリックに任せる（本文編集や次の step にしない）。
  if (e.target.closest?.('.slide-studio-step-badge') && ['Enter', ' '].includes(e.key)) { e.stopImmediatePropagation(); return; }
  if (active) {
    e.stopImmediatePropagation();
    if (inHeading()) {
      if ((e.metaKey || e.ctrlKey) && ['b', 'i', 'u', 'k', '[', ']'].includes(e.key.toLowerCase())) e.preventDefault();
      if (!e.isComposing && e.keyCode !== 229 && ['Escape', 'Enter'].includes(e.key)) { e.preventDefault(); editor.finish(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); editor.finish(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); editor.finish(); }
    if (e.key === 'Tab' && inCell() && !e.isComposing) { e.preventDefault(); tabCell(e.shiftKey ? -1 : 1); }
    // ⌘] ／⌘[ で文字を大きく／小さく（⌘B・⌘I はブラウザの編集操作のまま）
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.isComposing && (e.key === ']' || e.key === '[')) { e.preventDefault(); stepSize(e.key === ']' ? 1 : -1); }
  } else if (handlers.keydown(e)) e.stopImmediatePropagation();
}, true);
listen(window, 'keyup', e => { if (!active) handlers?.keyup?.(e); }, true);

 editor.configure(handlersForBridge);
 return { editor, active: () => active };
}
