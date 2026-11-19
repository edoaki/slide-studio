// Only manuscript page boundaries are eligible; the cover and unfinished blocks stay intact.
export function slideInsertionPositions(structure) {
  if (structure.meta_error) return [];
  const pages = structure.pages;
  const cover = p => p.id === 'cover' || p.classes?.includes('cover');
  const lastCover = pages.findLastIndex(cover);
  const positions = pages.filter((p, i) => i > lastCover && !p.raw_only && (!p.generated || p.generated === 'refs') && !pages[i - 1]?.raw_only).map(p => p.index);
  const last = pages.at(-1);
  if (!structure.meta_error && (pages.length > 0 || !Array.from(structure.text || '').slice(structure.front?.[1] || 0).join('').trim()) && (!last || (!last.raw_only && last.generated !== 'refs'))) positions.push(pages.length);
  return positions;
}
