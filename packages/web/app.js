import { strings } from './strings.js';

const DESKTOP_API = Object.freeze({
  workspace: '/api/workspace',
  selectWorkspace: '/api/workspace/select',
  decks: '/api/decks'
});

const PREVIEW_DEBOUNCE_MS = 400;
const PREVIEW_BUSY_MAX_RETRIES = 3;
const PREVIEW_BUSY_BASE_DELAY_MS = 300;

const TOKEN = readTokenAndCleanUrl();

const els = {
  app: document.getElementById('app'),
  brandMark: document.getElementById('brand-mark'),
  appName: document.getElementById('app-name'),
  appSubtitle: document.getElementById('app-subtitle'),
  saveStatus: document.getElementById('save-status'),
  saveButton: document.getElementById('save-button'),
  exportGroup: document.getElementById('export-group'),
  exportHtml: document.getElementById('export-html'),
  exportPdf: document.getElementById('export-pdf'),
  exportStatus: document.getElementById('export-status'),
  appError: document.getElementById('app-error'),
  appErrorText: document.getElementById('app-error-text'),
  appErrorRetry: document.getElementById('app-error-retry'),
  sidebar: document.getElementById('sidebar'),
  workspaceLabel: document.getElementById('workspace-label'),
  selectWorkspace: document.getElementById('select-workspace'),
  workspacePath: document.getElementById('workspace-path'),
  workspaceStatus: document.getElementById('workspace-status'),
  deckLabel: document.getElementById('deck-label'),
  deckCount: document.getElementById('deck-count'),
  newDeckForm: document.getElementById('new-deck-form'),
  newTitleLabel: document.getElementById('new-title-label'),
  newTitle: document.getElementById('new-title'),
  newDeck: document.getElementById('new-deck'),
  newDeckError: document.getElementById('new-deck-error'),
  deckList: document.getElementById('deck-list'),
  editorLabel: document.getElementById('editor-label'),
  activeDeckTitle: document.getElementById('active-deck-title'),
  editorNote: document.getElementById('editor-note'),
  conflictRecovery: document.getElementById('conflict-recovery'),
  conflictRecoveryText: document.getElementById('conflict-recovery-text'),
  conflictReload: document.getElementById('conflict-reload'),
  conflictOverwrite: document.getElementById('conflict-overwrite'),
  deckNotice: document.getElementById('deck-notice'),
  sourceEditor: document.getElementById('source-editor'),
  previewLabel: document.getElementById('preview-label'),
  previewStatus: document.getElementById('preview-status'),
  previewStage: document.getElementById('preview-stage'),
  previewFrameWrap: document.getElementById('preview-frame-wrap'),
  previewFrame: document.getElementById('preview-frame'),
  previewPlaceholder: document.getElementById('preview-placeholder'),
  diagnostics: document.getElementById('diagnostics'),
  diagnosticsTitle: document.getElementById('diagnostics-title'),
  diagnosticsCount: document.getElementById('diagnostics-count'),
  diagnosticsList: document.getElementById('diagnostics-list'),
  previousSlide: document.getElementById('previous-slide'),
  slideSelect: document.getElementById('slide-select'),
  nextSlide: document.getElementById('next-slide'),
  pageIndicator: document.getElementById('page-indicator'),
  noticeTrial: document.getElementById('notice-trial'),
  noticeUnavailable: document.getElementById('notice-unavailable'),
  noticePdf: document.getElementById('notice-pdf')
};

const state = {
  booting: true,
  fatal: false,
  workspace: null,
  decks: [],
  currentDeck: null,
  source: '',
  originalSource: '',
  deckGeneration: 0,
  loadingDeck: false,
  workspaceBusy: false,
  creating: false,
  saving: false,
  recovering: false,
  composing: false,
  saveState: 'idle',
  saveErrorCode: '',
  saveErrorText: '',
  conflict: false,
  conflictNotice: '',
  exporting: null,
  exportText: '',
  workspaceNote: '',
  errorRetry: null,
  preview: {
    seq: 0,
    controller: null,
    timer: null,
    status: 'empty',
    url: null,
    origin: null,
    pinnedOrigin: null,
    slides: [],
    warnings: [],
    index: 0,
    readyCount: 0,
    busyAttempt: 0,
    errorText: ''
  }
};

function readTokenAndCleanUrl() {
  let token = '';
  try {
    const rawHash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    token = new URLSearchParams(rawHash).get('token') || '';
  } catch {
    token = '';
  }

  if (window.location.hash) {
    try {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );
    } catch {
      // The token is already in closure memory; URL cleanup is best effort.
    }
  }

  return token;
}

function boot() {
  applyStaticLabels();
  bindEvents();
  renderAll();

  if (!TOKEN) {
    state.booting = false;
    state.fatal = true;
    showAppError(strings.errors.MISSING_TOKEN, null);
    renderAll();
    return;
  }

  void loadInitialWorkspace();
}

function applyStaticLabels() {
  document.title = strings.documentTitle;
  els.brandMark.textContent = strings.brandMark;
  els.appName.textContent = strings.appName;
  els.appSubtitle.textContent = strings.appSubtitle;
  els.workspaceLabel.textContent = strings.workspace.label;
  els.deckLabel.textContent = strings.deck.label;
  els.newTitleLabel.textContent = strings.deck.newTitle;
  els.newTitle.placeholder = strings.deck.newTitle;
  els.newTitle.setAttribute('aria-label', strings.deck.newTitle);
  els.newDeck.textContent = strings.deck.create;
  els.selectWorkspace.textContent = strings.workspace.select;
  els.editorLabel.textContent = strings.editor.label;
  els.sourceEditor.setAttribute('aria-label', strings.editor.label);
  els.sourceEditor.placeholder = strings.editor.placeholderEmpty;
  els.previewLabel.textContent = strings.preview.label;
  els.previewFrame.title = strings.preview.frameTitle;
  els.previousSlide.textContent = strings.preview.previous;
  els.nextSlide.textContent = strings.preview.next;
  els.slideSelect.setAttribute('aria-label', strings.preview.slideSelectLabel);
  els.diagnosticsTitle.textContent = strings.preview.diagnosticsHead;
  els.saveButton.textContent = strings.save.button;
  els.conflictReload.textContent = strings.conflict.reload;
  els.conflictOverwrite.textContent = strings.conflict.overwrite;
  els.exportHtml.textContent = strings.export.html;
  els.exportPdf.textContent = strings.export.pdf;
  els.exportGroup.setAttribute('aria-label', strings.export.groupLabel);
  els.sidebar.setAttribute('aria-label', strings.workspace.sidebarLabel);
  els.appErrorRetry.textContent = strings.errors.retry;
  els.noticeTrial.textContent = strings.notices.trial;
  els.noticeUnavailable.textContent = strings.notices.unavailable;
  els.noticePdf.textContent = strings.notices.pdf;
}

