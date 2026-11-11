// 原稿の構造（/api/structure を UTF-16 の位置にしたもの）。同じ原稿への問い合わせは1回にまとめ、
// スライドの操作と原稿のブロック表示で共有する。描き直し（Pandoc）は待たない。
import { api } from './api.js';
import { units } from './block-ops.js';

const cache = new Map();
export function structureOf(text) {
  let p = cache.get(text);
  if (!p) {
    p = api('/api/structure', { method: 'POST', body: { text } }).then(s => ({ ...units(text, s), text }));
    p.catch(() => cache.delete(text));
    cache.set(text, p);
    while (cache.size > 12) cache.delete(cache.keys().next().value);
  }
  return p;
}
