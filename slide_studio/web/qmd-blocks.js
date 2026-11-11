// 原稿のブロック表示（元：ai-slide mock/gui/index.html「原稿（qmd）のブロック表示」）。
// ブロックは原文のチャンク。左の線（rail）を押すと選び、ドラッグで移す。選んだブロックの右上のツールバーで
// 下に分割・右に分割・列の幅・削除。文字はカードを押して直接書く。書き換えは対象の範囲だけ（block-ops.js）。
// 選択はスライドと共有する（blocks.js の ctx.blocks）。
import { api, toast } from './api.js';
import { qInline } from './qmd-editor.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import * as op from './block-ops.js';
import { kindTone } from './block-nav.js';
import { structureOf } from './structure.js';
import { pureMath } from './insert.js';
import { captureScroll, restoreScroll } from './scroll-anchor.js';
import { choosePageTemplate, isPlaceholder } from './page-templates.js';
import { tip } from './tip.js';
import { figureSteps, stepLabel } from './step-badge.js';
import { makeCoverForm, ownsChunk } from './cover-form.js';

const qLayer = d => d <= 1 ? 'var(--l1)' : d === 2 ? 'var(--l2)' : 'var(--l3)';
const div = (cls, text) => { const e = document.createElement('div'); e.className = cls; if (text != null) e.textContent = text; return e; };

