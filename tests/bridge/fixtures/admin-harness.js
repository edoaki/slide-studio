// Test-only parent harness. It imports the real bridge modules served from the
// admin origin; the content agent is the separately built classic IIFE.
import {
  AgentClient,
  capabilityUrl,
  createGeneration,
  createNonce,
} from '/bridge/agent-client.js';
import { makeRequest } from '/bridge/protocol.js';
import { installExternalLinks } from '/external-links.js';

const entries = new Map();
const fixtureMessages = [];
const bridgeEvents = [];
const bridgeIntents = [];
const bridgeSnapshots = [];
const bridgeFailures = [];
const siblings = new Set();
let reloadSequence = 0;
let rawSequence = 0;

addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (typeof data.fixtureGeneration === 'string'
    && (data.type === 'forged-hello-posted'
      || (typeof data.type === 'string' && data.type.startsWith('fixture-')))) {
    fixtureMessages.push({ ...data, origin: event.origin });
  }
});

function entryFor(generation) {
  const entry = entries.get(generation);
  if (!entry) throw new Error(`unknown bridge generation: ${generation}`);
  return entry;
}

function finishUrl(value) {
  const url = new URL(value, location.href);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('test URLs must use http(s)');
  }
  return url;
}

function create(options) {
  const generation = options.generation || createGeneration();
  const nonce = options.nonce || createNonce();
  const frameNonce = options.frameNonce ?? nonce;
  const expectedNonce = options.expectedNonce ?? nonce;
  const url = finishUrl(options.url);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('generation', generation);
  const baseUrl = url.href;

  const frame = document.createElement('iframe');
  frame.title = 'bridge e2e';
  frame.dataset.bridgeGeneration = generation;

  const client = new AgentClient({
    frame,
    deck: options.deck || 'deck-test',
    version: options.version || 'v1',
    generation,
    adminOrigin: location.origin,
    contentOrigin: options.contentOrigin,
    nonce: expectedNonce,
    rpcTimeoutMs: options.rpcTimeoutMs ?? 5000,
    readyTimeoutMs: options.readyTimeoutMs ?? 8000,
    onSnapshot: (snapshot, source) => {
      bridgeSnapshots.push({ generation, source, snapshot });
    },
    onEvent: (name, data) => {
      bridgeEvents.push({ generation, name, data });
    },
    onEditIntent: intent => {
      bridgeIntents.push({ generation, ...intent });
      // Minimal parent chrome used only to observe the Stage 2 contract.
      const toolbar = document.getElementById('parent-toolbar');
      if (!toolbar) return;
      if (intent.kind === 'select') toolbar.dataset.key = intent.key || '';
      if (intent.kind === 'hover') {
        toolbar.dataset.hover = intent.key || '';
        const qmd = document.getElementById('qmd-hover');
        if (qmd) qmd.dataset.key = intent.key || '';
      }
      if (intent.kind === 'key') {
        toolbar.dataset.lastKey = intent.code;
        if (intent.type === 'keydown' && (intent.code === 'KeyR' || intent.code === 'KeyF')) {
          toolbar.dataset.pad = intent.code === 'KeyR' ? 'inner' : 'outer';
        }
        if (intent.type === 'keyup' && (intent.code === 'KeyR' || intent.code === 'KeyF')) {
          delete toolbar.dataset.pad;
        }
      }
      if (intent.kind === 'blur') delete toolbar.dataset.pad;
    },
    onFailure: error => {
      bridgeFailures.push({ generation, code: error.code, message: error.message });
    },
  });

  const entry = {
    generation,
    nonce: expectedNonce,
    frameNonce,
    frame,
    client,
    contentOrigin: options.contentOrigin,
    baseUrl,
    status: 'pending',
    error: null,
    snapshot: null,
    portAtReady: null,
    pending: null,
  };
  entries.set(generation, entry);
  installExternalLinks(client);

  client.start();
  client.ready.then(
    snapshot => {
      entry.status = 'ready';
      entry.snapshot = snapshot;
      entry.portAtReady = client.port;
    },
    error => {
      entry.status = 'rejected';
      entry.error = { code: error.code || '', message: error.message || '' };
    },
  );

  frame.src = capabilityUrl(baseUrl, {
    index: options.index ?? 0,
    step: options.step ?? 0,
    nonce: frameNonce,
    mode: options.mode,
  });
  document.body.append(frame);
  return { generation, nonce: expectedNonce, frameNonce, src: frame.src };
}

