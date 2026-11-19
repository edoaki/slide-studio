import { S } from './strings.js';

export function makeBlockContextMenu({ root, apply, movePage }) {
  let menu = null, origin = null;
  function close(restore = false) { menu?.remove(); menu = null; if (restore && origin?.isConnected) origin.focus(); origin = null; }
  const outside = e => { if (menu && !menu.contains(e.target)) close(); };
  const key = e => {
    if (!menu) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && e.target.tagName !== 'SELECT') {
      e.preventDefault(); e.stopPropagation();
      const items = [...menu.querySelectorAll('button:not(:disabled),select')], index = items.indexOf(document.activeElement);
      items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
  const blur = () => close();
  window.addEventListener('blur', blur);
  return {
    close,
    open({ x, y, actions, anchor }) {
      close(); origin = anchor || document.activeElement;
      const t = S.blockContext; menu = document.createElement('div'); menu.className = 'block-context-menu';
      menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t.title);
      for (const name of ['duplicate', 'remove', 'up', 'down']) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = t[name]; b.setAttribute('role', 'menuitem'); b.disabled = !actions[name] || !!actions[name].error;
        b.onclick = () => { close(); apply(name); }; menu.append(b);
      }
      const label = document.createElement('label'); label.textContent = t.movePage;
      const select = document.createElement('select'); select.setAttribute('aria-label', t.movePage);
      select.append(new Option(t.choosePage, ''));
      for (const p of actions.pages) { const option = new Option(t.page(p.index + 1, p.title), String(p.index)); option.disabled = !p.enabled; select.append(option); }
      select.onchange = () => { if (select.value !== '') { const page = +select.value; close(); movePage(page); } };
      label.append(select); menu.append(label); root.append(menu);
      menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
      menu.querySelector('button:not(:disabled)')?.focus();
    },
    destroy() { close(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur); },
  };
}
