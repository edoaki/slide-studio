// 原稿のブロック操作を、原文の文字列の変更にする（元：ai-slide mock/gui/index.html の OPS）。
// mock はモデルから qmd 全体を作り直すが、ここでは対象の範囲だけを書き換える（設計書 §6.1）。
// 位置はすべて JS の文字位置（UTF-16）。/api/structure の結果（コードポイント位置）は units() で変換する。
import { DECORATION_PROPERTIES, designOf } from './block-design.js';

export const isBox = c => c.kind === 'columns' || c.kind === 'column' || c.kind === 'box';
const splice = (t, a, b, s = '') => t.slice(0, a) + s + t.slice(b);

// 項目の本文先頭では、箇条書き → 項目内の改行 → 前の行に連結、と削除する。
export function backspaceList(text, caret) {
  const start = text.lastIndexOf('\n', caret - 1) + 1;
  if (!start) return null;
  const prefix = text.slice(start, caret);
  const previousStart = text.lastIndexOf('\n', start - 2) + 1;
  const previous = text.slice(previousStart, start - 1);
  const marker = prefix.match(/^( *)([-+*]|\d+[.)]) +$/);
  const priorMarker = previous.match(/^( *)(?:[-+*]|\d+[.)]) +/);
  if (marker && priorMarker && marker[1] === priorMarker[1]) {
    const continuation = ' '.repeat(priorMarker[0].length);
    const replacement = '\\\n' + continuation;
    return { text: splice(text, start - 1, caret, replacement), caret: start - 1 + replacement.length };
  }
  if (/^ *$/.test(prefix) && /(?<!\\)(?:\\\\)*\\$/.test(previous)) {
    const at = start - 2;
    return { text: splice(text, at, caret), caret: at };
  }
  return null;
}
function* walk(cs) { for (const c of cs) { yield c; yield* walk(c.children); } }

// 構造の位置を UTF-16 にし、親・キー（p<ページ>/<パス>）・囲みの行の位置を付ける
export function units(text, structure) {
  const map = []; let u = 0;
  for (const ch of text) { map.push(u); u += ch.length; }
  map.push(u);
  const at = n => map[Math.min(n, map.length - 1)];
  const pages = structure.pages.map(p => {
    const page = { ...p, start: at(p.start), head_end: at(p.head_end), end: at(p.end) };
    const conv = (c, parent) => {
      const n = { ...c, key: `p${p.index}/${c.path}`, page: p.index, parent, start: at(c.start), end: at(c.end) };
      if (c.open != null) { n.openEnd = n.start + c.open.length; n.closeStart = n.end - (c.close || '').length; }
      n.children = (c.children || []).map(k => conv(k, n));
      return n;
    };
    page.chunks = p.chunks.map(c => conv(c, null));
    return page;
  });
  return { ...structure, pages };
}
export function find(st, key) {
  for (const page of st?.pages || []) for (const chunk of walk(page.chunks)) if (chunk.key === key) return { page, chunk };
  return null;
}
// ---------------------------------------------------------------- 画面で数える層（§10.4）
// 余白・段階表示・揃えの包みは層に数えず、選ぶのは中の本文、動かすのは包みごと
export const styleProps = s => (s || '').split(';').map(d => d.split(':')).filter(p => p.length > 1 && p[0].trim())
  .map(([k, ...v]) => [k.trim().toLowerCase(), v.join(':').trim()]);
// 表紙のタイトル・副題の囲み（::: {.cover-title}）。中の段落はふつうの本文として選んで直し、囲みは消さない・動かさない
export const isCoverPart = c => c?.kind === 'box' && !!c.attrs?.classes?.some(k => k === 'cover-title' || k === 'cover-subtitle');
export const coverPart = c => isCoverPart(c) ? c : isCoverPart(outer(c)) ? outer(c) : null;
// 表の文字サイズ・太さ・列の幅（slide-studio.lua が表に当てる）
export const TABLE_PROPS = ['--table-size', '--table-weight', '--table-cols'];
export const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
export const isTable = (text, c) => {
  if (c?.kind !== 'text') return false;
  const lines = text.slice(c.start, c.end).trim().split('\n');
  return lines.length > 1 && TABLE_RULE.test(lines[1]) && lines.every(l => l.includes('|'));
};
export function isPadWrap(c) {
  if (isCoverPart(c)) return c.children?.length === 1 && c.children[0].kind === 'text';
  if (c?.kind !== 'box' || c.attrs?.id || c.attrs?.classes?.some(k => k !== 'incremental') || c.children?.length !== 1 || c.children[0].kind !== 'text') return false;
  const kv = Object.keys(c.attrs?.kv || {});
  const styles = styleProps(c.attrs?.kv?.style);
  // デザインのある囲みは、段落が1つでも独立した入れ物として選択・追加・移動する。
  if (designOf(Object.fromEntries(styles)) !== 'unframed') return false;
  const decoration = ['--block-design', '--block-shadow', 'border', 'background-color'];
  return (kv.length > 0 || c.attrs?.classes?.includes('incremental')) && kv.every(k => ['style', 'data-step'].includes(k)) && styles.every(([k]) => ['padding', 'text-box', '--block-space', 'text-align', ...TABLE_PROPS, ...decoration].includes(k));
}
export const outer = c => isPadWrap(c?.parent) ? c.parent : c;
export const inner = c => isPadWrap(c) ? c.children[0] : c;
// 並びの中身（包みは中の段落にする）
export const kidsOf = (page, c) => (c ? c.children : page.chunks).filter(x => x.kind !== 'def').map(inner);
export const siblings = (page, c) => kidsOf(page, outer(c).parent);
export const parentKey = key => { const m = key?.match(/^(p\d+\/)(.+)\.\d+$/); return m ? m[1] + m[2] : null; };
const keyOf = (c, i) => c.key.replace(/\d+$/, String(i));
const nextKey = c => keyOf(c, +c.key.match(/\d+$/)[0] + 1);
// 文字の範囲（start〜end）のブロックのキー。並べ替え・移動のあとに選び直す
export function keyAt(st, start, end) {
  for (const page of st.pages) for (const c of walk(page.chunks)) if (c.start === start && c.end === end) return inner(c).key;
  return null;
}
export const columnOf = c => { for (let x = outer(c).parent; x; x = x.parent) if (x.kind === 'column') return x; return null; };

