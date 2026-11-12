/**
 * Legacy HTTP/SSE host.
 *
 * This is the TypeScript replacement for the legacy Starlette service in
 * `.reference/parity/server.py`. It keeps the legacy JSON bodies and route
 * precedence while adding the desktop host boundary: a privileged admin origin
 * and a separate content origin. Authored HTML is only ever served from the
 * content origin.
 *
 * Feature extensions (assets, materials, bibliography, themes, AI, checks,
 * shots, chunks/editing, math, export, setup, home management) are deliberately
 * routed through `featureHandlers`. An unregistered feature returns 501 instead
 * of pretending to succeed. The host therefore reports itself as in progress
 * until those handlers are integrated.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { load as loadHtml } from "cheerio";
import { watch, type FSWatcher } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  readdir,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  LegacyFeatureHandler,
  LegacyFeatureRequest,
  LegacyFeatureResponse,
  LegacyRenderText,
  LegacyRendered,
} from "../../packages/contracts/src/legacy.js";
import { atomicWriteFile } from "../../packages/core/src/atomic.js";
import { pyStrip } from "../../packages/core/src/legacy-cover.js";
import {
  cell_markdown,
  chunk_info,
  prepared_html,
  to_markdown,
  type ChunkEditMap,
} from "../../packages/core/src/legacy-edit.js";
import { merge3 } from "../../packages/core/src/legacy-edit-scope.js";
import { warning_issues } from "../../packages/core/src/legacy-render.js";
import {
  image_options,
  locate,
  move_chunk,
  parse,
  rewrite,
  set_cell,
  ValueError,
} from "../../packages/core/src/legacy-source.js";
import type { Doc } from "../../packages/core/src/legacy-source.js";
import { isInsideRoot } from "../../packages/core/src/paths.js";
import {
  decodeDeckBytes,
  encodeSourceForDeck,
  sha256,
} from "../../packages/core/src/source.js";
import {
  TEMPLATES,
  THEME_VARIABLES,
  theme_variables,
  check_name,
  checkLookupName,
  set_front,
  type Workspace,
} from "../../packages/core/src/legacy-workspace.js";
import { LegacyOutput } from "./legacy-output.js";
import type { LegacyInspect } from "../../packages/contracts/src/legacy-output.js";
import * as aiRoles from "../../packages/core/src/legacy-ai-roles.js";
import * as deckManage from "../../packages/core/src/legacy-deck-manage.js";
import { LegacyChat } from "./legacy-chat.js";
import type { Providers } from "../../packages/ai/src/providers.js";
import type { Runner } from "../../packages/ai/src/workflow.js";
import { RequestBridge } from "../../packages/ai/src/bridge.js";
import * as audit from "./legacy-audit.js";
import { LegacyInsertion } from "./legacy-insertion.js";
import { handleAssets } from "./legacy-assets.js";
import { handleMaterials } from "./legacy-materials.js";
import { MAX_BYTES as MATERIALS_MAX_BYTES } from "../../packages/core/src/legacy-materials.js";
import { LegacyThemes } from "./legacy-themes.js";
import * as memo from "./legacy-memo.js";
import * as history from "./legacy-history.js";

const LOOPBACK = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_MAX_PREVIEW_CAPABILITIES = 8;
const DEFAULT_MAX_SSE_CONNECTIONS = 32;
const DEFAULT_SSE_QUEUE = 256;
const DEFAULT_KEEP_ALIVE_MS = 15_000;
const DEFAULT_RENDER_CONCURRENCY = 2;
const DEFAULT_RENDER_PENDING = 64;
const CHUNK_VERSIONS = 4;
const PREVIEW_FILE = "__slide-studio_preview__.html";

/** Public workspace surface used by the host. Keeping it structural makes test doubles possible. */
export interface LegacyWorkspace {
  readonly root: string;
  readonly themes: string;
  has_deck(deck: string): boolean;
  qmd(deck: string): string;
  memo(deck: string): string;
  deck_dir(deck: string): string;
  list_decks(): string[];
  recent(): Array<Record<string, unknown>>;
  shelves(): string[];
  list_figures(
    shelf?: string | null,
    deck?: string | null,
  ): Array<Record<string, unknown>>;
  topic_empty(shelf: string): boolean;
  is_untouched(deck: string): boolean;
  is_blank(deck: string): boolean;
  themes_list(): string[];
  prefs(): Record<string, unknown>;
  theme_preparation(): Array<Record<string, unknown>>;
  migration_preparation(): Array<Record<string, unknown>>;
  touch_recent(deck: string): void;
  require_deck(deck: string): string;
  new_deck(
    deck: string,
    shelf: string,
    theme?: string,
    source_deck?: string | null,
    title?: string | null,
  ): string;
  new_topic(shelf: string): string;
}

export interface LegacyDiagnosticItem {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
  [key: string]: unknown;
}

export type LegacyDiagnostics =
  | LegacyDiagnosticItem[]
  | (() => LegacyDiagnosticItem[] | Promise<LegacyDiagnosticItem[]>);

export type LegacySelectWorkspace = () =>
  | LegacyWorkspace
  | null
  | Promise<LegacyWorkspace | null>;

export type LegacyOpenExternal = (url: string) => boolean | Promise<boolean>;

export type LegacyWorkspaceChanged = (
  next: LegacyWorkspace,
  previous: LegacyWorkspace,
) => void | Promise<void>;

