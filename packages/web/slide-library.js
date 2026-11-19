import { slideInsertionPositions } from './slide-insertion.js';
import { api, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';
import { structureOf } from './structure.js';

export function makeSlideLibrary(ctx) {
 const s = S.slideLibrary;
 const trigger = tip(Object.assign(document.createElement('button'), {type: 'button', className: 'ibtn slide-library-trigger', innerHTML: svg('slideSearch')}), s.open);
 ctx.root.querySelector('#stripTools').append(trigger);
 let dialog = null, generation = 0, observer = null;
 const close = () => { generation++; observer?.disconnect(); dialog?.close(); dialog?.remove(); dialog = null; trigger.focus(); };
 const open = (position = null) => {
  if (dialog || ctx.locked) return;
  const box = document.createElement('dialog'); dialog = box; box.className = 'slide-library';
  box.setAttribute('aria-label', s.open);
  const header = document.createElement('header'); header.className = 'sl-head';
  const heading = document.createElement('div');
  const subtitle = Object.assign(document.createElement('p'), {textContent: s.subtitle});
  const title = Object.assign(document.createElement('h2'), {textContent: s.open});
  const closer = Object.assign(document.createElement('button'), {type: 'button', className: 'ibtn', innerHTML: svg('x')}); closer.setAttribute('aria-label', s.close); closer.onclick = close;
  const back = Object.assign(document.createElement('button'), {type: 'button', className: 'ibtn', innerHTML: svg('chevL'), hidden: true});
  back.setAttribute('aria-label', s.back);
  heading.append(title, subtitle); header.append(back, heading, closer);
  const form = document.createElement('form'); form.className = 'sl-search';
  const searchIcon = document.createElement('span'); searchIcon.innerHTML = svg('search'); searchIcon.setAttribute('aria-hidden', 'true');
  const input = Object.assign(document.createElement('input'), {type: 'search', placeholder: s.placeholder}); input.setAttribute('aria-label', s.placeholder);
  const search = Object.assign(document.createElement('button'), {type: 'submit', className: 'btn ghost sm', textContent: s.search}); form.append(searchIcon, input, search);
  const status = document.createElement('p'); status.className = 'sl-status'; status.setAttribute('role', 'status');
  const list = document.createElement('div'); list.className = 'slide-library-results';
  const take = Object.assign(document.createElement('button'), {type: 'button', className: 'btn primary', innerHTML: svg('plus') + `<span>${position ? s.take : s.choosePosition}</span>`, disabled: true});
  const append = Object.assign(document.createElement('button'), {type: 'button', className: 'btn ghost', textContent: s.append, disabled: true});
  const footer = document.createElement('footer'); footer.className = 'sl-footer';
  const selection = Object.assign(document.createElement('strong'), {textContent: s.selection(0)});
  const destination = Object.assign(document.createElement('span'), {textContent: s.destination(ctx.deck)});
  const summary = document.createElement('div'); summary.className = 'sl-summary'; summary.append(selection, destination);
  const clear = Object.assign(document.createElement('button'), {type: 'button', className: 'btn ghost', textContent: s.clear, hidden: true});
  footer.append(summary, clear, take, append);
  const toolbar = document.createElement('div'); toolbar.className = 'sl-toolbar'; toolbar.append(form, status);
  const results = document.createElement('div'); results.className = 'sl-scroll'; results.append(list);
  box.append(header, toolbar, results, footer); document.body.append(box); box.showModal(); input.focus();
  box.addEventListener('cancel', e => {e.preventDefault(); if (!busy) close();});
  let selected = new Set(), busy = false, sourceDeck = null;
  back.onclick = () => {sourceDeck = null; input.value = ''; form.requestSubmit();};
  const syncSelection = () => {take.disabled = append.disabled = !selected.size; selection.textContent = s.selection(selected.size); clear.hidden = !selected.size;};
  clear.onclick = () => {selected.clear(); list.querySelectorAll('input').forEach(el => el.checked = false); syncSelection();};
  form.onsubmit = async e => {
   e.preventDefault(); if (busy) return;
   observer?.disconnect();
   back.hidden = !sourceDeck; title.textContent = sourceDeck || s.open; subtitle.textContent = sourceDeck ? s.pages : s.subtitle;
   footer.hidden = !sourceDeck;
   const current = ++generation; selected = new Set(); syncSelection(); list.replaceChildren(); status.textContent = s.searching;
   try {
    const params = new URLSearchParams({q: input.value, exclude: ctx.deck, ...(sourceDeck ? {deck: sourceDeck} : {view: 'decks'})});
    const data = await api(`/api/slides/search?${params}`);
    if (generation !== current) return;
    status.textContent = (sourceDeck ? s.count(data.results.length) : s.decks(data.results.length)) + (data.skipped.length ? s.skipped(data.skipped.length) : '');
    if (!data.results.length) {
     const empty = document.createElement('div'); empty.className = 'sl-empty';
     const icon = document.createElement('span'); icon.innerHTML = svg('search');
     empty.append(icon, Object.assign(document.createElement('strong'), {textContent: s.empty}), Object.assign(document.createElement('p'), {textContent: s.emptyHint}));
     list.append(empty);
    }
    const byDeck = new Map();
    for (const result of data.results) {
     const card = document.createElement(sourceDeck ? 'label' : 'button'); card.className = sourceDeck ? 'slide-library-card' : 'slide-library-card sl-deck-card';
     if (!sourceDeck) {card.type = 'button'; card.dataset.deck = result.deck; card.onclick = () => {sourceDeck = result.deck; form.requestSubmit();};}
     const check = Object.assign(document.createElement('input'), {type: 'checkbox'});
     check.onchange = () => {check.checked ? selected.add(result) : selected.delete(result); syncSelection();};
     const thumb = Object.assign(document.createElement('div'), {className: 'slide-library-thumb', textContent: s.noThumb});
     const mark = Object.assign(document.createElement('span'), {className: 'sl-check', innerHTML: svg('check')}); mark.setAttribute('aria-hidden', 'true');
     const name = Object.assign(document.createElement('strong'), {textContent: sourceDeck ? result.title : result.deck, className: 'sl-card-title'});
     const origin = Object.assign(document.createElement('span'), {className: 'sl-origin', textContent: sourceDeck ? result.deck : s.pageCount(result.count)});
     const number = Object.assign(document.createElement('span'), {className: 'sl-page', textContent: String(result.page + 1).padStart(2, '0')});
     const meta = document.createElement('div'); meta.className = 'sl-card-meta'; meta.append(origin, number);
     card.title = result.excerpt;
     if (sourceDeck) card.append(check);
     card.append(thumb); if (sourceDeck) card.append(mark);
     card.append(name, meta); list.append(card);
     if (!byDeck.has(result.deck)) byDeck.set(result.deck, []);
     byDeck.get(result.deck).push({result, thumb, card});
    }
    // Resolve page → rendered slide explicitly; generated covers/TOCs shift indices.
    const loadDeck = async (deck, cards) => {
     if (generation !== current) return;
     try {
      const d = await api(`/api/deck/${encodeURIComponent(deck)}`);
      const update = async () => {
       const shots = await api(`/api/deck/${encodeURIComponent(deck)}/shots`);
       if (generation !== current) return;
       for (const {result, thumb} of cards) {
        if (d.version !== result.version) { thumb.textContent = s.changed; continue; }
        const slide = d.render.slides.find(p => p.page === result.page);
        const url = shots.slides[slide?.index]?.filter(Boolean).at(-1);
        if (url) thumb.replaceChildren(Object.assign(new Image(), {src: url, alt: result.title, loading: 'lazy'}));
       }
      };
      await update();
      // Newly opened decks may still be producing their first thumbnails.
      for (const delay of [1500, 4000, 10000]) setTimeout(() => {if (generation === current) update().catch(() => {});}, delay);
     } catch { /* Keep the source excerpt available when rendering fails. */ }
    };
    let pending = Promise.resolve();
    const queued = new Set();
    observer = new IntersectionObserver(entries => {
     for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const deck = entry.target.dataset.deck;
      if (queued.has(deck)) continue;
      queued.add(deck);
      pending = pending.then(() => loadDeck(deck, byDeck.get(deck)));
     }
    }, {root: results, rootMargin: '200px'});
    for (const [deck, cards] of byDeck) for (const {card} of cards) {card.dataset.deck = deck; observer.observe(card);}
   } catch (e) {if (generation === current) status.textContent = e.message;}
  };
  const importPages = async target => {
   if (busy || ctx.locked || !selected.size) return;
   if (target.text !== ctx.text) {status.textContent = s.positionChanged; position = null; take.querySelector('span').textContent = s.choosePosition; return;}
   busy = true; back.disabled = true; take.disabled = append.disabled = true; search.disabled = true; closer.disabled = true; clear.disabled = true;
   box.querySelectorAll('input').forEach(el => el.disabled = true);
   status.textContent = s.importing;
   try {
    if (!await ctx.flush()) throw Error(S.saveFirst);
    const original = ctx.text, structure = await structureOf(original);
    if (original !== target.text) throw Error(s.positionChanged);
    if (!slideInsertionPositions(structure).includes(target.before)) throw Error(s.invalidPosition);
    const next = structure.pages.find(p => p.index === target.before);
    const at = next ? next.start : original.length;
    const parts = [];
    for (const item of [...selected].sort((a, b) => a.page - b.page)) parts.push((await api(`/api/deck/${encodeURIComponent(ctx.deck)}/slides/take`, {method: 'POST', body: item})).text);
    if (ctx.locked) throw Error(S.locked);
    if (ctx.text !== original) throw Error(s.positionChanged);
    const prefix = original.slice(0, at), suffix = original.slice(at);
    const separator = prefix.endsWith('\n\n') ? '' : prefix.endsWith('\n') ? '\n' : '\n\n';
    ctx.setText(prefix + separator + parts.join('\n\n') + '\n\n' + suffix);
    if (!await ctx.flush()) throw Error(S.saveFirst);
    toast(s.imported(parts.length)); close();
   } catch (e) {status.textContent = e.message;}
   finally {busy = false; back.disabled = false; take.disabled = append.disabled = !selected.size; search.disabled = false; closer.disabled = false; clear.disabled = false; box.querySelectorAll('input').forEach(el => el.disabled = false);}
  };
  append.onclick = () => {void importPages({before: slideInsertionPositions(ctx.structure).at(-1), text: ctx.text});};
  take.onclick = () => {
   if (busy || !selected.size) return;
   if (position) {void importPages(position); return;}
   box.close();
   ctx.chooseSlideInsertion(target => {
    if (dialog !== box) return;
    box.showModal();
    if (target) void importPages(target);
   });
  };
  form.requestSubmit();
 };
 trigger.onclick = () => open();
 ctx.openSlideLibrary = open;
 return {destroy() {close(); trigger.remove(); delete ctx.openSlideLibrary;}};
}
