import { mapSourceProse } from './source-prose.js';
// 原稿の該当範囲だけを変更する。位置は UTF-16。
const walk = function* (chunks) { for (const c of chunks || []) { yield c; yield* walk(c.children); } };
export function duplicatePage(text, st, index) {
  const p = st.pages[index];
  if (!p || p.generated || p.raw_only || st.meta_error || st.unclosed?.length) return null;
  const used = new Set([...text.matchAll(/\{[^{}\n]*#([^\s}]+)/g)].map(m => m[1]));
  const ids = new Map(), edits = [];
  const fresh = id => { let n = 1, next; do { next = `${id || 'page'}-copy-${n++}`; } while (used.has(next)); used.add(next); return next; };
  const regions = [[p.start, p.head_end], ...[...walk(p.chunks)].filter(c => c.open != null).map(c => [c.start, c.openEnd])];
  for (const [a, b] of regions) {
    const raw = text.slice(a, b), m = raw.match(/\{[^{}]*?(#([^\s}]+))/);
    if (!m) continue;
    const id = m[2], next = fresh(id); ids.set(id, next);
    const at = a + m.index + m[0].lastIndexOf('#'); edits.push([at, at + id.length + 1, `#${next}`]);
  }
  // 自動 ID に依存せず、複製したページには一意の ID を与える。
  if (!p.id) {
    const raw = text.slice(p.start, p.head_end), tail = raw.match(/\{[^{}]*\}[ \t\r]*$/);
    const at = tail ? p.start + tail.index + 1 : p.head_end - (raw.endsWith('\r') ? 1 : 0);
    edits.push([at, at, tail ? `#${fresh('page')} ` : ` {#${fresh('page')}}`]);
  }
  let copy = text.slice(p.start, p.end);
  for (const [a, b, value] of edits.sort((a, b) => b[0] - a[0])) copy = copy.slice(0, a - p.start) + value + copy.slice(b - p.start);
  // 同じページ内を指す Markdown リンクも複製先へ向ける。
  copy = mapSourceProse(copy, raw => raw.replace(/\]\(#([^\s)]+)\)/g, (all, id) => ids.has(id) ? `](#${ids.get(id)})` : all));
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const separate = s => s.endsWith(nl + nl) ? '' : s.endsWith(nl) ? nl : nl + nl;
  return { text: text.slice(0, p.end) + separate(text.slice(p.start, p.end)) + copy + (p.end < text.length ? separate(copy) : '') + text.slice(p.end), page: index + 1 };
}
export function togglePageSkip(text, st, index) {
  const p = st.pages[index]; if (!p || p.raw_only) return null;
  const head = text.slice(p.start, p.head_end);
  // 生成ページは ::: の属性を正本とする。
  const marker = p.generated ? /:{3,}[ \t]*\{[^{}]*\}/.exec(head) : null;
  const offset = marker ? marker.index : 0, raw = marker ? marker[0] : head;
  const attr = /\{[^{}]*\}[ \t\r]*$/.exec(raw);
  let line;
  if (attr) {
    const attrs = attr[0].replace(/\s+$/, '');
    const next = /(?:^|\s)\.studio-skip(?=\s|})/.test(attrs.slice(1))
      ? attrs.replace(/([ \t]*)\.studio-skip(?=[ \t}]|$)/, '')
      : attrs.slice(0, -1) + ' .studio-skip}';
    line = raw.slice(0, attr.index) + next + raw.slice(attr.index + attrs.length);
  } else {
    const cr = raw.endsWith('\r') ? '\r' : '';
    line = raw.slice(0, raw.length - cr.length) + ' {.studio-skip}' + cr;
  }
  return { text: text.slice(0, p.start + offset) + line + text.slice(p.start + offset + raw.length), page: index };
}
