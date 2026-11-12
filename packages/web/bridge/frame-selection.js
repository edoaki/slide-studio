// Stage 2 selection/hover/keyboard runtime for the content frame.
//
// This module is initialized by frame-agent after deckReady. It is deliberately
// separate from inject/edit.js: that legacy file has side effects (lint import,
// window globals) and cannot be loaded by the first-head agent before the deck
// exists. When Stage 4 ports text editing it must extend this controller rather
// than add a second set of selection listeners.
//
// It owns only frame DOM reads/classes. Source writes remain in the parent.

const MAX_EDIT_KEYS = 10000;
const MAX_EDIT_RECTS = 256;
const MAX_EDIT_COORD = 100000000;
const MAX_KEY_RULES = 256;
const EDITABLE = 'input,textarea,select,button,.fmt-menu,[contenteditable=true]';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value) {
  return Math.max(-MAX_EDIT_COORD, Math.min(MAX_EDIT_COORD, value));
}

function safeKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeAlign(value) {
  if (value === 'center' || value === '-webkit-center') return 'center';
  if (value === 'right' || value === 'end') return 'right';
  return 'left';
}

export function createFrameSelection(win, doc, {
  getSourceVersion,
  sendEvent,
  dom,
} = {}) {
  if (!win || !doc || typeof sendEvent !== 'function') return null;
  const runtime = dom || {};
  const querySelectorAll = runtime.querySelectorAll || doc.querySelectorAll.bind(doc);
  const getComputedStyleFn = runtime.getComputedStyle || win.getComputedStyle.bind(win);
  const elemRect = runtime.elementRect || win.Element?.prototype?.getBoundingClientRect;
  const elementFromPoint = runtime.elementFromPoint || doc.elementFromPoint?.bind(doc);
  const treeWalkerFn = runtime.createTreeWalker || doc.createTreeWalker?.bind(doc);
  const createRangeFn = runtime.createRange || doc.createRange?.bind(doc);
  const NodeFilterCtor = runtime.NodeFilter || win.NodeFilter;
  const addWindowListener = runtime.addWindowListener || win.addEventListener.bind(win);
  const removeWindowListener = runtime.removeWindowListener || win.removeEventListener.bind(win);
  const addDocListener = doc.addEventListener.bind(doc);
  const removeDocListener = doc.removeEventListener.bind(doc);
  const raf = runtime.requestAnimationFrame || win.requestAnimationFrame?.bind(win) || (fn => win.setTimeout(fn, 16));
  const cancelRaf = runtime.cancelAnimationFrame || win.cancelAnimationFrame?.bind(win) || (id => win.clearTimeout(id));
  const ResizeObserverCtor = runtime.ResizeObserver || win.ResizeObserver;
  const MutationObserverCtor = runtime.MutationObserver || win.MutationObserver;
  const textMeasure = runtime.textMeasure || doc.createElement('canvas').getContext('2d');

  let enabled = false;
  let configured = false;
  let keys = new Set();
  let layers = Object.create(null);
  let keymap = [];
  let selected = null;
  let frameKey = null;
  let hovered = null;
  let notifiedHover = null;
  let sequence = 0;
  let dirty = false;
  let rafId = 0;
  let destroyed = false;
  let resizeObserver = null;
  let stageObserver = null;
  let rootObserver = null;
  let lastLayout = null;

  const elements = key => {
    if (!safeKey(key)) return [];
    try {
      return [...querySelectorAll('[data-slide-studio]:not(.slide-studio-step-badge)')]
        .filter(el => {
          try { return el.dataset.slideStudio === key; } catch { return false; }
        });
    } catch { return []; }
  };

  const leafAt = el => el;

  // Ported from inject/edit.js onText(): hit-test the painted glyphs, not the
  // paragraph's padding. This keeps click selection identical to the legacy UI.
  function onText(el, x, y, precise = false) {
    if (!el) return false;
    try {
      if (!precise && el.closest('.cover-title,.cover-subtitle')) return true;
    } catch { return false; }
    const hit = q => x >= q.left - 3 && x <= q.right + 3 && y >= q.top - 3 && y <= q.bottom + 3;
    try {
      const walk = treeWalkerFn(el, NodeFilterCtor.SHOW_TEXT);
      const r = createRangeFn();
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const text = typeof n.data === 'string' ? n.data : '';
        if (!text.trim()) continue;
        const parent = n.parentElement;
        if (!parent || parent.closest('[data-slide-studio-atom],math')) continue;
        const style = getComputedStyleFn(parent);
        textMeasure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const m = textMeasure.measureText(text.trim());
        r.setStart(n, text.length - text.trimStart().length);
        r.setEnd(n, text.trimEnd().length);
        for (const q of r.getClientRects()) {
          const height = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
          const scale = height > 0 ? q.height / height : 1;
          const baseline = q.top + (m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent) * scale;
          if (hit({
            left: q.left, right: q.right,
            top: baseline - m.actualBoundingBoxAscent * scale,
            bottom: baseline + m.actualBoundingBoxDescent * scale,
          })) return true;
        }
      }
      return [...el.querySelectorAll('[data-slide-studio-atom],math,img')]
        .some(k => hit(k.getBoundingClientRect()));
    } catch { return false; }
  }

  function emptyCell(target) {
    try {
      const td = target?.closest?.('td,th');
      return !!td && !td.textContent.trim() && !td.querySelector('img,math');
    } catch { return false; }
  }

  function editableEvent(event) {
    try { return !!event.target?.closest?.(EDITABLE); } catch { return false; }
  }

  function emit(event, data) {
    if (destroyed) return;
    sequence += 1;
    sendEvent(event, {
      sourceVersion: String(getSourceVersion?.() ?? ''),
      sequence,
      ...data,
    });
  }

  function applySelection() {
    try {
      for (const el of querySelectorAll('.slide-studio-selected, .slide-studio-frame')) {
        el.classList.remove('slide-studio-selected', 'slide-studio-quiet', 'slide-studio-frame');
      }
    } catch { /* hostile document */ }
    if (!enabled) return;
    if (selected != null) {
      for (const el of elements(selected)) {
        el.classList.add('slide-studio-selected');
        if (frameKey != null) el.classList.add('slide-studio-quiet');
      }
    }
    if (frameKey != null) {
      for (const el of elements(frameKey)) el.classList.add('slide-studio-frame');
    }
  }

  function applyHover(next, notify) {
    if (notify && next !== notifiedHover) {
      notifiedHover = next;
      emit('edit.intent', { kind: 'hover', key: next });
    }
    if (next === hovered) return;
    hovered = next;
    try {
      for (const el of querySelectorAll('.slide-studio-hover')) el.classList.remove('slide-studio-hover');
    } catch { /* hostile document */ }
    if (next != null) for (const el of elements(next)) el.classList.add('slide-studio-hover');
  }

  function applyLayers() {
    let all = [];
    try { all = [...querySelectorAll('[data-slide-studio]')]; } catch { return; }
    for (const el of all) {
      try {
        const key = el.dataset.slideStudio;
        el.dataset.slideStudioLayer = keys.has(key) ? (layers[key] ?? '') : '';
      } catch { /* hostile element */ }
    }
  }

  function unionRects(list) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const rect of list) {
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    return Number.isFinite(left) ? { left, top, right, bottom } : null;
  }

  function rectsFor(key) {
    const out = [];
    for (const el of elements(key)) {
      if (out.length >= MAX_EDIT_RECTS) break;
      try {
        const rect = typeof elemRect === 'function' ? elemRect.call(el) : el.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) continue;
        if (![rect.left, rect.top, rect.right, rect.bottom].every(finite)) continue;
        out.push({
          left: clamp(rect.left), top: clamp(rect.top),
          right: clamp(rect.right), bottom: clamp(rect.bottom),
        });
      } catch { /* detached element */ }
    }
    return out;
  }

  function alignFor(key) {
    try {
      const el = elements(key)[0];
      const parent = el?.parentElement;
      return parent ? normalizeAlign(getComputedStyleFn(parent).textAlign) : 'left';
    } catch { return 'left'; }
  }

  function scaleFor() {
    try {
      const stage = querySelectorAll('#stage')[0];
      if (!stage) return 1;
      const rect = typeof elemRect === 'function' ? elemRect.call(stage) : stage.getBoundingClientRect();
      const base = stage.offsetWidth || 1280;
      const scale = rect.width > 0 && base > 0 ? rect.width / base : 1;
      return finite(scale) && scale >= 0 && scale <= 1000 ? scale : 1;
    } catch { return 1; }
  }

  function measure() {
    if (destroyed || !configured) return lastLayout;
    const blocks = [];
    let count = 0;
    for (const key of keys) {
      if (count >= MAX_EDIT_KEYS) break;
      count += 1;
      blocks.push({ key, rects: rectsFor(key), align: alignFor(key) });
    }
    const selectionKey = frameKey ?? selected;
    const selection = selectionKey == null ? null : unionRects(rectsFor(selectionKey));
    const layout = {
      sourceVersion: String(getSourceVersion?.() ?? ''),
      sequence: ++sequence,
      scale: scaleFor(),
      blocks,
      selection,
    };
    lastLayout = layout;
    sendEvent('edit.layout', layout);
    return layout;
  }

  function publish() {
    dirty = false;
    rafId = 0;
    if (destroyed) return;
    try { measure(); } catch { /* a single hostile element must not kill selection */ }
  }

  function schedule() {
    if (destroyed || !configured || dirty) return;
    dirty = true;
    rafId = raf(publish);
  }

  function observe() {
    try {
      if (typeof ResizeObserverCtor === 'function') {
        resizeObserver = new ResizeObserverCtor(schedule);
        resizeObserver.observe(doc.documentElement);
        const stage = querySelectorAll('#stage')[0];
        if (stage) resizeObserver.observe(stage);
      }
    } catch { resizeObserver = null; }
    try {
      if (typeof MutationObserverCtor === 'function') {
        stageObserver = new MutationObserverCtor(schedule);
        const stage = querySelectorAll('#stage')[0];
        if (stage) stageObserver.observe(stage, {
          subtree: true, childList: true, characterData: true,
          attributes: true, attributeFilter: ['class', 'style', 'data-step', 'data-slide-studio'],
        });
        rootObserver = new MutationObserverCtor(schedule);
        rootObserver.observe(doc.documentElement, {
          attributes: true, attributeFilter: ['class', 'style', 'data-theme'],
        });
      }
    } catch {
      stageObserver = null;
      rootObserver = null;
    }
    addWindowListener('resize', schedule);
  }

  function keyRule(event) {
    if (!enabled) return null;
    if (event.isComposing || event.keyCode === 229 || editableEvent(event)) return null;
    const code = typeof event.code === 'string' ? event.code : '';
    if (!code) return null;
    for (let i = 0; i < keymap.length; i += 1) {
      const rule = keymap[i];
      if (rule.code !== code) continue;
      if (rule.shift !== !!event.shiftKey) continue;
      if (rule.alt !== !!event.altKey) continue;
      if (rule.ctrl !== !!event.ctrlKey) continue;
      if (rule.meta !== !!event.metaKey) continue;
      return rule;
    }
    return null;
  }

  function onKey(event) {
    if (destroyed || !event.isTrusted) return;
    const rule = keyRule(event);
    if (!rule) return;
    if (event.type === 'keydown') {
      if (rule.preventDefault) event.preventDefault();
      // The parent used to return true synchronously from plugins[].keydown.
      // The pushed keymap replaces that with an explicit local decision.
      event.stopImmediatePropagation();
    }
    emit('edit.intent', {
      kind: 'key',
      type: event.type,
      key: typeof event.key === 'string' ? event.key : '',
      code: typeof event.code === 'string' ? event.code : '',
      repeat: !!event.repeat,
      isComposing: !!event.isComposing,
      trusted: true,
      mods: {
        shift: !!event.shiftKey, alt: !!event.altKey,
        ctrl: !!event.ctrlKey, meta: !!event.metaKey,
      },
    });
  }

  function onClick(event) {
    if (destroyed || !enabled || !event.isTrusted) return;
    if (event.button !== 0) return;
    let el;
    try { el = event.target?.closest?.('[data-slide-studio]'); } catch { return; }
    if (!el) {
      emit('edit.intent', {
        kind: 'select', key: null, again: false, text: false,
        point: { x: event.clientX, y: event.clientY, lineEnd: false }, trusted: true,
      });
      return;
    }
    const leaf = leafAt(el);
    let key = null;
    try { key = leaf?.dataset?.slideStudio ?? null; } catch { key = null; }
    if (!safeKey(key) || !keys.has(key)) return;
    const text = onText(leaf, event.clientX, event.clientY) || emptyCell(event.target);
    // Keep the legacy click from reaching authored slide navigation.
    event.preventDefault();
    event.stopPropagation();
    emit('edit.intent', {
      kind: 'select',
      key,
      again: !!leaf.classList.contains('slide-studio-selected'),
      text,
      point: {
        x: event.clientX, y: event.clientY,
        lineEnd: !text && !event.target.closest('table'),
      },
      trusted: true,
    });
  }

  function onPointerMove(event) {
    if (destroyed || !enabled || !event.isTrusted) return;
    if (event.buttons) { applyHover(null, true); return; }
    let key = null;
    try {
      const el = event.target?.closest?.('[data-slide-studio]');
      if (el) key = leafAt(el)?.dataset?.slideStudio ?? null;
    } catch { key = null; }
    if (key != null && (!safeKey(key) || !keys.has(key))) key = null;
    applyHover(key, true);
  }

  function onPointerOut(event) {
    if (destroyed || !enabled || !event.isTrusted) return;
    if (!event.relatedTarget) applyHover(null, true);
  }

  function onBlur() {
    if (destroyed) return;
    applyHover(null, false);
    emit('edit.intent', { kind: 'blur' });
  }

  function onStepBadge(event) {
    if (destroyed) return;
    let badge = null;
    try { badge = event.target?.closest?.('.slide-studio-step-badge'); } catch { badge = null; }
    if (!badge) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click') return;
    if (!event.isTrusted || !enabled) return;
    let key = null;
    try { key = badge.dataset.slideStudio || ''; } catch { key = ''; }
    if (!safeKey(key) || !keys.has(key)) return;
    emit('edit.intent', { kind: 'stepMenu', key, trusted: true });
  }

  function configure(params) {
    if (destroyed) return false;
    const nextKeys = Array.isArray(params?.keys) ? params.keys.filter(safeKey).slice(0, MAX_EDIT_KEYS) : [];
    keys = new Set(nextKeys);
    layers = Object.create(null);
    if (params?.layers && typeof params.layers === 'object') {
      for (const key of nextKeys) {
        const value = params.layers[key];
        if (value === '1' || value === '2' || value === '3') layers[key] = value;
      }
    }
    keymap = Array.isArray(params?.keymap)
      ? params.keymap.slice(0, MAX_KEY_RULES).filter(rule => rule
        && typeof rule.code === 'string' && rule.code.length > 0 && rule.code.length <= 64
        && typeof rule.preventDefault === 'boolean'
        && typeof rule.shift === 'boolean' && typeof rule.alt === 'boolean'
        && typeof rule.ctrl === 'boolean' && typeof rule.meta === 'boolean')
      : [];
    enabled = params?.enabled === true;
    configured = true;
    if (selected != null && !keys.has(selected)) selected = null;
    if (frameKey != null && !keys.has(frameKey)) frameKey = null;
    applyLayers();
    applySelection();
    applyHover(null, false);
    schedule();
    return true;
  }

  function select(key, nextFrameKey) {
    if (destroyed || !configured) return false;
    if (key != null && (!safeKey(key) || !keys.has(key))) return false;
    if (nextFrameKey != null && (!safeKey(nextFrameKey) || !keys.has(nextFrameKey))) return false;
    selected = key ?? null;
    frameKey = nextFrameKey ?? null;
    applySelection();
    schedule();
    return true;
  }

  function hover(key) {
    if (destroyed || !configured) return false;
    if (key != null && (!safeKey(key) || !keys.has(key))) return false;
    applyHover(key ?? null, false);
    return true;
  }

  function designing(active) {
    if (destroyed || !configured) return false;
    try { doc.documentElement.classList.toggle('slide-studio-designing', active === true); } catch { return false; }
    return true;
  }

  addDocListener('click', onClick, true);
  addDocListener('pointermove', onPointerMove, true);
  addDocListener('pointerout', onPointerOut, true);
  addDocListener('pointerdown', onStepBadge, true);
  addDocListener('pointerup', onStepBadge, true);
  addDocListener('click', onStepBadge, true);
  addDocListener('dblclick', onStepBadge, true);
  addWindowListener('keydown', onKey, true);
  addWindowListener('keyup', onKey, true);
  addWindowListener('blur', onBlur);
  observe();

  return Object.freeze({
    configure,
    select,
    hover,
    designing,
    measure,
    schedule,
    get enabled() { return enabled; },
    get selected() { return selected; },
    get frameKey() { return frameKey; },
    get hovered() { return hovered; },
    get sequence() { return sequence; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId) cancelRaf(rafId);
      rafId = 0;
      removeDocListener('click', onClick, true);
      removeDocListener('pointermove', onPointerMove, true);
      removeDocListener('pointerout', onPointerOut, true);
      removeDocListener('pointerdown', onStepBadge, true);
      removeDocListener('pointerup', onStepBadge, true);
      removeDocListener('click', onStepBadge, true);
      removeDocListener('dblclick', onStepBadge, true);
      removeWindowListener('keydown', onKey, true);
      removeWindowListener('keyup', onKey, true);
      removeWindowListener('blur', onBlur);
      removeWindowListener('resize', schedule);
      try { resizeObserver?.disconnect(); } catch { /* already gone */ }
      try { stageObserver?.disconnect(); } catch { /* already gone */ }
      try { rootObserver?.disconnect(); } catch { /* already gone */ }
      resizeObserver = null;
      stageObserver = null;
      rootObserver = null;
      keys.clear();
      keymap = [];
    },
  });
}
