// Filter and sort a copy so home reloads and new-presentation defaults retain their original order.
export function presentationList(items, query = '', sort = 'opened') {
  const words = query.normalize('NFKC').toLocaleLowerCase('ja').trim().split(/\s+/u).filter(Boolean);
  const text = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ja');
  const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'ja', { numeric: true });
  return items.filter(item => words.every(word => text(`${item.title || ''} ${item.shelf || ''}`).includes(word)))
    .sort((a, b) => (sort === 'title' ? compare(a.title, b.title)
      : sort === 'topic' ? compare(a.shelf, b.shelf) || compare(a.title, b.title)
      : sort === 'modified' ? Number(b.modified || 0) - Number(a.modified || 0)
      : Number(b.opened || 0) - Number(a.opened || 0) || Number(b.modified || 0) - Number(a.modified || 0)) || compare(a.deck, b.deck));
}
