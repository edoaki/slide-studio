// Sort a copy so home reloads and new-presentation defaults retain their original order.
export function presentationList(items, sort = 'opened') {
  const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'ja', { numeric: true });
  return [...items].sort((a, b) => (sort === 'title' ? compare(a.title, b.title)
      : sort === 'topic' ? compare(a.shelf, b.shelf) || compare(a.title, b.title)
      : sort === 'modified' ? Number(b.modified || 0) - Number(a.modified || 0)
      : Number(b.opened || 0) - Number(a.opened || 0) || Number(b.modified || 0) - Number(a.modified || 0)) || compare(a.deck, b.deck));
}
