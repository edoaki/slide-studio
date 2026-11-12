import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

const E2E = process.env.SLIDE_STUDIO_BRIDGE_E2E === "1";
const TEST_TIMEOUT_MS = 120_000;
const WAIT_TIMEOUT_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 20_000;

interface CreatedClient {
  generation: string;
  nonce: string;
  frameNonce: string;
  src: string;
}

interface BridgeStatus {
  status: "pending" | "ready" | "rejected";
  error: { code: string; message: string } | null;
  identity: { deck: string; version: string; generation: string };
  destroyed: boolean;
  portNull: boolean;
  pending: { status: string; code?: string; message?: string } | null;
}

interface Snapshot {
  deck: string;
  version: string;
  generation: string;
  index: number;
  step: number;
  maxStep: number;
  background: string;
  scale: number;
  stageAt?: number;
  sourceVersion?: string;
  slides: Array<{
    index: number;
    page: number | null;
    id: string;
    title: string;
    chapter: boolean;
    group: string;
    sectionStart: boolean;
    maxStep: number;
    pdfMarks: number[];
  }>;
}

interface FixtureMessage {
  type: string;
  fixtureGeneration: string;
  origin?: string;
  label?: string;
  authoredHash?: string;
  authoredHref?: string;
  adminDom?: string;
  nodeAccess?: string;
  themeHref?: string;
  themeCount?: number;
  studioVersion?: string;
  noHash?: boolean;
  filter?: number[] | null;
  index?: number;
  step?: number;
  url?: string;
  data?: unknown;
  [key: string]: unknown;
}

interface BridgeEvent {
  generation: string;
  name: string;
  data: Record<string, unknown>;
}

interface BridgeFailure {
  generation: string;
  code: string;
  message: string;
}

interface StaleResponse extends Record<string, unknown> {
  ok: boolean;
  id: number;
  generation: string;
  error?: { code: string; message: string };
}

interface EditRect { left: number; top: number; right: number; bottom: number }
interface EditLayout {
  sourceVersion: string;
  sequence: number;
  scale: number;
  blocks: Array<{ key: string; rects: EditRect[]; align: "left" | "center" | "right" }>;
  selection: EditRect | null;
}
interface EditIntent extends Record<string, unknown> {
  sourceVersion: string;
  sequence: number;
  kind: string;
  key?: string | null;
  trusted?: boolean;
  type?: string;
  code?: string;
  mods?: { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean };
}

function repoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    // Do not stop at dist/: it contains copied product assets but not the
    // source fixtures or package.json. Both markers identify the checkout root.
    if (existsSync(join(current, "package.json"))
      && existsSync(join(current, "packages/web/bridge/agent-client.js"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("cannot locate the repository root");
    current = parent;
  }
}

function fixturePath(name: string): string {
  return join(repoRoot(), "tests/bridge/fixtures", name);
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function contentSecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
}

function startServer(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      contentSecurityHeaders(response);
      handler(request, response).catch(error => {
        if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", String(error));
        else response.destroy();
      });
    });
    const failed = (error: Error) => {
      server.off("error", failed);
      try { server.close(); } catch { /* already closed */ }
      reject(error);
    };
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", failed);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback server did not expose a TCP port"));
        return;
      }
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function fillDeck(template: string, adminOrigin: string, contentOrigin: string, generation: string): string {
  return template
    .replaceAll("__ADMIN_ORIGIN__", adminOrigin)
    .replaceAll("__CONTENT_ORIGIN__", contentOrigin)
    .replaceAll("__GENERATION__", generation)
    .replaceAll("__ADMIN_ORIGIN_JSON__", JSON.stringify(adminOrigin))
    .replaceAll("__GENERATION_JSON__", JSON.stringify(generation));
}

