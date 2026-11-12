// 文字の書式バー（設計書 §10.5）。スライドで文字を編集している間、ブロックのツールバーの代わりに同じ場所に出す。
// 大きさ ⊖ px ⊕｜文字の色（A を押すとテーマの色と自由な色のメニュー）｜太字・斜体｜色と大きさを戻す。先頭の［外側を選択］で段落の選択に戻る。
// 書式をかけるのはスライドの iframe の slideStudioEdit（inject/edit.js）。押してもスライドの文字から焦点を移さない。
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';
import { alignButton } from './text-tools.js';
import { linkInput } from './link-input.js';

// テーマの色：qmd のクラス名と、テーマが必ず持つ CSS 変数（check.py の THEME_COLORS と合わせる）
// .main・.muted は書いてあれば表示するが、メニューには出さない。マーカーは地の色（--mark）を見本にする
export const COLORS = [['accent', '--accent'], ['good', '--good'], ['warn', '--warn'], ['highlight', '--mark']];
export const COLOR_CLASSES = COLORS.map(([c]) => c);

// win：今のスライドの iframe の window を返す関数
export function makeTextFormat(win, changeAlign, remote = null) {
  const edit = () => remote ?? win()?.slideStudioEdit;
  const keep = e => { if (!e.target.closest('input')) e.preventDefault(); };
  const button = (icon, name, keys, fn, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `ibtn ${cls}`; b.innerHTML = svg(icon); b.onclick = fn;
    b.addEventListener('mousedown', keep);
    return tip(b, name, keys);
  };
  const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });

  // 大きさ：スライド上の px で出し、打ち込んでも変えられる（原稿には周りに対する em で書く）
  const size = document.createElement('input');
  size.type = 'number'; size.min = '8'; size.max = '200'; size.step = '1'; size.className = 'fmt-size';
  tip(size, S.fmt.size);
  size.addEventListener('change', () => { const v = Number(size.value); if (size.checkValidity() && v) edit()?.size(v); });
  size.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); size.dispatchEvent(new Event('change')); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); update(true); edit()?.focus(); }
  });

  // 文字の色：A を押したときだけメニューを出す
  const color = button('textColor', S.fmt.color, '', () => toggle(), 'fmt-color');
  color.setAttribute('aria-haspopup', 'true'); color.setAttribute('aria-expanded', 'false');
  color.append(Object.assign(document.createElement('i'), { className: 'fmt-ink' }));
  const menu = document.createElement('div');
  menu.className = 'fmt-menu'; menu.hidden = true; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', S.fmt.color);
  // 先頭の［本文］は色を外して元の色（--ink）に戻す
  const swatches = [['', '--ink'], ...COLORS].map(([cls, v]) => {
    const b = button('', cls ? S.fmt.colors[cls] : S.fmt.noColor, '', () => pick(cls || null), 'swatch');
    b.dataset.color = cls; b.dataset.var = v;
    return b;
  });
  const free = document.createElement('input');
  free.type = 'color'; free.hidden = true;
  free.addEventListener('change', () => pick(free.value));
  const other = button('plus', S.fmt.pick, '', () => free.click(), 'swatch more');
  const row = (...kids) => { const r = document.createElement('div'); r.className = 'fmt-row'; r.append(...kids); return r; };
  menu.append(row(...swatches, other, free));
  function pick(value) { toggle(false); edit()?.color(value); update(); }
  function toggle(open = menu.hidden) {
    menu.hidden = !open; color.setAttribute('aria-expanded', String(open));
    if (!open) return;
    // 色はスライドのテーマから取る（テーマを替えれば見本も替わる）
    const w = win(), cs = w && w.getComputedStyle(w.document.documentElement);
    for (const b of swatches) b.style.setProperty('--c', remote?.colors()[b.dataset.var] || cs?.getPropertyValue(b.dataset.var).trim() || 'transparent');
  }

  const bold = button('bold', S.fmt.bold, '⌘ B', () => { edit()?.command('bold'); update(); });
  const italic = button('italic', S.fmt.italic, '⌘ I', () => { edit()?.command('italic'); update(); });
  const smaller = button('sizeDown', S.fmt.smaller, '⌘ [', () => { edit()?.stepSize(-1); update(); });
  const larger = button('sizeUp', S.fmt.larger, '⌘ ]', () => { edit()?.stepSize(1); update(); });
  const clear = button('clearFmt', S.fmt.clear, '', () => { edit()?.clearFormat(); update(); });
  const done = button('parent', S.blockParent, 'Esc', () => edit()?.finish(), 'fmt-done');
  const sizeGroup = document.createElement('div');
  sizeGroup.className = 'tb-group'; sizeGroup.append(smaller, size, larger);
  const colorGroup = document.createElement('div');
  colorGroup.className = 'fmt-colorbox'; colorGroup.append(color, menu);
  const linkBox = document.createElement('div'); linkBox.className = 'fmt-colorbox';
  const linkMenu = document.createElement('div'); linkMenu.className = 'fmt-menu fmt-link'; linkMenu.hidden = true;
  function closeLink() { linkMenu.hidden = true; linkMenu.replaceChildren(); }
  async function openLink() {
    const state = await edit()?.linkState(); if (!state) return;
    toggle(false);
    const input = linkInput({ ...state,
      done: (url, text) => { edit()?.setLink(url, text); closeLink(); update(); },
      cancel: () => { closeLink(); edit()?.focus(); },
    });
    linkMenu.replaceChildren(input.node); linkMenu.hidden = false; input.focus();
  }
  const linkButton = button('link', S.link.name, '⌘ K', openLink);
  linkBox.append(linkButton, linkMenu);
  const shortcut = e => { if (e.detail === win()) openLink(); };
  addEventListener('slide-studio-link', shortcut);
  const align = alignButton((icon, name, fn) => button(icon, name, '', fn), 'left', value => { changeAlign?.(value); update(); });
  const styleSep = sep(), styles = [styleSep, bold, italic, linkBox], alignSep = sep();
  const nodes = [done, sep(), sizeGroup, sep(), colorGroup, ...styles, alignSep, align, sep(), clear];

  // 選んでいる文字の今の書式を出す。force：大きさの欄に打ちかけていても今の値に戻す
  function update(force = false) {
    const st = edit()?.formatState?.(); if (!st) return;
    const currentAlign = remote?.align() ?? win()?.getComputedStyle(win().document.querySelector('.slide-studio-editing')).textAlign;
    align.setAlign(currentAlign);
    if (force || document.activeElement !== size) size.value = String(st.px);
    color.querySelector('.fmt-ink').style.background = st.ink;
    for (const b of swatches) b.setAttribute('aria-pressed', String(b.dataset.color === (st.color ?? '')));
    bold.setAttribute('aria-pressed', String(st.bold)); italic.setAttribute('aria-pressed', String(st.italic));
  }
  // メニューの外を押したら閉じる
  const away = e => {
    if (!menu.hidden && !colorGroup.contains(e.target)) toggle(false);
    if (!linkMenu.hidden && !linkBox.contains(e.target)) closeLink();
  };
  addEventListener('pointerdown', away, true);
  return {
    nodes, update, openLink,
    // 表紙のタイトル・副題を直すときは、太字・斜体・リンクを出さない
    plain(on) { for (const n of styles) n.hidden = on; },
    // 表のセルの揃えは列で決まるので、セルを直している間は揃えを出さない
    cell(on) { alignSep.hidden = align.hidden = on; },
    close() { toggle(false); closeLink(); },
    destroy() { removeEventListener('pointerdown', away, true); removeEventListener('slide-studio-link', shortcut); },
  };
}