function addSibling(url, generation) {
  const frame = document.createElement('iframe');
  frame.title = 'bridge e2e sibling';
  frame.dataset.bridgeSibling = generation;
  frame.src = url;
  document.body.append(frame);
  siblings.add(frame);
  return true;
}

function removeSiblings() {
  for (const frame of siblings) frame.remove();
  siblings.clear();
}

function reload(generation, options = {}) {
  const entry = entryFor(generation);
  const url = new URL(entry.baseUrl);
  url.searchParams.set('reload', String(++reloadSequence));
  entry.frame.src = capabilityUrl(url.href, {
    index: options.index ?? 0,
    step: options.step ?? 0,
    nonce: options.nonce || createNonce(),
    mode: options.mode,
  });
  return true;
}

async function ready(generation) {
  return entryFor(generation).client.ready;
}

function status(generation) {
  const entry = entryFor(generation);
  return {
    status: entry.status,
    error: entry.error,
    identity: entry.client.identity,
    destroyed: entry.client.destroyed,
    portNull: entry.client.port === null,
    pending: entry.pending,
  };
}

function snapshot(generation) {
  return entryFor(generation).client.snapshot;
}

function snapshotReads(generation) {
  const api = entryFor(generation).client.api;
  return {
    index: api.index,
    step: api.step,
    count: api.count,
    maxStep: api.maxStep(1),
    pdfMarks: api.pdfMarks(1),
    stageAt: api.stageAt(),
    stageNumber: api.stageNumber(1, 0),
    sourceVersion: entryFor(generation).client.snapshot?.sourceVersion,
  };
}

async function go(generation, index, step = 0) {
  const entry = entryFor(generation);
  await entry.client.api.go(index, step);
  return entry.client.snapshot;
}

async function move(generation, delta = 1) {
  const entry = entryFor(generation);
  await entry.client.api.move(delta);
  return entry.client.snapshot;
}

async function setFilter(generation, indices) {
  const entry = entryFor(generation);
  await entry.client.api.setFilter(indices);
  return entry.client.snapshot;
}

async function themeSwap(generation, name, version, sourceVersion) {
  const entry = entryFor(generation);
  const result = await entry.client.themeSwap(name, version, sourceVersion);
  return { result, snapshot: entry.client.snapshot };
}

async function themeSwapRapid(generation, swaps) {
  const entry = entryFor(generation);
  const results = await Promise.all(swaps.map(swap => entry.client
    .themeSwap(swap.name, swap.version, swap.sourceVersion)
    .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error: error.message }))));
  return { results, snapshot: entry.client.snapshot };
}

function portStable(generation) {
  const entry = entryFor(generation);
  return entry.portAtReady !== null && entry.client.port === entry.portAtReady;
}

function pendingGo(generation) {
  const entry = entryFor(generation);
  entry.pending = { status: 'pending' };
  entry.client.request('go', { index: 999, step: 0 }).then(
    () => { entry.pending = { status: 'fulfilled' }; },
    error => { entry.pending = { status: 'rejected', code: error.code || '', message: error.message || '' }; },
  );
  return true;
}

