import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { load as loadHtml } from "cheerio";
import type {
  LegacyFeatureHandler,
  LegacyRenderText,
  LegacyRendered,
} from "../../packages/contracts/src/legacy.js";
import { reset_cover_positions } from "../../apps/server/legacy-themes.js";
import { parse } from "../../packages/core/src/legacy-source.js";
import { sha256 } from "../../packages/core/src/source.js";
import { Workspace } from "../../packages/core/src/legacy-workspace.js";
import {
  startLegacyHost,
  type LegacyHost,
  type LegacyWorkspace,
} from "../../apps/server/legacy.js";

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
  if (options.token !== undefined && options.token !== null) {
    headers["x-studio-token"] = options.token;
  }
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
  const base = new URL(origin);
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest({
      hostname: base.hostname,
      port: base.port,
      path,
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
  host: LegacyHost,
  path: string,
  options: RequestOptions = {},
): Promise<ResponseValue> {
  return request(host.adminOrigin, path, {
    ...options,
    token: options.token === undefined ? host.token : options.token,
  });
}

async function createUi(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "slide-studio-legacy-ui-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "app.html"), "<!doctype html><html><head><title>UI</title></head><body>UI</body></html>\n");
  await writeFile(join(directory, "app.js"), "export const app = true;\n");
  await writeFile(join(directory, "extra.js"), "export const extra = true;\n");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(directory, "bridge")));
  await writeFile(
    join(directory, "bridge", "frame-agent.classic.js"),
    "window.__frameAgent = true;\n",
  );
  return directory;
}

async function createWorkspace(t: TestContext): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "slide-studio-legacy-ws-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return Workspace.open(root);
}

function renderedFrom(text: string): LegacyRendered {
  const html = text.includes("hostile-preview")
    ? "<script src=\"/prefix-before-html.js\"></script>"
      + "<html lang=\"en\"><script src=\"/prefix-before-head.js\"></script>"
      + "<head data-hostile=\"1\"><base href=\"https://evil.example/base/\">"
      + "<script src=\"/authored-head.js\"></script>"
      + "<body><script src=\"/authored-body.js\"></script><div id=\"stage\">hostile</div></body></html>"
    : "<!doctype html><html><head><script src=\"/authored.js\"></script></head>"
      + "<body><div id=\"stage\">preview</div></body></html>";
  return {
    html,
    slides: [{ index: 0, page: 0, id: "cover", title: "Cover", level: 1, figures: [] }],
    doc: parse(text),
    version: sha256(text),
    warnings: [],
    missing_cites: [],
    cited: [],
    unsupported: [],
    timing: {},
  };
}

interface HostFixture {
  host: LegacyHost;
  workspace: Workspace;
  uiDirectory: string;
}

async function launch(
  t: TestContext,
  overrides: {
    featureHandlers?: LegacyFeatureHandler[];
    onShutdown?: () => void | Promise<void>;
    watch?: boolean;
    keepAliveMs?: number;
    renderText?: LegacyRenderText;
    selectWorkspace?: () => LegacyWorkspace | null | Promise<LegacyWorkspace | null>;
    maxBodyBytes?: number;
    maxSourceBodyBytes?: number;
    maxUploadBodyBytes?: number;
    shutdownGraceMs?: number;
  } = {},
): Promise<HostFixture> {
  const workspace = await createWorkspace(t);
  const uiDirectory = await createUi(t);
  const host = await startLegacyHost({
    workspace,
    uiDirectory,
    pandocPath: "/bin/pandoc",
    renderText: overrides.renderText
      ?? (async (_workspace, _deck, text) => renderedFrom(text)),
    watch: overrides.watch ?? false,
    keepAliveMs: overrides.keepAliveMs,
    featureHandlers: overrides.featureHandlers,
    selectWorkspace: overrides.selectWorkspace,
    maxBodyBytes: overrides.maxBodyBytes,
    maxSourceBodyBytes: overrides.maxSourceBodyBytes,
    maxUploadBodyBytes: overrides.maxUploadBodyBytes,
    shutdownGraceMs: overrides.shutdownGraceMs,
    onShutdown: overrides.onShutdown,
  });
  t.after(async () => host.close());
  return { host, workspace, uiDirectory };
}