export interface LegacyExportDocumentInput {
  deck: string;
  html: string;
  version: string;
  rendered: LegacyRendered | null;
}

export type LegacyExportDocument = (
  document: LegacyExportDocumentInput,
  format: "html" | "pdf",
  title: string,
) => string | null | Promise<string | null>;

export interface LegacyHostOptions {
  adminPort?: number;
  /** The caller owns the workspace lock and calls `Workspace.ensure()`. */
  workspace: LegacyWorkspace;
  /** Directory containing the restored legacy `app.html` and `/web` assets. */
  uiDirectory: string;
  pandocPath: string;
  /** Injected renderer. The actual render module is integrated separately. */
  renderText: LegacyRenderText;
  /** Optional feature extensions. Registered handlers run in array order. */
  featureHandlers?: LegacyFeatureHandler[];
  /** Native folder picker. The host never closes either workspace itself. */
  selectWorkspace?: LegacySelectWorkspace;
  openWorkspace?: (path:string, mode:"new"|"existing") => Promise<LegacyWorkspace>;
  recentWorkspaces?: () => string[];
  /**
   * Called after a selected workspace has been committed by the host. The
   * callback receives ownership of `previous`; the host no longer uses it.
   * The caller should release the previous lock here, not in selectWorkspace.
   */
  onWorkspaceChanged?: LegacyWorkspaceChanged;
  /** Native OS browser opening. */
  openExternal?: LegacyOpenExternal;
  openPath?: (path: string) => Promise<void>;
  /** Native save/export adapter, used by a later export feature route. */
  exportDocument?: LegacyExportDocument;
  inspect?: LegacyInspect;
  aiStorage?: string;
  aiProviders?: Providers;
  aiRunner?: Runner;
  /** Injected doctor/environment report for `/api/env`. */
  diagnostics?: LegacyDiagnostics;
  /**
   * Optional override for warning issues. The default is the real
   * `legacy-render.warning_issues` helper.
   */
  warningIssues?: (rendered: LegacyRendered | null) => unknown[];
  onShutdown?: () => void | Promise<void>;
  watch?: boolean;
  keepAliveMs?: number;
  maxSseConnections?: number;
  maxBodyBytes?: number;
  maxSourceBodyBytes?: number;
  maxUploadBodyBytes?: number;
  shutdownGraceMs?: number;
  maxPreviewCapabilities?: number;
  renderConcurrency?: number;
  renderPending?: number;
}

export interface LegacyHostHandoff {
  status: "in_progress";
  pending: string[];
  implemented: string[];
  notes: string[];
}

export interface LegacyHost {
  adminOrigin: string;
  contentOrigin: string;
  /** In-memory credential. Never log it or put it in content URLs. */
  token: string;
  close(): Promise<void>;
  /** Explicit remaining feature groups. The whole app is not feature-complete. */
  pending: readonly string[];
  /** Alias used by integration handoffs. */
  pendingFeatures: readonly string[];
  /** Integration handoff describing what this stage does and does not provide. */
  handoff: LegacyHostHandoff;
}

interface HttpErrorLike extends Error {
  code?: unknown;
}

class LegacyHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "LegacyHttpError";
  }
}

interface SourceSnapshot {
  text: string;
  version: string;
  bytes: Buffer;
  eol: "lf" | "crlf" | "mixed";
  bom: boolean;
}

interface DeckState {
  deck: string;
  html: string | null;
  version: string;
  error: string | null;
  rendered: LegacyRendered | null;
  rendering: boolean;
  dirty: boolean;
  force: boolean;
  themeOnly: boolean;
  promise: Promise<DeckState> | null;
  chunks: Map<string, ChunkEntry>;
}

interface ChunkEntry {
  rendered: LegacyRendered;
  info: Promise<ChunkEditMap>;
}

interface PreviewCapability {
  kind: "deck" | "theme";
  html: string;
  deck: string;
  version: string;
  generation: string;
  mode: "edit" | "present";
}

interface SseClient {
  response: ServerResponse;
  queue: BoundedQueueEvents<Record<string, unknown>>;
  timer: NodeJS.Timeout;
  paused: boolean;
  closed: boolean;
}

interface FeatureRoute {
  name: string;
  methods: readonly string[];
  pattern: RegExp;
  /** Optional per-route request limit. Upload routes may exceed the JSON limit. */
  bodyLimit?: number;
}

/** Restored UI assets and its private bridge client. Unknown files are never served. */
export const LEGACY_WEB_FILES: readonly string[] = Object.freeze([
  "bridge/agent-client.js", "bridge/protocol.js",
  "agents.js", "ai-model.js", "api.js", "app.css", "app.html", "app.js",
  "asset-preview.js", "assets.js", "bib-view.js", "bibliography.js",
  "block-design.js", "block-drag.js", "block-handles.js", "block-nav.js",
  "block-ops.js", "blocks.js", "chat.js", "checks.js", "clipboard.js",
  "color-picker.js", "cover-authors.js", "cover-form.js", "decoration.js",
  "editor.js", "external-links.js", "gradient-editor.js", "history.js",
  "home-ai.js", "home-manage.js", "home.js", "icons.js", "inject/edit.css",
  "inject/edit.js", "inject/layout-check.js", "inject/link.js", "inject/lint.js",
  "inject/step-badges.js", "insert.js", "layout-lint.js", "left-tabs.js",
  "link-input.js", "location.css", "location.html", "location.js",
  "materials.js", "memo.js", "overview.js", "output.js", "page-reorder.js",
  "page-strip.js", "page-templates.js", "pdf-step.js", "present.js", "preview.js",
  "qmd-blocks.js", "qmd-editor.js", "scroll-anchor.js", "shared.css",
  "shot-thumbs.js", "step-badge.js", "structure.js", "strings.js",
  "table-tools.js", "text-format.js", "text-tools.js", "theme-tab.js",
  "themes.js", "tip.js", "toc-settings.js", "topic.js",
]);

