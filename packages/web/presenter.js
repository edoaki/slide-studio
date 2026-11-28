import { installExternalLinks } from './external-links.js';
import { api, toast } from './api.js';
import { S } from './strings.js';
import { svg } from './icons.js';
import { tip } from './tip.js';
import { studioSelect } from './custom-select.js';
import { structureOf } from './structure.js';
import { countablePages, countedSlides, PresentationClock, pointerPrefs, paintPointer, POINTER_STYLES, POINTER_COLORS, POINTER_SIZES } from './presentation-model.js';
import { AgentClient, capabilityUrl, createGeneration, createNonce, requestPreviewCapability } from './bridge/agent-client.js';
import { HOST_KEYS, PRESENTATION_KEYS } from './bridge/protocol.js';
const P = S.speaker;
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, fn) => { const b = el('button', 'btn', text); b.type = 'button'; b.onclick = fn; return b; };
const paintIcon = (b, label, icon) => { b.classList.remove('btn'); b.classList.add('ibtn'); b.innerHTML = svg(icon); b.setAttribute('aria-label', label); b.dataset.tip = label; return b; };
const iconButton = (label, icon, fn) => paintIcon(button(label,fn),label,icon);
const format = ms => { const seconds = Math.floor(Math.abs(ms) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
// 持ち時間・タイマーの表示・メモの文字サイズ・ペインの比率は、次に開いたときも同じにする
const PREFS = 'slide-studio.presenter', FONT_MIN = 12, FONT_MAX = 40, FONT_STEP = 2;
const loadPrefs = () => { try { const v = JSON.parse(localStorage.getItem(PREFS)); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const savePrefs = patch => { try { localStorage.setItem(PREFS, JSON.stringify({...loadPrefs(), ...patch})); } catch { /* 覚えられなくても動く */ } };
const clamp = (v, min, max, fallback) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
// 数字の入力欄。全角数字は半角に直し、数字以外は入れない
const halfWidth = v => String(v).replace(/[０-９]/g,d => String(d.charCodeAt(0) - 0xff10));
const toNumber = v => Number(halfWidth(v));
function numberField(label, maxLength = 4) {
  const input = el('input','speaker-number'); input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'off'; input.setAttribute('aria-label',label);
  // 日本語入力の変換中に書き換えると確定前の文字が崩れるので、確定してから直す
  const normalize = () => {
    const value = halfWidth(input.value).replace(/[^0-9]/g,'').slice(0,maxLength);
    if (value !== input.value) input.value = value;
  };
  input.addEventListener('input', e => { if (!e.isComposing) normalize(); });
  input.addEventListener('compositionend', normalize);
  input.addEventListener('focus', () => input.select());
  return input;
}
// 進捗に数えるページを選ぶ一覧。押したページまでを数える。章扉・参考文献など数えないページは押せない
function countPicker(pages) {
  const countable = countablePages(pages), total = countable.length;
  const panel = el('div','speaker-popup speaker-count-panel'); panel.setAttribute('role','dialog'); panel.setAttribute('aria-label',P.countEnd); panel.hidden = true;
  const head = el('label','speaker-count-head'), input = numberField(P.countValue);
  head.append(input,el('span','',P.countHint(total)));
  const list = el('div','speaker-count-list'), items = [];
  for (const page of pages) {
    if (page.level === 1) { list.append(el('div','speaker-count-chapter',page.title)); continue; }
    const k = countable.indexOf(page) + 1, item = el(k ? 'button' : 'div','speaker-count-page');
    item.append(el('span','speaker-count-num',k ? String(k) : ''),el('span','speaker-count-title',page.title));
    if (k) { item.type = 'button'; item.dataset.count = String(k); items.push(item); } else item.setAttribute('aria-disabled','true');
    item.dataset.page = String(page.index); list.append(item);
  }
  if (!total) list.append(el('p','speaker-count-help',P.countEmpty));
  panel.append(el('strong','',P.countEnd),head,el('p','speaker-count-help',P.countHelp),list);
  return { panel, input, list, items, total };
}
// ポインターの形・色・大きさ。ポインターが OFF の間も変えられ、投影用ウィンドウにすぐ反映する
function pointerFields(pointer, onChange) {
  const group = el('div', 'speaker-pointer-options');
  const choice = (key, label, values, names, className) => {
    const select = studioSelect({ label, value: pointer[key], variant: 'segmented', className, options: values.map(value => ({ value, label: names[value] })) });
    select.onchange = () => { pointer[key] = select.value; onChange(); };
    const box = el('label', '', P.pointerLabels[key]); box.append(select); return box;
  };
  group.append(
    choice('style', P.pointerStyle, POINTER_STYLES, P.pointerStyles),
    choice('color', P.pointerColor, Object.keys(POINTER_COLORS), P.pointerColors, 'speaker-pointer-color'),
    choice('size', P.pointerSize, POINTER_SIZES, P.pointerSizes));
  return group;
}
export function makePresenter(ctx) {
  let session, busy = false, alive = true;
  ctx.openPresenter = start;
  async function start() {
    if (busy || session || ctx.presenting || document.querySelector('.present-screen')) return;
    busy = true;
    let s;
    try {
      if (!await ctx.flush()) throw Error(S.saveFirst);
      const source = ctx.text, structure = await structureOf(source), generation = createGeneration();
      const capability = await requestPreviewCapability(api, {deck:ctx.deck, version:ctx.version, mode:'present', generation});
      if (!alive) return;
      const box = el('section', 'speaker-screen'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', P.title);
      const header = el('header', 'speaker-header'); header.append(el('strong', '', P.title));
      const prefs = loadPrefs();
      let timerMode = prefs.timerMode === 'elapsed' ? 'elapsed' : 'remaining';
      // 持ち時間（秒）。大きい時間表示を押すと、その場で分と秒を打ち込める。以前の分単位の設定も読む
      const DURATION_MAX = 1440*60;
      let durationSec = Math.round(clamp(prefs.durationSec ?? (typeof prefs.duration === 'number' ? prefs.duration*60 : undefined),1,DURATION_MAX,20*60));
      const timer = button('', () => editDuration()); timer.className = 'speaker-timer'; timer.dataset.tip = P.durationTip;
      const durationBox = el('label','speaker-duration'), durationInput = numberField(P.duration), secondsInput = numberField(P.durationSeconds,2);
      durationBox.append(el('span','',P.durationLabel),durationInput,el('span','',P.minutes),secondsInput,el('span','',P.seconds)); durationBox.hidden = true;
      // label の中を押すと先頭の入力欄へ移るので、秒の欄を押したときはそのまま秒の欄に置く
      durationBox.addEventListener('click', e => { if (e.target === secondsInput) e.preventDefault(); });
      const durationText = () => { const m = Math.floor(durationSec/60), sec = durationSec%60; return sec ? `${m}${P.minutes}${sec}${P.seconds}` : `${m}${P.minutes}`; };
      function editDuration() {
        durationInput.value = String(Math.floor(durationSec/60)); secondsInput.value = String(durationSec%60).padStart(2,'0');
        timer.hidden = true; durationBox.hidden = false; durationInput.focus();
      }
      function closeDuration(save) {
        if (durationBox.hidden) return;
        const minutes = durationInput.value === '' ? 0 : Math.round(toNumber(durationInput.value));
        const seconds = secondsInput.value === '' ? 0 : Math.round(toNumber(secondsInput.value));
        const value = minutes*60 + Math.min(59,seconds);
        if (save && Number.isFinite(value) && value >= 1) { durationSec = Math.min(DURATION_MAX,value); savePrefs({durationSec}); }
        durationBox.hidden = true; timer.hidden = false; drawTime();
      }
      for (const input of [durationInput,secondsInput]) {
        input.onkeydown = e => {
          if (e.isComposing || !['Enter','Escape'].includes(e.key)) return;
          e.preventDefault(); closeDuration(e.key === 'Enter'); timer.focus();
        };
        // 分と秒の欄を行き来するあいだは閉じない
        input.onblur = e => { if (!durationBox.contains(e.relatedTarget)) closeDuration(true); };
      }
      // 進捗の数え方。「進捗 ◯ / ◯」を押すと、ページ数の入力欄とページの一覧が出る（既定は参考文献の手前まで）
      const picker = countPicker(structure.pages);
      const beforeRefs = countedSlides(structure.pages.map(p => ({index:p.index,page:p.index})),structure.pages).length;
      let countTo = beforeRefs || picker.total;
      const progress = button('', () => { if (picker.panel.hidden) openCount(); else closeCount(); });
      progress.className = 'speaker-progress'; progress.dataset.tip = P.countTip; progress.setAttribute('aria-haspopup','dialog'); progress.setAttribute('aria-expanded','false'); progress.disabled = !picker.total;
      const countBox = el('div','speaker-count'); countBox.append(progress,picker.panel);
      function setCount(k, typed = false) {
        if (!picker.total) return;
        countTo = Math.max(1,Math.min(picker.total,Math.round(k) || 1));
        if (!typed) picker.input.value = String(countTo);
        paintCount(); if (s?.ready) paintProgress(s.main.snapshot);
      }
      function paintCount() {
        const page = String(s?.main?.snapshot?.slides[s.index]?.page ?? '');
        for (const item of picker.items) { const k = Number(item.dataset.count); item.classList.toggle('included',k <= countTo); item.setAttribute('aria-pressed',String(k === countTo)); }
        for (const item of picker.list.querySelectorAll('[data-page]')) if (item.dataset.page === page) item.setAttribute('aria-current','page'); else item.removeAttribute('aria-current');
      }
      function openCount() {
        picker.input.value = String(countTo); paintCount(); picker.panel.hidden = false; progress.setAttribute('aria-expanded','true');
        const end = picker.items[countTo - 1];
        if (end) picker.list.scrollTop = end.offsetTop - (picker.list.clientHeight - end.offsetHeight) / 2;
        picker.input.focus();
      }
      function closeCount(focus = false) {
        if (picker.panel.hidden) return;
        picker.panel.hidden = true; progress.setAttribute('aria-expanded','false');
        if (focus) progress.focus();
      }
      picker.input.addEventListener('input', () => { const n = toNumber(picker.input.value); if (n >= 1) setCount(n,true); });
      picker.input.onblur = () => { picker.input.value = String(countTo); };
      picker.input.onkeydown = e => {
        if (e.isComposing || !['Enter','Escape'].includes(e.key)) return;
        e.preventDefault(); closeCount(true);
      };
      picker.list.onclick = e => {
        const item = e.target.closest?.('button[data-count]');
        if (item) { setCount(Number(item.dataset.count)); closeCount(true); }
      };
      // 小さく出ている方の時間を押すと、大きい表示と入れ替わる
      const elapsed = button('', () => { timerMode = timerMode === 'elapsed' ? 'remaining' : 'elapsed'; savePrefs({timerMode}); drawTime(); });
      elapsed.className = 'speaker-elapsed'; elapsed.innerHTML = svg('swap'); const elapsedText = el('span'); elapsed.append(elapsedText);
      const toggle = button(P.start, () => { if (s.clock.running) { s.clock.pause(); paintIcon(toggle,P.resume,'play'); } else { s.clock.start(); paintIcon(toggle,P.pause,'pause'); } drawTime(); });
      paintIcon(toggle,P.start,'play'); toggle.classList.add('speaker-clock-toggle');
      const finishButton = button(P.finish, () => finish()); finishButton.classList.add('speaker-finish');
      const timing = el('div','speaker-timing'); timing.append(countBox,timer,durationBox,elapsed,toggle);
      header.append(timing);
      const pointer = pointerPrefs(prefs.pointer);
      // 手元の現在のスライドにも、投影画面と同じポインターを重ねて見せる
      const laser = el('div','projection-pointer speaker-pointer'); laser.hidden = true; laser.setAttribute('aria-hidden','true');
      let pointerAt = {x:0,y:0,visible:false};
      const drawPointer = () => {
        const frame = current.querySelector('iframe');
        paintPointer(laser,pointer,{...pointerAt,visible:pointerAt.visible && !!frame},frame?.getBoundingClientRect() ?? {left:0,top:0,width:0,height:0});
      };
      const pointerChanged = () => { savePrefs({pointer:{...pointer}}); sendProjection('pointerStyle',{...pointer}); drawPointer(); paintToggle(); };
      // 一覧の外を押したら閉じる。区切り選択は押すとボタンを作り直すため、押された要素ではなくイベントの経路で内側かどうかを見る
      box.addEventListener('click', e => { if (!e.composedPath().includes(countBox)) closeCount(); });
      const projection = iconButton(P.projection,'monitorOut', () => openProjection());
      const connection = el('span','speaker-connection'); connection.setAttribute('aria-label',P.projectionClosed); connection.title = P.projectionClosed;
      // ポインターは見出しのボタンで示す。押すと ON/OFF が切り替わり、カーソルを合わせると下に形・色・大きさの設定が出る。
      // ボタンには矢印と今のポインターの見本を並べ、OFF の間は見本を灰色の輪にする
      const pointerToggle = button('', () => {
        pointer.enabled = !pointer.enabled; pointerChanged();
        if (!pointer.enabled) pointerAt = {x:0,y:0,visible:false};
        s.main?.api.trackPointer(pointer.enabled).catch(() => {});
      });
      pointerToggle.className = 'speaker-pointer-toggle'; pointerToggle.setAttribute('role','switch'); pointerToggle.setAttribute('aria-label',P.pointer);
      const pointerSwatch = el('span','speaker-pointer-swatch'); pointerToggle.innerHTML = svg('cursor'); pointerToggle.append(pointerSwatch);
      const pointerPanel = el('div','speaker-popup speaker-pointer-panel'), pointerHead = el('div','speaker-pointer-head'), pointerState = el('span','speaker-pointer-state');
      pointerHead.append(el('strong','',P.pointer),pointerState);
      pointerPanel.append(pointerHead,el('p','speaker-pointer-help',P.pointerHelp),pointerFields(pointer, pointerChanged));
      const pointerMenu = el('div','speaker-pointer-menu'); pointerMenu.append(pointerToggle,pointerPanel);
      // 進捗の一覧と重ならないよう、ポインターの設定を出すときは一覧を閉じる
      pointerMenu.addEventListener('pointerenter', () => closeCount());
      function paintToggle() {
        pointerToggle.setAttribute('aria-checked',String(pointer.enabled)); pointerState.textContent = pointer.enabled ? P.pointerOn : P.pointerOff;
        pointerSwatch.dataset.style = pointer.style; pointerSwatch.dataset.size = pointer.size; pointerSwatch.style.setProperty('--pointer-color', POINTER_COLORS[pointer.color]);
      }
      paintToggle();
      const actions = el('div','speaker-actions'); actions.append(pointerMenu,projection,connection,finishButton); header.append(actions);
      const body = el('div','speaker-body'), slides = el('div','speaker-slides'), current = el('div','speaker-current'), next = el('div','speaker-next');
      // 次のスライドは見出しを押して折りたためる。開閉は次に開いたときも同じにする
      const nextToggle = el('button','speaker-next-toggle'); nextToggle.type = 'button';
      nextToggle.innerHTML = svg('chevD'); nextToggle.append(el('span','',P.next));
      const nextHead = el('h3'); nextHead.append(nextToggle); next.append(nextHead);
      const nextStatus = el('span','speaker-next-status'); next.append(nextStatus);
      function setNextOpen(open, remember = true) {
        slides.classList.toggle('next-collapsed',!open); nextToggle.setAttribute('aria-expanded',String(open));
        nextToggle.dataset.tip = open ? P.hideNext : P.showNext;
        if (remember) savePrefs({nextOpen:open});
      }
      nextToggle.onclick = () => setNextOpen(slides.classList.contains('next-collapsed'));
      setNextOpen(prefs.nextOpen !== false,false);
      // 進む・戻るは段階ごと。段階のあるページでは、段階を飛ばしてページを移るボタンも両脇に出す。
      // PageDown/PageUp（リモコン）もページ送りだが、説明には書かない
      const navButton = (label, icon, help, keys, fn) => { const b = iconButton(label,icon,fn); b.dataset.tip = help; b.dataset.keys = keys; return b; };
      const prevPage = navButton(P.prevPage,'chevsL',P.prevPageTip,'↑', () => goPage(-1));
      const back = navButton(P.prev,'chevL',P.prevTip,'←', () => s.main.api.move(-1).catch(fail));
      const forward = navButton(P.forward,'chevR',P.forwardTip,'→ Space', () => s.main.api.move(1).catch(fail));
      const nextPage = navButton(P.nextPage,'chevsR',P.nextPageTip,'↓', () => goPage(1));
      const nav = el('div','speaker-nav'); nav.append(prevPage,back,forward,nextPage);
      // 送る・戻るボタンはスライドの右上に置く。見出しは付けず、その分スライドを大きく見せる
      const currentHead = el('div','speaker-slide-head'); currentHead.append(nav); current.append(currentHead);
      function goPage(dir) {
        const target = shownSlides[shownSlides.findIndex(slide => slide.index === s.index) + dir];
        if (!target || shownPage < 1) return;
        endPreview(false); s.main.api.go(target.index,0).catch(fail);
      }
      // 現在のスライドの段階。カーソルを合わせた段階は手元の表示だけを切り替え（投影はそのまま）、押すと投影にも反映する
      const stepRow = el('div','speaker-steps'), stepTrack = el('div','speaker-step-track'), stepCount = el('output','speaker-step-count');
      stepTrack.setAttribute('role','group'); stepTrack.setAttribute('aria-label',P.steps); stepRow.append(stepTrack,stepCount);
      const stepPreview = el('span','speaker-step-preview'); stepPreview.hidden = true; stepPreview.setAttribute('aria-live','polite');
      // ページ番号・一覧・全画面のバーは、スライドに重ねずスライドの外の下に常に出す（上でカーソルを動かしてもポインターにならない）
      const footer = el('div','speaker-footer'), footerProgress = el('div','speaker-footer-progress'), footerFill = el('span');
      footerProgress.setAttribute('role','progressbar'); footerProgress.setAttribute('aria-label',S.present.progress); footerProgress.setAttribute('aria-valuemin','0'); footerProgress.setAttribute('aria-valuemax','100'); footerProgress.append(footerFill);
      // 一覧の横にページ番号の入力欄を置く。番号は飛ばすページを除いた通し番号で、Enter でそのページへ移る
      const PAGE_DIGITS = 6;
      const pageBox = el('label','speaker-footer-page'), pageField = numberField(P.pageJump,PAGE_DIGITS), pageTotal = el('span','speaker-footer-total');
      pageBox.dataset.tip = P.pageJumpHelp;
      pageBox.append(pageField,pageTotal);
      let shownSlides = [], shownPage = 0;
      const showPage = () => { pageField.value = shownPage ? String(shownPage) : ''; };
      pageField.onblur = showPage;
      function jumpPage() {
        const target = shownSlides[toNumber(pageField.value) - 1];
        if (!target) { showPage(); pageField.select(); return; }
        endPreview(true);
        s.main.api.go(target.index,0).catch(fail);
        current.querySelector('iframe')?.focus();
      }
      pageField.onkeydown = e => {
        if (e.key === 'Escape') { e.preventDefault(); showPage(); current.querySelector('iframe')?.focus(); }
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault(); jumpPage();
      };
      // スライドの上や投影用ウィンドウで数字を押したときは、スライドに番号を重ねて出さず、この欄に入れる。続けて押した数字は後ろに足す
      function typePage(digit) {
        if (s.main.snapshot?.overviewOpen) return;
        if (document.activeElement === pageField) pageField.setRangeText(digit,pageField.selectionStart ?? pageField.value.length,pageField.selectionEnd ?? pageField.value.length,'end');
        else { pageField.focus(); pageField.value = digit; }
        if (pageField.value.length > PAGE_DIGITS) pageField.value = pageField.value.slice(0,PAGE_DIGITS);
      }
      // 一覧（O）とページ番号の入力は発表者ビューが受け持つ。現在のスライドと投影用ウィンドウで押したキーもここで扱う
      function hostKey(key) {
        const typing = document.activeElement === pageField;
        if (/^[0-9]$/.test(key)) typePage(key);
        else if (key === 'Enter' && typing) jumpPage();
        else if (key === 'Backspace' && typing) pageField.value = pageField.value.slice(0,-1);
        else if (key === 'o') { endPreview(true); sendKey('o'); }
      }
      const sendKey = key => s.main.api.presentationKey('keydown',key).then(() => s.main.api.presentationKey('keyup',key)).catch(fail);
      const overviewButton = tip(iconButton(S.present.overview,'grid', () => { endPreview(true); sendKey('o'); }),S.present.overview,'O');
      const fullscreenButton = tip(iconButton(S.present.fullscreen,'fullscreen', () => toggleFullscreen()),S.present.fullscreen,'F');
      footer.append(footerProgress,pageBox,overviewButton,fullscreenButton);
      current.append(stepRow,stepPreview,footer);
      const notes = el('div','speaker-notepad'), pageNotes = el('div','speaker-note-pane speaker-note-page'), globalNotes = el('div','speaker-note-pane speaker-note-global');
      function makeDivider(label, vertical, initial, first, second, apply, min = 30, max = 70) {
        const handle = el('div', `speaker-divider${vertical ? '' : ' speaker-slide-divider'}`);
        handle.tabIndex = 0; handle.setAttribute('role','separator'); handle.setAttribute('aria-label',label);
        handle.setAttribute('aria-orientation',vertical ? 'vertical' : 'horizontal');
        handle.setAttribute('aria-valuemin',String(min)); handle.setAttribute('aria-valuemax',String(max));
        let value = initial, drag = null;
        function set(valueNext) {
          value = Math.max(min,Math.min(max,valueNext)); apply(value);
          handle.setAttribute('aria-valuenow',String(Math.round(value)));
        }
        set(value);
        handle.onpointerdown = e => {
          if (e.button !== 0 || drag) return;
          e.preventDefault(); handle.focus(); handle.setPointerCapture(e.pointerId);
          const dimension = vertical ? 'width' : 'height';
          drag = {id:e.pointerId, start:vertical ? e.clientX : e.clientY, value,
            available:first.getBoundingClientRect()[dimension] + second.getBoundingClientRect()[dimension]};
          box.classList.add(vertical ? 'resizing' : 'resizing-slides'); handle.classList.add('dragging');
        };
        handle.onpointermove = e => {
          if (drag?.id === e.pointerId && drag.available > 0)
            set(drag.value + ((vertical ? e.clientX : e.clientY) - drag.start) / drag.available * 100);
        };
        const stop = e => {
          if (drag?.id !== e.pointerId) return;
          drag = null; box.classList.remove(vertical ? 'resizing' : 'resizing-slides'); handle.classList.remove('dragging');
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        };
        handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = stop;
        handle.onkeydown = e => {
          const decrease = vertical ? 'ArrowLeft' : 'ArrowUp', increase = vertical ? 'ArrowRight' : 'ArrowDown';
          if (![decrease,increase,'Home','End'].includes(e.key)) return;
          e.preventDefault(); e.stopPropagation();
          set(e.key === 'Home' ? min : e.key === 'End' ? max : value + (e.key === increase ? 1 : -1) * (e.shiftKey ? 5 : 1));
        };
        return handle;
      }
      // 次のスライドは確認用なので、既定では小さく出す。以前の既定（60）が全員に保存されているため、保存名を変えて新しい既定を効かせる
      const slideDivider = makeDivider(P.ratio,false,clamp(prefs.currentRatio,30,85,75),current,next,value => {
        current.style.flex = String(value); next.style.flex = String(100 - value); savePrefs({currentRatio:value});
      },30,85);
      slides.append(current,slideDivider,next);
      const divider = makeDivider(P.width,true,clamp(prefs.slideWidth,30,70,55),slides,notes,value => {
        box.style.setProperty('--speaker-left',String(value / 100)); savePrefs({slideWidth:value});
      });
      // 上にページのメモ、下に全体のメモ
      const noteDivider = makeDivider(P.noteRatio,false,clamp(prefs.noteRatio,15,85,60),pageNotes,globalNotes,value => {
        pageNotes.style.flex = String(value); globalNotes.style.flex = String(100 - value); savePrefs({noteRatio:value});
      },15,85);
      noteDivider.classList.add('speaker-note-divider');
      notes.append(pageNotes,noteDivider,globalNotes);
      body.append(slides,divider,notes); box.append(header,body,laser); document.body.append(box);
      s = session = { box, clock:new PresentationClock(), structure, generation, capability,
        clients:[], popup:null, projectionId:createNonce(), index:0, step:0, preview:null, previewBusy:0, ready:false, closing:false, wasInert:ctx.root.inert,
        toggle, connection, nextStatus, progress, timer, elapsed, projectionOpen:false };
      ctx.presenting = true; ctx.root.inert = true;
      function fail(e) { if (!s?.closing && session === s) toast(e?.message || P.startError); }
      async function frame(host, title, onSnapshot) {
        // 名前は読み上げ用に付け、カーソルを合わせてもツールチップは出さない（スライドに重なって邪魔になる）
        const f = el('iframe'); f.setAttribute('aria-label',title); f.dataset.tipOff = ''; if (title === P.next) f.tabIndex = -1;
        const nonce = createNonce();
        const client = new AgentClient({frame:f,deck:ctx.deck,version:capability.version,generation,nonce,adminOrigin:location.origin,contentOrigin:capability.origin,onSnapshot,onFailure:fail});
        s.clients.push(client); client.start(); f.src = capabilityUrl(capability.url,{nonce,mode:'present',generation,footer:false,hostKeys:true}); host.insertBefore(f,host.querySelector(':scope > .speaker-steps'));
        const resize = new ResizeObserver(() => { if (client.snapshot) client.api.resize().catch(() => {}); }); resize.observe(f); s.clients.push({destroy:()=>resize.disconnect()});
        await client.ready; if (!alive || session !== s) throw Error(P.startError); return client;
      }
      s.main = await frame(current,P.current, snapshot => { if (s.ready) changed(snapshot); });
      s.main.on('key', data => {
        if (data.type !== 'keydown' || data.repeat) return;
        if (data.key === 'Escape') void finish();
        else if (data.key === 'f') toggleFullscreen();
        else hostKey(data.key);
      });
      installExternalLinks(s.main);
      // 現在のスライド上のカーソル位置（スライドに対する 0〜1）を投影用ウィンドウへ送る
      s.main.on('pointer', data => {
        if (!pointer.enabled && data.visible) return;
        pointerAt = {x:data.x,y:data.y,visible:data.visible}; drawPointer(); sendProjection('pointer',pointerAt);
      });
      if (pointer.enabled) s.main.api.trackPointer(true).catch(() => {});
      // 現在のスライドは手元の操作面。ポインターで指すときのクリックで投影が進まないよう、左右の端のクリックだけで送る
      s.main.api.edgeClicks(true).catch(() => {});
      function toggleFullscreen() {
        const action = document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen();
        action.catch(() => {});
      }
      s.next = await frame(next,P.next, null);
      const notePage = () => {
        const frozen = s.main?.snapshot?.slides[s.index];
        const page = structure.pages[frozen?.page];
        return page ? {id:page.id,index:page.index,title:page.title} : null;
      };
      s.notes = ctx.speakerNotes.createView(pageNotes, notePage, {slideNumber: () => s.index + 1, autoGrow: false, scope: 'page'});
      s.globalNotes = ctx.speakerNotes.createView(globalNotes, notePage, {slideNumber: () => s.index + 1, autoGrow: false, scope: 'global'});
      // メモの文字サイズは、ページのメモの見出しの右端で変える
      let noteFont = 20;
      const fontControl = el('div','speaker-font'); fontControl.setAttribute('role','group'); fontControl.setAttribute('aria-label',P.fontSize);
      const smaller = iconButton(P.fontSmaller,'minus', () => setFont(noteFont - FONT_STEP)), larger = iconButton(P.fontLarger,'plus', () => setFont(noteFont + FONT_STEP));
      const fontValue = el('output','speaker-font-value'); fontValue.setAttribute('aria-label',P.fontSize); fontValue.dataset.tip = P.fontSize;
      function setFont(value, remember = true) {
        noteFont = Math.round(clamp(value,FONT_MIN,FONT_MAX,20) / FONT_STEP) * FONT_STEP;
        box.style.setProperty('--speaker-font',`${noteFont}px`); fontValue.textContent = String(noteFont);
        smaller.disabled = noteFont <= FONT_MIN; larger.disabled = noteFont >= FONT_MAX;
        if (remember) savePrefs({noteFont});
      }
      setFont(prefs.noteFont,false); fontControl.append(smaller,fontValue,larger); s.notes.head.append(fontControl);
      s.ready = true; changed(s.main.snapshot); s.interval = setInterval(drawTime, 200);
      function drawTime() {
        s.clock.tick(); const left = durationSec*1000 - s.clock.elapsed;
        const remainingText = `${left < 0 ? P.overtime : P.remaining} ${format(left)}`, elapsedTime = `${P.elapsed} ${format(s.clock.elapsed)}`;
        const big = timerMode === 'elapsed', swapLabel = big ? P.showRemaining : P.showElapsed;
        timer.textContent = big ? elapsedTime : remainingText; timer.classList.toggle('over',!big && left < 0);
        timer.setAttribute('aria-label',`${timer.textContent}（${P.durationTip}・${P.durationLabel} ${durationText()}）`);
        elapsedText.textContent = big ? remainingText : elapsedTime; elapsed.classList.toggle('over',big && left < 0);
        elapsed.dataset.tip = swapLabel; elapsed.setAttribute('aria-label',`${swapLabel}（${elapsedText.textContent}）`);
        if (s.popup?.closed) { s.popup = null; connection.classList.remove('connected'); connection.title = P.projectionClosed; connection.setAttribute('aria-label',P.projectionClosed); }
        paintProjection();
      }
      function changed(snapshot) {
        box.classList.toggle('overview-open', !!snapshot.overviewOpen); overviewButton.setAttribute('aria-pressed',String(!!snapshot.overviewOpen));
        // 飛ばすページを除いた通し番号（投影画面の操作バーと同じ数え方）
        shownSlides = snapshot.slides.filter(slide => !structure.pages[slide.page]?.skipped); shownPage = shownSlides.findIndex(slide => slide.index === snapshot.index) + 1;
        const ratio = shownSlides.length ? shownPage / shownSlides.length * 100 : 0;
        pageTotal.textContent = `/ ${shownSlides.length}`; if (document.activeElement !== pageField) showPage();
        footerFill.style.width = `${ratio}%`; footerProgress.setAttribute('aria-valuenow',String(Math.round(ratio))); footerProgress.setAttribute('aria-valuetext',`${shownPage} / ${shownSlides.length}`);
        // 段階のプレビュー中の表示は投影へ送らない。プレビューの通信が終わったら resync で今の状態を取り直す
        if (s.previewBusy || s.preview != null && snapshot.index === s.index) {
          paintSteps(committedMax(snapshot)); return;
        }
        s.preview = null; // プレビュー中に別のページへ移ったときは、そちらに従う
        const moved = s.index !== snapshot.index; s.index = snapshot.index; s.step = snapshot.step;
        paintProgress(snapshot); if (!picker.panel.hidden) paintCount();
        const stepped = snapshot.maxStep > 0, atStart = shownPage <= 1, atEnd = shownPage >= shownSlides.length;
        prevPage.hidden = nextPage.hidden = !stepped; prevPage.disabled = atStart; nextPage.disabled = atEnd;
        back.disabled = atStart && s.step <= 0; forward.disabled = atEnd && s.step >= snapshot.maxStep;
        const nextIndex = snapshot.slides.find(slide => slide.index > s.index && !structure.pages[slide.page]?.skipped)?.index;
        next.hidden = nextIndex == null;
        slideDivider.hidden = next.hidden;
        nextStatus.textContent = snapshot.maxStep > s.step ? P.stages(snapshot.maxStep - s.step) : next.hidden ? P.last : '';
        if (!next.hidden && s.next.snapshot?.index !== nextIndex) s.next.api.go(nextIndex,0).catch(fail);
        if (moved) s.notes?.refresh();
        paintSteps(snapshot.maxStep);
        sendProjection('go',{index:s.index,step:s.step}); drawPointer(); drawTime();
      }
      function paintProgress(snapshot) {
        const counted = countedSlides(snapshot.slides,structure.pages,countTo);
        progress.textContent = `${P.progress} ${counted.filter(i => i <= s.index).length} / ${counted.length}`;
      }
      function paintSteps(maxStep) {
        const n = Math.max(1, (Number.isSafeInteger(maxStep) ? maxStep : 0) + 1);
        stepRow.classList.toggle('single', n <= 1);
        if (stepTrack.childElementCount !== n) {
          stepTrack.replaceChildren(...Array.from({length:n}, (_, k) => {
            const b = el('button','speaker-step'); b.type = 'button'; b.dataset.step = String(k); b.setAttribute('aria-label',P.stepCount(k + 1,n)); return b;
          }));
          stepTrack.classList.toggle('dense', n > 24);
        }
        for (const b of stepTrack.children) {
          const k = Number(b.dataset.step);
          b.classList.toggle('done', k < s.step); b.classList.toggle('preview', k === s.preview);
          if (k === s.step) b.setAttribute('aria-current','step'); else b.removeAttribute('aria-current');
        }
        stepCount.textContent = n > 1 ? P.stepCount(s.step + 1,n) : '';
        current.classList.toggle('previewing', s.preview != null);
        stepPreview.hidden = s.preview == null;
        if (s.preview != null) stepPreview.textContent = P.stepPreview(s.preview + 1);
      }
      // プレビューは同じページの中で step だけを変える。投影と s.step（確定した段階）はそのまま
      function committedMax(snapshot = s.main.snapshot) { return snapshot.index === s.index ? snapshot.maxStep : snapshot.slides[s.index]?.maxStep ?? 0; }
      function resync() { if (session === s && s.ready && !s.closing && !s.previewBusy && s.preview == null && s.main.snapshot) changed(s.main.snapshot); }
      function previewGo(step) {
        s.previewBusy++;
        s.main.api.go(s.index,step).catch(() => {}).finally(() => { s.previewBusy--; resync(); });
      }
      function previewStep(k) {
        if (!s.ready || k === (s.preview ?? s.step)) return;
        if (k === s.step) { endPreview(true); return; }
        s.preview = k; paintSteps(committedMax()); previewGo(k);
      }
      function endPreview(restore) {
        if (s.preview == null) return;
        s.preview = null; paintSteps(committedMax());
        if (restore) previewGo(s.step);
      }
      function commitStep(k) {
        if (!s.ready) return;
        endPreview(false);
        // 表示が既にその段階でも変化の通知は来ないため、終わったら取り直して投影へ送る
        s.main.api.go(s.index,k).then(resync,fail);
      }
      stepTrack.addEventListener('pointermove', e => {
        if (e.pointerType === 'touch') return;
        const b = e.target.closest?.('.speaker-step');
        if (b) previewStep(Number(b.dataset.step));
      });
      stepTrack.addEventListener('pointerleave', () => endPreview(true));
      stepTrack.addEventListener('click', e => {
        const b = e.target.closest?.('.speaker-step');
        if (!b) return;
        commitStep(Number(b.dataset.step));
        // マウスで押したときは操作をスライドに戻し、Space などがこのボタンではなく発表の操作として効くようにする
        if (e.detail) current.querySelector('iframe')?.focus();
      });
      function sendProjection(type, data={}) { if (s.popup && !s.popup.closed) s.popup.postMessage({speakerProjection:s.projectionId,type,...data},location.origin); }
      // 開いている間は押すと前面に出す。デスクトップ版はメインプロセスが確実に前面化する
      function paintProjection() {
        const open = !!s.popup && !s.popup.closed;
        if (open === s.projectionOpen) return;
        s.projectionOpen = open; paintIcon(projection,open ? P.projectionFocus : P.projection,'monitorOut'); projection.classList.toggle('active',open);
      }
      function openProjection() {
        if (s.popup && !s.popup.closed) {
          s.popup.focus();
          api('/api/desktop/projection/focus',{method:'POST',body:{}}).catch(() => {});
          return;
        }
        s.popup = window.open(`/web/projection.html#${s.projectionId}`,`projection-${s.projectionId}`,'popup,width=1100,height=720');
        if (!s.popup) toast(P.projectionBlocked);
        paintProjection();
      }
      s.message = e => {
        if (e.source !== s.popup || e.origin !== location.origin || e.data?.speakerProjection !== s.projectionId) return;
        const d = e.data;
        if (d.type === 'ready') { sendProjection('init',{deck:ctx.deck,capability,generation,index:s.index,step:s.step}); sendProjection('pointerStyle',{...pointer}); paintProjection(); }
        if (d.type === 'connected') { connection.classList.add('connected'); connection.title = P.projectionHelp; connection.setAttribute('aria-label',P.projectionHelp); sendProjection('go',{index:s.index,step:s.step}); }
        if (d.type === 'closed' || d.type === 'failure') { connection.classList.remove('connected'); connection.title = P.projectionClosed; connection.setAttribute('aria-label',P.projectionClosed); }
        if (d.type === 'key' && d.event === 'keydown' && !d.repeat && HOST_KEYS.includes(d.key)) hostKey(d.key);
        if (d.type === 'position' && Number.isSafeInteger(d.index) && Number.isSafeInteger(d.step) && (d.index !== s.index || d.step !== s.step)) {
          // 投影側で動かしたときは段階のプレビューをやめ、投影に合わせる
          endPreview(false); s.main.api.go(d.index,d.step).then(resync,fail);
        }
      };
      addEventListener('message',s.message);
      openProjection();
      s.keys = e => {
        if (e.target.closest?.('.speaker-number')) return; // 数字の入力中は Esc・数字・Enter を入力欄で扱う
        if (e.key === 'Escape' && !e.target.closest?.('studio-select[open]')) { // 選択欄の一覧を開いているときは一覧だけ閉じる
          e.preventDefault(); e.stopImmediatePropagation(); if (e.type !== 'keydown') return;
          if (!picker.panel.hidden) closeCount(true); else { endPreview(true); s.main.api.presentationKey(e.type,'Escape',e.repeat).catch(fail); }
          return;
        }
        if (e.target.closest?.('.speaker-divider')) return;
        if (e.target.closest?.('textarea,input,select,studio-select,[contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Enter' && e.target.closest?.('button,a')) return;
        if (e.isComposing || e.key === ' ' && e.target.closest?.('button,a')) return;
        if (e.key === 'f') {
          e.preventDefault(); e.stopImmediatePropagation();
          if (e.type === 'keydown' && !e.repeat) toggleFullscreen();
          return;
        }
        // 数字はスライドに送らず、ページ番号の欄に入れる
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault(); e.stopImmediatePropagation();
          if (e.type === 'keydown' && !e.repeat) typePage(e.key);
          return;
        }
        if (PRESENTATION_KEYS.includes(e.key)) {
          e.preventDefault(); e.stopImmediatePropagation();
          if (e.type === 'keydown') endPreview(true); // キーは確定した段階から操作する
          s.main.api.presentationKey(e.type,e.key,e.repeat).catch(fail);
        }
      };
      addEventListener('keydown',s.keys,true); addEventListener('keyup',s.keys,true); current.querySelector('iframe').focus();
    } catch(e) { if (s) cleanup(s); toast(e.message || P.startError); }
    finally { busy = false; }
  }
  function cleanup(s) {
    clearInterval(s.interval); if (s.message) removeEventListener('message',s.message); if(s.keys) { removeEventListener('keydown',s.keys,true); removeEventListener('keyup',s.keys,true); }
    if (document.fullscreenElement === s.box) document.exitFullscreen().catch(() => {});
    s.popup?.close(); s.notes?.destroy(); s.globalNotes?.destroy(); for (const c of s.clients) c.destroy(); s.box.remove(); ctx.root.inert = s.wasInert; ctx.presenting = false; session = null;
  }
  async function finish() {
    const s = session; if (!s || !s.ready || s.closing) return false;
    const running = s.clock.running;
    s.closing = true; busy = true; s.clock.pause(); paintIcon(s.toggle,P.resume,'play');
    try {
      // 保存できないまま閉じると書いたメモを失うので、知らせて発表を続ける
      if (!await ctx.flush()) { toast(S.saveFirst); if (running) { s.clock.start(); paintIcon(s.toggle,P.pause,'pause'); } return false; }
      const id = s.main.snapshot.slides[s.index]?.id, index = ctx.preview.slides.findIndex(p => p.id === id);
      cleanup(s); await ctx.preview.go(index >= 0 ? index : s.index,s.step); ctx.root.querySelector('.present-tools > button')?.focus();
      return true;
    } catch(e) { toast(P.finishError); return false; }
    finally { s.closing = false; busy = false; }
  }
  return { destroy() { alive = false; if(session) cleanup(session); delete ctx.openPresenter; } };
}
