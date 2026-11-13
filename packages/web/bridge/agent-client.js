// Parent half of the staged preview/presentation bridge. This module never
// reads an iframe document and never imports api.js, so the admin session and
// its token cannot be reached by the content frame.
import {
  capabilityHash,
  createIdentity,
  isFiniteNumber,
  makeRequest,
  parseEditIntent,
  parseEditLayout,
  parsePreviewCapability,
  parseSnapshot,
  validateEvent,
  validateHello,
  validateRequest,
  validateResponse,
  validateThemeName,
} from './protocol.js';

export const DEFAULT_RPC_TIMEOUT_MS = 5000;
export const DEFAULT_READY_TIMEOUT_MS = 30000;
export const THEME_SWAP_RPC_TIMEOUT_MS = 12000;
export const THEME_SAMPLE_PATH = '/files/decks/__theme-sample__/sample.html';

const clientsByFrame = new WeakMap();

export function createGeneration() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createNonce() {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(24);
    c.getRandomValues(bytes);
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function httpUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw new TypeError('invalid bridge URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('invalid bridge URL protocol');
  return url;
}

function originOf(value, base) {
  const url = httpUrl(value, base);
  return url.origin;
}

// The parent asks the existing legacy preview resolver (a future host route)
// for a content-origin capability URL. The nonce is added only afterwards, in
// the fragment; no API token crosses to the content origin.
export async function requestPreviewCapability(api, { deck, version, mode, generation }) {
  if (typeof api !== 'function') throw new TypeError('api adapter is required');
  if (mode !== 'edit' && mode !== 'present') throw new TypeError('invalid preview mode');
  const data = await api(`/api/deck/${encodeURIComponent(deck)}/preview`, {
    method: 'POST',
    body: { version, mode, generation },
  });
  return parsePreviewCapability(data);
}

export function themeSampleName(value) {
  const url = httpUrl(value, globalThis.location?.href);
  const adminOrigin = globalThis.location?.origin;
  if (adminOrigin && url.origin !== adminOrigin) throw new TypeError('theme sample must use the admin origin');
  if (url.pathname !== THEME_SAMPLE_PATH) throw new TypeError('unknown theme sample path');
  const name = url.searchParams.get('theme');
  if (!validateThemeName(name)) throw new TypeError('invalid theme sample name');
  return name;
}

// The theme sample is not a raw admin iframe. The resolver returns a content
// capability URL for the named sample; the generation reaches the host here.
export async function requestThemeSampleCapability(api, { name, version, generation }) {
  if (typeof api !== 'function') throw new TypeError('api adapter is required');
  if (!validateThemeName(name)) throw new TypeError('invalid theme name');
  const data = await api(`/api/themes/${encodeURIComponent(name)}/preview`, {
    method: 'POST',
    body: { generation, version },
  });
  return parsePreviewCapability(data);
}

export function capabilityUrl(base, { index = 0, step = 0, nonce, mode, generation } = {}) {
  const url = httpUrl(base, globalThis.location?.href);
  // Edit is the default. Presentation needs a hint because the host script
  // contract has no required mode attribute; the agent also recognizes
  // mode=present / edit=0 from the resolver URL.
  if (mode === 'present') url.searchParams.set('studio-mode', 'present');
  // A per-load query keeps the same version from being served from the HTTP
  // cache with the previous generation in its injected HTML.
  if (generation) url.searchParams.set('generation', String(generation));
  url.hash = capabilityHash(index, step, nonce);
  return url.href;
}

export function registerFrameClient(frame, client) {
  if (frame && client) clientsByFrame.set(frame, client);
}

export function unregisterFrameClient(frame, client) {
  if (!frame) return;
  if (!client || clientsByFrame.get(frame) === client) clientsByFrame.delete(frame);
}

export function clientForFrame(frame) {
  return frame ? clientsByFrame.get(frame) || null : null;
}

// Used by app.js for the legacy page-level wheel gesture. It is a small
// compatibility command, not a write intent.
export function forwardWheel(frame, event) {
  const client = clientForFrame(frame);
  if (!client || !event) return;
  // Cancellation must happen in the original event turn, before the async RPC.
  // Leave vertical scrolling and pinch zoom to the browser as the player does.
  if (!event.ctrlKey && event.deltaX && Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.preventDefault();
  client.pageWheel(event).catch(() => {});
}

function bridgeError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

export class AgentClient {
  constructor({
    frame, deck, version, generation, adminOrigin, contentOrigin, nonce,
    window: ownerWindow = globalThis,
    rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    onSnapshot = null,
    onEvent = null,
    onFailure = null,
    onEditLayout = null,
    onEditIntent = null,
  }) {
    if (!frame) throw new TypeError('frame is required');
    this.frame = frame;
    this.identity = createIdentity(deck, version, generation);
    this.adminOrigin = originOf(adminOrigin, globalThis.location?.href);
    this.contentOrigin = originOf(contentOrigin, globalThis.location?.href);
    if (this.adminOrigin === this.contentOrigin) {
      throw new TypeError('admin and content origins must differ');
    }
    this.nonce = nonce;
    this.window = ownerWindow;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.onSnapshot = onSnapshot;
    this.onEvent = onEvent;
    this.onFailure = onFailure;
    this.onEditLayout = onEditLayout;
    this.onEditIntent = onEditIntent;

    this.port = null;
    this._portPostMessage = null;
    this._portClose = null;
    this.snapshot = null;
    this.started = false;
    this.destroyed = false;
    this.loads = 0;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this._readySettled = false;
    this._readyTimer = 0;
    this._lastSnapshotKey = '';
    // Stage 2 edit state is deliberately separate from the navigation snapshot.
    // sourceVersion comes from the frame, never from a configure request.
    this._frameSourceVersion = this.identity.version;
    this._lastEditSequence = 0;
    this.editLayout = null;
    this._editKeys = null;
    this._editKeymap = [];

    this.api = this._makeApi();

    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    // Callers that are replaced before ready must not create an unhandled
    // rejection; an interested caller still receives the rejection.
    this.ready.catch(() => {});

    this._messageHandler = event => this._onWindowMessage(event);
    this._frameLoadHandler = () => this._onFrameLoad();
  }

  _makeApi() {
    const client = this;
    const api = {
      get index() { return client.snapshot?.index ?? 0; },
      get step() { return client.snapshot?.step ?? 0; },
      get count() { return client.snapshot?.slides.length ?? 0; },
      get slides() { return client.snapshot?.slides ?? []; },
      maxStep(index) {
        const snapshot = client.snapshot;
        if (!snapshot) return 0;
        const at = Number.isSafeInteger(index) ? index : snapshot.index;
        return snapshot.slides[at]?.maxStep ?? (at === snapshot.index ? snapshot.maxStep : 0);
      },
      pdfMarks(index) {
        const snapshot = client.snapshot;
        if (!snapshot || !Number.isSafeInteger(index)) return [];
        return (snapshot.slides[index]?.pdfMarks ?? []).slice();
      },
      stageAt() {
        return client.snapshot?.stageAt ?? client.snapshot?.step ?? 0;
      },
      stageNumber(stage, index) {
        if (!Number.isSafeInteger(stage) || stage < 0) return 0;
        const snapshot = client.snapshot;
        if (!snapshot) return stage + 1;
        const at = Number.isSafeInteger(index) ? index : snapshot.index;
        const slide = snapshot.slides[at];
        return slide?.stageNumbers?.[stage]
          ?? snapshot.stageNumbers?.[at]?.[stage]
          ?? stage + 1;
      },
      go(index, step = 0) { return client.request('go', { index, step }); },
      move(delta = 1) { return client.request('move', { delta }); },
      jump(delta = 1) { return client.request('jump', { delta }); },
      goStage(stage) { return client.request('goStage', { stage }); },
      resize() { return client.request('resize', {}); },
      setFilter(indices) {
        return client.request('setFilter', { indices: Array.isArray(indices) ? indices.slice() : null });
      },
      theme: Object.freeze({
        swap(name, version, sourceVersion) { return client.themeSwap(name, version, sourceVersion); },
      }),
      'theme.swap': (name, version, sourceVersion) => client.themeSwap(name, version, sourceVersion),
      pageWheel(event) { return client.pageWheel(event); },
      edit: Object.freeze({
        get layout() { return client.editLayout; },
        get sourceVersion() { return client._frameSourceVersion; },
        configure(params) { return client.editConfigure(params); },
        select(key, frameKey = null) { return client.editSelect(key, frameKey); },
        hover(key) { return client.editHover(key); },
        designing(active) { return client.editDesigning(active); },
        measure() { return client.editMeasure(); },
      }),
    };
    return Object.freeze(api);
  }

  start() {
    if (this.started || this.destroyed) return this;
    this.started = true;
    this.window.addEventListener('message', this._messageHandler);
    this.frame.addEventListener('load', this._frameLoadHandler);
    this._readyTimer = setTimeout(() => {
      this._fail(bridgeError('timeout', 'preview bridge did not become ready'));
    }, this.readyTimeoutMs);
    return this;
  }

  on(event, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener is required');
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(event);
    };
  }

  _emit(event, data) {
    for (const listener of this.listeners.get(event) || []) {
      try { listener(data); } catch { /* a listener cannot break the bridge */ }
    }
    if (this.onEvent) {
      try { this.onEvent(event, data); } catch { /* same */ }
    }
  }

  _onWindowMessage(event) {
    if (this.destroyed || this.port) return;
    let frameWindow;
    try { frameWindow = this.frame.contentWindow; } catch { return; }
    if (!frameWindow || event.source !== frameWindow) return;
    if (event.origin !== this.contentOrigin) return;
    if (!validateHello(event.data, { nonce: this.nonce })) return;
    // Exactly one transferred port, and only the first valid hello is used.
    if (!Array.isArray(event.ports) || event.ports.length !== 1 || !event.ports[0]) return;
    const port = event.ports[0];
    this.port = port;
    this._portPostMessage = port.postMessage.bind(port);
    this._portClose = port.close.bind(port);
    port.onmessage = message => this._onPortMessage(message);
    // Window messages are irrelevant once the private port is accepted.
    try { this.window.removeEventListener('message', this._messageHandler); } catch { /* already gone */ }
  }

  _onFrameLoad() {
    this.loads += 1;
    // The first load is the bootstrap document. Any later load is navigation
    // or reload; the agent from the old document is no longer trustworthy.
    if (this.loads > 1 && !this.destroyed) {
      this._fail(bridgeError('navigation', 'preview frame navigated after bootstrap'));
    }
  }

  _onPortMessage(event) {
    if (this.destroyed || !this.port) return;
    const data = event?.data;
    if (validateResponse(data, this.identity)) {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (!data.ok) {
        if (pending.method === 'edit.configure') {
          // A rejected configure must not leave the client claiming keys that
          // the frame did not actually accept.
          this._editKeys = null;
          this._editKeymap = [];
        }
        pending.reject(bridgeError(data.error.code, data.error.message));
        return;
      }
      if ((pending.method.startsWith('edit.') || pending.method.startsWith('text.') || pending.method.startsWith('cover.') || pending.method.startsWith('block.') || pending.method.startsWith('theme.') || pending.method.startsWith('lint.'))) {
        const layout = pending.method === 'edit.measure' ? parseEditLayout(data.result) : null;
        pending.resolve(layout || data.result);
        return;
      }
      const snapshot = parseSnapshot(data.result, this.identity);
      if (snapshot) this._updateSnapshot(snapshot, 'response');
      pending.resolve(snapshot || data.result);
      return;
    }
    if (!validateEvent(data, this.identity)) return;
    if (data.event === 'edit.layout') {
      const layout = parseEditLayout(data.data);
      if (layout) this._acceptEditLayout(layout);
      return;
    }
    if (data.event === 'edit.intent') {
      const intent = parseEditIntent(data.data);
      if (intent) this._acceptEditIntent(intent);
      return;
    }
    if (data.event === 'ready' || data.event === 'deckchange') {
      const snapshot = parseSnapshot(data.data, this.identity);
      if (!snapshot) return;
      this._updateSnapshot(snapshot, data.event);
      if (data.event === 'ready' && !this._readySettled) {
        this._readySettled = true;
        clearTimeout(this._readyTimer);
        this._resolveReady(snapshot);
      }
      return;
    }
    if (data.event === 'failure') {
      this._fail(bridgeError(data.data.code, data.data.message));
      return;
    }
    this._emit(data.event, data.data);
  }

  _updateSnapshot(snapshot, event) {
    // This is the committed frame revision. A later configure request cannot
    // advance it; only a frame snapshot/theme ack can.
    this._frameSourceVersion = snapshot.sourceVersion ?? this.identity.version;
    const key = `${snapshot.index}/${snapshot.step}/${snapshot.maxStep}/${snapshot.slides.length}/${snapshot.background}/${snapshot.scale}/${snapshot.stageAt}/${snapshot.sourceVersion}`;
    if (key === this._lastSnapshotKey) return;
    this._lastSnapshotKey = key;
    this.snapshot = snapshot;
    if (this.onSnapshot) {
      try { this.onSnapshot(snapshot, event); } catch { /* observer failure is isolated */ }
    }
  }

  request(method, params = {}) {
    if (this.destroyed) return Promise.reject(bridgeError('destroyed', 'preview bridge was destroyed'));
    if (!this.port) return Promise.reject(bridgeError('not-connected', 'preview bridge is not connected'));
    let message;
    try {
      message = makeRequest(this.identity, ++this.seq, method, params);
      if (!validateRequest(message, this.identity)) throw new TypeError('invalid request');
    } catch (error) {
      return Promise.reject(error);
    }
    const id = message.id;
    const timeout = method === 'theme.swap'
      ? Math.max(this.rpcTimeoutMs, THEME_SWAP_RPC_TIMEOUT_MS)
      : this.rpcTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(bridgeError('timeout', `preview bridge request timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this._portPostMessage(message); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  themeSwap(name, version, sourceVersion) {
    const params = { name, version };
    if (sourceVersion !== undefined && sourceVersion !== null) params.sourceVersion = sourceVersion;
    return this.request('theme.swap', params);
  }

  pageWheel(event) {
    const source = event || {};
    return this.request('pageWheel', {
      deltaX: isFiniteNumber(source.deltaX) ? source.deltaX : 0,
      deltaY: isFiniteNumber(source.deltaY) ? source.deltaY : 0,
      deltaMode: Number.isSafeInteger(source.deltaMode) && source.deltaMode >= 0 && source.deltaMode <= 2 ? source.deltaMode : 0,
      shiftKey: !!source.shiftKey,
      altKey: !!source.altKey,
      ctrlKey: !!source.ctrlKey,
      metaKey: !!source.metaKey,
    });
  }

  _knownEditKey(key) {
    return key == null || (!!this._editKeys && this._editKeys.has(key));
  }

  _acceptEditLayout(layout) {
    if (layout.sourceVersion !== this._frameSourceVersion) return false;
    if (layout.sequence <= this._lastEditSequence) return false;
    if (this._editKeys && !layout.blocks.every(block => this._editKeys.has(block.key))) return false;
    this._lastEditSequence = layout.sequence;
    this.editLayout = layout;
    if (this.onEditLayout) {
      try { this.onEditLayout(layout); } catch { /* observer failure is isolated */ }
    }
    this._emit('edit.layout', layout);
    return true;
  }

  _acceptEditIntent(intent) {
    if (intent.sourceVersion !== this._frameSourceVersion) return false;
    if (intent.sequence <= this._lastEditSequence) return false;
    if (!this._editKeys) return false;
    if (intent.kind === 'select' || intent.kind === 'stepMenu' || intent.kind === 'hover') {
      if (!this._knownEditKey(intent.key)) return false;
    }
    if ((intent.kind === 'select' || intent.kind === 'stepMenu' || intent.kind === 'key')
      && intent.trusted !== true) return false;
    if (intent.kind === 'key') {
      const rule = this._editKeymap.find(item => item.code === intent.code
        && item.shift === intent.mods.shift && item.alt === intent.mods.alt
        && item.ctrl === intent.mods.ctrl && item.meta === intent.mods.meta);
      if (!rule) return false;
    }
    this._lastEditSequence = intent.sequence;
    if (this.onEditIntent) {
      try { this.onEditIntent(intent); } catch { /* observer failure is isolated */ }
    }
    this._emit('edit.intent', intent);
    return true;
  }

  editConfigure(params) {
    const clean = {
      sourceVersion: params?.sourceVersion,
      keys: Array.isArray(params?.keys) ? params.keys.slice() : params?.keys,
      layers: params?.layers && typeof params.layers === 'object' ? { ...params.layers } : params?.layers,
      keymap: Array.isArray(params?.keymap)
        ? params.keymap.map(rule => ({
          code: rule.code, shift: rule.shift, alt: rule.alt,
          ctrl: rule.ctrl, meta: rule.meta, preventDefault: rule.preventDefault,
        }))
        : params?.keymap,
      enabled: params?.enabled,
    };
    try {
      // Validate before changing the optimistic key set used to accept the
      // layout event that can arrive before the configure response.
      makeRequest(this.identity, 1, 'edit.configure', clean);
    } catch (error) {
      return Promise.reject(error);
    }
    const previousKeys = this._editKeys;
    const previousKeymap = this._editKeymap;
    this._editKeys = new Set(clean.keys);
    this._editKeymap = clean.keymap.slice();
    return this.request('edit.configure', clean).catch(error => {
      this._editKeys = previousKeys;
      this._editKeymap = previousKeymap;
      throw error;
    });
  }

  editSelect(key, frameKey = null) {
    return this.request('edit.select', { key: key ?? null, frameKey: frameKey ?? null });
  }

  editHover(key) {
    return this.request('edit.hover', { key: key ?? null });
  }

  editDesigning(active) {
    return this.request('edit.designing', { active: active === true });
  }

  editLocks(figures, color) {
    return this.request('edit.locks', { figures, color });
  }

  editMeasure() {
    return this.request('edit.measure', {});
  }

  _fail(error) {
    if (this.destroyed) return;
    const failure = this.onFailure;
    this._destroy(error, true);
    if (failure) {
      try { failure(error); } catch { /* observer failure is isolated */ }
    }
  }

  invalidate(reason = 'invalidated') {
    this._destroy(bridgeError('invalidated', reason), false);
  }

  destroy() {
    this._destroy(bridgeError('destroyed', 'preview bridge was destroyed'), false);
  }

  _destroy(error, notify) {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this._readyTimer);
    try { this.window.removeEventListener('message', this._messageHandler); } catch { /* already gone */ }
    try { this.frame.removeEventListener('load', this._frameLoadHandler); } catch { /* already gone */ }
    if (this.port) {
      this.port.onmessage = null;
      try { this._portClose?.(); } catch { /* already closed */ }
      this.port = null;
      this._portPostMessage = null;
      this._portClose = null;
    }
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.editLayout = null;
    this._editKeys = null;
    this._editKeymap = [];
    if (!this._readySettled) {
      this._readySettled = true;
      this._rejectReady(error);
    }
    if (notify) this._emit('failure', { code: error.code, message: error.message });
  }
}
