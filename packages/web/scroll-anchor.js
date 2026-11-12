// 原稿の更新前後で共通する、画面内の文字の位置を保つ。
// 単なる scrollTop の復元では、上側の文章が伸び縮みすると見ていた所が飛ぶ。
export function captureScroll(scroller, entries, before, after) {
  if (!scroller) return null;
  const fallback = scroller.scrollTop, view = scroller.getBoundingClientRect();
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  for (const { el, pos } of entries) {
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom <= view.top || r.top >= view.bottom) continue;
    const next = pos < prefix ? pos : pos >= before.length - suffix ? pos + after.length - before.length : null;
    if (next != null) return { pos: next, top: r.top - view.top, fallback };
  }
  return { fallback };
}

export function restoreScroll(scroller, anchor, entries) {
  if (!anchor) return;
  const el = anchor.pos != null && entries.find(e => e.pos === anchor.pos)?.el;
  scroller.scrollTop = el ? scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top : anchor.fallback;
}