const IMPLEMENTED_FEATURES: readonly string[] = Object.freeze([
  "home", "env", "new-deck", "new-topic", "deck-read", "deck-source",
  "memo", "style", "structure", "events", "preview", "theme-preview",
  "open-external", "chunks", "warning-issues", "merge3",
  "block-design-migrate", "themes", "materials", "assets", "library", "math", "bibliography", "bib",
  "ai", "chat", "setup", "home-manage", "topic", "location", "inject", "hooks/locks", "edit-scope",
  "location-token", "pandoc-lifecycle", "content-origin-secret", "will-frame-navigate",
]);

const FEATURE_ROUTES: readonly FeatureRoute[] = Object.freeze([
  { name: "topic", methods: ["GET"], pattern: /^\/api\/topic\/[^/]+$/u },
  { name: "topic", methods: ["POST"], pattern: /^\/api\/topic\/[^/]+\/html\/delete$/u },
  { name: "topic", methods: ["DELETE"], pattern: /^\/api\/topic\/[^/]+$/u },
  { name: "setup", methods: ["POST"], pattern: /^\/api\/setup$/u },
  { name: "download", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/download\/[^/]+$/u },
  { name: "chunks", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/chunks$/u },
  { name: "assets", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/assets$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "assets", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/assets\/[^/]+$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "materials", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/materials$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "materials", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/materials\/read$/u },
  { name: "materials", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/materials\/[^/]+$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "library", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/library$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "bibliography", methods: ["POST"], pattern: /^\/api\/topic\/[^/]+\/bib\/verify$/u },
  { name: "bibliography", methods: ["PATCH"], pattern: /^\/api\/topic\/[^/]+\/bib$/u },
  { name: "bibliography", methods: ["GET", "POST", "PATCH"], pattern: /^\/api\/deck\/[^/]+\/bib$/u },
  { name: "math", methods: ["POST"], pattern: /^\/api\/math$/u },
  { name: "checks", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/checks$/u },
  { name: "shots", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/shots$/u },
  { name: "shots", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/shots\/priority$/u },
  { name: "themes", methods: ["GET", "POST"], pattern: /^\/api\/themes$/u },
  { name: "themes", methods: ["POST"], pattern: /^\/api\/themes\/select$/u },
  { name: "themes", methods: ["GET", "PUT", "DELETE"], pattern: /^\/api\/themes\/[^/]+$/u },
  { name: "ai", methods: ["GET"], pattern: /^\/api\/ai\/status$/u },
  { name: "ai", methods: ["GET"], pattern: /^\/api\/ai\/roles$/u },
  { name: "ai", methods: ["PUT"], pattern: /^\/api\/ai\/roles\/[^/]+\/extra$/u },
  { name: "ai", methods: ["GET"], pattern: /^\/api\/ai\/runtimes$/u },
  { name: "ai", methods: ["GET", "POST"], pattern: /^\/api\/ai\/[^/]+\/login$/u },
  { name: "ai", methods: ["POST"], pattern: /^\/api\/ai\/[^/]+\/runtime$/u },
  { name: "ai", methods: ["PUT"], pattern: /^\/api\/ai\/favorites$/u },
  { name: "chat", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/chat$/u },
  { name: "chat", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/open$/u },
  { name: "chat", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/tabs$/u },
  { name: "chat", methods: ["PATCH"], pattern: /^\/api\/deck\/[^/]+\/chat\/tabs\/[^/]+$/u },
  { name: "chat", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/tabs\/[^/]+\/send$/u },
  { name: "chat", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/rounds\/[^/]+\/(?:continue|cancel|handoff)$/u },
  { name: "chat", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/rounds\/[^/]+\/restore$/u },
  { name: "home-manage", methods: ["POST"], pattern: /^\/api\/home\/manage$/u },
]);

/** Small FIFO with bounded active and waiting work. */
class BoundedQueue<T> {
  #active = 0;
  #waiting: Array<() => void> = [];
  readonly #concurrency: number;
  readonly #pending: number;

  constructor(concurrency: number, pending: number) {
    this.#concurrency = Math.max(1, concurrency);
    this.#pending = Math.max(1, pending);
  }

  run<R>(task: () => Promise<R>): Promise<R> {
    return new Promise<R>((resolveTask, rejectTask) => {
      const start = (): void => {
        this.#active += 1;
        Promise.resolve()
          .then(task)
          .then(resolveTask, rejectTask)
          .finally(() => {
            this.#active -= 1;
            const next = this.#waiting.shift();
            try {
              next?.();
            } catch (error) {
              console.error("[legacy] queued render could not start", error);
            }
          });
      };
      if (this.#active < this.#concurrency) {
        start();
        return;
      }
      if (this.#waiting.length >= this.#pending) {
        rejectTask(new LegacyHttpError(503, "render queue is full"));
        return;
      }
      this.#waiting.push(start);
    });
  }
}

