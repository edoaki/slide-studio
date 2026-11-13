// 挿入と貼り付け。元：ai-slide mock/gui/insert.js（挿入メニュー・数式のプレビュー・表の入力・TSV の貼り付け）。
// 入口は2つで、同じメニューを開く：上のバーの ＋（ブロックを選んでいるときは / でも）と、原稿のブロック表示の行頭の /。
// （素材の画面のカードは持って動かして置く。assets.js）
// メニュー・貼り付けで入れる位置は「カーソルの後」：原稿で入力中ならその段落の後（文の中に入れる引用・脚注はカーソルの所）、
// スライドでブロックを選んでいればその後、どちらもなければ今のページの最後。
// 画像は素材（topics/<トピック>/images/）に置いてから入れる。図は Slide Studio の図の形式のものだけを入れられる。
// 数式・画像・図は、同じトピック（topic:）の発表の原稿で前に使ったものからも選べる（library.py。保存はしない）。
// 同じトピックの画像・図はそのまま共有する。
import { api, toast } from './api.js';
import { svg } from './icons.js';
import { S, PAGE_PLACEHOLDERS as P } from './strings.js';
import { tip } from './tip.js';
import * as op from './block-ops.js';
import { structureOf } from './structure.js';
import { imagePlaceholder } from './page-templates.js';
import { linkInput, linkMd } from './link-input.js';

const T = S.ins;
// words：/ のあとに打った文字で絞り込む（読みでも引ける）。inline：文の中に入れるもの
const ITEMS = [
  { key: 'link', icon: 'link', inline: true, words: ['リンク', 'りんく', 'link', 'url'] },
  { key: 'image', icon: 'image', words: ['画像', 'がぞう', '写真', 'image', 'img', 'picture'] },
  { key: 'figure', icon: 'fileCode', words: ['図', 'ず', 'html', 'fig', 'figure'] },
  { key: 'math', icon: 'sigma', words: ['数式', 'すうしき', '式', 'しき', 'math', 'tex', 'latex', 'equation'] },
  { key: 'table', icon: 'table', words: ['表', 'ひょう', 'table', 'tsv'] },
  { key: 'cite', icon: 'bookOpen', inline: true, words: ['引用', 'いんよう', '文献', 'ぶんけん', 'cite', 'citation', 'ref'] },
  { key: 'note', icon: 'superscript', inline: true, words: ['脚注', 'きゃくちゅう', '注', 'note', 'footnote'] },
  { key: 'code', icon: 'squareCode', words: ['コード', 'こーど', 'code', 'program'] },
];
// 数式の雛形。§ にカーソルを置く（§a§ は a を選んだ状態にする）。ボタンには記号だけを出し、名前はカーソルを合わせたときに出す。
// 行列などの環境は1行ずつ書く
const SNIPPETS = [
  ['frac', 'a⁄b', '\\frac{§}{}'], ['sub', 'xᵢ', '_{§}'], ['sup', 'x²', '^{§}'], ['sum', '∑', '\\sum_{i=1}^{n} §'],
  ['int', '∫', '\\int_{a}^{b} § \\, dx'], ['sqrt', '√', '\\sqrt{§}'], ['bold', '𝐱', '\\mathbf{§}'],
  ['expect', '𝔼', '\\mathbb{E}\\left[ § \\right]'], ['argmin', 'argmin', '\\mathop{\\mathrm{arg\\,min}}_{§}'],
  ['matrix', '[ ]', '\\begin{bmatrix}\n§a§ & b \\\\\nc & d\n\\end{bmatrix}'],
  ['aligned', '&=', '\\begin{aligned}\n§ &= \\\\\n &=\n\\end{aligned}'],
  ['cases', '{', '\\begin{cases}\n§ & (x \\ge 0) \\\\\n & (x < 0)\n\\end{cases}'],
];
// 画像の初めの幅：スライドの本文に収まる大きさ（縦長の画像は高さで決める）
const IMG_MAX_W = 1000, IMG_MAX_H = 440;

