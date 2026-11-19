import { S } from '../strings.js';
import { svg } from '../icons.js';

// Keep the player's existing overview/fullscreen handlers and bridge interception.
export function installPresentationFooter(win, currentDeck) {
  const doc = win.document, toolbar = doc.querySelector('#toolbar');
  const menu = toolbar?.querySelector('#menu'), fullscreen = toolbar?.querySelector('#fullscreen');
  if (!toolbar || !menu || !fullscreen) return;
  toolbar.classList.add('presentation-footer');
  const style = doc.createElement('style');
  style.textContent = `
    body #toolbar.presentation-footer {inset:auto 0 0; height:86px; padding:27px 24px 0;
      display:flex; align-items:center; gap:12px; background:linear-gradient(transparent 24px,#191b20 24px);
      color:#eee; font:14px system-ui,sans-serif; opacity:0; transition:opacity .15s}
    body #toolbar.presentation-footer:hover, body #toolbar.presentation-footer:focus-within {opacity:1}
    .presentation-footer .presentation-progress {position:absolute; top:24px; left:0; width:100%; height:3px; background:#ffffff30}
    .presentation-footer .presentation-progress-fill {display:block; height:100%; background:#00c4d0}
    .presentation-footer .presentation-pages {margin-right:auto; font-variant-numeric:tabular-nums}
    body #toolbar.presentation-footer button {display:grid; place-items:center; padding:8px; width:36px; height:36px;
      border:0; border-radius:4px; background:transparent; color:inherit}
    body #toolbar.presentation-footer button:hover {background:#ffffff15}
    .presentation-footer svg {width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round}
    .presentation-footer .presentation-exit-hint {font-size:12px; color:#b7b9be; white-space:nowrap; margin-left:8px}
    @media (hover:none) {body #toolbar.presentation-footer {opacity:1}}
    @media (prefers-reduced-motion:reduce) {body #toolbar.presentation-footer {transition:none}}
  `;
  doc.head.append(style);
  const progress = doc.createElement('div'); progress.className = 'presentation-progress';
  progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-label', S.present.progress);
  progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100');
  const fill = doc.createElement('span'); fill.className = 'presentation-progress-fill'; progress.append(fill);
  const pages = doc.createElement('span'); pages.className = 'presentation-pages';
  const hint = doc.createElement('span'); hint.className = 'presentation-exit-hint'; hint.textContent = S.present.exitHint; hint.title = S.speaker.shortcuts;
  menu.innerHTML = svg('grid'); menu.setAttribute('aria-label', S.present.overview);
  fullscreen.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>';
  fullscreen.setAttribute('aria-label', S.present.fullscreen);
  toolbar.replaceChildren(progress, pages, menu, fullscreen, hint);
  const update = () => {
    const deck = currentDeck(); if (!deck) return;
    const visible = Array.from(deck.slides || []).map((slide,index) => ({slide,index})).filter(({slide}) => !slide.classList.contains('studio-skip'));
    const count = visible.length, page = count ? visible.findIndex(({index}) => index === deck.index) + 1 : 0;
    pages.textContent = `${page} / ${count}`;
    const ratio = count ? page / count * 100 : 0;
    fill.style.width = `${ratio}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(ratio)));
    progress.setAttribute('aria-valuetext', pages.textContent);
  };
  win.addEventListener('deckchange', update);
  update();
}
