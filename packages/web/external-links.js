// 本体の専用 Chrome から、OS の既定ブラウザーへリンクを渡す。
import { api, toast } from './api.js';
import { S } from './strings.js';
const installed = new WeakSet();

function openExternal(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return;
  api('/api/open-external', { method: 'POST', body: { url: parsed.href } }).catch(() => toast(S.externalLinkError));
}

export function installExternalLinks(target) {
  if (!target || installed.has(target)) return;
  installed.add(target);

  // Secure preview/presentation path: the content agent reports only the link
  // URL. The parent, which owns the session, performs the API call. A trusted
  // click in the child propagates user activation to this ancestor; rate-limit
  // additionally so a compromised content realm cannot spam the OS browser.
  if (typeof target.on === 'function' && typeof target.request === 'function') {
    let last = 0;
    return target.on('link.open', data => {
      if (!navigator.userActivation?.isActive) return;
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      openExternal(data?.url);
    });
  }

  // Legacy/admin-document path, kept for app.js and for callers that have not
  // been migrated yet. This must not be used by preview.js or present.js.
  const doc = target;
  const open = e => {
    if ((e.type === 'click' && e.button !== 0) || (e.type === 'auxclick' && e.button !== 1)) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.hasAttribute('data-nav') || a.hasAttribute('download') || a.isContentEditable) return;
    if (doc.querySelector('.slide-studio-editing')) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || !['http:', 'https:'].includes(a.protocol)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    openExternal(a.href);
  };
  // 編集用の document ハンドラーより先に処理する。
  doc.defaultView.addEventListener('click', open, true);
  doc.defaultView.addEventListener('auxclick', open, true);
}
