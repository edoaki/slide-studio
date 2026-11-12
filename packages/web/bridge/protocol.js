// Shared, dependency-free contract for the staged secure preview bridge.
// This file is the runtime half of packages/contracts/src/edit-bridge.ts. Keep
// the protocol string and message shapes in sync; the TypeScript contract is
// owned by the integrator and must not be edited from this stage.
export const PROTOCOL = 'slide-studio-edit/1';

export const EVENT_TYPES = Object.freeze([
  'ready', 'deckchange', 'layout', 'key', 'link.open', 'failure',
]);

// Stage 1 only forwards presentation keys. Keep this an allowlist; do not
// silently turn the key event into an arbitrary shortcut transport.
export const KEY_ALLOWLIST = Object.freeze(['Escape', 'f']);

// Navigation commands are the only operations in stage 1. No command accepts
// HTML, JavaScript, selectors, filesystem paths or an arbitrary remote URL.
export const COMMAND_METHODS = Object.freeze([
  'go', 'move', 'jump', 'goStage', 'resize', 'setFilter', 'theme.swap', 'finish', 'pageWheel',
]);

const MAX_SLIDES = 10000;
const MAX_STEPS = 100000;
const MAX_INDICES = 100000;
const MAX_DELTA = 100000;
const MAX_PAGE = 1000000;

export function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoolean(value) {
  return value === true || value === false;
}

