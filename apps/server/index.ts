/**
 * Local HTTP/SSE server for Slide Studio.
 *
 * Separates a privileged admin origin (UI + authenticated JSON API) from an
 * isolated content origin (authored slide HTML and static workspace assets).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile, realpath, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  LegacyFeatureRequest,
  LegacyFeatureResponse,
  LegacyRendered,
} from "../../packages/contracts/src/server.js";
import { atomicWriteFile } from "../../packages/core/src/atomic.js";
import {
  cell_markdown,
  chunk_info,
  prepared_html,
  to_markdown,
  type ChunkEditMap,
} from "../../packages/core/src/edit.js";
import { merge3 } from "../../packages/core/src/edit-scope.js";
import { warning_issues } from "../../packages/core/src/render.js";
import {
  image_options,
  locate,
  move_chunk,
  parse,
  rewrite,
  set_cell,
  ValueError,
} from "../../packages/core/src/source.js";
import type { Doc } from "../../packages/core/src/source.js";
import { isInsideRoot } from "../../packages/core/src/paths.js";
import {
  decodeDeckBytes,
  encodeSourceForDeck,
  sha256,
} from "../../packages/core/src/encoding.js";
import {
  TEMPLATES,
  THEME_VARIABLES,
  theme_variables,
  check_name,
  set_front,
  type Workspace,
} from "../../packages/core/src/workspace.js";
import * as aiRoles from "../../packages/core/src/ai-roles.js";
import * as homeTrash from "../../packages/core/src/trash.js";
import * as deckManage from "../../packages/core/src/deck-manage.js";
import { MAX_BYTES as MATERIALS_MAX_BYTES } from "../../packages/core/src/materials.js";
import { RequestBridge } from "../../packages/ai/src/bridge.js";
import { LegacyOutput } from "./output.js";
import { LegacyChat } from "./chat.js";
import * as audit from "./audit.js";
import { LegacyInsertion } from "./insertion.js";
import { handleAssets } from "./assets.js";
import { handleMaterials } from "./materials.js";
import { LegacyThemes } from "./themes.js";
import * as memo from "./memo.js";
import * as history from "./history.js";
import { readRehearsal, saveRehearsal, validRehearsal } from "./rehearsal-store.js";
import { UiSettingsStore, validateSettings } from "./ui-settings.js";
import { cpSlice, migrateBlockDesign } from "./block-migrate.js";
import { createContentHandler } from "./content.js";
import {
  baseState,
  type ChunkEntry,
  type DeckState,
  type LegacyDiagnosticItem,
  type LegacyDiagnostics,
  type LegacyExportDocument,
  type LegacyExportDocumentInput,
  type LegacyHost,
  type LegacyHostHandoff,
  type LegacyHostOptions,
  type LegacyOpenExternal,
  type LegacySelectWorkspace,
  type LegacyWorkspace,
  type LegacyWorkspaceChanged,
  type PreviewCapability,
  type SourceSnapshot,
  type SseClient,
} from "./host-types.js";
import {
  absolutizeContentUrls,
  adminCsp,
  beginClose,
  BoundedQueue,
  BoundedQueueEvents,
  cloneHeaders,
  contentTypeFor,
  decodeName,
  decodeSegment,
  errorCode,
  headerValue,
  integerField,
  isDeckName,
  isMutation,
  isRecord,
  LegacyHttpError,
  listen,
  LOOPBACK,
  mediaTypeOf,
  parseJson,
  readBody,
  recordBody,
  safeName,
  sendApiError,
  sendBytes,
  sendEmpty,
  sendFailure,
  sendJson,
  tokenMatches,
} from "./http.js";
import {
  DEFAULT_MAX_UPLOAD_BODY_BYTES,
  FEATURE_ROUTES,
  type FeatureRoute,
  IMPLEMENTED_FEATURES,
  isShellPath,
  LEGACY_WEB_FILES,
  matchesFeature,
  PREVIEW_FILE,
} from "./web-files.js";

export { LEGACY_WEB_FILES };
export type {
  LegacyDiagnosticItem,
  LegacyDiagnostics,
  LegacyExportDocument,
  LegacyExportDocumentInput,
  LegacyHost,
  LegacyHostHandoff,
  LegacyHostOptions,
  LegacyOpenExternal,
  LegacySelectWorkspace,
  LegacyWorkspace,
  LegacyWorkspaceChanged,
};

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_MAX_PREVIEW_CAPABILITIES = 8;
const DEFAULT_MAX_SSE_CONNECTIONS = 32;
const DEFAULT_SSE_QUEUE = 256;
const DEFAULT_KEEP_ALIVE_MS = 15_000;
const DEFAULT_RENDER_CONCURRENCY = 2;
const DEFAULT_RENDER_PENDING = 64;
const CHUNK_VERSIONS = 4;

/**
 * Start the admin and content HTTP hosts. The caller owns the workspace lock
 * and remains responsible for closing the workspace after this host is closed.
 */
