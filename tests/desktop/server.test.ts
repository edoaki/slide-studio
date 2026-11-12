import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { startDesktopHost } from "../../apps/server/index.js";
import type {
  CoreErrorCode,
  CoreFailure,
  DeckDocument,
  DeckSummary,
  DesktopHost,
  DesktopHostOptions,
  PreviewDocument,
  WorkspaceService,
} from "../../packages/contracts/src/desktop.js";

function failure(code: CoreErrorCode, message: string, currentVersion?: string): CoreFailure {
  const error = new Error(message) as CoreFailure;
  error.code = code;
  if (currentVersion !== undefined) error.currentVersion = currentVersion;
  return error;
}

class FakeWorkspace implements WorkspaceService {
  readonly decks: DeckDocument[] = [];
  closed = 0;
  readCalls = 0;
  saveCalls: { id: string; source: string; expectedVersion: string }[] = [];
  renderCalls: { id: string; source?: string }[] = [];
  saveGate: Promise<void> | undefined;

  constructor(readonly root: string, initial?: DeckDocument) {
    if (initial) this.decks.push(initial);
  }

  async listDecks(): Promise<DeckSummary[]> {
    return this.decks.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  async createDeck(title: string): Promise<DeckDocument> {
    const document: DeckDocument = {
      id: `deck-${this.decks.length + 1}`,
      title,
      updatedAt: "2026-11-12T00:00:00.000Z",
      source: `# ${title}\n`,
      version: "v1",
      eol: "lf",
      bom: false,
      readOnly: false,
      diagnostics: [],
    };
    this.decks.push(document);
    return { ...document };
  }

  async readDeck(id: string): Promise<DeckDocument> {
    this.readCalls += 1;
    if (id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) {
      throw failure("OUTSIDE_ROOT", "deck id escapes the workspace root");
    }
    if (id === "locked") throw failure("LOCKED", "workspace is locked");
    if (id === "missing") throw failure("NOT_FOUND", "deck not found");
    const found = this.decks.find((deck) => deck.id === id);
    if (found === undefined) throw failure("NOT_FOUND", "deck not found");
    return { ...found };
  }

  async saveDeck(id: string, source: string, expectedVersion: string): Promise<DeckDocument> {
    this.saveCalls.push({ id, source, expectedVersion });
    if (this.saveGate !== undefined) await this.saveGate;
    const found = this.decks.find((deck) => deck.id === id);
    if (found === undefined) throw failure("NOT_FOUND", "deck not found");
    if (expectedVersion !== found.version) {
      throw failure("CONFLICT", "source changed on disk", "external-edit");
    }
    found.source = source;
    found.version = `v${this.saveCalls.length + 1}`;
    return { ...found };
  }

  async renderDeck(id: string, source?: string): Promise<PreviewDocument> {
    this.renderCalls.push({ id, source });
    const found = await this.readDeck(id);
    if (id === "preview-fail") throw failure("RENDER_FAILED", "render failed");
    if (id === "preview-timeout") throw failure("RENDER_TIMEOUT", "render timed out");
    return {
      html: "<!doctype html><html><head><meta charset=\"utf-8\"><title>Preview</title></head><body><div id=\"stage\">プレビュー</div></body></html>",
      version: found.version,
      slides: [{ index: 0, id: "slide-1", title: found.title, level: 1 }],
      warnings: [],
    };
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

interface ResponseValue {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: unknown;
}

interface RequestOptions {
  method?: string;
  token?: string | null;
  origin?: string | null;
  json?: unknown;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

function request(
  origin: string,
  path: string,
  options: RequestOptions = {},
): Promise<ResponseValue> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...options.headers };
  const token = options.token === undefined ? undefined : options.token;
  if (token !== undefined && token !== null) headers["x-studio-token"] = token;
  if (method !== "GET" && method !== "HEAD" && options.origin !== null) {
    headers.origin = options.origin ?? origin;
  }
  let body: string | undefined = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["content-type"] = options.contentType ?? "application/json";
  } else if (options.contentType !== undefined) {
    headers["content-type"] = options.contentType;
  }
  const url = new URL(path, origin);
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = undefined;
        }
        resolveResponse({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text,
          json,
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function adminRequest(
  host: DesktopHost,
  path: string,
  options: RequestOptions = {},
): Promise<ResponseValue> {
  return request(host.adminOrigin, path, {
    ...options,
    token: options.token === undefined ? host.token : options.token,
  });
}

async function createUiDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "slide-studio-ui-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>UI</title>\n");
  await writeFile(join(directory, "app.js"), "export const app = true;\n");
  await writeFile(join(directory, "styles.css"), "body { color: black; }\n");
  await writeFile(join(directory, "strings.js"), "export const strings = { title: 'Slide Studio' };\n");
  return directory;
}

interface HostFixture {
  host: DesktopHost;
  workspace: FakeWorkspace;
  uiDirectory: string;
}

async function launch(
  t: TestContext,
  overrides: Partial<DesktopHostOptions> = {},
  initial?: DeckDocument,
): Promise<HostFixture> {
  const uiDirectory = overrides.uiDirectory ?? await createUiDirectory(t);
  const workspace = (overrides.workspace as FakeWorkspace | undefined)
    ?? new FakeWorkspace("/tmp/slide-studio-test", initial);
  const host = await startDesktopHost({
    workspace,
    uiDirectory,
    ...overrides,
  });
  t.after(async () => {
    await host.close();
  });
  return { host, workspace, uiDirectory };
}

function initialDeck(): DeckDocument {
  return {
    id: "deck-1",
    title: "テスト",
    updatedAt: "2026-11-12T00:00:00.000Z",
    source: "# テスト\n",
    version: "v1",
    eol: "lf",
    bom: false,
    readOnly: false,
    diagnostics: [],
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("condition did not become true");
}

test("serves only the allowlisted admin UI files with a self CSP", async (t) => {
  const { host } = await launch(t);
  const index = await adminRequest(host, "/");
  assert.equal(index.status, 200);
  assert.match(String(index.headers["content-type"]), /text\/html/);
  const csp = String(index.headers["content-security-policy"]);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, new RegExp(`frame-src ${host.contentOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  assert.equal((await adminRequest(host, "/app.js")).status, 200);
  assert.equal((await adminRequest(host, "/styles.css")).status, 200);
  assert.equal((await adminRequest(host, "/strings.js")).status, 200);
  assert.equal((await adminRequest(host, "/package.json")).status, 404);
  assert.equal((await adminRequest(host, "/../../package.json")).status, 404);
  assert.equal((await adminRequest(host, "/does-not-exist")).status, 404);
});

test("requires the launch token on every API route", async (t) => {
  const { host } = await launch(t);
  assert.equal((await adminRequest(host, "/api/workspace", { token: null })).status, 401);
  assert.equal((await adminRequest(host, "/api/workspace", { token: "wrong" })).status, 401);
  const ok = await adminRequest(host, "/api/workspace");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { root: "/tmp/slide-studio-test", decks: [] });
  assert.equal(ok.text.includes(host.token), false);

  const protectedRequests: { path: string; method: string; json?: unknown }[] = [
    { path: "/api/workspace", method: "GET" },
    { path: "/api/workspace/select", method: "POST", json: {} },
    { path: "/api/decks", method: "POST", json: { title: "x" } },
    { path: "/api/deck/deck-1/source", method: "GET" },
    { path: "/api/deck/deck-1/source", method: "PUT", json: { source: "", version: "v1" } },
    { path: "/api/deck/deck-1/preview", method: "POST", json: {} },
    { path: "/api/deck/deck-1/export", method: "POST", json: { format: "html" } },
  ];
  for (const protectedRequest of protectedRequests) {
    const response = await adminRequest(host, protectedRequest.path, {
      method: protectedRequest.method,
      token: null,
      json: protectedRequest.json,
    });
    assert.equal(response.status, 401, `${protectedRequest.method} ${protectedRequest.path}`);
  }
});

test("rejects an unexpected Host header on both ports", async (t) => {
  const { host } = await launch(t);
  const admin = await request(host.adminOrigin, "/api/workspace", {
    token: host.token,
    headers: { host: "evil.example" },
  });
  assert.equal(admin.status, 403);
  const port = new URL(host.adminOrigin).port;
  const localhostAdmin = await request(host.adminOrigin, "/api/workspace", {
    token: host.token,
    headers: { host: `localhost:${port}` },
  });
  assert.equal(localhostAdmin.status, 403);
  const content = await request(host.contentOrigin, "/preview/unknown", {
    headers: { host: "evil.example" },
  });
  assert.equal(content.status, 403);
  const contentPort = new URL(host.contentOrigin).port;
  const localhostContent = await request(host.contentOrigin, "/preview/unknown", {
    headers: { host: `localhost:${contentPort}` },
  });
  assert.equal(localhostContent.status, 403);
});

test("requires exact Origin and JSON for mutations", async (t) => {
  const { host } = await launch(t);
  const noOrigin = await adminRequest(host, "/api/decks", {
    method: "POST",
    origin: null,
    json: { title: "x" },
  });
  assert.equal(noOrigin.status, 403);
  const wrongOrigin = await adminRequest(host, "/api/decks", {
    method: "POST",
    origin: "http://evil.example",
    json: { title: "x" },
  });
  assert.equal(wrongOrigin.status, 403);
  const nonJson = await adminRequest(host, "/api/decks", {
    method: "POST",
    body: "title=x",
    contentType: "text/plain",
  });
  assert.equal(nonJson.status, 400);
  const created = await adminRequest(host, "/api/decks", { method: "POST", json: { title: "新規" } });
  assert.equal(created.status, 201);
  assert.equal((created.json as DeckDocument).title, "新規");
});

test("answers OPTIONS without any CORS allow headers", async (t) => {
  const { host } = await launch(t);
  const response = await request(host.adminOrigin, "/api/workspace", { method: "OPTIONS" });
  assert.equal(response.status, 405);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["access-control-allow-methods"], undefined);
  assert.equal(response.headers["access-control-allow-headers"], undefined);
});

test("decodes deck ids before rejecting traversal", async (t) => {
  const { host, workspace } = await launch(t, {}, initialDeck());
  const before = workspace.readCalls;
  const rejected = [
    "%2e%2e",
    "%2e%2e%2fsecret",
    "a%2Fb",
    "a%5Cb",
    "%00",
    "C:x",
    "a:stream",
    "CON",
    "trailing.",
    "trailing%20",
  ];
  for (const id of rejected) {
    const response = await adminRequest(host, `/api/deck/${id}/source`);
    assert.equal(response.status, 403, id);
  }
  assert.equal(workspace.readCalls, before, "rejected ids must not reach the service");
});

test("returns core errors with the documented status codes and no stack", async (t) => {
  const { host } = await launch(t, {}, initialDeck());
  const missing = await adminRequest(host, "/api/deck/missing/source");
  assert.equal(missing.status, 404);
  const missingBody = missing.json as { error: { code: string; message: string; stack?: string } };
  assert.equal(missingBody.error.code, "NOT_FOUND");
  assert.equal(missingBody.error.stack, undefined);

  const locked = await adminRequest(host, "/api/deck/locked/source");
  assert.equal(locked.status, 409);

  const stale = await adminRequest(host, "/api/deck/deck-1/source", {
    method: "PUT",
    json: { source: "# 変更\n", version: "old" },
  });
  assert.equal(stale.status, 409);
  assert.equal((stale.json as { error: { code: string } }).error.code, "CONFLICT");
  assert.equal((stale.json as { error: { currentVersion: string } }).error.currentVersion, "external-edit");
});

test("saves with the expected version and rejects unknown fields", async (t) => {
  const { host, workspace } = await launch(t, {}, initialDeck());
  const bad = await adminRequest(host, "/api/deck/deck-1/source", {
    method: "PUT",
    json: { source: "# x", version: "v1", path: "/tmp/out" },
  });
  assert.equal(bad.status, 400);
  const saved = await adminRequest(host, "/api/deck/deck-1/source", {
    method: "PUT",
    json: { source: "# x\n", version: "v1" },
  });
  assert.equal(saved.status, 200);
  assert.equal(workspace.saveCalls.length, 1);
  assert.equal(workspace.decks[0]?.source, "# x\n");
});

test("creates preview capabilities with the host bridge and content CSP", async (t) => {
  const { host, workspace } = await launch(t, {}, initialDeck());
  const preview = await adminRequest(host, "/api/deck/deck-1/preview", {
    method: "POST",
    json: { source: "# 更新\n" },
  });
  assert.equal(preview.status, 200);
  const body = preview.json as { url: string; version: string; slides: unknown[]; warnings: unknown[] };
  assert.match(body.url, new RegExp(`^${host.contentOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/preview/[A-Za-z0-9_-]+$`));
  assert.equal(body.url.includes(host.token), false);
  assert.equal(workspace.renderCalls[0]?.source, "# 更新\n");

  const path = new URL(body.url).pathname;
  const content = await request(host.contentOrigin, path);
  assert.equal(content.status, 200);
  assert.match(content.text, /slide-studio:go/);
  assert.match(content.text, new RegExp(host.adminOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const csp = String(content.headers["content-security-policy"]);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /sandbox allow-scripts allow-same-origin/);
  assert.match(csp, new RegExp(`frame-ancestors ${host.adminOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(csp, /file:/);
  assert.doesNotMatch(csp, /https:/);
  assert.equal(content.headers["access-control-allow-origin"], undefined);

  const head = await request(host.contentOrigin, path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.equal((await request(host.contentOrigin, "/preview/not-a-capability")).status, 404);
});

test("content port has no API and rejects mutations", async (t) => {
  const { host } = await launch(t, {}, initialDeck());
  const api = await request(host.contentOrigin, "/api/workspace", { token: host.token });
  assert.equal(api.status, 404);
  const mutation = await request(host.contentOrigin, "/preview/anything", {
    method: "POST",
    body: "{}",
    contentType: "application/json",
  });
  assert.equal(mutation.status, 405);
});

test("workspace selection revokes existing preview capabilities", async (t) => {
  const next = new FakeWorkspace("/tmp/slide-studio-next");
  const { host, workspace } = await launch(t, {
    selectWorkspace: async () => next,
  }, initialDeck());
  const preview = await adminRequest(host, "/api/deck/deck-1/preview", {
    method: "POST",
    json: {},
  });
  const path = new URL((preview.json as { url: string }).url).pathname;
  assert.equal((await request(host.contentOrigin, path)).status, 200);

  const selected = await adminRequest(host, "/api/workspace/select", {
    method: "POST",
    json: {},
  });
  assert.equal(selected.status, 200);
  assert.deepEqual(selected.json, { root: "/tmp/slide-studio-next", decks: [] });
  assert.equal(workspace.closed, 1);
  assert.equal((await request(host.contentOrigin, path)).status, 404);

  const cancelledHost = await launch(t, {
    selectWorkspace: async () => null,
  }, initialDeck());
  const cancelledPreview = await adminRequest(cancelledHost.host, "/api/deck/deck-1/preview", {
    method: "POST",
    json: {},
  });
  const cancelledPath = new URL((cancelledPreview.json as { url: string }).url).pathname;
  const cancelled = await adminRequest(cancelledHost.host, "/api/workspace/select", {
    method: "POST",
    json: {},
  });
  assert.deepEqual(cancelled.json, { cancelled: true });
  assert.equal((await request(cancelledHost.host.contentOrigin, cancelledPath)).status, 200);
  assert.equal(cancelledHost.workspace.closed, 0);
});

test("keeps the same workspace service without closing it", async (t) => {
  const same = new FakeWorkspace("/tmp/slide-studio-same", initialDeck());
  const { host } = await launch(t, {
    workspace: same,
    selectWorkspace: async () => same,
  });
  const selected = await adminRequest(host, "/api/workspace/select", {
    method: "POST",
    json: {},
  });
  assert.equal(selected.status, 200);
  assert.equal(same.closed, 0);
});

test("keeps only the eight newest preview capabilities", async (t) => {
  const { host } = await launch(t, {}, initialDeck());
  const urls: string[] = [];
  for (let index = 0; index < 9; index++) {
    const preview = await adminRequest(host, "/api/deck/deck-1/preview", {
      method: "POST",
      json: {},
    });
    urls.push((preview.json as { url: string }).url);
  }
  assert.equal((await request(host.contentOrigin, new URL(urls[0] as string).pathname)).status, 404);
  assert.equal((await request(host.contentOrigin, new URL(urls[8] as string).pathname)).status, 200);
});

test("export delegates to the native callback and rejects output paths", async (t) => {
  const calls: { format: string; title: string }[] = [];
  const { host, workspace } = await launch(t, {
    exportDocument: async (_document, format, title) => {
      calls.push({ format, title });
      return `export.${format}`;
    },
  }, initialDeck());

  const bad = await adminRequest(host, "/api/deck/deck-1/export", {
    method: "POST",
    json: { format: "html", output: "/tmp/pwn.html" },
  });
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 0);

  const html = await adminRequest(host, "/api/deck/deck-1/export", {
    method: "POST",
    json: { format: "html", source: "# 新しい\n" },
  });
  assert.equal(html.status, 200);
  assert.deepEqual(html.json, { file: "export.html" });
  const pdf = await adminRequest(host, "/api/deck/deck-1/export", {
    method: "POST",
    json: { format: "pdf" },
  });
  assert.deepEqual(pdf.json, { file: "export.pdf" });
  assert.deepEqual(calls, [
    { format: "html", title: "テスト" },
    { format: "pdf", title: "テスト" },
  ]);
  assert.equal(workspace.renderCalls[0]?.source, "# 新しい\n");
});

test("rejects a callback that returns a path instead of a basename", async (t) => {
  const { host } = await launch(t, {
    exportDocument: async () => "../escape.html",
  }, initialDeck());
  const response = await adminRequest(host, "/api/deck/deck-1/export", {
    method: "POST",
    json: { format: "html" },
  });
  assert.equal(response.status, 500);
});

test("closes idempotently and calls onShutdown once", async (t) => {
  let shutdowns = 0;
  const { host, workspace } = await launch(t, {
    onShutdown: async () => {
      shutdowns += 1;
    },
  }, initialDeck());
  await host.close();
  await host.close();
  assert.equal(shutdowns, 1);
  assert.equal(workspace.closed, 0);
});

test("close waits for an in-flight save before shutdown", async (t) => {
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolveGate) => {
    releaseSave = resolveGate;
  });
  let shutdownCalled = false;
  let closeFinished = false;
  const { host, workspace } = await launch(t, {
    onShutdown: async () => {
      shutdownCalled = true;
    },
  }, initialDeck());
  workspace.saveGate = saveGate;

  const pendingSave = adminRequest(host, "/api/deck/deck-1/source", {
    method: "PUT",
    json: { source: "# 保存中\n", version: "v1" },
  });
  pendingSave.catch(() => {});
  await waitUntil(() => workspace.saveCalls.length === 1);

  const closing = host.close().then(() => {
    closeFinished = true;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(shutdownCalled, false, "onShutdown must wait for the save");
  assert.equal(closeFinished, false);

  releaseSave();
  await closing;
  assert.equal(shutdownCalled, true);

  const settled = await pendingSave.then(
    () => "fulfilled",
    () => "rejected",
  );
  assert.ok(settled === "fulfilled" || settled === "rejected");
  workspace.saveGate = undefined;
});

test("export does not block source reads and rejects a second export as BUSY", async (t) => {
  let releaseExport!: () => void;
  const exportGate = new Promise<void>((resolveGate) => {
    releaseExport = resolveGate;
  });
  let exportCalls = 0;
  const { host } = await launch(t, {
    exportDocument: async (_document, format) => {
      exportCalls += 1;
      await exportGate;
      return `export.${format}`;
    },
  }, initialDeck());

  const firstExport = adminRequest(host, "/api/deck/deck-1/export", {
    method: "POST",
    json: { format: "html" },
  });
  await waitUntil(() => exportCalls === 1);

  const source = await adminRequest(host, "/api/deck/deck-1/source");
  assert.equal(source.status, 200);

  const secondExport = await adminRequest(host, "/api/deck/deck-1/export", {
    method: "POST",
    json: { format: "html" },
  });
  assert.equal(secondExport.status, 409);
  assert.equal((secondExport.json as { error: { code: string } }).error.code, "BUSY");
  assert.equal(exportCalls, 1);

  releaseExport();
  const completed = await firstExport;
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.json, { file: "export.html" });
});

test("rejects oversized JSON bodies", async (t) => {
  const { host } = await launch(t, {}, initialDeck());
  const response = await adminRequest(host, "/api/decks", {
    method: "POST",
    body: `{"title":"${"a".repeat(2 * 1024 * 1024)}"}`,
    contentType: "application/json",
  });
  assert.equal(response.status, 413);
});
