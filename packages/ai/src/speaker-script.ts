import { parse } from '../../core/src/source.js';
import { noteText, replaceNote, type NoteRange } from '../../core/src/speaker-notes.js';

export const scriptSchema = {
  type: 'object', additionalProperties: false, required: ['notes'],
  properties: {notes: {type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['page', 'text'],
    properties: {page: {type: 'integer'}, text: {type: 'string'}},
  }}},
};

export function scriptTargets(text: string) {
  const offsets = [0];
  for (const ch of text) offsets.push(offsets[offsets.length - 1]! + ch.length);
  return parse(text).pages.flatMap(page => {
    if (page.generated || page.raw_only || page.attrs.classes.includes('studio-skip')) return [];
    const chunks: NoteRange[] = [];
    for (const chunk of page.chunks) {
      if (!chunk.attrs?.classes.some(k => k === 'note' || k === 'notes')) continue;
      if (!chunk.open || !chunk.close) return [];
      chunks.push({start: offsets[chunk.start]!, end: offsets[chunk.end]!, openEnd: offsets[chunk.open[1]]!,
        closeStart: offsets[chunk.close[0]]!, close: text.slice(offsets[chunk.close[0]], offsets[chunk.close[1]])});
    }
    return noteText(text, chunks).trim() ? [] : [{page: page.index + 1, title: page.title, at: offsets[page.end]!, chunks}];
  });
}

export function applyScript(text: string, targets: ReturnType<typeof scriptTargets>, value: unknown) {
  const notes = new Map<number, string>();
  if (Array.isArray(value)) for (const item of value) {
    if (!Number.isInteger(item?.page) || typeof item.text !== 'string' || !item.text.trim() || notes.has(item.page)) break;
    notes.set(item.page, item.text.trim());
  }
  if (!Array.isArray(value) || value.length !== targets.length || !targets.every(t => notes.has(t.page))) {
    throw Error('対象ページの原稿がそろいませんでした。もう一度送信してください。');
  }
  for (const t of targets.toReversed()) text = replaceNote(text, t.chunks, t.at, notes.get(t.page)!);
  return text;
}
