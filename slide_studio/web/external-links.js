// 本体の専用 Chrome から、OS の既定ブラウザーへリンクを渡す。
import { api, toast } from './api.js';
import { S } from './strings.js';
const installed = new WeakSet();
export function installExternalLinks(doc) {
  if (!doc || installed.has(doc)) return;
  installed.add(doc);
  const open = e => {
    if ((e.type === 'click' && e.button !== 0) || (e.type === 'auxclick' && e.button !== 1)) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.hasAttribute('data-nav') || a.hasAttribute('download') || a.isContentEditable) return;
    if (doc.querySelector('.slide-studio-editing')) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || !['http:', 'https:'].includes(a.protocol)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    api('/api/open-external', { method: 'POST', body: { url: a.href } }).catch(() => toast(S.externalLinkError));
  };
  // 編集用の document ハンドラーより先に処理する。
  doc.defaultView.addEventListener('click', open, true);
  doc.defaultView.addEventListener('auxclick', open, true);
}