/** Bounded event queue. Overflow is reported so the stream can end and reconnect. */
class BoundedQueueEvents<T> {
  readonly #items: T[] = [];
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  get length(): number {
    return this.#items.length;
  }

  /** Returns false when the queue is full; callers must end the stream. */
  push(value: T): boolean {
    if (this.#items.length >= this.#limit) return false;
    this.#items.push(value);
    return true;
  }

  shift(): T | undefined {
    return this.#items.shift();
  }

  clear(): void {
    this.#items.length = 0;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value?.[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

function statusForCode(code: string | undefined): number {
  switch (code) {
    case "NOT_FOUND": return 404;
    case "CONFLICT":
    case "LOCKED":
    case "BUSY": return 409;
    case "OUTSIDE_ROOT":
    case "READ_ONLY": return 403;
    case "INVALID_INPUT": return 400;
    case "RENDER_TIMEOUT": return 504;
    case "RENDER_FAILED": return 500;
    default: return 500;
  }
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as HttpErrorLike).code;
  return typeof code === "string" ? code : undefined;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed || response.writableEnded) {
    if (!response.destroyed) response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

function sendBytes(
  response: ServerResponse,
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed || response.writableEnded) {
    if (!response.destroyed) response.destroy();
    return;
  }
  const body = Buffer.from(bytes);
  response.writeHead(status, {
    "content-type": "application/octet-stream",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

function sendEmpty(
  response: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed || response.writableEnded) {
    if (!response.destroyed) response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-length": "0",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end();
}

function sendApiError(
  response: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(response, status, { error: message, ...extra });
}

function sendFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed || response.writableEnded) {
    console.error("[legacy] request failed after the response was closed", error);
    if (!response.destroyed) response.destroy();
    return;
  }
  if (error instanceof LegacyHttpError) {
    sendJson(response, error.status, { error: error.message, ...error.extra }, error.headers ?? {});
    return;
  }
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : "unexpected error";
  if (code !== undefined) {
    sendApiError(response, statusForCode(code), message, { code });
    return;
  }
  console.error("[legacy] unhandled request failure", error);
  sendApiError(response, 500, "internal server error");
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const tooLarge = (): LegacyHttpError => new LegacyHttpError(
    413,
    "リクエストが大きすぎます",
    undefined,
    { connection: "close" },
  );
  const declared = headerValue(request.headers["content-length"]);
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) {
      request.resume();
      throw tooLarge();
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > limit) {
      request.destroy();
      throw tooLarge();
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function mediaTypeOf(request: IncomingMessage): string | undefined {
  return headerValue(request.headers["content-type"])?.split(";")[0]?.trim().toLowerCase();
}

function parseJson(bytes: Buffer): unknown {
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new LegacyHttpError(400, "リクエスト本文が正しくありません");
  }
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new LegacyHttpError(400, "リクエスト本文が正しくありません");
  return value;
}

function decodeSegment(raw: string, label: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new LegacyHttpError(400, `${label}が正しくありません`);
  }
}

/** Validate a decoded deck/theme segment before it reaches the workspace. */
function decodeName(raw: string, label: string): string {
  const value = decodeSegment(raw, label);
  try {
    return checkLookupName(value, label);
  } catch {
    throw new LegacyHttpError(400, `${label}が正しくありません`);
  }
}

function safeName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value) && !value.startsWith("_");
}

function integerField(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^[+-]?\d+$/u.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  throw new ValueError("操作が正しくありません");
}

function cloneHeaders(request: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    // The admin token and cookies are host credentials; extensions never
    // receive them on the loopback content/admin boundary.
    if (lower === "x-studio-token" || lower === "cookie" || lower === "authorization") continue;
    headers[key] = headerValue(value);
  }
  return headers;
}

const CONTENT_URL_KEYS = new Set(["url", "thumb", "src"]);

/**
 * Rewrite only URL-valued fields. Legacy feature payloads include free-form
 * strings (titles, environment text, future chunk text) that must never be
 * rewritten just because they happen to start with `/files/`.
 */
function absolutizeContentUrls(
  value: unknown,
  contentOrigin: string,
  parentKey?: string,
): unknown {
  if (typeof value === "string") {
    if (
      (parentKey !== undefined && CONTENT_URL_KEYS.has(parentKey))
      || parentKey === "shots" || parentKey === "slides"
    ) {
      if (value.startsWith("/files/") || value.startsWith("/theme/")) {
        return `${contentOrigin}${value}`;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => absolutizeContentUrls(item, contentOrigin, parentKey));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = absolutizeContentUrls(item, contentOrigin, key);
    }
    return result;
  }
  return value;
}

function contentCsp(adminOrigin: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'none'",
    "script-src 'self' 'unsafe-inline' data: blob:",
    "style-src 'self' 'unsafe-inline' data: blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "frame-src 'self' data: blob: about:",
    "connect-src 'self'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "sandbox allow-scripts allow-same-origin",
    `frame-ancestors 'self' ${adminOrigin}`,
  ].join("; ");
}

