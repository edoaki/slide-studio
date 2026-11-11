// ブロックの選択のたどり方（設計書 §10.4 の WASD・QE・パンくず）。原稿の構造（block-ops の units）の上で決める。
// 層は囲み（横並び・列・箱）→ 中身。ページは選ばない。段落の余白の包みは数えない。
import * as op from './block-ops.js';
import { S } from './strings.js';

// 外側（Q）。いちばん上のブロックで止まる
export function upKey(st, key) {
  const f = op.find(st, key); if (!f) return null;
  return op.outer(f.chunk).parent?.key ?? null;
}
// 内側（E）。memory：その中で前に選んでいた子
export function downKey(st, key, memory) {
  const f = op.find(st, key); if (!f) return null;
  const kids = op.kidsOf(f.page, f.chunk);
  return kids.find(k => k.key === memory.get(key))?.key ?? kids[0]?.key ?? null;
}
// 縦の並びの前・次（W／S）。列は横に並ぶので、その横並びの前・次へ
export function verticalKey(st, key, delta) {
  const f = op.find(st, key); if (!f) return null;
  let c = op.outer(f.chunk);
  if (c.kind === 'column') c = c.parent;
  const list = op.kidsOf(f.page, c.parent), i = list.indexOf(op.inner(c));
  return list[i + delta]?.key ?? null;
}
// 横の並びの前・次（A／D）。列の中のブロックは、外側の横並びをたどって、隣の列の中で高さ（中心）が近いブロックへ。
// rectOf(key)：スライドでの位置（表示が古いときは null）
export function horizontalKey(st, key, delta, rectOf) {
  const f = op.find(st, key); if (!f) return null;
  const c = op.outer(f.chunk);
  const step = col => { const cols = col.parent.children; return cols[cols.indexOf(col) + delta]; };
  if (c.kind === 'column') return step(c)?.key ?? null;
  const columnAbove = x => { for (let p = x.parent; p; p = p.parent) if (p.kind === 'column') return p; return null; };
  for (let col = columnAbove(c); col; col = columnAbove(col)) {
    const n = step(col); if (!n) continue;
    const kids = op.kidsOf(f.page, n);
    if (!kids.length) return n.key;
    const r = rectOf(f.chunk.key);
    if (!r) return kids[0].key;
    const y = (r.top + r.bottom) / 2, dist = k => { const q = rectOf(k.key); return q ? Math.abs((q.top + q.bottom) / 2 - y) : Infinity; };
    return kids.reduce((a, b) => dist(b) < dist(a) ? b : a).key;
  }
  return null;
}
// 選んでいる位置（p3 › 横並び › 列1 › 段落）。押すとその層を選ぶ（ページは選べない：key が null）
export function trail(st, key) {
  const f = op.find(st, key); if (!f) return [];
  const out = [];
  for (let c = f.chunk; c; c = op.outer(c).parent) {
    const o = op.outer(c), list = o.parent ? o.parent.children : f.page.chunks;
    const label = c.kind === 'column' ? S.crumb.column(list.indexOf(o) + 1) : S.crumb[c.kind] ?? S.crumb.opaque;
    out.unshift({ key: c.key, label });
  }
  out.unshift({ key: null, label: S.crumb.page(f.page.index + 1) });
  return out;
}
// 入れ子の深さ（1〜3）。原稿のブロック表示の線の色（qLayer）と同じ数え方
export function layerOf(st, key) {
  return Math.min(3, Math.max(1, trail(st, key).length - 1));
}
// 層によらず種類で色を分けるブロック：図と生の HTML は html、画像は image。それ以外は null
export function kindTone(chunk, text) {
  if (chunk?.kind === 'fig') return 'html';
  if (chunk?.kind === 'image') return 'image';
  if (chunk?.kind === 'opaque' && /^(`{3,}\s*\{=html\}|<)/.test(text.slice(chunk.start, chunk.end))) return 'html';
  return null;
}
// 枠の色の名前（l1〜l3・html・image）
export function toneOf(st, key) {
  return kindTone(op.find(st, key)?.chunk, st.text) ?? `l${layerOf(st, key)}`;
}