// 消す範囲を前後の改行まで広げ、間を空行1つ（囲みの行の隣なら改行1つ）にまとめる
function removal(text, a, b) {
  let s = a, e = b;
  while (s > 0 && text[s - 1] === '\n') s--;
  while (e < text.length && text[e] === '\n') e++;
  if (s === 0) return [0, e, ''];
  if (e === text.length) return [s, e, '\n'];
  return [s, e, '\n'.repeat(Math.min(2, Math.max(a - s, e - b)))];
}
// 位置の大きい順に当てる。同じ位置では、範囲の長いもの（消す側）を先にする
function apply(text, edits) {
  for (const [a, b, s] of [...edits].sort((x, y) => y[0] - x[0] || y[1] - x[1])) text = splice(text, a, b, s);
  return text;
}

// ---------------------------------------------------------------- 列の幅
// 列の幅（%）。書いていない列は、書いてある列の平均とみなす（mock の ratios）
export function ratios(columns) {
  const ws = columns.children.map(c => parseFloat(c.attrs?.kv?.width) || null), known = ws.filter(w => w != null);
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const filled = ws.map(w => w ?? avg), sum = filled.reduce((a, b) => a + b, 0);
  return filled.map(w => w / sum * 100);
}
// 整数の % にそろえる（合計 100。端数は大きい順に配る）
export function intRatios(r) {
  const out = r.map(Math.floor);
  let rest = 100 - out.reduce((a, b) => a + b, 0);
  r.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest-- > 0) out[i]++; });
  return out;
}
// 境目 j（1〜列数-1）を x % へ動かす。隣の列が下限まで細くなったら、その先の境目も押す（mock の pushRatios）
export function pushRatios(start, j, x, min) {
  const k = start.length, pos = [0];
  start.forEach(v => pos.push(pos[pos.length - 1] + v));
  pos[j] = Math.max(j * min, Math.min(100 - (k - j) * min, Math.round(x)));
  for (let i = j - 1; i > 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - min);
  for (let i = j + 1; i < k; i++) pos[i] = Math.max(pos[i], pos[i - 1] + min);
  return start.map((_, i) => pos[i + 1] - pos[i]);
}
// ::: {.column width="40%"} の width だけを書き換える（null なら外す）。ほかの属性はそのまま
export function withWidth(line, w) {
  const m = line.match(/^(\s*:{3,}[ \t]*)(\{[^{}]*\}|[\w-]+)(.*)$/);
  if (!m) return line;
  let inner = m[2].startsWith('{') ? m[2].slice(1, -1) : `.${m[2]}`;
  inner = inner.replace(/(^|\s)width=(?:"[^"]*"|'[^']*'|\S+)/, '').trim();
  if (w != null) inner += ` width="${w}%"`;
  return `${m[1]}{${inner.trim()}}${m[3]}`;
}
const widthEdits = (text, cols, ws) => cols.map((c, i) => [c.start, c.openEnd, withWidth(text.slice(c.start, c.openEnd), ws[i])]);
export function setWidths(text, columns, ws) { return apply(text, widthEdits(text, columns.children, ws)); }
const hasWidths = columns => columns.children.some(c => c.attrs?.kv?.width);

// 列全体を占める無名の箱は、列そのものにする。意味を持つ名前・クラスは残す。
const columnBox = c => c?.kind === 'box' && !c.attrs?.id && !c.attrs?.classes?.length;
const columnLayout = new Set(['padding', 'text-box', '--block-space']);
function canMergeColumn(column, box) {
  if (!columnBox(box)) return false;
  const outerStyle = Object.fromEntries(styleProps(column.attrs?.kv?.style));
  const innerStyle = Object.fromEntries(styleProps(box.attrs?.kv?.style));
  // 二重の枠・影や、相対文字サイズ・不透明度の重なりは別々の囲みとして保つ。
  if (DECORATION_PROPERTIES.some(k => k in outerStyle) && DECORATION_PROPERTIES.some(k => k in innerStyle)) return false;
  return Object.keys(innerStyle).every(k => columnLayout.has(k) || !(k in outerStyle))
    && Object.entries(box.attrs?.kv || {}).every(([k, v]) => k === 'style' || !(k in column.attrs.kv) || column.attrs.kv[k] === v);
}
function asColumn(text, c) {
  const raw = text.slice(c.start, c.end);
  return columnBox(c) ? raw.replace(/^(\s*:{3,}\s*\{)/, '$1.column ') : `::: {.column}\n${raw}\n:::`;
}
// 列とその唯一の箱を統合。列幅は列に残し、箱の設定を引き継ぐ。
function columnOpening(text, column, box) {
  const kv = { ...column.attrs?.kv, ...box.attrs?.kv };
  const style = { ...Object.fromEntries(styleProps(column.attrs?.kv?.style)), ...Object.fromEntries(styleProps(box.attrs?.kv?.style)) };
  const outerSpace = Object.fromEntries(styleProps(column.attrs?.kv?.style))['--block-space'];
  if (outerSpace != null) style['--block-space'] = outerSpace;
  if (Object.keys(style).length) kv.style = Object.entries(style).map(([k, v]) => `${k}:${v}`).join(';');
  let open = text.slice(column.start, column.openEnd);
  for (const [k, v] of Object.entries(kv)) open = divAttr(open, k, v);
  return open;
}
function mergeColumn(text, column, box) {
  return apply(text, [[column.start, column.openEnd, columnOpening(text, column, box)], [box.start, box.openEnd, ''], [box.closeStart, box.end, '']]);
}

// ---------------------------------------------------------------- 追加・分割・削除
// 下に追加する空のブロックの位置。空のブロックは原稿に書けないので、文字を入れた時点で書く（mock も空の箱は書かない）
export function pendingBelow(st, key) {
  const f = find(st, key); if (!f?.chunk) return null;
  const c = outer(f.chunk);
  if (c.kind === 'column' || (c.kind === 'box' && !isPadWrap(c))) {
    const last = c.children.at(-1);
    return last ? { pos: last.end, prefix: '\n\n', owner: c.key, after: last.key } : { pos: c.openEnd, prefix: '\n', owner: c.key, after: null };
  }
  return { pos: c.end, prefix: '\n\n', owner: c.parent?.key ?? null, after: c.key, page: f.page.index };
}
// ページの本文が空のときの入力位置
export const pendingPage = page => ({ pos: page.head_end, prefix: '\n\n', owner: null, after: null, page: page.index });
export const pendingEmpty = c => ({ pos: c.openEnd, prefix: '\n', owner: c.key, after: null });

// カーソルの位置で上下に分ける（段落の途中に空行を入れる）
export function splitAt(text, pos) {
  const a = text.slice(0, pos).replace(/[ \t]+$/, ''), b = text.slice(pos).replace(/^[ \t\n]+/, '');
  const head = a.replace(/\n+$/, '');
  return { text: `${head}\n\n${b}`, caret: head.length + 2 };
}

// 右に列を足す。列の中なら隣に列を、横並びなら最後に列を、それ以外は横並びで包む
export function addRight(text, st, key) {
  const f = find(st, key); if (!f?.chunk) return null;
  const c = outer(f.chunk);
  if (c.kind === 'column' || c.kind === 'columns') {
    const cols = c.kind === 'column' ? c.parent : c, after = c.kind === 'column' ? c : cols.children.at(-1);
    const i = cols.children.indexOf(after), fence = text.slice(after.start, after.openEnd).match(/^\s*:{3,}/)[0];
    const edits = [[after.end, after.end, `\n${fence} {.column}\n${fence}`]];
    let out = text;
    if (hasWidths(cols)) {
      // 新しい列は今の列の平均の幅にして、全体を 100 に割り直す（mock の ratios と同じ）
      const r = ratios(cols), avg = 100 / r.length;
      r.splice(i + 1, 0, avg);
      const ws = intRatios(r.map(v => v / (100 + avg) * 100));
      edits.push(...widthEdits(text, cols.children, ws.slice(0, i + 1).concat(ws.slice(i + 2))));
      edits[0][2] = `\n${withWidth(`${fence} {.column}`, ws[i + 1])}\n${fence}`;
    }
    out = apply(out, edits);
    return { text: out, select: keyOf(after, i + 1) };
  }
  const out = splice(text, c.start, c.end, `:::: {.columns}\n${asColumn(text, c)}\n::: {.column}\n:::\n::::`);
  return { text: out, select: `${c.key}.1` };
}

// 横並び・列を外すときの開始行。幅とレイアウトのクラスを外し、枠・余白・段などは囲みに残す。
function layoutShell(text, c) {
  const attrs = c.attrs || {};
  if (!attrs.id && !(attrs.classes || []).some(k => k !== c.kind) && !Object.keys(attrs.kv || {}).some(k => k !== 'width')) return null;
  return withWidth(text.slice(c.start, c.openEnd), null)
    .replace(/("(?:[^"\\]|\\.)*"|'[^']*')|(^|[\s{])\.(column|columns)(?=[\s}])/g,
      (all, quoted, lead, kind) => quoted || (kind === c.kind ? lead : all))
    .replace(/\{\s+/, '{').replace(/[ \t]+\}/, '}');
}
// 列が1つだけ残るときは横並びを外す。残る列の設定は囲みに引き継ぐ。
function columnRemoval(text, c) {
  const cols = c.parent, rest = cols.children.filter(x => x !== c);
  if (rest.length === 1) {
    const o = rest[0], shell = layoutShell(text, o), outerShell = layoutShell(text, cols);
    if (outerShell) {
      const edits = [[cols.start, cols.openEnd, outerShell], [cols.openEnd, o.start, '\n'], [o.end, cols.closeStart, '\n']];
      if (shell) edits.push([o.start, o.openEnd, shell]);
      else edits.push([o.start, o.openEnd, ''], [o.closeStart, o.end, '']);
      return edits;
    }
    if (shell) return [[cols.start, o.start, ''], [o.start, o.openEnd, shell], [o.end, cols.end, '']];
    if (!o.children.length) return [removal(text, cols.start, cols.end)];
    return [[cols.start, o.children[0].start, ''], [o.children.at(-1).end, cols.end, '']];
  }
  const edits = [removal(text, c.start, c.end)];
  if (hasWidths(cols)) {
    const r = ratios(cols).filter((_, i) => cols.children[i] !== c), sum = r.reduce((a, b) => a + b, 0);
    edits.push(...widthEdits(text, rest, intRatios(r.map(v => v / sum * 100))));
  }
  return edits;
}
// ブロックを消す
export function remove(text, st, key) {
  const f = find(st, key); if (!f?.chunk || coverPart(f.chunk)) return null;
  const c = outer(f.chunk);
  if (c.kind === 'column') {
    const rest = c.parent.children.filter(x => x !== c), out = apply(text, columnRemoval(text, c));
    return rest.length === 1 && rest[0].children.length ? { text: out, select: c.parent.key } : { text: out };
  }
  return { text: apply(text, [removal(text, c.start, c.end)]) };
}

// 同じ並びのとなりと入れ替える（⌥↑↓、⇧WASD）。at・end：動かしたブロックの新しい範囲
export function nudge(text, st, key, delta) {
  const f = find(st, key); if (!f?.chunk || coverPart(f.chunk)) return null;
  const c = outer(f.chunk), sibs = (c.parent ? c.parent.children : f.page.chunks).filter(x => x.kind !== 'def');
  const o = sibs[sibs.indexOf(c) + delta];
  if (!o) return null;
  const [a, b] = delta < 0 ? [o, c] : [c, o];
  const out = text.slice(0, a.start) + text.slice(b.start, b.end) + text.slice(a.end, b.start) + text.slice(a.start, a.end) + text.slice(b.end);
  const at = delta < 0 ? a.start : b.end - (a.end - a.start);
  return { text: out, select: isPadWrap(c) ? `${o.key}.0` : o.key, at, end: at + (c.end - c.start) };
}

// 前の段落の終わりにつなぐ（段落の先頭で Backspace）
export function merge(text, st, key) {
  const f = find(st, key); if (!f) return null;
  const sibs = siblings(f.page, f.chunk), prev = sibs[sibs.indexOf(f.chunk) - 1];
  if (!prev || prev.kind !== 'text' || f.chunk.kind !== 'text') return null;
  return { text: splice(text, prev.end, f.chunk.start), caret: prev.end };
}

// 移す。spec = { key, side: 'before'|'after' } か { into: 列などのキー }（空の囲み）か { page }（ページの最初）か
// { pageEnd }（ページの最後）。at・end：移したブロックの新しい範囲。
// 列を列の前後以外へ移すときは、枠などの設定を持つ囲み、または中身だけのブロックとして移す。
export function move(text, st, key, spec) {
  const f = find(st, key); if (!f?.chunk || coverPart(f.chunk)) return null;
  const c = outer(f.chunk), loose = c.kind === 'column' && find(st, spec.key)?.chunk?.kind !== 'column';
  if (loose && !c.children.length) return null;
  const destination = spec.into && find(st, spec.into)?.chunk;
  const promote = destination?.kind === 'column' && !destination.children.length && canMergeColumn(destination, c);
  const shell = loose && layoutShell(text, c);
  const raw = promote ? text.slice(c.openEnd, c.closeStart).trim()
    : shell ? shell + text.slice(c.openEnd, c.end)
    : loose ? text.slice(c.children[0].start, c.children.at(-1).end) : text.slice(c.start, c.end);
  let pos, pre = '', post = '';
  if (spec.key) {
    let t = find(st, spec.key)?.chunk;
    if (t && !(t.kind === 'column' && c.kind === 'column')) t = outer(t);
    if (!t || t === c) return null;
    if (t.start >= c.start && t.end <= c.end) return { error: 'inside' };
    const sep = t.kind === 'column' && c.kind === 'column' ? '\n' : '\n\n';
    if (spec.side === 'before') { pos = t.start; post = sep; } else { pos = t.end; pre = sep; }
  } else if (spec.into) {
    const t = find(st, spec.into)?.chunk;
    if (isCoverPart(t)) return null;
    if (!t || (t.start >= c.start && t.end <= c.end)) return { error: 'inside' };
    pos = t.openEnd; pre = '\n';
  } else {
    const p = st.pages.find(x => x.index === (spec.pageEnd ?? spec.page));
    if (!p || p.raw_only) return null;
    const last = p.chunks.filter(x => x.kind !== 'def').at(-1);
    pos = spec.pageEnd != null && last ? last.end : p.head_end; pre = '\n\n';
    if (last === c) return null;
  }
  const rm = loose ? columnRemoval(text, c) : [removal(text, c.start, c.end)];
  if (promote) rm.push([destination.start, destination.openEnd, columnOpening(text, destination, c)]);
  if (rm.some(([a, b]) => a < pos && pos < b)) return null;
  const shift = rm.reduce((n, [a, b, s]) => a < pos && b <= pos ? n + s.length - (b - a) : n, 0);
  const at = pos + shift + pre.length;
  const out = apply(text, [...rm, [pos, pos, pre + raw + post]]);
  if (promote) {
    const shifted = offset => offset + rm.reduce((n, [a, b, s]) => b <= offset ? n + s.length - (b - a) : n, 0);
    return { text: out, at: shifted(destination.start), end: shifted(destination.end) + pre.length + raw.length + post.length };
  }
  return { text: out, at, end: at + raw.length };
}
// 移すと並びが変わるか（空行の数だけの違いは変わらないとみなす）。変わらない・置けない所には置き場所を出さない
export function moves(text, st, key, spec) {
  const r = move(text, st, key, spec), flat = t => t.replace(/\n{3,}/g, '\n\n');
  return !!r && !r.error && flat(r.text) !== flat(text);
}

// ---------------------------------------------------------------- ページ
// ページの原文をそのまま移す。before は移動前のページ境界（末尾も可）。
export function movePage(text, st, index, before) {
  const pages = st.pages;
  if (!pages[index] || !Number.isInteger(before) || before < 0 || before > pages.length || before === index || before === index + 1) return null;
  const parts = pages.map((p, i) => ({ index: i, text: text.slice(p.start, pages[i + 1]?.start ?? text.length) }));
  const [part] = parts.splice(index, 1), next = before > index ? before - 1 : before;
  parts.splice(next, 0, part);
  // 末尾に空行がない原稿でも、移した後の見出しを本文と連結しない。
  const separated = parts.map((part, i) => {
    const p = part.text, nextPart = parts[i + 1];
    if (!nextPart || nextPart.index === part.index + 1) return p;
    return p + (p.endsWith('\n\n') ? '' : p.endsWith('\n') ? '\n' : '\n\n');
  });
  return { text: text.slice(0, pages[0].start) + separated.join(''), page: next };
}
const HEAD = /^(#{1,2})[ \t]+(.*?)[ \t]*$/;
const ATTR = /[ \t]*(\{[^{}]*\})[ \t]*$/;
// 見出しの行を、文字だけ差し替えた行にする（## と {#id .class} は残す）
export function headingLine(line, title) {
  const m = line.match(HEAD); if (!m) return line;
  const attr = m[2].match(ATTR)?.[1];
  return `${m[1]} ${title.replace(/\n/g, ' ')}${attr ? `${title ? ' ' : ''}${attr}` : ''}`;
}
// 見出しの {…} の key="value" を差し替える（value が空なら外す）。ほかの属性はそのまま残す
export function setPageAttr(text, st, index, key, value) {
  const p = st.pages[index]; if (!p || p.generated) return null;
  const m = text.slice(p.start, p.head_end).match(HEAD); if (!m) return null;
  const am = m[2].match(ATTR), title = am ? m[2].slice(0, m[2].length - am[0].length) : m[2];
  const token = new RegExp(`(^|[ \\t])${key.replace(/[^\w-]/g, '')}=(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s}]*)`, 'g');
  let inner = (am ? am[1].slice(1, -1) : '').replace(token, '').trim();
  if (value) inner = `${inner}${inner ? ' ' : ''}${key}="${value}"`;
  const line = `${m[1]} ${title}${inner ? `${title ? ' ' : ''}{${inner}}` : ''}`;
  return { text: splice(text, p.start, p.head_end, line) };
}
export const isEmptyPage = p => !p.title.trim() && !p.chunks.length;
export const canAddPage = (st, i) => ![st.pages[i - 1], st.pages[i]].some(p => p && isEmptyPage(p));
export function addPage(text, st, index, template = {}) {
  const used = new Set(st.pages.map(p => p.id));
  if (template.unique && used.has(template.unique)) return null;
  const prefix = template.chapter ? 'chapter' : 'page';
  let n = 1; while (used.has(`${prefix}-${n}`)) n++;
  const line = template.source || `${template.chapter ? '#' : '##'} {#${prefix}-${n}}${template.body ? '\n\n' + template.body : ''}`, next = st.pages[index];
  if (next) return { text: splice(text, next.start, next.start, `${line}\n\n`), page: index };
  const head = text.replace(/\n*$/, '');
  return { text: `${head}${head ? '\n\n' : ''}${line}\n`, page: index };
}
export function removePage(text, st, index) {
  const p = st.pages[index]; if (!p) return null;
  if (index === st.pages.length - 1) return { text: text.slice(0, p.start).replace(/\n+$/, '\n') };
  return { text: splice(text, p.start, p.end) };
}

// ---------------------------------------------------------------- キーでの並べ替え・追加（§10.4 の ⇧WASD・⌥WASD）
// その向きへ1つ動かす。並びの端では外側の囲みの外へ出し、ページの端では止める（null）
export function reorder(text, st, key, dir) {
  const f = find(st, key); if (!f?.chunk || coverPart(f.chunk)) return null;
  const c = outer(f.chunk), delta = dir === 'up' || dir === 'left' ? -1 : 1;
  if (dir === 'up' || dir === 'down') {
    if (c.kind === 'column') return null;
    const r = nudge(text, st, key, delta);
    if (r) return r;
    let box = c.parent; if (!box) return null;
    if (box.kind === 'column') box = box.parent;
    return move(text, st, key, { key: box.key, side: delta < 0 ? 'before' : 'after' });
  }
  if (c.kind === 'column') return nudge(text, st, key, delta);
  // 列の中のブロックは、となりの列（無ければ外側の横並びのとなり）の同じ順番の位置へ
  for (let col = columnOf(c); col; col = columnOf(col)) {
    const cols = col.parent.children, n = cols[cols.indexOf(col) + delta];
    if (!n) continue;
    const list = n.children.filter(x => x.kind !== 'def'), i = siblings(f.page, f.chunk).indexOf(f.chunk);
    if (!list.length) return move(text, st, key, { into: n.key });
    return list[i] ? move(text, st, key, { key: list[i].key, side: 'before' }) : move(text, st, key, { key: list.at(-1).key, side: 'after' });
  }
  return null;
}

// 段落を足す。side：'before'|'after'。列・箱を選んでいるときはその中の最初・最後。md は書いた原稿
export function insertBlock(text, st, key, side, md) {
  const f = find(st, key); if (!f || !md) return null;
  const c = outer(f.chunk), into = c.kind === 'column' || (c.kind === 'box' && !isPadWrap(c));
  const list = c.children.filter(x => x.kind !== 'def');
  let pos, s, select;
  if (into && !list.length) {
    pos = c.openEnd; s = `\n${md}`; select = `${c.key}.0`;
  } else if (into) {
    const t = side === 'before' ? list[0] : list.at(-1);
    if (side === 'before') { pos = t.start; s = `${md}\n\n`; select = t.key; } else { pos = t.end; s = `\n\n${md}`; select = nextKey(t); }
  } else if (side === 'before') { pos = c.start; s = `${md}\n\n`; select = c.key; }
  else { pos = c.end; s = `\n\n${md}`; select = nextKey(c); }
  return { text: splice(text, pos, pos, s), select };
}

// 列を足す（中に md を書く）。side：'left'|'right'。列の中ならその列の隣、列の外なら横並びで包む
export function addColumn(text, st, key, side, md) {
  const f = find(st, key); if (!f?.chunk || !md) return null;
  const c = outer(f.chunk), col = c.kind === 'column' ? c : columnOf(c);
  if (!col) {
    const cols = [asColumn(text, c), `::: {.column}\n${md}\n:::`];
    if (side === 'left') cols.reverse();
    return { text: splice(text, c.start, c.end, `:::: {.columns}\n${cols.join('\n')}\n::::`), select: `${c.key}.${side === 'left' ? 0 : 1}.0` };
  }
  const cols = col.parent, i = cols.children.indexOf(col), at = side === 'left' ? i : i + 1;
  const fence = text.slice(col.start, col.openEnd).match(/^\s*:{3,}/)[0];
  let open = `${fence} {.column}`;
  const edits = [];
  if (hasWidths(cols)) {
    // 新しい列は今の列の平均の幅にして、全体を 100 に割り直す（addRight と同じ）
    const r = ratios(cols), avg = 100 / r.length;
    r.splice(at, 0, avg);
    const ws = intRatios(r.map(v => v / (100 + avg) * 100));
    edits.push(...widthEdits(text, cols.children, ws.slice(0, at).concat(ws.slice(at + 1))));
    open = withWidth(open, ws[at]);
  }
  const block = `${open}\n${md}\n${fence}`;
  edits.push(side === 'left' ? [col.start, col.start, `${block}\n`] : [col.end, col.end, `\n${block}`]);
  return { text: apply(text, edits), select: `${cols.key}.${at}.0` };
}

// ---------------------------------------------------------------- 大きさ・余白の書き方（§10.4）
const ATTR_KEY = name => new RegExp(`(^|\\s)${name.replace(/[-]/g, '\\-')}=(?:"[^"]*"|'[^']*'|[^\\s}>]+)`);
// {…} の中の name= を書き換える（null なら外す）。ほかの属性はそのまま
function withKey(inner, name, value) {
  let s = inner.replace(ATTR_KEY(name), '').replace(/\s{2,}/g, ' ').trim();
  if (value != null) s += `${s ? ' ' : ''}${name}="${value}"`;
  return s;
}
export function withStyle(style, prop, value) {
  const ps = styleProps(style).filter(([k]) => k !== prop && !(prop === 'padding' && k.startsWith('padding-')));
  if (value != null) ps.push([prop, value]);
  return ps.map(([k, v]) => `${k}:${v}`).join(';');
}
// ::: の開始行の属性
export function divAttr(line, name, value) {
  const m = line.match(/^(\s*:{3,}[ \t]*)(\{[^{}]*\}|[\w-]+)(.*)$/);
  if (!m) return line;
  const inner = withKey(m[2].startsWith('{') ? m[2].slice(1, -1) : `.${m[2]}`, name, value);
  return `${m[1]}{${inner}}${m[3]}`;
}
const divStyle = (text, c, prop, value) =>
  splice(text, c.start, c.openEnd, divAttr(text.slice(c.start, c.openEnd), 'style', withStyle(c.attrs?.kv?.style, prop, value) || null));
// ![…](…){…} の属性
export function imageAttr(raw, name, value) {
  const m = raw.match(/\{([^{}]*)\}\s*$/), base = m ? raw.slice(0, m.index) : raw;
  const inner = withKey(m ? m[1] : '', name, value);
  return inner ? `${base}{${inner}}` : base;
}
const imageStyle = (raw, prop, value) => {
  const style = raw.match(/\{[^{}]*\bstyle="([^"]*)"[^{}]*\}\s*$/)?.[1];
  return imageAttr(raw, 'style', withStyle(style, prop, value) || null);
};
// {{< fig … >}} の引数
export function figArg(raw, name, value) {
  const m = raw.match(/^(\{\{<\s*fig\s+)(.*?)(\s*>\}\})$/);
  if (!m) return raw;
  return m[1] + withKey(m[2], name, value) + m[3];
}
// 図の参照（{{< fig nco/x … >}} の最初の引数）
export const figRef = raw => raw.match(/^\{\{<\s*fig\s+"?([^\s">]+)/)?.[1] ?? null;
const chunkRaw = (text, c, fn) => splice(text, c.start, c.end, fn(text.slice(c.start, c.end)));

// 大きさ（画像は幅、図は高さ、箱は最低の高さ。px の数。null で消す）
export function setSize(text, st, key, value) {
  const c = find(st, key)?.chunk; if (!c) return null;
  if (c.kind === 'image') return { text: chunkRaw(text, c, r => imageAttr(r, 'width', value)), select: key };
  if (c.kind === 'fig') return { text: chunkRaw(text, c, r => figArg(figArg(r, 'width', null), 'height', value)), select: key };
  if (c.kind === 'box') return { text: divStyle(text, c, 'min-height', value == null ? null : `${value}px`), select: key };
  return null;
}
// 表紙は囲みへ保存する。本文やタイトルの同期用メタデータには触れない。
export function setCoverLayout(text, st, key, values) {
  const c = coverPart(find(st, key)?.chunk); if (!c) return null;
  let style = c.attrs?.kv?.style;
  for (const [prop, value] of Object.entries(values)) style = withStyle(style, prop, value);
  return { text: splice(text, c.start, c.openEnd, divAttr(text.slice(c.start, c.openEnd), 'style', style || null)), select: key };
}
// 列の幅（%。null なら全部の列の幅を消す）
export function setColumnWidths(text, st, key, ws) {
  const c = find(st, key)?.chunk, cols = c?.kind === 'columns' ? c : c?.kind === 'column' ? c.parent : columnOf(c)?.parent;
  if (!cols) return null;
  return { text: setWidths(text, cols, ws || cols.children.map(() => null)) };
}
export const columnsOf = (st, key) => { const c = find(st, key)?.chunk; return c?.kind === 'column' ? c.parent : c && columnOf(c)?.parent; };

// 枠のある囲み。余白は文字の行間を含めず測る（base.css の既定と同じ）
export const isFramed = c => (c?.kind === 'column' || c?.kind === 'box') && styleProps(c.attrs?.kv?.style).some(([k, v]) => k === '--block-design' && !['shadow', 'corner'].includes(v));

// 余白。pad は CSS の値（"8px 12px"。横並びは列の間の1つの値）。null でそのブロックの値を消す
export function setPad(text, st, key, pad) {
  const f = find(st, key); if (!f) return null;
  const c = f.chunk, o = outer(c);
  if (c.kind === 'columns') return { text: divStyle(text, c, '--gutter', pad), select: key };
  if (isFramed(c)) {
    const style = withStyle(withStyle(c.attrs?.kv?.style, 'padding', pad), 'text-box', pad == null ? null : 'trim-both text');
    return { text: splice(text, c.start, c.openEnd, divAttr(text.slice(c.start, c.openEnd), 'style', style || null)), select: key };
  }
  if (c.kind === 'column' || c.kind === 'box') return { text: divStyle(text, c, 'padding', pad), select: key };
  if (c.kind === 'image') return { text: chunkRaw(text, c, r => imageStyle(r, 'padding', pad)), select: key };
  if (c.kind === 'fig') return { text: chunkRaw(text, c, r => figArg(r, 'pad', pad && pad.replace(/px/g, ''))), select: key };
  if (c.kind !== 'text') return null;
  return setTextOptions(text, st, key, { padding: pad, 'text-box': pad == null ? null : 'trim-both text' });
}

// 外側余白は枠・背景を持たない描画用の囲みで確保する（margin の相殺を避ける）。
export function setSpace(text, st, key, value) {
  const c = find(st, key)?.chunk; if (!c) return null;
  if (c.kind === 'text') return setTextOptions(text, st, key, { '--block-space': value });
  if (isBox(c)) return { text: divStyle(text, c, '--block-space', value), select: key };
  if (c.kind === 'image') return { text: chunkRaw(text, c, r => imageStyle(r, '--block-space', value)), select: key };
  if (c.kind === 'fig') return { text: chunkRaw(text, c, r => figArg(r, 'space', value && value.replace(/px/g, ''))), select: key };
  return null;
}

// 余白・段階表示・揃えは1つの包みで持つ。本文の原文と、それ以外のブロックは変えない。
// 揃えを書いていないときは周り（テーマの表紙の中央揃えなど）に従う。alignBase はその揃え
export const isList = (text, c) => c?.kind === 'text' && /^\s*(?:[-+*]|\d+[.)]) +/.test(text.slice(c.start, c.end));
export function textOptions(c, alignBase = 'left') {
  const o = outer(c), kv = o !== c ? o.attrs?.kv || {} : {};
  return { step: Number(kv['data-step'] ?? (o.attrs?.classes?.includes('incremental') ? 1 : 0)),
    incremental: o !== c && !!o.attrs?.classes?.includes('incremental'),
    align: styleProps(kv.style).find(([k]) => k === 'text-align')?.[1] || alignBase };
}
// 表に書いてある値（書いていないものは無い）
export const tableOptions = c => Object.fromEntries(styleProps(outer(c).attrs?.kv?.style).filter(([k]) => TABLE_PROPS.includes(k)));
export function setTextOptions(text, st, key, options) {
  const c = find(st, key)?.chunk; if (c?.kind !== 'text') return null;
  const w = wrapEdit(text, c, options);
  return { text: apply(text, [w.edit]), at: w.at, end: w.end };
}
// 包みを書き直す1つの変更（mapRaw：中の本文の書き換え。段の番号の詰め直しに使う）
function wrapEdit(text, c, options, mapRaw = r => r) {
  const base = options.alignBase || 'left', o = outer(c), old = textOptions(c, base), state = { ...old, ...options };
  const kv = { ...(o !== c ? o.attrs.kv : {}) };
  if ('padding' in options) kv.style = withStyle(kv.style, 'padding', options.padding);
  for (const prop of [...DECORATION_PROPERTIES, ...TABLE_PROPS, '--block-space', 'text-box']) if (prop in options) kv.style = withStyle(kv.style, prop, options[prop]);
  if ('align' in options) kv.style = withStyle(kv.style, 'text-align', state.align === base ? null : state.align);
  if ('step' in options || 'incremental' in options) {
    delete kv['data-step'];
    if (state.step > 0 || state.incremental) kv['data-step'] = String(state.step);
  }
  if (!kv.style) delete kv.style;
  // 表紙のタイトル・副題の名前は残す（値が無くなっても囲みは外さない）
  const cover = isCoverPart(o) ? o.attrs.classes.filter(k => k !== 'incremental').map(k => `.${k}`) : [];
  const attrs = [...cover, state.incremental ? '.incremental' : '', ...Object.entries(kv).map(([k, v]) => `${k}="${v}"`)].filter(Boolean).join(' ');
  const raw = mapRaw(text.slice(c.start, c.end)), open = attrs ? `::: {${attrs}}` : '';
  const replacement = open ? `${open}\n${raw}\n:::` : raw;
  const at = o.start + (open ? open.length + 1 : 0);
  // end が末尾の改行を含むチャンクでも、次のブロックとの境界を残す
  const tail = o !== c && text.slice(o.start, o.end).endsWith('\n') ? '\n' : '';
  return { edit: [o.start, o.end, replacement + tail], at, end: at + raw.length };
}

// ---------------------------------------------------------------- 段階表示（§10.4）
// 段の番号は原稿の data-step のまま見せる。変えたらそのページの番号を詰め直し、空いた段を残さない。
// 段を持つもの：本文の包み（1項目ずつは項目の数だけ続けて使う）・図の step="k"・画像の data-step・強調の data-highlight-step
const HIGHLIGHT = /(\bdata-highlight-step=)(["']?)(\d+)\2/g;
const ITEM = /^( *)(?:[-+*]|\d+[.)]) +/;
const itemCount = raw => {
  const ind = raw.split('\n').map(l => l.match(ITEM)?.[1].length).filter(n => n != null);
  return Math.max(1, ind.filter(n => n === Math.min(...ind)).length);
};
const figStep = raw => Number(raw.match(/^\{\{<\s*fig\s.*?\bstep=["']?(\d+)/)?.[1] ?? 0);
const imageStep = raw => Number(raw.match(/\{[^{}]*\bdata-step=["']?(\d+)[^{}]*\}\s*$/)?.[1] ?? 0);
export const canStep = c => !!c && (['text', 'fig', 'image'].includes(c.kind) || isBox(c));
// 段を書くチャンク（本文は包み）
const stepOwner = c => c.kind === 'text' ? outer(c) : c;
export function stepState(text, c) {
  if (c.kind === 'fig') return { step: figStep(text.slice(c.start, c.end)), incremental: false };
  if (c.kind === 'image') return { step: imageStep(text.slice(c.start, c.end)), incremental: false };
  if (isBox(c)) return { step: Number(c.attrs?.kv?.['data-step'] ?? 0), incremental: false };
  const { step, incremental } = textOptions(c);
  return { step, incremental, count: incremental ? itemCount(text.slice(c.start, c.end)) : 1 };
}
// ページの中で段を使っているもの。本文は包みごと、入れ物は自身だけを除く。set(n)：段を n にする変更
function stepMarks(text, page, skip) {
  const marks = [], inSkip = (a, b) => skip && a >= skip.start && b <= skip.end;
  const replaceBody = skip && (!isBox(skip) || isPadWrap(skip));
  for (const c of walk(page.chunks)) {
    if (c === skip || (replaceBody && inSkip(c.start, c.end))) continue;
    const kv = c.attrs?.kv || {}, raw = text.slice(c.start, c.end);
    if (isBox(c) && ('data-step' in kv || c.attrs?.classes?.includes('incremental'))) {
      const inc = !!c.attrs?.classes?.includes('incremental');
      marks.push({ start: Number(kv['data-step'] ?? 1) || 0, count: inc ? itemCount(text.slice(c.openEnd, c.closeStart)) : 1,
        set: n => [c.start, c.openEnd, divAttr(text.slice(c.start, c.openEnd), 'data-step', String(n))] });
    } else if (c.kind === 'fig' && figStep(raw)) {
      marks.push({ start: figStep(raw), count: 1, set: n => [c.start, c.end, figArg(raw, 'step', String(n))] });
    } else if (c.kind === 'image' && imageStep(raw)) {
      marks.push({ start: imageStep(raw), count: 1, set: n => [c.start, c.end, imageAttr(raw, 'data-step', String(n))] });
    }
  }
  const body = text.slice(page.start, page.end);
  for (const m of body.matchAll(HIGHLIGHT)) {
    const a = page.start + m.index + m[1].length, b = page.start + m.index + m[0].length;
    // 選んだブロックの中の強調も段には数える（書き直しは包みと一緒に行う）
    marks.push({ start: Number(m[3]), count: 1, inner: replaceBody && inSkip(a, b), set: n => [a, b, `${m[2]}${n}${m[2]}`] });
  }
  return marks;
}
const span = (start, count) => Array.from({ length: count }, (_, i) => start + i);
// 選んだブロックに選ばせる段：0〜（ほかのものの最大の段＋1）。others：段ごとのほかのものの数
export function stepChoices(text, st, key) {
  const f = find(st, key); if (!f || !canStep(f.chunk)) return null;
  const others = new Map();
  for (const m of stepMarks(text, f.page, stepOwner(f.chunk))) for (const k of span(m.start, m.count)) others.set(k, (others.get(k) || 0) + 1);
  return { ...stepState(text, f.chunk), max: Math.max(0, ...others.keys()) + 1, others, list: isList(text, f.chunk) };
}
// 段を変える（options：step・incremental）。ページの段の番号は 0 から詰め直す
export function setStep(text, st, key, options) {
  const f = find(st, key); if (!f || !canStep(f.chunk)) return null;
  const c = f.chunk, own = stepOwner(c), state = { ...stepState(text, c), ...options };
  if (c.kind !== 'text') state.incremental = false;
  const marks = stepMarks(text, f.page, own);
  const count = state.incremental ? itemCount(text.slice(c.start, c.end)) : 1;
  const used = [...new Set([0, ...marks.flatMap(m => span(m.start, m.count)), ...span(state.step, count)])].sort((a, b) => a - b);
  const map = new Map(used.map((k, i) => [k, i]));
  const edits = marks.filter(m => !m.inner && map.get(m.start) !== m.start).map(m => m.set(map.get(m.start)));
  const step = map.get(state.step), raw = text.slice(c.start, c.end);
  if (c.kind === 'fig') edits.push([c.start, c.end, figArg(raw, 'step', step ? String(step) : null)]);
  else if (c.kind === 'image') edits.push([c.start, c.end, imageAttr(raw, 'data-step', step ? String(step) : null)]);
  else if (isBox(c)) edits.push([c.start, c.openEnd, divAttr(text.slice(c.start, c.openEnd), 'data-step', step ? String(step) : null)]);
  else {
    const w = wrapEdit(text, c, { step, incremental: state.incremental }, r => r.replace(HIGHLIGHT, (_, a, q, n) => `${a}${q}${map.get(+n) ?? n}${q}`));
    edits.push(w.edit);
    // 前にある変更で桁が変わった分だけ、選び直す位置をずらす
    const shift = edits.slice(0, -1).filter(e => e[0] < own.start).reduce((d, [a, b, s]) => d + s.length - (b - a), 0);
    return { text: apply(text, edits), at: w.at + shift, end: w.end + shift };
  }
  return { text: apply(text, edits), select: key };
}

// 装飾は既存の属性・余白・段を保持して対象だけに書く。
export const canDecorate = c => !!c && ['text', 'image', 'box', 'column', 'columns'].includes(c.kind);
export function decorationOf(text, c) {
  if (c.kind === 'text' && outer(c).parent?.kind === 'column') c = outer(c).parent;
  const raw = text.slice(c.start, c.end);
  const style = c.kind === 'text' ? outer(c).attrs?.kv?.style : c.attrs?.kv?.style ?? raw.match(/\bstyle="([^"]*)"/)?.[1];
  return Object.fromEntries(styleProps(style).filter(([k]) => DECORATION_PROPERTIES.includes(k)));
}
export function setDecoration(text, st, key, values) {
  let c = find(st, key)?.chunk;
  if (!canDecorate(c)) return null;
  if (c.kind === 'column' && c.children.length === 1 && canMergeColumn(c, c.children[0])) c = c.children[0];
  if (c.kind === 'text' && c.parent?.children.length === 1 && c.parent.parent?.kind === 'column'
      && c.parent.parent.children.length === 1 && canMergeColumn(c.parent.parent, c.parent)) c = c.parent;
  // 列の中身全体へのデザインは列へ保存し、列の内側にもう1つ箱を作らない。
  const o = outer(c), column = o.parent;
  if (column?.kind === 'column' && c.kind === 'text' && column.children.length > 1) { c = column; key = column.key; }
  if (column?.kind === 'column' && column.children.length === 1 && (c.kind === 'text' || canMergeColumn(column, c))) {
    if (columnBox(o)) {
      text = mergeColumn(text, column, o);
      // 列の開始行だけを編集するので、統合後の終端位置は不要。
      const open = text.slice(column.start).split('\n')[0];
      c = { ...column, openEnd: column.start + open.length, attrs: { ...column.attrs, kv: { ...column.attrs.kv, ...o.attrs.kv,
        style: open.match(/\bstyle="([^"]*)"/)?.[1] } } };
    } else c = column;
    key = column.key;
  }
  if (c.kind === 'text') {
    const result = setTextOptions(text, st, key, values);
    // 枠を付けた直後は中の段落ではなく、新しく作った囲みを選ぶ。
    if (designOf({ ...decorationOf(text, c), ...values }) !== 'unframed') result.select = outer(c).key;
    return result;
  }
  let style = c.attrs?.kv?.style ?? text.slice(c.start, c.end).match(/\bstyle="([^"]*)"/)?.[1];
  for (const prop of DECORATION_PROPERTIES) if (prop in values) style = withStyle(style, prop, values[prop]);
  if (isBox(c)) return { text: splice(text, c.start, c.openEnd, divAttr(text.slice(c.start, c.openEnd), 'style', style || null)), select: key };
  if (c.kind === 'image') return { text: chunkRaw(text, c, r => imageAttr(r, 'style', style || null)), select: key };
  return null;
}