function bindEvents() {
  els.selectWorkspace.addEventListener('click', () => {
    void selectWorkspace();
  });

  els.newDeckForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void createDeck();
  });

  els.newTitle.addEventListener('input', () => {
    hideNewDeckError();
  });

  els.saveButton.addEventListener('click', () => {
    void saveDeck();
  });

  els.exportHtml.addEventListener('click', () => {
    void exportDeck('html');
  });

  els.exportPdf.addEventListener('click', () => {
    void exportDeck('pdf');
  });

  els.deckList.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button[data-deck-id]');
    if (!button || !els.deckList.contains(button)) return;
    void selectDeck(button.dataset.deckId);
  });

  els.sourceEditor.addEventListener('input', onSourceInput);
  els.sourceEditor.addEventListener('compositionstart', () => {
    state.composing = true;
  });
  els.sourceEditor.addEventListener('compositionend', () => {
    state.composing = false;
    if (els.sourceEditor.value !== state.source) {
      onSourceInput();
    } else {
      renderEditor();
    }
  });

  els.conflictReload.addEventListener('click', () => {
    void reloadConflict();
  });

  els.conflictOverwrite.addEventListener('click', () => {
    void overwriteConflict();
  });

  els.previousSlide.addEventListener('click', () => {
    navigateSlide(-1);
  });

  els.nextSlide.addEventListener('click', () => {
    navigateSlide(1);
  });

  els.slideSelect.addEventListener('change', onSlideSelect);

  els.appErrorRetry.addEventListener('click', () => {
    const retry = state.errorRetry;
    if (typeof retry === 'function') void retry();
  });

  window.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('message', onPreviewMessage);
}

function onGlobalKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return;

  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 's'
  ) {
    event.preventDefault();
    if (!state.saving) void saveDeck();
  }
}

function onBeforeUnload(event) {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = '';
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = {
    'X-Studio-Token': TOKEN,
    Accept: 'application/json'
  };
  const init = {
    method,
    headers,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error'
  };

  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw makeApiError('NETWORK', strings.errors.NETWORK, { cause: error });
  }

  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    if (isAbort(error)) throw error;
    throw makeApiError('INVALID_RESPONSE', strings.errors.INVALID_RESPONSE, {
      status: response.status,
      cause: error
    });
  }

  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const extracted = extractErrorPayload(payload, response);
    throw makeApiError(extracted.code, extracted.message, {
      status: response.status,
      currentVersion: extracted.currentVersion
    });
  }

  if (text && payload === null) {
    throw makeApiError('INVALID_RESPONSE', strings.errors.INVALID_RESPONSE, {
      status: response.status
    });
  }

  return payload;
}

function extractErrorPayload(payload, response) {
  let code = '';
  let message = '';
  let currentVersion;

  if (payload && typeof payload === 'object') {
    const error = payload.error;
    if (typeof error === 'string') {
      message = error;
      code = typeof payload.code === 'string' ? payload.code : '';
      currentVersion = payload.currentVersion;
    } else if (error && typeof error === 'object') {
      code = typeof error.code === 'string' ? error.code : '';
      message = typeof error.message === 'string' ? error.message : '';
      currentVersion = error.currentVersion ?? payload.currentVersion;
    } else {
      code = typeof payload.code === 'string' ? payload.code : '';
      message = typeof payload.message === 'string' ? payload.message : '';
      currentVersion = payload.currentVersion;
    }
  }

  const headerVersion =
    response.headers.get('X-Current-Version') ||
    response.headers.get('X-Studio-Current-Version');
  if (currentVersion === undefined && headerVersion) {
    currentVersion = headerVersion;
  }

  if (!code) {
    if (response.status === 404) code = 'NOT_FOUND';
    else if (response.status === 409) code = 'CONFLICT';
    else code = `HTTP_${response.status}`;
  }

  return { code, message, currentVersion };
}

function makeApiError(code, message, extra = {}) {
  const error = new Error(message || code || 'API_ERROR');
  error.code = code || 'UNKNOWN';
  if (extra.status !== undefined) error.status = extra.status;
  if (extra.currentVersion !== undefined) {
    error.currentVersion = extra.currentVersion;
  }
  if (extra.cause) error.cause = extra.cause;
  return error;
}

function isAbort(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

function errorText(error, contextKey) {
  const context =
    contextKey &&
    Object.prototype.hasOwnProperty.call(strings.errors, contextKey)
      ? strings.errors[contextKey]
      : strings.errors.generic;
  const code = typeof error?.code === 'string' ? error.code : '';
  const mapped =
    code && Object.prototype.hasOwnProperty.call(strings.errors, code)
      ? strings.errors[code]
      : '';
  let text = context;
  if (mapped && mapped !== context) text += ` ${mapped}`;
  if (code) text += ` [${code}]`;
  return text;
}

function format(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (token, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return token;
    return String(values[key]);
  });
}

function uiBusy() {
  return (
    state.booting ||
    state.workspaceBusy ||
    state.loadingDeck ||
    state.creating
  );
}

function navigationLocked() {
  return (
    state.fatal ||
    uiBusy() ||
    state.saving ||
    state.recovering ||
    Boolean(state.exporting)
  );
}

function isDirty() {
  return Boolean(
    state.currentDeck && state.source !== state.originalSource
  );
}

async function loadInitialWorkspace() {
  state.booting = true;
  hideAppError();
  renderAll();

  let info;
  try {
    info = await api(DESKTOP_API.workspace);
  } catch (error) {
    if (isAbort(error)) return;
    state.booting = false;
    showAppError(errorText(error, 'workspaceLoad'), loadInitialWorkspace);
    renderAll();
    return;
  }

  hideAppError();
  adoptWorkspace(info);
  state.booting = false;
  renderAll();

  if (state.decks.length > 0) {
    await selectDeck(state.decks[0].id, { skipConfirm: true });
  }
}

