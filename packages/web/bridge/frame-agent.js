// Content half of the staged preview/presentation bridge.
//
// The host serves this file as bridge/frame-agent.classic.js and includes it as
// the FIRST classic <head> script. It must be bundled from this ES module into
// a classic IIFE (the integrator owns that esbuild step); a module/defer/async
// script would run after authored deck scripts and is not acceptable.
//
// This agent runs in the content origin. It has no API adapter, token, file
// system handle or session credential. Stage 1 commands are navigation/theme
// only; no write intent crosses the port.
import {
  PROTOCOL,
  createIdentity,
  makeEvent,
  makeHello,
  makeResponse,
  parseNonceFragment,
  validateRequest,
  validateSnapshot,
  validateThemeName,
} from './protocol.js';

const MAX_SNAPSHOT_STAGES = 4096;

function errorWithCode(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function safeInteger(value, fallback = 0, min = 0) {
  return Number.isSafeInteger(value) && value >= min ? value : fallback;
}

function readScript(doc) {
  if (doc.currentScript) return doc.currentScript;
  try { return doc.querySelector('script[data-studio-admin-origin][data-studio-deck]'); } catch { return null; }
}

function parseOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch { return null; }
}

function detectMode(win, script) {
  const dataMode = script?.dataset?.studioMode;
  if (dataMode === 'present' || dataMode === 'edit') return dataMode;
  try {
    const params = new URL(win.location.href).searchParams;
    const param = params.get('studio-mode') || params.get('mode');
    if (param === 'present') return 'present';
    if (param === 'edit') return 'edit';
    if (params.get('edit') === '0') return 'present';
  } catch { /* about:srcdoc or an opaque URL */ }
  return 'edit';
}

