// ホームの発表カードの「…」メニュー（名前・フォルダ名の変更、削除）と直前の操作の取り消し。
import { api, toast } from './api.js';
import { S } from './strings.js';
import { svg } from './icons.js';
import { tip } from './tip.js';

export function homeManage(root, reload) {
  let token = null, busy = false, alive = true;
  const notice = document.createElement('div');
  notice.className = 'deck-notice'; notice.setAttribute('role', 'status'); notice.hidden = true;
  root.append(notice);
  const button = (icon, label, fn, keys = '') => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ibtn'; b.innerHTML = svg(icon);
    tip(b, label, keys); b.onclick = e => { e.stopPropagation(); fn(); };
    return b;
  };
  async function undo() {
    if (!token || busy) return;
    busy = true;
    try {
      await api('/api/home/manage', { method: 'POST', body: { action: 'undo', token } });
      token = null; notice.hidden = true; toast(S.deckManage.restored); await reload();
    } catch (e) { toast(e.message); }
    finally { busy = false; }
  }
  // 受け付けられたらすぐ画面を閉じ（done）、一覧を読み直す
  async function perform(body, done) {
    const result = await api('/api/home/manage', { method: 'POST', body });
    done();
    if (!alive) return;
    token = result.token;
    notice.textContent = body.action === 'delete' ? S.deckManage.deleted : body.title === undefined ? S.deckManage.moved : S.deckManage.renamed;
    notice.append(button('undo', S.deckManage.undo, undo, '⌘ Z'));
    notice.hidden = false;
    await reload();
  }
  // 1つの欄だけの小さい画面（名前の変更・フォルダ名の変更）
  function ask(title, label, value, input, send, hint = '') {
    const back = document.createElement('div'); back.className = 'dialog-back';
    back.innerHTML = `<form class="dialog deck-ask" role="dialog" aria-modal="true"><div class="dh"><h3></h3></div><label><span></span><input autocomplete="off" spellcheck="false"></label>
      ${hint ? '<p class="field-hint"></p>' : ''}<p class="error" role="alert"></p><div class="df"></div></form>`;
    const form = back.querySelector('form'), field = form.querySelector('input'), error = form.querySelector('.error');
    form.setAttribute('aria-label', title);
    form.querySelector('h3').textContent = title; form.querySelector('label span').textContent = label;
    if (hint) form.querySelector('.field-hint').textContent = hint;
    Object.assign(field, { value, required: true }, input);
    const close = () => { back.remove(); removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const save = button('check', S.deckManage.save, () => form.requestSubmit());
    save.classList.add('primary');
    form.querySelector('.df').append(button('x', S.cancel, close), save);
    form.onsubmit = async e => {
      e.preventDefault();
      if (field.value === value) { close(); return; }
      save.disabled = true;
      try { await send(field.value, close); }
      catch (err) { error.textContent = err.message; save.disabled = false; }
    };
    back.onmousedown = e => { if (e.target === back) close(); };
    addEventListener('keydown', onKey);
    document.body.append(back); field.focus(); field.select();
  }
  const rename = deck => ask(S.deckManage.rename, S.deckTitle, deck.title, {},
    (title, done) => perform({ action: 'rename', deck: deck.deck, name: deck.deck, title }, done));
  const move = deck => ask(S.deckManage.folder, S.deckName, deck.deck, { pattern: '[a-z0-9][a-z0-9-]*' },
    (name, done) => perform({ action: 'rename', deck: deck.deck, name }, done), S.deckManage.folderHint);
  // カードの「…」から開くメニュー。上下キーで移り、Esc・外を押すと閉じる
  let menu = null;
  function closeMenu(focus = false) {
    if (!menu) return;
    const { el, anchor } = menu; menu = null;
    el.remove(); anchor.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', outside, true); removeEventListener('resize', closeMenu); removeEventListener('scroll', closeMenu, true);
    if (focus) anchor.focus();
  }
  const outside = e => { if (menu && !menu.el.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu(); };
  function openMenu(anchor, deck) {
    const again = menu?.anchor === anchor;
    closeMenu();
    if (again) return;
    const el = document.createElement('div'); el.className = 'deck-menu'; el.setAttribute('role', 'menu'); el.setAttribute('aria-label', S.deckManage.more);
    for (const item of [['pencil', S.deckManage.rename, S.deckManage.renameTip, rename], ['folder', S.deckManage.folder, S.deckManage.folderTip(deck.deck), move],
      null, ['trash', S.deckManage.remove, S.deckManage.removeTip, remove]]) {
      if (!item) { el.append(document.createElement('hr')); continue; }
      const [icon, label, help, fn] = item;
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem'); b.dataset.tip = help;
      if (icon === 'trash') b.className = 'danger';
      b.innerHTML = `${svg(icon)}<span></span>`; b.querySelector('span').textContent = label;
      b.onclick = () => { closeMenu(); fn(deck); };
      el.append(b);
    }
    el.addEventListener('keydown', e => {
      const items = [...el.querySelectorAll('button')], i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(true); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
      else if (e.key === 'Tab') closeMenu();
    });
    document.body.append(el);
    // ボタンの下に右端をそろえて出す。下に入らなければ上に出す。項目の説明はメニューの外側に出して項目を隠さない
    const r = anchor.getBoundingClientRect(), h = el.offsetHeight, up = r.bottom + 4 + h > innerHeight - 8;
    el.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    el.style.top = `${up ? Math.max(8, r.top - 4 - h) : r.bottom + 4}px`;
    el.dataset.tipSide = up ? 'above' : 'below';
    anchor.setAttribute('aria-expanded', 'true');
    menu = { el, anchor };
    addEventListener('pointerdown', outside, true); addEventListener('resize', closeMenu); addEventListener('scroll', closeMenu, true);
    el.querySelector('button').focus();
  }
  function remove(deck) {
    const back = document.createElement('div'); back.className = 'dialog-back';
    const box = document.createElement('div'); box.className = 'dialog';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', S.deckManage.remove);
    const text = document.createElement('p'); text.textContent = S.deckManage.confirm(deck.title);
    const error = document.createElement('p'); error.className = 'error'; error.setAttribute('role', 'alert');
    const foot = document.createElement('div'); foot.className = 'df';
    const close = () => { back.remove(); removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const cancel = button('x', S.cancel, close);
    const yes = button('trash', S.deckManage.remove, async () => {
      yes.disabled = true;
      try { await perform({ action: 'delete', deck: deck.deck }, close); }
      catch (e) { error.textContent = e.message; yes.disabled = false; }
    });
    foot.append(cancel, yes); box.append(text, error, foot); back.append(box); document.body.append(back);
    back.onmousedown = e => { if (e.target === back) close(); };
    addEventListener('keydown', onKey); cancel.focus();
  }
  const keydown = e => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' || !token) return;
    if (document.querySelector('.dialog-back') || e.target.closest?.('input, textarea, [contenteditable=true]')) return;
    e.preventDefault(); undo();
  };
  addEventListener('keydown', keydown);
  return {
    card(card, deck) {
      const wrap = document.createElement('div'); wrap.className = 'deck-card-wrap'; wrap.dataset.deck = deck.deck;
      wrap.append(card);
      if (!deck.running) {
        const more = button('more', S.deckManage.more, () => openMenu(more, deck));
        more.classList.add('deck-more'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
        wrap.append(more);
      }
      return wrap;
    },
    destroy() { alive = false; closeMenu(); notice.remove(); removeEventListener('keydown', keydown); },
  };
}