export function makeQmdBlocks(ctx) {
  const host = ctx.root.querySelector('#qblocks'), scroller = ctx.root.querySelector('#qscroll');
  host.innerHTML = `<div class="qpages"></div><div class="qov"></div>
    <div class="qtb" role="toolbar" aria-label="${S.blockTools}">
      <button class="tb-btn" type="button" data-act="below"></button>
      <button class="tb-btn" type="button" data-act="right"></button>
      <span class="tb-sep"></span>
      <button class="tb-btn" type="button" data-act="ratio" aria-expanded="false"></button>
      <button class="tb-btn" type="button" data-act="delete"></button>
      <div class="rpop" hidden><div class="rtrack"></div></div>
    </div>`;
  const pagesEl = host.querySelector('.qpages'), ov = host.querySelector('.qov'), qtb = host.querySelector('.qtb');
  const rpop = qtb.querySelector('.rpop'), rtrack = qtb.querySelector('.rtrack'), ratioBtn = qtb.querySelector('[data-act="ratio"]');
  const TB = { below: ['splitV', S.qb.below, '⌘Enter'], right: ['splitH', S.qb.right, '⇧⌘Enter'], ratio: ['ratio', S.qb.ratio], delete: ['trash', S.qb.remove, 'Delete'] };
  for (const [act, [icon, label, keys]] of Object.entries(TB)) {
    const b = qtb.querySelector(`[data-act="${act}"]`);
    b.innerHTML = svg(icon); b.setAttribute('aria-label', label); b.title = keys ? `${label}（${keys}）` : label;
  }

  let source = '', st = null, ticket = 0, dead = false, lastCaret = null;
  let closeTemplate = null;
  let session = null; // 入力中の欄 { ta, start, end, end0（開いたときの end）, owner, pending, heading }
  let pending = null; // 文字を入れる前の空のブロック（block-ops の pendingBelow）
  let preview = null; // ツールバーに乗せている間の予告 { pending } | { remove } | { st }
  let hover = null, slideHover = null, press = null, drag = null, ratio = null, focusAfter = null, goPage = null, shownPage = null;
  const folded = new Set(); let currentOnly = false, openCount = 0;
  let drawnText = '';
  const scrollEntries = () => [...pagesEl.querySelectorAll('.card[data-start], .heading[data-start]')].map(el => ({ el, pos: +el.dataset.start }));
  const info = new WeakMap(); // カード → { start, end, owner, pending }
  const cur = () => ctx.editor.page;
  const sel = () => ctx.blocks?.selected ?? null;
  const boxOf = key => key && pagesEl.querySelector(`.page.cur .box[data-key="${CSS.escape(key)}"]`);
  const rel = el => { const r = el.getBoundingClientRect(), b = host.getBoundingClientRect(); return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height }; };

  // ブロック表示から原稿を書く間は、スライド側の選択解除（blocks.js の textChanged）で表示を崩さない
  let writing = false;
  function write(text, opts, key) {
    writing = true;
    try { ctx.setText(text, opts); if (opts?.typing) ctx.editor.setText(ctx.text, { caret: opts.caret }); ctx.blocks?.select(key ?? null); }
    finally { writing = false; }
    chrome();
  }
  // 表紙のページは入力欄にする（cover-form.js）。入力中は描き直さない
  const cover = makeCoverForm(ctx, {
    write: (text, typing) => write(text, typing ? { typing: true } : {}, sel()),
    // 目次の設定へ移るときは描き直さない（押している途中で DOM から外すとクリックが失われる）
    leave: next => { if (!next?.closest('.toc-settings')) draw(); },
  });
  const isCover = p => p.classes?.includes('cover') && !p.raw_only;
  // ------------------------------------------------------------ 選択
  function select(key, { rail = false } = {}) {
    ctx.blocks?.select(key);
    chrome();
    if (rail && key) boxOf(key)?.querySelector(':scope > .rail')?.focus({ preventScroll: true });
  }
  // 原稿を変える。ctx.setText が履歴に積み、保存して変換する
  function commit(text, { select: key, focus } = {}) {
    if (ctx.locked) { toast(S.locked); return false; }
    if (text == null || text === ctx.text) return false;
    session = null; pending = null; preview = null; closeRatio();
    focusAfter = focus || (key ? { rail: key } : null);
    write(text, {}, key);
    return true;
  }
  function goTo(page) {
    if (page === cur()) return;
    ctx.editor.page = page;
    const i = ctx.preview.slideOfPage(page);
    if (i >= 0) ctx.preview.go(i, 0);
    draw();
  }

  // ------------------------------------------------------------ 描画
  function pathLabel(c) {
    const out = [];
    for (let x = c; x; x = x.parent) {
      const sibs = x.parent ? x.parent.children : st.pages[x.page].chunks;
      out.unshift((x.parent?.kind === 'columns' ? S.qb.col : S.qb.row)(sibs.indexOf(x) + 1));
    }
    return out.join(' › ');
  }
  function display(t, chunks) {
    chunks.forEach((c, k) => {
      if (k) t.append(document.createTextNode('\n\n'));
      const raw = source.slice(c.start, c.end);
      if (c.kind === 'fig' || c.kind === 'image') {
        const chip = document.createElement('span'); chip.className = 'chip';
        const image = raw.match(/!\[([^\]]*)\]\(([^)]*)\)/);
        chip.innerHTML = svg(c.kind === 'image' ? 'image' : 'shapes');
        if (c.kind === 'fig') chip.dataset.fig = raw.match(/fig\s+"?([^\s">]+)/)?.[1] || '';
        chip.append(Object.assign(document.createElement('span'), { textContent: raw.match(/fig\s+"?([^\s">]+)/)?.[1] || image?.[1] || image?.[2] || raw }));
        t.append(chip);
      } else if (c.kind === 'text' && pureMath(raw) != null) {
        // 数式（$$ だけのブロック）は図・画像と同じく札にして、書き始めの所だけを見せる。押すと数式の画面で直す
        const chip = document.createElement('span'); chip.className = 'chip math';
        chip.innerHTML = svg('sigma');
        chip.append(Object.assign(document.createElement('span'), { textContent: pureMath(raw).replace(/\s+/g, ' ') }));
        t.append(chip);
      } else if (c.kind === 'opaque' && rawDiv(raw)) {
        // 名前の付いた囲み（::: {.cover-title} など）は、記法の代わりに名前の札と中の文を見せる。押すと原文で直す
        const d = rawDiv(raw), chip = document.createElement('span'); chip.className = 'chip div';
        chip.textContent = d.name;
        const s = document.createElement('span'); s.innerHTML = d.body.split('\n').map(l => qInline(l)).join('\n');
        t.append(chip, s);
      } else if (c.kind === 'opaque' || c.kind === 'def') t.append(Object.assign(document.createElement('span'), { className: 'raw-text', textContent: raw }));
      else { const s = document.createElement('span'); s.innerHTML = raw.split('\n').map(l => qInline(l)).join('\n'); t.append(s); }
    });
  }
  // 原文の囲み1つ（::: {.名前} … :::）なら { name: 表示名, body: 中の文 }
  function rawDiv(raw) {
    const m = raw.match(/^(:{3,})\s*\{\.([\w-]+)[^}]*\}\s*\n([\s\S]*?)\n\1\s*$/);
    if (!m || /^:{3,}/m.test(m[3])) return null;
    return { name: S.qb.divNames[m[2]] || m[2], body: m[3] };
  }
  function card(chunks, owner, dormant) {
    const el = div('card'), t = div('text');
    display(t, chunks);
    el.append(t);
    if (!dormant && chunks.some(c => c.kind === 'opaque')) el.dataset.tip = S.qb.rawCard;
    el.dataset.start = chunks[0].start; el.dataset.end = chunks.at(-1).end; el.dataset.owner = owner || '';
    el.dataset.keys = chunks.map(c => c.key).join(' ');
    // 図・HTML・画像は枠をスライドの枠と同じ種類の色にする（列に1つだけのときは線が無いので）
    const tone = chunks.length === 1 && kindTone(chunks[0], source);
    if (tone) { el.dataset.tone = tone; el.style.setProperty('--lc', `var(--l-${tone})`); }
    const one = chunks.length === 1 && chunks[0].kind === 'text';
    info.set(el, { start: chunks[0].start, end: chunks.at(-1).end, owner, text: one,
      math: one && chunks[0].key && pureMath(source.slice(chunks[0].start, chunks[0].end)) != null ? chunks[0].key : null });
    if (dormant) el.classList.add('inert');
    return el;
  }
  function emptyCard(p, owner, ghost) {
    const el = div('card empty'), t = div('text');
    if (!ghost) t.dataset.ph = S.qb.emptyPage;
    el.append(t);
    if (!ghost) info.set(el, { pending: p, owner });
    if (p && !ghost) el.dataset.tip = S.qb.emptyPageTip;
    return el;
  }
  const gap = () => div('gap');
  // 段階表示の印（スライドの印と同じ形）。段を付けていないものは null
  function stepBadge(c) {
    let k, last;
    if (c.kind === 'fig' || c.kind === 'image' || (c.kind === 'text' && op.outer(c) !== c)) {
      const s = op.stepState(source, c);
      if (!s.step && !s.incremental && c.kind !== 'fig') return null;
      k = s.step; last = s.incremental ? s.step + s.count - 1 : k;
    } else if (op.isBox(c) && (c.attrs?.kv?.['data-step'] != null || c.attrs?.classes?.includes('incremental'))) {
      k = Number(c.attrs.kv?.['data-step'] ?? 1) || 0; last = k;
    } else return null;
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'step-badge';
    Object.assign(b.dataset, { key: c.key, step: k, last, figure: c.kind === 'fig' ? '1' : '' });
    b.onpointerdown = e => { e.preventDefault(); e.stopPropagation(); };
    b.onclick = e => { e.stopPropagation(); const p = +b.closest('.page').dataset.page; if (p !== cur()) goTo(p); ctx.blocks?.openStepMenu(c.key); };
    return b;
  }
  function updateStepBadges() {
    const w = ctx.preview.win;
    for (const b of pagesEl.querySelectorAll('.step-badge')) {
      const elements = w?.slideStudioEdit?.elements(b.dataset.key) || [];
      const k = b.dataset.figure ? Number(elements[0]?.closest('[data-step]')?.dataset.step || b.dataset.step) : +b.dataset.step;
      const n = figureSteps(elements);
      b.hidden = !k && !n;
      const i = ctx.preview.slideOfPage(+b.closest('.page').dataset.page);
      const first = w?.deck?.stageNumber(k, i) ?? k + 1;
      const last = n ? first + n : w?.deck?.stageNumber(+b.dataset.last, i) ?? +b.dataset.last + 1;
      const pending = !!b.closest('.page.cur') && k > (w?.deck?.stageAt() ?? 0);
      b.dataset.range = String(last > first);
      b.textContent = stepLabel(first, last);
      b.classList.toggle('pending', pending);
      tip(b, S.qb.stepBadge(k, +b.dataset.last, n, pending));
    }
  }
  function cmap(cols, i) {
    const m = document.createElement('span'); m.className = 'cmap';
    const r = op.ratios(cols), W = Math.min(24, cols.children.length * 6);
    r.forEach((v, k) => { const c = document.createElement('i'); if (k === i) c.className = 'on'; c.style.width = `${Math.max(3, Math.round(W * v / 100))}px`; m.append(c); });
    return m;
  }
  function box(c, depth, { virtual = false, inRow = null, index = 0, dormant = false, ghost = false } = {}) {
    const b = div(`box${virtual ? ' virtual' : ''}${inRow ? ' col' : ''}${ghost ? ' ghost' : ''}`);
    b.style.setProperty('--lc', ghost ? 'var(--primary)' : kindTone(c, source) ? `var(--l-${kindTone(c, source)})` : qLayer(depth));
    const rail = div('rail');
    if (c && !dormant && c.kind !== 'def') {
      b.dataset.key = c.key; rail.dataset.key = c.key; rail.tabIndex = 0;
      rail.setAttribute('role', 'button'); rail.setAttribute('aria-label', pathLabel(c));
      rail.title = virtual ? S.qb.railVirtual : S.qb.rail;
      if (preview?.remove === c.key) b.classList.add('deleting');
      if (preview?.nu === c.key) b.classList.add('ghost');
      if (drag?.key === c.key) b.classList.add('drag-src');
    }
    if (inRow) rail.append(cmap(inRow, index));
    rail.insertAdjacentHTML('beforeend', `<span class="line"></span><span class="grip">${svg('grip')}</span>`);
    const content = div('content');
    if (!c) content.append(emptyCard(pending, pending?.owner, ghost));
    else if (virtual) content.append(card([c], c.key, dormant));
    else fill(content, c, c.children, depth, null, dormant);
    b.append(rail, content);
    const badge = c && !ghost && stepBadge(c);
    if (badge) {
      // 中身がカード1枚ならカードの右上に、囲みなら中身の先頭に置く
      const first = content.firstElementChild;
      if (first?.classList.contains('card') && content.children.length === 1) first.prepend(badge); else content.prepend(badge);
    }
    return b;
  }
  // 箱は中身が1つでも親子を表示し、枠の内外それぞれへ移動できるようにする。
  function fill(el, owner, kids, depth, page, dormant) {
    const root = !owner, row = owner?.kind === 'columns', pend = dormant ? null : preview?.pending || pending;
    const here = pend && (pend.owner ?? null) === (owner?.key ?? null) && (root ? pend.page === page.index : true);
    if (root && page.level === 1 && !kids.length && !here) return; // 章扉は見出しだけで足りるので、空の本文欄を出さない
    if (!root && !row && owner.kind !== 'box' && kids.length === 1 && !op.isBox(op.inner(kids[0])) && !here) { el.append(card([op.inner(kids[0])], owner.key, dormant)); return; }
    kids.forEach((c, k) => {
      c = op.inner(c);
      if (root) el.append(gap());
      else if (k) { if (row) { const d = div('gap divider'); d.style.setProperty('--lc', qLayer(depth + 1)); el.append(d); } else el.append(gap()); }
      el.append(op.isBox(c) ? box(c, depth + 1, { inRow: row ? owner : null, index: k, dormant }) : box(c, depth + 1, { virtual: true, dormant }));
      if (here && (pend.after === c.key || pend.after === op.outer(c).key)) el.append(gap(), box(null, depth + 1, { virtual: true, ghost: !!preview?.pending }));
    });
    if (!kids.length) el.append(...root ? [gap()] : [], emptyCard(dormant ? null : owner ? op.pendingEmpty(owner) : op.pendingPage(page), owner?.key ?? null));
    if (root) el.append(gap());
  }
  function summary(p) {
    const words = cs => cs.flatMap(c => c.children.length ? words(c.children) : [source.slice(c.start, c.end)]);
    return words(p.chunks).map(w => w.replace(/^#+\s+|^[-*+]\s+|^\d+\.\s+/gm, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
  }
  // 目次の行。自動生成なので番号・名前と設定だけを出す。OFF（p が無いときも）はスライドが無いので番号を出さず、移動もしない
  function tocRow(p, number) {
    const off = !p || p.classes.includes('toc-off'), isCur = !off && p.index === cur();
    const el = div(`page folded toc-page${off ? ' off' : isCur ? ' cur' : ' dormant'}`);
    if (!off) el.dataset.page = p.index;
    if (!off && !isCur) el.dataset.tip = S.qb.gotoPage;
    const num = document.createElement('button');
    num.type = 'button'; num.className = 'page-num'; num.disabled = off || isCur;
    num.innerHTML = `<span class="n">${off ? '–' : number}</span>`;
    if (!off && !isCur) { num.setAttribute('aria-label', `${number}：${S.qb.gotoPage}`); num.onclick = () => goTo(p.index); }
    el.append(num, div('heading', S.toc.title), ctx.tocSettings.el);
    return el;
  }
  function draw() {
    if (!st || session || dead || cover.active) return;
    shownPage = cur();
    const view = preview?.st || st;
    const anchor = host.hidden ? null : captureScroll(scroller, scrollEntries(), drawnText, source);
    const onRail = !!document.activeElement?.closest?.('#qblocks .rail');
    const content = document.createDocumentFragment();
    // 目次の囲みがまだ無ければ、ONにしたときに入る位置（表紙の直後）に行を出す
    const noToc = ctx.tocSettings && !view.pages.some(p => p.generated === 'toc'), firstCover = view.pages.find(isCover);
    if (noToc && !firstCover) content.append(tocRow(null));
    let number = 0; // 表示する番号。OFF の目次はスライドにならないので数えない
    view.pages.forEach((p, i) => {
      if (p.generated !== 'toc' || !p.classes.includes('toc-off')) number++;
      const renderedIndex = ctx.preview?.slideOfPage(p.index);
      if (renderedIndex >= 0) number = renderedIndex + 1;
      if (p.generated === 'toc') { if (ctx.tocSettings) content.append(tocRow(p, number)); return; }
      if (op.canAddPage(view, i)) content.append(addRow(i, i > 0));
      const isCur = p.index === cur(), closed = currentOnly ? !isCur : folded.has(p.index);
      const el = div(`page${isCur ? ' cur' : ' dormant'}${closed ? ' folded' : ''}${p.level === 1 ? ' chapter' : ''}`);
      el.dataset.page = p.index;
      if (!isCur) el.dataset.tip = S.qb.gotoPage; // ほかのページは押すとそのページへ
      const num = document.createElement('button');
      num.type = 'button'; num.className = `page-num${currentOnly ? '' : ' fold'}`;
      num.draggable = true;
      // 開け閉めできるときは、カーソルを合わせると番号の代わりに開け閉めの印を出す
      num.innerHTML = `<span class="n">${number}</span>${currentOnly ? '' : svg(closed ? 'chevR' : 'chevD')}`;
      const tip = currentOnly ? (isCur ? S.unfoldAll : S.qb.gotoPage) : `${closed ? S.unfoldPage : S.foldPage}（${S.foldAlt}）`;
      num.setAttribute('aria-label', `${number}：${tip}`); num.dataset.tip = `${tip} / ${S.pageDrag}`;
      if (!currentOnly) num.setAttribute('aria-expanded', String(!closed));
      num.onclick = e => pageNum(p.index, e.altKey);
      const head = div('heading', isCover(p) && !closed ? S.cover.form : p.title);
      head.dataset.start = p.start;
      head.dataset.ph = S.qb.headingPh; if (!p.title) head.dataset.empty = '';
      el.append(num, head);
      if (closed) el.append(div('page-sum', summary(p)));
      else {
        const tree = div('qtree');
        if (p.raw_only) {
          tree.append(div('qb-label', S.blockPageRaw));
          const c = { start: p.head_end, end: p.end, kind: 'opaque', key: '' };
          tree.append(card([c], null, !isCur));
        } else if (isCover(p)) {
          // 表紙：タイトル・副題・発表者は入力欄。ほかに書いたものはいつものブロックで出す
          cover.update(st); tree.append(cover.el);
          const rest = p.chunks.filter(c => !ownsChunk(source, c));
          if (rest.length) fill(tree, null, rest, 0, { ...p, chunks: rest }, !isCur);
        } else if (!p.generated) fill(tree, null, p.chunks, 0, p, !isCur);
        el.append(tree);
      }
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'page-delete'; del.innerHTML = svg('trash');
      del.setAttribute('aria-label', S.qb.deletePage);
      del.disabled = view.pages.length === 1 && op.isEmptyPage(p);
      del.onpointerdown = e => e.stopPropagation(); del.onmousedown = e => e.preventDefault();
      del.onclick = () => { const r = op.removePage(ctx.text, st, p.index); if (r && commit(r.text)) toast(S.qb.deleted); };
      el.append(del);
      content.append(el);
      if (noToc && p === firstCover) content.append(tocRow(null));
    });
    if (op.canAddPage(view, view.pages.length)) content.append(addRow(view.pages.length, false));
    openCount = view.pages.filter(p => !(currentOnly ? p.index !== cur() : folded.has(p.index))).length;
    if (!view.pages.length) content.append(card([{ start: 0, end: source.length, kind: 'opaque', key: '' }], null));
    pagesEl.replaceChildren(content);
    ctx.paintLock?.();
    updateStepBadges();
    drawnText = source;
    restoreScroll(scroller, anchor, scrollEntries());
    if (onRail && !focusAfter) focusAfter = sel() ? { rail: sel() } : null;
    restoreFocus();
    chrome();
    ctx.foldChanged?.();
  }
  function addRow(i, between) {
    const row = div(`page-add${between ? ' between' : ''}`), b = document.createElement('button');
    b.type = 'button'; b.className = 'end-btn'; b.innerHTML = svg('plus');
    tip(b, S.qb.addPage);
    b.onclick = () => {
      if (ctx.locked) return;
      closeTemplate = choosePageTemplate(b, template => {
        if (dead || source !== ctx.text || ctx.locked) return;
        const r = op.addPage(ctx.text, st, i, template);
        if (r) { goPage = r.page; ctx.editor.page = r.page; commit(r.text, { focus: template.unique ? null : { heading: r.page } }); }
      }, st.pages);
    };
    row.append(b);
    return row;
  }
  function pageNum(i, others) {
    if (currentOnly) { if (i === cur()) { currentOnly = false; folded.clear(); draw(); } else goTo(i); return; }
    if (others) {
      const rest = st.pages.filter(p => p.index !== i).map(p => p.index), close = rest.some(k => !folded.has(k));
      rest.forEach(k => close ? folded.add(k) : folded.delete(k));
    } else if (!folded.delete(i)) folded.add(i);
    draw();
  }

  // ------------------------------------------------------------ 選択・ホバーの表示とツールバー
  function chrome() {
    if (dead || writing) return;
    pagesEl.querySelectorAll('.box.selected, .box.rail-hover, .box.is-active, .box.hovered, .card.selected, .card.hovered').forEach(b => b.classList.remove('selected', 'rail-hover', 'is-active', 'hovered'));
    const s = sel(), b = boxOf(s);
    const cardsOf = key => [...pagesEl.querySelectorAll('.page.cur .card')].filter(c => (c.dataset.keys || '').split(' ').includes(key));
    if (b) b.classList.add('selected', 'rail-hover', 'is-active');
    else if (s) cardsOf(s).forEach(c => c.classList.add('selected'));
    // カーソルを合わせているブロック（ここで合わせたもの、なければスライドで合わせたもの）
    const h = hover ?? slideHover;
    if (h && h !== s) { const hb = boxOf(h); if (hb) hb.classList.add('is-active', 'hovered'); else cardsOf(h).forEach(c => c.classList.add('hovered')); }
    if (session?.owner) boxOf(session.owner)?.classList.add('is-active');
    const show = b && !drag && !b.classList.contains('ghost');
    qtb.classList.toggle('show', !!show);
    qtb.inert = !show;
    if (show) {
      const r = preview?.anchor || rel(b);
      ratioBtn.hidden = !ratio && !ratioTarget(s);
      qtb.style.top = `${Math.max(0, r.y - 27)}px`;
      rpop.classList.toggle('below', r.y - 27 - scroller.scrollTop < 70);
      qtb.style.left = `${Math.max(0, r.x + r.w - qtb.offsetWidth + 2)}px`;
    } else closeRatio();
  }
  function setHover(key) {
    if (key === hover) return;
    hover = key; chrome();
    ctx.preview.win?.slideStudioEdit?.hover?.(key);
  }

  // ------------------------------------------------------------ 入力
  function caretFromPoint(el, x, y) {
    const r = document.caretRangeFromPoint?.(x, y);
    if (!r || !el.contains(r.startContainer)) return null;
    const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  }
  // カードを入力欄にする。入力のたびに、その範囲だけを書き換える
  function edit(el, caret = null) {
    const d = info.get(el);
    if (!d || session || ctx.locked) return;
    if (source !== ctx.text) { refresh(); return; }
    const raw = d.pending ? '' : ctx.text.slice(d.start, d.end);
    if (d.math && !d.pending && ctx.insert?.editMath(d.math, raw, el.getBoundingClientRect())) return;
    const ta = document.createElement('textarea');
    ta.className = 'text'; ta.value = raw; ta.spellcheck = false; ta.setAttribute('aria-label', S.qmdBlockInput);
    el.replaceChildren(ta); el.classList.add('editing');
    // 空のブロックに書いた段落は、書いた時点で前の段落の次（空の囲み・ページなら最初）のチャンクになる
    const born = d.pending && (d.pending.after ? d.pending.after.replace(/\d+$/, n => String(+n + 1))
      : d.pending.owner ? `${d.pending.owner}.0` : `p${d.pending.page}/0`);
    const end = d.pending ? d.pending.pos : d.end;
    session = { ta, start: d.pending ? d.pending.pos : d.start, end, end0: end, owner: d.owner, pending: d.pending, born };
    if (d.owner) ctx.blocks?.select(d.owner);
    const size = () => { ta.style.height = '0'; ta.style.height = `${ta.scrollHeight}px`; };
    ta.oninput = () => {
      if (ctx.locked || session?.ta !== ta) return;
      const s = session, value = ta.value, insert = s.pending ? (value ? s.pending.prefix + value : '') : value;
      const text = ctx.text.slice(0, s.start) + insert + ctx.text.slice(s.end);
      s.end = s.start + insert.length;
      const at = s.start + (s.pending && value ? s.pending.prefix.length : 0) + ta.selectionStart;
      if (s.pending) s.owner = value ? s.born : s.pending.owner;
      write(text, { typing: true, caret: at }, s.owner);
      size();
    };
    ta.onkeydown = e => textKey(e, ta);
    ta.onblur = () => { if (session?.ta !== ta) return; lastCaret = { pos: caretOf(session), text: ctx.text }; session = null; pending = null; draw(); };
    ta.focus({ preventScroll: true });
    const pos = Math.min(caret ?? raw.length, raw.length);
    if (isPlaceholder(raw)) ta.select(); else ta.setSelectionRange(pos, pos);
    size(); chrome();
  }
  // 見出しは文字だけを書く。## と {#id .class} は残す
  function editHeading(el, page, caret = null) {
    if (session || ctx.locked || source !== ctx.text) return;
    const p = st.pages[page]; if (!p || p.generated) return;
    if (isCover(p)) { cover.focus('title'); return; }
    const ta = document.createElement('textarea');
    ta.className = 'heading-input'; ta.value = p.title; ta.rows = 1; ta.spellcheck = false; ta.setAttribute('aria-label', S.qb.headingInput);
    el.replaceChildren(ta); el.classList.add('editing'); delete el.dataset.empty;
    session = { ta, start: p.start, end: p.head_end, end0: p.head_end, heading: true };
    ctx.blocks?.select(null);
    const size = () => { ta.style.height = '0'; ta.style.height = `${ta.scrollHeight}px`; };
    ta.oninput = () => {
      const s = session; if (s?.ta !== ta || ctx.locked) return;
      ta.value = ta.value.replace(/\n/g, '');
      const line = op.headingLine(ctx.text.slice(s.start, s.end), ta.value);
      const text = ctx.text.slice(0, s.start) + line + ctx.text.slice(s.end);
      s.end = s.start + line.length;
      write(text, { typing: true, caret: s.end }, sel());
      size();
    };
    ta.onkeydown = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); ta.blur(); e.shiftKey ? ctx.redo() : ctx.undo(); return; }
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ta.blur(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); ta.blur(); const c = pagesEl.querySelector('.page.cur .card'); if (c) edit(c, 0); }
    };
    ta.onblur = () => { if (session?.ta !== ta) return; session = null; draw(); };
    const pos = Math.min(caret ?? ta.value.length, ta.value.length);
    ta.focus({ preventScroll: true }); ta.setSelectionRange(pos, pos);
    size();
  }
  const cards = () => [...pagesEl.querySelectorAll('.page.cur .card:not(.inert)')].filter(c => info.has(c));
  // 入力欄のカーソルの、原稿の中の位置（挿入の位置に使う）
  const caretOf = s => s.start + (s.pending && s.ta.value ? s.pending.prefix.length : 0) + s.ta.selectionStart;
  function textKey(e, ta) {
    const s = session, mod = e.metaKey || e.ctrlKey;
    e.stopPropagation();
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); ta.blur(); e.shiftKey ? ctx.redo() : ctx.undo(); return; }
    if (e.key === 'Escape') { e.preventDefault(); const key = s.owner; ta.blur(); if (key && find(key)) select(key, { rail: true }); return; }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) { if (s.owner) toolOp('right', s.owner); return; }
      const at = ta.selectionStart;
      const base = s.start + (s.pending && ta.value ? s.pending.prefix.length : 0);
      if (ta.selectionStart === ta.selectionEnd && at > 0 && at < ta.value.trimEnd().length) {
        const r = op.splitAt(ctx.text, base + at);
        commit(r.text, { focus: { pos: r.caret, caret: r.caret } });
      } else if (s.owner) { ta.blur(); toolOp('below', s.owner); }
      return;
    }
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    if (e.key === 'Backspace' && !mod && !e.altKey && !e.isComposing && ta.selectionStart === ta.selectionEnd) {
      const r = op.backspaceList(ta.value, ta.selectionStart);
      if (r) {
        e.preventDefault();
        ta.value = r.text; ta.setSelectionRange(r.caret, r.caret); ta.oninput();
        return;
      }
    }
    if (e.key === 'Backspace' && atStart && !mod) {
      if (s.pending && !ta.value) { e.preventDefault(); const all = cards(), i = all.findIndex(c => c.contains(ta)); ta.blur(); const p = cards()[i - 1]; if (p) edit(p); return; }
      const r = s.owner && source === ctx.text && op.merge(ctx.text, st, s.owner);
      if (r) { e.preventDefault(); commit(r.text, { focus: { pos: r.caret, caret: r.caret } }); }
      return;
    }
    if (e.key === 'ArrowUp' && atStart && !e.shiftKey) {
      e.preventDefault();
      const all = cards(), i = all.findIndex(c => c.contains(ta)), p = all[i - 1];
      ta.blur();
      if (p) edit(cards()[i - 1]);
      else { const h = pagesEl.querySelector('.page.cur > .heading'); if (h) editHeading(h, cur()); }
      return;
    }
    if (e.key === 'ArrowDown' && atEnd && !e.shiftKey) {
      const all = cards(), i = all.findIndex(c => c.contains(ta));
      if (all[i + 1]) { e.preventDefault(); ta.blur(); cards()[i + 1] && edit(cards()[i + 1], 0); }
    }
  }
  // 入力中に別の欄を押したとき。今の欄を閉じ（描き直す）、押した欄を開く。
  // 入力中は描き直さないので、今の欄より後のカードの位置は、打った分だけずらして探す
  function switchTo(c, caret) {
    const d = info.get(c), s = session;
    if (d.pending) focusAfter = d.pending.owner ? { empty: d.pending.owner } : null;
    else { const start = d.start + (d.start >= s.end0 ? s.end - s.end0 : 0); focusAfter = { pos: start, caret: start + (caret ?? d.end - d.start) }; }
    s.ta.blur();
  }
  function restoreFocus() {
    const f = focusAfter; if (!f) return;
    // 構造の取り直しを待つ（描き直したときにもう一度呼ばれる）
    if (f.pos != null && source !== ctx.text) return;
    focusAfter = null;
    if (f.cover) { cover.focus(f.cover); return; }
    if (f.heading != null) { const h = pagesEl.querySelector(`.page.cur[data-page="${f.heading}"] > .heading`); if (h) editHeading(h, f.heading, f.caret); return; }
    if (f.rail) { boxOf(f.rail)?.querySelector(':scope > .rail')?.focus({ preventScroll: true }); boxOf(f.rail)?.scrollIntoView({ block: 'nearest' }); return; }
    if (f.empty) { const c = boxOf(f.empty)?.querySelector('.card.empty'); if (c) edit(c); return; }
    if (f.pending) { const c = pagesEl.querySelector('.page.cur .box.virtual:not([data-key]) .card.empty'); if (c) edit(c); return; }
    if (f.pos != null) {
      const c = cards().find(c => { const d = info.get(c); return !d.pending && d.start <= f.pos && f.pos <= d.end; });
      if (c) edit(c, f.caret - info.get(c).start);
    }
  }

  // ------------------------------------------------------------ ツールバー
  function find(key) { return op.find(st, key); }
  function afterRemove(key) {
    const f = find(key); if (!f) return null;
    const sibs = op.siblings(f.page, f.chunk), i = sibs.indexOf(f.chunk);
    return sibs[i + 1] ? key : sibs[i - 1]?.key ?? op.parentKey(key);
  }
  function toolOp(act, key, { dry = false } = {}) {
    if (!key || !find(key)) return null;
    if (act === 'below') {
      const p = op.pendingBelow(st, key);
      if (dry) return { pending: p };
      pending = p; preview = null; focusAfter = { pending: true }; draw(); return true;
    }
    if (act === 'delete') {
      if (dry) return { remove: key };
      const r = op.remove(ctx.text, st, key); if (!r) return null;
      if (commit(r.text, { select: r.select ?? afterRemove(key) })) toast(S.qb.deleted);
      return true;
    }
    if (act === 'right') {
      const r = op.addRight(ctx.text, st, key); if (!r) return null;
      if (dry) return r;
      return commit(r.text, { select: r.select, focus: { empty: r.select } });
    }
    return null;
  }
  let hoverAct = 0;
  qtb.addEventListener('mousedown', e => e.preventDefault());
  qtb.querySelectorAll('.tb-btn:not([data-act="ratio"])').forEach(b => {
    b.addEventListener('mouseenter', async () => {
      if (ratio || session) return;
      const key = sel(), act = b.dataset.act, id = ++hoverAct, anchor = boxOf(key) && rel(boxOf(key));
      const r = toolOp(act, key, { dry: true });
      if (!r) return;
      if (act === 'right') {
        try {
          const structure = await api('/api/structure', { method: 'POST', body: { text: r.text } });
          if (id !== hoverAct) return;
          preview = { st: op.units(r.text, structure), nu: r.select, anchor, text: r.text };
        } catch { return; }
      } else preview = { ...r, anchor };
      const was = source;
      if (preview.text) source = preview.text;
      draw(); source = was;
    });
    b.addEventListener('mouseleave', () => { hoverAct++; if (preview) { preview = null; draw(); } });
    b.addEventListener('click', () => { hoverAct++; preview = null; toolOp(b.dataset.act, sel()); });
  });

  // ------------------------------------------------------------ 列の幅（mock の rpop）
  function ratioTarget(key) {
    const c = find(key)?.chunk; if (!c) return null;
    if (c.kind === 'column' && c.parent.children.length > 1) return { row: c.parent.key, col: key };
    if (c.kind === 'columns' && c.children.length > 1) return { row: key, col: null };
    return null;
  }
  function openRatio(t) {
    const cols = find(t.row).chunk, k = cols.children.length;
    ratio = { ...t, min: Math.min(Math.floor(100 / k), 10), r: op.intRatios(op.ratios(cols)) };
    rtrack.style.setProperty('--lc', qLayer(pathLabel(cols).split(' › ').length));
    rtrack.replaceChildren();
    cols.children.forEach(c => rtrack.append(div(`rseg${c.key === t.col ? ' cur' : ''}`)));
    for (let j = 1; j < k; j++) {
      const h = div('rhandle'); h.tabIndex = 0; h.dataset.j = j;
      h.setAttribute('role', 'slider'); h.setAttribute('aria-label', S.qb.ratioEdge(j));
      h.setAttribute('aria-valuemin', '0'); h.setAttribute('aria-valuemax', '100');
      rtrack.append(h);
    }
    rpop.hidden = false; ratioBtn.setAttribute('aria-expanded', 'true');
    syncRatio(); chrome();
    rtrack.querySelector('.rhandle')?.focus({ preventScroll: true });
  }
  function closeRatio() {
    if (!ratio) return;
    ratio = null; rdrag = null; rpop.hidden = true; ratioBtn.setAttribute('aria-expanded', 'false');
  }
  function syncRatio() {
    if (!ratio) return;
    const segs = rtrack.querySelectorAll('.rseg'), hs = rtrack.querySelectorAll('.rhandle');
    let x = 0;
    ratio.r.forEach((v, i) => {
      Object.assign(segs[i].style, { left: `calc(${x}% + 1px)`, width: `calc(${v}% - 2px)` });
      segs[i].textContent = v; segs[i].classList.toggle('at-min', v <= ratio.min);
      x += v;
      if (hs[i]) { hs[i].style.left = `${x}%`; hs[i].setAttribute('aria-valuenow', String(x)); hs[i].setAttribute('aria-valuetext', ratio.r.join(' : ')); }
    });
  }
  // 動かしている間はその場で原稿に書く（取り消しは1秒ごとにまとめる）
  function liveRatios(r) {
    if (!ratio || r.join() === ratio.r.join()) return;
    // 幅だけを書き換えている間は、開いたときの原稿と構造から作り直す（構造の取り直しを待たない）
    if (ctx.text !== ratio.last) {
      if (source !== ctx.text) return;
      ratio.base = ctx.text; ratio.cols = find(ratio.row)?.chunk;
    }
    if (!ratio.cols) return;
    ratio.r = r; syncRatio();
    ratio.last = op.setWidths(ratio.base, ratio.cols, r);
    write(ratio.last, { typing: true }, sel() || ratio.col || ratio.row);
    ctx.hint(S.qb.ratioHint(r));
  }
  let rdrag = null;
  ratioBtn.addEventListener('click', () => { if (ratio) { closeRatio(); chrome(); return; } const t = ratioTarget(sel()); if (t) openRatio(t); });
  rtrack.addEventListener('pointerdown', e => {
    const h = e.target.closest('.rhandle'); if (!h || e.button || !ratio) return;
    e.preventDefault(); h.setPointerCapture(e.pointerId); h.focus({ preventScroll: true });
    rdrag = { j: +h.dataset.j, start: [...ratio.r], h }; h.classList.add('on');
  });
  rtrack.addEventListener('pointermove', e => {
    if (!rdrag || !ratio) return;
    const r = rtrack.getBoundingClientRect();
    liveRatios(op.pushRatios(rdrag.start, rdrag.j, (e.clientX - r.left) / r.width * 100, ratio.min));
  });
  const endRdrag = () => { if (rdrag) { rdrag.h.classList.remove('on'); rdrag = null; } };
  rtrack.addEventListener('pointerup', endRdrag); rtrack.addEventListener('pointercancel', endRdrag);
  rtrack.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeRatio(); chrome(); ratioBtn.focus({ preventScroll: true }); return; }
    const h = e.target.closest('.rhandle'); if (!h || !ratio) return;
    const step = e.shiftKey ? 5 : 1;
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0;
    if (!d) return;
    e.preventDefault();
    const j = +h.dataset.j;
    liveRatios(op.pushRatios(ratio.r, j, ratio.r.slice(0, j).reduce((a, b) => a + b, 0) + d, ratio.min));
  });
  const outside = e => { if (ratio && !qtb.contains(e.target)) { closeRatio(); chrome(); } };
  document.addEventListener('pointerdown', outside, true);

  // ------------------------------------------------------------ ドラッグで移す
  function dropAt(x, y) {
    const e = document.elementFromPoint(x, y);
    if (!e || !pagesEl.contains(e)) return null;
    const pg = e.closest('.page.cur'); if (!pg) return null;
    const src = find(drag.key)?.chunk, page = st.pages[+pg.dataset.page];
    if (e.closest('.heading')) {
      const first = page.chunks[0];
      return first ? { key: first.key, side: 'before', el: boxOf(first.key) } : { page: page.index, el: e.closest('.heading') };
    }
    const empty = e.closest('.card.empty');
    if (empty) { const d = info.get(empty); return d?.pending?.owner ? { into: d.pending.owner, el: empty } : { page: page.index, el: empty }; }
    let b = e.closest('.box[data-key]');
    // 列は、別の列の上なら列の前後へ、列の外ならいちばん内側のブロックの前後へ（中身だけを移す。block-ops の move）
    if (src.kind === 'column') {
      let near = null;
      for (; b; b = b.parentElement.closest('.box[data-key]')) {
        const t = find(b.dataset.key)?.chunk; if (!t) continue;
        if (t.kind === 'column') { near = t === src ? null : { t, b }; break; }
        near ??= { t, b };
      }
      if (!near) return null;
      const r = near.b.getBoundingClientRect();
      return { key: near.t.key, side: y < r.top + r.height / 2 ? 'before' : 'after', el: near.b };
    }
    while (b) {
      const t = find(b.dataset.key)?.chunk;
      if (t && t.kind !== 'column') {
        const r = b.getBoundingClientRect();
        return { key: t.key, side: y < r.top + r.height / 2 ? 'before' : 'after', el: b };
      }
      // 段落を列の上に落としたら、その列の最後に入れる
      if (t && t.kind === 'column' && src.kind !== 'column') {
        const last = t.children.at(-1);
        return last ? { key: last.key, side: 'after', el: b, face: true } : { into: t.key, el: b, face: true };
      }
      b = b.parentElement.closest('.box[data-key]');
    }
    return null;
  }
  function drawDrop() {
    ov.replaceChildren();
    const sp = drag?.spec; if (!sp) return;
    const put = (cls, r) => { const e = div(cls); Object.assign(e.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }); ov.append(e); };
    const r = rel(sp.el.querySelector?.(':scope > .content') || sp.el);
    if (sp.face || sp.into || sp.page != null) { const f = rel(sp.el); put('ind-face', { x: f.x - 4, y: f.y - 4, w: f.w + 8, h: f.h + 8 }); }
    if (sp.side === 'before') put('ind-h', { x: r.x, y: r.y - 6, w: r.w, h: 2 });
    else if (sp.side === 'after' && !sp.face) put('ind-h', { x: r.x, y: r.y + r.h + 5, w: r.w, h: 2 });
  }
  function endDrag(ok) {
    const d = drag; drag = null; press = null; ov.replaceChildren();
    if (ok && d?.spec) {
      const r = op.move(ctx.text, st, d.key, d.spec);
      if (r) commit(r.text, { select: null });
    }
    draw();
  }
  pagesEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const pg = e.target.closest('.page');
    if (pg && pg.classList.contains('dormant')) {
      if (e.target.closest('.page-num, .page-delete')) return;
      e.preventDefault();
      const c = e.target.closest('.card'), d = c && info.get(c);
      // 入力中の欄（見出しも）は先に閉じる。開いたままだと描き直さないので、押したページへ移れない。
      // 入力中は描き直していないので、今の欄より後の位置は、打った分だけずらす
      const s = session, shift = p => s && p >= s.end0 ? p + s.end - s.end0 : p;
      s?.ta.blur();
      const head = e.target.closest('.heading');
      if (d?.start != null) {
        const at = caretFromPoint(c.querySelector('.text'), e.clientX, e.clientY);
        focusAfter = { pos: shift(d.start), caret: at == null ? shift(d.end) : shift(d.start) + at };
      }
      else if (e.target.closest('.cover-form')) focusAfter = { cover: cover.fieldAt(e.target) };
      else if (head) focusAfter = { heading: +pg.dataset.page, caret: caretFromPoint(head, e.clientX, e.clientY) };
      goTo(+pg.dataset.page);
      return;
    }
    if (pg?.classList.contains('folded') && e.target.closest('.page-sum')) { e.preventDefault(); folded.delete(+pg.dataset.page); draw(); return; }
    const rail = e.target.closest('.rail[data-key]');
    if (rail) { e.preventDefault(); rail.setPointerCapture(e.pointerId); press = { key: rail.dataset.key, x: e.clientX, y: e.clientY, rail }; return; }
    if (e.target.closest('.cover-form')) return;
    const head = e.target.closest('.page.cur > .heading');
    if (head) {
      // 入力欄内のクリック・範囲選択では編集を終えない。
      if (head.classList.contains('editing')) return;
      e.preventDefault();
      const at = caretFromPoint(head, e.clientX, e.clientY);
      if (session) { focusAfter = { heading: +pg.dataset.page, caret: at }; session.ta.blur(); } else editHeading(head, +pg.dataset.page, at);
      return;
    }
    const c = e.target.closest('.card');
    if (c && !c.classList.contains('editing') && info.has(c)) {
      e.preventDefault();
      const d = info.get(c), caret = d.pending ? 0 : caretFromPoint(c.querySelector('.text'), e.clientX, e.clientY);
      if (session) switchTo(c, caret); else edit(c, caret);
      return;
    }
    if (!c && !e.target.closest('.qtb')) { document.activeElement?.blur?.(); select(null); }
  });
  pagesEl.addEventListener('pointermove', e => {
    if (press && !drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) {
      drag = { key: press.key, spec: null };
      boxOf(press.key)?.classList.add('drag-src'); chrome();
    }
    if (drag) {
      const sp = dropAt(e.clientX, e.clientY);
      drag.spec = sp && op.moves(ctx.text, st, drag.key, sp) ? sp : null;
      drawDrop(); return;
    }
    if (press || session) return;
    const t = e.target;
    const key = t.closest?.('.page.cur .rail[data-key]')?.dataset.key || t.closest?.('.page.cur .card')?.dataset.owner || null;
    setHover(key || null);
  });
  pagesEl.addEventListener('pointerup', e => {
    if (drag) { endDrag(true); return; }
    if (press) { const key = press.key; press = null; select(key, { rail: true }); }
  });
  pagesEl.addEventListener('pointercancel', () => { if (drag) endDrag(false); press = null; });
  pagesEl.addEventListener('pointerleave', () => { if (!drag) setHover(null); });
  pagesEl.addEventListener('focusin', e => {
    const rail = e.target.closest?.('.rail[data-key]');
    if (rail && rail.dataset.key !== sel() && !press) select(rail.dataset.key);
  });

  // ------------------------------------------------------------ 線にフォーカスがあるときのキー（mock の blockKey）
  pagesEl.addEventListener('keydown', e => {
    if (drag && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endDrag(false); return; }
    const rail = e.target.closest?.('.rail[data-key]'); if (!rail) return;
    const key = rail.dataset.key, f = find(key); if (!f) return;
    const mod = e.metaKey || e.ctrlKey;
    const prevKey = e.key === 'ArrowUp' || e.key === 'ArrowLeft', nextKey = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if ((prevKey || nextKey) && e.altKey) { done(); const r = op.nudge(ctx.text, st, key, prevKey ? -1 : 1); if (r) commit(r.text, { select: r.select }); return; }
    if (prevKey || nextKey) {
      done();
      const sibs = op.siblings(f.page, f.chunk), s = sibs[sibs.indexOf(f.chunk) + (prevKey ? -1 : 1)];
      if (s) select(s.key, { rail: true });
      return;
    }
    if (e.key === 'Escape') { done(); select(null); rail.blur(); return; }
    if (e.key === 'Enter' && mod) { done(); toolOp(e.shiftKey ? 'right' : 'below', key); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      done();
      const child = f.chunk.children.find(c => c.kind !== 'def');
      const b = boxOf(key);
      if (child && boxOf(child.key)) select(child.key, { rail: true });
      else { const c = b?.querySelector('.card'); if (c) edit(c); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (pagesEl.ownerDocument.getSelection()?.isCollapsed === false) return;
      done(); toolOp('delete', key);
    }
  });

  // ------------------------------------------------------------ 構造の取得
  async function refresh() {
    const id = ++ticket, text = ctx.text;
    try {
      const result = await structureOf(text);
      if (dead || id !== ticket || text !== ctx.text) return;
      source = text; st = result;
      if (session) return;
      draw();
    } catch { /* 原文表示は引き続き使える */ }
  }
  function reveal() {
    const el = pagesEl.querySelector('.page.cur'); if (!el) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const h = el.querySelector('.heading').getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    if (!currentOnly && h.top >= sr.top && h.bottom <= sr.bottom) return;
    scroller.scrollTo({ top: scroller.scrollTop + top - 4, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  ctx.qmdBlocks = {
    // スライドでカーソルを合わせているブロック（inject/edit.js から）
    hover(key) { if (key !== slideHover) { slideHover = key; chrome(); } },
    mark() {
      chrome();
      const b = boxOf(sel()), onRail = document.activeElement?.closest?.('#qblocks .rail');
      if (onRail && b && onRail !== b.querySelector(':scope > .rail')) { b.querySelector(':scope > .rail')?.focus({ preventScroll: true }); b.scrollIntoView({ block: 'nearest' }); }
      else if (b && !host.hidden && document.activeElement?.closest?.('#qblocks') == null) b.scrollIntoView({ block: 'nearest' });
    },
    fold(others) { currentOnly = others; folded.clear(); draw(); reveal(); },
    openPages: () => openCount,
    reveal() { if (!session) draw(); reveal(); },
    render() { if (!session) draw(); },
    headEl() { return pagesEl.querySelector('.page.cur > .heading'); },
    // 入力中の欄のカーソル（入力を終えた後は、原稿が変わっていなければ最後の位置）
    caret() {
      if (session && !session.heading) return { pos: caretOf(session), live: true };
      return lastCaret && lastCaret.text === ctx.text ? { pos: lastCaret.pos, live: false } : null;
    },
    // 入力中の欄（挿入で原稿を書く前に閉じる）
    get input() { return session && !session.heading ? session.ta : null; },
    // 表紙のタイトル・副題のブロック（スライドで直接直せないもの）なら、表紙の入力欄の該当する欄へ移って true
    editCover(key) {
      const k = st && find(key)?.chunk, c = k && (op.coverPart(k) || k);
      if (!c || !ownsChunk(source, c) || host.hidden || document.body.classList.contains('editor-off')) return false;
      session?.ta.blur();
      cover.focus(/cover-subtitle/.test(source.slice(c.start, c.end)) ? 'subtitle' : 'title');
      return true;
    },
  };
  refresh();
  return {
    textChanged() { refresh(); },
    // AI が別の場所を書いたら、入力中の欄の位置を合わせる。見つからなければ入力を終える
    textRebased(before, after) {
      const s = session; if (!s) return;
      const seg = before.slice(s.start, s.end);
      let best = -1;
      if (seg) for (let i = after.indexOf(seg); i >= 0; i = after.indexOf(seg, i + 1)) if (best < 0 || Math.abs(i - s.start) < Math.abs(best - s.start)) best = i;
      if (best < 0) { s.ta.blur(); return; }
      const shift = best - s.start;
      s.start += shift; s.end += shift; s.end0 += shift;
    },
    slideChanged() {
      if (cur() === shownPage) { updateStepBadges(); chrome(); return; }
      shownPage = cur();
      if (session && !session.heading) session.ta.blur();
      if (cover.active && cover.el.contains(document.activeElement)) document.activeElement.blur();
      draw(); if (!host.hidden) reveal();
    },
    previewLoaded() {
      // 目次の表示切り替えや文献の分割で変わった番号だけを、入力欄を描き直さずに合わせる。
      for (const el of pagesEl.querySelectorAll('.page[data-page]')) {
        const i = ctx.preview.slideOfPage(+el.dataset.page);
        if (i < 0) continue;
        const button = el.querySelector(':scope > .page-num'), label = button?.getAttribute('aria-label');
        button.querySelector('.n').textContent = i + 1;
        if (label) button.setAttribute('aria-label', label.replace(/^\d+：/, `${i + 1}：`));
      }
      updateStepBadges();
      if (goPage == null) return;
      const i = ctx.preview.slideOfPage(goPage); goPage = null;
      if (i >= 0) ctx.preview.go(i, 0);
    },
    destroy() { dead = true; closeTemplate?.(); document.removeEventListener('pointerdown', outside, true); },
  };
}
