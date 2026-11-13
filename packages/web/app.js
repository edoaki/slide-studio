import { installExternalLinks } from './external-links.js';
import { forwardWheel } from './bridge/agent-client.js';
// 画面の切り替え：/ はホーム、/deck/<名前> は発表の編集画面。
import { mountTopic } from './topic.js';
import { mountHome } from './home.js';
import { mountAgents } from './agents.js';
import { mountEditor } from './editor.js';
import './tip.js';

let unmount = null;
let leaving = null;
// Called only by the trusted desktop host or navigation within this UI.
export function flushBeforeLeave() {
  if (!leaving) leaving = Promise.resolve().then(() => unmount?.flush?.() ?? true)
    .catch(() => false).finally(() => { leaving = null; });
  return leaving;
}
const entryKey = 'slideStudioEntry';
let entry = Number.isSafeInteger(history.state?.[entryKey]) ? history.state[entryKey] : 0;
let renderedUrl = location.pathname + location.search + location.hash;
let navigating = null, restoringHistory = false, traversal = 0;
history.replaceState({ ...history.state, [entryKey]: entry }, '', location.href);
export function navigate(path, replace = false) {
  if (navigating) return navigating;
  navigating = (async () => {
    if (!await flushBeforeLeave()) return false;
    traversal++;
    if (!replace) entry++;
    history[replace ? 'replaceState' : 'pushState']({ [entryKey]: entry }, '', path);
    route();
    return true;
  })().finally(() => { navigating = null; });
  return navigating;
}
function route() {
  renderedUrl = location.pathname + location.search + location.hash;
  unmount?.();
  const root = document.getElementById('root');
  root.textContent = '';
  const m = location.pathname.match(/^\/deck\/([^/]+)/);
  const topic = location.pathname.match(/^\/topic\/([^/]+)$/);
  unmount = location.pathname === '/agents' ? mountAgents(root) : topic ? mountTopic(root, decodeURIComponent(topic[1])) : m ? mountEditor(root, decodeURIComponent(m[1])) : mountHome(root);
}
addEventListener('popstate', async event => {
  if (restoringHistory) { restoringHistory = false; return; }
  if (window.__slideStudioFigureRoute?.()) return;
  const ticket = ++traversal, target = event.state?.[entryKey];
  const saved = await flushBeforeLeave();
  if (ticket !== traversal) return;
  if (!saved) {
    if (Number.isSafeInteger(target) && target !== entry) {
      restoringHistory = true;
      history.go(entry - target);
    } else history.replaceState({ ...history.state, [entryKey]: entry }, '', renderedUrl);
    return;
  }
  entry = Number.isSafeInteger(target) ? target : entry + 1;
  history.replaceState({ ...history.state, [entryKey]: entry }, '', location.href);
  route();
});
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
