// ボタンの説明（ツールチップ）。ボタンには文字を書かず、カーソルを合わせたとき（キーボードで移ったとき）に
// data-tip の操作名と data-keys のキー（空白区切り、1つずつ囲む）を下に出す。画面全体で1つだけ置く。
// 押せるものはすべて説明を出す：title はこのツールチップに移し、どちらも無ければ押せるものの aria-label を出す。
const DELAY = 300;
const PRESS = 'button, a[href], [role=button], [role=tab], [role=slider], [role=separator], summary, select, input[type=checkbox], input[type=radio]';
let el = null, timer = 0, owner = null;

function target(node) {
  if (node.closest?.('[data-tip-off]')) return null;
  const t = node.closest?.('[data-tip], [title]');
  if (t) {
    if (t.hasAttribute('title')) {
      // コードで付けた data-tip があればそちらを使う（title から移したものは新しい title で置き換える）
      if (t.title && (!t.dataset.tip || t.dataset.tipFromTitle)) { t.dataset.tip = t.title; t.dataset.tipFromTitle = '1'; if (!t.hasAttribute('aria-label') && !t.textContent.trim()) t.setAttribute('aria-label', t.title); }
      t.removeAttribute('title');
    }
    if (t.dataset.tip) return t;
  }
  const p = node.closest?.(PRESS);
  return p?.getAttribute('aria-label') ? p : null;
}
const nameOf = t => t.dataset.tip || t.getAttribute('aria-label');

function show(t) {
  if (!el) { el = document.createElement('div'); el.className = 'tip'; el.setAttribute('role', 'tooltip'); document.body.append(el); }
  const name = Object.assign(document.createElement('span'), { className: 'tip-name', textContent: nameOf(t) });
  const keys = (t.dataset.keys || '').split(' ').filter(Boolean).map(k => Object.assign(document.createElement('kbd'), { textContent: k }));
  el.replaceChildren(name, ...keys.length ? [Object.assign(document.createElement('span'), { className: 'tip-keys' })] : []);
  el.querySelector('.tip-keys')?.append(...keys);
  // 下に出す。入らなければ上に出し、左右は画面の中に収める
  const r = t.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  const toolbar = t.closest('.fmt-menu') ? null : t.closest('[data-tip-side]');
  const anchor = toolbar ? toolbar.getBoundingClientRect() : r;
  const below = toolbar ? toolbar.dataset.tipSide === 'below' : r.bottom + 8 + h <= innerHeight - 4;
  const y = below ? anchor.bottom + 8 : anchor.top - h - 8;
  // 選択要素側へ折り返さない。空きがなければ説明を出さず、操作面を保つ。
  if (toolbar && (y < 4 || y + h > innerHeight - 4)) { el.classList.remove('show'); return; }
  el.dataset.side = below ? 'below' : 'above';
  const x = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 4));
  el.style.left = `${x}px`; el.style.top = `${y}px`;
  el.style.setProperty('--arrow', `${r.left + r.width / 2 - x}px`);
  el.classList.add('show');
}
function hide() { clearTimeout(timer); owner = null; el?.classList.remove('show'); }
function enter(e) {
  const t = target(e.target);
  if (t === owner) return;
  hide();
  if (!t) return;
  owner = t; timer = setTimeout(() => { if (owner === t && t.isConnected) show(t); }, DELAY);
}
document.addEventListener('pointerover', enter);
document.addEventListener('focusin', e => { if (e.target.matches?.(':focus-visible')) enter(e); });
document.addEventListener('pointerout', e => { if (owner && !owner.contains(e.relatedTarget)) hide(); });
document.addEventListener('focusout', hide);
document.addEventListener('pointerdown', hide, true);
addEventListener('blur', hide);

// ボタンに説明を付ける。keys は '⌘ B' のように空白で区切る
export function tip(node, name, keys = '') {
  node.dataset.tip = name; node.setAttribute('aria-label', name); delete node.dataset.tipFromTitle;
  if (keys) node.dataset.keys = keys; else delete node.dataset.keys;
  node.removeAttribute('title');
  if (owner === node && el?.classList.contains('show')) show(node);
  return node;
}