function adoptWorkspace(info) {
  const workspace = info && typeof info === 'object' ? info : {};
  state.deckGeneration += 1;
  resetPreview();
  state.workspace = workspace;
  state.decks = Array.isArray(workspace.decks)
    ? workspace.decks.filter(isDeckSummary).map(normalizeDeckSummary)
    : [];
  state.currentDeck = null;
  state.source = '';
  state.originalSource = '';
  state.loadingDeck = false;
  state.creating = false;
  state.saving = false;
  state.recovering = false;
  state.composing = false;
  state.saveState = 'idle';
  state.saveErrorCode = '';
  state.saveErrorText = '';
  state.conflict = false;
  state.conflictNotice = '';
  state.exporting = null;
  state.exportText = '';
  state.workspaceNote = '';
  els.newTitle.value = '';
  hideNewDeckError();
  renderAll();
}

function clearDeckState() {
  state.deckGeneration += 1;
  state.currentDeck = null;
  state.source = '';
  state.originalSource = '';
  state.saveState = 'idle';
  state.saveErrorCode = '';
  state.saveErrorText = '';
  state.conflict = false;
  state.conflictNotice = '';
  state.recovering = false;
  state.composing = false;
  state.exporting = null;
  state.exportText = '';
  resetPreview();
  renderAll();
}

async function selectDeck(id, options = {}) {
  if (!id || state.saving) return;
  if (!options.skipConfirm && state.currentDeck?.id === id) return;
  if (navigationLocked() && !options.skipConfirm) return;

  if (!options.skipConfirm && isDirty()) {
    if (!window.confirm(strings.confirm.switchDeck)) return;
  }

  const generation = ++state.deckGeneration;
  state.loadingDeck = true;
  state.workspaceNote = '';
  hideAppError();
  renderAll();

  try {
    const document = await api(`/api/deck/${encodeURIComponent(id)}/source`);
    if (generation !== state.deckGeneration) return;
    applyDeckDocument(document);
    hideAppError();
  } catch (error) {
    if (isAbort(error) || generation !== state.deckGeneration) return;
    state.loadingDeck = false;
    showAppError(errorText(error, 'deckLoad'), () => selectDeck(id));
    if (state.currentDeck) {
      state.preview.busyAttempt = 0;
      schedulePreview(0);
    }
    renderAll();
    return;
  } finally {
    if (generation === state.deckGeneration) {
      state.loadingDeck = false;
      renderAll();
    }
  }
}

function applyDeckDocument(document) {
  const source = typeof document?.source === 'string' ? document.source : '';
  const deck = normalizeDeckDocument(document, source);
  state.currentDeck = deck;
  state.source = source;
  state.originalSource = source;
  state.saveState = 'saved';
  state.saveErrorCode = '';
  state.saveErrorText = '';
  state.conflict = false;
  state.conflictNotice = '';
  state.exportText = '';
  upsertDeckSummary(deck);
  hideNewDeckError();
  resetPreview();
  renderAll();
  schedulePreview(0);
}

async function createDeck() {
  if (navigationLocked()) return;

  const title = els.newTitle.value.trim();
  hideNewDeckError();
  if (!title) {
    showNewDeckError(strings.errors.TITLE_REQUIRED);
    els.newTitle.focus();
    return;
  }

  if (isDirty() && !window.confirm(strings.confirm.createDeck)) return;

  const generation = ++state.deckGeneration;
  state.creating = true;
  renderAll();

  try {
    const document = await api(DESKTOP_API.decks, {
      method: 'POST',
      body: { title }
    });
    if (generation !== state.deckGeneration) return;

    const summary = normalizeDeckDocument(
      document,
      typeof document?.source === 'string' ? document.source : ''
    );
    upsertDeckSummary(summary, { prepend: true });
    els.newTitle.value = '';
    hideNewDeckError();
    applyDeckDocument(document);
    hideAppError();
  } catch (error) {
    if (isAbort(error) || generation !== state.deckGeneration) return;
    showNewDeckError(errorText(error, 'deckCreate'));
    if (state.currentDeck) {
      state.preview.busyAttempt = 0;
      schedulePreview(0);
    }
  } finally {
    state.creating = false;
    renderAll();
  }
}

async function selectWorkspace() {
  if (navigationLocked()) return;

  if (isDirty() && !window.confirm(strings.confirm.switchWorkspace)) return;

  state.workspaceBusy = true;
  state.workspaceNote = '';
  renderAll();

  try {
    const result = await api(DESKTOP_API.selectWorkspace, {
      method: 'POST',
      body: {}
    });

    if (!result || result.cancelled === true) {
      state.workspaceNote = strings.workspace.cancelled;
      return;
    }

    hideAppError();
    adoptWorkspace(result);
    state.workspaceBusy = false;
    renderAll();

    if (state.decks.length > 0) {
      await selectDeck(state.decks[0].id, { skipConfirm: true });
    } else {
      clearDeckState();
    }
  } catch (error) {
    if (isAbort(error)) return;
    showAppError(errorText(error, 'workspaceSelect'), selectWorkspace);
  } finally {
    state.workspaceBusy = false;
    renderAll();
  }
}

