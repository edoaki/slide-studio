import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CoreErrorCode,
  DesktopHost,
  DesktopHostOptions,
  PreviewDocument,
  PreviewResponse,
  WorkspaceInfo,
  WorkspaceService,
} from "../../packages/contracts/src/desktop.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CAPABILITIES = 8;
const LOOPBACK = "127.0.0.1";

interface Capability {
  html: string;
  version: string;
  slides: PreviewDocument["slides"];
  warnings: PreviewDocument["warnings"];
}

interface CoreFailureLike extends Error {
  code?: unknown;
  currentVersion?: unknown;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly currentVersion?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** A small FIFO queue. It keeps workspace replacement and exports from racing. */
class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value?.[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

function coreCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as CoreFailureLike).code;
  return typeof code === "string" ? code : undefined;
}

function coreCurrentVersion(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const version = (error as CoreFailureLike).currentVersion;
  return typeof version === "string" ? version : undefined;
}

function statusForCode(code: string | undefined): number {
  switch (code as CoreErrorCode | undefined) {
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "LOCKED":
    case "BUSY":
      return 409;
    case "OUTSIDE_ROOT":
    case "READ_ONLY":
      return 403;
    case "INVALID_INPUT":
      return 400;
    case "RENDER_TIMEOUT":
      return 504;
    case "RENDER_FAILED":
      return 500;
    default:
      return 500;
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function sendEmpty(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    "content-length": "0",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end();
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  currentVersion?: string,
): void {
  sendJson(response, status, {
    error: {
      code,
      message,
      ...(currentVersion === undefined ? {} : { currentVersion }),
    },
  });
}

function sendFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed || response.writableEnded) {
    console.error("[desktop] request failed after the response was closed", error);
    if (!response.destroyed) response.destroy();
    return;
  }
  if (error instanceof HttpError) {
    sendError(response, error.status, error.code, error.message, error.currentVersion);
    return;
  }
  const code = coreCode(error);
  const message = error instanceof Error ? error.message : "unexpected error";
  if (code !== undefined) {
    sendError(response, statusForCode(code), code, message, coreCurrentVersion(error));
    return;
  }
  // Do not expose stacks or arbitrary internal details to the renderer.
  console.error("[desktop] unhandled request failure", error);
  sendError(response, 500, "INTERNAL", "internal server error");
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "INVALID_INPUT", "request body is too large");
    }
    chunks.push(bytes);
  }
  if (total === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_INPUT", "request body must be valid JSON");
  }
  if (!isRecord(value)) {
    throw new HttpError(400, "INVALID_INPUT", "request body must be a JSON object");
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "INVALID_INPUT", `${field} must be a non-empty string`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_INPUT", `${field} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_INPUT", `${field} must be a string`);
  }
  return value;
}

function decodeId(raw: string): string {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "INVALID_INPUT", "deck id is not valid percent-encoding");
  }
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    id === "."
    || id === ".."
    || id.includes("/")
    || id.includes("\\")
    || id.includes("\0")
    || /[<>:"|?*\u0000-\u001f]/.test(id)
    || /[. ]$/.test(id)
    || windowsReserved.test(id)
  ) {
    throw new HttpError(403, "OUTSIDE_ROOT", "deck id escapes the workspace root");
  }
  return id;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
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
    server.listen(0, LOOPBACK);
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return Promise.resolve();
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}