async function startServers(): Promise<{
  admin: Server;
  content: Server;
  adminOrigin: string;
  contentOrigin: string;
  externalCalls: { count: number; urls: string[] };
}> {
  const root = repoRoot();
  const fixtures = join(root, "tests/bridge/fixtures");
  const [
    adminHtml, harnessSource, protocolSource, agentClientSource, deckTemplate,
    selectionDeckTemplate, forgedTemplate, apiSource, externalLinksSource, stringsSource,
  ] = await Promise.all([
    readFile(join(fixtures, "admin.html"), "utf8"),
    readFile(join(fixtures, "admin-harness.js"), "utf8"),
    readFile(join(root, "packages/web/bridge/protocol.js"), "utf8"),
    readFile(join(root, "packages/web/bridge/agent-client.js"), "utf8"),
    readFile(join(fixtures, "deck.html"), "utf8"),
    readFile(join(fixtures, "selection-deck.html"), "utf8"),
    readFile(join(fixtures, "forged-hello.html"), "utf8"),
    readFile(join(root, "packages/web/api.js"), "utf8"),
    readFile(join(root, "packages/web/external-links.js"), "utf8"),
    readFile(join(root, "packages/web/strings.js"), "utf8"),
  ]);
  const externalCalls = { count: 0, urls: [] as string[] };
  const agentBundlePath = join(root, "dist/packages/web/bridge/frame-agent.classic.js");
  let agentBundle: string;
  try {
    agentBundle = await readFile(agentBundlePath, "utf8");
  } catch (error) {
    throw new Error(`classic frame-agent bundle is missing; build it first at ${agentBundlePath}: ${String(error)}`);
  }

  let adminOrigin = "";
  let contentOrigin = "";
  let adminServer: { server: Server; origin: string } | undefined;
  let contentServer: { server: Server; origin: string } | undefined;

  try {
    adminServer = await startServer(async (request, response) => {
      const url = new URL(request.url || "/", adminOrigin || "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname === "/admin.html") {
        send(response, 200, "text/html; charset=utf-8", adminHtml);
        return;
      }
      if (url.pathname === "/harness.js") {
        send(response, 200, "text/javascript; charset=utf-8", harnessSource);
        return;
      }
      if (url.pathname === "/bridge/protocol.js") {
        send(response, 200, "text/javascript; charset=utf-8", protocolSource);
        return;
      }
      if (url.pathname === "/bridge/agent-client.js") {
        send(response, 200, "text/javascript; charset=utf-8", agentClientSource);
        return;
      }
      if (url.pathname === "/api.js") {
        send(response, 200, "text/javascript; charset=utf-8", apiSource);
        return;
      }
      if (url.pathname === "/external-links.js") {
        send(response, 200, "text/javascript; charset=utf-8", externalLinksSource);
        return;
      }
      if (url.pathname === "/strings.js") {
        send(response, 200, "text/javascript; charset=utf-8", stringsSource);
        return;
      }
      if (url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        response.write("retry: 1000\n\n");
        return;
      }
      if (url.pathname === "/api/open-external" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        try {
          const parsed = JSON.parse(body) as { url?: unknown };
          if (typeof parsed.url === "string") externalCalls.urls.push(parsed.url);
        } catch { /* record the call count even for a malformed body */ }
        externalCalls.count += 1;
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/forged-hello.html") {
        send(response, 200, "text/html; charset=utf-8",
          forgedTemplate.replaceAll("__ADMIN_ORIGIN_JSON__", JSON.stringify(adminOrigin)));
        return;
      }
      if (url.pathname === "/blank.html") {
        send(response, 200, "text/html; charset=utf-8", "<!doctype html><title>blank</title>");
        return;
      }
      send(response, 404, "text/plain; charset=utf-8", "not found");
    });
    adminOrigin = adminServer.origin;

    contentServer = await startServer(async (request, response) => {
      const url = new URL(request.url || "/", contentOrigin || "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname === "/deck.html") {
        const generation = url.searchParams.get("generation") || "test-generation";
        send(response, 200, "text/html; charset=utf-8",
          fillDeck(deckTemplate, adminOrigin, contentOrigin, generation));
        return;
      }
      if (url.pathname === "/selection.html") {
        const generation = url.searchParams.get("generation") || "test-generation";
        send(response, 200, "text/html; charset=utf-8",
          fillDeck(selectionDeckTemplate, adminOrigin, contentOrigin, generation));
        return;
      }
      if (url.pathname === "/bridge/frame-agent.classic.js") {
        send(response, 200, "text/javascript; charset=utf-8", agentBundle);
        return;
      }
      if (url.pathname.startsWith("/theme/")) {
        const file = url.pathname.slice("/theme/".length);
        const color = file === "accent.css"
          ? "rgb(1, 2, 3)"
          : file === "blue.css" ? "rgb(4, 5, 6)" : "rgb(250, 251, 252)";
        // Keep theme loads overlapping so the rapid-swap test actually
        // exercises superseding rather than two serialized completions.
        await new Promise(resolve => setTimeout(resolve, 35));
        send(response, 200, "text/css; charset=utf-8",
          `#stage > .active { background-color: ${color}; }\n`);
        return;
      }
      if (url.pathname === "/forged-hello.html") {
        send(response, 200, "text/html; charset=utf-8",
          forgedTemplate.replaceAll("__ADMIN_ORIGIN_JSON__", JSON.stringify(adminOrigin)));
        return;
      }
      if (url.pathname === "/blank.html") {
        send(response, 200, "text/html; charset=utf-8", "<!doctype html><title>blank</title>");
        return;
      }
      send(response, 404, "text/plain; charset=utf-8", "not found");
    });
    contentOrigin = contentServer.origin;
    return {
      admin: adminServer.server,
      content: contentServer.server,
      adminOrigin,
      contentOrigin,
      externalCalls,
    };
  } catch (error) {
    await closeServer(contentServer?.server);
    await closeServer(adminServer?.server);
    throw error;
  }
}

async function harnessCall<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(({ method, args }) => {
    const harness = (window as any).__bridgeHarness;
    if (!harness) throw new Error("bridge harness is not installed");
    const fn = harness[method];
    if (typeof fn !== "function") throw new Error(`bridge harness method is missing: ${method}`);
    return fn.apply(harness, args);
  }, { method, args });
  return result as T;
}

