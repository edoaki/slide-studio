import { installExternalLinks } from './external-links.js';
import { forwardWheel } from './bridge/agent-client.js';
// 画面の切り替え：/ はホーム、/deck/<名前> は発表の編集画面。
import { mountTopic } from './topic.js';
import { mountHome } from './home.js';
import { mountAgents } from './agents.js';
import { mountEditor } from './editor.js';
import './tip.js';

let unmount = null;
export function navigate(path, replace = false) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  route();
}
function route() {
  unmount?.();
  const root = document.getElementById('root');
  root.textContent = '';
  const m = location.pathname.match(/^\/deck\/([^/]+)/);
  const topic = location.pathname.match(/^\/topic\/([^/]+)$/);
  unmount = location.pathname === '/agents' ? mountAgents(root) : topic ? mountTopic(root, decodeURIComponent(topic[1])) : m ? mountEditor(root, decodeURIComponent(m[1])) : mountHome(root);
}
addEventListener('popstate', () => { if (!window.__slideStudioFigureRoute?.()) route(); });
// iframe の外でも横スワイプは表示中のスライドへ渡す。
addEventListener('wheel', e => {
  const frame = document.querySelector('.present-screen iframe') || document.querySelector('#slideBox iframe:not(.loading)');
  if (frame) forwardWheel(frame, e);
}, { passive: false, capture: true });
installExternalLinks(document);
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate(a.getAttribute('href')); }
});
route();