export async function startLegacyHost(options: LegacyHostOptions): Promise<LegacyHost> {
  if (typeof options.renderText !== "function") {
    throw new TypeError("renderText is required");
  }
  if (!isAbsolute(options.uiDirectory) || !isAbsolute(options.pandocPath)) {
    throw new TypeError("uiDirectory and pandocPath must be absolute paths");
  }

  const uiSettings = new UiSettingsStore(options.settingsPath ?? join(options.workspace.root, '.slide-studio-ui.json'));
  await uiSettings.load();
  const token = randomBytes(32).toString("base64url");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxSourceBodyBytes = options.maxSourceBodyBytes ?? DEFAULT_MAX_SOURCE_BODY_BYTES;
  const maxUploadBodyBytes = options.maxUploadBodyBytes ?? DEFAULT_MAX_UPLOAD_BODY_BYTES;
  const shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
  const maxPreviews = options.maxPreviewCapabilities ?? DEFAULT_MAX_PREVIEW_CAPABILITIES;
  const maxSseConnections = options.maxSseConnections ?? DEFAULT_MAX_SSE_CONNECTIONS;
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const renderQueue = new BoundedQueue<LegacyRendered>(
    options.renderConcurrency ?? DEFAULT_RENDER_CONCURRENCY,
    options.renderPending ?? DEFAULT_RENDER_PENDING,
  );

  let workspace = options.workspace;
  let adminOrigin = "";
  let contentOrigin = "";
  const capabilities = new Map<string, PreviewCapability>();
  const states = new Map<string, DeckState>();
  const sseClients = new Set<SseClient>();
  const inflight = new Set<Promise<void>>();
  const requestTasks = new Map<IncomingMessage, Promise<void>>();
  const mutations = new Set<IncomingMessage>();
  const pendingRenders = new Set<Promise<unknown>>();
  const deckLocks = new Map<string, Promise<unknown>>();
  let envCache: LegacyDiagnosticItem[] | null = null;
  let watcher: FSWatcher | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  const watchPaths = new Set<string>();
  let closed = false;
  let draining = false;
  let switching = false;
  let managing = false;
  let latestManage: {root:string;token:string;record:deckManage.ManageRecord}|null = null;
  let epoch = 0;
  let shutdownPromise: Promise<void> | undefined;
  let cliBridge: RequestBridge | undefined;

  const output = new LegacyOutput({ pandocPath: options.pandocPath, inspect: options.inspect, broadcast });
  const chat = new LegacyChat({
    storage: options.aiStorage ?? join(homedir(), ".slide-studio", "ai"), providers: options.aiProviders, runner: options.aiRunner, broadcast, openExternal: async url => await options.openExternal?.(url) ?? false,
    check: async (ws, deck, mode) => {
      if (mode !== "theme") return output.check(ws, deck);
      const name = ws.deck_theme(deck), css = await readFile(join(ws.themes, `${name}.css`), "utf8");
      const variables = theme_variables(css), missing = THEME_VARIABLES.filter(v => !variables.includes(v));
      return {kind: "theme", errors: missing.length ? [{kind: "theme", message: `テーマ themes/${name}.css に必須の変数がありません: ${missing.join(", ")}`}] : [], warnings: []};
    },
    reviewContext: async (ws, deck, mode) => mode === "memo" ? null : audit.run(ws, deck, output),
    changed: (ws, paths) => {
      if (ws !== workspace || closed) return;
      broadcast({type: "files", paths});
      for (const deck of affectedDecks(ws, paths)) scheduleRender(ws, deck, true, true);
    },
  });
  const insertion = new LegacyInsertion({ pandocPath: options.pandocPath, changed: path => broadcast({ type: "files", paths: [path] }) });
  const themes = new LegacyThemes({
    contentOrigin: () => contentOrigin,
    shots: options.inspect ? (ws,name) => output.scheduleTheme(ws,name) : undefined,
    locked: (ws, name) => chat.existing(ws)?.themeLocked(name) ?? false,
    changed: (ws, name) => {
      if (ws !== workspace) return;
      const paths = [`themes/${name}.css`];
      broadcast({ type: "files", paths });
      for (const deck of affectedDecks(ws, paths)) scheduleRender(ws, deck, true, true);
    },
  });
  const pending = options.inspect ? [] : ["theme-shots", "checks", "shots", "export", "download", "home-shots-running"];
  async function startCliBridge(ws: LegacyWorkspace) {
    cliBridge = await new RequestBridge(ws.root, async (body, signal) => {
      if (body.operation === "audit_tools") return {result: audit.TOOLS};
      if (body.operation === "consult") {
        if (typeof body.tab !== "string" || typeof body.question !== "string") throw Error("相談の形式が正しくありません");
        const workflow = chat.existing(ws as Workspace);
        if (!workflow) throw Error("相談できるのは AI が作業している間だけです");
        return {answer: await workflow.consult(body.tab, body.question, signal)};
      }
      if (body.operation === "audit_run" || body.operation === "audit_review" || body.operation === "audit_status") {
        if (typeof body.deck !== "string" || !ws.has_deck(body.deck)) throw Error("発表がありません");
        if (body.operation === "audit_run") return {result: await audit.run(ws as Workspace, body.deck, output)};
        if (typeof body.audit_id !== "string") throw Error("監査 ID がありません");
        return {result: body.operation === "audit_review" ? await audit.review(ws as Workspace, body.deck, body.audit_id, body.review) : audit.status(ws as Workspace, body.deck, body.audit_id)};
      }
      if (body.operation !== undefined && body.operation !== "check") throw Error("検査の操作が正しくありません");
      if (body.figure === undefined && (typeof body.deck !== "string" || !ws.has_deck(body.deck))) throw Error("発表がありません");
      if (body.figure !== undefined && typeof body.figure !== "string") throw Error("図の指定が正しくありません");
      const result = typeof body.figure === "string" ? await output.checkFigure(ws as Workspace, body.figure) : await output.check(ws as Workspace, body.deck as string);
      const errors = body.page ? result.errors.filter(i => !i.page_id || i.page_id === body.page) : result.errors;
      const warnings = body.page ? result.warnings.filter(i => !i.page_id || i.page_id === body.page) : result.warnings;
      return {result: {...result, errors, warnings}, errors: errors.length, summary: `検査：エラー ${errors.length}・警告 ${warnings.length}\n` + [...errors, ...warnings].map(i => i.message).join("\n")};
    }).start();
  }
  const handoff: LegacyHostHandoff = {
    status: "in_progress",
    pending: [...pending],
    implemented: [...IMPLEMENTED_FEATURES, ...(options.inspect ? ["theme-shots", "checks", "shots", "export", "download", "home-shots-running"] : [])],
    notes: [
      "Feature routes are explicit dispatches; unregistered groups return 501 instead of empty success.",
      "Authored HTML is served only from the content origin; the admin origin never serves /files.",
      "The caller owns the workspace lock; close() drains accepted writes and listeners but not the workspace.",
      "Chunk GET/POST includes markdown/cell/html/delete/move/image conversion with a four-version render cache keyed by raw source bytes.",
      "Deck reads migrate legacy block styles under the per-deck lock and preserve BOM/CRLF bytes; raw byte hashes remain the source revision.",
      "Original UI handlers are connected; output routes require the caller's Electron inspection service. Full legacy test parity and live provider verification remain separate validation gates.",
      "Content origin authentication (Electron secret header) and non-loopback frame navigation blocking belong to desktop integration and are not enabled here.",
      "Content CSP is stricter than the legacy service: remote images/fonts/frames are blocked pending a parity decision.",
      "Desktop download handling and the full output/export bridge remain pending.",
    ],
  };

  function expectedHost(origin: string): string {
    return origin.replace(/^http:\/\//u, "");
  }

  function hostMatches(request: IncomingMessage, origin: string): boolean {
    return headerValue(request.headers.host) === expectedHost(origin);
  }

  function stateFor(deck: string): DeckState {
    const found = states.get(deck);
    if (found) return found;
    const created = baseState(deck);
    states.set(deck, created);
    return created;
  }

  function rememberCapability(
    kind: PreviewCapability["kind"],
    html: string,
    deck: string,
    version: string,
    generation: string,
    mode: PreviewCapability["mode"],
  ): string {
    const capability = randomBytes(32).toString("base64url");
    capabilities.set(capability, { kind, html, deck, version, generation, mode });
    while (capabilities.size > Math.max(1, maxPreviews)) {
      const oldest = capabilities.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      capabilities.delete(oldest);
    }
    return capability;
  }

  function touchCapability(capability: string): PreviewCapability | undefined {
    const found = capabilities.get(capability);
    if (found === undefined) return undefined;
    capabilities.delete(capability);
    capabilities.set(capability, found);
    return found;
  }

  function viewUrl(capability: string): string {
    const found = capabilities.get(capability);
    if (found?.kind === "theme") {
      return `${contentOrigin}/files/themes/${PREVIEW_FILE}?c=${encodeURIComponent(capability)}`;
    }
    const deck = encodeURIComponent(found?.deck ?? "");
    return `${contentOrigin}/files/decks/${deck}/${PREVIEW_FILE}?c=${encodeURIComponent(capability)}`;
  }

  function generationFor(value: unknown): string {
    if (value === undefined) return randomBytes(8).toString("hex");
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
      throw new LegacyHttpError(400, "generationが正しくありません");
    }
    return value;
  }

  function withDeckLock<T>(
    ws: LegacyWorkspace,
    deck: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${ws.root}\0${deck}`;
    const previous = deckLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    deckLocks.set(key, run);
    void run.finally(() => {
      if (deckLocks.get(key) === run) deckLocks.delete(key);
    }).catch(() => undefined);
    return run;
  }

  async function readSource(ws: LegacyWorkspace, deck: string): Promise<SourceSnapshot> {
    if (!ws.has_deck(deck)) {
      throw new LegacyHttpError(404, `発表がありません: ${deck}`);
    }
    const file = ws.qmd(deck);
    const bytes = await readFile(file);
    const encoding = decodeDeckBytes(bytes);
    if (!encoding.validUtf8) {
      throw new LegacyHttpError(
        422,
        "原稿が UTF-8 ではないため読み書きできません",
        { code: "INVALID_UTF8" },
      );
    }
    return {
      text: encoding.source,
      version: sha256(bytes),
      bytes,
      eol: encoding.eol,
      bom: encoding.bom,
    };
  }

  function broadcast(event: Record<string, unknown>): void {
    if (sseClients.size === 0) return;
    for (const client of [...sseClients]) {
      if (!client.queue.push(absolutizeContentUrls(event, contentOrigin) as Record<string, unknown>)) {
        // Losing events can leave the UI stuck (especially a render event).
        // End the stream so the client reconnects and refetches state.
        cleanupSse(client);
        if (!client.response.destroyed && !client.response.writableEnded) {
          try {
            client.response.end();
          } catch {
            client.response.destroy();
          }
        }
        continue;
      }
      flushSse(client);
    }
  }

  function flushSse(client: SseClient): void {
    if (client.closed || client.paused || client.response.destroyed) return;
    while (client.queue.length > 0) {
      const event = client.queue.shift();
      if (event === undefined) break;
      const line = `data: ${JSON.stringify(event)}\n\n`;
      try {
        if (!client.response.write(line)) {
          client.paused = true;
          break;
        }
      } catch {
        cleanupSse(client);
        break;
      }
    }
  }

  function cleanupSse(client: SseClient): void {
    if (client.closed) return;
    client.closed = true;
    clearInterval(client.timer);
    client.queue.clear();
    sseClients.delete(client);
  }

  function endSse(): void {
    for (const client of [...sseClients]) {
      cleanupSse(client);
      if (!client.response.destroyed && !client.response.writableEnded) {
        try {
          client.response.end();
        } catch {
          client.response.destroy();
        }
      }
    }
    sseClients.clear();
  }

  function themeOnlyRender(
    previous: LegacyRendered | null,
    text: string,
    requested: boolean,
  ): boolean {
    try {
      const previousText = (previous as { doc?: { text?: unknown } } | null)?.doc?.text;
      if (typeof previousText !== "string") return false;
      if (!(requested || previousText !== text)) return false;
      return set_front(previousText, { theme: "default" }) === set_front(text, { theme: "default" });
    } catch {
      return false;
    }
  }

  function warnIssues(rendered: LegacyRendered | null): unknown[] {
    if (rendered === null) return [];
    try {
      return options.warningIssues === undefined
        ? warning_issues(rendered)
        : options.warningIssues(rendered);
    } catch (error) {
      console.error("[legacy] warning provider failed", error);
      return [];
    }
  }

  function chunkInfoFor(
    ws: LegacyWorkspace,
    deck: string,
    state: DeckState,
    rendered: LegacyRendered,
    version: string,
  ): Promise<ChunkEditMap> {
    const found = state.chunks.get(version);
    if (found !== undefined && found.rendered === rendered) return found.info;
    const entry: ChunkEntry = {
      rendered,
      info: Promise.resolve().then(() => chunk_info(
        { html: rendered.html, doc: rendered.doc },
        { pandocPath: options.pandocPath, cwd: ws.deck_dir(deck) },
      )),
    };
    state.chunks.set(version, entry);
    while (state.chunks.size > CHUNK_VERSIONS) {
      const oldest = state.chunks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      state.chunks.delete(oldest);
    }
    void entry.info.catch(() => {
      if (state.chunks.get(version) === entry) state.chunks.delete(version);
    });
    return entry.info;
  }

  async function renderDeck(
    ws: LegacyWorkspace,
    deck: string,
    optionsForRender: { force?: boolean; themeOnly?: boolean; source?: SourceSnapshot } = {},
  ): Promise<DeckState> {
    if (draining) {
      throw new LegacyHttpError(503, "サーバーを終了しています");
    }
    const state = stateFor(deck);
    const renderEpoch = epoch;
    state.force ||= optionsForRender.force === true;
    state.themeOnly ||= optionsForRender.themeOnly === true;
    if (state.rendering && state.promise !== null) {
      state.dirty = true;
      return state.promise;
    }

    let provided = optionsForRender.source;
    const promise = (async (): Promise<DeckState> => {
      state.rendering = true;
      try {
        while (true) {
          state.dirty = false;
          const source = provided ?? await readSource(ws, deck);
          provided = undefined;
          if (renderEpoch !== epoch) break;
          const forceRender = state.force;
          const themeOnly = state.themeOnly;
          state.force = false;
          state.themeOnly = false;

          if (
            !forceRender
            && state.html !== null
            && state.version === source.version
            && state.error === null
          ) {
            break;
          }

          const previous = state.rendered;
          broadcast({ type: "render-start", deck, version: source.version });
          const started = Date.now();
          try {
            const rendered = await renderQueue.run(() =>
              options.renderText(ws as Workspace, deck, source.text, {
                pandocPath: options.pandocPath,
                wrap: true,
              }));
            if (renderEpoch !== epoch) break;
            const renderedDoc = rendered as unknown as {
              doc?: { meta?: Record<string, unknown> };
            };
            state.html = rendered.html;
            state.version = source.version;
            state.error = null;
            state.rendered = rendered;
            if (options.inspect) output.schedule(ws as Workspace, deck);
            broadcast({
              type: "render",
              deck,
              ok: true,
              version: source.version,
              theme_only: themeOnlyRender(previous, source.text, themeOnly),
              theme: String(renderedDoc.doc?.meta?.theme ?? "default"),
              ms: Date.now() - started,
              timing: rendered.timing ?? {},
              slides: rendered.slides ?? [],
              warnings: rendered.warnings ?? [],
              warning_issues: warnIssues(rendered),
              unsupported: rendered.unsupported ?? [],
              missing_cites: rendered.missing_cites ?? [],
            });
          } catch (error) {
            if (renderEpoch !== epoch) break;
            state.error = error instanceof Error ? error.message : String(error);
            broadcast({
              type: "render",
              deck,
              ok: false,
              version: source.version,
              error: state.error,
            });
          }
          if (!state.dirty) break;
        }
      } finally {
        state.rendering = false;
        state.promise = null;
      }
      return state;
    })();

    state.promise = promise;
    pendingRenders.add(promise);
    void promise.finally(() => {
      pendingRenders.delete(promise);
    }).catch(() => undefined);
    return promise;
  }

  async function ensureRendered(ws: LegacyWorkspace, deck: string): Promise<DeckState> {
    const source = await readSource(ws, deck);
    const state = stateFor(deck);
    if (state.html === null || state.version !== source.version) {
      return renderDeck(ws, deck, { source });
    }
    return state;
  }

  function scheduleRender(
    ws: LegacyWorkspace,
    deck: string,
    force: boolean,
    themeOnly: boolean,
  ): void {
    if (draining) return;
    void renderDeck(ws, deck, { force, themeOnly }).catch((error: unknown) => {
      if (error instanceof LegacyHttpError && error.status === 503) return;
      console.error(`[legacy] cannot render ${deck}`, error);
    });
  }

  function affectedDecks(ws: LegacyWorkspace, paths: string[]): Set<string> {
    const affected = new Set<string>();
    for (const path of paths) {
      const parts = path.split("/");
      if (parts[0] === ".slide-studio" || !parts[0]) continue;
      if (parts[0] === "decks" && parts[1]) {
        const deck = parts[1] as string;
        const rest = parts.slice(2);
        if (rest[0] === "materials" || (rest.length === 1 && ["memo.md", "rehearsals.json"].includes(rest[0]!))) continue;
        if (states.has(deck) && ws.has_deck(deck)) affected.add(deck);
      } else if (parts[0] === "topics" || parts[0] === "themes") {
        for (const deck of states.keys()) {
          if (ws.has_deck(deck)) affected.add(deck);
        }
      }
    }
    return affected;
  }

  function flushWatch(ws: LegacyWorkspace): void {
    watchTimer = undefined;
    if (closed) return;
    const paths = [...watchPaths];
    watchPaths.clear();
    if (paths.length === 0) return;
    const rels = [...new Set(paths.map((path) =>
      relative(resolve(ws.root), path).replaceAll("\\", "/")))].sort();
    if (rels.length === 0) return;
    broadcast({ type: "files", paths: rels });
    for (const deck of affectedDecks(ws, rels)) {
      const force = rels.some((rel) => rel !== `decks/${deck}/slides.qmd`);
      const themeOnly = rels.length > 0 && rels.every((rel) => rel.startsWith("themes/"));
      scheduleRender(ws, deck, force, themeOnly);
    }
  }

  function startWatch(ws: LegacyWorkspace): void {
    if (options.watch === false) return;
    try {
      watcher = watch(ws.root, { recursive: true }, (_event, filename) => {
        if (closed || filename === null) return;
        const name = String(filename);
        if (name.includes(`.slide-studio${process.platform === "win32" ? "\\" : "/"}`)) return;
        const base = name.split(/[\\/]/u).at(-1) ?? "";
        if (base.startsWith(".") || base.endsWith(".tmp") || base === PREVIEW_FILE) return;
        watchPaths.add(resolve(ws.root, name));
        if (watchTimer === undefined) watchTimer = setTimeout(() => flushWatch(ws), 50);
      });
      watcher.on("error", (error) => {
        console.error("[legacy] workspace watcher failed", error);
      });
    } catch (error) {
      console.error("[legacy] cannot watch workspace", error);
    }
  }

  function stopWatch(): void {
    if (watchTimer !== undefined) {
      clearTimeout(watchTimer);
      watchTimer = undefined;
    }
    watchPaths.clear();
    watcher?.close();
    watcher = undefined;
  }

  async function dispatchFeature(
    feature: FeatureRoute | { name: string },
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    bytes: Buffer,
    body: unknown,
    extras: { deck?: string; op?: string } = {},
  ): Promise<void> {
    const featureRequest = {
      method: request.method ?? "",
      pathname: url.pathname,
      query: url.searchParams,
      body,
      bytes,
      headers: cloneHeaders(request),
      route: feature.name,
      ...extras,
    } as LegacyFeatureRequest & { route: string; deck?: string; op?: string };
    for (const handler of options.featureHandlers ?? []) {
      const result = await handler(featureRequest);
      if (result !== null) {
        sendFeatureResponse(response, result, contentOrigin);
        return;
      }
    }
    const chatResult = await chat.handle(workspace as Workspace, featureRequest);
    if (chatResult !== null) { sendFeatureResponse(response, chatResult, contentOrigin); return; }
    const outputResult = options.inspect ? await output.handle(workspace as Workspace, featureRequest) : null;
    if (outputResult !== null) { sendFeatureResponse(response, outputResult, contentOrigin); return; }
    const insertionResult = await insertion.handle(workspace as Workspace, featureRequest);
    if (insertionResult !== null) { sendFeatureResponse(response, insertionResult, contentOrigin); return; }
    const assetResult = await handleAssets(workspace as Workspace, featureRequest, path => broadcast({ type: "files", paths: [path] }));
    if (assetResult !== null) { sendFeatureResponse(response, assetResult, contentOrigin); return; }
    const materialResult = await handleMaterials(workspace as Workspace, featureRequest, {
      openPath: options.openPath,
      changed: path => broadcast({ type: "files", paths: [path] }),
    });
    if (materialResult !== null) {
      sendFeatureResponse(response, materialResult, contentOrigin);
      return;
    }
    const themeResult = await themes.handle(workspace as Workspace, featureRequest);
    if (themeResult !== null) {
      sendFeatureResponse(response, themeResult, contentOrigin);
      return;
    }
    sendApiError(
      response,
      501,
      `この機能はまだ移植されていません: ${feature.name}`,
      { code: "NOT_IMPLEMENTED", feature: feature.name, pending: true },
    );
  }

  function sendFeatureResponse(
    response: ServerResponse,
    result: LegacyFeatureResponse,
    contentOriginValue: string,
  ): void {
    const requestedStatus = result.status ?? 200;
    const status = Number.isInteger(requestedStatus) && requestedStatus >= 100 && requestedStatus <= 599
      ? requestedStatus
      : 500;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      const lower = key.toLowerCase();
      if (lower.startsWith("access-control-")) continue;
      if (lower === "content-length") continue;
      headers[lower] = value;
    }
    if (headers["cache-control"] === undefined) headers["cache-control"] = "no-store";
    if (result.bytes !== undefined) {
      delete headers["set-cookie"];
      const contentType = (headers["content-type"] ?? "").toLowerCase();
      const active = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|(?:application|text)\/xml|text\/javascript|application\/javascript)/u
        .test(contentType);
      if (active && headers["content-disposition"] === undefined) {
        headers["content-disposition"] = "attachment";
      }
      headers["content-security-policy"] = "sandbox; default-src 'none'";
      sendBytes(response, status, result.bytes, headers);
      return;
    }
    if (result.body !== undefined) {
      sendJson(
        response,
        status,
        absolutizeContentUrls(result.body, contentOriginValue),
        headers,
      );
      return;
    }
    sendEmpty(response, status, headers);
  }

  async function readThemeCss(ws: LegacyWorkspace, name: string): Promise<Buffer | null> {
    if (!safeName(name)) return null;
    const path = join(ws.themes, `${name}.css`);
    const link = await lstat(path, { throwIfNoEntry: false }).catch(() => undefined);
    if (!link || !link.isFile() || link.isSymbolicLink()) return null;
    let rootReal: string;
    let fileReal: string;
    try {
      rootReal = await realpath(ws.root);
      fileReal = await realpath(path);
    } catch {
      return null;
    }
    if (!isInsideRoot(rootReal, fileReal)) return null;
    return readFile(fileReal);
  }

  async function handleDeckPreview(
    request: IncomingMessage,
    response: ServerResponse,
    ws: LegacyWorkspace,
    deck: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const requestedMode = body.mode ?? "edit";
    if (requestedMode !== "edit" && requestedMode !== "present") {
      throw new LegacyHttpError(400, "表示モードが正しくありません");
    }
    const source = await readSource(ws, deck);
    let state = stateFor(deck);
    if (requestedMode === "present") {
      state = await renderDeck(ws, deck, { source });
      if (state.error !== null || state.html === null) {
        throw new LegacyHttpError(500, state.error ?? "変換できません");
      }
    } else if (state.html === null) {
      state = await renderDeck(ws, deck, { source });
    }
    // Edit mode serves the last good render, matching the legacy behaviour when
    // the current source cannot be converted.
    if (state.html === null) {
      throw new LegacyHttpError(500, state.error ?? "変換できません");
    }
    const version = state.version;
    const generation = generationFor(body.generation);
    const capability = rememberCapability(
      "deck",
      state.html,
      deck,
      version,
      generation,
      requestedMode,
    );
    sendJson(response, 200, {
      url: viewUrl(capability),
      origin: contentOrigin,
      version,
    });
  }

  async function handleThemePreview(
    request: IncomingMessage,
    response: ServerResponse,
    ws: LegacyWorkspace,
    name: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (!safeName(name) || !ws.themes_list().includes(name)) {
      throw new LegacyHttpError(400, `テーマがありません: themes/${name}.css`);
    }
    const css = await readThemeCss(ws, name);
    if (css === null) throw new LegacyHttpError(400, `テーマがありません: themes/${name}.css`);
    let sample: string;
    try {
      sample = await readFile(join(TEMPLATES, "theme-editor-sample.qmd"), "utf8");
    } catch {
      throw new LegacyHttpError(500, "テーマの見本を読み込めません");
    }
    const text = set_front(sample, { theme: name });
    let rendered: LegacyRendered;
    try {
      rendered = await renderQueue.run(() =>
        options.renderText(ws as Workspace, "__theme-sample__", text, {
          pandocPath: options.pandocPath,
          wrap: true,
        }));
    } catch (error) {
      throw new LegacyHttpError(
        500,
        `テーマの見本を表示できません: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const version = typeof body.version === "string" && body.version.length > 0
      ? body.version
      : sha256(css);
    const generation = generationFor(body.generation);
    const capability = rememberCapability(
      "theme",
      rendered.html,
      "__theme-sample__",
      version,
      generation,
      "edit",
    );
    sendJson(response, 200, {
      url: viewUrl(capability),
      origin: contentOrigin,
      version,
    });
  }

  async function handleDeckGet(
    response: ServerResponse,
    ws: LegacyWorkspace,
    deck: string,
  ): Promise<void> {
    await withDeckLock(ws, deck, async () => {
      if (!ws.has_deck(deck)) {
        sendApiError(response, 404, `発表がありません: ${deck}`);
        return;
      }
      let source = await readSource(ws, deck);
      // Older GUI versions wrote per-block colors into the source. Migrate
      // exactly like the reference on open, but keep the raw byte revision
      // canonical and preserve BOM/CRLF on disk.
      const migrated = migrateBlockDesign(source.text);
      if (migrated !== source.text) {
        const path = ws.qmd(deck);
        const info = await stat(path);
        const encoded = encodeSourceForDeck(migrated, {
          bom: source.bom,
          eol: source.eol,
        });
        if (encoded.byteLength > maxSourceBodyBytes) {
          throw new LegacyHttpError(413, "原稿が大きすぎます");
        }
        await atomicWriteFile(path, encoded, info.mode & 0o777);
        source = {
          text: migrated,
          version: sha256(encoded),
          bytes: encoded,
          eol: source.eol,
          bom: source.bom,
        };
      }
      const state = await renderDeck(ws, deck, { source });
      const structure = parse(source.text).to_json();
      ws.touch_recent(deck);
      sendJson(response, 200, {
        deck,
        text: source.text,
        version: source.version,
        structure,
        render: {
          ok: state.error === null,
          version: state.version,
          error: state.error,
          slides: state.rendered?.slides ?? [],
          warning_issues: warnIssues(state.rendered),
        },
        blank: ws.is_blank(deck),
        root: ws.root,
      });
    });
  }

  async function handleDeckSource(
    response: ServerResponse,
    ws: LegacyWorkspace,
    deck: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await withDeckLock(ws, deck, async () => {
      if (!ws.has_deck(deck)) {
        sendApiError(response, 404, `発表がありません: ${deck}`);
        return;
      }
      const text = body.text;
      if (typeof text !== "string") {
        sendApiError(response, 400, "原稿がありません");
        return;
      }
      const current = await readSource(ws, deck);
      const base = body.base;
      const rebased = base !== current.version;
      const baseText = rebased ? body.base_text : current.text;
      if (typeof baseText !== "string") {
        sendApiError(response, 409, "外で変更されました", {
          version: current.version,
          text: current.text,
        });
        return;
      }
      let merged: string | null;
      if (rebased) {
        merged = merge3(baseText, text, current.text);
        if (merged === null) {
          sendApiError(response, 409, "外で変更されました", {
            version: current.version,
            text: current.text,
          });
          return;
        }
      } else {
        merged = text;
      }
      let final: string;
      try {
        final = set_front(merged, {});
      } catch {
        final = merged;
      }

      let version = current.version;
      if (final !== current.text) {
        if (chat.existing(ws as Workspace)?.locked(deck, "slides", current.text, final)) {
          sendApiError(response, 409, "この対象は AI が作業中です"); return;
        }
        const path = ws.qmd(deck);
        const info = await stat(path);
        let encoded: Buffer;
        try {
          encoded = encodeSourceForDeck(final, { bom: current.bom, eol: current.eol });
        } catch (error) {
          throw new LegacyHttpError(
            400,
            error instanceof Error ? error.message : "原稿を保存できません",
          );
        }
        if (encoded.byteLength > maxSourceBodyBytes) {
          throw new LegacyHttpError(413, "原稿が大きすぎます");
        }
        await chat.existing(ws as Workspace)?.userSaved(deck, current.text, final);
        await atomicWriteFile(path, encoded, info.mode & 0o777);
        version = sha256(encoded);
      }
      // Legacy always scheduled a render after a save, even when the text was
      // unchanged; this matters after a failed render.
      scheduleRender(ws, deck, false, false);
      sendJson(response, 200, {
        version,
        ...(rebased ? { text: final } : {}),
      });
    });
  }

  async function handleChunks(
    request: IncomingMessage,
    response: ServerResponse,
    ws: LegacyWorkspace,
    deck: string,
    body: unknown,
  ): Promise<void> {
    if (!ws.has_deck(deck)) {
      sendApiError(response, 404, "発表がありません");
      return;
    }
    const state = stateFor(deck);
    if (state.rendered === null) {
      await renderDeck(ws, deck);
    }
    if (state.rendered === null) {
      sendApiError(response, 409, "表示が古い");
      return;
    }
    let rendered = state.rendered;
    const version = state.version;
    if (request.method === "GET" || request.method === "HEAD") {
      const info = await chunkInfoFor(ws, deck, state, rendered, version);
      sendJson(response, 200, {
        version,
        structure: rendered.doc.to_json(),
        chunks: info,
      });
      return;
    }

    const values = recordBody(body);
    const action = values.action;
    if (action === "markdown") {
      if (typeof values.html !== "string") {
        sendApiError(response, 400, "操作が正しくありません");
        return;
      }
      const original = values.original ?? "";
      if (typeof original !== "string") {
        sendApiError(response, 400, "操作が正しくありません");
        return;
      }
      let html = values.html;
      if (original) html = prepared_html(html, original);
      const markdown = await to_markdown(html, original, {
        pandocPath: options.pandocPath,
        cwd: ws.deck_dir(deck),
      });
      sendJson(response, 200, { markdown });
      return;
    }

    if (action === "cell") {
      try {
        if (typeof values.text !== "string" || typeof values.html !== "string") {
          throw new ValueError("操作が正しくありません");
        }
        const markdown = await cell_markdown(values.html, {
          pandocPath: options.pandocPath,
          cwd: ws.deck_dir(deck),
        });
        const result = set_cell(
          parse(values.text),
          String(values.key),
          integerField(values.row),
          integerField(values.col),
          markdown,
        );
        sendJson(response, 200, { text: result });
      } catch (error) {
        if (
          error instanceof ValueError
          || error instanceof TypeError
        ) {
          sendApiError(response, 400, error.message);
          return;
        }
        throw error;
      }
      return;
    }

    let renderedVersion = version;
    if (values.base !== version) {
      const cached = typeof values.base === "string"
        ? state.chunks.get(values.base)?.rendered
        : undefined;
      if (cached === undefined) {
        sendApiError(response, 409, "表示が古いので、更新を待ってください");
        return;
      }
      rendered = cached;
      renderedVersion = values.base as string;
    }
    if (typeof values.text !== "string" || values.text !== rendered.doc.text) {
      sendApiError(response, 409, "表示が古いので、更新を待ってください");
      return;
    }

    try {
      const doc: Doc = rendered.doc;
      const key = String(values.key);
      let result: string;
      if (action === "html") {
        const info = await chunkInfoFor(ws, deck, state, rendered, renderedVersion);
        if (!info[key]?.direct) {
          throw new ValueError("文字の編集対象が見つかりません");
        }
        const chunk = locate(doc, key)[1];
        const original = cpSlice(doc.text, chunk.start, chunk.end);
        if (typeof values.html !== "string") {
          throw new TypeError("操作が正しくありません");
        }
        const markdown = await to_markdown(values.html, original, {
          pandocPath: options.pandocPath,
          cwd: ws.deck_dir(deck),
        });
        result = rewrite(doc, { [key]: markdown });
      } else if (action === "delete") {
        result = rewrite(doc, { [key]: "" });
      } else if (action === "move") {
        result = move_chunk(
          doc,
          key,
          integerField(values.page),
          typeof values.before === "string" ? values.before : null,
        );
      } else if (action === "image") {
        const width = values.width === null || values.width === undefined
          ? null
          : integerField(values.width);
        result = image_options(doc, key, width, String(values.align));
      } else {
        throw new ValueError("操作が正しくありません");
      }
      sendJson(response, 200, { text: result });
    } catch (error) {
      if (
        error instanceof ValueError
        || error instanceof TypeError
      ) {
        sendApiError(response, 400, error.message);
        return;
      }
      throw error;
    }
  }

  async function handleMemo(
    request: IncomingMessage,
    response: ServerResponse,
    ws: LegacyWorkspace,
    deck: string,
    body: unknown,
  ): Promise<void> {
    await withDeckLock(ws, deck, async () => {
      try {
        if (!ws.has_deck(deck)) {
          sendApiError(response, 404, "発表がありません");
          return;
        }
        if (request.method === "GET" || request.method === "HEAD") {
          const current = memo.read(ws as Workspace, deck);
          sendJson(response, 200, {
            ...current,
            locked: chat.existing(ws as Workspace)?.locked(deck, "memo") ?? false,
            slides_body: memo.from_slides(ws as Workspace, deck),
          });
          return;
        }
        const values = recordBody(body);
        if (chat.existing(ws as Workspace)?.locked(deck, "memo")) {sendApiError(response, 409, "下書きは AI が作業中です"); return;}
        if (typeof values.text !== "string") {
          sendApiError(response, 400, "下書きがありません");
          return;
        }
        sendJson(
          response,
          200,
          memo.write(ws as Workspace, deck, values.text, values.base),
        );
        chat.existing(ws as Workspace)?.userWrote(deck, `decks/${deck}/memo.md`);
      } catch (error) {
        if (error instanceof memo.MemoConflict) {
          sendApiError(response, 409, error.message, { ...error.current });
          return;
        }
        if (error instanceof memo.EncodingError) {
          sendApiError(response, 422, error.message, { code: "INVALID_UTF8" });
          return;
        }
        if (error instanceof memo.MemoFileError) {
          sendApiError(response, 400, error.message);
          return;
        }
        throw error;
      }
    });
  }

  async function handleStyle(
    response: ServerResponse,
    ws: LegacyWorkspace,
    deck: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await withDeckLock(ws, deck, async () => {
      if (!ws.has_deck(deck)) {
        sendApiError(response, 404, "発表がありません");
        return;
      }
      try {
        const result = history.style(ws as Workspace, deck, body);
        scheduleRender(ws, deck, true, false);
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof history.Conflict) {
          sendApiError(response, 409, error.message);
          return;
        }
        if (error instanceof history.EncodingError) {
          sendApiError(response, 422, error.message, { code: "INVALID_UTF8" });
          return;
        }
        if (error instanceof Error) {
          sendApiError(response, 400, error.message);
          return;
        }
        throw error;
      }
    });
  }

  async function handleEvents(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendApiError(response, 405, "method not allowed");
      return;
    }
    if (sseClients.size >= maxSseConnections) {
      sendApiError(response, 503, "イベント接続が多すぎます");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.write("retry: 1000\n\n");
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const client: SseClient = {
      response,
      queue: new BoundedQueueEvents<Record<string, unknown>>(DEFAULT_SSE_QUEUE),
      timer: setInterval(() => {
        if (client.closed || client.paused || response.destroyed) return;
        if (!response.write(": ping\n\n")) client.paused = true;
      }, Math.max(1, keepAliveMs)),
      paused: false,
      closed: false,
    };
    sseClients.add(client);
    response.on("close", () => cleanupSse(client));
    response.on("error", () => cleanupSse(client));
    response.on("drain", () => {
      client.paused = false;
      flushSse(client);
    });
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = request.method ?? "";
    if (method === "OPTIONS") {
      sendEmpty(response, 405);
      return;
    }
    if (!tokenMatches(token, headerValue(request.headers["x-studio-token"]))) {
      sendApiError(response, 401, "a valid X-Studio-Token header is required", {
        code: "UNAUTHORIZED",
      });
      return;
    }

    const pathname = url.pathname;
    const ws = workspace;
    if (managing) { sendApiError(response, 409, "発表の整理中です"); return; }
    if (switching && !(pathname === "/api/workspace/select" && method === "POST")) {
      sendApiError(response, 409, "ワークスペースを切り替えています");
      return;
    }
    const mutation = isMutation(method);
    if (mutation && headerValue(request.headers.origin) !== adminOrigin) {
      sendApiError(response, 403, "同じ画面から接続してください");
      return;
    }

    const feature = matchesFeature(method, pathname);
    const mediaType = mediaTypeOf(request);
    if (mutation && feature === null && mediaType !== "application/json") {
      // The source route may exceed the JSON limit, but still speaks JSON.
      if (!(method === "PUT" && /^\/api\/deck\/[^/]+\/source$/u.test(pathname))) {
        sendApiError(response, 400, "content-type must be application/json");
        return;
      }
    }

    const limit = method === "PUT" && /^\/api\/deck\/[^/]+\/source$/u.test(pathname)
      ? maxSourceBodyBytes
      : /^\/api\/deck\/[^/]+\/materials$/u.test(pathname)
        ? (options.maxUploadBodyBytes ?? MATERIALS_MAX_BYTES)
        : feature?.bodyLimit !== undefined ? maxUploadBodyBytes : maxBodyBytes;
    const raw = mutation ? await readBody(request, limit) : Buffer.alloc(0);
    const body = raw.byteLength === 0
      ? (mediaType === "application/json" ? {} : undefined)
      : (mediaType === "application/json" ? parseJson(raw) : undefined);

    if (pathname === '/api/settings') {
      if (method !== 'GET' && method !== 'POST') { sendApiError(response, 405, 'method not allowed'); return; }
      if (method === 'POST') {
        let patch;
        try { patch = validateSettings(body); }
        catch { sendApiError(response, 400, 'invalid settings'); return; }
        await uiSettings.save(patch);
      }
      options.applyUiZoom?.(uiSettings.value.zoom);
      sendJson(response, 200, { settings: uiSettings.value, nativeZoom: Boolean(options.applyUiZoom) });
      return;
    }

    if (pathname === '/api/updates') {
      if (!options.updates) { sendJson(response, 200, { phase: 'disabled', automatic: false, version: '' }); return; }
      if (method === 'GET') { sendJson(response, 200, options.updates.state()); return; }
      if (method !== 'POST') { sendApiError(response, 405, 'method not allowed'); return; }
      const values = recordBody(body);
      if (values.action === 'automatic' && typeof values.value === 'boolean') {
        sendJson(response, 200, await options.updates.automatic(values.value));
      } else if (values.action === 'check') {
        void options.updates.check(); sendJson(response, 200, options.updates.state());
      } else if (values.action === 'download') {
        void options.updates.download(); sendJson(response, 200, options.updates.state());
      } else if (values.action === 'install') {
        options.updates.install(); sendJson(response, 200, options.updates.state());
      } else sendApiError(response, 400, 'invalid update action');
      return;
    }

    if (pathname === "/api/home/trash" && (method === "GET" || method === "HEAD")) {
      sendJson(response, 200, {items:homeTrash.listing(ws as Workspace)}); return;
    }
    if ((pathname === "/api/home/manage" || pathname === "/api/home/trash") && method === "POST") {
      if (chat.busy || cliBridge?.busy || managing || switching) {
        sendApiError(response, 409, "表示の更新が終わってから操作してください"); return;
      }
      managing = true;
      try {
        await Promise.allSettled([...requestTasks].filter(([other]) => other !== request && !((other.method === "GET" || other.method === "HEAD") && /^\/api\/ai\//u.test(other.url ?? ""))).map(([,task])=>task));
        await Promise.allSettled([...pendingRenders]);await output.settle();
        if(chat.busy||cliBridge?.busy)throw Error("AI の作業が終わってから操作してください");
        await chat.forget(ws as Workspace);
        const values = body as Record<string, unknown> | undefined;
        if (!values) throw new Error("操作が正しくありません");
        if (pathname === "/api/home/trash") {
          if (typeof values.id !== "string") throw Error("ごみ箱の項目が正しくありません");
          await homeTrash.restore(ws as Workspace, values.id);
          latestManage = null;
        } else if (values.action === "undo") {
          if (!latestManage || latestManage.root !== ws.root || values.token !== latestManage.token) throw new Error("元に戻せる操作がありません");
          await deckManage.undo(ws as Workspace, latestManage.record);
          latestManage = null;
        } else {
          if (typeof values.deck !== "string") throw new Error("発表名が正しくありません");
          let record: deckManage.ManageRecord;
          if (values.action === "rename") {
            if (typeof values.name !== "string" || (values.title != null && typeof values.title !== "string")) throw new Error("名前を入力してください");
            record = await deckManage.rename(ws as Workspace, values.deck, values.name, values.title == null ? undefined : values.title as string);
          } else if (values.action === "delete") record = await deckManage.remove(ws as Workspace, values.deck);
          else throw new Error("操作が正しくありません");
          latestManage = {root:ws.root, token:randomBytes(24).toString("hex"), record};
        }
        states.clear(); capabilities.clear(); epoch += 1;
        broadcast({type:"files",paths:[]});
        sendJson(response, 200, {token:latestManage?.token ?? null});
      } catch (error) { sendApiError(response, 400, error instanceof Error ? error.message : String(error)); }
      finally { managing = false; }
      return;
    }

    if (pathname === "/api/workspace") {
      if (method !== "GET" && method !== "HEAD") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      sendJson(response, 200, {
        root: ws.root,
        decks: ws.list_decks(),
      });
      return;
    }

    if (pathname === "/api/location" && (method === "GET" || method === "HEAD")) {
      sendJson(response, 200, {current:ws.root,recent:options.recentWorkspaces?.() ?? [ws.root]}); return;
    }
    if (pathname === "/api/location/folders" && (method === "GET" || method === "HEAD")) {
      try {
        const input=url.searchParams.get("path") || homedir();
        const path=await realpath(input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(),input.slice(2)) : input);
        const folders:string[]=[];
        for(const entry of await readdir(path,{withFileTypes:true})) if(!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink() && (await stat(join(path,entry.name)).catch(()=>null))?.isDirectory())) folders.push(entry.name);
        sendJson(response,200,{path,parent:dirname(path),folders:folders.sort(),suggested:join(homedir(),"Slides")});
      } catch(error) {sendApiError(response,400,error instanceof Error ? error.message : String(error));}
      return;
    }
    if (pathname === "/api/workspace/select" || pathname === "/api/location" && method === "POST") {
      if (method !== "POST") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      // Folder listing can still be in flight when the user submits. Drain
      // those reads after closing admission, rather than rejecting the click.
      if (mutations.size > 1 || chat.busy || cliBridge?.busy) {
        sendApiError(response, 409, "処理中のためワークスペースを切り替えできません", {
          code: "BUSY",
        });
        return;
      }
      switching = true;
      try {
        await Promise.allSettled([...requestTasks].filter(([other]) => other !== request && !((other.method === "GET" || other.method === "HEAD") && /^\/api\/ai\//u.test(other.url ?? ""))).map(([, task]) => task));
        await Promise.allSettled([...pendingRenders]);await output.settle();
        if (pendingRenders.size || output.busy || chat.busy || cliBridge?.busy) throw new LegacyHttpError(409, "処理中のためワークスペースを切り替えできません");
        const previous = workspace;
        const values=body as Record<string,unknown>|undefined;
        if(pathname === "/api/location" && (!values || typeof values.path !== "string" || !["new","existing"].includes(String(values.mode)))) throw new LegacyHttpError(400,"保管場所を指定してください");
        if(pathname === "/api/location" && !options.openWorkspace) throw new LegacyHttpError(503,"保管場所の切り替えが接続されていません");
        const next = pathname === "/api/location" ? await options.openWorkspace!(values!.path as string,values!.mode as "new"|"existing") : options.selectWorkspace === undefined
          ? null
          : await options.selectWorkspace();
        if (next === null) {
          sendJson(response, 200, { cancelled: true });
          return;
        }
        await chat.forget(previous as Workspace);
        await cliBridge?.close();
        workspace = next;
        await startCliBridge(next);
        latestManage = null;
        epoch += 1;
        capabilities.clear();
        states.clear();
        envCache = null;
        stopWatch();
        startWatch(next);
        if (next !== previous && options.onWorkspaceChanged !== undefined) {
          try {
            await options.onWorkspaceChanged(next, previous);
          } catch (error) {
            // The switch has already been committed. The previous workspace is
            // the caller's responsibility and the error must not redirect a
            // successfully selected new workspace.
            console.error("[legacy] workspace change callback failed", error);
          }
        }
        broadcast({ type: "workspace" });
        sendJson(response, 200, {
          root: next.root,
          decks: next.list_decks(),
          ok: true,
          url: "/",
        });
      } catch(error) {
        if(pathname !== "/api/location") throw error;
        sendApiError(response,400,error instanceof Error ? error.message : String(error));
      } finally {
        switching = false;
      }
      return;
    }

    if (pathname === "/api/open-external") {
      if (method !== "POST") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      if (headerValue(request.headers.origin) !== adminOrigin) {
        sendApiError(response, 403, "invalid origin");
        return;
      }
      const values = recordBody(body);
      const target = values.url;
      let parsed: URL | null = null;
      try {
        parsed = typeof target === "string" ? new URL(target) : null;
      } catch {
        parsed = null;
      }
      if (
        parsed === null
        || (
          parsed.protocol !== "http:"
          && parsed.protocol !== "https:"
          && parsed.protocol !== "mailto:"
        )
        || (
          parsed.protocol === "mailto:"
            ? parsed.pathname.trim().length === 0
            : parsed.hostname.length === 0
        )
        || typeof target !== "string"
        || /[\u0000-\u001f]/u.test(target)
      ) {
        sendApiError(response, 400, "invalid URL");
        return;
      }
      let opened = false;
      try {
        opened = options.openExternal === undefined
          ? false
          : await options.openExternal(target);
      } catch {
        opened = false;
      }
      sendJson(response, opened ? 200 : 503, { ok: Boolean(opened) });
      return;
    }

    if (pathname === "/api/ai/roles" && (method === "GET" || method === "HEAD")) {
      sendJson(response,200,aiRoles.catalog(ws as Workspace));return;
    }
    const roleExtra=/^\/api\/ai\/roles\/([^/]+)\/extra$/u.exec(pathname);
    if(roleExtra && method === "PUT") {
      try {sendJson(response,200,{extra:aiRoles.set_extra(ws as Workspace,decodeURIComponent(roleExtra[1]!),isRecord(body)?body.text:undefined)});}
      catch(error){sendApiError(response,400,error instanceof Error?error.message:String(error));}
      return;
    }

    if (pathname === "/api/setup" && method === "POST") {
      const diagnostics=options.diagnostics;
      envCache=typeof diagnostics === "function" ? await diagnostics() : diagnostics ?? [];
      const runtime=envCache.filter(item=>["Chromium","Pandoc"].includes(item.name));
      if(runtime.length < 2 || runtime.some(item=>!item.ok)) {sendApiError(response,503,"同梱の描画環境を確認できません。アプリを再インストールしてください");return;}
      sendJson(response,200,{ok:true,items:runtime}); return;
    }

    if (pathname === "/api/env") {
      if (method !== "GET" && method !== "HEAD") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      if (envCache === null || url.searchParams.get("refresh")) {
        const diagnostics = options.diagnostics;
        envCache = diagnostics === undefined
          ? []
          : typeof diagnostics === "function"
            ? await diagnostics()
            : diagnostics;
      }
      const items: unknown[] = [
        ...envCache,
        ...ws.theme_preparation(),
        ...ws.migration_preparation(),
      ];
      sendJson(response, 200, {
        ok: items.every((item) => isRecord(item) && Boolean(item.ok)),
        items: absolutizeContentUrls(items, contentOrigin),
      });
      return;
    }

    if (pathname === "/api/home") {
      if (method !== "GET" && method !== "HEAD") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      const recent: Array<Record<string, unknown>> = ws.recent().map((item) => {
        const deck = String(item.deck ?? "");
        const shots: unknown[] = options.inspect ? output.saved(ws as Workspace, deck).slides.map(row => row[0]).filter(Boolean) : [];
        return {
          ...item,
          blank: ws.is_untouched(deck),
          running: false,
          shots,
          thumb: shots[0] ?? null,
        };
      });
      const shelves = ws.shelves().map((name) => ({
        name,
        count: ws.list_figures(name).length,
        empty: !recent.some((item) => item.shelf === name) && ws.topic_empty(name),
      }));
      sendJson(response, 200, absolutizeContentUrls({
        root: ws.root,
        recent,
        shelves,
        themes: ws.themes_list(),
        prefs: ws.prefs(),
      }, contentOrigin));
      return;
    }

    const deckPreview = /^\/api\/deck\/([^/]+)\/preview$/u.exec(pathname);
    if (deckPreview) {
      if (method !== "POST") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      const deck = decodeName(deckPreview[1] as string, "発表名");
      await handleDeckPreview(request, response, ws, deck, recordBody(body));
      return;
    }

    const themePreview = /^\/api\/themes\/([^/]+)\/preview$/u.exec(pathname);
    if (themePreview) {
      if (method !== "POST") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      const name = decodeName(themePreview[1] as string, "テーマ名");
      await handleThemePreview(request, response, ws, name, recordBody(body));
      return;
    }

    const deckGet = /^\/api\/deck\/([^/]+)$/u.exec(pathname);
    if (deckGet) {
      if (method !== "GET" && method !== "HEAD") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      const deck = decodeName(deckGet[1] as string, "発表名");
      await handleDeckGet(response, ws, deck);
      return;
    }

    const deckSource = /^\/api\/deck\/([^/]+)\/source$/u.exec(pathname);
    if (deckSource) {
      if (method !== "PUT") {
        // Starlette lets POST fall through to the generic `{action}` route,
        // which rejects unknown actions with this legacy message.
        if (method === "POST") {
          sendApiError(response, 404, "操作が正しくありません");
        } else {
          sendApiError(response, 405, "method not allowed");
        }
        return;
      }
      const deck = decodeName(deckSource[1] as string, "発表名");
      await handleDeckSource(response, ws, deck, recordBody(body));
      return;
    }

    const deckChunks = /^\/api\/deck\/([^/]+)\/chunks$/u.exec(pathname);
    if (deckChunks) {
      if (method !== "GET" && method !== "HEAD" && method !== "POST") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      const deck = decodeName(deckChunks[1] as string, "発表名");
      await handleChunks(request, response, ws, deck, body);
      return;
    }

    const deckStyle = /^\/api\/deck\/([^/]+)\/style$/u.exec(pathname);
    if (deckStyle) {
      if (method !== "PUT") {
        if (method === "POST") {
          sendApiError(response, 404, "操作が正しくありません");
        } else {
          sendApiError(response, 405, "method not allowed");
        }
        return;
      }
      const deck = decodeName(deckStyle[1] as string, "発表名");
      await handleStyle(response, ws, deck, recordBody(body));
      return;
    }

    const rehearsal = /^\/api\/deck\/([^/]+)\/rehearsals$/u.exec(pathname);
    if (rehearsal) {
      if (method !== 'GET' && method !== 'PUT') { sendApiError(response,405,'method not allowed'); return; }
      const deck = decodeName(rehearsal[1]!, '発表名');
      await withDeckLock(ws,deck,async () => {
        if (!ws.has_deck(deck)) { sendApiError(response,404,'発表がありません'); return; }
        if (method === 'PUT' && !validRehearsal(body)) { sendApiError(response,400,'invalid rehearsal record'); return; }
        const previous = await readRehearsal(ws.deck_dir(deck));
        if (method === 'PUT') await saveRehearsal(ws.deck_dir(deck),body as import('./rehearsal-store.js').RehearsalRecord);
        sendJson(response,200,{previous});
      });
      return;
    }

    const deckMemo = /^\/api\/deck\/([^/]+)\/memo$/u.exec(pathname);
    if (deckMemo) {
      if (method !== "GET" && method !== "HEAD" && method !== "PUT") {
        if (method === "POST") {
          sendApiError(response, 404, "操作が正しくありません");
        } else {
          sendApiError(response, 405, "method not allowed");
        }
        return;
      }
      const deck = decodeName(deckMemo[1] as string, "発表名");
      await handleMemo(request, response, ws, deck, body);
      return;
    }

    if (pathname === "/api/events") {
      await handleEvents(request, response);
      return;
    }

    if (/^\/api\/topic\/[^/]+$/u.test(pathname) && method === "POST") {
      // Starlette path-matches the GET/DELETE topic route and reports 405.
      sendApiError(response, 405, "method not allowed");
      return;
    }

    if (feature !== null) {
      const extras: { deck?: string; op?: string } = {};
      const featureDeck = /^\/api\/deck\/([^/]+)\/([^/]+)/u.exec(pathname);
      if (featureDeck) {
        extras.deck = decodeName(featureDeck[1] as string, "発表名");
        extras.op = featureDeck[2] as string;
      }
      const featureTopic = /^\/api\/topic\/([^/]+)/u.exec(pathname);
      if (featureTopic) {
        extras.deck = decodeName(featureTopic[1] as string, "トピック名");
      }
      await dispatchFeature(feature, request, response, url, raw, body, extras);
      return;
    }

    const deckOperation = /^\/api\/deck\/([^/]+)\/([^/]+)$/u.exec(pathname);
    if (deckOperation) {
      if (method !== "POST") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      const action = deckOperation[2] as string;
      if (action !== "check" && action !== "build") {
        sendApiError(response, 404, "操作が正しくありません");
        return;
      }
      const deck = decodeName(deckOperation[1] as string, "発表名");
      await dispatchFeature({ name: action }, request, response, url, raw, body, {
        deck,
        op: action,
      });
      return;
    }

    if (pathname === "/api/structure") {
      if (method !== "POST") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      const values = recordBody(body);
      const text = values.text ?? "";
      if (typeof text !== "string") {
        sendApiError(response, 400, "操作が正しくありません");
        return;
      }
      sendJson(response, 200, parse(text).to_json());
      return;
    }

    if (pathname === "/api/new") {
      if (method !== "POST") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      const values = recordBody(body);
      try {
        ws.new_deck(
          typeof values.name === "string" ? values.name : "",
          typeof values.shelf === "string" ? values.shelf : "",
          typeof values.theme === "string" && values.theme.length > 0 ? values.theme : "default",
          typeof values.from === "string" && values.from.length > 0 ? values.from : null,
          typeof values.title === "string" && values.title.length > 0 ? values.title : null,
        );
      } catch (error) {
        sendApiError(response, 400, error instanceof Error ? error.message : String(error));
        return;
      }
      sendJson(response, 200, { deck: values.name });
      return;
    }

    if (pathname === "/api/topics") {
      if (method !== "POST") {
        sendApiError(response, 405, "method not allowed");
        return;
      }
      const values = recordBody(body);
      try {
        ws.new_topic(typeof values.name === "string" ? values.name : "");
      } catch (error) {
        sendApiError(response, 400, error instanceof Error ? error.message : String(error));
        return;
      }
      sendJson(response, 200, { topic: values.name });
      return;
    }

    sendApiError(response, 404, "not found");
  }

  async function handleShell(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendEmpty(response, 405);
      return;
    }
    let html: Buffer;
    try {
      html = await readFile(join(options.uiDirectory, new URL(request.url ?? "/", adminOrigin).pathname === "/location" ? "location.html" : "app.html"));
    } catch {
      sendApiError(response, 404, "not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(html.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": adminCsp(contentOrigin),
    });
    response.end(request.method === "HEAD" ? undefined : html);
  }

  async function handleWeb(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendEmpty(response, 405);
      return;
    }
    const suffix = pathname.slice("/web/".length);
    let decoded: string;
    try {
      decoded = decodeURIComponent(suffix);
    } catch {
      sendApiError(response, 404, "not found");
      return;
    }
    const parts = decoded.split("/");
    if (
      parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))
      || !LEGACY_WEB_FILES.includes(decoded)
    ) {
      sendApiError(response, 404, "not found");
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(join(options.uiDirectory, ...parts));
    } catch {
      sendApiError(response, 404, "not found");
      return;
    }
    response.writeHead(200, {
      "content-type": contentTypeFor(decoded),
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": adminCsp(contentOrigin),
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  }

  const handleContent = createContentHandler({
    uiDirectory: options.uiDirectory,
    getAdminOrigin: () => adminOrigin,
    getContentOrigin: () => contentOrigin,
    getWorkspace: () => workspace,
    hostMatches,
    touchCapability,
    readThemeCss,
  });

  async function handleAdmin(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (closed) {
        sendApiError(response, 503, "サーバーを終了しています");
        return;
      }
      if (!hostMatches(request, adminOrigin)) {
        sendApiError(response, 403, "unexpected Host header");
        return;
      }
      const rawUrl = request.url ?? "/";
      let url: URL;
      try {
        url = new URL(rawUrl, adminOrigin);
      } catch {
        sendApiError(response, 400, "invalid request URL");
        return;
      }
      const pathname = url.pathname;
      if (!pathname.startsWith("/")) {
        sendApiError(response, 400, "invalid request URL");
        return;
      }
      if (pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }
      if (pathname === "/files" || pathname.startsWith("/files/")) {
        // Authored HTML/files are content-origin only.
        sendApiError(response, 404, "not found");
        return;
      }
      if (pathname.startsWith("/web/")) {
        await handleWeb(request, response, pathname);
        return;
      }
      if (isShellPath(pathname)) {
        await handleShell(request, response);
        return;
      }
      sendApiError(response, 404, "not found");
    } catch (error) {
      sendFailure(response, error);
    }
  }

  const adminServer = createServer((request, response) => {
    if (isMutation(request.method ?? "GET")) mutations.add(request);
    const promise = handleAdmin(request, response).catch((error: unknown) => {
      console.error("[legacy] admin handler escaped", error);
      sendFailure(response, error);
    });
    inflight.add(promise);
    requestTasks.set(request, promise);
    void promise.finally(() => {
      inflight.delete(promise);
      requestTasks.delete(request);
      mutations.delete(request);
    }).catch(() => undefined);
  });
  const contentServer = createServer((request, response) => {
    void handleContent(request, response);
  });

  try {
    if (options.adminPort !== undefined && (!Number.isInteger(options.adminPort) || options.adminPort < 0 || options.adminPort > 65535)) throw Error("ポート番号が正しくありません");
    const adminPort = await listen(adminServer, options.adminPort);
    adminOrigin = `http://${LOOPBACK}:${adminPort}`;
    const contentPort = await listen(contentServer);
    contentOrigin = `http://${LOOPBACK}:${contentPort}`;
  } catch (error) {
    const admin = beginClose(adminServer);
    const content = beginClose(contentServer);
    admin.force();
    content.force();
    await Promise.all([admin.done, content.done]);
    throw error;
  }

  startWatch(workspace);

  async function drain(set: Set<Promise<unknown>>, label: string): Promise<void> {
    const deadline = Date.now() + shutdownGraceMs;
    while (set.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.error(`[legacy] abandoning ${set.size} ${label} during shutdown`);
        return;
      }
      const snapshot = [...set];
      const settled = await Promise.race([
        Promise.allSettled(snapshot).then(() => true),
        new Promise<boolean>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(false), remaining);
        }),
      ]);
      if (!settled) {
        console.error(`[legacy] abandoning ${set.size} ${label} during shutdown`);
        return;
      }
    }
  }

  /**
   * Accepted request handlers own writes and must settle before shutdown
   * callbacks run. A client disconnect or a tiny grace period must never let
   * the workspace lock be released while one of those handlers is still
   * writing. Render subprocesses have their own bounded timeout (and
   * `close_pandoc` at the desktop boundary), so only background renders use
   * the shorter drain below.
   */
  async function drainSettled(set: Set<Promise<unknown>>, label: string): Promise<void> {
    while (set.size > 0) {
      await Promise.allSettled([...set]);
    }
    void label;
  }

  async function close(): Promise<void> {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async () => {
      if (closed) return;
      draining = true;
      closed = true;
      stopWatch();
      const admin = beginClose(adminServer);
      const content = beginClose(contentServer);
      endSse();
      await cliBridge?.close();
      // Track the handler promises themselves. A client disconnect fires
      // `response.close` while the handler may still be inside a write.
      await chat.close();
      await output.close();
      await drainSettled(inflight, "admin requests");
      await drain(pendingRenders, "renders");
      admin.force();
      content.force();
      await Promise.all([admin.done, content.done]);
      if (options.onShutdown !== undefined) await options.onShutdown();
      capabilities.clear();
      states.clear();
    })();
    return shutdownPromise;
  }

  await startCliBridge(workspace);
  return {
    adminOrigin,
    contentOrigin,
    token,
    close,
    pending,
    pendingFeatures: pending,
    handoff,
  };
}