async function waitMarker(page: Page, generation: string, type: string, label?: string): Promise<void> {
  await page.waitForFunction(({ generation, type, label }) => {
    const harness = (window as any).__bridgeHarness;
    return !!harness?.hasMarker(generation, type, label);
  }, { generation, type, label }, { timeout: WAIT_TIMEOUT_MS, polling: 100 });
}

async function waitEvent(page: Page, generation: string, name: string): Promise<BridgeEvent> {
  await page.waitForFunction(({ generation, name }) => {
    const harness = (window as any).__bridgeHarness;
    return harness.events(generation, name).length > 0;
  }, { generation, name }, { timeout: WAIT_TIMEOUT_MS, polling: 100 });
  const events = await harnessCall<BridgeEvent[]>(page, "events", generation, name);
  const event = events[0];
  if (!event) throw new Error(`expected ${name} event for ${generation}`);
  return event;
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function messageOf<T extends FixtureMessage>(messages: FixtureMessage[], predicate: (message: FixtureMessage) => boolean): T {
  const message = messages.find(predicate);
  if (!message) throw new Error("expected fixture message was not recorded");
  return message as T;
}

test("stage 1 bridge keeps a real cross-origin frame private and navigable", {
  timeout: TEST_TIMEOUT_MS,
  skip: !E2E,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "slide-studio-bridge-e2e-"));
  let adminServer: Server | undefined;
  let contentServer: Server | undefined;
  let electronApp: ElectronApplication | undefined;
  let page: Page | undefined;

  t.after(async () => {
    if (page) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        page.evaluate(() => {
          const harness = (window as any).__bridgeHarness;
          return harness?.destroyAll?.();
        }).catch(() => {}),
        new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 2_000); }),
      ]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
    if (electronApp) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        electronApp.close().catch(() => {}),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); }),
      ]);
      if (timer) clearTimeout(timer);
      try { electronApp.process().kill("SIGKILL"); } catch { /* already gone */ }
    }
    await closeServer(contentServer);
    await closeServer(adminServer);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const servers = await startServers();
  adminServer = servers.admin;
  contentServer = servers.content;
  const { adminOrigin, contentOrigin, externalCalls } = servers;

  const mainPath = join(root, "main.cjs");
  await copyFile(fixturePath("main.cjs"), mainPath);

  const electronPath = createRequire(import.meta.url)("electron") as string;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  env.BRIDGE_E2E_ADMIN_URL = `${adminOrigin}/`;
  env.TMPDIR = root;
  env.TMP = root;
  env.TEMP = root;

  electronApp = await electron.launch({
    executablePath: electronPath,
    args: [mainPath],
    env,
    timeout: LAUNCH_TIMEOUT_MS,
  });
  page = await electronApp.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
  await page.waitForFunction(() => Boolean((window as any).__bridgeHarness), undefined, {
    timeout: WAIT_TIMEOUT_MS,
    polling: 100,
  });
  assert.equal(new URL(page.url()).origin, adminOrigin);

  const deckUrl = `${contentOrigin}/deck.html`;
  const main = await harnessCall<CreatedClient>(page, "create", {
    generation: "gen-main",
    nonce: "nonce-main",
    url: deckUrl,
    contentOrigin,
    query: { duplicateNonce: "nonce-main" },
    mode: "edit",
    rpcTimeoutMs: 15_000,
    readyTimeoutMs: 10_000,
  });
  assert.ok(main.src.startsWith(`${contentOrigin}/deck.html`));
  assert.match(main.src, /#1\/0&n=nonce-main$/);

  await waitMarker(page, main.generation, "fixture-loaded");
  const loaded = messageOf(await harnessCall<FixtureMessage[]>(page, "messages", main.generation, "fixture-loaded"), message => message.type === "fixture-loaded");
  assert.equal(loaded.authoredHash, "#1/0", "the first content script must see the legacy page/step hash without the nonce");
  assert.doesNotMatch(String(loaded.authoredHref), /[?&#]n=/, "the nonce must not survive into the authored document URL");
  assert.match(String(loaded.adminDom), /^denied:/, "content must not read the admin DOM");
  assert.equal(loaded.nodeAccess, "none", "sandboxed content must not expose Node globals");

  const initial = await harnessCall<Snapshot>(page, "ready", main.generation);
  assert.equal(initial.deck, "deck-test");
  assert.equal(initial.version, "v1");
  assert.equal(initial.generation, "gen-main");
  assert.equal(initial.index, 0);
  assert.equal(initial.step, 0);
  assert.equal(initial.maxStep, 2);
  assert.equal(initial.slides.length, 3);
  assert.deepEqual(initial.slides.map(slide => slide.id), ["slide-1", "slide-2", "slide-3"]);
  assert.deepEqual(initial.slides.map(slide => slide.page), [0, 1, 2]);
  assert.equal(initial.slides[1]?.chapter, true);
  assert.equal(initial.slides[2]?.sectionStart, true);
  assert.deepEqual(initial.slides[1]?.pdfMarks, [0, 1]);
  assert.equal(initial.stageAt, 0);
  const cachedReads = await harnessCall<{ maxStep: number; pdfMarks: number[]; stageNumber: number; count: number }>(page, "snapshotReads", main.generation);
  assert.equal(cachedReads.count, 3);
  assert.equal(cachedReads.maxStep, 1);
  assert.deepEqual(cachedReads.pdfMarks, [0, 1]);
  assert.equal(cachedReads.stageNumber, 2);

  await waitMarker(page, main.generation, "fixture-duplicate-posted");
  assert.equal(await harnessCall<boolean>(page, "portStable", main.generation), true,
    "a duplicate hello must not replace the accepted agent port");

  const afterGo = await harnessCall<Snapshot>(page, "go", main.generation, 1, 0);
  assert.equal(afterGo.index, 1);
  assert.equal(afterGo.step, 0);
  assert.equal(afterGo.background, "rgb(250, 251, 252)");

  const afterMove = await harnessCall<Snapshot>(page, "move", main.generation, 1);
  assert.equal(afterMove.index, 1);
  assert.equal(afterMove.step, 1);

  await harnessCall(page, "setFilter", main.generation, [0, 2]);
  await waitMarker(page, main.generation, "fixture-filter");
  const filters = await harnessCall<FixtureMessage[]>(page, "messages", main.generation, "fixture-filter");
  assert.deepEqual(filters.at(-1)?.filter, [0, 2]);

  await harnessCall(page, "setFilter", main.generation, null);
  const clearedFilters = await harnessCall<FixtureMessage[]>(page, "messages", main.generation, "fixture-filter");
  assert.equal(clearedFilters.at(-1)?.filter, null);

  const themed = await harnessCall<{ result: { swapped?: boolean }; snapshot: Snapshot }>(page, "themeSwap", main.generation, "accent", "v2", "rev-theme-2");
  assert.equal(themed.result.swapped, true);
  assert.equal(themed.snapshot.background, "rgb(1, 2, 3)");
  assert.equal(themed.snapshot.sourceVersion, "rev-theme-2");
  assert.equal(await harnessCall(page, "contentCommand", main.generation, { type: "fixture-state", label: "after-theme" }), true);
  await waitMarker(page, main.generation, "fixture-state", "after-theme");
  const themedState = messageOf(await harnessCall<FixtureMessage[]>(page, "messages", main.generation, "fixture-state"), message => message.label === "after-theme");
  assert.match(String(themedState.themeHref), new RegExp(`${contentOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/theme/accent\\.css\\?version=v2$`));
  assert.equal(themedState.studioVersion, "rev-theme-2");

  const rapid = await harnessCall<{ results: Array<{ status: string; value?: { swapped?: boolean } }>; snapshot: Snapshot }>(
    page, "themeSwapRapid", main.generation, [
      { name: "accent", version: "v2-rapid", sourceVersion: "rev-theme-2r" },
      { name: "blue", version: "v3", sourceVersion: "rev-theme-3" },
    ],
  );
  assert.equal(rapid.snapshot.background, "rgb(4, 5, 6)");
  assert.equal(rapid.snapshot.sourceVersion, "rev-theme-3");
  assert.ok(rapid.results.some(result => result.status === "fulfilled" && result.value?.swapped === true));
  assert.equal(await harnessCall(page, "contentCommand", main.generation, { type: "fixture-state", label: "after-rapid-theme" }), true);
  await waitMarker(page, main.generation, "fixture-state", "after-rapid-theme");
  const rapidState = messageOf(await harnessCall<FixtureMessage[]>(page, "messages", main.generation, "fixture-state"), message => message.label === "after-rapid-theme");
  assert.match(String(rapidState.themeHref), new RegExp(`${contentOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/theme/blue\\.css\\?version=v3$`));
  assert.equal(rapidState.studioVersion, "rev-theme-3");
  assert.equal(rapidState.themeCount, 1, "one live theme link is expected after rapid swaps");

  const beforeStale = await harnessCall<Snapshot>(page, "snapshot", main.generation);
  const stale = await harnessCall<StaleResponse>(page, "staleRequest", main.generation, "stale-generation");
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, "invalid-request");
  assert.equal(stale.generation, "gen-main");
  const afterStale = await harnessCall<Snapshot>(page, "snapshot", main.generation);
  assert.equal(afterStale.index, beforeStale.index);
  assert.equal(afterStale.step, beforeStale.step);

  const readiness = await harnessCall<CreatedClient>(page, "create", {
    generation: "gen-readiness",
    nonce: "nonce-readiness",
    url: deckUrl,
    contentOrigin,
    query: { deferReady: "1" },
    readyTimeoutMs: 10_000,
  });
  await waitMarker(page, readiness.generation, "fixture-loaded");
  const readinessPending = await harnessCall<BridgeStatus>(page, "status", readiness.generation);
  assert.equal(readinessPending.status, "pending", "a parsed stage without deckReady must not become ready");
  await harnessCall(page, "contentCommand", readiness.generation, { type: "fixture-ready" });
  await waitMarker(page, readiness.generation, "fixture-ready-set");
  const readinessSnapshot = await harnessCall<Snapshot>(page, "ready", readiness.generation);
  assert.equal(readinessSnapshot.slides.length, 3);
  await harnessCall(page, "destroy", readiness.generation);

  await assert.rejects(
    harnessCall(page, "create", {
      generation: "gen-equal-origin",
      nonce: "nonce-equal-origin",
      url: deckUrl,
      contentOrigin: adminOrigin,
      readyTimeoutMs: 10_000,
    }),
    /origins must differ/,
    "a capability resolving to the admin origin must be rejected",
  );

  const present = await harnessCall<CreatedClient>(page, "create", {
    generation: "gen-present",
    nonce: "nonce-present",
    url: deckUrl,
    contentOrigin,
    mode: "present",
    readyTimeoutMs: 10_000,
  });
  const presented = await harnessCall<Snapshot>(page, "ready", present.generation);
  assert.equal(presented.generation, "gen-present");
  assert.equal(presented.index, 0);
  assert.equal(await harnessCall(page, "contentCommand", present.generation, { type: "fixture-key", key: "Escape", eventType: "keydown" }), true);
  const keyEvent = await waitEvent(page, present.generation, "key");
  assert.equal(keyEvent.data.key, "Escape");
  assert.equal(keyEvent.data.type, "keydown");
  await waitMarker(page, present.generation, "fixture-key-dispatched");
  const keyMarker = messageOf(await harnessCall<FixtureMessage[]>(page, "messages", present.generation, "fixture-key-dispatched"), message => message.type === "fixture-key-dispatched");
  assert.equal(keyMarker.canceled, true, "the presentation agent must consume the content-side Escape default");
  await harnessCall(page, "contentCommand", present.generation, { type: "fixture-state", label: "present-state" });
  await waitMarker(page, present.generation, "fixture-state", "present-state");
  const presentState = messageOf(await harnessCall<FixtureMessage[]>(page, "messages", present.generation, "fixture-state"), message => message.label === "present-state");
  assert.equal(presentState.noHash, true, "presentation must set __slideStudioNoHash before the authored runtime");

  await harnessCall(page, "contentCommand", present.generation, {
    type: "fixture-link-prepare",
    href: "https://example.invalid/safe",
  });
  await waitMarker(page, present.generation, "fixture-link-prepared");
  const presentFrame = page.frames().find(frame => frame.url().includes("generation=gen-present"));
  assert.ok(presentFrame, "presentation content frame should be available");
  await presentFrame.locator("#bridge-external-link").click({ timeout: WAIT_TIMEOUT_MS });
  await presentFrame.locator("#bridge-external-link").click({ timeout: WAIT_TIMEOUT_MS });
  const linkEvent = await waitEvent(page, present.generation, "link.open");
  assert.equal(linkEvent.data.url, "https://example.invalid/safe");
  await waitForCondition(() => externalCalls.count === 1, "the parent external-link API call");
  assert.deepEqual(externalCalls.urls, ["https://example.invalid/safe"]);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(externalCalls.count, 1, "a second trusted click must be parent rate-limited");

  const scriptedBefore = (await harnessCall<BridgeEvent[]>(page, "events", present.generation, "link.open")).length;
  assert.equal(await harnessCall(page, "contentCommand", present.generation, {
    type: "fixture-link",
    href: "https://example.invalid/scripted",
  }), true);
  await waitMarker(page, present.generation, "fixture-link-clicked");
  const scriptedMarker = messageOf(await harnessCall<FixtureMessage[]>(page, "messages", present.generation, "fixture-link-clicked"), message => message.type === "fixture-link-clicked");
  assert.equal(scriptedMarker.canceled, false, "a script-generated click must not be intercepted");
  await new Promise(resolve => setTimeout(resolve, 100));
  const scriptedAfter = await harnessCall<BridgeEvent[]>(page, "events", present.generation, "link.open");
  assert.equal(scriptedAfter.length, scriptedBefore, "a script-generated click must not emit link.open");
  assert.equal(externalCalls.count, 1);

  const wrongOrigin = await harnessCall<CreatedClient>(page, "create", {
    generation: "gen-wrong-origin",
    nonce: "nonce-wrong-origin",
    url: `${adminOrigin}/forged-hello.html`,
    contentOrigin,
    query: { nonce: "nonce-wrong-origin" },
    readyTimeoutMs: 10_000,
  });
  await waitMarker(page, wrongOrigin.generation, "forged-hello-posted");
  const wrongOriginMessage = messageOf(await harnessCall<FixtureMessage[]>(page, "messages", wrongOrigin.generation, "forged-hello-posted"), message => message.type === "forged-hello-posted");
  assert.equal(wrongOriginMessage.origin, adminOrigin);
  const wrongOriginStatus = await harnessCall<BridgeStatus>(page, "status", wrongOrigin.generation);
  assert.equal(wrongOriginStatus.status, "pending");
  assert.equal(wrongOriginStatus.portNull, true, "a hello from the wrong origin must not attach");
  await harnessCall(page, "destroy", wrongOrigin.generation);

  const wrongSource = await harnessCall<CreatedClient>(page, "create", {
    generation: "gen-wrong-source",
    nonce: "nonce-wrong-source",
    url: `${adminOrigin}/blank.html`,
    contentOrigin,
    readyTimeoutMs: 10_000,
  });
  const siblingUrl = `${contentOrigin}/forged-hello.html?${new URLSearchParams({
    nonce: "nonce-wrong-source",
    generation: wrongSource.generation,
  })}`;
  await harnessCall(page, "addSibling", siblingUrl, wrongSource.generation);
  await waitMarker(page, wrongSource.generation, "forged-hello-posted");
  const wrongSourceMessage = messageOf(await harnessCall<FixtureMessage[]>(page, "messages", wrongSource.generation, "forged-hello-posted"), message => message.type === "forged-hello-posted");
  assert.equal(wrongSourceMessage.origin, contentOrigin);
  const wrongSourceStatus = await harnessCall<BridgeStatus>(page, "status", wrongSource.generation);
  assert.equal(wrongSourceStatus.status, "pending");
  assert.equal(wrongSourceStatus.portNull, true, "a hello from another content frame must not attach");
  await harnessCall(page, "destroy", wrongSource.generation);
  await harnessCall(page, "removeSiblings");

  const wrongNonce = await harnessCall<CreatedClient>(page, "create", {
    generation: "gen-wrong-nonce",
    nonce: "expected-nonce",
    frameNonce: "wrong-nonce",
    url: deckUrl,
    contentOrigin,
    readyTimeoutMs: 10_000,
  });
  await waitMarker(page, wrongNonce.generation, "fixture-loaded");
  const wrongNonceStatus = await harnessCall<BridgeStatus>(page, "status", wrongNonce.generation);
  assert.equal(wrongNonceStatus.status, "pending");
  assert.equal(wrongNonceStatus.portNull, true, "a hello with the wrong nonce must not attach");
  await harnessCall(page, "destroy", wrongNonce.generation);

  await harnessCall(page, "pendingGo", main.generation);
  await harnessCall(page, "reload", main.generation, { nonce: "nonce-reloaded" });
  await page.waitForFunction(generation => {
    const harness = (window as any).__bridgeHarness;
    return harness.status(generation).pending?.status === "rejected";
  }, main.generation, { timeout: WAIT_TIMEOUT_MS, polling: 100 });
  const reloaded = await harnessCall<BridgeStatus>(page, "status", main.generation);
  assert.equal(reloaded.pending?.code, "navigation");
  assert.equal(reloaded.destroyed, true);
  assert.equal(reloaded.portNull, true, "the old port must be closed after navigation");
  const failures = await harnessCall<BridgeFailure[]>(page, "failures", main.generation);
  assert.ok(failures.some(failure => failure.code === "navigation"),
    "navigation must invalidate the old client and be reported as a failure");
});

