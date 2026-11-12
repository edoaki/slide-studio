import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  LegacyFeatureHandler,
  LegacyRendered,
} from "../../packages/contracts/src/legacy.js";
import { parse } from "../../packages/core/src/legacy-source.js";
import { sha256 } from "../../packages/core/src/source.js";
import { Workspace } from "../../packages/core/src/legacy-workspace.js";
import { startLegacyHost, type LegacyHost } from "../../apps/server/legacy.js";

async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slide-studio-legacy-close-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function launch(
  t: TestContext,
  handler: LegacyFeatureHandler,
  shutdownGraceMs: number,
): Promise<{ host: LegacyHost; shutdowns: () => number }> {
  const workspace = Workspace.open(await scratch(t));
  const ui = await mkdtemp(join(tmpdir(), "slide-studio-legacy-close-ui-"));
  t.after(async () => rm(ui, { recursive: true, force: true }));
  await writeFile(join(ui, "app.html"), "<!doctype html><title>UI</title>\n");
  let shutdowns = 0;
  const host = await startLegacyHost({
    workspace,
    uiDirectory: ui,
    pandocPath: "/bin/pandoc",
    renderText: async (_workspace, _deck, text): Promise<LegacyRendered> => ({
      html: "<!doctype html><html><body><div id=\"stage\"></div></body></html>",
      slides: [],
      doc: parse(text),
      version: sha256(text),
      warnings: [],
      missing_cites: [],
      cited: [],
      unsupported: [],
      timing: {},
    }),
    featureHandlers: [handler],
    watch: false,
    shutdownGraceMs,
    onShutdown: () => {
      shutdowns += 1;
    },
  });
  t.after(async () => host.close());
  return { host, shutdowns: () => shutdowns };
}

function gatedHandler(gate: Promise<void>, started: () => void): LegacyFeatureHandler {
  return async (request) => {
    if (request.pathname !== "/api/math") return null;
    started();
    await gate;
    return { status: 200, body: { ok: true } };
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

test("close waits for an accepted write after the client aborts", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const { host, shutdowns } = await launch(
    t,
    gatedHandler(gate, () => {
      entered = true;
    }),
    1,
  );

  const base = new URL(host.adminOrigin);
  const request = httpRequest({
    hostname: base.hostname,
    port: base.port,
    path: "/api/math",
    method: "POST",
    headers: {
      "x-studio-token": host.token,
      origin: host.adminOrigin,
      "content-type": "application/json",
    },
  });
  request.on("error", () => undefined);
  request.end(JSON.stringify({ tex: "x" }));
  await waitUntil(() => entered);

  let closed = false;
  const closing = host.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed, false);
  assert.equal(shutdowns(), 0);

  // The handler owns a write even though the client is gone.
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed, false);
  assert.equal(shutdowns(), 0);

  release();
  await closing;
  assert.equal(shutdowns(), 1);
});

test("a tiny shutdown grace never releases before a gated write settles", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const { host, shutdowns } = await launch(
    t,
    gatedHandler(gate, () => {
      entered = true;
    }),
    1,
  );

  const base = new URL(host.adminOrigin);
  const response = new Promise<number>((resolveResponse, reject) => {
    const request = httpRequest({
      hostname: base.hostname,
      port: base.port,
      path: "/api/math",
      method: "POST",
      headers: {
        "x-studio-token": host.token,
        origin: host.adminOrigin,
        "content-type": "application/json",
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolveResponse(res.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(JSON.stringify({ tex: "x" }));
  });
  await waitUntil(() => entered);

  let closed = false;
  const closing = host.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(closed, false);
  assert.equal(shutdowns(), 0);

  release();
  assert.equal(await response, 200);
  await closing;
  assert.equal(shutdowns(), 1);
});
