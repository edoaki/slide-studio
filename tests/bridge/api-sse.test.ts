import assert from "node:assert/strict";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import test from "node:test";

import {
  installEnv,
  loadApiModule,
  loadStrings,
  makeSessionStorage,
} from "./api-test-env.js";

const TOKEN_KEY = "slide-studio:admin-token";

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function startServer(handler: (request: IncomingMessage, response: ServerResponse, pathname: string) => Promise<void>): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      handler(request, response, url.pathname).catch(error => {
        try {
          if (!response.headersSent) response.writeHead(500);
          response.end(String(error));
        } catch { /* already gone */ }
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function eventHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
  });
}

test("fetch SSE decodes split UTF-8 chunks and multiline data exactly once", { timeout: 10_000 }, async (t) => {
  let connections = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seenHeaders: IncomingHttpHeaders[] = [];
  const started = await startServer(async (request, response, pathname) => {
    if (pathname !== "/api/events") { response.writeHead(404); response.end(); return; }
    connections += 1;
    seenHeaders.push(request.headers as IncomingHttpHeaders);
    eventHeaders(response);
    response.write("retry: 20\n\n");
    await gate;
    const frame = Buffer.from(
      ": ping\n\n"
      + 'data: {"type":"utf8","text":"日本語"}\r\n\r\n'
      + "data: not-json\n\n"
      + 'data: {"type":"multi",\r\n'
      + 'data: "text":"行1\\n行2"}\r\n\r\n',
      "utf8",
    );
    const japanese = Buffer.from("日", "utf8");
    const cut = frame.indexOf(japanese) + 1;
    assert.ok(cut > 0 && cut < frame.length, "the test frame must split a UTF-8 character");
    response.write(frame.subarray(0, cut));
    await delay(10);
    response.write(frame.subarray(cut, cut + 5));
    await delay(10);
    response.write(frame.subarray(cut + 5));
  });

  const env = installEnv({ href: `${started.origin}/#token=secret`, meta: "/ws" });
  t.after(async () => {
    env.unload();
    env.cleanup();
    await closeServer(started.server);
  });

  const apiModule = await loadApiModule();
  const events: Array<Record<string, unknown>> = [];
  apiModule.onEvent(event => events.push(event as Record<string, unknown>));
  apiModule.onEvent(event => events.push({ ...(event as Record<string, unknown>), second: true }));
  release();

  await waitFor(() => events.filter(event => !event.second).length >= 2, "both SSE events");
  const first = events.find(event => event.type === "utf8" && !event.second);
  const second = events.find(event => event.type === "multi" && !event.second);
  assert.equal(first?.text, "日本語");
  assert.equal(second?.text, "行1\n行2");
  assert.equal(events.filter(event => event.type === "utf8").length, 2, "both listeners must receive the event");
  assert.equal(connections, 1, "one document must keep exactly one SSE stream");
  assert.equal(seenHeaders[0]?.["x-studio-token"], "secret");
  assert.equal(seenHeaders[0]?.["x-slide-studio-location"], "/ws");
});

test("SSE reconnects after a close and unload cancels further attempts", { timeout: 10_000 }, async (t) => {
  let connections = 0;
  let closed = 0;
  const requestedAt: number[] = [];
  const reconnectHeaders: IncomingHttpHeaders[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = await startServer(async (request, response, pathname) => {
    if (pathname !== "/api/events") { response.writeHead(404); response.end(); return; }
    connections += 1;
    requestedAt.push(Date.now());
    reconnectHeaders.push(request.headers as IncomingHttpHeaders);
    eventHeaders(response);
    response.write("retry: 20\n\n");
    if (connections === 1) {
      response.write("id: 7\n\n");
      response.end();
      return;
    }
    response.on("close", () => { closed += 1; });
    await gate;
    response.write('data: {"type":"files","paths":[]}\n\n');
  });

  const env = installEnv({ href: `${started.origin}/#token=secret` });
  t.after(async () => {
    env.unload();
    env.cleanup();
    await closeServer(started.server);
  });

  const apiModule = await loadApiModule();
  const events: Array<Record<string, unknown>> = [];
  apiModule.onEvent(event => events.push(event as Record<string, unknown>));
  release();

  await waitFor(() => connections >= 2 && events.some(event => event.type === "files"), "SSE reconnect");
  assert.ok(connections >= 2);
  assert.ok((requestedAt[1] ?? 0) - (requestedAt[0] ?? 0) >= 5,
    "the reconnect must respect the server retry delay instead of looping immediately");
  assert.equal(reconnectHeaders[1]?.["last-event-id"], undefined,
    "the legacy host has no replay support, so Last-Event-ID must not be sent");

  const beforeUnload = connections;
  env.unload();
  await waitFor(() => closed >= 1, "unload to close the stream");
  await delay(150);
  assert.equal(connections, beforeUnload, "unload must abort the stream and stop reconnecting");
});

test("SSE authentication loss stops the loop and shows one clear message", { timeout: 10_000 }, async (t) => {
  let connections = 0;
  const started = await startServer(async (_request, response, pathname) => {
    if (pathname !== "/api/events") { response.writeHead(404); response.end(); return; }
    connections += 1;
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "認証が切れました" }));
  });

  const storage = makeSessionStorage();
  const env = installEnv({ href: `${started.origin}/#token=expired`, sessionStorage: storage });
  t.after(async () => {
    env.unload();
    env.cleanup();
    await closeServer(started.server);
  });

  const strings = await loadStrings();
  await loadApiModule();
  await waitFor(() => env.toastText() === strings.S.authLost, "the authentication message");
  await delay(150);
  assert.equal(connections, 1, "authentication failure must not retry forever");
  assert.equal(storage.getItem(TOKEN_KEY), null, "authentication failure must clear the stored token");
});

