// 自作の画面（.dialog-back）のフォーカス。Tab・⇧Tab は一番上の画面の中だけを回り、閉じたら開く前の場所へ戻す。
// 画面はそれぞれの機能が作って消すので、ここでは出入りを見て共通に扱う（Esc で閉じるのは各画面のまま）。
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable=true]';
const openers = new WeakMap();
// 最近フォーカスした場所（新しい順）。開いた「…」メニューの項目のように消えるものがあるので、いくつか覚える
let recent = [];

const top = () => { const all = document.querySelectorAll('.dialog-back'); return all[all.length - 1] || null; };
const visible = el => el.getClientRects().length > 0 && !el.closest('[hidden], [inert]');
export const focusables = box => [...box.querySelectorAll(FOCUSABLE)].filter(el => el.tabIndex >= 0 && visible(el));

function remember(back) {
  // 画面を出す前に触っていた場所（画面を出した処理が中へ移していても、その前の場所）
  if (!openers.has(back)) openers.set(back, recent.filter(el => !back.contains(el)));
}
function restore(back) {
  const candidates = openers.get(back) || [];
  openers.delete(back);
  const active = document.activeElement;
  // 別の場所へ移していれば（次の画面・入力欄など）そのままにする
  if (active && active !== document.body && active.isConnected && !back.contains(active)) return;
  // 下に別の画面が残っていれば、その中の場所へ戻す
  const next = top();
  const opener = candidates.find(el => el.isConnected && visible(el) && (!next || next.contains(el)));
  if (opener) opener.focus({ preventScroll: true });
  else if (next) focusables(next)[0]?.focus();
}

export function installModalFocus(doc = document) {
  doc.addEventListener('focusin', e => {
    if (e.target === doc.body) return;
    recent = [e.target, ...recent.filter(el => el !== e.target && el.isConnected)].slice(0, 5);
  }, true);
  new MutationObserver(records => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1 && n.matches('.dialog-back')) remember(n);
      for (const n of r.removedNodes) if (n.nodeType === 1 && n.matches('.dialog-back')) restore(n);
    }
  }).observe(doc.body, { childList: true });
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const back = top(); if (!back) return;
    // 上に開いた <dialog>（showModal）はブラウザーが閉じ込めるので任せる
    const native = doc.querySelector('dialog[open]');
    if (native && !back.contains(native)) return;
    const items = focusables(back); if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], active = doc.activeElement;
    const inside = back.contains(active);
    if (!inside) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && (active === first || active === back)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  });
}
