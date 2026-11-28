export interface NoteRange {
  start: number;
  end: number;
  openEnd: number;
  closeStart: number;
  close: string;
}

export const noteText = (text: string, chunks: NoteRange[]): string => chunks.map(c => {
  const body = text.slice(c.openEnd,c.closeStart).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const literal = body.match(/^(~{3,}) \{\.speaker-note-text\}\r?\n([\s\S]*)\r?\n\1$/);
  return literal ? literal[2]! : body;
}).join('\n\n');
export function replaceNote(text: string, chunks: NoteRange[], at: number, value: string, global = false) {
  if (chunks.some(c => !c.close)) throw Error('発表メモの囲みが閉じていません');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = value.replace(/\r\n?/g, '\n').replace(/\n/g, nl);
  const longest = Math.max(2, ...[...normalized.matchAll(/^\s*(:{3,})/gm)].map(m => m[1]!.length));
  const fence = ':'.repeat(longest + 1);
  const code = '~'.repeat(Math.max(2, ...[...normalized.matchAll(/^\s*(~{3,})/gm)].map(m => m[1]!.length)) + 1);
  const block = value ? `${fence} {.note${global ? ' .presentation-note' : ''}}${nl}${code} {.speaker-note-text}${nl}${normalized}${nl}${code}${nl}${fence}${nl}` : '';
  if (!chunks.length) return text.slice(0, at) + (block ? `${nl}${block}${nl}` : '') + text.slice(at);
  let result = text;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i]!; result = result.slice(0, c.start) + (i === 0 ? block : '') + result.slice(c.end);
  }
  return result;
}