function adminCsp(contentOrigin: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "script-src 'self'",
    `style-src 'self' ${contentOrigin} 'unsafe-inline'`,
    `img-src 'self' ${contentOrigin} data: blob:`,
    `font-src 'self' ${contentOrigin} data:`,
    `media-src 'self' ${contentOrigin} data: blob:`,
    "connect-src 'self'",
    `frame-src ${contentOrigin} data: blob: about:`,
    "frame-ancestors 'none'",
  ].join("; ");
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

function contentTypeFor(file: string): string {
  const dot = file.lastIndexOf(".");
  return CONTENT_TYPES[dot < 0 ? "" : file.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

function injectPreview(
  html: string,
  input: {
    adminOrigin: string;
    contentOrigin: string;
    deck: string;
    version: string;
    generation: string;
    mode: "edit" | "present";
  },
): string {
  const $ = loadHtml(html, null, true);

  const flags: string[] = [
    `window.__slideStudioDeck=${scriptJson(input.deck)};`,
    `window.__slideStudioVersion=${scriptJson(input.version)};`,
    "window.__slideStudioNoHash=true;",
  ];
  if (input.mode === "present") {
    // Stage 1 accepts NoHash in present mode so reveal does not rewrite the
    // frame hash. Deck/Version remain part of the legacy bootstrap.
  } else {
    flags.push("window.__slideStudioFill=true;");
    flags.push("window.__slideStudioNoOverview=true;");
  }
  const injected = [
    `<script data-studio-admin-origin="${escapeAttribute(input.adminOrigin)}"`
      + ` data-studio-deck="${escapeAttribute(input.deck)}"`
      + ` data-studio-version="${escapeAttribute(input.version)}"`
      + ` data-studio-generation="${escapeAttribute(input.generation)}"`
      + ` data-studio-mode="${input.mode}"`
      + ` src="${escapeAttribute(input.contentOrigin)}/bridge/frame-agent.classic.js"></script>`,
    `<script>${flags.join("")}</script>`,
    ...(input.mode === "edit" ? [`<link rel="stylesheet" href="${escapeAttribute(input.contentOrigin)}/bridge/edit.css">`] : []),
  ].join("");

  // parse5 has already normalized malformed input (including scripts before
  // html/head). Prepending to head keeps the classic bridge agent ahead of every
  // authored script, even when the source begins with scripts. The preview is
  // served from the deck directory, so fragment links resolve within the same
  // document without an injected <base>.
  $("head").prepend(injected);
  const serialized = $.html();
  return typeof serialized === "string" ? serialized : "";
}

function isShellPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/agents" || pathname === "/location") return true;
  if (/^\/deck\/[^/]+$/u.test(pathname)) return true;
  if (/^\/topic\/[^/]+$/u.test(pathname)) return true;
  if (pathname.startsWith("/figure/")) return true;
  return false;
}

function matchesFeature(method: string, pathname: string): FeatureRoute | null {
  const effective = method === "HEAD" ? "GET" : method;
  for (const route of FEATURE_ROUTES) {
    if (!route.methods.includes(effective)) continue;
    if (route.pattern.test(pathname)) return route;
  }
  return null;
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolvePort(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOOPBACK);
  });
}

function beginClose(server: Server): { done: Promise<void>; force: () => void } {
  if (!server.listening) {
    return { done: Promise.resolve(), force: () => undefined };
  }
  const done = new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
  return { done, force: () => server.closeAllConnections() };
}

function baseState(deck: string): DeckState {
  return {
    deck,
    html: null,
    version: "",
    error: null,
    rendered: null,
    rendering: false,
    dirty: false,
    force: false,
    themeOnly: false,
    promise: null,
    chunks: new Map(),
  };
}

function isPublicSegment(part: string): boolean {
  return part !== ""
    && part !== "."
    && part !== ".."
    && !part.includes("\\")
    && !part.startsWith(".")
    && !part.endsWith(".tmp")
    && part !== PREVIEW_FILE;
}