async function saveDeck(options = {}) {
  const recovery = options.recovery === true;

  if (!state.currentDeck || state.saving) return;
  if (!recovery && (uiBusy() || state.recovering || state.exporting)) return;
  if (state.currentDeck.readOnly) return;
  if (!recovery && (state.conflict || state.saveState === 'conflict')) return;

  if (!recovery && !isDirty()) {
    state.saveState = 'saved';
    renderSaveState();
    return;
  }

  const deck = state.currentDeck;
  const generation = state.deckGeneration;
  const sourceAtSave =
    recovery && typeof options.source === 'string'
      ? options.source
      : state.source;
  const versionAtSave =
    recovery && typeof options.version === 'string'
      ? options.version
      : deck.version;

  state.saving = true;
  state.saveState = 'saving';
  state.saveErrorCode = '';
  state.saveErrorText = '';
  state.conflict = false;
  state.conflictNotice = '';
  // Disable navigation while the version compare/write is in flight, but keep
  // the editor editable so keystrokes made during the request are never lost.
  renderAll();

  let saved;
  try {
    saved = await api(
      `/api/deck/${encodeURIComponent(deck.id)}/source`,
      {
        method: 'PUT',
        body: {
          source: sourceAtSave,
          version: versionAtSave
        }
      }
    );
  } catch (error) {
    state.saving = false;

    if (
      isAbort(error) ||
      generation !== state.deckGeneration ||
      state.currentDeck?.id !== deck.id
    ) {
      renderAll();
      return;
    }

    if (error.status === 409 || error.code === 'CONFLICT') {
      state.conflict = true;
      state.saveState = 'conflict';
      state.saveErrorCode = 'CONFLICT';
      state.saveErrorText = strings.save.conflictDetail;
      state.conflictNotice = '';
    } else if (recovery) {
      // The external change is still unresolved; keep the recovery actions.
      state.conflict = true;
      state.saveState = 'conflict';
      state.saveErrorCode = error.code || '';
      state.saveErrorText = errorText(error, 'save');
      state.conflictNotice = errorText(error, 'conflictRecovery');
    } else {
      state.conflict = false;
      state.saveState = 'error';
      state.saveErrorCode = error.code || '';
      state.saveErrorText = errorText(error, 'save');
    }

    renderAll();
    return;
  }

  state.saving = false;

  const savedTitle =
    typeof saved?.title === 'string' ? saved.title : deck.title;
  const savedUpdatedAt =
    typeof saved?.updatedAt === 'string' ? saved.updatedAt : deck.updatedAt;

  if (state.decks.some((item) => item.id === deck.id)) {
    upsertDeckSummary({
      id: deck.id,
      title: savedTitle,
      updatedAt: savedUpdatedAt
    });
  }

  if (
    generation !== state.deckGeneration ||
    state.currentDeck?.id !== deck.id
  ) {
    renderAll();
    return;
  }

  const savedSource =
    typeof saved?.source === 'string' ? saved.source : sourceAtSave;
  const unchangedSinceSave = state.source === sourceAtSave;

  if (unchangedSinceSave) {
    state.source = savedSource;
    state.originalSource = savedSource;
  } else {
    // Keep the newer editor text. The version that was actually written is
    // the baseline for the next dirty check.
    state.originalSource = sourceAtSave;
  }

  state.currentDeck = {
    ...state.currentDeck,
    title: savedTitle,
    updatedAt: savedUpdatedAt,
    version:
      typeof saved?.version === 'string'
        ? saved.version
        : state.currentDeck.version,
    readOnly:
      typeof saved?.readOnly === 'boolean'
        ? saved.readOnly
        : state.currentDeck.readOnly,
    eol: saved?.eol || state.currentDeck.eol,
    bom:
      typeof saved?.bom === 'boolean' ? saved.bom : state.currentDeck.bom,
    diagnostics: Array.isArray(saved?.diagnostics)
      ? normalizeWarnings(saved.diagnostics)
      : state.currentDeck.diagnostics,
    source: state.source
  };

  state.saveState = isDirty() ? 'unsaved' : 'saved';
  state.saveErrorCode = '';
  state.saveErrorText = '';
  state.conflict = false;
  state.conflictNotice = '';

  hideAppError();
  renderAll();
}

function conflictBusy() {
  return Boolean(
    state.saving ||
      state.recovering ||
      state.exporting ||
      uiBusy()
  );
}

async function reloadConflict() {
  if (!state.currentDeck || !state.conflict || conflictBusy()) return;
  if (!window.confirm(strings.conflict.reloadConfirm)) return;

  const deck = state.currentDeck;
  const generation = state.deckGeneration;
  const localSource = state.source;
  const shouldCopy =
    isDirty() && window.confirm(strings.conflict.copyBeforeReload);

  state.recovering = true;
  state.conflictNotice = '';
  renderAll();

  try {
    if (shouldCopy) {
      await copyLocalSourceToNewDeck(localSource);
    }

    const fresh = await api(
      `/api/deck/${encodeURIComponent(deck.id)}/source`
    );
    if (
      generation !== state.deckGeneration ||
      state.currentDeck?.id !== deck.id
    ) {
      return;
    }

    applyDeckDocument(fresh);
    hideAppError();
  } catch (error) {
    if (isAbort(error)) return;
    if (
      generation !== state.deckGeneration ||
      state.currentDeck?.id !== deck.id
    ) {
      return;
    }
    state.conflict = true;
    state.saveState = 'conflict';
    state.conflictNotice = errorText(error, 'conflictRecovery');
  } finally {
    state.recovering = false;
    renderAll();
  }
}

async function overwriteConflict() {
  if (!state.currentDeck || !state.conflict || conflictBusy()) return;
  if (state.currentDeck.readOnly) {
    state.conflictNotice = strings.editor.readOnly;
    renderConflictRecovery();
    return;
  }
  if (!window.confirm(strings.conflict.overwriteConfirm)) return;

  const deck = state.currentDeck;
  const generation = state.deckGeneration;
  const localSource = state.source;

  state.recovering = true;
  state.conflictNotice = '';
  renderAll();

  try {
    // The contract does not place currentVersion reliably on HTTP errors, so
    // fetch the authoritative version without adopting the external source.
    const fresh = await api(
      `/api/deck/${encodeURIComponent(deck.id)}/source`
    );
    if (
      generation !== state.deckGeneration ||
      state.currentDeck?.id !== deck.id
    ) {
      return;
    }

    const version = typeof fresh?.version === 'string' ? fresh.version : '';
    if (!version) {
      throw makeApiError(
        'INVALID_RESPONSE',
        strings.errors.INVALID_RESPONSE
      );
    }

    await saveDeck({
      recovery: true,
      source: localSource,
      version
    });
  } catch (error) {
    if (isAbort(error)) return;
    if (
      generation !== state.deckGeneration ||
      state.currentDeck?.id !== deck.id
    ) {
      return;
    }
    state.conflict = true;
    state.saveState = 'conflict';
    state.conflictNotice = errorText(error, 'conflictRecovery');
  } finally {
    state.recovering = false;
    renderAll();
  }
}