export function isSafeString(value, { allowEmpty = false, max = 4096 } = {}) {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

// The nonce lives only in the URL fragment, e.g. "#3/0&n=<nonce>". Removing it
// must leave the legacy page/step fragment byte-for-byte intact for authored
// deck scripts that run after the first head agent.
export function parseNonceFragment(hash) {
  if (typeof hash !== 'string') return { hash: '', nonce: null };
  if (!hash.startsWith('#')) return { hash, nonce: null };
  const parts = hash.slice(1).split('&');
  let nonce = null;
  const rest = [];
  for (const part of parts) {
    if (part.startsWith('n=')) {
      if (nonce === null) nonce = safeDecode(part.slice(2));
      continue;
    }
    rest.push(part);
  }
  if (nonce === null) return { hash, nonce: null };
  return { hash: rest.length ? `#${rest.join('&')}` : '', nonce };
}

export function stripNonceFromHash(hash) {
  return parseNonceFragment(hash).hash;
}

// "#{1-based page}/{step}&n=..." is the legacy hash plus an opaque nonce.
export function capabilityHash(index, step, nonce) {
  const page = isFiniteInteger(index, 0, MAX_PAGE) ? index + 1 : 1;
  const at = isFiniteInteger(step, 0, MAX_STEPS) ? step : 0;
  return `#${page}/${at}${nonce ? `&n=${encodeURIComponent(nonce)}` : ''}`;
}

export function createIdentity(deck, version, generation) {
  if (!isSafeString(deck) || !isSafeString(version) || !isSafeString(generation)) {
    throw new TypeError('invalid frame identity');
  }
  return { deck, version, generation };
}

export function validateIdentity(value, expected) {
  if (!isRecord(value)) return false;
  if (!isSafeString(value.deck) || !isSafeString(value.version) || !isSafeString(value.generation)) return false;
  if (!expected) return true;
  return value.deck === expected.deck
    && value.version === expected.version
    && value.generation === expected.generation;
}

export function makeHello(nonce) {
  if (!isSafeString(nonce)) throw new TypeError('invalid nonce');
  return { protocol: PROTOCOL, type: 'hello', nonce };
}

export function validateHello(value, expected = {}) {
  if (!isRecord(value)) return false;
  if (value.protocol !== PROTOCOL || value.type !== 'hello') return false;
  if (!isSafeString(value.nonce)) return false;
  if (expected.nonce != null && value.nonce !== expected.nonce) return false;
  if (expected.protocol != null && value.protocol !== expected.protocol) return false;
  return true;
}

function validSlide(value) {
  if (!isRecord(value)) return false;
  if (!isFiniteInteger(value.index, 0, MAX_SLIDES)) return false;
  if (!(value.page === null || isFiniteInteger(value.page, 0, MAX_PAGE))) return false;
  if (!isSafeString(value.id, { allowEmpty: true })) return false;
  if (!isSafeString(value.title, { allowEmpty: true, max: 65536 })) return false;
  if (!isBoolean(value.chapter) || !isBoolean(value.sectionStart)) return false;
  if (!isSafeString(value.group, { allowEmpty: true })) return false;
  if (!isFiniteInteger(value.maxStep, 0, MAX_STEPS)) return false;
  if (!Array.isArray(value.pdfMarks) || !value.pdfMarks.every(m => isFiniteInteger(m, 0, MAX_STEPS))) return false;
  if (value.stageNumbers !== undefined) {
    if (!Array.isArray(value.stageNumbers)) return false;
    if (!value.stageNumbers.every(n => isFiniteInteger(n, 0, MAX_STEPS))) return false;
  }
  return true;
}

export function validateSnapshot(value, expected) {
  if (!isRecord(value)) return false;
  if (!validateIdentity(value, expected)) return false;
  if (!isFiniteInteger(value.index, 0, MAX_SLIDES)) return false;
  if (!isFiniteInteger(value.step, 0, MAX_STEPS)) return false;
  if (!isFiniteInteger(value.maxStep, 0, MAX_STEPS)) return false;
  if (!Array.isArray(value.slides) || value.slides.length > MAX_SLIDES) return false;
  if (!value.slides.every(validSlide)) return false;
  if (typeof value.background !== 'string' || value.background.length > 512) return false;
  if (!isFiniteNumber(value.scale) || value.scale < 0 || value.scale > 1000) return false;
  if (value.sourceVersion !== undefined && !isSafeString(value.sourceVersion, { max: 4096 })) return false;
  if (value.stageAt !== undefined && !isFiniteInteger(value.stageAt, 0, MAX_STEPS)) return false;
  if (value.stageNumbers !== undefined) {
    if (!Array.isArray(value.stageNumbers)) return false;
    if (!value.stageNumbers.every(row => Array.isArray(row) && row.every(n => isFiniteInteger(n, 0, MAX_STEPS)))) return false;
  }
  return true;
}

// Return a fresh, plain copy so caller-owned objects cannot mutate the cache.
export function parseSnapshot(value, expected) {
  if (!validateSnapshot(value, expected)) return null;
  const snapshot = {
    deck: value.deck, version: value.version, generation: value.generation,
    index: value.index, step: value.step, maxStep: value.maxStep,
    background: value.background, scale: value.scale,
    slides: value.slides.map(s => {
      const slide = {
        index: s.index, page: s.page, id: s.id, title: s.title,
        chapter: s.chapter, group: s.group, sectionStart: s.sectionStart,
        maxStep: s.maxStep, pdfMarks: s.pdfMarks.slice(),
      };
      if (Array.isArray(s.stageNumbers)) slide.stageNumbers = s.stageNumbers.slice();
      return slide;
    }),
  };
  if (value.sourceVersion !== undefined) snapshot.sourceVersion = value.sourceVersion;
  if (value.stageAt !== undefined) snapshot.stageAt = value.stageAt;
  if (Array.isArray(value.stageNumbers)) {
    snapshot.stageNumbers = value.stageNumbers.map(row => row.slice());
  }
  return snapshot;
}

export function validateThemeName(name) {
  // A theme name is not a URL. It is encoded once by the content agent and
  // resolved against the fixed /theme/{name}.css content route.
  if (!isSafeString(name, { max: 256 })) return false;
  if (name === '.' || name === '..') return false;
  if (/[\u0000-\u001f\u007f/\\?#]/.test(name)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(name)) return false;
  return true;
}

export function validateParams(method, params) {
  if (!isRecord(params)) params = {};
  switch (method) {
    case 'go':
      return isFiniteInteger(params.index, 0, MAX_SLIDES)
        && isFiniteInteger(params.step, 0, MAX_STEPS);
    case 'move':
    case 'jump':
      return isFiniteInteger(params.delta, -MAX_DELTA, MAX_DELTA);
    case 'goStage':
      return isFiniteInteger(params.stage, 0, MAX_STEPS);
    case 'resize':
    case 'finish':
      return Object.keys(params).length === 0;
    case 'setFilter':
      return params.indices === null
        || (Array.isArray(params.indices)
          && params.indices.length <= MAX_INDICES
          && params.indices.every(i => isFiniteInteger(i, 0, MAX_SLIDES)));
    case 'theme.swap':
      return validateThemeName(params.name)
        && isSafeString(params.version, { max: 512 })
        && (params.sourceVersion === undefined
          || isSafeString(params.sourceVersion, { max: 4096 }));
    case 'pageWheel':
      return isFiniteNumber(params.deltaX) && isFiniteNumber(params.deltaY)
        && Math.abs(params.deltaX) <= 1e6 && Math.abs(params.deltaY) <= 1e6
        && isFiniteInteger(params.deltaMode, 0, 2)
        && isBoolean(params.shiftKey) && isBoolean(params.altKey)
        && isBoolean(params.ctrlKey) && isBoolean(params.metaKey);
    default:
      return false;
  }
}

export function makeRequest(identity, id, method, params = {}) {
  if (!validateIdentity(identity)) throw new TypeError('invalid identity');
  if (!isFiniteInteger(id, 1)) throw new TypeError('invalid request id');
  if (!COMMAND_METHODS.includes(method) || !validateParams(method, params)) {
    throw new TypeError('invalid bridge request');
  }
  return { protocol: PROTOCOL, type: 'request', id, ...identity, method, params };
}

export function validateRequest(value, expected) {
  if (!isRecord(value)) return false;
  if (value.protocol !== PROTOCOL || value.type !== 'request') return false;
  if (!isFiniteInteger(value.id, 1)) return false;
  if (!validateIdentity(value, expected)) return false;
  if (!COMMAND_METHODS.includes(value.method)) return false;
  return validateParams(value.method, value.params);
}

export function makeResponse(identity, id, ok, result, error) {
  const out = { protocol: PROTOCOL, type: 'response', id, ...identity, ok: !!ok };
  if (ok) out.result = result;
  else out.error = { code: error?.code || 'error', message: error?.message || 'error' };
  return out;
}

export function validateResponse(value, expected) {
  if (!isRecord(value)) return false;
  if (value.protocol !== PROTOCOL || value.type !== 'response') return false;
  if (!isFiniteInteger(value.id, 1)) return false;
  if (!validateIdentity(value, expected)) return false;
  if (!isBoolean(value.ok)) return false;
  if (!value.ok) {
    if (!isRecord(value.error)) return false;
    if (!isSafeString(value.error.code, { max: 128 })) return false;
    if (!isSafeString(value.error.message, { max: 2048 })) return false;
  }
  return true;
}

export function makeEvent(identity, event, data) {
  if (!validateIdentity(identity)) throw new TypeError('invalid identity');
  if (!EVENT_TYPES.includes(event)) throw new TypeError('invalid event');
  return { protocol: PROTOCOL, type: 'event', ...identity, event, data };
}

function validLinkOpen(data) {
  if (!isRecord(data) || !isSafeString(data.url, { max: 8192 })) return false;
  try {
    const url = new URL(data.url);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch { return false; }
}

export function validateEvent(value, expected) {
  if (!isRecord(value)) return false;
  if (value.protocol !== PROTOCOL || value.type !== 'event') return false;
  if (!validateIdentity(value, expected)) return false;
  if (!EVENT_TYPES.includes(value.event)) return false;
  if (value.event === 'ready' || value.event === 'deckchange') return validateSnapshot(value.data, expected);
  if (value.event === 'link.open') return validLinkOpen(value.data);
  if (value.event === 'failure') {
    return isRecord(value.data)
      && isSafeString(value.data.code, { max: 128 })
      && isSafeString(value.data.message, { max: 2048 });
  }
  if (value.event === 'key') {
    const data = value.data;
    if (!isRecord(data)) return false;
    if (data.type !== 'keydown' && data.type !== 'keyup') return false;
    if (!isSafeString(data.key, { allowEmpty: true, max: 64 })) return false;
    if (!KEY_ALLOWLIST.includes(data.key)) return false;
    if (data.code !== undefined && !isSafeString(data.code, { allowEmpty: true, max: 64 })) return false;
    if (data.repeat !== undefined && !isBoolean(data.repeat)) return false;
    if (data.isComposing !== undefined && !isBoolean(data.isComposing)) return false;
    if (data.kind !== undefined && !isSafeString(data.kind, { max: 64 })) return false;
    if (!isRecord(data.mods)) return false;
    return isBoolean(data.mods.shift) && isBoolean(data.mods.alt)
      && isBoolean(data.mods.ctrl) && isBoolean(data.mods.meta);
  }
  // layout data is intentionally opaque in stage 1; it is still identity
  // checked and cloned before it reaches a caller.
  return value.data === undefined || isRecord(value.data) || Array.isArray(value.data);
}

export function parsePreviewCapability(value) {
  if (!isRecord(value) || !isSafeString(value.url, { max: 8192 })) {
    throw new TypeError('invalid preview capability');
  }
  let parsed;
  try { parsed = new URL(value.url); } catch { throw new TypeError('invalid preview capability URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('invalid preview capability protocol');
  if (!isSafeString(value.origin, { max: 255 })) throw new TypeError('invalid preview capability origin');
  if (parsed.origin !== value.origin) throw new TypeError('preview capability origin mismatch');
  if (!isSafeString(value.version) && !(isFiniteNumber(value.version) && value.version >= 0)) {
    throw new TypeError('invalid preview capability version');
  }
  return { url: parsed.href, origin: parsed.origin, version: String(value.version) };
}