test("a cancelled beforeunload keeps SSE, and bfcache restarts it", { timeout: 10_000 }, async (t) => {
  let connections = 0;
  let closed = 0;
  const started = await startServer(async (_request, response, pathname) => {
    if (pathname !== "/api/events") { response.writeHead(404); response.end(); return; }
    connections += 1;
    eventHeaders(response);
    response.write("retry: 20\n\n");
    response.on("close", () => { closed += 1; });
  });

  const env = installEnv({ href: `${started.origin}/#token=secret` });
  t.after(async () => {
    env.unload();
    env.cleanup();
    await closeServer(started.server);
  });

  await loadApiModule();
  await waitFor(() => connections >= 1, "the initial SSE stream");

  env.dispatch("beforeunload");
  await delay(150);
  assert.equal(connections, 1, "a cancelled beforeunload must not reconnect");
  assert.equal(closed, 0, "a cancelled beforeunload must leave the stream open");

  env.dispatch("pagehide", { persisted: true });
  await waitFor(() => closed >= 1, "bfcache pagehide to abort the stream");
  await delay(150);
  assert.equal(connections, 1, "a bfcache pagehide must not reconnect");

  env.dispatch("pageshow", { persisted: true });
  await waitFor(() => connections >= 2, "bfcache pageshow to restart the stream");
});

test("an empty retry field does not force a minimum-delay reconnect", { timeout: 10_000 }, async (t) => {
  let connections = 0;
  const requestedAt: number[] = [];
  const started = await startServer(async (_request, response, pathname) => {
    if (pathname !== "/api/events") { response.writeHead(404); response.end(); return; }
    connections += 1;
    requestedAt.push(Date.now());
    eventHeaders(response);
    response.write("retry:\n\n");
    response.end();
  });

  const env = installEnv({ href: `${started.origin}/#token=secret` });
  t.after(async () => {
    env.unload();
    env.cleanup();
    await closeServer(started.server);
  });

  await loadApiModule();
  await waitFor(() => connections >= 2, "a reconnect after an empty retry field", 6_000);
  assert.ok((requestedAt[1] ?? 0) - (requestedAt[0] ?? 0) >= 500,
    "an empty retry field must be ignored, not treated as a 20 ms delay");
});

test("SSE listener errors are reported instead of swallowed", { timeout: 10_000 }, async (t) => {
  const reported: unknown[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(globals, "reportError");
  Object.defineProperty(globals, "reportError", {
    configurable: true,
    writable: true,
    value: (error: unknown) => { reported.push(error); },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globals, "reportError", previous);
    else delete globals.reportError;
  });

  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = await startServer(async (_request, response, pathname) => {
    if (pathname !== "/api/events") { response.writeHead(404); response.end(); return; }
    eventHeaders(response);
    response.write("retry: 20\n\n");
    await gate;
    response.write('data: {"type":"boom"}\n\n');
  });

  const env = installEnv({ href: `${started.origin}/#token=secret` });
  t.after(async () => {
    env.unload();
    env.cleanup();
    await closeServer(started.server);
  });

  const apiModule = await loadApiModule();
  apiModule.onEvent(() => { throw new Error("listener failed"); });
  release();
  await waitFor(() => reported.length >= 1, "the listener error to be reported");
  assert.match(String((reported[0] as Error).message), /listener failed/);
});

test("uploadFetch rejects a redirect instead of following it", { timeout: 10_000 }, async (t) => {
  let uploadRequests = 0;
  const started = await startServer(async (_request, response, pathname) => {
    if (pathname === "/api/events") { eventHeaders(response); return; }
    if (pathname === "/api/upload") {
      uploadRequests += 1;
      response.writeHead(302, { location: "https://evil.invalid/leak" });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const env = installEnv({ href: `${started.origin}/#token=secret` });
  t.after(async () => {
    env.unload();
    env.cleanup();
    await closeServer(started.server);
  });

  const apiModule = await loadApiModule();
  await assert.rejects(apiModule.uploadFetch("/api/upload", { method: "POST", body: "payload" }));
  await delay(100);
  assert.equal(uploadRequests, 1, "the redirect response must not be followed");
});