function bridgeScript(adminOrigin: string): string {
  const origin = JSON.stringify(adminOrigin);
  return `<script>(function () {
  var parentOrigin = ${origin};
  if (window.parent === window) return;
  function publishPage() {
    try {
      var deck = window.deck;
      var index = Number(deck && deck.index);
      var step = Number(deck && deck.step);
      if (!Number.isInteger(index) || index < 0) index = 0;
      if (!Number.isInteger(step) || step < 0) step = 0;
      window.parent.postMessage({ type: 'slide-studio:page', index: index, step: step }, parentOrigin);
    } catch (error) { /* the player owns the state */ }
  }
  function publishReady() {
    try {
      var count = Number(window.deck && window.deck.count);
      window.parent.postMessage({
        type: 'slide-studio:ready',
        count: Number.isInteger(count) && count >= 0 ? count : 0
      }, parentOrigin);
    } catch (error) { /* the player owns the state */ }
    publishPage();
  }
  addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || data.type !== 'slide-studio:go') return;
    if (typeof data.index !== 'number' || !Number.isInteger(data.index) || data.index < 0) return;
    if (data.step !== undefined && (typeof data.step !== 'number' || !Number.isInteger(data.step) || data.step < 0)) return;
    var deck = window.deck;
    if (!deck || typeof deck.go !== 'function') return;
    try { deck.go(data.index, data.step === undefined ? 0 : data.step); } catch (error) { /* ignore */ }
  });
  addEventListener('deckchange', publishPage);
  if (window.deckReady === true) publishReady();
  else addEventListener('deckready', publishReady, { once: true });
})();</script>`;
}

function injectBridge(html: string, adminOrigin: string): string {
  const script = bridgeScript(adminOrigin);
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const end = head.index + head[0].length;
    return `${html.slice(0, end)}${script}${html.slice(end)}`;
  }
  const body = /<body\b[^>]*>/i.exec(html);
  if (body) {
    const end = body.index + body[0].length;
    return `${html.slice(0, end)}${script}${html.slice(end)}`;
  }
  return `${script}${html}`;
}

function adminCsp(contentOrigin: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${contentOrigin}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

function contentCsp(adminOrigin: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "script-src 'self' 'unsafe-inline' data: blob:",
    "style-src 'self' 'unsafe-inline' data: blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "frame-src 'self' data: blob: about:",
    "connect-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "sandbox allow-scripts allow-same-origin",
    `frame-ancestors ${adminOrigin}`,
  ].join("; ");
}

const STATIC_FILES: ReadonlyMap<string, string> = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
  ["/strings.js", "strings.js"],
]);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function staticContentType(file: string): string {
  const dot = file.lastIndexOf(".");
  return CONTENT_TYPES[dot < 0 ? "" : file.slice(dot)] ?? "application/octet-stream";
}