async function copyLocalSourceToNewDeck(localSource) {
  const created = await api(DESKTOP_API.decks, {
    method: 'POST',
    body: { title: strings.conflict.copyDeckTitle }
  });

  const id =
    created && (typeof created.id === 'string' || typeof created.id === 'number')
      ? String(created.id)
      : '';
  const version = typeof created?.version === 'string' ? created.version : '';
  if (!id || !version) {
    throw makeApiError('INVALID_RESPONSE', strings.errors.INVALID_RESPONSE);
  }

  const saved = await api(`/api/deck/${encodeURIComponent(id)}/source`, {
    method: 'PUT',
    body: { source: localSource, version }
  });

  const title =
    typeof saved?.title === 'string'
      ? saved.title
      : typeof created.title === 'string'
        ? created.title
        : strings.conflict.copyDeckTitle;
  const updatedAt =
    typeof saved?.updatedAt === 'string'
      ? saved.updatedAt
      : typeof created.updatedAt === 'string'
        ? created.updatedAt
        : '';

  upsertDeckSummary({ id, title, updatedAt }, { prepend: true });
  renderDeckList();
}

function onSourceInput() {
  if (
    !state.currentDeck ||
    state.currentDeck.readOnly ||
    uiBusy() ||
    state.recovering
  ) {
    return;
  }

  state.source = els.sourceEditor.value;
  state.preview.busyAttempt = 0;

  if (!state.saving) {
    if (state.conflict) {
      state.saveState = 'conflict';
    } else {
      state.saveState = isDirty() ? 'unsaved' : 'saved';
      state.saveErrorCode = '';
      state.saveErrorText = '';
    }
  }

  renderSaveState();
  renderEditorMeta();
  renderDeckNotice();
  schedulePreview(PREVIEW_DEBOUNCE_MS);
}

async function exportDeck(format) {
  if (
    !state.currentDeck ||
    state.exporting ||
    navigationLocked() ||
    (format !== 'html' && format !== 'pdf')
  ) {
    return;
  }

  const deck = state.currentDeck;
  const generation = state.deckGeneration;
  const sourceAtExport = state.source;

  state.exporting = format;
  state.exportText = strings.export.busy;
  renderAll();

  try {
    const result = await api(`/api/deck/${encodeURIComponent(deck.id)}/export`, {
      method: 'POST',
      body: { format, source: sourceAtExport }
    });

    if (generation !== state.deckGeneration || state.currentDeck?.id !== deck.id) {
      return;
    }

    if (!result || result.file === null || result.file === undefined) {
      state.exportText = strings.export.cancelled;
    } else {
      const file = basename(String(result.file));
      state.exportText = format(strings.export.saved, { file });
    }
  } catch (error) {
    if (generation !== state.deckGeneration || state.currentDeck?.id !== deck.id) {
      return;
    }
    state.exportText = errorText(error, 'export');
  } finally {
    state.exporting = null;
    renderAll();
  }
}

function basename(value) {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

function schedulePreview(delay = PREVIEW_DEBOUNCE_MS) {
  if (!state.currentDeck) return;
  if (state.preview.timer !== null) {
    window.clearTimeout(state.preview.timer);
    state.preview.timer = null;
  }

  state.preview.timer = window.setTimeout(() => {
    state.preview.timer = null;
    void requestPreview();
  }, Math.max(0, delay));
}

async function requestPreview() {
  if (!state.currentDeck) return;

  const delegation = state.currentDeck;
  const generation = state.deckGeneration;
  const sourceAtRequest = state.source;
  const sequence = ++state.preview.seq;

  if (state.preview.controller) {
    state.preview.controller.abort();
  }
  const controller = new AbortController();
  state.preview.controller = controller;

  state.preview.status = 'loading';
  state.preview.errorText = '';
  renderPreviewStatus();
  renderPreviewPlaceholder();

  try {
    const response = await api(
      `/api/deck/${encodeURIComponent(delegation.id)}/preview`,
      {
        method: 'POST',
        body: { source: sourceAtRequest },
        signal: controller.signal
      }
    );

    if (
      sequence !== state.preview.seq ||
      generation !== state.deckGeneration ||
      state.currentDeck?.id !== delegation.id
    ) {
      return;
    }

    const url = validatePreviewUrl(response?.url);
    const slides = normalizeSlides(response?.slides);
    const warnings = normalizeWarnings(response?.warnings);

    if (!state.preview.pinnedOrigin) {
      state.preview.pinnedOrigin = url.origin;
    }
    state.preview.origin = url.origin;
    state.preview.url = url.href;
    state.preview.slides = slides;
    state.preview.warnings = warnings;
    state.preview.readyCount = slides.length;
    state.preview.busyAttempt = 0;
    state.preview.status = 'ready';
    state.preview.errorText = '';

    if (!slides.some((slide) => slide.index === state.preview.index)) {
      state.preview.index = slides.length > 0 ? slides[0].index : 0;
    }

    els.previewFrame.src = url.href;
    renderPreview();
  } catch (error) {
    if (isAbort(error)) return;
    if (
      sequence !== state.preview.seq ||
      generation !== state.deckGeneration
    ) {
      return;
    }

    if (state.source !== sourceAtRequest) {
      // A newer edit owns the next preview request and its debounce timer.
      return;
    }

    const busy = error.code === 'BUSY' || error.status === 503;
    if (busy && state.preview.busyAttempt < PREVIEW_BUSY_MAX_RETRIES) {
      state.preview.busyAttempt += 1;
      state.preview.status = 'loading';
      state.preview.errorText = '';
      renderPreviewStatus();
      renderPreviewPlaceholder();
      schedulePreview(
        PREVIEW_BUSY_BASE_DELAY_MS *
          2 ** (state.preview.busyAttempt - 1)
      );
      return;
    }

    state.preview.status = 'error';
    state.preview.errorText = errorText(error, 'preview');
    renderPreview();
  } finally {
    if (sequence === state.preview.seq) {
      state.preview.controller = null;
    }
  }
}

function validatePreviewUrl(value) {
  let url;
  const raw = typeof value === 'string' ? value : String(value ?? '');
  try {
    url = new URL(raw);
  } catch {
    throw makeApiError(
      'INVALID_PREVIEW_URL',
      strings.errors.INVALID_PREVIEW_URL
    );
  }

  let decodedHref = url.href;
  try {
    decodedHref = decodeURIComponent(url.href);
  } catch {
    decodedHref = url.href;
  }
  const hasToken =
    TOKEN.length > 0 &&
    (url.href.includes(TOKEN) ||
      decodedHref.includes(TOKEN) ||
      raw.includes(TOKEN));
  const outsidePinnedOrigin =
    state.preview.pinnedOrigin !== null &&
    url.origin !== state.preview.pinnedOrigin;

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.origin === window.location.origin ||
    hasToken ||
    outsidePinnedOrigin
  ) {
    throw makeApiError(
      'INVALID_PREVIEW_URL',
      strings.errors.INVALID_PREVIEW_URL
    );
  }

  return url;
}

