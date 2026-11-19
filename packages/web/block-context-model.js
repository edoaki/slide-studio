import { mapSourceProse } from './source-prose.js';
import * as op from './block-ops.js';

export function duplicateBlock(text, structure, key) {
  const found = op.find(structure, key);
  if (!found || op.coverPart(found.chunk) || found.chunk.kind === 'def' || found.page.raw_only) return null;
  const c = op.outer(found.chunk);
  let raw = text.slice(c.start, c.end);
  // Keep authored anchors unique, and retarget links inside the copied block.
  const ids = new Map();
  let prose = ''; mapSourceProse(raw, value => { prose += value; return value; });
  for (const m of prose.matchAll(/(?:\{[^}\n]*?#|\bid=["'])([\w:.-]+)/g)) {
    const id = m[1]; if (ids.has(id)) continue;
    let next = `${id}-copy`, n = 2;
    while (text.includes(next) || [...ids.values()].includes(next)) next = `${id}-copy-${n++}`;
    ids.set(id, next);
  }
  for (const [id, next] of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    raw = mapSourceProse(raw, value => value.replace(new RegExp(`([#]|\\bid=["'])${escaped}(?=[\\s}"')\\]])`, 'g'), (_, prefix) => prefix + next));
  }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = c.kind === 'column' ? nl : nl + nl, at = c.end + separator.length;
  return { text: text.slice(0, c.end) + separator + raw + text.slice(c.end), at, end: at + raw.length };
}

export function blockContextActions(text, structure, key) {
  const f = op.find(structure, key);
  if (!f || op.coverPart(f.chunk) || f.chunk.kind === 'def' || f.page.raw_only) return null;
  return {
    duplicate: duplicateBlock(text, structure, key), remove: op.remove(text, structure, key),
    up: op.nudge(text, structure, key, -1), down: op.nudge(text, structure, key, 1),
    pages: structure.pages.filter(p => !p.raw_only).map(p => ({ index: p.index, title: p.title, enabled: op.moves(text, structure, key, { pageEnd: p.index }) })),
  };
}