function isDeckName(value: string): boolean {
  try {
    checkLookupName(value, "発表名");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- block design migration

const BLOCK_DECORATION = new Set([
  "border",
  "background-color",
  "--block-design",
  "border-top",
  "border-left",
  "border-radius",
  "box-shadow",
]);
const BLOCK_KINDS = ["plain", "top", "left", "quote", "bracket", "fold"] as const;
const BLOCK_DESIGNS: Record<string, Record<string, string>> = {
  plain: {},
  top: {},
  left: {},
  quote: {},
  bracket: {},
  fold: {},
  shadow: {
    border: "0 solid transparent",
    "border-radius": "10px",
    "background-color": "var(--block-shadow-fill)",
    "box-shadow": "0 4px 14px var(--block-shadow-color)",
  },
  corner: {
    border: "0 solid transparent",
    "border-radius": "10px",
    "border-top": "var(--block-corner-top)",
    "border-left": "var(--block-corner-left)",
    "background-color": "var(--block-corner-fill)",
  },
};
const BLOCK_COLOR = "#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?";
const BLOCK_BORDER = new RegExp(
  String.raw`^[\d.]+px (?:solid|dashed|dotted|double) ${BLOCK_COLOR}$`,
  "u",
);
const BLOCK_COLOR_FULL = new RegExp(String.raw`^${BLOCK_COLOR}$`, "u");
const BLOCK_STYLE = /(\{[^{}\n]*?\bstyle=")([^"]*)(")/gu;
const BLOCK_EXTRA_KEYS = new Set([
  "--block-design",
  "border-top",
  "border-left",
  "border-radius",
  "box-shadow",
]);
const BLOCK_COLUMN_DECORATION = new Set([...BLOCK_DECORATION, "--block-shadow"]);

function blockProps(style: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of style.split(";")) {
    if (!part.includes(":")) continue;
    const colon = part.indexOf(":");
    pairs.push([
      pyStrip(part.slice(0, colon)),
      pyStrip(part.slice(colon + 1)),
    ]);
  }
  return pairs;
}

function blockKind(props: Record<string, string>): string | null | false {
  const design = props["--block-design"];
  if (design !== undefined && Object.prototype.hasOwnProperty.call(BLOCK_DESIGNS, design)) {
    return design;
  }
  const border = props.border;
  const fill = props["background-color"];
  if (
    (border === undefined && fill === undefined)
    || Object.keys(props).some((key) => BLOCK_EXTRA_KEYS.has(key))
  ) {
    return false;
  }
  if (border !== undefined && !(border === "none" || BLOCK_BORDER.test(border))) {
    return false;
  }
  if (fill !== undefined && !(fill === "transparent" || BLOCK_COLOR_FULL.test(fill))) {
    return false;
  }
  return (border !== undefined && border !== "none")
    || (fill !== undefined && fill !== "transparent")
    ? "plain"
    : null;
}

function blockDesignValues(kind: string | null): Array<[string, string]> {
  if (kind === null) return [];
  return [["--block-design", kind], ...Object.entries(BLOCK_DESIGNS[kind] ?? {})];
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) && right[key] === left[key]);
}

function migrateBlockStyles(text: string): string {
  return text.replace(BLOCK_STYLE, (_match, prefix: string, style: string, suffix: string) => {
    const props = blockProps(style);
    const kind = blockKind(Object.fromEntries(props));
    if (kind === false) return _match;
    const rest = [
      ...props.filter(([key]) => !BLOCK_DECORATION.has(key)),
      ...blockDesignValues(kind),
    ];
    if (rest.length === 0) return _match;
    if (sameRecord(Object.fromEntries(rest), Object.fromEntries(props))) return _match;
    return `${prefix}${rest.map(([key, value]) => `${key}:${value}`).join(";")}${suffix}`;
  });
}

function cpSlice(value: string, start: number, end: number): string {
  return Array.from(value).slice(Math.max(0, start), Math.max(0, end)).join("");
}