function resetPreview() {
  state.preview.seq += 1;

  if (state.preview.timer !== null) {
    window.clearTimeout(state.preview.timer);
    state.preview.timer = null;
  }

  if (state.preview.controller) {
    state.preview.controller.abort();
    state.preview.controller = null;
  }

  state.preview.status = 'empty';
  state.preview.url = null;
  state.preview.origin = null;
  state.preview.slides = [];
  state.preview.warnings = [];
  state.preview.index = 0;
  state.preview.readyCount = 0;
  state.preview.busyAttempt = 0;
  state.preview.errorText = '';
  // Keep pinnedOrigin across decks/workspaces. The host's content origin is
  // stable for the lifetime of this admin page.
  els.previewFrame.hidden = true;
  els.previewFrame.removeAttribute('src');
  els.previewFrameWrap.hidden = true;
}

function onPreviewMessage(event) {
  const preview = state.preview;
  if (!preview.origin || !preview.url) return;
  if (event.origin !== preview.origin) return;
  if (!els.previewFrame.contentWindow) return;
  if (event.source !== els.previewFrame.contentWindow) return;

  const data = event.data;
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
    return;
  }

  if (data.type === 'slide-studio:ready') {
    const count = Number(data.count);
    if (Number.isInteger(count) && count >= 0) {
      preview.readyCount = count;
    }
    if (preview.index > 0) postGoTo(preview.index);
    return;
  }

  if (data.type === 'slide-studio:page') {
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0) return;
    const slide = preview.slides.find((item) => item.index === index);
    if (!slide) return;
    preview.index = index;
    renderSlides();
  }
}

function postGoTo(index) {
  if (!Number.isInteger(index) || index < 0) return;
  if (!state.preview.origin || !state.preview.url) return;
  const frameWindow = els.previewFrame.contentWindow;
  if (!frameWindow) return;

  frameWindow.postMessage(
    { type: 'slide-studio:go', index, step: 0 },
    state.preview.origin
  );
}

function navigateSlide(delta) {
  const slides = state.preview.slides;
  if (!slides.length || navigationLocked()) return;

  let position = slides.findIndex(
    (slide) => slide.index === state.preview.index
  );
  if (position < 0) position = 0;

  const nextPosition = Math.min(
    Math.max(position + delta, 0),
    slides.length - 1
  );
  const slide = slides[nextPosition];
  state.preview.index = slide.index;
  renderSlides();
  postGoTo(slide.index);
}

function onSlideSelect() {
  if (navigationLocked()) return;
  const index = Number(els.slideSelect.value);
  if (!Number.isInteger(index)) return;
  const slide = state.preview.slides.find((item) => item.index === index);
  if (!slide) return;
  state.preview.index = index;
  renderSlides();
  postGoTo(index);
}

function renderAll() {
  els.app.dataset.dirty = String(isDirty());
  els.app.dataset.busy = String(uiBusy());
  els.app.setAttribute('aria-busy', String(uiBusy()));

  renderWorkspace();
  renderDeckList();
  renderNewDeckControls();
  renderEditor();
  renderConflictRecovery();
  renderDeckNotice();
  renderSaveState();
  renderExportState();
  renderPreview();
}

function renderWorkspace() {
  const path = state.workspace?.root;
  const workspacePath =
    typeof path === 'string' && path.length > 0
      ? path
      : state.booting
        ? strings.workspace.loading
        : strings.workspace.none;

  els.workspacePath.textContent = workspacePath;
  els.workspacePath.title = workspacePath;
  els.workspaceStatus.textContent = state.workspaceNote;
  els.workspaceStatus.hidden = !state.workspaceNote;
  els.selectWorkspace.textContent = state.workspaceBusy
    ? strings.workspace.selecting
    : strings.workspace.select;
  els.selectWorkspace.disabled = navigationLocked();
}

function renderDeckList() {
  els.deckList.replaceChildren();
  els.deckCount.textContent = format(strings.deck.count, {
    count: state.decks.length
  });
  els.deckList.setAttribute('aria-busy', String(state.booting || state.loadingDeck));

  if (state.booting && !state.workspace) {
    appendDeckListNote(strings.deck.loading);
    return;
  }

  if (state.decks.length === 0) {
    appendDeckListNote(strings.deck.empty);
    return;
  }

  const locked = navigationLocked();

  for (const deck of state.decks) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const title = deck.title || strings.deck.untitled;

    button.type = 'button';
    button.className = 'deck-item';
    button.dataset.deckId = deck.id;
    button.textContent = title;
    button.title = title;
    button.disabled = locked;
    if (state.currentDeck?.id === deck.id) {
      button.setAttribute('aria-current', 'true');
    }
    item.append(button);
    els.deckList.append(item);
  }
}

function appendDeckListNote(text) {
  const item = document.createElement('li');
  item.className = 'deck-list-empty';
  item.textContent = text;
  els.deckList.append(item);
}

function renderNewDeckControls() {
  const locked = navigationLocked();
  els.newTitle.disabled = locked;
  els.newDeck.disabled = locked;
  els.newDeck.textContent = state.creating
    ? strings.deck.creating
    : strings.deck.create;
}

function syncEditorValue() {
  if (els.sourceEditor.value === state.source) return;
  if (state.composing) return;

  const selectionStart = els.sourceEditor.selectionStart;
  const selectionEnd = els.sourceEditor.selectionEnd;
  const selectionDirection = els.sourceEditor.selectionDirection;
  const scrollTop = els.sourceEditor.scrollTop;
  const scrollLeft = els.sourceEditor.scrollLeft;

  els.sourceEditor.value = state.source;

  const max = state.source.length;
  try {
    els.sourceEditor.setSelectionRange(
      Math.min(selectionStart, max),
      Math.min(selectionEnd, max),
      selectionDirection || 'none'
    );
  } catch {
    // Selection restoration is cosmetic; never block rendering for it.
  }
  els.sourceEditor.scrollTop = scrollTop;
  els.sourceEditor.scrollLeft = scrollLeft;
}

