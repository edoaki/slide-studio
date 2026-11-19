// Source offsets supplied by structureOf are UTF-16; never normalize untouched QMD.
export const isPresentationNote = c => c?.attrs?.classes?.some(k => k === 'note' || k === 'notes');
export const noteText = (text, chunks) => chunks.map(c => {
  const body = text.slice(c.openEnd,c.closeStart).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const literal = body.match(/^(~{3,}) \{\.speaker-note-text\}\r?\n([\s\S]*)\r?\n\1$/);
  return literal ? literal[2] : body;
}).join('\n\n');
export function replaceNote(text, chunks, at, value, global = false) {
  if (chunks.some(c => !c.close)) throw Error('発表メモの囲みが閉じていません');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = value.replace(/\r\n?/g, '\n').replace(/\n/g, nl);
  const longest = Math.max(2, ...[...normalized.matchAll(/^\s*(:{3,})/gm)].map(m => m[1].length));
  const fence = ':'.repeat(longest + 1);
  const code = '~'.repeat(Math.max(2, ...[...normalized.matchAll(/^\s*(~{3,})/gm)].map(m => m[1].length)) + 1);
  const block = value ? `${fence} {.note${global ? ' .presentation-note' : ''}}${nl}${code} {.speaker-note-text}${nl}${normalized}${nl}${code}${nl}${fence}${nl}` : '';
  if (!chunks.length) return text.slice(0, at) + (block ? `${nl}${block}${nl}` : '') + text.slice(at);
  let result = text;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i]; result = result.slice(0, c.start) + (i === 0 ? block : '') + result.slice(c.end);
  }
  return result;
}
export function countedSlides(slides, pages, endPage = null) {
  const refs = pages.find(p => p.generated === 'refs' || p.id === 'references' || /^(参考文献|文献|references|bibliography)$/i.test(p.title.trim()));
  const limit = endPage ?? (refs ? refs.index - 1 : Infinity);
  return slides.filter(s => pages[s.page]?.level === 2 && !pages[s.page]?.generated && !pages[s.page]?.skipped && s.page <= limit).map(s => s.index);
}
export class RehearsalClock {
  constructor(now = () => performance.now()) { this.now = now; this.elapsed = 0; this.times = new Map(); this.running = false; this.index = 0; }
  tick() {
    if (!this.running) return;
    const current = this.now(), delta = Math.max(0, current - this.last); this.last = current;
    this.elapsed += delta; this.times.set(this.index, (this.times.get(this.index) || 0) + delta);
  }
  go(index) { this.tick(); this.index = index; if (this.running && !this.times.has(index)) this.times.set(index, 0); }
  start() { if (this.running) return; this.running = true; this.last = this.now(); if (!this.times.has(this.index)) this.times.set(this.index, 0); }
  pause() { this.tick(); this.running = false; }
}

// Store one completed run per deck. IDs keep comparisons aligned after reordering.
export function rehearsalRecord(clock, slides, pages, date = new Date().toISOString()) {
  const grouped = new Map();
  for (const slide of slides) {
    const page = pages[slide.page];
    if (page?.skipped) continue;
    const id = page?.id || slide.id;
    if (!id) continue;
    if (!grouped.has(id)) grouped.set(id, {id, title:page?.title || slide.title || id, number:slide.index + 1, ms:0, visited:false});
    const row = grouped.get(id);
    if (clock.times.has(slide.index)) { row.visited = true; row.ms += clock.times.get(slide.index); }
  }
  return {version:1, date, elapsed:clock.elapsed, pages:[...grouped.values()]};
}