export function bootstrapFrameAgent(win = globalThis.window) {
  if (!win || !win.document || win.parent === win) return null;
  const doc = win.document;
  if (win.__slideStudioFrameAgentStarted) return null;
  try {
    Object.defineProperty(win, '__slideStudioFrameAgentStarted', { value: true, configurable: false });
  } catch {
    win.__slideStudioFrameAgentStarted = true;
  }

  const script = readScript(doc);
  if (!script) return null;
  const adminOrigin = parseOrigin(script.getAttribute('data-studio-admin-origin'));
  const deckName = script.getAttribute('data-studio-deck');
  const version = script.getAttribute('data-studio-version');
  const generation = script.getAttribute('data-studio-generation');
  if (!adminOrigin || !deckName || !version || !generation) return null;

  const parsed = parseNonceFragment(win.location.hash);
  if (!parsed.nonce) return null;
  const nonce = parsed.nonce;

  // Captured before authored scripts get a chance to replace built-ins.
  const parentWindow = win.parent;
  if (typeof parentWindow?.postMessage !== 'function') return null;
  const postToParent = parentWindow.postMessage.bind(parentWindow);
  const MessageChannelCtor = win.MessageChannel || globalThis.MessageChannel;
  const bind = (fn, fallback) => (typeof fn === 'function' ? fn.bind(win) : fallback);
  const addWindowListener = bind(win.addEventListener, () => {});
  const removeWindowListener = bind(win.removeEventListener, () => {});
  const querySelector = doc.querySelector.bind(doc);
  const querySelectorAll = doc.querySelectorAll.bind(doc);
  const computedStyle = win.getComputedStyle || globalThis.getComputedStyle;
  const getComputedStyle = typeof computedStyle === 'function'
    ? computedStyle.bind(win)
    : () => ({ backgroundColor: '' });
  const elementRect = win.Element?.prototype?.getBoundingClientRect;
  const replaceState = typeof win.history?.replaceState === 'function'
    ? win.history.replaceState.bind(win.history)
    : () => {};
  const setIntervalFn = bind(win.setInterval || globalThis.setInterval, () => 0);
  const clearIntervalFn = bind(win.clearInterval || globalThis.clearInterval, () => {});
  const setTimeoutFn = bind(win.setTimeout || globalThis.setTimeout, () => 0);
  const clearTimeoutFn = bind(win.clearTimeout || globalThis.clearTimeout, () => {});
  const encode = bind(win.encodeURIComponent || globalThis.encodeURIComponent, value => String(value));
  if (typeof MessageChannelCtor !== 'function') return null;

  // Remove only the nonce. The legacy "#page/step" fragment survives for the
  // authored deck scripts that run immediately after this first head script.
  // If the nonce cannot be removed, do not start a bridge that would leave the
  // capability secret readable by deck scripts.
  try {
    replaceState(null, doc.title || '', `${win.location.pathname}${win.location.search}${parsed.hash}`);
  } catch { return null; }

  const identity = Object.freeze(createIdentity(deckName, version, generation));
  const presenting = detectMode(win, script) === 'present';
  if (presenting) {
    // Legacy presentation set this before the runtime started; do the same in
    // the first head agent so the authored runtime sees it immediately.
    try { win.__slideStudioNoHash = true; } catch { /* frozen window */ }
  }
  const channel = new MessageChannelCtor();
  const port = channel.port1;
  const postPort = port.postMessage.bind(port);
  const closePort = port.close.bind(port);
  let deck = null;
  let ready = false;
  let poll = 0;
  let pollStop = 0;
  let destroyed = false;
  const linkedDocuments = new WeakSet();
  const fullscreenButtons = new WeakSet();
  let lastSentKey = '';
  let liveSourceVersion = identity.version;
  let inflightTheme = null;
  let cachedSlides = null;
  let cachedStageNumbers = null;
  let slidesDirty = true;
  let stageObserver = null;

  function currentDeck() {
    try {
      const value = win.deck;
      if (value) deck = value;
      return deck;
    } catch { return deck; }
  }

  function readProperty(object, name, fallback = undefined) {
    try { return object?.[name]; } catch { return fallback; }
  }

  function deckCall(name, ...args) {
    const target = currentDeck();
    if (!target) return undefined;
    try {
      const fn = target[name];
      if (typeof fn !== 'function') return undefined;
      return fn.apply(target, args);
    } catch { return undefined; }
  }

  function invokeDeck(name, ...args) {
    const target = currentDeck();
    let fn;
    try { fn = target?.[name]; } catch { fn = undefined; }
    if (typeof fn !== 'function') throw errorWithCode('unsupported', `deck.${name} is not available`);
    return fn.apply(target, args);
  }

  function send(message) {
    if (destroyed) return;
    try { postPort(message); } catch { /* parent is gone */ }
  }

  function snapshotKey(snapshot) {
    return `${snapshot.index}/${snapshot.step}/${snapshot.maxStep}/${snapshot.slides.length}/${snapshot.background}/${snapshot.scale}/${snapshot.stageAt}/${snapshot.sourceVersion}`;
  }

  function clampString(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function sendEvent(event, data) {
    send(makeEvent(identity, event, data));
  }

  function readSlides() {
    let nodes = [];
    try { nodes = Array.from(querySelectorAll('#stage > .slide')); } catch { /* no stage */ }
    const stageNumbers = [];
    const slides = nodes.map((slide, index) => {
      let page = null;
      try {
        const raw = slide.dataset.page;
        if (raw !== '' && raw != null) {
          const n = Number(raw);
          if (Number.isSafeInteger(n) && n >= 0) page = n;
        }
      } catch { /* detached element */ }
      let id = '';
      let title = '';
      let group = '';
      let chapter = false;
      let sectionStart = false;
      try {
        id = clampString(slide.id || '', 4096);
        title = clampString(slide.querySelector('h1,h2')?.textContent || '', 65536);
        group = clampString(slide.dataset.group || '', 4096);
        chapter = slide.classList.contains('section-slide');
        sectionStart = slide.dataset.sectionStart === 'true';
      } catch { /* hostile element */ }

      const rawMax = deckCall('maxStep', index);
      const maxStep = safeInteger(rawMax, 0, 0);
      const marks = deckCall('pdfMarks', index);
      const pdfMarks = Array.isArray(marks)
        ? marks.filter(mark => Number.isSafeInteger(mark) && mark >= 0).slice(0, 4096)
        : [];
      const stages = [];
      const count = Math.min(maxStep, MAX_SNAPSHOT_STAGES);
      for (let stage = 0; stage <= count; stage += 1) {
        const n = deckCall('stageNumber', stage, index);
        stages.push(safeInteger(n, stage + 1, 0));
      }
      stageNumbers[index] = stages;
      return {
        index, page, id, title, chapter, group, sectionStart,
        maxStep, pdfMarks,
      };
    });
    cachedSlides = slides;
    cachedStageNumbers = stageNumbers;
    slidesDirty = false;
    return { slides, stageNumbers };
  }

  function readSnapshot(refreshSlides = false) {
    const target = currentDeck();
    if (!target) return null;
    if (refreshSlides || slidesDirty || !cachedSlides) readSlides();

    const liveIndex = safeInteger(readProperty(target, 'index'), 0, 0);
    const liveStep = safeInteger(readProperty(target, 'step'), 0, 0);
    const liveMax = safeInteger(deckCall('maxStep', liveIndex), cachedSlides[liveIndex]?.maxStep ?? 0, 0);
    let background = '';
    try {
      const active = querySelector('#stage > .slide.active');
      if (active) background = clampString(getComputedStyle(active).backgroundColor || '', 512);
    } catch { /* no active slide */ }
    let scale = 1;
    try {
      const stage = querySelector('#stage');
      if (stage) {
        const rect = typeof elementRect === 'function' ? elementRect.call(stage) : stage.getBoundingClientRect();
        const base = stage.offsetWidth || 1280;
        if (rect.width > 0 && base > 0) scale = rect.width / base;
      }
    } catch { /* measurement failed */ }
    if (!Number.isFinite(scale) || scale < 0 || scale > 1000) scale = 1;
    const stageAt = safeInteger(deckCall('stageAt'), liveStep, 0);

    const snapshot = {
      ...identity,
      index: liveIndex,
      step: liveStep,
      maxStep: liveMax,
      slides: cachedSlides,
      background,
      scale,
      stageAt,
      stageNumbers: cachedStageNumbers,
      sourceVersion: liveSourceVersion,
    };
    return validateSnapshot(snapshot, identity) ? snapshot : null;
  }

  function publish(event, force = false, refreshSlides = false) {
    const snapshot = readSnapshot(refreshSlides);
    if (!snapshot) return null;
    const key = snapshotKey(snapshot);
    if (!force && event === 'deckchange' && key === lastSentKey) return snapshot;
    lastSentKey = key;
    sendEvent(event, snapshot);
    return snapshot;
  }

  function presentationKey(event) {
    if (!presenting) return;
    const key = typeof event.key === 'string' ? event.key : '';
    const fullscreen = key === 'f' && !event.metaKey && !event.ctrlKey && !event.altKey;
    if (key !== 'Escape' && !fullscreen) return;
    // The parent decides what to do. The agent only blocks the content-side
    // default for the two presentation keys the legacy shell owns.
    event.preventDefault();
    event.stopImmediatePropagation();
    sendEvent('key', {
      type: event.type,
      key,
      code: typeof event.code === 'string' ? event.code : '',
      repeat: !!event.repeat,
      isComposing: !!event.isComposing,
      mods: {
        shift: !!event.shiftKey,
        alt: !!event.altKey,
        ctrl: !!event.ctrlKey,
        meta: !!event.metaKey,
      },
    });
  }

  function attachFigureKeys(frame) {
    if (!presenting) return;
    let frameWindow;
    let frameDocument;
    try {
      frameWindow = frame.contentWindow;
      // Accessing document is the same-origin check. Cross-origin figures are
      // skipped exactly like the legacy try/catch path.
      frameDocument = frameWindow?.document;
      if (!frameWindow || !frameDocument) return;
    } catch { return; }
    if (linkedDocuments.has(frameDocument)) return;
    linkedDocuments.add(frameDocument);
    try {
      frameWindow.addEventListener('keydown', presentationKey, true);
      frameWindow.addEventListener('keyup', presentationKey, true);
    } catch { /* the figure navigated */ }
  }

  function attachNestedFrames(root = doc) {
    if (!presenting) return;
    let frames = [];
    try { frames = Array.from(root.querySelectorAll('iframe')); } catch { return; }
    for (const frame of frames) attachFigureKeys(frame);
  }

  function sendFullscreenIntent() {
    sendEvent('key', {
      type: 'keydown',
      key: 'f',
      code: 'KeyF',
      repeat: false,
      isComposing: false,
      kind: 'fullscreen',
      mods: { shift: false, alt: false, ctrl: false, meta: false },
    });
  }

  function installFullscreenButton() {
    if (!presenting) return;
    let button;
    try { button = querySelector('#fullscreen'); } catch { return; }
    if (!button || fullscreenButtons.has(button)) return;
    fullscreenButtons.add(button);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      sendFullscreenIntent();
    }, true);
  }

  function installLinkInterception() {
    const open = event => {
      // Script-generated clicks are not a user gesture. The parent still checks
      // activation and rate-limits bridge link opens.
      if (!event.isTrusted) return;
      if ((event.type === 'click' && event.button !== 0) || (event.type === 'auxclick' && event.button !== 1)) return;
      const anchor = event.target?.closest?.('a[href]');
      if (!anchor || anchor.hasAttribute('data-nav') || anchor.hasAttribute('download') || anchor.isContentEditable) return;
      try { if (querySelector('.slide-studio-editing')) return; } catch { return; }
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || !['http:', 'https:'].includes(anchor.protocol)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sendEvent('link.open', { url: anchor.href });
    };
    addWindowListener('click', open, true);
    addWindowListener('auxclick', open, true);
  }

  function watchStageStructure() {
    const MutationObserverCtor = win.MutationObserver;
    let stage;
    try { stage = querySelector('#stage'); } catch { stage = null; }
    if (!stage || typeof MutationObserverCtor !== 'function') return;
    try {
      stageObserver = new MutationObserverCtor(() => { slidesDirty = true; });
      stageObserver.observe(stage, { childList: true, subtree: true });
    } catch { stageObserver = null; }
  }

  function installReadyListeners() {
    addWindowListener('deckchange', () => { publish('deckchange'); });
    watchStageStructure();
    if (presenting) {
      addWindowListener('keydown', presentationKey, true);
      addWindowListener('keyup', presentationKey, true);
      addWindowListener('load', event => {
        const frame = event.target;
        if (frame?.tagName === 'IFRAME') attachFigureKeys(frame);
      }, true);
      attachNestedFrames();
      installFullscreenButton();
    }
    installLinkInterception();
  }

  function markReady() {
    if (ready || destroyed) return;
    const target = currentDeck();
    if (!target) return;
    const snapshot = readSnapshot(true);
    if (!snapshot) return;
    ready = true;
    clearIntervalFn(poll);
    clearIntervalFn(pollStop);
    poll = 0;
    pollStop = 0;
    removeWindowListener('deckready', markReady);
    installReadyListeners();
    lastSentKey = snapshotKey(snapshot);
    sendEvent('ready', snapshot);
  }

  function deckLooksReady() {
    const target = currentDeck();
    if (!target) return false;
    if (!Number.isSafeInteger(readProperty(target, 'index'))
      || !Number.isSafeInteger(readProperty(target, 'step'))) return false;
    // Match the legacy contract: only deckReady or the deckready event. A
    // partially parsed stage is not an acceptable readiness signal.
    try { return win.deckReady === true; } catch { return false; }
  }

  function execute(request) {
    const target = currentDeck();
    if (!target) throw errorWithCode('not-ready', 'deck is not ready');
    const params = request.params || {};
    switch (request.method) {
      case 'go':
        return Promise.resolve(invokeDeck('go', params.index, params.step));
      case 'move':
        return Promise.resolve(invokeDeck('move', params.delta));
      case 'jump':
        return Promise.resolve(invokeDeck('jump', params.delta));
      case 'goStage': {
        if (typeof readProperty(target, 'goStage') === 'function') {
          return Promise.resolve(invokeDeck('goStage', params.stage));
        }
        return Promise.resolve(invokeDeck('go', safeInteger(readProperty(target, 'index'), 0, 0), params.stage));
      }
      case 'resize':
        return Promise.resolve(invokeDeck('resize'));
      case 'setFilter':
        return Promise.resolve(invokeDeck('setFilter', params.indices));
      case 'pageWheel': {
        const wheel = readProperty(currentDeck(), 'pageWheel');
        if (typeof wheel !== 'function') return Promise.resolve(false);
        const WheelCtor = win.WheelEvent;
        const event = typeof WheelCtor === 'function'
          ? new WheelCtor('wheel', {
            deltaX: params.deltaX, deltaY: params.deltaY, deltaMode: params.deltaMode,
            shiftKey: params.shiftKey, altKey: params.altKey,
            ctrlKey: params.ctrlKey, metaKey: params.metaKey,
            bubbles: false, cancelable: true,
          })
          : {
            deltaX: params.deltaX, deltaY: params.deltaY, deltaMode: params.deltaMode,
            shiftKey: params.shiftKey, altKey: params.altKey,
            ctrlKey: params.ctrlKey, metaKey: params.metaKey,
          };
        return Promise.resolve(invokeDeck('pageWheel', event));
      }
      case 'theme.swap':
        return swapTheme(params.name, params.version, params.sourceVersion);
      case 'finish':
        return Promise.resolve(null);
      default:
        throw errorWithCode('unsupported', 'unsupported bridge command');
    }
  }

  function swapTheme(name, themeVersion, sourceVersion) {
    // The name is always re-encoded here and resolved against the fixed content
    // route. No command can supply an arbitrary stylesheet URL.
    if (!validateThemeName(name)) throw errorWithCode('invalid-theme', 'invalid theme name');
    let link;
    try { link = querySelector('#slide-studio-theme'); } catch { link = null; }
    if (!link) return Promise.resolve({ swapped: false });
    const href = `/theme/${encode(name)}.css?version=${encode(themeVersion)}`;
    return new Promise(resolve => {
      let done = false;
      let next = null;
      let timer = 0;
      const finish = (result, committed = false) => {
        if (done) return;
        done = true;
        if (inflightTheme === job) inflightTheme = null;
        clearTimeoutFn(timer);
        if (committed && sourceVersion !== undefined) {
          liveSourceVersion = sourceVersion;
          try { win.__slideStudioVersion = sourceVersion; } catch { /* frozen window */ }
        }
        if (committed) {
          try { win.slideStudioRefreshSpacing?.(); } catch { /* optional runtime hook */ }
        }
        resolve(result);
      };
      const job = {
        cancel() {
          try { next?.remove(); } catch { /* detached */ }
          finish({ swapped: false, reason: 'superseded' });
        },
      };
      const previous = inflightTheme;
      inflightTheme = job;
      previous?.cancel();
      timer = setTimeoutFn(() => {
        try { next?.remove(); } catch { /* detached */ }
        finish({ swapped: false, reason: 'timeout' });
      }, 10000);
      try {
        next = link.cloneNode();
        next.removeAttribute('id');
        next.media = 'not all';
        next.onload = () => {
          if (done || inflightTheme !== job) return;
          try {
            const current = querySelector('#slide-studio-theme');
            next.onload = null;
            next.onerror = null;
            next.media = current?.media ?? link.media;
            next.id = 'slide-studio-theme';
            current?.remove();
          } catch { /* link detached */ }
          finish({ swapped: true }, true);
        };
        next.onerror = () => {
          try { next.remove(); } catch { /* detached */ }
          finish({ swapped: false, reason: 'error' });
        };
        next.href = href;
        const current = querySelector('#slide-studio-theme') || link;
        current.after(next);
      } catch {
        finish({ swapped: false, reason: 'error' });
      }
    });
  }

  async function handleRequest(message) {
    if (!validateRequest(message, identity)) {
      // Only answer well-framed requests with a usable id; stray, malformed or
      // wrong-identity traffic is otherwise dropped.
      if (message?.protocol === PROTOCOL && message?.type === 'request'
        && Number.isSafeInteger(message.id) && message.id > 0) {
        send(makeResponse(identity, message.id, false, undefined, {
          code: 'invalid-request', message: 'invalid bridge request',
        }));
      }
      return;
    }
    try {
      const result = await execute(message);
      if (message.method === 'theme.swap') {
        // The command keeps its ack result; a separate snapshot event updates
        // the parent's cached backdrop without turning the ack into a snapshot.
        publish('deckchange', true);
        send(makeResponse(identity, message.id, true, result ?? null));
      } else {
        const snapshot = readSnapshot();
        if (snapshot) lastSentKey = snapshotKey(snapshot);
        send(makeResponse(identity, message.id, true, snapshot || result || null));
      }
    } catch (error) {
      send(makeResponse(identity, message.id, false, undefined, {
        code: typeof error?.code === 'string' ? error.code : 'error',
        message: typeof error?.message === 'string' ? error.message : 'bridge command failed',
      }));
    }
  }

  port.onmessage = event => {
    if (destroyed) return;
    const message = event?.data;
    if (message?.type === 'request') handleRequest(message);
  };

  postToParent(makeHello(nonce), adminOrigin, [channel.port2]);

  // The deck runtime may assign window.deck and window.deckReady without
  // dispatching a public event. Poll only during bootstrap, then stop for good.
  if (deckLooksReady()) markReady();
  else {
    addWindowListener('deckready', markReady, { once: true });
    poll = setIntervalFn(() => { if (deckLooksReady()) markReady(); }, 50);
    pollStop = setIntervalFn(() => {
      if (!ready) { clearIntervalFn(poll); clearIntervalFn(pollStop); poll = 0; pollStop = 0; }
    }, 30000);
  }

  return Object.freeze({
    identity,
    nonce,
    presenting,
    publish,
    ready: () => ready,
    destroy() {
      destroyed = true;
      clearIntervalFn(poll);
      clearIntervalFn(pollStop);
      removeWindowListener('deckready', markReady);
      port.onmessage = null;
      try { stageObserver?.disconnect(); } catch { /* already gone */ }
      stageObserver = null;
      inflightTheme?.cancel();
      inflightTheme = null;
      try { closePort(); } catch { /* already closed */ }
    },
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootstrapFrameAgent(window);
}

export { PROTOCOL };