function renderEditor() {
  syncEditorValue();

  const deck = state.currentDeck;
  const locked =
    !deck || uiBusy() || state.recovering || deck.readOnly;
  els.sourceEditor.readOnly = locked;
  els.sourceEditor.setAttribute('aria-readonly', String(locked));
  els.sourceEditor.placeholder = deck
    ? strings.editor.placeholder
    : strings.editor.placeholderEmpty;
  els.activeDeckTitle.textContent = deck
    ? deck.title || strings.deck.untitled
    : strings.editor.noDeckTitle;
  els.activeDeckTitle.title = els.activeDeckTitle.textContent;
  renderEditorMeta();
}

function renderEditorMeta() {
  const deck = state.currentDeck;
  let note = '';

  if (deck) {
    if (deck.readOnly) {
      note = isDirty()
        ? strings.editor.readOnlyDirty
        : strings.editor.readOnly;
    } else if (state.recovering) {
      note = strings.conflict.busy;
    } else if (state.loadingDeck) {
      note = strings.editor.loading;
    } else if (isDirty()) {
      note = strings.editor.unsaved;
    }
  }

  els.editorNote.textContent = note;
  els.editorNote.title = note;
}

function renderConflictRecovery() {
  const visible = Boolean(state.currentDeck && state.conflict);
  els.conflictRecovery.hidden = !visible;

  if (!visible) {
    els.conflictRecoveryText.textContent = '';
    return;
  }

  let text = strings.conflict.hint;
  if (state.recovering && !state.saving) {
    text += ` ${strings.conflict.busy}`;
  }
  if (state.conflictNotice) {
    text += ` ${state.conflictNotice}`;
  }
  els.conflictRecoveryText.textContent = text;

  const busy = conflictBusy();
  els.conflictReload.disabled = busy;
  els.conflictOverwrite.disabled = busy;
}

function renderDeckNotice() {
  const deck = state.currentDeck;
  const messages = [];

  if (deck) {
    if (deck.readOnly && isDirty()) {
      messages.push(strings.editor.readOnlyDirty);
    }
    if (deck.eol === 'mixed') {
      messages.push(
        deck.readOnly
          ? strings.editor.mixedEolReadOnly
          : strings.editor.mixedEol
      );
    }
    if (deck.bom) messages.push(strings.editor.bom);
  }

  els.deckNotice.textContent = messages.join(' ');
  els.deckNotice.hidden = messages.length === 0;
}

function renderSaveState() {
  const deck = state.currentDeck;
  let text = '';
  let statusState = 'idle';
  let title = '';

  if (!deck) {
    text = strings.save.none;
  } else if (deck.readOnly) {
    text = isDirty()
      ? strings.save.readOnlyDirty
      : strings.save.readOnly;
    statusState = 'readonly';
    if (isDirty()) title = strings.editor.readOnlyDirty;
  } else if (state.saving) {
    text = strings.save.saving;
    statusState = 'saving';
  } else if (state.saveState === 'conflict' || state.conflict) {
    text = strings.save.conflict;
    statusState = 'conflict';
    title = state.saveErrorText || strings.save.conflictDetail;
  } else if (state.saveState === 'error') {
    text = strings.save.error;
    if (state.saveErrorCode) text += ` (${state.saveErrorCode})`;
    statusState = 'error';
    title = state.saveErrorText || text;
  } else if (isDirty()) {
    text = strings.save.unsaved;
    statusState = 'unsaved';
  } else {
    text = strings.save.saved;
    statusState = 'saved';
  }

  els.saveStatus.textContent = text;
  els.saveStatus.dataset.state = statusState;
  els.saveStatus.title = title || text;
  els.saveButton.disabled =
    !deck ||
    deck.readOnly ||
    state.saving ||
    state.recovering ||
    Boolean(state.exporting) ||
    state.conflict ||
    state.saveState === 'conflict' ||
    !isDirty() ||
    uiBusy();
}

function renderExportState() {
  const deck = state.currentDeck;
  const blocked =
    !deck ||
    Boolean(state.exporting) ||
    state.saving ||
    state.recovering ||
    uiBusy();

  els.exportHtml.disabled = blocked;
  els.exportPdf.disabled = blocked;
  els.exportHtml.textContent =
    state.exporting === 'html' ? strings.export.busy : strings.export.html;
  els.exportPdf.textContent =
    state.exporting === 'pdf' ? strings.export.busy : strings.export.pdf;
  els.exportGroup.setAttribute('aria-busy', String(Boolean(state.exporting)));

  els.exportStatus.textContent = state.exportText;
  els.exportStatus.title = state.exportText;
  els.exportStatus.hidden = !state.exportText;
}

function combinedDiagnostics() {
  const combined = [];
  const seen = new Set();
  const source = [
    ...(state.currentDeck?.diagnostics || []),
    ...state.preview.warnings
  ];

  for (const diagnostic of source) {
    const key = [
      diagnostic.line ?? '',
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(diagnostic);
  }

  return combined;
}

function renderPreview() {
  renderPreviewStatus();
  renderPreviewPlaceholder();
  renderSlides();
  renderDiagnostics();
}

function renderPreviewStatus() {
  let text = '';
  let statusState = 'idle';
  let title = '';

  if (!state.currentDeck) {
    text = state.booting
      ? strings.preview.loading
      : strings.preview.emptyNoDeck;
    if (state.booting) statusState = 'loading';
  } else if (state.preview.status === 'loading') {
    text =
      state.preview.busyAttempt > 0
        ? strings.preview.retrying
        : strings.preview.loading;
    statusState = 'loading';
  } else if (state.preview.status === 'ready') {
    const warningCount = combinedDiagnostics().length;
    text =
      warningCount > 0
        ? format(strings.preview.readyWithWarnings, {
            count: warningCount
          })
        : strings.preview.ready;
    statusState = 'ready';
  } else if (state.preview.status === 'error') {
    text = strings.preview.error;
    statusState = 'error';
    title = state.preview.errorText;
  } else {
    text = strings.preview.empty;
  }

  els.previewStatus.textContent = text;
  els.previewStatus.dataset.state = statusState;
  els.previewStatus.title = title || text;
}

function renderPreviewPlaceholder() {
  const hasFrame = Boolean(state.preview.url);
  els.previewFrame.hidden = !hasFrame;
  els.previewFrameWrap.hidden = !hasFrame;

  if (hasFrame) {
    els.previewPlaceholder.hidden = true;
    els.previewPlaceholder.textContent = '';
    return;
  }

  let text = '';
  if (!state.currentDeck) {
    text = state.booting
      ? strings.preview.loading
      : strings.preview.emptyNoDeck;
  } else if (state.preview.status === 'loading') {
    text =
      state.preview.busyAttempt > 0
        ? strings.preview.retrying
        : strings.preview.loading;
  } else if (state.preview.status === 'error') {
    text = state.preview.errorText || strings.preview.error;
  } else {
    text = strings.preview.empty;
  }

  els.previewPlaceholder.hidden = false;
  els.previewPlaceholder.textContent = text;
}

function renderSlides() {
  const slides = state.preview.slides;
  const canNavigate = !navigationLocked();

  els.slideSelect.replaceChildren();

  if (slides.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = strings.preview.noPages;
    els.slideSelect.append(option);
    els.slideSelect.value = '';
    els.slideSelect.disabled = true;
    els.previousSlide.disabled = true;
    els.nextSlide.disabled = true;
    els.pageIndicator.textContent = strings.preview.noPages;
    return;
  }

  let position = slides.findIndex(
    (slide) => slide.index === state.preview.index
  );
  if (position < 0) {
    position = 0;
    state.preview.index = slides[0].index;
  }

  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index];
    const option = document.createElement('option');
    option.value = String(slide.index);
    option.textContent = format(strings.preview.slideOption, {
      number: index + 1,
      title: slide.title || strings.preview.untitledSlide
    });
    els.slideSelect.append(option);
  }

  els.slideSelect.value = String(slides[position].index);
  els.slideSelect.disabled = !canNavigate;
  els.previousSlide.disabled = !canNavigate || position <= 0;
  els.nextSlide.disabled = !canNavigate || position >= slides.length - 1;
  els.pageIndicator.textContent = format(strings.preview.pageOf, {
    current: position + 1,
    total: slides.length
  });
}

