// 選択を入力欄へ移す前に保存し、リンクの変更を1回の編集として流す。
export function makeLink(active, selected, changed) {
  let saved = null, anchor = null;
  function state() {
    const el = active(); if (!el) return null;
    const r = selected() || document.createRange();
    if (!selected()) { r.selectNodeContents(el); r.collapse(false); }
    saved = r.cloneRange();
    const at = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    anchor = at.closest('a[href]');
    if (anchor && (!el.contains(anchor) || anchor.closest('[data-slide-studio-atom]'))) anchor = null;
    return { url: anchor?.getAttribute('href') || '', existing: !!anchor, label: r.collapsed && !anchor };
  }
  function apply(url, text) {
    const el = active(); if (!el || !saved || !el.contains(saved.commonAncestorContainer)) return;
    const r = saved.cloneRange(), box = document.createElement('div');
    // 外すときは unlink。insertHTML で文字だけを入れ直すと、Chrome はリンクの中に入れてしまう
    if (anchor?.isConnected && url == null) {
      el.focus({ preventScroll: true });
      r.selectNode(anchor);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.execCommand('unlink');
      changed(); saved = anchor = null; return;
    }
    if (anchor?.isConnected) {
      r.selectNode(anchor); box.append(anchor.cloneNode(true));
      box.firstChild.setAttribute('href', url);
    } else {
      const a = document.createElement('a'); a.setAttribute('href', url);
      if (r.collapsed) a.textContent = text;
      else {
        a.append(r.cloneContents());
        a.querySelectorAll('a').forEach(n => n.replaceWith(...n.childNodes));
      }
      box.append(a);
    }
    el.focus({ preventScroll: true });
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertHTML', false, box.innerHTML);
    changed(); saved = anchor = null;
  }
  return { state, apply };
}
