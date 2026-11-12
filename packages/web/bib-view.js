// トピックの文献：一覧・詳細と確認待ちの解除。
import { esc, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';

const T = S.topic;
// 詳細の表に出さないもの（題名・要旨は別の場所に出す）
const SKIP = new Set(['title', 'abstract', 'slide-studio-status']);
// 発表の文献タブの絞り込み（種類とアイコン）
const FILTERS = [['all', 'bookOpen'], ['used', 'quote'], ['unused', 'quoteOff']];

// 一覧の著者：1人・2人は姓、3人以上は「姓 ほか」
const creator = e => e.authors.length > 2 ? `${e.authors[0].family} ${T.etAl}` : e.authors.map(a => a.family).join('・');
const year = e => e.fields.year || (e.fields.date || '').slice(0, 4);
const value = { title: e => e.fields.title || e.key, creator, year, used: e => e.decks.length };
const link = href => /^https?:\/\//i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(href)}</a>` : esc(href);

export function bibView(sec, options = {}) {
  sec.innerHTML = `<div class="sec-head"><h2>${T.bib}</h2><span class="sec-count"></span><span class="grow"></span>
    <label class="bib-search">${svg('search')}<input type="search" placeholder="${T.bibSearch}" aria-label="${T.bibSearch}"></label></div>
    ${options.deck ? `<div class="seg icons bib-filter" role="group" aria-label="${T.bibFilter}">${FILTERS.map(([k, icon]) => `<button type="button" data-filter="${k}" aria-label="${T.bibShow[k]}" data-tip="${T.bibShow[k]}">${svg(icon)}</button>`).join('')}</div>` : ''}
    <div class="bib">
      <div class="bib-list" tabindex="0" role="listbox" aria-label="${T.bib}"><table>
        <thead><tr>${Object.entries(options.deck ? {...T.bibCols, used: T.bibThisUsed} : T.bibCols).map(([k, v]) => `<th class="c-${k}" data-sort="${k}"><button type="button" data-tip="${esc(T.bibSort(v))}">${v}</button></th>`).join('')}</tr></thead>
        <tbody></tbody></table></div>
      <div class="bib-resize" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="${T.bibResize}" data-tip="${T.bibResize}" aria-valuemin="15" aria-valuemax="85" aria-valuenow="65"></div>
      <aside class="bib-detail" aria-live="polite"></aside>
    </div>
    <p class="bib-note empty-note" hidden></p>`;
  const $ = s => sec.querySelector(s);
  const input = $('.bib-search input'), list = $('.bib-list'), body = $('tbody'), detail = $('.bib-detail');
  let items = [], titles = {}, shown = [], current = null, sort = { by: 'title', dir: 1 }, filter = 'all';
  let editing = null, saving = false, fitting = null;
  // 入力欄を中身の高さに合わせる（文字が隠れないように）
  const fit = ta => {
    const box = ta.closest('.bib-edit-fields'), top = box?.scrollTop;
    ta.style.height = '0';
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`;
    if (box) box.scrollTop = top;
  };

  const pane = $('.bib'), grip = $('.bib-resize');
  function resize(share) {
    const available = pane.clientHeight - grip.offsetHeight;
    if (available <= 0) return;
    const min = Math.min(50, Math.max(15, 80 / available * 100));
    share = Math.max(min, Math.min(100 - min, share));
    pane.style.setProperty('--bib-list-size', `${share}fr`);
    pane.style.setProperty('--bib-detail-size', `${100 - share}fr`);
    grip.setAttribute('aria-valuenow', String(Math.round(share)));
  }
  grip.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    grip.focus({preventScroll: true});
    grip.setPointerCapture(ev.pointerId);
    grip.classList.add('on');
  });
  grip.addEventListener('pointermove', ev => {
    if (!grip.hasPointerCapture(ev.pointerId)) return;
    resize((ev.clientY - pane.getBoundingClientRect().top - grip.offsetHeight / 2) / (pane.clientHeight - grip.offsetHeight) * 100);
  });
  const stopResize = () => grip.classList.remove('on');
  grip.addEventListener('pointerup', ev => {
    if (grip.hasPointerCapture(ev.pointerId)) grip.releasePointerCapture(ev.pointerId);
    stopResize();
  });
  grip.addEventListener('pointercancel', stopResize);
  grip.addEventListener('lostpointercapture', stopResize);
  grip.addEventListener('keydown', ev => {
    const delta = {ArrowUp: -5, ArrowDown: 5}[ev.key];
    if (!delta) return;
    ev.preventDefault(); ev.stopPropagation();
    resize(list.offsetHeight / (pane.clientHeight - grip.offsetHeight) * 100 + delta);
  });

  function draw() {
    const q = input.value.trim().toLowerCase();
    shown = items.filter(e => !q || [e.key, e.fields.title, e.authors.map(a => a.name).join(' '), year(e), e.fields.journal, e.fields.booktitle]
      .some(s => (s || '').toLowerCase().includes(q)));
    sec.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
    if (filter === 'used') shown = shown.filter(e => e.pages?.length);
    if (filter === 'unused') shown = shown.filter(e => !e.pages?.length);
    const get = value[sort.by];
    shown.sort((a, b) => sort.dir * (typeof get(a) === 'number' ? get(a) - get(b) : String(get(a)).localeCompare(String(get(b)), 'ja', { numeric: true })));
    sec.querySelectorAll('th').forEach(th => th.setAttribute('aria-sort', th.dataset.sort !== sort.by ? 'none' : sort.dir > 0 ? 'ascending' : 'descending'));
    if (!shown.some(e => e.key === current)) current = shown[0]?.key ?? null;
    body.innerHTML = shown.length ? shown.map(e => `<tr role="option" data-key="${esc(e.key)}" aria-selected="${e.key === current}" data-tip="${T.bibOpen}">
      <td class="c-title">${e.unverified ? `<b class="u">${S.ins.unverified}</b>` : ''}${esc(value.title(e))}</td>
      <td class="c-creator">${esc(creator(e))}</td><td class="c-year">${esc(year(e))}</td><td class="c-used">${options.deck ? (e.pages?.length ? `<span role="img" aria-label="${T.bibThisUsed}">${svg('check')}</span>` : '') : e.decks.length || ''}</td></tr>`).join('')
      : `<tr><td colspan="4" class="empty-note">${T.bibNoMatch}</td></tr>`;
    show();
  }

  function show() {
    if (editing?.key === current) return;
    editing = null;
    fitting?.disconnect(); fitting = null;
    detail.classList.remove('editing');
    const e = items.find(i => i.key === current);
    body.querySelectorAll('tr[data-key]').forEach(tr => tr.setAttribute('aria-selected', String(tr.dataset.key === current)));
    if (!e) { detail.innerHTML = ''; return; }
    const f = e.fields, rows = [];
    if (e.authors.length) rows.push([T.bibFields.author, e.authors.map(a => `<div>${esc(a.name)}</div>`).join('')]);
    const known = Object.keys(T.bibFields).filter(k => k !== 'author' && f[k]);
    const rest = Object.keys(f).filter(k => !SKIP.has(k) && !(k in T.bibFields));
    for (const k of [...known, ...rest]) {
      const v = k === 'doi' ? link(/^https?:/i.test(f.doi) ? f.doi : `https://doi.org/${f.doi}`) : k === 'url' ? link(f.url) : esc(f[k]);
      rows.push([T.bibFields[k] || k, v]);
    }
    detail.innerHTML = `<div class="bd-type">${esc(T.bibTypes[e.type] || e.type)}${e.unverified ? `<b class="u">${S.ins.unverified}</b>` : ''}</div>
      <h3>${esc(f.title || e.key)}</h3>
      ${options.save ? `<button type="button" class="btn" data-act="edit">${T.bibEdit}</button>` : ''}
      ${e.unverified ? `<p class="empty-note">${T.bibPendingReason} ${T.bibPendingHint}</p>${options.verify ? `<button type="button" class="btn" data-act="verify">${S.ins.verifyBib}</button>` : ''}` : ''}
      <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}
        <dt>${T.bibKey}</dt><dd class="bd-key"><code>${esc(e.key)}</code><button type="button" class="ibtn" data-act="copy" aria-label="${T.bibCopy}" data-tip="${T.bibCopy}">${svg('copy')}</button></dd></dl>
      ${f.abstract ? `<h4>${T.bibAbstract}</h4><p class="bd-abstract">${esc(f.abstract)}</p>` : ''}
      ${options.deck ? `<h4>${T.bibPages}</h4>${e.pages?.length ? e.pages.map(p => `<button type="button" class="btn" data-page="${p.index}">${esc(p.title)}</button>`).join(' ') : `<p class="empty-note">${T.bibThisUnused}</p>`}` : ''}
      <h4 ${options.deck ? 'hidden' : ''}>${T.bibUsedBy}</h4>
      ${options.deck ? '' : e.decks.length ? `<ul class="bd-decks">${e.decks.map(d => `<li><a href="/deck/${encodeURIComponent(d)}" data-nav>${esc(titles[d] || d)}</a></li>`).join('')}</ul>` : `<p class="empty-note">${T.bibUnused}</p>`}
      <details><summary data-tip="${T.bibRawShow}">${T.bibRaw}</summary><pre>${esc(e.raw)}</pre></details>`;
  }

  input.addEventListener('input', draw);
  $('.bib-filter')?.addEventListener('click', ev => {
    const b = ev.target.closest('[data-filter]');
    if (b) { filter = b.dataset.filter; draw(); }
  });
  $('thead').addEventListener('click', ev => {
    const by = ev.target.closest('th')?.dataset.sort;
    if (!by) return;
    sort = { by, dir: sort.by === by ? -sort.dir : by === 'used' ? -1 : 1 };
    draw();
  });
  body.addEventListener('click', ev => {
    if (saving) return;
    const key = ev.target.closest('tr[data-key]')?.dataset.key;
    if (key) { current = key; show(); list.focus({ preventScroll: true }); }
  });
  list.addEventListener('keydown', ev => {
    if (saving) return;
    const move = { ArrowDown: 1, ArrowUp: -1 }[ev.key];
    if (!move || !shown.length) return;
    ev.preventDefault();
    const i = Math.max(0, Math.min(shown.length - 1, shown.findIndex(e => e.key === current) + move));
    current = shown[i].key; show();
    body.querySelector(`tr[data-key="${CSS.escape(current)}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  detail.addEventListener('click', async ev => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit') {
      const e = items.find(i => i.key === current);
      editing = {key: e.key, raw: e.raw, fields: e.editable || {}};
      const labels = {title: T.bibTitle, ...T.bibFields, abstract: T.bibAbstract};
      const keys = [...new Set(['title', 'author', ...(e.fields.date && !e.fields.year ? ['date'] : ['year', ...(e.fields.date ? ['date'] : [])]), ...(editing.fields.booktitle && !editing.fields.journal ? [] : ['journal']), 'doi', 'url', ...Object.keys(editing.fields), 'abstract'])].filter(k => k !== 'slide-studio-status');
      detail.classList.add('editing');
      detail.innerHTML = `<form class="bib-edit"><div class="bib-edit-fields"><p class="empty-note">${T.bibShared}</p>${keys.map(k => `<label>${esc(labels[k] || k)}<textarea name="${esc(k)}" aria-label="${esc(labels[k] || k)}" rows="${k === 'abstract' ? 4 : 1}">${esc(editing.fields[k] || '')}</textarea></label>`).join('')}</div><div class="bib-edit-actions"><button type="submit" class="btn primary">${T.bibSave}</button><button type="button" class="btn" data-act="cancel-edit">${T.bibCancel}</button></div></form>`;
      const fields = detail.querySelector('.bib-edit-fields');
      fields.querySelectorAll('textarea').forEach(fit);
      fields.addEventListener('input', ev => { if (ev.target.matches('textarea')) fit(ev.target); });
      // 幅が変わると折り返しが変わるので高さを合わせ直す
      let width = 0;
      fitting = new ResizeObserver(([entry]) => {
        if (entry.contentRect.width === width) return;
        width = entry.contentRect.width;
        fields.querySelectorAll('textarea').forEach(fit);
      });
      fitting.observe(fields);
      detail.querySelector('[name=year], [name=date]').focus();
      return;
    }
    if (act === 'cancel-edit') { if (!saving) { editing = null; show(); } return; }
    const verify = ev.target.closest('[data-act=verify]');
    if (verify) {
      const key = current; verify.disabled = true;
      try { await options.verify(key); toast(T.bibVerified); }
      catch (err) { toast(err.message); }
      finally { verify.disabled = false; }
      return;
    }
    const page = ev.target.closest('[data-page]');
    if (page) { options.go?.(+page.dataset.page); return; }
    if (!ev.target.closest('[data-act=copy]')) return;
    try { await navigator.clipboard.writeText(`[@${current}]`); toast(T.bibCopied); } catch (err) { toast(err.message); }
  });
  detail.addEventListener('submit', async ev => {
    if (!ev.target.matches('.bib-edit')) return;
    ev.preventDefault();
    if (saving || !editing) return;
    const changes = Object.fromEntries([...new FormData(ev.target)].filter(([k, v]) => v !== (editing.fields[k] || '')));
    if (!Object.keys(changes).length) { editing = null; show(); return; }
    saving = true;
    ev.target.querySelectorAll('button, textarea').forEach(el => { el.disabled = true; });
    try {
      await options.save(editing.key, changes, editing.raw);
      editing = null; draw(); toast(T.bibSaved);
    } catch (err) { toast(err.message); }
    finally {
      saving = false;
      detail.querySelectorAll('button, textarea').forEach(el => { el.disabled = false; });
    }
  });

  return {
    select(key) {
      filter = 'all';
      input.value = key; current = key; draw();
      if (!items.some(e => e.key === key)) detail.textContent = T.bibMissing(key);
      list.focus({preventScroll: true});
    },
    update(data) {
      items = data.bib; titles = Object.fromEntries(data.recent.map(d => [d.deck, d.title]));
      const note = data.bib_error ? T.bibError : items.length ? '' : T.noBib;
      $('.bib').hidden = $('.bib-search').hidden = !!note;
      $('.bib-note').hidden = !note; $('.bib-note').textContent = note;
      $('.sec-count').textContent = items.length ? T.bibCount(items.length) : '';
      draw();
    },
  };
}
