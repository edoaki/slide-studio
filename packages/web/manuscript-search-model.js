import { pageHeads } from './qmd-scan.js';

// Literal, non-overlapping matches. RegExp's indices remain UTF-16 offsets,
// including when Unicode case folding changes the length of a lowercase string.
export function manuscriptMatches(text, query, { caseSensitive = false } = {}) {
  if (!query) return [];
  const lines = text.split('\n'), offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
  const heads = pageHeads(lines).map((h, page) => ({ page, start: offsets[h.line], title: lines[h.line].replace(/^#+\s*/, '') }));
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
  const result = []; let page = -1;
  for (const match of text.matchAll(pattern)) {
    const start = match.index, end = start + match[0].length;
    while (heads[page + 1]?.start <= start) page++;
    const from = Math.max(text.lastIndexOf('\n', start - 1) + 1, start - 50);
    const lineEnd = text.indexOf('\n', end);
    const to = Math.min(lineEnd < 0 ? text.length : lineEnd, end + 70);
    result.push({ start, end, value: match[0], page, title: heads[page]?.title || '', before: text.slice(from, start), after: text.slice(end, to) });
  }
  return result;
}

export function replaceManuscriptMatches(text, matches, replacement) {
  // Reject stale or overlapping ranges instead of writing into unrelated text.
  let end = 0;
  for (const m of matches) {
    if (m.start < end || m.start < 0 || m.end <= m.start || text.slice(m.start, m.end) !== m.value) return null;
    end = m.end;
  }
  for (const m of [...matches].reverse()) text = text.slice(0, m.start) + replacement + text.slice(m.end);
  return text;
}
