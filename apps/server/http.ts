import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ValueError } from "../../packages/core/src/source.js";
import { checkLookupName } from "../../packages/core/src/workspace.js";
import { PREVIEW_FILE } from "./web-files.js";

export const LOOPBACK = "127.0.0.1";

interface HttpErrorLike extends Error {
  code?: unknown;
}

export class LegacyHttpError extends Error {
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

/** Small FIFO with bounded active and waiting work. */
export class BoundedQueue<T> {
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
              console.error("[server] queued render could not start", error);
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
export class BoundedQueueEvents<T> {
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

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value?.[0];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

export function statusForCode(code: string | undefined): number {
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

export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as HttpErrorLike).code;
  return typeof code === "string" ? code : undefined;
}

export function sendJson(
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

export function sendBytes(
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

export function sendEmpty(
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

export function sendApiError(
  response: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(response, status, { error: message, ...extra });
}

export function sendFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed || response.writableEnded) {
    console.error("[server] request failed after the response was closed", error);
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
  console.error("[server] unhandled request failure", error);
  sendApiError(response, 500, "internal server error");
}

export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
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

export function mediaTypeOf(request: IncomingMessage): string | undefined {
  return headerValue(request.headers["content-type"])?.split(";")[0]?.trim().toLowerCase();
}

export function parseJson(bytes: Buffer): unknown {
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new LegacyHttpError(400, "リクエスト本文が正しくありません");
  }
}

export function recordBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new LegacyHttpError(400, "リクエスト本文が正しくありません");
  return value;
}

export function decodeSegment(raw: string, label: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new LegacyHttpError(400, `${label}が正しくありません`);
  }
}

/** Validate a decoded deck/theme segment before it reaches the workspace. */
export function decodeName(raw: string, label: string): string {
  const value = decodeSegment(raw, label);
  try {
    return checkLookupName(value, label);
  } catch {
    throw new LegacyHttpError(400, `${label}が正しくありません`);
  }
}

export function safeName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value) && !value.startsWith("_");
}

export function integerField(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^[+-]?\d+$/u.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  throw new ValueError("操作が正しくありません");
}

export function cloneHeaders(request: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (lower === "x-studio-token" || lower === "cookie" || lower === "authorization") continue;
    headers[key] = headerValue(value);
  }
  return headers;
}

const CONTENT_URL_KEYS = new Set(["url", "thumb", "src"]);

/** Rewrite only URL-valued fields so free-form text starting with `/files/` is left intact. */
export function absolutizeContentUrls(
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

export function contentCsp(adminOrigin: string): string {
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

export function adminCsp(contentOrigin: string): string {
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

export function contentTypeFor(file: string): string {
  const dot = file.lastIndexOf(".");
  return CONTENT_TYPES[dot < 0 ? "" : file.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

export function listen(server: Server, port = 0): Promise<number> {
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

export function beginClose(server: Server): { done: Promise<void>; force: () => void } {
  if (!server.listening) {
    return { done: Promise.resolve(), force: () => undefined };
  }
  const done = new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
  return { done, force: () => server.closeAllConnections() };
}

export function isPublicSegment(part: string): boolean {
  return part !== ""
    && part !== "."
    && part !== ".."
    && !part.includes("\\")
    && !part.startsWith(".")
    && !part.endsWith(".tmp")
    && part !== PREVIEW_FILE;
}

export function isDeckName(value: string): boolean {
  try {
    checkLookupName(value, "発表名");
    return true;
  } catch {
    return false;
  }
}

/**
 * `/files` is a public content origin. Only explicit asset scopes are visible;
 * `.slide-studio` is private except for the runtime assets figures load.
 */
export function fileScope(parts: readonly string[]): readonly string[] | null {
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
    if (parts[0] === "decks" && parts.length === 3 && ["memo.md", "rehearsals.json"].includes(parts[2]!)) return null;
    return parts.slice(0, 2);
  }
  return null;
}

export interface ByteRange {
  start: number;
  end: number;
}

export function parseRange(value: string | undefined, size: number): ByteRange | null | "invalid" {
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