function sseConnect(host: LegacyHost): Promise<{
  chunks: () => string;
  ended: Promise<void>;
  destroy: () => void;
}> {
  const base = new URL(host.adminOrigin);
  return new Promise((resolveConnect, reject) => {
    const req = httpRequest({
      hostname: base.hostname,
      port: base.port,
      path: "/api/events",
      headers: { "x-studio-token": host.token },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      const ended = new Promise<void>((resolveEnd) => {
        res.on("end", () => resolveEnd());
        res.on("close", () => resolveEnd());
      });
      resolveConnect({
        chunks: () => text,
        ended,
        destroy: () => {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("condition did not become true");
}

test("requires the token and keeps content separate from admin", async (t) => {
  const { host, uiDirectory } = await launch(t);

  assert.equal((await adminRequest(host, "/api/home", { token: null })).status, 401);
  assert.equal((await adminRequest(host, "/api/home", { token: "wrong" })).status, 401);

  const shell = await adminRequest(host, "/");
  assert.equal(shell.status, 200);
  assert.match(shell.text, /<title>UI<\/title>/);

  assert.equal((await adminRequest(host, "/web/app.js")).status, 200);
  assert.equal((await adminRequest(host, "/web/extra.js")).status, 404);
  assert.equal((await adminRequest(host, "/files/anything")).status, 404);
  assert.equal((await request(host.contentOrigin, "/api/home", { token: host.token })).status, 404);
  assert.equal((await request(host.contentOrigin, "/web/app.js")).status, 404);
  assert.equal((await request(host.contentOrigin, "/bridge/frame-agent.classic.js")).status, 200);

  const badHost = await request(host.adminOrigin, "/api/home", {
    token: host.token,
    headers: { host: "evil.example" },
  });
  assert.equal(badHost.status, 403);
  const localhost = await request(host.adminOrigin, "/api/home", {
    token: host.token,
    headers: { host: `localhost:${new URL(host.adminOrigin).port}` },
  });
  assert.equal(localhost.status, 403);

  const noOrigin = await adminRequest(host, "/api/new", {
    method: "POST",
    origin: null,
    json: { name: "x", shelf: "t" },
  });
  assert.equal(noOrigin.status, 403);
  const foreignOrigin = await adminRequest(host, "/api/new", {
    method: "POST",
    origin: "http://evil.example",
    json: { name: "x", shelf: "t" },
  });
  assert.equal(foreignOrigin.status, 403);
  const notJson = await adminRequest(host, "/api/new", {
    method: "POST",
    body: "name=x",
    contentType: "text/plain",
  });
  assert.equal(notJson.status, 400);

  assert.match(shell.headers["content-security-policy"] as string, /frame-src http:\/\/127\.0\.0\.1:\d+/);
  const adminCsp = String(shell.headers["content-security-policy"]);
  assert.ok(adminCsp.includes(`img-src 'self' ${host.contentOrigin} data: blob:`));
  assert.ok(adminCsp.includes(`media-src 'self' ${host.contentOrigin} data: blob:`));
  assert.ok(adminCsp.includes(`font-src 'self' ${host.contentOrigin} data:`));
  assert.equal(adminCsp.includes("img-src *"), false);
  assert.equal(adminCsp.includes("media-src *"), false);
  assert.equal(adminCsp.includes("connect-src *"), false);
  assert.equal(uiDirectory.length > 0, true);
});

test("reads normalized source, previews on the content origin, and preserves CRLF/BOM", async (t) => {
  const { host, workspace } = await launch(t);
  workspace.new_deck("deck-1", "topic", "default", null, "Test");
  const path = workspace.qmd("deck-1");
  const original = Buffer.from("\uFEFF---\r\ntitle: Test\r\n---\r\n\r\n## Slide\r\n\r\nbody\r\n", "utf8");
  await writeFile(path, original);

  const read = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(read.status, 200);
  const readBody = read.json as {
    text: string;
    version: string;
    render: { ok: boolean; version: string };
    structure: { pages: unknown[] };
    blank: boolean;
    root: string;
  };
  assert.equal(readBody.text.includes("\r"), false);
  assert.equal(readBody.text.startsWith("\uFEFF"), false);
  assert.equal(readBody.version, sha256(original));
  assert.equal(readBody.render.ok, true);
  assert.equal(readBody.render.version, readBody.version);
  assert.ok(Array.isArray(readBody.structure.pages));
  assert.equal(readBody.root, workspace.root);

  const preview = await adminRequest(host, "/api/deck/deck-1/preview", {
    method: "POST",
    json: { version: readBody.version, mode: "edit", generation: "gen-1" },
  });
  assert.equal(preview.status, 200);
  const previewBody = preview.json as { url: string; origin: string; version: string };
  assert.equal(previewBody.origin, host.contentOrigin);
  assert.equal(previewBody.version, readBody.version);
  const previewUrl = new URL(previewBody.url);
  assert.equal(previewUrl.origin, host.contentOrigin);
  assert.equal(previewUrl.pathname, "/files/decks/deck-1/__slide-studio_preview__.html");
  assert.match(previewUrl.searchParams.get("c") ?? "", /^[A-Za-z0-9_-]+$/);

  const content = await request(
    host.contentOrigin,
    `${previewUrl.pathname}${previewUrl.search}`,
  );
  assert.equal(content.status, 200);
  assert.equal(content.headers["access-control-allow-origin"], undefined);
  assert.equal(content.headers["cache-control"], "no-store");
  const csp = String(content.headers["content-security-policy"]);
  assert.match(csp, /sandbox allow-scripts allow-same-origin/);
  assert.match(csp, new RegExp(`frame-ancestors 'self' ${host.adminOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(csp.includes("connect-src 'self'"));
  assert.equal(csp.includes("connect-src 'none'"), false);
  assert.equal(csp.includes("connect-src *"), false);
  assert.equal(csp.includes("allow-popups"), false);
  assert.equal(csp.includes("allow-top-navigation"), false);
  assert.equal(content.text.includes(host.token), false);
  const bridge = content.text.indexOf("bridge/frame-agent.classic.js");
  const authored = content.text.indexOf("/authored.js");
  assert.ok(bridge >= 0 && authored > bridge);
  assert.match(content.text, new RegExp(`data-studio-admin-origin="${host.adminOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(content.text, /data-studio-deck="deck-1"/);
  assert.match(content.text, /data-studio-generation="gen-1"/);
  assert.match(content.text, /__slideStudioNoHash=true/);
  assert.match(content.text, /__slideStudioFill=true/);
  assert.match(content.text, /__slideStudioNoOverview=true/);

  const newText = "---\ntitle: Test\n---\n\n## Slide\n\nchanged\n";
  const saved = await adminRequest(host, "/api/deck/deck-1/source", {
    method: "PUT",
    json: { text: newText, base: readBody.version },
  });
  assert.equal(saved.status, 200);
  const savedBody = saved.json as { version: string };
  const stored = await import("node:fs/promises").then(({ readFile }) => readFile(path));
  assert.equal(stored[0], 0xef);
  assert.equal(stored[1], 0xbb);
  assert.equal(stored[2], 0xbf);
  assert.ok(stored.toString("utf8").includes("\r\n"));
  assert.equal(savedBody.version, sha256(stored));

  const stale = await adminRequest(host, "/api/deck/deck-1/source", {
    method: "PUT",
    json: { text: "stale", base: readBody.version },
  });
  assert.equal(stale.status, 409);
  assert.equal((stale.json as { error: string }).error, "外で変更されました");

  workspace.new_deck("deck-hostile", "topic", "default", null, "Hostile");
  await writeFile(
    workspace.qmd("deck-hostile"),
    "---\ntitle: Hostile\n---\n\nhostile-preview\n",
  );
  const badGeneration = await adminRequest(host, "/api/deck/deck-hostile/preview", {
    method: "POST",
    json: { mode: "edit", generation: "gen\"</script><script id=\"breakout\">" },
  });
  assert.equal(badGeneration.status, 400);

  const hostilePreview = await adminRequest(host, "/api/deck/deck-hostile/preview", {
    method: "POST",
    json: { mode: "edit", generation: "gen-hostile" },
  });
  assert.equal(hostilePreview.status, 200);
  const hostileUrl = new URL((hostilePreview.json as { url: string }).url);
  const hostile = await request(
    host.contentOrigin,
    `${hostileUrl.pathname}${hostileUrl.search}`,
  );
  assert.equal(hostile.status, 200);

  const $ = loadHtml(hostile.text);
  const scripts = $("script");
  const firstScript = scripts.first();
  assert.match(firstScript.attr("src") ?? "", /\/bridge\/frame-agent\.classic\.js$/);
  assert.equal(firstScript.attr("data-studio-admin-origin"), host.adminOrigin);
  assert.equal(firstScript.attr("data-studio-deck"), "deck-hostile");
  assert.equal(firstScript.attr("data-studio-generation"), "gen-hostile");
  assert.equal($("#breakout").length, 0);
  // The host no longer removes or injects <base>; the authored base survives.
  assert.equal($("base").length, 1);
  assert.equal($("base").attr("href"), "https://evil.example/base/");
  assert.equal(
    scripts.eq(1).attr("src"),
    undefined,
    "the inline flags script is second",
  );
  assert.match(scripts.eq(1).text(), /__slideStudioNoHash=true/);

  const scriptSources = scripts
    .map((_, element) => $(element).attr("src"))
    .get()
    .filter((src): src is string => typeof src === "string");
  assert.match(scriptSources[0] ?? "", /\/bridge\/frame-agent\.classic\.js$/);
  for (const authored of [
    "/prefix-before-html.js",
    "/prefix-before-head.js",
    "/authored-head.js",
    "/authored-body.js",
  ]) {
    assert.ok(scriptSources.indexOf(authored) > 0, `${authored} must follow the bootstrap`);
  }
});

test("dispatches feature routes before the generic POST action and never fakes success", async (t) => {
  const calls: string[] = [];
  const handler: LegacyFeatureHandler = async (req) => {
    calls.push(`${req.method} ${req.pathname}`);
    if (req.pathname !== "/api/deck/deck-1/assets") return null;
    return { status: 200, body: { url: "/files/deck.png", seen: req.body } };
  };
  const { host, workspace } = await launch(t, { featureHandlers: [handler] });
  workspace.new_deck("deck-1", "topic");

  const handled = await adminRequest(host, "/api/deck/deck-1/assets", {
    method: "POST",
    json: { op: "list" },
  });
  assert.equal(handled.status, 200);
  const body = handled.json as { url: string; seen: unknown };
  assert.equal(body.url, `${host.contentOrigin}/files/deck.png`);
  assert.deepEqual(body.seen, { op: "list" });
  assert.deepEqual(calls, ["POST /api/deck/deck-1/assets"]);

  const pending = await adminRequest(host, "/api/deck/deck-1/materials", {
    method: "GET",
  });
  assert.equal(pending.status, 501);
  const pendingBody = pending.json as { feature: string; code: string; pending: boolean };
  assert.equal(pendingBody.feature, "materials");
  assert.equal(pendingBody.code, "NOT_IMPLEMENTED");
  assert.equal(pendingBody.pending, true);

  const unknownAction = await adminRequest(host, "/api/deck/deck-1/anything", {
    method: "POST",
    json: {},
  });
  assert.equal(unknownAction.status, 404);
  assert.equal((unknownAction.json as { error: string }).error, "操作が正しくありません");

  const check = await adminRequest(host, "/api/deck/deck-1/check", {
    method: "POST",
    json: {},
  });
  assert.equal(check.status, 501);
  assert.equal((check.json as { feature: string }).feature, "check");
  assert.equal(host.handoff.status, "in_progress");
  assert.ok(host.pending.includes("assets"));
  assert.ok(host.pending.includes("ai"));
});

test("streams authenticated SSE and closes the stream on shutdown", async (t) => {
  const { host, workspace } = await launch(t, { keepAliveMs: 20 });
  workspace.new_deck("deck-1", "topic");

  const stream = await sseConnect(host);
  await waitUntil(() => stream.chunks().includes("retry: 1000"));
  assert.match(stream.chunks(), /retry: 1000\n\n/);

  await adminRequest(host, "/api/deck/deck-1");
  await waitUntil(() => stream.chunks().includes("\"type\":\"render\""));
  assert.match(stream.chunks(), /"type":"render"/);

  await Promise.race([
    host.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 3_000)),
  ]);
  await Promise.race([
    stream.ended,
    new Promise((_, reject) => setTimeout(() => reject(new Error("SSE did not end")), 3_000)),
  ]);
  stream.destroy();
});

test("close drains accepted writes before listeners and onShutdown", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let started = false;
  let shutdowns = 0;
  const handler: LegacyFeatureHandler = async (req) => {
    if (req.pathname !== "/api/math") return null;
    started = true;
    await gate;
    return { status: 200, body: { ok: true } };
  };
  const { host } = await launch(t, {
    featureHandlers: [handler],
    onShutdown: () => {
      shutdowns += 1;
    },
  });

  const pending = adminRequest(host, "/api/math", { method: "POST", json: { tex: "x" } });
  pending.catch(() => undefined);
  await waitUntil(() => started);

  let closeFinished = false;
  const closing = host.close().then(() => {
    closeFinished = true;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.equal(closeFinished, false);
  assert.equal(shutdowns, 0);

  release();
  const response = await pending;
  assert.equal(response.status, 200);
  await closing;
  assert.equal(shutdowns, 1);
  assert.equal(host.handoff.status, "in_progress");
});

test("memo and style keep the legacy conflict fields", async (t) => {
  const { host, workspace } = await launch(t);
  workspace.new_deck("deck-1", "topic");
  await import("node:fs/promises")
    .then(({ unlink }) => unlink(workspace.memo("deck-1")))
    .catch(() => undefined);

  const memoRead = await adminRequest(host, "/api/deck/deck-1/memo");
  assert.equal(memoRead.status, 200);
  const memoBody = memoRead.json as {
    text: string;
    version: string;
    exists: boolean;
    locked: boolean;
    slides_body: string;
  };
  assert.equal(memoBody.text, "");
  assert.equal(memoBody.exists, false);
  assert.equal(memoBody.locked, false);
  assert.equal(typeof memoBody.slides_body, "string");

  const memoWrite = await adminRequest(host, "/api/deck/deck-1/memo", {
    method: "PUT",
    json: { text: "# 案\n", base: memoBody.version },
  });
  assert.equal(memoWrite.status, 200);
  const staleMemo = await adminRequest(host, "/api/deck/deck-1/memo", {
    method: "PUT",
    json: { text: "x", base: memoBody.version },
  });
  assert.equal(staleMemo.status, 409);
  assert.equal((staleMemo.json as { text: string }).text, "# 案\n");

  const before = await import("node:fs/promises").then(({ readFile }) => readFile(workspace.qmd("deck-1"), "utf8"));
  const styled = await adminRequest(host, "/api/deck/deck-1/style", {
    method: "PUT",
    json: {
      vars: { "--img-pad": "12px" },
      text: `${before}\n`,
      base: sha256(before),
    },
  });
  assert.equal(styled.status, 200);
  const styleBody = styled.json as { version: string; vars: Record<string, string> };
  assert.equal(styleBody.vars["--img-pad"], "12px");
  const css = await import("node:fs/promises").then(({ readFile }) =>
    readFile(join(workspace.deck_dir("deck-1"), "styles", "slides.css"), "utf8"));
  assert.match(css, /Slide Studio の余白/);
  assert.match(css, /--img-pad:12px/);

  const conflict = await adminRequest(host, "/api/deck/deck-1/style", {
    method: "PUT",
    json: { css: "x", css_base: "different" },
  });
  assert.equal(conflict.status, 409);
  assert.equal((conflict.json as { error: string }).error, "外で変更されました");
});

test("restricts public files to asset scopes and streams byte ranges", async (t) => {
  const { host, workspace } = await launch(t);
  workspace.new_deck("deck-1", "topic");
  const deckDir = workspace.deck_dir("deck-1");
  await mkdir(join(deckDir, "styles"), { recursive: true });
  await writeFile(join(deckDir, "styles", "slides.css"), "body{}");
  await writeFile(join(deckDir, "memo.md"), "private memo");

  const stateDir = join(workspace.root, ".slide-studio");
  await mkdir(join(stateDir, "runtime"), { recursive: true });
  await mkdir(join(stateDir, "history"), { recursive: true });
  await mkdir(join(stateDir, "shots", "deck-1"), { recursive: true });
  await writeFile(join(stateDir, "runtime", "base.css"), "runtime");
  await writeFile(join(stateDir, "history", "secret.txt"), "secret");
  await writeFile(join(stateDir, "shots", "deck-1", "cover.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  await mkdir(workspace.themes, { recursive: true });
  await writeFile(join(workspace.themes, "default.css"), "theme");
  await mkdir(join(workspace.root, "topics", "shelf", "images"), { recursive: true });
  await writeFile(join(workspace.root, "topics", "shelf", "images", "figure.png"), "figure");

  // A symlink inside an allowed scope must not expose private state.
  await symlink(
    join(stateDir, "history"),
    join(deckDir, "leak"),
    "dir",
  );

  for (const path of [
    "/files/.slide-studio/history/secret.txt",
    "/files/.git/config",
    "/files/decks/deck-1/.slides.qmd.tmp",
    "/files/decks/deck-1/memo.md",
    "/files/decks/deck-1/leak/secret.txt",
    "/files/.slide-studio/shots/deck-1/cover.png",
  ]) {
    assert.equal((await request(host.contentOrigin, path)).status, 404, path);
  }

  assert.equal((await request(host.contentOrigin, "/files/.slide-studio/runtime/base.css")).status, 200);
  assert.equal((await request(host.contentOrigin, "/files/decks/deck-1/styles/slides.css")).status, 200);
  assert.equal((await request(host.contentOrigin, "/files/themes/default.css")).status, 200);
  assert.equal((await request(host.contentOrigin, "/files/topics/shelf/images/figure.png")).status, 200);

  const shot = await request(host.contentOrigin, "/shots/deck-1/cover.png");
  assert.equal(shot.status, 200);
  assert.equal(shot.headers["content-type"], "image/png");

  const ranged = await request(host.contentOrigin, "/files/decks/deck-1/styles/slides.css", {
    headers: { range: "bytes=1-3" },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.text, "ody");
  assert.equal(ranged.headers["content-range"], "bytes 1-3/6");
  assert.equal(ranged.headers["accept-ranges"], "bytes");
});

test("refuses a workspace switch while another request or render is in flight", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let started = false;
  let selections = 0;
  const handler: LegacyFeatureHandler = async (req) => {
    if (req.pathname !== "/api/math") return null;
    started = true;
    await gate;
    return { status: 200, body: { ok: true } };
  };
  const { host } = await launch(t, {
    featureHandlers: [handler],
    selectWorkspace: () => {
      selections += 1;
      return null;
    },
  });

  const pending = adminRequest(host, "/api/math", { method: "POST", json: { tex: "x" } });
  pending.catch(() => undefined);
  await waitUntil(() => started);

  const select = await adminRequest(host, "/api/workspace/select", {
    method: "POST",
    json: {},
  });
  assert.equal(select.status, 409);
  assert.equal(selections, 0);

  release();
  assert.equal((await pending).status, 200);
});

test("serializes source writes and preserves CRLF/BOM through style saves", async (t) => {
  const { host, workspace } = await launch(t);
  workspace.new_deck("deck-1", "topic");
  const path = workspace.qmd("deck-1");
  const original = Buffer.from("\uFEFF---\r\ntitle: Test\r\n---\r\n\r\n## Slide\r\n\r\nbody\r\n", "utf8");
  await writeFile(path, original);

  const read = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(read.status, 200);
  const version = (read.json as { version: string }).version;

  const one = "---\ntitle: Test\n---\n\n## Slide\n\none\n";
  const two = "---\ntitle: Test\n---\n\n## Slide\n\ntwo\n";
  const [left, right] = await Promise.all([
    adminRequest(host, "/api/deck/deck-1/source", {
      method: "PUT",
      json: { text: one, base: version },
    }),
    adminRequest(host, "/api/deck/deck-1/source", {
      method: "PUT",
      json: { text: two, base: version },
    }),
  ]);
  assert.deepEqual([left.status, right.status].sort((a, b) => a - b), [200, 409]);

  const currentResponse = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(currentResponse.status, 200);
  const current = currentResponse.json as { text: string; version: string };
  const styled = await adminRequest(host, "/api/deck/deck-1/style", {
    method: "PUT",
    json: {
      vars: { "--img-pad": "12px" },
      text: `${current.text}\n`,
      base: current.version,
    },
  });
  assert.equal(styled.status, 200);
  const styledBody = styled.json as { version: string };
  const stored = await readFile(path);
  assert.equal(stored[0], 0xef);
  assert.equal(stored[1], 0xbb);
  assert.equal(stored[2], 0xbf);
  assert.ok(stored.toString("utf8").includes("\r\n"));
  assert.equal(styledBody.version, sha256(stored));

  const after = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(after.status, 200);
  assert.equal((after.json as { version: string }).version, styledBody.version);
});

test("rejects invalid UTF-8 memo content without overwriting bytes", async (t) => {
  const { host, workspace } = await launch(t);
  workspace.new_deck("deck-1", "topic");
  const path = workspace.memo("deck-1");
  const original = Buffer.from([0x82, 0xa0]);
  await writeFile(path, original);

  const read = await adminRequest(host, "/api/deck/deck-1/memo");
  assert.equal(read.status, 422);

  const write = await adminRequest(host, "/api/deck/deck-1/memo", {
    method: "PUT",
    json: { text: "replacement", base: sha256("") },
  });
  assert.equal(write.status, 422);
  assert.deepEqual(await readFile(path), original);
});

test("rewrites only URL fields and sandboxes active feature bytes", async (t) => {
  let seenHeaders: Record<string, string | undefined> = {};
  const handler: LegacyFeatureHandler = async (req) => {
    if (req.pathname === "/api/deck/deck-1/assets") {
      return {
        status: 200,
        body: {
          title: "/files/not-a-url",
          url: "/files/y.png",
          thumb: "/files/t.png",
          shots: ["/files/s.png"],
        },
      };
    }
    if (req.pathname === "/api/deck/deck-1/assets/active") {
      seenHeaders = req.headers;
      return {
        status: 200,
        bytes: Buffer.from("<script>alert(1)</script>"),
        headers: { "content-type": "text/html", "set-cookie": "a=b" },
      };
    }
    return null;
  };
  const { host } = await launch(t, { featureHandlers: [handler] });

  const bodyResult = await adminRequest(host, "/api/deck/deck-1/assets", {
    method: "POST",
    json: { op: "list" },
  });
  assert.equal(bodyResult.status, 200);
  const body = bodyResult.json as {
    title: string;
    url: string;
    thumb: string;
    shots: string[];
  };
  assert.equal(body.title, "/files/not-a-url");
  assert.equal(body.url, `${host.contentOrigin}/files/y.png`);
  assert.equal(body.thumb, `${host.contentOrigin}/files/t.png`);
  assert.deepEqual(body.shots, [`${host.contentOrigin}/files/s.png`]);

  const bytesResult = await adminRequest(host, "/api/deck/deck-1/assets/active", {
    method: "POST",
    json: {},
    headers: { cookie: "secret=1" },
  });
  assert.equal(bytesResult.status, 200);
  assert.equal(bytesResult.headers["content-security-policy"], "sandbox; default-src 'none'");
  assert.equal(bytesResult.headers["content-disposition"], "attachment");
  assert.equal(bytesResult.headers["set-cookie"], undefined);
  assert.equal(seenHeaders.cookie, undefined);
  assert.equal(seenHeaders["x-studio-token"], undefined);
});

test("a synchronous renderer throw does not leak render queue slots", async (t) => {
  const renderText: LegacyRenderText = (_workspace, _deck, text) => {
    if (text.includes("boom")) throw new Error("boom");
    return Promise.resolve(renderedFrom(text));
  };
  const { host, workspace } = await launch(t, { renderText });
  workspace.new_deck("deck-1", "topic");
  await writeFile(workspace.qmd("deck-1"), "---\ntitle: Test\n---\n\nboom\n");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const failed = await adminRequest(host, "/api/deck/deck-1");
    assert.equal(failed.status, 200);
    assert.equal((failed.json as { render: { ok: boolean } }).render.ok, false);
  }

  await writeFile(workspace.qmd("deck-1"), "---\ntitle: Test\n---\n\nrecovered\n");
  const recovered = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(recovered.status, 200);
  assert.equal((recovered.json as { render: { ok: boolean } }).render.ok, true);
});

test("edit preview keeps the last good render while present mode fails", async (t) => {
  const renderText: LegacyRenderText = (_workspace, _deck, text) => {
    if (text.includes("broken")) throw new Error("broken source");
    return Promise.resolve(renderedFrom(text));
  };
  const { host, workspace } = await launch(t, { renderText });
  workspace.new_deck("deck-1", "topic");
  await writeFile(workspace.qmd("deck-1"), "---\ntitle: Test\n---\n\nfirst\n");

  const first = await adminRequest(host, "/api/deck/deck-1/preview", {
    method: "POST",
    json: { mode: "edit", generation: "gen-1" },
  });
  assert.equal(first.status, 200);
  const firstBody = first.json as { url: string; version: string };

  await writeFile(workspace.qmd("deck-1"), "---\ntitle: Test\n---\n\nbroken\n");

  const edit = await adminRequest(host, "/api/deck/deck-1/preview", {
    method: "POST",
    json: { mode: "edit", generation: "gen-2" },
  });
  assert.equal(edit.status, 200);
  assert.equal((edit.json as { version: string }).version, firstBody.version);

  const present = await adminRequest(host, "/api/deck/deck-1/preview", {
    method: "POST",
    json: { mode: "present", generation: "gen-3" },
  });
  assert.equal(present.status, 500);
});

test("accepts large uploads and a larger source PUT than the JSON limit", async (t) => {
  const handler: LegacyFeatureHandler = async (req) => {
    if (req.pathname !== "/api/deck/deck-1/assets") return null;
    return { status: 200, body: { received: req.bytes.byteLength } };
  };
  const { host, workspace } = await launch(t, {
    featureHandlers: [handler],
    maxBodyBytes: 1024,
  });
  workspace.new_deck("deck-1", "topic");

  const upload = await adminRequest(host, "/api/deck/deck-1/assets", {
    method: "POST",
    json: { data: "x".repeat(5 * 1024 * 1024) },
  });
  assert.equal(upload.status, 200);
  assert.ok((upload.json as { received: number }).received > 5 * 1024 * 1024);

  workspace.new_deck("big-deck", "topic");
  const version = sha256(await readFile(workspace.qmd("big-deck")));
  const saved = await adminRequest(host, "/api/deck/big-deck/source", {
    method: "PUT",
    json: {
      text: `---\ntitle: Big\n---\n\n${"y".repeat(3 * 1024 * 1024)}`,
      base: version,
    },
  });
  assert.equal(saved.status, 200);
});

test("matches legacy route precedence for wrong methods", async (t) => {
  const calls: string[] = [];
  const handler: LegacyFeatureHandler = async (req) => {
    calls.push(`${req.method} ${req.pathname}`);
    if (req.pathname !== "/api/deck/deck-1/assets") return null;
    return { status: 200, body: { ok: true } };
  };
  const { host, workspace } = await launch(t, { featureHandlers: [handler] });
  workspace.new_deck("deck-1", "topic");

  const sourcePost = await adminRequest(host, "/api/deck/deck-1/source", {
    method: "POST",
    json: {},
  });
  assert.equal(sourcePost.status, 404);
  assert.equal((sourcePost.json as { error: string }).error, "操作が正しくありません");

  const topicPost = await adminRequest(host, "/api/topic/shelf", {
    method: "POST",
    json: {},
  });
  assert.equal(topicPost.status, 405);

  const head = await adminRequest(host, "/api/deck/deck-1/assets", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.deepEqual(calls, ["HEAD /api/deck/deck-1/assets"]);
});

test('theme API preserves original create, edit, conflict, undo, select and delete operations', async t => {
  const {host, workspace} = await launch(t);
  const listing = await adminRequest(host, '/api/themes');
  assert.equal(listing.status, 200);
  const listed = listing.json as {themes: Array<{name:string;version:string}>;fonts:unknown[]};
  assert.ok(listed.fonts.length > 0);
  const original = listed.themes.find(theme=>theme.name==='default')!;
  assert.ok(original.version);
  const created = await adminRequest(host, '/api/themes', {method:'POST',json:{name:'custom',from:'default',base:original.version}});
  assert.equal(created.status,201);
  const before = created.json as {version:string};
  const edited = await adminRequest(host, '/api/themes/custom', {method:'PUT',json:{base:before.version,vars:{'--ink':'#123456'}}});
  assert.equal(edited.status,200);
  const updated = edited.json as {version:string;css:string;before:string;vars:Record<string,string>};
  assert.equal(updated.vars['--ink'],'#123456');
  assert.equal(await readFile(join(workspace.themes,'custom.css'),'utf8'),updated.css);
  const conflict = await adminRequest(host, '/api/themes/custom', {method:'PUT',json:{base:before.version,vars:{'--ink':'#abcdef'}}});
  assert.equal(conflict.status,409);
  const undo = await adminRequest(host, '/api/themes/custom', {method:'PUT',json:{base:updated.version,css:updated.before}});
  assert.equal(undo.status,200);
  assert.equal((undo.json as {version:string}).version,before.version);
  const selected = await adminRequest(host, '/api/themes/select', {method:'POST',json:{theme:'custom',text:'---\ntheme: default\n---\n\n# Hello\n'}});
  assert.equal(selected.status,200);
  assert.match((selected.json as {text:string}).text,/theme: custom/);
  assert.deepEqual(workspace.prefs().recent_themes,['custom']);
  const removed = await adminRequest(host, '/api/themes/custom', {method:'DELETE'});
  assert.equal(removed.status,200);
  assert.equal(workspace.themes_list().includes('custom'),false);
  assert.equal((await adminRequest(host,'/api/themes/default',{method:'DELETE'})).status,400);
});

test('serves the complete original UI import graph and editing stylesheet', async t => {
  const workspace = await createWorkspace(t);
  const host = await startLegacyHost({workspace, uiDirectory:join(process.cwd(),'dist/packages/web'),pandocPath:'/bin/pandoc',watch:false,renderText:async (_ws,_deck,text)=>renderedFrom(text)});
  t.after(()=>host.close());
  const pending = ['/web/app.js','/web/location.js'];
  const visited = new Set<string>();
  while(pending.length) {
    const path = pending.pop()!;
    if(visited.has(path)) continue;
    visited.add(path);
    const result = await adminRequest(host,path);
    assert.equal(result.status,200,`UI module must be served: ${path}`);
    for(const match of result.text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.\.?\/[^"']+)["']/gu)) {
      pending.push(new URL(match[1]!,`${host.adminOrigin}${path}`).pathname);
    }
  }
  assert.ok(visited.has('/web/present.js'));
  assert.ok(visited.has('/web/bridge/agent-client.js'));
  const css = await request(host.contentOrigin,'/bridge/edit.css');
  assert.equal(css.status,200);
  assert.match(String(css.headers['content-type']),/text\/css/);
  assert.ok(css.text.length>100);
});


test('theme switching resets positions while preserving author metadata and Unicode offsets', () => {
  const source = '---\ntitle: 日本語🎤\ncover-authors-layout: {"x": 10, "y": 20, "labels": ["a,b", "name\\\":value", "日本語"], "align": "left"}\n---\n\n## Title {.cover}\n\n::: {.cover-title style="left:10px;top:20px;color:red"}\nTitle\n:::\n';
  const changed = reset_cover_positions(source);
  const layout = parse(changed).meta['cover-authors-layout'];
  assert.deepEqual(layout,{labels:['a,b','name":value','日本語'],align:'left'});
  assert.match(changed,/style="color:red"/);
  assert.match(changed,/title: 日本語🎤/);
  assert.equal(reset_cover_positions(changed),changed);
});
