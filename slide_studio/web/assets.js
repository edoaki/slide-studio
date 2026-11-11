// 素材（左の欄の［素材］タブ）。元：ai-slide mock/gui/assets.js。
// 画像（topics/<トピック>/images/）と HTML を分けて、縮小表示・名前・状態を並べる。
// 挿入可否と使用中を文字で示す。理由・使っているページはカーソルを合わせたときに出す。
// カードを持ってスライド（またはページの帯）へ動かすと、落とした所に入れる。線はブロックを動かすときと同じ（block-drag.js）。
// 追加は末尾の点線のタイル・ドロップ・貼り付け（insert.js）。
// 押すと拡大プレビュー。専用ボタンで削除の選択を始める（⇧ で範囲、⌘A ですべて）。Delete／⌫ か上の帯のごみ箱で消す
// （.slide-studio/trash/ へ移し、取り消しで戻す）。
import { api, locationHeaders, esc, onEvent, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';
import { assetPreview, longPress } from './asset-preview.js';
import { leftTabs } from './left-tabs.js';

const A = S.as;
const THUMB_W = 960; // 図の縮小表示の元の幅（16:9）
const START = 4; // 持つまでに動かす距離（px）

export function makeAssets(ctx) {
  const deck = encodeURIComponent(ctx.deck), panel = ctx.root.querySelector('#editor'), head = panel.querySelector('.panel-head'), side = leftTabs(ctx);
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('slide-studio.' + k); localStorage.setItem('slide-studio.' + k, v); } catch { /* 保存できなくても動く */ } return null; };
  let data = null, loading = null, kind = pref('assetKind') === 'images' ? 'images' : 'html', dead = false, timer = 0;
  const chosen = new Set(); // 選んでいる素材の path（いま見ている種類の中だけ）
  let anchor = null, dialog = null, previewDialog = null, selecting = false;

  // ------------------------------------------------------------ 左の欄の［素材］タブと種類（HTML｜画像）
  const kinds = document.createElement('div');
  kinds.className = 'seg as-kinds'; kinds.setAttribute('role', 'tablist'); kinds.setAttribute('aria-label', A.kinds);
  for (const [k, icon] of [['html', 'fileCode'], ['images', 'image']]) {
    const b = tip(document.createElement('button'), A[k]); b.type = 'button'; b.dataset.kind = k;
    b.innerHTML = `${svg(icon)}<span class="n"></span>`;
    kinds.append(b);
  }
  head.after(kinds);
  kinds.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { if (kind !== b.dataset.kind) { chosen.clear(); anchor = null; selecting = false; } kind = b.dataset.kind; pref('assetKind', kind); render(); } });
  const view = document.createElement('div');
  view.className = 'assets'; view.id = 'assetsView'; view.setAttribute('role', 'tabpanel'); view.setAttribute('aria-label', S.tabAssets);
  panel.querySelector('#qscroll').after(view);
  const shown = () => side.shown('assets');
  // 上の帯：すべて選ぶ・選んでいる数・削除・選ぶのをやめる
  const bar = document.createElement('div'); bar.className = 'as-bar';
  const button = (act, icon, label) => { const b = tip(document.createElement('button'), label); b.type = 'button'; b.className = 'ibtn'; b.dataset.act = act; b.innerHTML = svg(icon); return b; };
  const allBtn = button('all', 'circleCheck', A.selectAll), count = Object.assign(document.createElement('span'), { className: 'as-count' });
  const delBtn = button('delete', 'trash', A.removeChosen), noneBtn = button('none', 'x', A.selectNone);
  delBtn.dataset.keys = 'Delete ⌫'; noneBtn.dataset.keys = 'Esc'; allBtn.dataset.keys = '⌘A';
  const selectBtn = button('select', 'circleCheck', A.startSelection);
  selectBtn.className = 'btn'; selectBtn.append(Object.assign(document.createElement('span'), { textContent: A.startSelection }));
  bar.append(selectBtn, allBtn, count, delBtn, noneBtn);

  // ------------------------------------------------------------ 一覧
  // 取り直す間も前の一覧は残す（空にすると、その間に押した操作が何もしない）。取り直し中に頼まれたら、終わってからもう一度取る
  let again = false;
  async function refresh() {
    if (loading) { again = true; return loading; }
    loading = (async () => {
      do {
        again = false;
        try { data = await api(`/api/deck/${deck}/assets`); } catch (e) { if (!data) toast(`${A.listError}：${e.message}`); }
      } while (again && !dead);
      loading = null;
      if (!dead) render();
      return data;
    })();
    return loading;
  }
  // 使っているページの番号。原稿は打つたびに変わるので、画面で数える
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function usedPages(item) {
    const re = item.kind === 'image' ? new RegExp(`\\]\\(<?${reEsc(item.path)}[\\s)>]`) : item.ref ? new RegExp(`\\{\\{<\\s*fig\\s+"?${reEsc(item.ref)}["\\s>]`) : null;
    if (!re) return [];
    return ctx.text.split(/^#{1,2}[ \t]+\S.*$/m).slice(1).flatMap((p, i) => re.test(p) ? [i + 1] : []);
  }

  // 縮小表示。図は押せない iframe を縮めて見せる（形式でない HTML は scripts だけ許した別の生まれにする）
  function thumb(item) {
    const t = document.createElement('div'); t.className = 'as-thumb';
    if (item.kind === 'image') {
      const img = document.createElement('img'); img.src = item.url; img.alt = ''; img.loading = 'lazy'; img.draggable = false;
      t.append(img);
    } else if (item.url) {
      const f = document.createElement('iframe');
      if (item.kind === 'html') f.sandbox = 'allow-scripts';
      f.src = item.url; f.tabIndex = -1; f.loading = 'lazy'; f.title = item.name; f.setAttribute('aria-hidden', 'true');
      t.append(f);
      fit.observe(t);
    } else t.innerHTML = svg('fileCode');
    return t;
  }
  const fit = new ResizeObserver(es => { for (const e of es) e.target.style.setProperty('--s', e.contentRect.width / THUMB_W); });
  // 挿入可否と使用状況は、色だけに頼らず別々のラベルで示す。
  function mark(node, item) {
    const pages = usedPages(item);
    node.classList.toggle('fits', item.kind !== 'image' && item.status !== 'ng');
    node.classList.toggle('ng', item.status === 'ng');
    node.classList.toggle('used', pages.length > 0);
    let status = node.querySelector('.as-status');
    if (!status) { status = document.createElement('div'); status.className = 'as-status'; node.append(status); }
    const available = item.status !== 'ng';
    const ready = document.createElement('span'); ready.className = available ? 'as-ready' : 'as-unavailable';
    ready.textContent = available ? A.insertable : A.unavailable;
    status.replaceChildren(ready);
    if (pages.length) {
      const used = document.createElement('span'); used.className = 'as-used'; used.textContent = A.inUse;
      status.append(used);
    }
    const place = item.kind === 'image' ? null : A.place[item.place];
    const where = typeof place === 'function' ? place(data?.shelf || '') : place;
    const lines = [item.kind === 'figure' && item.title !== item.name ? item.title : null, where, ...item.reasons || [], pages.length ? A.used(pages) : null];
    node.dataset.tip = lines.filter(Boolean).join(' / ') || (item.path || item.ref);
    return node;
  }
  function card(item) {
    const c = document.createElement('div');
    c.className = 'as-card'; c.tabIndex = 0; c.setAttribute('role', 'option');
    const pick = tip(document.createElement('button'), A.pick); pick.type = 'button'; pick.className = 'ibtn as-pick'; pick.innerHTML = svg('check');
    c.append(thumb(item), Object.assign(document.createElement('span'), { className: 'nm', textContent: item.name }), pick);
    if (item.status === 'ng' && item.kind === 'html') {
      const ai = tip(document.createElement('button'), A.toFigure); ai.type = 'button'; ai.className = 'ibtn as-ai'; ai.innerHTML = svg('sparkles');
      c.append(ai);
    }
    c._item = item;
    return mark(c, item);
  }
  function render() {
    if (dead) return;
    const imgs = data?.images || [], html = data?.html || [];
    kinds.querySelectorAll('button').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
      b.querySelector('.n').textContent = data ? (b.dataset.kind === 'images' ? imgs.length : html.length) : '';
    });
    if (!shown()) return;
    const keep = view.scrollTop;
    const g = document.createElement('div'); g.className = 'as-grid';
    // HTML は トピックの図 → 図の形式でない の順（区切りは線だけ）
    const items = listed();
    for (const k of [...chosen]) if (!items.some(x => x.path === k)) chosen.delete(k);
    g.setAttribute('role', 'listbox'); g.setAttribute('aria-multiselectable', 'true'); g.setAttribute('aria-label', A.list);
    items.forEach((item, i) => {
      if (i && item.place && item.place !== items[i - 1].place) g.append(Object.assign(document.createElement('hr'), { className: 'as-sep' }));
      g.append(card(item));
    });
    const add = tip(document.createElement('button'), A.add); add.type = 'button'; add.className = 'as-add'; add.innerHTML = svg('upload');
    if (kind === 'images') g.append(add);
    view.replaceChildren(...items.length ? [bar] : [], g);
    view.scrollTop = keep;
    paint();
  }
  const listed = () => kind === 'images' ? data?.images || [] : ['shelf', 'file'].flatMap(p => (data?.html || []).filter(x => x.place === p));

  // ------------------------------------------------------------ 選ぶ
  // 縮小表示を作り直さずに、印だけ付け替える（iframe を読み直さない）
  function paint() {
    const cards = [...view.querySelectorAll('.as-card')];
    for (const c of cards) {
      const on = chosen.has(c._item.path);
      c.classList.toggle('sel', on); c.setAttribute('aria-selected', String(on));
      c.querySelector('.as-pick').setAttribute('aria-pressed', String(on));
    }
    const all = cards.length > 0 && chosen.size === cards.length;
    view.classList.toggle('choosing', selecting);
    selectBtn.hidden = selecting;
    allBtn.hidden = noneBtn.hidden = !selecting;
    allBtn.setAttribute('aria-pressed', String(all)); allBtn.dataset.tip = all ? A.selectNone : A.selectAll;
    count.textContent = chosen.size ? A.chosen(chosen.size) : '';
    delBtn.hidden = !selecting; delBtn.disabled = !chosen.size;
    for (const c of cards) c.querySelector('.as-pick').hidden = !selecting;
  }
  function choose(c, e = {}) {
    const key = c._item.path, keys = listed().map(x => x.path);
    if (e.shiftKey && anchor && keys.includes(anchor)) {
      const [a, b] = [keys.indexOf(anchor), keys.indexOf(key)].sort((x, y) => x - y);
      if (!e.metaKey && !e.ctrlKey) chosen.clear();
      keys.slice(a, b + 1).forEach(k => chosen.add(k));
    } else if (e.metaKey || e.ctrlKey || e.toggle) {
      chosen.has(key) ? chosen.delete(key) : chosen.add(key);
      anchor = key;
    } else {
      chosen.clear(); chosen.add(key); anchor = key;
    }
    paint();
  }
  function chooseAll(on = chosen.size < listed().length) {
    chosen.clear();
    if (on) listed().forEach(x => chosen.add(x.path));
    anchor = null; paint();
  }

  // ------------------------------------------------------------ 拡大プレビュー
  function showPreview(card) {
    previewDialog?.close();
    previewDialog = assetPreview(card._item, card);
  }

  function stopSelecting() { selecting = false; chooseAll(false); selectBtn.focus(); }

  // ------------------------------------------------------------ 消す
  const rawOp = (name, body) => api(`/api/deck/${deck}/assets/${name}`, { method: 'POST', body });
  const reload = () => refresh();
  function confirmRemove(items) {
    return new Promise(resolve => {
      dialog?.remove();
      dialog = document.createElement('div'); dialog.className = 'dialog-back';
      dialog.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(A.removeTitle)}">
        <div class="dh"><h3>${esc(A.removeTitle)}</h3></div><div class="chat-dialog-body"></div>
        <div class="df"><button class="btn" data-a="no">${S.cancel}</button><button class="btn primary" data-a="yes">${esc(A.remove)}</button></div></div>`;
      const body = dialog.querySelector('.chat-dialog-body');
      const line = (text, className = '') => body.append(Object.assign(document.createElement('p'), { textContent: text, className }));
      line(A.removeText(items.map(x => x.name)));
      const pages = [...new Set(items.flatMap(usedPages))].sort((a, b) => a - b);
      if (pages.length) line(A.removeUsed(pages), 'as-warn');
      const others = [...new Set(items.flatMap(x => x.others || []))];
      if (others.length) line(A.removeOthers(others), 'as-warn');
      line(A.removeHint, 'mt-hint');
      document.body.append(dialog);
      const done = v => { dialog?.remove(); dialog = null; resolve(v); };
      dialog.onclick = e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) done(a === 'yes'); else if (e.target === dialog) done(false); };
      dialog.onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape') done(false); };
      dialog.querySelector('[data-a=yes]').focus();
    });
  }
  async function removeChosen() {
    const items = listed().filter(x => chosen.has(x.path));
    if (!items.length) return;
    const ok = await confirmRemove(items);
    if (ok) {
      try {
        let { items: trashed } = await rawOp('delete', { paths: items.map(x => x.path) });
        ctx.recordHistory({
          undo: async () => { await rawOp('restore', { items: trashed }); await reload(); },
          redo: async () => { ({ items: trashed } = await rawOp('delete', { paths: trashed.map(t => t.path) })); await reload(); },
        });
        chosen.clear(); anchor = null; selecting = false;
        toast(A.removed(items.length));
      } catch (e) { toast(e.message); }
      await reload();
    }
    (view.querySelector('.as-card.sel') || view).focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ 追加
  async function upload(file) {
    const r = await fetch(`/api/deck/${deck}/assets?name=${encodeURIComponent(file.name || '')}`, {
      method: 'POST', headers: { ...locationHeaders(), 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `${r.status}`);
    return out;
  }
  async function addFiles(files) {
    let added = 0, reused = 0, last = null;
    for (const f of files) {
      try { const r = await upload(f); r.reused ? reused++ : added++; last = r.kind; } catch (e) { toast(e.message); }
    }
    if (last && last !== kind) { kind = last; pref('assetKind', kind); }
    await refresh();
    if (added) toast(A.added(added)); else if (reused) toast(A.reused);
  }
  function askAi(item) {
    const chat = ctx.plugins.find(p => p.draft);
    const name = item.name.replace(/\.html?$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'figure';
    if (chat?.draft(A.toFigureText(`topics/${data.shelf}/${item.path}`, name))) toast(A.drafted);
  }
  view.tabIndex = -1;
  view.addEventListener('click', e => {
    if (e.target.closest('.as-add')) { ctx.insert?.pickFiles('image/*').then(fs => fs.length && addFiles(fs)); return; }
    const ai = e.target.closest('.as-ai');
    if (ai) { askAi(ai.closest('.as-card')._item); return; }
    const act = e.target.closest('.as-bar [data-act]')?.dataset.act;
    if (act) { if (act === 'select') { selecting = true; paint(); noneBtn.focus(); } else if (act === 'all') chooseAll(); else if (act === 'none') stopSelecting(); else removeChosen(); return; }
    const c = e.target.closest('.as-card');
    if (dragged) { dragged = false; return; }
    if (c) { if (selecting) choose(c, { toggle: true, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey }); else showPreview(c); }
    else if (!e.target.closest('.as-bar') && chosen.size) chooseAll(false);
  });
  view.addEventListener('keydown', e => {
    if (e.target.closest('.as-bar') && e.key !== 'Escape') return;
    const c = e.target.closest('.as-card'), mod = e.metaKey || e.ctrlKey;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') { handled(); if (selecting) chooseAll(true); return; }
    // 素材で押した Delete／⌫ はスライドへ渡さない（ブロックを消さない）
    if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) { handled(); if (selecting) removeChosen(); return; }
    if (e.key === 'Escape' && selecting) { handled(); stopSelecting(); return; }
    if (c && e.target === c && (e.key === 'Enter' || e.key === ' ')) { handled(); if (selecting) choose(c, { toggle: true, shiftKey: e.shiftKey }); else showPreview(c); }
  });
  view.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); view.classList.add('dropping'); } });
  view.addEventListener('dragleave', e => { if (!view.contains(e.relatedTarget)) view.classList.remove('dropping'); });
  view.addEventListener('drop', e => { e.preventDefault(); view.classList.remove('dropping'); addFiles([...e.dataTransfer.files]); });

  const stopHold = longPress(view, '.as-card', () => !selecting, c => {
    end(false); selecting = true; choose(c); c.focus({ preventScroll: true });
  });

  // ------------------------------------------------------------ 持って動かす（スライド・ページの帯へ）
  let press = null, drag = null, dragged = false;
  view.addEventListener('pointerdown', e => {
    const c = e.target.closest('.as-card');
    if (selecting || e.button || !c || e.target.closest('button') || c.classList.contains('ng')) return;
    e.preventDefault(); c.focus({ preventScroll: true });
    press = { card: c, x: e.clientX, y: e.clientY, id: e.pointerId };
    c.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', e => {
    if (!press) return;
    if (!drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < START) return;
      const ghost = press.card.querySelector('.as-thumb').cloneNode(true);
      ghost.className = 'as-ghost'; ghost.querySelector('iframe')?.remove();
      if (press.card._item.kind !== 'image') ghost.innerHTML = svg('fileCode');
      document.body.append(ghost);
      drag = { item: press.card._item, ghost, target: null };
      press.card.classList.add('dragging'); document.body.classList.add('as-dragging');
    }
    drag.ghost.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
    drag.target = ctx.blocks?.dropAt(e.clientX, e.clientY) ?? null;
  });
  function end(ok) {
    const d = drag, p = press; drag = null; press = null;
    if (!d) return;
    dragged = true; setTimeout(() => { dragged = false; });
    d.ghost.remove(); p.card.classList.remove('dragging'); document.body.classList.remove('as-dragging');
    ctx.blocks?.dropClear();
    if (ok && d.target) ctx.insert?.dropItem(d.item, d.target);
  }
  view.addEventListener('pointerup', () => end(true));
  view.addEventListener('pointercancel', () => end(false));
  const escape = e => { if (drag && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } };
  addEventListener('keydown', escape, true);

  // 素材のフォルダが変わったら取り直す
  const off = onEvent(ev => {
    if (ev.type !== 'files') return;
    const mine = data?.shelf ? [`topics/${data.shelf}/`] : [];
    if (!ev.paths.some(p => mine.some(m => p.startsWith(m)))) return;
    clearTimeout(timer); timer = setTimeout(refresh, 200);
  });

  ctx.assets = {
    list: async () => data || await refresh(), refresh: () => refresh(),
    upload, thumb, mark,
  };
  side.add('assets', 'images', S.tabAssets, on => { if (on) { render(); refresh(); } });
  refresh();
  return {
    textChanged() {
      if (!shown()) return;
      clearTimeout(timer); timer = setTimeout(() => { for (const c of view.querySelectorAll('.as-card')) mark(c, c._item); }, 300);
    },
    destroy() { dead = true; stopHold(); previewDialog?.close(); dialog?.remove(); off(); fit.disconnect(); clearTimeout(timer); removeEventListener('keydown', escape, true); end(false); },
  };
}