// ---------------------------------------------------------------- 原稿の書き方（e2e の単体テストでも使う）
export function imageMd(path, size) {
  const w = size?.w && size?.h ? Math.round(Math.min(size.w, IMG_MAX_W, IMG_MAX_H * size.w / size.h)) : null;
  return `![](${path}){${w ? `width=${w} ` : ''}fig-align="center"}`;
}
export const figureMd = ref => `{{< fig ${ref} >}}`;
export function codeMd(lang, code) {
  const fence = code.includes('```') ? '~~~~' : '```';
  return `${fence}${lang.trim().replace(/\s+/g, '')}\n${code.replace(/\n+$/, '')}\n${fence}`;
}
export const pureMath = s => { const m = s.trim().match(/^\$\$([\s\S]*)\$\$$/); return m && !m[1].includes('$$') ? m[1].trim() : null; };
// パイプテーブル。セルの | は \| にする
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { out.push(cur.trim()); cur = ''; } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}
export function parseTable(md) {
  const lines = md.trim().split('\n');
  if (lines.length < 2 || !op.TABLE_RULE.test(lines[1]) || !lines.every(l => l.includes('|'))) return null;
  const align = splitRow(lines[1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : c.startsWith(':') ? 'l' : null);
  const rows = [lines[0], ...lines.slice(2)].map(splitRow);
  const n = Math.max(align.length, ...rows.map(r => r.length));
  return { rows: rows.map(r => [...r, ...Array(n - r.length).fill('')]), align: [...align, ...Array(n - align.length).fill(null)] };
}
export function tableMd({ rows, align }) {
  const cell = c => ' ' + (c.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ') || ' ') + ' ';
  const sep = a => a === 'c' ? ':-:' : a === 'r' ? '--:' : a === 'l' ? ':--' : '---';
  const line = r => '|' + r.map(cell).join('|') + '|';
  return [line(rows[0]), '|' + align.map(sep).join('|') + '|', ...rows.slice(1).map(line)].join('\n').replace(/ {2,}\|/g, ' |');
}
export const tsvRows = t => {
  const rows = t.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map(l => l.split('\t').map(c => c.trim()));
  const n = Math.max(...rows.map(r => r.length));
  return rows.map(r => [...r, ...Array(n - r.length).fill('')]);
};
// 表計算のセル（2行2列以上）
export const isSheet = t => !!t && t.includes('\t') && (r => r.length > 1 && r[0].length > 1)(tsvRows(t));
// 前に使った数式の候補：打った所までが前から一致するもの、次に途中に含むもの（空白は無視）。何も打っていなければ使った数の順
const squash = s => s.replace(/\s+/g, '');
export function matchMath(items, typed, limit = 30) {
  const q = squash(typed);
  if (!q) return items.slice(0, limit);
  const rest = items.filter(it => squash(it.tex) !== q);
  const head = rest.filter(it => squash(it.tex).startsWith(q));
  return [...head, ...rest.filter(it => !head.includes(it) && squash(it.tex).includes(q))].slice(0, limit);
}
// 最近使った順（recent に入っているものが先、あとは元の順）
export function byRecent(items, key, recent) {
  const at = new Map(recent.map((k, i) => [k, i]));
  return items.map((it, i) => [at.get(key(it)) ?? recent.length + i, it]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
}
const RECENT_MAX = 50;
function recentList(name) { try { const v = JSON.parse(localStorage.getItem(`slide-studio.recent.${name}`)); return Array.isArray(v) ? v : []; } catch { return []; } }
function used(name, key) {
  try { localStorage.setItem(`slide-studio.recent.${name}`, JSON.stringify([key, ...recentList(name).filter(k => k !== key)].slice(0, RECENT_MAX))); } catch { /* 覚えられなくても動く */ }
}
function pref(name, v) {
  try { if (v === undefined) return JSON.parse(localStorage.getItem(`slide-studio.${name}`)); localStorage.setItem(`slide-studio.${name}`, JSON.stringify(v)); } catch { /* 覚えられなくても動く */ }
  return null;
}
// Pandoc の出力の math だけを使う（スクリプトなどは入らない）
function mathNode(html) {
  const m = html && new DOMParser().parseFromString(html, 'text/html').querySelector('math');
  return m ? document.importNode(m, true) : null;
}
function* walk(cs) { for (const c of cs) { yield c; yield* walk(c.children); } }
// md を段落として入れる。anchor：{ key }（そのブロックの後）か { pos }（その位置を含むブロックの後）。
// どちらも使えなければ page のページの最後
export function insertAt(text, st, anchor, md, page) {
  if (anchor?.key && op.find(st, anchor.key)) return imagePlaceholder(text, st, anchor.key, md) || op.insertBlock(text, st, anchor.key, 'after', md);
  const pos = anchor?.pos;
  const p = pos != null ? st.pages.findLast(x => x.start <= pos) : st.pages[page] ?? st.pages.at(-1);
  if (!p) return { text: `${text.replace(/\s*$/, '')}\n\n${md}\n`, select: null };
  if (p.raw_only) {
    const at = pos != null && pos > p.head_end ? Math.min(pos, p.end) : p.end;
    const pre = text.slice(0, at).replace(/\s*$/, '');
    return { text: `${pre}\n\n${md}\n\n${text.slice(at).replace(/^\s*/, '')}`, select: null };
  }
  const kids = p.chunks.filter(c => c.kind !== 'def');
  const inside = pos != null ? [...walk(p.chunks)].filter(c => c.kind !== 'def' && c.start <= pos && pos <= c.end).at(-1) : null;
  const replacement = inside && imagePlaceholder(text, st, inside.key, md);
  if (replacement) return replacement;
  const before = inside || (pos != null ? kids.filter(c => c.end <= pos) : kids).at(-1);
  if (before) return op.insertBlock(text, st, op.inner(before).key, 'after', md);
  if (kids[0]) return op.insertBlock(text, st, op.inner(kids[0]).key, 'before', md);
  return { text: `${text.slice(0, p.head_end)}\n\n${md}${text.slice(p.head_end)}`, select: `p${p.index}/0` };
}
// 文の中に入れる（引用・脚注）。前が英数字なら空白を1つはさむ
export function inlineAt(text, pos, md) {
  const space = /[A-Za-z0-9.,;:)\]]$/.test(text.slice(0, pos)) ? ' ' : '';
  return text.slice(0, pos) + space + md + text.slice(pos);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 欄に打ったのと同じように入れる（⌘Z で戻せる。setRangeText・value の代入は戻せない）
function typeIn(ta, text, from, to) {
  ta.setSelectionRange(from, to);
  if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, from, to, 'end');
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function ibtn(icon, name, keys = '', cls = '') {
  const b = el('button', `ibtn ${cls}`.trim()); b.type = 'button'; b.innerHTML = svg(icon);
  return tip(b, name, keys);
}
export async function imageSize(src) {
  try {
    // スライドの iframe で貼ったファイルは別の window の Blob なので instanceof では判定しない
    if (typeof src !== 'string') { const b = await createImageBitmap(src); const s = { w: b.width, h: b.height }; b.close(); return s; }
    const img = new Image(); img.src = src; await img.decode();
    return img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  } catch { return null; }
}

export function makeInsert(ctx) {
  let dead = false, menu = null, pop = null, dismissed = null;
  const deck = encodeURIComponent(ctx.deck);

  // ------------------------------------------------------------ 入れる位置
  function anchor() {
    const text = ctx.text, c = ctx.qmdBlocks?.caret();
    if (c?.live) return { pos: c.pos, text };
    const ta = ctx.editor.ta;
    if (document.activeElement === ta && ta.offsetParent) return { pos: ctx.editor.caretOffset(), text };
    const key = ctx.blocks?.selected;
    if (key) return { key, text };
    if (c) return { pos: c.pos, text };
    return { text };
  }
  // 原稿の入力欄を閉じ、スライドの文字の編集を終えてから書く
  async function settle() {
    ctx.qmdBlocks?.input?.blur();
    if (ctx.blocks?.editing) {
      await ctx.blocks.finish?.();
      for (let i = 0; i < 100 && ctx.blocks.editing && !dead; i++) await sleep(30);
    }
  }
  async function placeBlock(md, a) {
    if (!md) return false;
    if (ctx.locked) { toast(S.locked); return false; }
    await settle();
    const text = ctx.text, st = await structureOf(text);
    if (dead || text !== ctx.text) return false;
    // 位置は書いたときの原稿のもの。原稿が変わっていたらブロックのキーだけを使う
    const r = insertAt(text, st, a?.text === text ? a : { key: a?.key }, md, ctx.editor.page);
    if (!r) return false;
    if (ctx.blocks?.write) ctx.blocks.write(r); else ctx.setText(r.text);
    return true;
  }
  async function placeInline(md, a) {
    if (ctx.locked) { toast(S.locked); return false; }
    await settle();
    const text = ctx.text;
    let pos = a?.text === text ? a.pos : null;
    if (pos == null && a?.key) {
      // 選んでいる文の最後に入れる（数式・表・コードの後ろには入れない）
      const st = await structureOf(text), c = op.find(st, a.key)?.chunk, raw = c ? text.slice(c.start, c.end) : '';
      if (c?.kind === 'text' && pureMath(raw) == null && !parseTable(raw) && !/^\s*(```|~~~|\$\$)/.test(raw)) pos = c.start + raw.trimEnd().length;
    }
    if (pos == null || text !== ctx.text) { toast(T.inlineOnly); return false; }
    ctx.setText(inlineAt(text, pos, md));
    return true;
  }
  // 持って動かして落とした所に入れる（target は ctx.blocks.dropAt の結果）
  async function placeDrop(md, target) {
    if (!md || !target) return false;
    if (ctx.locked) { toast(S.locked); return false; }
    await settle();
    const text = ctx.text, st = await structureOf(text), sp = target.spec;
    if (dead || text !== ctx.text) return false;
    const r = imagePlaceholder(text, st, sp.key, md) || (sp.pageEnd != null ? insertAt(text, st, {}, md, sp.pageEnd)
      : sp.into ? op.insertBlock(text, st, sp.into, 'after', md) : op.insertBlock(text, st, sp.key, sp.side, md));
    if (!r) return false;
    if (ctx.blocks?.write) ctx.blocks.write(r); else ctx.setText(r.text);
    return true;
  }
  // 選んだブロックを置き換える（数式・表を直す）。md が空なら、そのブロックを消す
  async function replaceBlock(key, raw, md) {
    if (ctx.locked) { toast(S.locked); return; }
    const text = ctx.text, st = await structureOf(text), c = op.find(st, key)?.chunk;
    if (!c || text.slice(c.start, c.end) !== raw || text !== ctx.text) { toast(S.blockWait); return; }
    const r = md ? { text: text.slice(0, c.start) + md + text.slice(c.end), select: key } : op.remove(text, st, key);
    if (!r) return;
    if (ctx.blocks?.write) ctx.blocks.write(r); else ctx.setText(r.text);
  }

  // ------------------------------------------------------------ トピック（同じ topic: の発表で前に使ったもの）
  let libCache = null;
  function library() {
    if (!libCache || libCache.text !== ctx.text || Date.now() - libCache.at > 30000) {
      const p = api(`/api/deck/${deck}/library`);
      p.catch(() => { if (libCache?.p === p) libCache = null; });
      libCache = { text: ctx.text, at: Date.now(), p };
    }
    return libCache.p;
  }
  // ------------------------------------------------------------ ファイル（貼り付け・パソコンから）
  async function addFiles(files, a) {
    const mds = [];
    for (const f of files) {
      try {
        const size = f.type.startsWith('image/') ? await imageSize(f) : null;
        const r = await ctx.assets.upload(f);
        if (r.kind === 'images') mds.push(imageMd(r.path, size));
        else toast(S.as.htmlStored);
        if (r.reused) toast(S.as.reused);
      } catch (e) { toast(e.message); }
    }
    ctx.assets.refresh();
    return placeBlock(mds.join('\n\n'), a);
  }
  function pickFiles(accept) {
    return new Promise(resolve => {
      const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true, accept });
      const end = fs => { input.remove(); resolve(fs); };
      input.addEventListener('change', () => end([...input.files]));
      input.addEventListener('cancel', () => end([]));
      document.body.append(input); // DOM の外の入力欄では選択の画面を開かないブラウザがある
      input.click();
    });
  }
  // 素材の原稿の書き方
  async function itemMd(item) {
    if (item.kind === 'image') return imageMd(item.path, await imageSize(item.url));
    if (item.status === 'ng') { toast(S.as.cannotInsert); return null; }
    return figureMd(item.ref);
  }
  // 挿入メニューの選ぶ画面から入れる
  async function addItem(item, a = anchor()) { return placeBlock(await itemMd(item), a); }
  // 素材の画面から持ってきて落とす
  async function dropItem(item, target) { return placeDrop(await itemMd(item), target); }

  // ------------------------------------------------------------ 貼り付け
  // 画像のファイルは素材に置いて、カーソルの後に入れる。原稿で表計算のセル（TSV）を貼ると表にする
  function paste(e, inSlide) {
    const dt = e.clipboardData; if (!dt || dead) return;
    const t = e.target, files = [...dt.files].filter(f => f.type.startsWith('image/') || /\.html?$/i.test(f.name));
    if (!inSlide) {
      if (t.closest?.('.ins-pop')) return;
      const inQmd = t.matches?.('#qblocks textarea.text') || t === ctx.editor.ta;
      if (!inQmd && t.closest?.('input, textarea, select, [contenteditable="true"]')) return; // チャットなど
      if (!files.length && !(inQmd && isSheet(dt.getData('text/plain')))) return;
    } else if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    const a = anchor();
    if (files.length) addFiles(files, a);
    else { const rows = tsvRows(dt.getData('text/plain')); placeBlock(tableMd({ rows, align: rows[0].map(() => null) }), a); }
  }
  const onPaste = e => paste(e, false);
  document.addEventListener('paste', onPaste, true);

  // ------------------------------------------------------------ メニュー（原稿の行頭の / と、ブロックを選んでいるときの /）
  function place(node, r) {
    const w = node.offsetWidth, h = node.offsetHeight;
    let y = r.bottom + 6;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
    node.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`;
    node.style.top = `${y}px`;
  }
  // slash：{ ta, ls }（原稿の / から開いたとき。選ぶと / と絞り込みの文字を消す）
  function openMenu({ rect, query = '', slash = null, target = null }) {
    const q = query.toLowerCase();
    const items = ITEMS.filter(it => !q || it.words.some(w => w.toLowerCase().startsWith(q)) || T[it.key].toLowerCase().startsWith(q));
    if (!items.length) { closeMenu(); return; }
    if (!menu) {
      const m = el('div', 'ins-menu'); m.setAttribute('role', 'menu'); m.setAttribute('aria-label', T.menu);
      m.addEventListener('mousedown', e => e.preventDefault());
      m.addEventListener('click', e => { const b = e.target.closest('button'); if (b) choose(+b.dataset.i); });
      document.body.append(m);
      menu = { el: m, i: 0 };
    }
    const keep = menu.items?.[menu.i];
    Object.assign(menu, { items, slash, rect, target, i: Math.max(0, items.indexOf(keep)) });
    menu.el.replaceChildren(...items.map((it, i) => {
      const b = ibtn(it.icon, T[it.key], i === 0 && slash ? 'Enter' : ''); b.dataset.i = i; b.setAttribute('role', 'menuitem'); b.dataset.key = it.key;
      return b;
    }));
    place(menu.el, rect);
    mark();
  }
  function mark() {
    const bs = menu.el.querySelectorAll('button');
    bs.forEach((b, i) => b.classList.toggle('on', i === menu.i));
    if (!menu.slash) bs[menu.i].focus({ preventScroll: true });
  }
  function closeMenu() {
    if (!menu) return;
    menu.el.remove(); menu = null;
  }
  function choose(i) {
    const { items, slash, rect, target } = menu, it = items[i];
    closeMenu();
    if (slash?.ta.isConnected) {
      // 打った / と絞り込みの文字を消す。行が空になるなら、その行も消す
      const ta = slash.ta, end = ta.selectionStart;
      let from = slash.ls;
      if (from > 0 && ta.value[from - 1] === '\n' && (end === ta.value.length || ta.value[end] === '\n')) from--;
      ta.setRangeText('', from, end, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    run(it.key, target || anchor(), rect);
  }
  function run(key, a, rect) {
    if (key === 'link') {
      const input = linkInput({ label: true,
        done: (url, text) => { closePop(); placeInline(linkMd(text, url), a); }, cancel: () => closePop(),
      });
      openPop('ins-link', rect, { confirm: input.submit, ok: false, focus: input.focus }).append(input.node);
      pop.key = e => { if (e.key === 'Enter') { input.submit(); return true; } return false; };
      return;
    }
    if (key === 'image') openPicker('images', a, rect);
    else if (key === 'figure') openPicker('html', a, rect);
    else if (key === 'math') openMath(rect, '', md => placeBlock(md, a));
    else if (key === 'table') openTable(rect, null, md => placeBlock(md, a));
    else if (key === 'cite') openCite(rect, md => placeInline(md, a));
    else if (key === 'note') openNote(rect, md => placeInline(md, a));
    else if (key === 'code') openCode(rect, md => placeBlock(md, a));
  }

  // 原稿のブロック表示の行頭の /（全角の ／ でもよい）
  function slashInput(e) {
    const ta = e.target;
    if (!ta.matches?.('#qblocks textarea.text')) return;
    const a = ta.selectionStart, v = ta.value;
    const ls = v.lastIndexOf('\n', a - 1) + 1, line = v.slice(ls, a), rest = v.slice(a).split('\n')[0];
    if (a !== ta.selectionEnd || !/^[/／][^\s/／]*$/.test(line) || rest.trim()) { if (menu?.slash) closeMenu(); dismissed = null; return; }
    if (dismissed === ta && menu == null) return;
    const r = ta.getBoundingClientRect(), lineTop = r.top + (v.slice(0, ls).split('\n').length) * 21;
    openMenu({ rect: { left: r.left + 8, right: r.left + 8, top: lineTop - 21, bottom: Math.min(lineTop, r.bottom) }, query: line.slice(1), slash: { ta, ls } });
  }
  document.addEventListener('input', slashInput);

  // ------------------------------------------------------------ 入力の画面（共通）
  // 右上に ✓（入れて閉じる。外を押す・⌘Enter と同じ）と ✕（やめる。Esc と同じ）。選ぶだけの画面は ✕ だけ
  const act = (icon, name, keys, fn) => {
    const b = tip(el('button', `ibtn ${icon}`), name, keys); b.type = 'button'; b.innerHTML = svg(icon);
    b.onmousedown = e => e.preventDefault(); b.onclick = fn;
    return b;
  };
  function openPop(cls, rect, { confirm, focus, ok = true }) {
    closePop();
    const node = el('div', `ins-pop ${cls}`); node.setAttribute('role', 'dialog');
    const acts = el('div', 'acts');
    if (ok) acts.append(act('check', T.apply, '⌘Enter', () => pop?.confirm()));
    acts.append(act('x', T.cancel, 'Esc', closePop));
    node.append(acts);
    document.body.append(node);
    pop = { el: node, confirm, rect };
    // 置いてから最初の欄へ。すでに中の欄を押していたら、そのままにする
    requestAnimationFrame(() => { if (pop?.el === node) { place(node, rect); if (!node.contains(document.activeElement)) focus?.(); } });
    return node;
  }
  function closePop() { if (pop) { pop.el.remove(); pop = null; } }


  // ------------------------------------------------------------ 画像・図を選ぶ
  async function openPicker(kind, a, rect) {
    const node = openPop('ins-pick', rect, { confirm: closePop, ok: false, focus: () => node.querySelector('.tile:not(:disabled)')?.focus({ preventScroll: true }) });
    const grid = el('div', 'tiles'); grid.setAttribute('role', 'listbox'); grid.setAttribute('aria-label', T[kind === 'images' ? 'image' : 'figure']);
    node.append(grid);
    let list;
    try { list = await ctx.assets.list(); } catch (e) { toast(e.message); closePop(); return; }
    if (pop?.el !== node) return;
    const items = list[kind];
    for (const item of items) {
      const b = el('button', 'tile'); b.type = 'button'; b.setAttribute('role', 'option');
      b.append(ctx.assets.thumb(item), el('span', 'nm', item.name));
      ctx.assets.mark(b, item);
      if (item.status === 'ng') b.disabled = true;
      else b.onclick = () => { closePop(); addItem(item, a); };
      grid.append(b);
    }
    if (kind === 'images') {
      const pc = tip(el('button', 'tile pc'), T.fromPc); pc.type = 'button'; pc.innerHTML = svg('upload');
      pc.onclick = async () => { closePop(); const fs = await pickFiles('image/*'); if (fs.length) addFiles(fs, a); };
      grid.append(pc);
    }
    if (kind !== 'images' && !items.some(x => x.status !== 'ng')) grid.prepend(el('div', 'empty', T.noFigures));
    grid.style.setProperty('--n', Math.max(1, Math.min(4, grid.querySelectorAll('.tile').length)));
    place(node, rect);
    node.querySelector('.tile:not(:disabled)')?.focus({ preventScroll: true });
    pop.key = e => {
      const ts = [...grid.querySelectorAll('.tile:not(:disabled)')], i = ts.indexOf(document.activeElement);
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      if (!d || i < 0) return false;
      ts[Math.max(0, Math.min(ts.length - 1, i + d))].focus(); return true;
    };
  }

  // ------------------------------------------------------------ 横に並べる帯（横に滑らせるか、‹ › で見えている分ずつ。端では反対の端へ）
  function strip(cls, label) {
    const row = el('div', 'row'); row.setAttribute('role', 'listbox'); row.setAttribute('aria-label', label);
    const prev = ibtn('chevL', T.prev, '', 'pg'), next = ibtn('chevR', T.next, '', 'pg');
    const node = el('div', `strip ${cls}`); node.append(prev, row, next);
    const page = d => {
      const max = row.scrollWidth - row.clientWidth;
      const to = d > 0 ? (row.scrollLeft >= max - 1 ? 0 : row.scrollLeft + row.clientWidth) : (row.scrollLeft <= 1 ? max : row.scrollLeft - row.clientWidth);
      row.scrollTo({ left: to, behavior: 'smooth' });
    };
    for (const [b, d] of [[prev, -1], [next, 1]]) { b.onmousedown = e => e.preventDefault(); b.onclick = () => page(d); }
    // 縦の回転も横に送る
    row.addEventListener('wheel', e => { if (!e.deltaX && e.deltaY) { row.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    const update = () => { const over = row.scrollWidth > row.clientWidth + 1; prev.hidden = next.hidden = !over; node.hidden = !row.children.length; };
    new ResizeObserver(update).observe(row);
    return { el: node, row, update };
  }
  // 入力の画面を持って動かす（欄・ボタン・帯の上と、右下の大きさのつまみ以外の所を掴む）
  function movable(node) {
    node.addEventListener('pointerdown', e => {
      if (e.button || e.target.closest('textarea, input, button, .row')) return;
      const r = node.getBoundingClientRect();
      if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) return;
      e.preventDefault();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      node.setPointerCapture(e.pointerId); node.classList.add('moving');
      const move = ev => {
        node.style.left = `${Math.max(0, Math.min(innerWidth - 40, ev.clientX - dx))}px`;
        node.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy))}px`;
        if (pop?.el === node) pop.moved = true;
      };
      const up = () => { node.classList.remove('moving'); node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up); };
      node.addEventListener('pointermove', move); node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
    });
  }

  // ------------------------------------------------------------ 数式（打ちながら MathML で確かめる）
  // 上から、書く欄・どう出るか・前に使った数式・雛形。外を押すか ✓ で入れて閉じる（Esc・✕ でやめる）。
  // 画面は持って動かせ、右下で大きさを変えられる（大きさは覚えておく）
  function openMath(rect, tex, done) {
    const ta = el('textarea'); ta.spellcheck = false; ta.value = tex; ta.placeholder = T.mathPh; ta.rows = 2;
    ta.setAttribute('aria-label', T.math);
    const ok = () => {
      const src = ta.value.trim(); closePop();
      if (!src) { if (tex.trim()) done(''); return; } // 直している数式を空にしたら消す
      used('math', squash(src));
      if (src !== tex.trim()) done(`$$\n${src}\n$$`);
    };
    const node = openPop('ins-math', rect, { confirm: ok, focus: () => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } });
    const size = pref('mathPop');
    if (size?.w) node.style.width = `${size.w}px`;
    if (size?.h) node.style.height = `${size.h}px`;
    movable(node);
    // 書いた分だけ欄を広げる
    const grow = () => {
      ta.style.flexGrow = '0'; ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight + 2, innerHeight * 0.6)}px`; ta.style.flexGrow = '';
    };
    const pv = el('div', 'pv'); pv.setAttribute('aria-live', 'polite');
    // 前に使った数式（打つと絞られる）。押すか Tab で欄に入れて、直してから入れられる
    const past = strip('cands', T.mathCands);
    let pool = [], shown = [], hi = -1;
    function suggest() {
      shown = matchMath(pool, ta.value); hi = Math.min(hi, shown.length - 1);
      past.row.replaceChildren(...shown.map((it, i) => {
        const b = tip(el('button', `cand${i === hi ? ' on' : ''}`), `${it.tex} / ${T.usedIn(it.decks)}`, i === 0 ? 'Tab' : ''); b.type = 'button';
        b.setAttribute('role', 'option'); b.tabIndex = -1;
        const m = mathNode(it.html); if (m) b.append(m); else b.textContent = it.tex;
        b.onmousedown = e => e.preventDefault();
        b.onclick = () => fill(it);
        return b;
      }));
      past.row.scrollLeft = 0; past.update();
    }
    function fill(it) {
      ta.focus(); typeIn(ta, it.tex, 0, ta.value.length);
      hi = -1; changed();
    }
    library().then(l => {
      if (pop?.el !== node) return;
      pool = byRecent(l.math, it => squash(it.tex), recentList('math')); suggest();
      if (!pop.moved) place(node, rect);
    }).catch(() => {});
    // 雛形（最近使った順）
    const snips = strip('snips', T.snippetsLabel);
    for (const [k, label, code] of byRecent(SNIPPETS, x => x[0], recentList('snippets'))) {
      const b = tip(el('button', 'snip', label), T.snippets[k]); b.type = 'button'; b.tabIndex = -1;
      b.onmousedown = e => e.preventDefault();
      b.onclick = () => {
        const parts = code.split('§'), [pre, mid] = parts.length === 3 ? [parts[0], parts[1]] : [parts[0], ''], post = parts.at(-1);
        const a = ta.selectionStart, sel = ta.value.slice(a, ta.selectionEnd) || mid;
        ta.focus(); typeIn(ta, pre + sel + (parts.length > 1 ? post : ''), a, ta.selectionEnd);
        ta.setSelectionRange(a + pre.length + (sel === mid ? 0 : sel.length), a + pre.length + sel.length);
        used('snippets', k); changed();
      };
      snips.row.append(b);
    }
    node.append(ta, pv, past.el, snips.el);
    snips.update();
    // 大きさを変えたら覚える（持って動かすだけのときは覚えない）
    let first = true;
    new ResizeObserver(() => {
      if (first) { first = false; return; }
      if (node.isConnected && node.offsetWidth && (node.style.width || node.style.height)) pref('mathPop', { w: node.offsetWidth, h: node.style.height ? node.offsetHeight : null });
    }).observe(node);
    pop.key = e => {
      if (e.target !== ta || !shown.length) return false;
      const n = shown.length;
      if (e.key === 'ArrowDown' && (hi >= 0 || ta.selectionStart === ta.value.length)) hi = Math.max(hi, 0);
      else if (e.key === 'ArrowUp' && hi >= 0) hi = -1;
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && hi >= 0) hi = (hi + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
      else if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && hi >= 0)) { fill(shown[Math.max(0, hi)]); return true; }
      else return false;
      past.row.querySelectorAll('.cand').forEach((b, i) => b.classList.toggle('on', i === hi));
      past.row.children[hi]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    };
    let timer = 0, seq = 0;
    function render() {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const n = ++seq, src = ta.value.trim();
        if (!src) { pv.replaceChildren(); pv.classList.remove('err'); return; }
        try {
          const { html } = await api('/api/math', { method: 'POST', body: { tex: src } });
          if (n !== seq) return;
          const m = mathNode(html);
          pv.classList.remove('err'); pv.replaceChildren(...m ? [m] : []);
        } catch { if (n === seq) { pv.classList.add('err'); pv.textContent = T.mathError; } }
      }, 150);
    }
    function changed() { grow(); render(); suggest(); }
    ta.addEventListener('input', changed);
    requestAnimationFrame(grow);
    render();
  }

  // ------------------------------------------------------------ 表（Tab で次のセル、TSV を貼ると広がる）
  function openTable(rect, init, done) {
    const t = init ? structuredClone(init) : { rows: [['', '', ''], ['', '', ''], ['', '', '']], align: [null, null, null] };
    const grid = el('div', 'grid');
    const ok = () => {
      closePop();
      // 中身のない行と列は捨てる
      const keep = t.rows[0].map((_, c) => t.rows.some(r => r[c].trim()));
      if (!keep.some(Boolean)) { if (init) done(''); return; } // 直している表を空にしたら消す
      const rows = t.rows.filter((r, i) => i === 0 || r.some(v => v.trim())).map(r => r.filter((_, c) => keep[c]));
      const md = tableMd({ rows: rows.length > 1 ? rows : [...rows, rows[0].map(() => '')], align: t.align.filter((_, c) => keep[c]) });
      if (!init || md !== tableMd(init)) done(md);
    };
    const node = openPop('ins-table', rect, { confirm: ok, focus: () => inputAt(0, 0)?.focus() });
    node.append(grid, el('div', 'hint', T.tableHint));
    const cols = () => t.rows[0].length;
    const inputAt = (r, c) => grid.querySelector(`input[data-r="${r}"][data-c="${c}"]`);
    function draw(fr = 0, fc = 0) {
      grid.style.setProperty('--cols', cols());
      grid.replaceChildren();
      t.rows.forEach((row, r) => {
        row.forEach((v, c) => {
          const i = el('input'); i.value = v; i.dataset.r = r; i.dataset.c = c; i.spellcheck = false;
          i.className = `${r === 0 ? 'h r0' : ''}${c === 0 ? ' c0' : ''}`;
          i.setAttribute('aria-label', T.cell(r + 1, c + 1));
          i.style.gridArea = `${r + 1} / ${c + 1}`;
          i.addEventListener('input', () => { t.rows[r][c] = i.value; });
          grid.append(i);
        });
      });
      const col = ibtn('plus', T.addCol, '', 'add'); col.style.gridArea = `1 / ${cols() + 1} / ${t.rows.length + 1}`;
      col.onclick = () => { t.rows.forEach(x => x.push('')); t.align.push(null); draw(0, cols() - 1); };
      const row = ibtn('plus', T.addRow, '', 'add row'); row.style.gridArea = `${t.rows.length + 1} / 1 / auto / ${cols() + 1}`;
      row.onclick = () => { t.rows.push(Array(cols()).fill('')); draw(t.rows.length - 1, 0); };
      grid.append(col, row);
      if (pop?.el === node) { place(node, rect); inputAt(fr, fc)?.focus({ preventScroll: true }); }
    }
    grid.addEventListener('paste', e => {
      const i = e.target.closest('input'), text = e.clipboardData.getData('text/plain');
      if (!i || (!text.includes('\t') && !text.includes('\n'))) return;
      e.preventDefault(); e.stopPropagation();
      const data = tsvRows(text), r0 = +i.dataset.r, c0 = +i.dataset.c;
      while (cols() < c0 + Math.max(...data.map(r => r.length))) { t.rows.forEach(x => x.push('')); t.align.push(null); }
      while (t.rows.length < r0 + data.length) t.rows.push(Array(cols()).fill(''));
      data.forEach((row, r) => row.forEach((v, c) => { t.rows[r0 + r][c0 + c] = v; }));
      draw(r0 + data.length - 1, c0 + data.at(-1).length - 1);
    });
    pop.key = e => {
      const i = e.target.closest?.('input'); if (!i) return false;
      const r = +i.dataset.r, c = +i.dataset.c, n = cols();
      if (e.key === 'Tab') {
        const k = r * n + c + (e.shiftKey ? -1 : 1);
        if (k < 0) return true;
        if (k >= t.rows.length * n) { t.rows.push(Array(n).fill('')); draw(r + 1, 0); return true; }
        inputAt(Math.floor(k / n), k % n).focus(); return true;
      }
      if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) { const d = inputAt(r + 1, c); if (d) d.focus(); else { t.rows.push(Array(n).fill('')); draw(r + 1, c); } return true; }
      return false;
    };
    draw();
  }

  // ------------------------------------------------------------ 文献の引用（reference.bib から選ぶ）
  async function openCite(rect, done) {
    const input = el('input'); input.type = 'search'; input.placeholder = T.citeSearch; input.setAttribute('aria-label', T.citeSearch);
    const list = el('div', 'cites'); list.setAttribute('role', 'listbox');
    let entries = [], shown = [], cur = 0;
    const pick = e => { closePop(); if (e) done(`[@${e.key}]`); };
    const node = openPop('ins-cite', rect, { confirm: () => pick(null), ok: false, focus: () => input.focus() });
    node.append(input, list);
    function draw() {
      const q = input.value.trim().toLowerCase();
      shown = entries.filter(e => !q || [e.key, e.author, e.title, e.year].some(s => s.toLowerCase().includes(q)));
      cur = Math.min(cur, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.length ? shown.map((e, i) => {
        const b = el('button', `cite${i === cur ? ' on' : ''}`); b.type = 'button'; b.setAttribute('role', 'option');
        b.append(el('span', 'k', e.key), el('span', 'a', [e.author, e.year].filter(Boolean).join(' ')), el('span', 't', e.title));
        if (e.unverified) b.append(el('span', 'u', T.unverified));
        b.onmousedown = ev => ev.preventDefault(); b.onclick = () => pick(e);
        if (!e.unverified) return b;
        const row = el('div', 'cite-row');
        const verified = act('check', T.verifyBib, '', async () => {
          try {
            entries = (await api(`/api/deck/${deck}/bib`, { method: 'POST', body: { key: e.key } })).entries;
            draw();
          } catch (error) { toast(error.message); }
        });
        row.append(b, verified);
        return row;
      }) : [el('div', 'empty', entries.length ? '' : T.noBib)]);
      list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    }
    input.addEventListener('input', () => { cur = 0; draw(); });
    pop.key = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { cur = Math.max(0, Math.min(shown.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1))); draw(); return true; }
      if (e.key === 'Enter') { pick(shown[cur]); return true; }
      return false;
    };
    try { entries = (await api(`/api/deck/${deck}/bib`)).entries; } catch (e) { toast(e.message); }
    if (pop?.el === node) { draw(); place(node, rect); }
  }

  // ------------------------------------------------------------ 脚注・コード
  function openNote(rect, done) {
    const input = el('input'); input.placeholder = T.notePh; input.setAttribute('aria-label', T.note);
    const ok = () => { const v = input.value.trim(); closePop(); if (v) done(`^[${v.replace(/[[\]]/g, m => `\\${m}`)}]`); };
    openPop('ins-note', rect, { confirm: ok, focus: () => input.focus() }).append(input);
    pop.key = e => { if (e.key === 'Enter') { ok(); return true; } return false; };
  }
  function openCode(rect, done) {
    const lang = el('input', 'lang'); lang.placeholder = T.codeLang; lang.setAttribute('aria-label', T.codeLang);
    const ta = el('textarea'); ta.placeholder = T.codePh; ta.rows = 6; ta.spellcheck = false; ta.setAttribute('aria-label', T.code);
    const ok = () => { const v = ta.value; closePop(); if (v.trim()) done(codeMd(lang.value, v)); };
    openPop('ins-code', rect, { confirm: ok, focus: () => ta.focus() }).append(lang, ta);
    ta.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || e.shiftKey) return;
      e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
    });
  }

  // ------------------------------------------------------------ キー
  function onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (!menu && !pop && e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && e.target.matches?.('#qblocks textarea.text') && e.target.value.trim() === P.image) {
      e.preventDefault(); e.stopPropagation(); openMenu({ rect: e.target.getBoundingClientRect(), target: anchor() }); return;
    }
    if (pop && pop.el.contains(e.target)) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closePop(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); pop.confirm(); return; }
      if (pop.key?.(e)) e.preventDefault();
      return;
    }
    if (!menu) return;
    const n = menu.items.length, move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (move) { menu.i = (menu.i + move + n) % n; mark(); }
    else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) choose(menu.i);
    else if (e.key === 'Escape') { const slash = menu.slash; if (slash) dismissed = slash.ta; closeMenu(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  }
  addEventListener('keydown', onKey, true);
  // 外を押したら閉じる（入力の画面は、書いた分を入れる。Esc・✕ でやめる）
  function outside(e) {
    if (menu && !menu.el.contains(e.target)) closeMenu();
    if (pop && !pop.el.contains(e.target)) pop.confirm();
  }
  addEventListener('pointerdown', outside, true);

  // ------------------------------------------------------------ スライドの数式・表を直す
  // スライドで選んだブロックの道具の下に出す（道具がなければスライドの枠）
  const toolsRect = () => (ctx.root.querySelector('#blockTools') || ctx.root.querySelector('#viewport')).getBoundingClientRect();
  const editable = (c, raw) => c.kind === 'text' && (pureMath(raw) != null ? 'math' : parseTable(raw) ? 'table' : null);
  function editBlock(c, raw) {
    const kind = editable(c, raw); if (!kind) return false;
    const r = toolsRect();
    const done = md => replaceBlock(c.key, raw, md);
    if (kind === 'math') openMath(r, pureMath(raw), done); else openTable(r, parseTable(raw), done);
    return true;
  }

  // 原稿のブロック表示の数式を直す（key のブロックを置き換える）
  function editMath(key, raw, rect) {
    if (pureMath(raw) == null) return false;
    openMath(rect, pureMath(raw), md => replaceBlock(key, raw, md));
    return true;
  }
  let stopFrameInput=()=>{};
  ctx.insert = { anchor, dropItem, pickFiles, editMath };
  return {
    // スライドの中の貼り付けも受ける（ブロックを選んで ⌘V）
    // スライドの中を押したときも、メニュー・入力の画面の外として閉じる
    previewLoaded() {
      stopFrameInput();const client=ctx.preview.client;if(!client)return;
      const current=d=>client===ctx.preview.client&&d.sourceVersion===ctx.preview.sourceVersion;
      const pointer=client.on('insert.pointer',d=>{if(current(d)){closeMenu();pop?.confirm();}});
      const clipboard=client.on('insert.paste',d=>{
        if(!current(d)||dead)return;
        const files=d.files.map(f=>new File([f.bytes],f.name,{type:f.type}));
        addFiles(files,anchor());
      });
      stopFrameInput=()=>{pointer();clipboard();};
    },
    // ブロックを選んでいるときの /
    keydown(e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || menu || pop) return false;
      e.preventDefault(); openMenu({ rect: toolsRect() }); return true;
    },
    blockTools(c, raw, { button, disabled }) {
      const kind = editable(c, raw);
      return kind ? [button('pencil', kind === 'math' ? T.editMath : T.editTable, () => editBlock(c, raw), { disabled, keys: 'Enter' })] : null;
    },
    enterBlock: editBlock,
    destroy() {
      dead = true; stopFrameInput(); closeMenu(); closePop();
      document.removeEventListener('paste', onPaste, true); document.removeEventListener('input', slashInput);
      removeEventListener('keydown', onKey, true); removeEventListener('pointerdown', outside, true);
    },
  };
}
