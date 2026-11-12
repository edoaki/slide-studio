// 左の欄のタブ（下書き｜原稿｜素材｜参考資料）。下書き（memo.js）・素材（assets.js）・参考資料（materials.js）が add で自分のタブを足す。
// 原稿以外のタブを選ぶと、欄に `alt-on` と `<タブ>-on` を付けて原稿を隠す。
// 開いたときは、スライドの中身がまだ無ければ（雛形のまま。ctx.blank）下書き、あれば原稿を出す。
// 数字キー 1〜6 で切り替え、0 で欄を閉じる（番号は並び順ではなくタブに付ける）。文字を入れている欄の中では反応しない。
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';

const KEYS = { memo: '1', qmd: '2', assets: '3', materials: '4', theme: '5', bib: '6' };
const BY_CODE = Object.fromEntries(Object.entries(KEYS).map(([tab, n]) => [`Digit${n}`, tab]));

// 数字キーを受ける plugin（プレビューの中で押したキーも plugins の keydown に届く）
export function makeLeftTabs(ctx) {
  const side = leftTabs(ctx);
  return { keydown: side.keydown };
}

export function leftTabs(ctx) {
  if (ctx.leftTabs) return ctx.leftTabs;
  const panel = ctx.root.querySelector('#editor'), head = panel.querySelector('.panel-head');
  const start = ctx.blank ? 'memo' : 'qmd';
  const bar = document.createElement('div');
  bar.className = 'seg icons ptabs'; bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', S.panelTabs);
  head.prepend(bar);
  const tabs = new Map();
  let cur = null;

  // how.key：キーで切り替えた（下書きは入力欄へ移らない。続けて数字で切り替えられるように）
  function show(key, how = {}) {
    if (!tabs.has(key)) key = 'qmd';
    const prev = cur; cur = key;
    for (const [k, t] of tabs) {
      if (k !== 'qmd') panel.classList.toggle(`${k}-on`, k === key);
      t.button.setAttribute('aria-pressed', String(k === key)); t.button.setAttribute('aria-selected', String(k === key));
    }
    panel.classList.toggle('alt-on', key !== 'qmd');
    if (key !== 'qmd') ctx.qmdBlocks?.input?.blur();
    if (prev !== key) { tabs.get(prev)?.onShow?.(false, how); tabs.get(key).onShow?.(true, how); }
  }
  // 欄を閉じていれば開いてから切り替える
  function keydown(e) {
    const key = BY_CODE[e.code], closing = e.code === 'Digit0';
    if ((!closing && !tabs.has(key)) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return false;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return false;
    e.preventDefault();
    if (document.body.classList.contains('editor-off') !== closing) ctx.root.querySelector('#editorToggle')?.click();
    if (!closing) show(key, { key: true });
    return true;
  }
  // first：先頭に置く（下書き）
  function add(key, icon, name, onShow, { first = false } = {}) {
    const b = tip(document.createElement('button'), name, KEYS[key]); b.type = 'button'; b.dataset.tab = key; b.setAttribute('role', 'tab');
    b.innerHTML = svg(icon);
    if (first) bar.prepend(b); else bar.append(b);
    tabs.set(key, { button: b, onShow });
    if (key === 'qmd' || key === start) show(key);
    return b;
  }
  bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.tab); });
  add('qmd', 'slide', S.tabQmd);
  ctx.leftTabs = {
    add, show, keydown,
    // そのタブが見えているか（原稿の欄を閉じていれば見えていない）
    shown: key => cur === key && !document.body.classList.contains('editor-off'),
  };
  return ctx.leftTabs;
}
