import { S } from './strings.js';
import { studioSelect } from './custom-select.js';

export function makeBlockContextMenu({ root, apply, movePage }) {
  let menu = null, origin = null;
  function close(restore = false) { menu?.remove(); menu = null; if (restore && origin?.isConnected) origin.focus(); origin = null; }
  const outside = e => { if (menu && !menu.contains(e.target)) close(); };
  const key = e => {
    if (!menu) return;
    // 移動先の選択欄の中のキーは欄に任せる（一覧を開いている間の Esc は一覧だけ閉じる）
    const field = e.target.closest?.('studio-select');
    if (e.key === 'Escape' && !field?.open) { e.preventDefault(); e.stopPropagation(); close(true); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && !field) {
      e.preventDefault(); e.stopPropagation();
      const items = [...menu.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
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
      const select = studioSelect({ label: t.movePage, placeholder: t.choosePage, size: 'sm', options: actions.pages.map(p => ({ value: String(p.index), label: t.page(p.index + 1, p.title), disabled: !p.enabled })) });
      select.onchange = () => { if (select.value !== '') { const page = +select.value; close(); movePage(page); } };
      label.append(select); menu.append(label); root.append(menu);
      menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
      menu.querySelector('button:not(:disabled)')?.focus();
    },
    destroy() { close(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur); },
  };
}