test("stage 2 selection stays trusted, keyed and revision-scoped across origins", {
  timeout: TEST_TIMEOUT_MS,
  skip: !E2E,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "slide-studio-selection-e2e-"));
  let adminServer: Server | undefined;
  let contentServer: Server | undefined;
  let electronApp: ElectronApplication | undefined;
  let page: Page | undefined;

  t.after(async () => {
    if (page) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        page.evaluate(() => (window as any).__bridgeHarness?.destroyAll?.()).catch(() => {}),
        new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 2_000); }),
      ]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
    if (electronApp) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        electronApp.close().catch(() => {}),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); }),
      ]);
      if (timer) clearTimeout(timer);
      try { electronApp.process().kill("SIGKILL"); } catch { /* already gone */ }
    }
    await closeServer(contentServer);
    await closeServer(adminServer);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const servers = await startServers();
  adminServer = servers.admin;
  contentServer = servers.content;
  const { adminOrigin, contentOrigin } = servers;

  const mainPath = join(root, "main.cjs");
  await copyFile(fixturePath("main.cjs"), mainPath);
  const electronPath = createRequire(import.meta.url)("electron") as string;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  env.BRIDGE_E2E_ADMIN_URL = `${adminOrigin}/`;
  env.TMPDIR = root;
  env.TMP = root;
  env.TEMP = root;

  electronApp = await electron.launch({
    executablePath: electronPath,
    args: [mainPath],
    env,
    timeout: LAUNCH_TIMEOUT_MS,
  });
  page = await electronApp.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
  await page.waitForFunction(() => Boolean((window as any).__bridgeHarness), undefined, {
    timeout: WAIT_TIMEOUT_MS,
    polling: 100,
  });

  const generation = "gen-selection";
  await harnessCall<CreatedClient>(page, "create", {
    generation,
    nonce: "nonce-selection",
    url: `${contentOrigin}/selection.html`,
    contentOrigin,
    readyTimeoutMs: 10_000,
  });
  const initial = await harnessCall<Snapshot>(page, "ready", generation);
  assert.equal(initial.sourceVersion, "v1");
  const frame = page.frames().find(item => item.url().includes(`generation=${generation}`));
  if (!frame) throw new Error("selection content frame was not found");

  await harnessCall(page, "editLocks", generation, ["test/figure"], "#ff8800");
  assert.equal(await frame.locator('[data-slide-studio-fig="test/figure"]').evaluate(el => (el as HTMLElement).style.outlineWidth), "3px");
  await harnessCall(page, "editLocks", generation, [], "#ff8800");
  assert.equal(await frame.locator('[data-slide-studio-fig="test/figure"]').evaluate(el => (el as HTMLElement).style.outline), "");

  const keys = [
    "p1/0", "p1/0.0", "p1/0.0.0", "p1/0.0.1",
    "p1/0.1", "p1/0.1.0", "p1/0.1.1",
  ];
  const layers: Record<string, "1" | "2" | "3"> = {
    "p1/0": "1", "p1/0.0": "2", "p1/0.0.0": "3", "p1/0.0.1": "3",
    "p1/0.1": "2", "p1/0.1.0": "3", "p1/0.1.1": "3",
  };
  const keymap = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyF", "Escape"]
    .map(code => ({ code, shift: false, alt: false, ctrl: false, meta: false, preventDefault: true }));
  const configure = {
    sourceVersion: initial.sourceVersion,
    keys,
    layers,
    keymap,
    enabled: true,
  };

  const configured = await harnessCall<{ sourceVersion: string; layout: EditLayout | null }>(
    page, "editConfigure", generation, configure,
  );
  assert.equal(configured.sourceVersion, "v1");
  await waitForCondition(() => true, "configure ack");
  await page.waitForFunction(({ generation }) => {
    const harness = (window as any).__bridgeHarness;
    return harness.events(generation, "edit.layout").length > 0;
  }, { generation }, { timeout: WAIT_TIMEOUT_MS, polling: 50 });
  let layouts = await harnessCall<Array<{ generation: string; name: string; data: EditLayout }>>(
    page, "events", generation, "edit.layout",
  );
  const firstLayout = layouts.at(-1)?.data;
  assert.ok(firstLayout, "configure must publish an edit.layout event");
  assert.equal(firstLayout.sourceVersion, "v1");
  assert.deepEqual(firstLayout.blocks.map(block => block.key).sort(), [...keys].sort());
  assert.equal(firstLayout.selection, null);
  for (const block of firstLayout.blocks) {
    for (const rect of block.rects) {
      for (const value of [rect.left, rect.top, rect.right, rect.bottom]) {
        assert.equal(Number.isFinite(value), true);
      }
    }
  }

  const first = frame.locator('[data-slide-studio="p1/0.0.0"]');
  // Parent qmd hover reaches the frame through edit.hover.
  await harnessCall(page, "editHover", generation, "p1/0.1.0");
  await frame.waitForFunction(() => document.querySelector('[data-slide-studio="p1/0.1.0"]')
    ?.classList.contains("slide-studio-hover"), undefined, { timeout: WAIT_TIMEOUT_MS });
  const parentHoverIntents = await harnessCall<EditIntent[]>(page, "intents", generation, "hover");
  assert.equal(parentHoverIntents.length, 0, "edit.hover is a command, not a frame-originated intent");

  // Frame hover reaches the parent only through a trusted pointer event.
  await frame.locator('[data-slide-studio="p1/0.1.0"]').hover();
  await page.waitForFunction(({ generation }) => {
    const harness = (window as any).__bridgeHarness;
    return harness.intents(generation, "hover").some((intent: EditIntent) => intent.key === "p1/0.1.0");
  }, { generation }, { timeout: WAIT_TIMEOUT_MS, polling: 50 });
  const hoverIntents = await harnessCall<EditIntent[]>(page, "intents", generation, "hover");
  assert.ok(hoverIntents.some(intent => intent.key === "p1/0.1.0"));
  assert.equal(await page.locator("#qmd-hover").getAttribute("data-key"), "p1/0.1.0");

  // A trusted click emits a selection intent; the parent then applies it.
  await first.click();
  await page.waitForFunction(({ generation }) => {
    const harness = (window as any).__bridgeHarness;
    return harness.intents(generation, "select").length > 0;
  }, { generation }, { timeout: WAIT_TIMEOUT_MS, polling: 50 });
  const selects = await harnessCall<EditIntent[]>(page, "intents", generation, "select");
  const selected = selects.at(-1);
  assert.equal(selected?.key, "p1/0.0.0");
  assert.equal(selected?.trusted, true);
  assert.ok(selected?.point && typeof selected.point === "object");
  await harnessCall(page, "editSelect", generation, "p1/0.0.0", null);
  await frame.waitForFunction(() => document.querySelector('[data-slide-studio="p1/0.0.0"]')
    ?.classList.contains("slide-studio-selected"), undefined, { timeout: WAIT_TIMEOUT_MS });
  const toolbar = await harnessCall<{ left: number; top: number } | null>(page, "placeToolbar", generation, "p1/0.0.0");
  assert.ok(toolbar && toolbar.left > 0 && toolbar.top > 0, "the parent toolbar must use frame geometry plus iframe offset");

  // Geometry updates after a real frame resize.
  const measured = await harnessCall<EditLayout>(page, "editMeasure", generation);
  const beforeLeft = measured.blocks.find(block => block.key === "p1/0.0.0")?.rects[0]?.left;
  await page.evaluate((name: string) => {
    const el = document.querySelector(`iframe[data-bridge-generation="${name}"]`) as HTMLIFrameElement | null;
    if (el) el.style.width = "560px";
  }, generation);
  await page.waitForFunction(({ generation, sequence }) => {
    const harness = (window as any).__bridgeHarness;
    return harness.events(generation, "edit.layout").some((event: { data: EditLayout }) =>
      event.data.sequence > sequence && event.data.sourceVersion === "v1");
  }, { generation, sequence: measured.sequence }, { timeout: WAIT_TIMEOUT_MS, polling: 50 });
  layouts = await harnessCall<Array<{ generation: string; name: string; data: EditLayout }>>(
    page, "events", generation, "edit.layout",
  );
  const resized = layouts.at(-1)?.data;
  const afterLeft = resized?.blocks.find(block => block.key === "p1/0.0.0")?.rects[0]?.left;
  assert.equal(typeof beforeLeft, "number");
  assert.equal(typeof afterLeft, "number");
  assert.notEqual(afterLeft, beforeLeft, "frame geometry must be republished after resize");

  // A theme swap commits a new source revision. The old configure revision is
  // rejected, and selection is not re-enabled until the parent reconfigures.
  const themed = await harnessCall<{ result: { swapped?: boolean }; snapshot: Snapshot }>(
    page, "themeSwap", generation, "accent", "v2", "rev-selection-2",
  );
  assert.equal(themed.result.swapped, true);
  assert.equal(themed.snapshot.sourceVersion, "rev-selection-2");
  await assert.rejects(
    harnessCall(page, "editConfigure", generation, configure),
    /sourceVersion does not match/,
    "configure must never advance or override the frame revision",
  );
  await harnessCall(page, "editConfigure", generation, { ...configure, sourceVersion: "rev-selection-2" });
  await page.waitForFunction(({ generation }) => {
    const harness = (window as any).__bridgeHarness;
    return harness.events(generation, "edit.layout").some((event: { data: EditLayout }) =>
      event.data.sourceVersion === "rev-selection-2");
  }, { generation }, { timeout: WAIT_TIMEOUT_MS, polling: 50 });

  // WASD/QE key intents are decided synchronously by the pushed keymap.
  await first.click();
  for (const [key, code] of [
    ["d", "KeyD"], ["q", "KeyQ"], ["e", "KeyE"], ["w", "KeyW"], ["a", "KeyA"], ["s", "KeyS"],
  ] as const) {
    await first.press(key);
    await page.waitForFunction(({ generation, code }) => {
      const harness = (window as any).__bridgeHarness;
      return harness.intents(generation, "key").some((intent: EditIntent) =>
        intent.type === "keydown" && intent.code === code && intent.trusted === true);
    }, { generation, code }, { timeout: WAIT_TIMEOUT_MS, polling: 50 });
  }

  // R/F hold and keyup are observable, and blur clears the parent pad state.
  await first.click();
  await page.evaluate((name: string) => {
    const el = document.querySelector(`iframe[data-bridge-generation="${name}"]`) as HTMLIFrameElement | null;
    el?.focus();
  }, generation);
  await page.keyboard.down("r");
  await page.waitForFunction(({ generation }) => {
    const harness = (window as any).__bridgeHarness;
    return harness.intents(generation, "key").some((intent: EditIntent) =>
      intent.type === "keydown" && intent.code === "KeyR");
  }, { generation }, { timeout: WAIT_TIMEOUT_MS, polling: 50 });
  assert.equal(await page.locator("#parent-toolbar").getAttribute("data-pad"), "inner");
  await page.keyboard.up("r");
  await page.waitForFunction(() => document.getElementById("parent-toolbar")?.hasAttribute("data-pad") === false,
    undefined, { timeout: WAIT_TIMEOUT_MS, polling: 50 });
  await page.keyboard.down("f");
  await page.waitForFunction(({ generation }) => {
    const harness = (window as any).__bridgeHarness;
    return harness.intents(generation, "key").some((intent: EditIntent) =>
      intent.type === "keydown" && intent.code === "KeyF");
  }, { generation }, { timeout: WAIT_TIMEOUT_MS, polling: 50 });
  assert.equal(await page.locator("#parent-toolbar").getAttribute("data-pad"), "outer");
  await frame.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForFunction(() => document.getElementById("parent-toolbar")?.hasAttribute("data-pad") === false,
    undefined, { timeout: WAIT_TIMEOUT_MS, polling: 50 });
  await page.keyboard.up("f").catch(() => {});

  // Synthetic selection clicks are ignored even when they target a real block.
  const beforeSynthetic = (await harnessCall<EditIntent[]>(page, "intents", generation, "select")).length;
  await frame.evaluate(() => {
    const el = document.querySelector('[data-slide-studio="p1/0.1.0"]');
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  const afterSynthetic = (await harnessCall<EditIntent[]>(page, "intents", generation, "select")).length;
  assert.equal(afterSynthetic, beforeSynthetic, "synthetic clicks must not select");

  // Unknown keys are rejected by the frame, not silently coerced.
  await assert.rejects(harnessCall(page, "editSelect", generation, "unknown/key"), /not configured/);
  await assert.rejects(harnessCall(page, "editSelect", generation, "p1/0.0.0", "unknown/frame"), /not configured/);
});