async function staleRequest(generation, staleGeneration) {
  const entry = entryFor(generation);
  const port = entry.client.port;
  if (!port) throw new Error('no accepted port');
  const id = 1_000_000 + (++rawSequence);
  const message = makeRequest({
    deck: entry.client.identity.deck,
    version: entry.client.identity.version,
    generation: staleGeneration,
  }, id, 'go', { index: 0, step: 0 });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.removeEventListener('message', onMessage);
      reject(new Error('stale request did not receive a response'));
    }, 2500);
    const onMessage = event => {
      const data = event.data;
      if (!data || data.type !== 'response' || data.id !== id) return;
      clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      resolve(data);
    };
    port.addEventListener('message', onMessage);
    port.postMessage(message);
  });
}

function contentCommand(generation, message) {
  const entry = entryFor(generation);
  const target = entry.frame.contentWindow;
  if (!target) return false;
  target.postMessage({ ...message, fixtureGeneration: generation }, entry.contentOrigin);
  return true;
}

function hasMarker(generation, type, label) {
  return fixtureMessages.some(message => message.fixtureGeneration === generation
    && message.type === type
    && (label === undefined || message.label === label));
}

function messages(generation, type) {
  return fixtureMessages.filter(message => message.fixtureGeneration === generation
    && (type === undefined || message.type === type));
}

function events(generation, name) {
  return bridgeEvents.filter(event => event.generation === generation
    && (name === undefined || event.name === name));
}

function failures(generation) {
  return bridgeFailures.filter(failure => failure.generation === generation);
}

function destroy(generation) {
  const entry = entryFor(generation);
  entry.client.destroy();
  entry.frame.remove();
  return true;
}

async function editConfigure(generation, params) {
  const entry = entryFor(generation);
  await entry.client.api.edit.configure(params);
  return {
    sourceVersion: entry.client.api.edit.sourceVersion,
    layout: entry.client.api.edit.layout,
  };
}

async function editSelect(generation, key, frameKey = null) {
  const entry = entryFor(generation);
  return entry.client.api.edit.select(key, frameKey);
}

async function editHover(generation, key) {
  const entry = entryFor(generation);
  return entry.client.api.edit.hover(key);
}

async function editDesigning(generation, active) {
  const entry = entryFor(generation);
  return entry.client.api.edit.designing(active);
}

async function editLocks(generation, figures, color) {
  return entryFor(generation).client.editLocks(figures, color);
}

async function editMeasure(generation) {
  const entry = entryFor(generation);
  return entry.client.api.edit.measure();
}

function editLayout(generation) {
  return entryFor(generation).client.api.edit.layout;
}

function intents(generation, kind) {
  return bridgeIntents.filter(intent => intent.generation === generation
    && (kind === undefined || intent.kind === kind));
}

function placeToolbar(generation, key) {
  const entry = entryFor(generation);
  const layout = entry.client.api.edit.layout;
  const block = layout?.blocks.find(item => item.key === key);
  const rect = block?.rects[0];
  const frameRect = entry.frame.getBoundingClientRect();
  const toolbar = document.getElementById('parent-toolbar');
  if (!rect || !toolbar) return null;
  toolbar.style.left = `${rect.left + frameRect.left}px`;
  toolbar.style.top = `${rect.top + frameRect.top - 32}px`;
  toolbar.dataset.key = key;
  return { layout, frameRect, left: rect.left + frameRect.left, top: rect.top + frameRect.top - 32 };
}

function destroyAll() {
  for (const entry of entries.values()) {
    entry.client.destroy();
    entry.frame.remove();
  }
  removeSiblings();
  return true;
}

window.__bridgeHarness = {
  create,
  addSibling,
  removeSiblings,
  reload,
  ready,
  status,
  snapshot,
  snapshotReads,
  go,
  move,
  setFilter,
  themeSwap,
  themeSwapRapid,
  portStable,
  pendingGo,
  staleRequest,
  contentCommand,
  hasMarker,
  messages,
  events,
  intents,
  editConfigure,
  editSelect,
  editHover,
  editDesigning,
  editMeasure,
  editLocks,
  editLayout,
  placeToolbar,
  failures,
  destroy,
  destroyAll,
};