/** Start the loopback admin UI/API server and the isolated preview content server. */
export async function startDesktopHost(options: DesktopHostOptions): Promise<DesktopHost> {
  const token = randomBytes(32).toString("base64url");
  const capabilities = new Map<string, Capability>();
  const queue = new SerialQueue();
  let exportInFlight = false;
  let workspace: WorkspaceService = options.workspace;
  let adminOrigin = "";
  let contentOrigin = "";
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  function expectedHost(origin: string): string {
    return origin.replace(/^http:\/\//, "");
  }

  function hostMatches(request: IncomingMessage, origin: string): boolean {
    return headerValue(request.headers.host) === expectedHost(origin);
  }

  function rememberCapability(preview: PreviewDocument): string {
    const capability = randomBytes(32).toString("base64url");
    capabilities.set(capability, {
      html: preview.html,
      version: preview.version,
      slides: preview.slides,
      warnings: preview.warnings,
    });
    while (capabilities.size > MAX_CAPABILITIES) {
      const oldest = capabilities.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      capabilities.delete(oldest);
    }
    return capability;
  }

  function previewResponse(preview: PreviewDocument): PreviewResponse {
    const capability = rememberCapability(preview);
    return {
      url: `${contentOrigin}/preview/${capability}`,
      version: preview.version,
      slides: preview.slides,
      warnings: preview.warnings,
    };
  }

  async function handleStatic(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendEmpty(response, 405);
      return;
    }
    const file = STATIC_FILES.get(pathname);
    if (file === undefined) {
      sendError(response, 404, "NOT_FOUND", "not found");
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(join(options.uiDirectory, file));
    } catch {
      sendError(response, 404, "NOT_FOUND", "not found");
      return;
    }
    const headers: Record<string, string> = {
      "content-type": staticContentType(file),
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": adminCsp(contentOrigin),
    };
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : bytes);
  }

  async function workspaceInfo(service: WorkspaceService): Promise<WorkspaceInfo> {
    return { root: service.root, decks: await service.listDecks() };
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      sendEmpty(response, 405);
      return;
    }
    if (!tokenMatches(token, headerValue(request.headers["x-studio-token"]))) {
      sendError(response, 401, "UNAUTHORIZED", "a valid X-Studio-Token header is required");
      return;
    }

    const method = request.method ?? "";
    const mutation = method !== "GET" && method !== "HEAD";
    if (mutation) {
      if (headerValue(request.headers.origin) !== adminOrigin) {
        sendError(response, 403, "FORBIDDEN", "Origin must match the admin origin");
        return;
      }
      const contentType = headerValue(request.headers["content-type"]);
      const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        sendError(response, 400, "INVALID_INPUT", "content-type must be application/json");
        return;
      }
    }

    if (pathname === "/api/workspace") {
      if (method !== "GET" && method !== "HEAD") {
        sendError(response, 405, "INVALID_INPUT", "method not allowed");
        return;
      }
      return queue.run(async () => {
        const info = await workspaceInfo(workspace);
        sendJson(response, 200, info);
      });
    }

    if (pathname === "/api/workspace/select") {
      if (method !== "POST") {
        sendError(response, 405, "INVALID_INPUT", "method not allowed");
        return;
      }
      const body = await readJsonBody(request);
      if (!hasOnlyKeys(body, [])) {
        throw new HttpError(400, "INVALID_INPUT", "workspace selection accepts no arguments");
      }
      return queue.run(async () => {
        const next = options.selectWorkspace === undefined ? null : await options.selectWorkspace();
        if (next === null) {
          sendJson(response, 200, { cancelled: true });
          return;
        }
        const previous = workspace;
        workspace = next;
        if (previous !== next) {
          capabilities.clear();
          try {
            await previous.close();
          } catch (error) {
            console.error("[desktop] cannot close the previous workspace", error);
          }
        }
        sendJson(response, 200, await workspaceInfo(workspace));
      });
    }

    if (pathname === "/api/decks") {
      if (method !== "POST") {
        sendError(response, 405, "INVALID_INPUT", "method not allowed");
        return;
      }
      const body = await readJsonBody(request);
      if (!hasOnlyKeys(body, ["title"])) {
        throw new HttpError(400, "INVALID_INPUT", "only title is accepted");
      }
      const title = requireString(body.title, "title");
      return queue.run(async () => {
        const document = await workspace.createDeck(title);
        sendJson(response, 201, document);
      });
    }

    const match = /^\/api\/deck\/([^/]+)\/(source|preview|export)$/.exec(pathname);
    if (match === null) {
      sendError(response, 404, "NOT_FOUND", "not found");
      return;
    }
    const id = decodeId(match[1] as string);
    const action = match[2] as "source" | "preview" | "export";

    if (action === "source") {
      if (method === "GET" || method === "HEAD") {
        return queue.run(async () => {
          sendJson(response, 200, await workspace.readDeck(id));
        });
      }
      if (method !== "PUT") {
        sendError(response, 405, "INVALID_INPUT", "method not allowed");
        return;
      }
      const body = await readJsonBody(request);
      if (!hasOnlyKeys(body, ["source", "version"])) {
        throw new HttpError(400, "INVALID_INPUT", "only source and version are accepted");
      }
      const source = requireText(body.source, "source");
      const version = requireString(body.version, "version");
      return queue.run(async () => {
        sendJson(response, 200, await workspace.saveDeck(id, source, version));
      });
    }

    if (action === "preview") {
      if (method !== "POST") {
        sendError(response, 405, "INVALID_INPUT", "method not allowed");
        return;
      }
      const body = await readJsonBody(request);
      if (!hasOnlyKeys(body, ["source"])) {
        throw new HttpError(400, "INVALID_INPUT", "only source is accepted");
      }
      const source = optionalString(body.source, "source");
      return queue.run(async () => {
        const preview = await workspace.renderDeck(id, source);
        sendJson(response, 200, previewResponse(preview));
      });
    }

    if (method !== "POST") {
      sendError(response, 405, "INVALID_INPUT", "method not allowed");
      return;
    }
    const body = await readJsonBody(request);
    if (!hasOnlyKeys(body, ["format", "source"])) {
      throw new HttpError(400, "INVALID_INPUT", "only format and source are accepted");
    }
    const format = body.format;
    if (format !== "html" && format !== "pdf") {
      throw new HttpError(400, "INVALID_INPUT", "format must be html or pdf");
    }
    const source = optionalString(body.source, "source");
    if (options.exportDocument === undefined) {
      throw new HttpError(400, "INVALID_INPUT", "export is unavailable in this host");
    }
    if (exportInFlight) {
      throw new HttpError(409, "BUSY", "another export is already in progress");
    }
    exportInFlight = true;
    try {
      const prepared = await queue.run(async () => {
        const document = await workspace.readDeck(id);
        const preview = await workspace.renderDeck(id, source);
        return { title: document.title, preview };
      });
      // The native dialog and PDF rendering may take a long time. They must not
      // hold the workspace queue: saves, previews and workspace reads stay live.
      const file = await options.exportDocument?.(prepared.preview, format, prepared.title) ?? null;
      if (file !== null) {
        if (
          file.length === 0
          || file.includes("/")
          || file.includes("\\")
          || file === "."
          || file === ".."
        ) {
          throw new Error("exportDocument must return a basename or null");
        }
      }
      sendJson(response, 200, { file });
    } finally {
      exportInFlight = false;
    }
  }

  async function handleAdmin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!hostMatches(request, adminOrigin)) {
        sendError(response, 403, "FORBIDDEN", "unexpected Host header");
        return;
      }
      const rawUrl = request.url ?? "/";
      const query = rawUrl.indexOf("?");
      const pathname = query < 0 ? rawUrl : rawUrl.slice(0, query);
      if (!pathname.startsWith("/")) {
        sendError(response, 400, "INVALID_INPUT", "invalid request URL");
        return;
      }
      if (pathname.startsWith("/api/")) {
        await handleApi(request, response, pathname);
        return;
      }
      await handleStatic(request, response, pathname);
    } catch (error) {
      sendFailure(response, error);
    }
  }

  async function handleContent(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!hostMatches(request, contentOrigin)) {
        sendEmpty(response, 403);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendEmpty(response, 405);
        return;
      }
      let url: URL;
      const rawUrl = request.url ?? "/";
      const query = rawUrl.indexOf("?");
      const pathname = query < 0 ? rawUrl : rawUrl.slice(0, query);
      try {
        url = new URL(pathname, contentOrigin);
      } catch {
        sendEmpty(response, 400);
        return;
      }
      const match = /^\/preview\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      const capability = match?.[1];
      const document = capability === undefined ? undefined : capabilities.get(capability);
      if (document === undefined) {
        sendEmpty(response, 404);
        return;
      }
      const html = Buffer.from(injectBridge(document.html, adminOrigin), "utf8");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(html.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": contentCsp(adminOrigin),
      });
      response.end(request.method === "HEAD" ? undefined : html);
    } catch (error) {
      console.error("[desktop] content request failure", error);
      if (response.headersSent || response.destroyed || response.writableEnded) response.destroy();
      else sendEmpty(response, 500);
    }
  }

  const adminServer = createServer((request, response) => {
    void handleAdmin(request, response);
  });
  const contentServer = createServer((request, response) => {
    void handleContent(request, response);
  });

  try {
    const adminPort = await listen(adminServer);
    adminOrigin = `http://${LOOPBACK}:${adminPort}`;
    const contentPort = await listen(contentServer);
    contentOrigin = `http://${LOOPBACK}:${contentPort}`;
  } catch (error) {
    await Promise.all([closeServer(adminServer), closeServer(contentServer)]);
    throw error;
  }

  async function close(): Promise<void> {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async () => {
      if (closed) return;
      closed = true;
      capabilities.clear();
      await Promise.all([closeServer(adminServer), closeServer(contentServer)]);
      // Let already accepted requests finish before the workspace is released.
      await queue.run(async () => {});
      if (options.onShutdown !== undefined) await options.onShutdown();
      else await workspace.close();
    })();
    return shutdownPromise;
  }

  return {
    adminOrigin,
    contentOrigin,
    token,
    close,
  };
}
