// 原稿の構造（/api/structure を UTF-16 の位置にしたもの）。同じ原稿への問い合わせは1回にまとめ、
// スライドの操作と原稿のブロック表示で共有する。描き直し（Pandoc）は待たない。
import { api } from './api.js';
import { units } from './block-ops.js';

const cache = new Map();
function entry(text) {
  let e = cache.get(text);
  if (!e) {
    e = { raw: api('/api/structure', { method: 'POST', body: { text } }), units: null };
    const own = e;
    e.raw.catch(() => { if (cache.get(text) === own) cache.delete(text); });
    cache.set(text, e);
    while (cache.size > 12) cache.delete(cache.keys().next().value);
  }
  return e;
}
export function structureOf(text) {
  const e = entry(text);
  return e.units ??= e.raw.then(s => ({ ...units(text, s), text }));
}
// サーバーが返したままの構造（位置は文字数。ctx.structure と同じ形）
export const rawStructureOf = text => entry(text).raw;
