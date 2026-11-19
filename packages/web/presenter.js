import { installExternalLinks } from './external-links.js';
import { api, toast } from './api.js';
import { S } from './strings.js';
import { svg } from './icons.js';
import { structureOf } from './structure.js';
import { countedSlides, RehearsalClock, rehearsalRecord } from './presentation-model.js';
import { AgentClient, capabilityUrl, createGeneration, createNonce, requestPreviewCapability } from './bridge/agent-client.js';
const P = S.speaker;
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, fn) => { const b = el('button', 'btn', text); b.type = 'button'; b.onclick = fn; return b; };
const paintIcon = (b, label, icon) => { b.classList.remove('btn'); b.classList.add('ibtn'); b.innerHTML = svg(icon); b.setAttribute('aria-label', label); b.dataset.tip = label; return b; };
const iconButton = (label, icon, fn) => paintIcon(button(label,fn),label,icon);
const format = ms => { const seconds = Math.floor(Math.abs(ms) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
export function makePresenter(ctx) {
  let session, result, busy = false, alive = true, slideWidth = 55, currentHeight = 60;
  ctx.openPresenter = start;
  async function start(rehearsal) {
    if (busy || session || result?.open || ctx.presenting || document.querySelector('.present-screen')) return;
    busy = true;
    let s;
    try {
      if (!await ctx.flush()) throw Error(S.saveFirst);
      const source = ctx.text, structure = await structureOf(source), generation = createGeneration();
      const capability = await requestPreviewCapability(api, {deck:ctx.deck, version:ctx.version, mode:'present', generation});
      if (!alive) return;
      const box = el('section', 'speaker-screen'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', rehearsal ? P.rehearsal : P.title);
      const header = el('header', 'speaker-header'); header.append(el('strong', '', rehearsal ? P.rehearsal : P.title));
      const durationLabel = el('label', '', P.duration), duration = el('input'); duration.type = 'number'; duration.min = '1'; duration.max = '1440'; duration.value = '20'; duration.setAttribute('aria-label', P.duration); durationLabel.append(duration);
      const endLabel = el('label', '', P.countEnd), end = el('select'); end.setAttribute('aria-label', P.countEnd);
      for (const [value, label] of [['refs',P.beforeRefs],['all',P.all],...structure.pages.filter(p => p.level === 2).map(p => [String(p.index),p.title])]) { const opt = el('option','',label); opt.value = value; end.append(opt); } endLabel.append(end);
      const progress = el('output','speaker-progress'), timer = el('output','speaker-timer'), elapsed = el('span','speaker-elapsed');
      const toggle = button(P.start, () => { if (s.clock.running) { s.clock.pause(); paintIcon(toggle,P.resume,'play'); } else { s.clock.start(); paintIcon(toggle,P.pause,'pause'); duration.disabled = true; } drawTime(); });
      paintIcon(toggle,P.start,'play'); toggle.classList.add('speaker-clock-toggle');
      const finishButton = iconButton(P.finish,'x', () => finish());
      const timing = el('div','speaker-timing'); timing.append(progress,timer,elapsed,toggle);
      header.append(timing);
      const controls = el('details','speaker-controls');
      const settingsToggle = el('summary','ibtn'); settingsToggle.innerHTML = svg('sliders'); settingsToggle.setAttribute('aria-label',P.options); settingsToggle.dataset.tip = P.options;
      const settingsBody = el('div','speaker-options'); settingsBody.append(el('strong','',P.options),durationLabel,endLabel); controls.append(settingsToggle,settingsBody);
      box.addEventListener('click', e => { if (!controls.contains(e.target)) controls.open = false; });
      const projection = iconButton(P.projection,'monitorOut', () => openProjection());
      const fontLabel = el('label','',P.fontSize), font = el('input'); font.type = 'range'; font.min = '14'; font.max = '36'; font.value = '20'; font.setAttribute('aria-label',P.fontSize); box.style.setProperty('--speaker-font', `${font.value}px`); font.oninput = () => box.style.setProperty('--speaker-font', `${font.value}px`); fontLabel.append(font);
      const connection = el('span','speaker-connection'); connection.setAttribute('aria-label',P.projectionClosed); connection.title = P.projectionClosed;
      settingsBody.append(fontLabel,el('small','',P.shortcuts));
      const actions = el('div','speaker-actions'); actions.append(projection,connection,controls,finishButton); header.append(actions);
      const body = el('div','speaker-body'), slides = el('div','speaker-slides'), current = el('div','speaker-current'), next = el('div','speaker-next');
      current.append(el('h3','',P.current)); next.append(el('h3','',P.next));
      const nextStatus = el('span','speaker-next-status'); next.append(nextStatus);
      const nav = el('div','speaker-nav'); nav.append(iconButton(P.prev,'chevL', () => s.main.api.move(-1).catch(fail)),iconButton(P.forward,'chevR', () => s.main.api.move(1).catch(fail)));
      const currentHead = el('div','speaker-slide-head'); currentHead.append(current.querySelector('h3'),nav); current.append(currentHead);
      const notes = el('div','speaker-notepad');
      function makeDivider(label, vertical, initial, first, second, apply) {
        const handle = el('div', `speaker-divider${vertical ? '' : ' speaker-slide-divider'}`);
        handle.tabIndex = 0; handle.setAttribute('role','separator'); handle.setAttribute('aria-label',label);
        handle.setAttribute('aria-orientation',vertical ? 'vertical' : 'horizontal');
        handle.setAttribute('aria-valuemin','30'); handle.setAttribute('aria-valuemax','70');
        let value = initial, drag = null;
        function set(valueNext) {
          value = Math.max(30,Math.min(70,valueNext)); apply(value);
          handle.setAttribute('aria-valuenow',String(Math.round(value)));
        }
        set(value);
        handle.onpointerdown = e => {
          if (e.button !== 0 || drag) return;
          e.preventDefault(); handle.focus(); handle.setPointerCapture(e.pointerId);
          const dimension = vertical ? 'width' : 'height';
          drag = {id:e.pointerId, start:vertical ? e.clientX : e.clientY, value,
            available:first.getBoundingClientRect()[dimension] + second.getBoundingClientRect()[dimension]};
          box.classList.add(vertical ? 'resizing' : 'resizing-slides');
        };
        handle.onpointermove = e => {
          if (drag?.id === e.pointerId && drag.available > 0)
            set(drag.value + ((vertical ? e.clientX : e.clientY) - drag.start) / drag.available * 100);
        };
        const stop = e => {
          if (drag?.id !== e.pointerId) return;
          drag = null; box.classList.remove(vertical ? 'resizing' : 'resizing-slides');
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        };
        handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = stop;
        handle.onkeydown = e => {
          const decrease = vertical ? 'ArrowLeft' : 'ArrowUp', increase = vertical ? 'ArrowRight' : 'ArrowDown';
          if (![decrease,increase,'Home','End'].includes(e.key)) return;
          e.preventDefault(); e.stopPropagation();
          set(e.key === 'Home' ? 30 : e.key === 'End' ? 70 : value + (e.key === increase ? 1 : -1) * (e.shiftKey ? 5 : 1));
        };
        return handle;
      }
      const slideDivider = makeDivider(P.ratio,false,currentHeight,current,next,value => {
        currentHeight = value; current.style.flex = String(value); next.style.flex = String(100 - value);
      });
      slides.append(current,slideDivider,next);
      const divider = makeDivider(P.width,true,slideWidth,slides,notes,value => {
        slideWidth = value; box.style.setProperty('--speaker-left',String(value / 100));
      });
      body.append(slides,divider,notes); box.append(header,body); document.body.append(box);
      s = session = { box, rehearsal, clock:new RehearsalClock(), structure, generation, capability,
        clients:[], popup:null, projectionId:createNonce(), index:0, step:0, ready:false, closing:false, wasInert:ctx.root.inert,
        toggle, connection, nextStatus, progress, timer, elapsed, pendingInputs:0 };
      ctx.presenting = true; ctx.root.inert = true;
      function fail(e) { if (!s?.closing && session === s) toast(e?.message || P.startError); }
      async function frame(host, title, onSnapshot) {
        const f = el('iframe'); f.title = title; if (title === P.next) f.tabIndex = -1;
        const nonce = createNonce();
        const client = new AgentClient({frame:f,deck:ctx.deck,version:capability.version,generation,nonce,adminOrigin:location.origin,contentOrigin:capability.origin,onSnapshot,onFailure:fail});
        s.clients.push(client); client.start(); f.src = capabilityUrl(capability.url,{nonce,mode:'present',generation}); host.append(f);
        const resize = new ResizeObserver(() => { if (client.snapshot) client.api.resize().catch(() => {}); }); resize.observe(f); s.clients.push({destroy:()=>resize.disconnect()});
        await client.ready; if (!alive || session !== s) throw Error(P.startError); return client;
      }
      s.main = await frame(current,P.current, snapshot => { if (s.ready) changed(snapshot); });
      s.main.on('key', data => {
        if (data.type !== 'keydown' || data.repeat) return;
        if (data.key === 'Escape') void finish();
        if (data.key === 'f') toggleFullscreen();
      });
      installExternalLinks(s.main);
      function toggleFullscreen() {
        const action = document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen();
        action.catch(() => {});
      }
      s.next = await frame(next,P.next, null);
      s.notes = ctx.speakerNotes.createView(notes, () => {
        const frozen = s.main?.snapshot?.slides[s.index];
        const page = structure.pages[frozen?.page];
        return page ? {id:page.id,index:page.index,title:page.title} : null;
      }, {slideNumber: () => s.index + 1, autoGrow: false});
      s.ready = true; changed(s.main.snapshot); s.interval = setInterval(drawTime, 200);
      end.onchange = () => changed(s.main.snapshot); duration.oninput = drawTime;
      function drawTime() {
        s.clock.tick(); const left = Math.max(1,Math.min(1440,Number(duration.value)||20))*60000 - s.clock.elapsed;
        timer.textContent = `${left < 0 ? P.overtime : P.remaining} ${format(left)}`; timer.classList.toggle('over',left < 0);
        elapsed.textContent = `${P.elapsed} ${format(s.clock.elapsed)}`;
        if (s.popup?.closed) { s.popup = null; connection.classList.remove('connected'); connection.title = P.projectionClosed; connection.setAttribute('aria-label',P.projectionClosed); }
      }
      function changed(snapshot) {
        box.classList.toggle('overview-open', !!snapshot.overviewOpen);
        const moved = s.index !== snapshot.index; s.index = snapshot.index; s.step = snapshot.step; s.clock.go(s.index);
        const counted = countedSlides(snapshot.slides,structure.pages,end.value === 'all' ? Infinity : end.value === 'refs' ? null : Number(end.value));
        progress.textContent = `${P.progress} ${counted.filter(i => i <= s.index).length} / ${counted.length}`;
        const nextIndex = snapshot.slides.find(slide => slide.index > s.index && !structure.pages[slide.page]?.skipped)?.index;
        next.hidden = nextIndex == null;
        slideDivider.hidden = next.hidden;
        nextStatus.textContent = snapshot.maxStep > s.step ? P.stages(snapshot.maxStep - s.step) : next.hidden ? P.last : '';
        if (!next.hidden && s.next.snapshot?.index !== nextIndex) s.next.api.go(nextIndex,0).catch(fail);
        if (moved) s.notes?.refresh();
        sendProjection('go',{index:s.index,step:s.step,blackout:!!s.main.snapshot.blackout}); drawTime();
      }
      function sendProjection(type, data={}) { if (s.popup && !s.popup.closed) s.popup.postMessage({speakerProjection:s.projectionId,type,...data},location.origin); }
      function openProjection() {
        if (s.popup && !s.popup.closed) { s.popup.focus(); return; }
        s.popup = window.open(`/web/projection.html#${s.projectionId}`,`projection-${s.projectionId}`,'popup,width=1100,height=720');
        if (!s.popup) toast(P.projectionBlocked);
      }
      s.message = e => {
        if (e.source !== s.popup || e.origin !== location.origin || e.data?.speakerProjection !== s.projectionId) return;
        const d = e.data;
        if (d.type === 'ready') sendProjection('init',{deck:ctx.deck,capability,generation,index:s.index,step:s.step,blackout:!!s.main.snapshot.blackout});
        if (d.type === 'connected') { connection.classList.add('connected'); connection.title = P.projectionHelp; connection.setAttribute('aria-label',P.projectionHelp); sendProjection('go',{index:s.index,step:s.step,blackout:!!s.main.snapshot.blackout}); }
        if (d.type === 'closed' || d.type === 'failure') { connection.classList.remove('connected'); connection.title = P.projectionClosed; connection.setAttribute('aria-label',P.projectionClosed); }
        if (d.type === 'position' && typeof d.blackout === 'boolean' && d.blackout !== !!s.main.snapshot.blackout) s.main.api.setBlackout(d.blackout).catch(fail);
        if (d.type === 'position' && Number.isSafeInteger(d.index) && Number.isSafeInteger(d.step) && (d.index !== s.index || d.step !== s.step)) s.main.api.go(d.index,d.step).catch(fail);
      };
      addEventListener('message',s.message);
      openProjection();
      s.keys = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (e.type !== 'keydown') return; if (controls.open) { controls.open = false; settingsToggle.focus(); } else s.main.api.presentationKey(e.type,'Escape',e.repeat).catch(fail); return; }
        if (e.target.closest?.('.speaker-divider')) return;
        if (e.target.closest?.('textarea,input,select,[contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Enter' && !s.pendingInputs && !s.main.snapshot.pageInput && e.target.closest?.('button,a')) return;
        if (e.isComposing || e.key === ' ' && e.target.closest?.('button,a')) return;
        if (e.key === 'f') {
          e.preventDefault(); e.stopImmediatePropagation();
          if (e.type === 'keydown' && !e.repeat) toggleFullscreen();
          return;
        }
        if (['ArrowRight','ArrowDown','ArrowLeft','ArrowUp',' ','o','b','B','Enter','Backspace'].includes(e.key) || /^[0-9]$/.test(e.key)) {
          e.preventDefault(); e.stopImmediatePropagation();
          const pendingInput = e.type === 'keydown' && !e.repeat && /^[0-9]$/.test(e.key);
          if (pendingInput) s.pendingInputs++;
          s.main.api.presentationKey(e.type,e.key,e.repeat).catch(fail).finally(() => { if (pendingInput) s.pendingInputs--; });
        }
      };
      addEventListener('keydown',s.keys,true); addEventListener('keyup',s.keys,true); current.querySelector('iframe').focus();
    } catch(e) { if (s) cleanup(s); toast(e.message || P.startError); }
    finally { busy = false; }
  }
  function cleanup(s) {
    clearInterval(s.interval); if (s.message) removeEventListener('message',s.message); if(s.keys) { removeEventListener('keydown',s.keys,true); removeEventListener('keyup',s.keys,true); }
    if (document.fullscreenElement === s.box) document.exitFullscreen().catch(() => {});
    s.popup?.close(); s.notes?.destroy(); for (const c of s.clients) c.destroy(); s.box.remove(); ctx.root.inert = s.wasInert; ctx.presenting = false; session = null;
  }
  async function finish() {
    const s = session; if (!s || !s.ready || s.closing) return false;
    s.closing = true; busy = true; s.clock.pause(); paintIcon(s.toggle,P.resume,'play');
    try {
      if (!await ctx.flush()) return false;
      const id = s.main.snapshot.slides[s.index]?.id, index = ctx.preview.slides.findIndex(p => p.id === id);
      const record = s.rehearsal ? rehearsalRecord(s.clock,s.main.snapshot.slides,s.structure.pages) : null;
      cleanup(s); await ctx.preview.go(index >= 0 ? index : s.index,s.step); ctx.root.querySelector('.present-tools > button')?.focus();
      if (record) {
        let previous = null, saved = true;
        try {
          const measured = record.pages.some(p => p.visited);
          ({previous} = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/rehearsals`, measured ? {method:'PUT',body:record} : {}));
        } catch { saved = false; }
        if (alive) showResult(record,previous,saved);
      }
      return true;
    } catch(e) { toast(P.finishError); return false; }
    finally { s.closing = false; busy = false; }
  }
  function showResult(record,previous,saved) {
    const dialog = result = el('dialog','rehearsal-result'); dialog.setAttribute('aria-label',P.result);
    dialog.append(el('h2','',P.result));
    if (!previous && saved) dialog.append(el('p','',P.noPrevious));
    else if (previous) dialog.append(el('p','',`${P.previous}: ${new Date(previous.date).toLocaleString()}`));
    if (!saved) dialog.append(el('p','',P.recordError));
    const table = el('table'), head = el('tr');
    for (const title of [P.page,P.thisRun,P.previous,P.difference]) head.append(el('th','',title));
    const thead = el('thead'); thead.append(head); table.append(thead);
    const body = el('tbody'), diff = (a,b) => b == null ? '—' : `${a < b ? '−' : a > b ? '+' : ''}${format(a-b)}`;
    function row(title,ms,old,visited=true) {
      const tr = el('tr');
      for (const value of [title,visited ? format(ms) : P.unvisited,old == null ? '—' : format(old),visited ? diff(ms,old) : '—']) tr.append(el('td','',value));
      body.append(tr);
    }
    for (const page of record.pages) {
      const old = previous?.pages.find(p => p.id === page.id && p.visited);
      row(`${P.pageNumber(page.number)} ${page.title}`,page.ms,old?.ms,page.visited);
    }
    row(P.total,record.elapsed,previous?.elapsed); table.append(body); dialog.append(table);
    const close = button(P.close,() => dialog.close()); dialog.append(close);
    dialog.addEventListener('keydown',e => e.stopPropagation()); dialog.addEventListener('keyup',e => e.stopPropagation());
    dialog.onclose = () => { result = null; dialog.remove(); ctx.root.querySelector('.present-tools > button')?.focus(); };
    document.body.append(dialog); dialog.showModal(); close.focus();
  }
  return { destroy() { alive = false; result?.remove(); result = null; if(session) cleanup(session); delete ctx.openPresenter; } };
}