function renderDiagnostics() {
  const warnings = combinedDiagnostics();
  els.diagnosticsList.replaceChildren();
  els.diagnostics.hidden = warnings.length === 0;

  if (warnings.length === 0) {
    els.diagnosticsCount.textContent = '';
    return;
  }

  els.diagnosticsCount.textContent = format(
    strings.preview.diagnosticsCount,
    { count: warnings.length }
  );

  for (const warning of warnings) {
    const item = document.createElement('li');
    const severity =
      warning.severity === 'error'
        ? strings.preview.errorSeverity
        : strings.preview.warning;
    const hasLine =
      warning.line !== undefined &&
      warning.line !== null &&
      Number.isFinite(Number(warning.line));
    let text = hasLine
      ? format(strings.preview.warningItemLine, {
          severity,
          line: warning.line,
          message: warning.message
        })
      : format(strings.preview.warningItem, {
          severity,
          message: warning.message
        });
    if (warning.code) text += ` [${warning.code}]`;

    item.className = 'diagnostic';
    item.dataset.severity = warning.severity;
    item.textContent = text;
    els.diagnosticsList.append(item);
  }
}

function showAppError(text, retry) {
  state.errorRetry = typeof retry === 'function' ? retry : null;
  els.appErrorText.textContent = text;
  els.appErrorRetry.hidden = !state.errorRetry;
  els.appError.hidden = false;
}

function hideAppError() {
  state.errorRetry = null;
  els.appErrorText.textContent = '';
  els.appErrorRetry.hidden = true;
  els.appError.hidden = true;
}

function showNewDeckError(text) {
  els.newDeckError.textContent = text;
  els.newDeckError.hidden = false;
  els.newTitle.setAttribute('aria-invalid', 'true');
}

function hideNewDeckError() {
  els.newDeckError.textContent = '';
  els.newDeckError.hidden = true;
  els.newTitle.removeAttribute('aria-invalid');
}

function normalizeDeckSummary(deck) {
  return {
    id: String(deck.id),
    title: typeof deck.title === 'string' ? deck.title : '',
    updatedAt: typeof deck.updatedAt === 'string' ? deck.updatedAt : ''
  };
}

function isDeckSummary(deck) {
  return Boolean(
    deck &&
      typeof deck === 'object' &&
      (typeof deck.id === 'string' || typeof deck.id === 'number')
  );
}

function normalizeDeckDocument(document, source) {
  const value = document && typeof document === 'object' ? document : {};
  return {
    id: value.id === undefined || value.id === null ? '' : String(value.id),
    title: typeof value.title === 'string' ? value.title : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    source,
    version: typeof value.version === 'string' ? value.version : '',
    eol:
      value.eol === 'crlf' || value.eol === 'mixed' || value.eol === 'lf'
        ? value.eol
        : 'lf',
    bom: Boolean(value.bom),
    readOnly: Boolean(value.readOnly),
    diagnostics: normalizeWarnings(value.diagnostics)
  };
}

function upsertDeckSummary(summary, options = {}) {
  const normalized = normalizeDeckSummary(summary);
  const index = state.decks.findIndex((deck) => deck.id === normalized.id);

  if (index >= 0) {
    state.decks[index] = {
      ...state.decks[index],
      title: normalized.title,
      updatedAt: normalized.updatedAt || state.decks[index].updatedAt
    };
  } else if (options.prepend) {
    state.decks.unshift(normalized);
  } else {
    state.decks.push(normalized);
  }
}

function normalizeSlides(rawSlides) {
  if (!Array.isArray(rawSlides)) return [];
  const slides = [];

  rawSlides.forEach((raw, position) => {
    if (!raw || typeof raw !== 'object') return;
    slides.push({
      index:
        Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : position,
      id: typeof raw.id === 'string' ? raw.id : '',
      title: typeof raw.title === 'string' ? raw.title : '',
      level: Number.isFinite(Number(raw.level)) ? Number(raw.level) : 1
    });
  });

  return slides;
}

function normalizeWarnings(rawWarnings) {
  if (!Array.isArray(rawWarnings)) return [];
  const warnings = [];

  for (const raw of rawWarnings) {
    if (!raw || typeof raw !== 'object') continue;
    const line = Number(raw.line);
    warnings.push({
      code: typeof raw.code === 'string' ? raw.code : '',
      severity: raw.severity === 'error' ? 'error' : 'warning',
      message: typeof raw.message === 'string' ? raw.message : '',
      line:
        raw.line !== undefined &&
        raw.line !== null &&
        Number.isFinite(line)
          ? line
          : undefined
    });
  }

  return warnings;
}

boot();
