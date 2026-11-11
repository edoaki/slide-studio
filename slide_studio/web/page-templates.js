// §10.9。内容と縮小図はテーマに依らず、横並びだけ標準の columns を使う。
import { S, PAGE_PLACEHOLDERS as P } from './strings.js';
import { tip } from './tip.js';

const list = (n = 3) => Array(n).fill(`- ${P.item}`).join('\n');
const columns = (a, b) => `:::: {.columns}\n::: {.column}\n${a}\n:::\n::: {.column}\n${b}\n:::\n::::`;
export const PAGE_TEMPLATES = [
  { id: 'blank', body: '' },
  { id: 'chapter', body: '', chapter: true },
  { id: 'references', source: '::: {#refs}\n:::', unique: 'references' },
  { id: 'appendix', source: '# APPENDIX {#appendix}', unique: 'appendix' },
  { id: 'textImage', body: `${P.body}\n\n${P.image}\n\n${P.body}` },
  { id: 'imageBullets', body: `${P.body}\n\n${columns(P.image, `**${P.subhead}**\n\n${list()}\n\n**${P.subhead}**\n\n${list()}`)}` },
  { id: 'table', body: `| ${P.cell} | ${P.cell} | ${P.cell} |\n| --- | --- | --- |\n| ${P.cell} | ${P.cell} | ${P.cell} |\n| ${P.cell} | ${P.cell} | ${P.cell} |\n\n${P.note}` },
  { id: 'comparison', body: `${columns(`### ${P.subhead}\n\n${list()}`, `### ${P.subhead}\n\n${list()}`)}\n\n${P.summary}` },
];

export function isPlaceholder(raw) {
  const words = raw.trim().split('\n').flatMap(l => l.split(/[|\t]/)).map(s => s.trim()
    .replace(/^(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)/, '').replace(/^\*\*(.*?)\*\*$/, '$1'))
    .filter(s => s && !/^:?-+:?$/.test(s));
  return words.length > 0 && words.every(s => Object.values(P).includes(s));
}
export function imagePlaceholder(text, st, key, md) {
  if (!/^\s*(?:!\[|\{\{<\s*fig\s)/.test(md)) return null;
  const walk = cs => cs.flatMap(c => [c, ...walk(c.children || [])]);
  const c = st.pages.flatMap(p => walk(p.chunks)).find(c => c.key === key);
  return c?.kind === 'text' && text.slice(c.start, c.end).trim() === P.image
    ? { text: text.slice(0, c.start) + md + text.slice(c.end), select: key } : null;
}

// 配置は図形で、特殊なページは名前で示す。
function thumbnail(id) {
  const rect = (x, y, w, h, fill = 'currentColor') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="${fill}"/>`;
  const lines = (x, y, w, n = 3) => Array.from({ length: n }, (_, i) => rect(x, y + i * 7, w, 2)).join('');
  const image = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="currentColor"/><path d="M${x} ${y + h}l${w / 3} -${h / 2} ${w / 4} ${h / 4} ${w * 5 / 12} -${h / 2}" fill="none" stroke="currentColor"/>`;
  const label = text => `<text x="60" y="40" text-anchor="middle" fill="currentColor" font-size="13" font-weight="600">${text}</text>`;
  const special = S.pageTemplates.preview[id];
  if (special) return `<svg viewBox="0 0 120 75" aria-hidden="true">${label(special)}</svg>`;
  const body = {
    blank: '',
    textImage: lines(12, 23, 96, 1) + image(35, 30, 50, 23) + lines(12, 60, 96, 1),
    imageBullets: lines(12, 23, 96, 1) + image(12, 32, 43, 29) + lines(65, 32, 40, 5),
    table: `<path d="M12 25H108V56H12Z M12 35H108 M12 46H108 M44 25V56 M76 25V56" fill="none" stroke="currentColor"/>` + lines(12, 63, 75, 1),
    comparison: lines(12, 27, 42, 4) + lines(66, 27, 42, 4) + lines(12, 63, 96, 1),
  }[id];
  return `<svg viewBox="0 0 120 75" aria-hidden="true">${rect(12, 10, 75, 4)}<g opacity=".6">${body}</g></svg>`;
}
let dismiss = null;
export function choosePageTemplate(anchor, done, pages = []) {
  dismiss?.();
  const panel = document.createElement('div'); panel.className = 'page-templates';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', S.pageTemplates.title);
  const close = (focus = false) => {
    panel.remove(); document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', outside, true);
    dismiss = null; if (focus && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const key = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
    const bs = [...panel.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(document.activeElement);
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); bs[(i + d + bs.length) % bs.length].focus(); }
  };
  const outside = e => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
  for (const t of PAGE_TEMPLATES) {
    const b = tip(document.createElement('button'), S.pageTemplates[t.id]); b.type = 'button'; b.dataset.template = t.id;
    b.disabled = !!t.unique && pages.some(p => p.id === t.unique);
    b.innerHTML = thumbnail(t.id); b.onclick = () => { close(); done(t); }; panel.append(b);
  }
  document.body.append(panel);
  const r = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(r.bottom + 6, innerHeight - panel.offsetHeight - 8))}px`;
  document.addEventListener('keydown', key, true); document.addEventListener('pointerdown', outside, true);
  dismiss = close; panel.querySelector('button').focus({ preventScroll: true });
  return close;
}