/** Port of `block_design.normalize_columns`, applied until stable. */
function normalizeBlockColumns(text: string): string {
  let current = text;
  while (true) {
    let edits: Array<[number, number, string]> | null = null;
    for (const page of parse(current).pages) {
      for (const column of page.walk()) {
        if (column.kind !== "column" || column.children.length !== 1 || !column.open) continue;
        const box = column.children[0]!;
        if (
          box.kind !== "box"
          || !box.open
          || !box.close
          || !box.attrs
          || box.attrs.id
          || box.attrs.classes.length > 0
        ) {
          continue;
        }
        const outer = Object.fromEntries(blockProps(column.attrs?.kv.style ?? ""));
        const inner = Object.fromEntries(blockProps(box.attrs.kv.style ?? ""));
        if (
          Object.keys(outer).some((key) => BLOCK_COLUMN_DECORATION.has(key))
          && Object.keys(inner).some((key) => BLOCK_COLUMN_DECORATION.has(key))
        ) {
          continue;
        }
        if (
          Object.keys(inner).some((key) =>
            !["padding", "text-box", "--block-space"].includes(key)
            && Object.prototype.hasOwnProperty.call(outer, key))
        ) {
          continue;
        }
        if (Object.entries(box.attrs.kv).some(([key, value]) =>
          key !== "style"
          && Object.prototype.hasOwnProperty.call(column.attrs!.kv, key)
          && column.attrs!.kv[key] !== value)) {
          continue;
        }
        const kv: Record<string, string> = { ...column.attrs!.kv, ...box.attrs.kv };
        if (Object.keys(outer).length > 0 || Object.keys(inner).length > 0) {
          const style: Record<string, string> = { ...outer, ...inner };
          if (Object.prototype.hasOwnProperty.call(outer, "--block-space")) {
            style["--block-space"] = outer["--block-space"]!;
          }
          kv.style = Object.entries(style).map(([key, value]) => `${key}:${value}`).join(";");
        }
        const attrs: string[] = [];
        if (column.attrs!.id) attrs.push(`#${column.attrs!.id}`);
        for (const name of column.attrs!.classes) attrs.push(`.${name}`);
        for (const [key, value] of Object.entries(kv)) {
          attrs.push(
            `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
          );
        }
        const openLine = cpSlice(current, column.open[0], column.open[1]);
        const fence = /^\s*:{3,}/u.exec(openLine)?.[0];
        if (fence === undefined) continue;
        edits = [
          [column.open[0], column.open[1], `${fence} {${attrs.join(" ")}}`],
          [box.open[0], box.open[1], ""],
          [box.close[0], box.close[1], ""],
        ];
        break;
      }
      if (edits !== null) break;
    }
    if (edits === null) return current;
    edits.sort((left, right) => right[0] - left[0] || right[1] - left[1]);
    for (const [start, end, replacement] of edits) {
      current = cpSlice(current, 0, start) + replacement + cpSlice(current, end, Number.POSITIVE_INFINITY);
    }
  }
}

/** Migrate per-block decoration colors to the current kind-only source form. */
function migrateBlockDesign(text: string): string {
  return normalizeBlockColumns(migrateBlockStyles(text));
}

/**
 * `/files` is a public content origin. Only explicit asset scopes are visible;
 * `.slide-studio` is private except for the runtime assets figures load.
 */
function fileScope(parts: readonly string[]): readonly string[] | null {
  if (parts.length === 6 && parts[0] === ".slide-studio" && parts[1] === "build" && isDeckName(parts[2]!) && parts[3] === "shots" && /^[a-f0-9]{64}$/u.test(parts[4]!) && /^p[0-9]+-s[0-9]+\.png$/u.test(parts[5]!)) return parts.slice(0, 5);
  if (
    parts.length > 2
    && parts[0] === ".slide-studio"
    && parts[1] === "runtime"
    && parts.slice(2).every(isPublicSegment)
  ) {
    return [".slide-studio", "runtime"];
  }
  if (parts.some((part) => !isPublicSegment(part))) return null;
  if (parts[0] === "themes" && parts.length >= 2) return ["themes"];
  if (
    (parts[0] === "decks" || parts[0] === "topics")
    && parts.length >= 3
    && isDeckName(parts[1] as string)
  ) {
    if (parts[0] === "decks" && parts.length === 3 && parts[2] === "memo.md") return null;
    return parts.slice(0, 2);
  }
  return null;
}

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(value: string | undefined, size: number): ByteRange | null | "invalid" {
  if (value === undefined) return null;
  if (!value.startsWith("bytes=") || size <= 0) return "invalid";
  const spec = value.slice("bytes=".length);
  if (spec.includes(",")) return "invalid";
  const match = /^(\d*)-(\d*)$/u.exec(spec);
  if (match === null) return "invalid";
  const first = match[1] as string;
  const second = match[2] as string;
  if (first === "" && second === "") return "invalid";
  if (first === "") {
    const suffix = Number(second);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = Number(first);
  const requestedEnd = second === "" ? size - 1 : Number(second);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return "invalid";
  if (start >= size || requestedEnd < start) return "invalid";
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/**
 * Start the legacy admin/content hosts. The caller owns the workspace lock and
 * remains responsible for closing the workspace after this host is closed.
 */
export async function startLegacyHost(options: LegacyHostOptions): Promise<LegacyHost> {
  if (typeof options.renderText !== "function") {
    throw new TypeError("renderText is required");
  }
  if (!isAbsolute(options.uiDirectory) || !isAbsolute(options.pandocPath)) {
    throw new TypeError("uiDirectory and pandocPath must be absolute paths");
  }

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
        if (rest[0] === "materials" || (rest.length === 1 && rest[0] === "memo.md")) continue;
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

    if (pathname === "/api/home/manage" && method === "POST") {
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
        if (values.action === "undo") {
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

  async function handleContentStatic(
    request: IncomingMessage,
    response: ServerResponse,
    ws: LegacyWorkspace,
    pathname: string,
    rangeHeader: string | undefined,
  ): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname.slice("/files/".length));
    } catch {
      sendEmpty(response, 404);
      return;
    }
    if (decoded.includes("\0")) {
      sendEmpty(response, 404);
      return;
    }
    const parts = decoded.split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) {
      sendEmpty(response, 404);
      return;
    }
    // Public `/files` is an explicit allowlist, not the whole workspace. This
    // also rejects symlinks that alias private state from an allowed scope.
    const scope = fileScope(parts);
    if (scope === null) {
      sendEmpty(response, 404);
      return;
    }
    const lexicalRoot = resolve(ws.root);
    const candidate = resolve(lexicalRoot, ...parts);
    if (!isInsideRoot(lexicalRoot, candidate)) {
      sendEmpty(response, 404);
      return;
    }
    let rootReal: string;
    let scopeReal: string;
    let fileReal: string;
    try {
      rootReal = await realpath(lexicalRoot);
      scopeReal = await realpath(resolve(rootReal, ...scope));
      fileReal = await realpath(candidate);
    } catch {
      sendEmpty(response, 404);
      return;
    }
    if (
      !isInsideRoot(rootReal, scopeReal)
      || !isInsideRoot(rootReal, fileReal)
      || !isInsideRoot(scopeReal, fileReal)
    ) {
      sendEmpty(response, 404);
      return;
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(fileReal, "r");
      const info = await handle.stat();
      if (!info.isFile()) {
        await handle.close();
        sendEmpty(response, 404);
        return;
      }
      const range = parseRange(rangeHeader, info.size);
      if (range === "invalid") {
        await handle.close();
        sendEmpty(response, 416, {
          "content-range": `bytes */${info.size}`,
          "accept-ranges": "bytes",
        });
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, info.size - 1);
      const length = info.size === 0 ? 0 : end - start + 1;
      const headers: Record<string, string> = {
        "content-type": contentTypeFor(fileReal),
        "content-length": String(length),
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": contentCsp(adminOrigin),
      };
      if (range !== null) headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
      response.writeHead(range === null ? 200 : 206, headers);
      if (request.method === "HEAD" || length === 0) {
        await handle.close();
        response.end();
        return;
      }
      const stream = handle.createReadStream({ start, end, autoClose: true });
      stream.on("error", () => {
        if (!response.destroyed) response.destroy();
      });
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    } catch {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // The descriptor may already be closed by the stream.
        }
      }
      if (!response.headersSent) sendEmpty(response, 404);
    }
  }

  async function handleContent(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (!hostMatches(request, contentOrigin)) {
        sendEmpty(response, 403);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendEmpty(response, 405);
        return;
      }
      const rawUrl = request.url ?? "/";
      let url: URL;
      try {
        url = new URL(rawUrl, contentOrigin);
      } catch {
        sendEmpty(response, 400);
        return;
      }
      const pathname = url.pathname;
      const ws = workspace;

      const servePreview = (capability: PreviewCapability): void => {
        const html = Buffer.from(injectPreview(capability.html, {
          adminOrigin,
          contentOrigin,
          deck: capability.deck,
          version: capability.version,
          generation: capability.generation,
          mode: capability.mode,
        }), "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(html.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": contentCsp(adminOrigin),
        });
        response.end(request.method === "HEAD" ? undefined : html);
      };

      if (pathname.startsWith("/preview/")) {
        const match = /^\/preview\/([A-Za-z0-9_-]+)$/u.exec(pathname);
        const capability = match === null ? undefined : touchCapability(match[1] as string);
        if (capability === undefined) {
          sendEmpty(response, 404);
          return;
        }
        servePreview(capability);
        return;
      }

      // The preview lives in the deck directory so fragment links resolve to
      // the same document. The capability is carried in the query string.
      const deckPreview = /^\/files\/decks\/([^/]+)\/__slide-studio_preview__\.html$/u.exec(pathname);
      if (deckPreview) {
        const code = url.searchParams.get("c");
        const capability = code === null ? undefined : touchCapability(code);
        if (capability === undefined || capability.kind !== "deck") {
          sendEmpty(response, 404);
          return;
        }
        let deck: string;
        try {
          deck = decodeName(deckPreview[1] as string, "発表名");
        } catch {
          sendEmpty(response, 404);
          return;
        }
        if (deck !== capability.deck) {
          sendEmpty(response, 404);
          return;
        }
        servePreview(capability);
        return;
      }
      if (pathname === `/files/themes/${PREVIEW_FILE}`) {
        const code = url.searchParams.get("c");
        const capability = code === null ? undefined : touchCapability(code);
        if (capability === undefined || capability.kind !== "theme") {
          sendEmpty(response, 404);
          return;
        }
        servePreview(capability);
        return;
      }

      const themeMatch = /^\/theme\/([^/]+)\.css$/u.exec(pathname);
      if (themeMatch) {
        const name = decodeName(themeMatch[1] as string, "テーマ名");
        const css = await readThemeCss(ws, name);
        if (css === null) {
          sendEmpty(response, 404);
          return;
        }
        response.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "content-length": String(css.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(request.method === "HEAD" ? undefined : css);
        return;
      }

      const themeShotMatch = /^\/theme-shots\/([^/]+)\/([0-3]\.png)$/u.exec(pathname);
      const shotMatch = themeShotMatch ?? /^\/shots\/([^/]+)\/([^/]+\.png)$/u.exec(pathname);
      if (shotMatch) {
        let deck: string;
        let file: string;
        try {
          deck = decodeName(shotMatch[1] as string, "発表名");
          file = decodeSegment(shotMatch[2] as string, "画像名");
        } catch {
          sendEmpty(response, 404);
          return;
        }
        if (!isPublicSegment(file)) {
          sendEmpty(response, 404);
          return;
        }
        const rootReal = await realpath(resolve(ws.root));
        const shotRoot = resolve(rootReal, ".slide-studio", themeShotMatch ? "themes" : "shots", deck);
        let shotReal: string;
        let rootScopeReal: string;
        try {
          shotReal = await realpath(resolve(shotRoot, file));
          rootScopeReal = await realpath(shotRoot);
        } catch {
          sendEmpty(response, 404);
          return;
        }
        if (!isInsideRoot(rootReal, rootScopeReal) || !isInsideRoot(rootScopeReal, shotReal)) {
          sendEmpty(response, 404);
          return;
        }
        let bytes: Buffer;
        try {
          bytes = await readFile(shotReal);
        } catch {
          sendEmpty(response, 404);
          return;
        }
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
        return;
      }

      if (pathname === "/bridge/edit.css") {
        const bytes = await readFile(join(options.uiDirectory, "inject", "edit.css"));
        response.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
        return;
      }
      if (pathname === "/bridge/frame-agent.classic.js") {
        let bytes: Buffer;
        try {
          bytes = await readFile(join(options.uiDirectory, "bridge", "frame-agent.classic.js"));
        } catch {
          sendEmpty(response, 404);
          return;
        }
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
        return;
      }

      if (pathname.startsWith("/files/")) {
        await handleContentStatic(
          request,
          response,
          ws,
          pathname,
          headerValue(request.headers.range),
        );
        return;
      }

      // Content has no API, CORS, admin shell or /web assets.
      sendEmpty(response, 404);
    } catch (error) {
      console.error("[legacy] content request failure", error);
      if (response.headersSent || response.destroyed || response.writableEnded) {
        if (!response.destroyed) response.destroy();
      } else {
        sendEmpty(response, 500);
      }
    }
  }

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
