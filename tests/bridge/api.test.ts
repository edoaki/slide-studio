import assert from "node:assert/strict";
import test from "node:test";

import {
  installEnv,
  loadApiModule,
  loadStrings,
  makeSessionStorage,
  type FetchLike,
} from "./api-test-env.js";

const ORIGIN = "http://127.0.0.1:4567";
const TOKEN_KEY = "slide-studio:admin-token";

interface Call {
  url: string;
  init: RequestInit;
  headers: Headers;
}

function neverEvents(): Promise<Response> {
  // Keep the module-level event stream pending so API-only tests do not reconnect.
  return new Promise<Response>(() => {});
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function failure(promise: Promise<unknown>): Promise<Error & { status?: number; data?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { status?: number; data?: unknown };
  }
  assert.fail("expected the request to fail");
  throw new Error("unreachable");
}

test("token bootstrap stores the session token and removes only its fragment", async (t) => {
  const calls: Call[] = [];
  const pageUrlsAtFetch: string[] = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    pageUrlsAtFetch.push(env.url().href);
    const url = new URL(String(input), env.url().href);
    if (url.pathname === "/api/events") return neverEvents();
    calls.push({ url: url.href, init, headers: new Headers(init.headers) });
    return json({ ok: true });
  };
  const env = installEnv({
    href: `${ORIGIN}/deck/a?x=1#token=secret%2Bvalue&page/1&n=keep`,
    meta: "/workspace",
    fetch: fetchImpl,
  });
  t.after(() => { env.unload(); env.cleanup(); });

  const apiModule = await loadApiModule();
  assert.equal(env.url().hash, "#page/1&n=keep");
  assert.doesNotMatch(env.url().href, /token|secret/i);
  assert.ok(pageUrlsAtFetch.length > 0, "the event stream must have started");
  assert.equal(pageUrlsAtFetch.some(url => /token|secret/i.test(url)), false,
    "the token fragment must be gone before the first network request");
  assert.equal((globalThis as unknown as Record<string, unknown>).token, undefined);
  assert.equal(Object.values(globalThis).includes("secret+value"), false);

  // 同じ配信元の管理スクリプトは sessionStorage を読める。閉包だけを安全境界にはしない。
  assert.equal(env.sessionStorage.getItem(TOKEN_KEY), "secret+value");
  assert.equal(apiModule.locationHeaders(`${ORIGIN}/api/upload`)["X-Studio-Token"], "secret+value");

  assert.deepEqual(await apiModule.api("/api/ok"), { ok: true });
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.headers.get("x-studio-token"), "secret+value");
  assert.equal(call.headers.get("x-slide-studio-location"), "/workspace");
  assert.doesNotMatch(call.url, /token|secret/i);
  assert.equal(env.url().hash, "#page/1&n=keep");
});

test("api keeps the legacy method, body, response and upload header shape", async (t) => {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input), env.url().href);
    if (url.pathname === "/api/events") return neverEvents();
    calls.push({ url: url.href, init, headers: new Headers(init.headers) });
    return json({ saved: true });
  };
  const env = installEnv({
    href: `${ORIGIN}/#token=abc123`,
    meta: "deck-a",
    fetch: fetchImpl,
  });
  t.after(() => { env.unload(); env.cleanup(); });

  const apiModule = await loadApiModule();
  const result = await apiModule.api("/api/deck/deck-a/source?view=full", {
    method: "PUT",
    body: { text: "line", base: "v1" },
  });
  assert.deepEqual(result, { saved: true });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.init.method, "PUT");
  assert.equal(call.init.body, JSON.stringify({ text: "line", base: "v1" }));
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.headers.get("content-type"), "application/json");
  assert.equal(call.headers.get("x-studio-token"), "abc123");
  assert.equal(call.headers.get("x-slide-studio-location"), "deck-a");
  assert.equal(new URL(call.url).pathname, "/api/deck/deck-a/source");
  assert.equal(new URL(call.url).search, "?view=full");

  const uploadHeaders = apiModule.locationHeaders(`${ORIGIN}/api/deck/deck-a/assets`);
  assert.equal(uploadHeaders["X-Studio-Token"], "abc123");
  assert.equal(uploadHeaders["X-Slide-Studio-Location"], "deck-a");
  assert.equal(apiModule.locationHeaders()["X-Studio-Token"], undefined,
    "a missing target must never receive the token");
  assert.equal(apiModule.locationHeaders("http://evil.invalid/api")["X-Studio-Token"], undefined);
  assert.equal(apiModule.locationHeaders(new Request(`${ORIGIN}/api/deck/deck-a/assets`))["X-Studio-Token"], "abc123",
    "Request targets must be checked by their .url");
  assert.equal(apiModule.locationHeaders(new Request("http://evil.invalid/api"))["X-Studio-Token"], undefined);
});

test("api rejects management requests outside the admin origin before fetching", async (t) => {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input), env.url().href);
    if (url.pathname === "/api/events") return neverEvents();
    calls.push({ url: url.href, init, headers: new Headers(init.headers) });
    return json({ ok: true });
  };
  const env = installEnv({
    href: `${ORIGIN}/#token=abc123`,
    fetch: fetchImpl,
  });
  t.after(() => { env.unload(); env.cleanup(); });

  const apiModule = await loadApiModule();
  const before = calls.length;
  const crossOrigin = await failure(apiModule.api("https://evil.invalid/api/deck"));
  assert.match(crossOrigin.message, /配信元/);
  const protocolRelative = await failure(apiModule.api("//evil.invalid/api/deck"));
  assert.match(protocolRelative.message, /配信元/);
  assert.equal(calls.length, before);

  const absoluteLocal = await apiModule.api(`${ORIGIN}/api/local`);
  assert.deepEqual(absoluteLocal, { ok: true });
  assert.equal(calls.length, before + 1);
});

test("api preserves HTTP error status/data and uses plaintext errors", async (t) => {
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input), env.url().href);
    if (url.pathname === "/api/events") return neverEvents();
    if (url.pathname === "/api/conflict") {
      return json({ error: "原稿が外で変更されました", currentVersion: "v2" }, 409);
    }
    if (url.pathname === "/api/auth-plain") return json({ error: "ログインし直してください" }, 401);
    if (url.pathname === "/api/auth-empty") return new Response("", { status: 403 });
    if (url.pathname === "/api/nested") return json({ error: { code: "BUSY", message: "処理中です" } }, 503);
    if (url.pathname === "/api/no-json") return new Response("not json", { status: 200 });
    return json({ error: "不明" }, 500);
  };
  const env = installEnv({
    href: `${ORIGIN}/#token=abc123`,
    fetch: fetchImpl,
  });
  t.after(() => { env.unload(); env.cleanup(); });

  const apiModule = await loadApiModule();
  const conflict = await failure(apiModule.api("/api/conflict", { method: "PUT", body: {} }));
  assert.equal(conflict.message, "原稿が外で変更されました");
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.data, { error: "原稿が外で変更されました", currentVersion: "v2" });

  const plain = await failure(apiModule.api("/api/auth-plain"));
  assert.equal(plain.message, "ログインし直してください");
  assert.equal(plain.status, 401);

  const strings = await loadStrings();
  const empty = await failure(apiModule.api("/api/auth-empty"));
  assert.equal(empty.message, strings.S.authLost);
  assert.equal(empty.status, 403);

  const nested = await failure(apiModule.api("/api/nested"));
  assert.equal(nested.message, "処理中です");
  assert.equal(nested.status, 503);

  assert.equal(await apiModule.api("/api/no-json"), null);
});

test("session storage restores the admin token after a reload", async (t) => {
  const storage = makeSessionStorage();
  let current: ReturnType<typeof installEnv> | null = null;
  t.after(() => { current?.unload(); current?.cleanup(); });

  current = installEnv({
    href: `${ORIGIN}/deck/a#token=stored-token`,
    sessionStorage: storage,
    fetch: async (input) => {
      const url = new URL(String(input), `${ORIGIN}/`);
      if (url.pathname === "/api/events") return neverEvents();
      return json({ ok: true });
    },
  });
  await loadApiModule();
  assert.equal(storage.getItem(TOKEN_KEY), "stored-token");
  current.unload();
  current.cleanup();
  current = null;

  const calls: Call[] = [];
  current = installEnv({
    href: `${ORIGIN}/deck/a`,
    sessionStorage: storage,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input), `${ORIGIN}/`);
      if (url.pathname === "/api/events") return neverEvents();
      calls.push({ url: url.href, init, headers: new Headers(init.headers) });
      return json({ ok: true });
    },
  });
  const apiModule = await loadApiModule();
  assert.deepEqual(await apiModule.api("/api/ok"), { ok: true });
  assert.equal(calls[0]?.headers.get("x-studio-token"), "stored-token");
});

test("a new startup fragment overrides the stored token", async (t) => {
  const storage = makeSessionStorage();
  storage.setItem(TOKEN_KEY, "old-token");
  const calls: Call[] = [];
  let current: ReturnType<typeof installEnv> | null = null;
  t.after(() => { current?.unload(); current?.cleanup(); });

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input), `${ORIGIN}/`);
    if (url.pathname === "/api/events") return neverEvents();
    calls.push({ url: url.href, init, headers: new Headers(init.headers) });
    return json({ ok: true });
  };

  current = installEnv({
    href: `${ORIGIN}/#token=new-token`,
    sessionStorage: storage,
    fetch: fetchImpl,
  });
  let apiModule = await loadApiModule();
  assert.equal(storage.getItem(TOKEN_KEY), "new-token");
  await apiModule.api("/api/ok");
  assert.equal(calls.at(-1)?.headers.get("x-studio-token"), "new-token");
  current.unload();
  current.cleanup();
  current = null;

  current = installEnv({
    href: `${ORIGIN}/deck/a`,
    sessionStorage: storage,
    fetch: fetchImpl,
  });
  apiModule = await loadApiModule();
  await apiModule.api("/api/ok");
  assert.equal(calls.at(-1)?.headers.get("x-studio-token"), "new-token",
    "a reload must keep the newest startup token");
});

test("auth failures clear the stored token", async (t) => {
  const storage = makeSessionStorage();
  const env = installEnv({
    href: `${ORIGIN}/#token=expired-token`,
    sessionStorage: storage,
    fetch: async (input) => {
      const url = new URL(String(input), `${ORIGIN}/`);
      if (url.pathname === "/api/events") return neverEvents();
      if (url.pathname === "/api/auth") return json({ error: "認証が切れました" }, 401);
      return json({ ok: true });
    },
  });
  t.after(() => { env.unload(); env.cleanup(); });

  const apiModule = await loadApiModule();
  assert.equal(storage.getItem(TOKEN_KEY), "expired-token");
  await failure(apiModule.api("/api/auth"));
  assert.equal(storage.getItem(TOKEN_KEY), null);
});

test("unavailable session storage keeps the bootstrap token in memory", async (t) => {
  const storage = {
    getItem(): string | null { throw new Error("get failed"); },
    setItem(): void { throw new Error("token=secret-token"); },
    removeItem(): void { throw new Error("remove failed"); },
    clear(): void {},
  };
  const env = installEnv({
    href: `${ORIGIN}/#token=secret-token`,
    sessionStorage: storage,
    fetch: async (input) => {
      const url = new URL(String(input), `${ORIGIN}/`);
      if (url.pathname === "/api/events") return neverEvents();
      return json({ ok: true });
    },
  });
  t.after(() => { env.unload(); env.cleanup(); });

  const apiModule = await loadApiModule();
  assert.equal(apiModule.locationHeaders(`${ORIGIN}/api/upload`)["X-Studio-Token"], "secret-token");
});

test("uploadFetch validates targets, authenticates, and preserves response handling", async (t) => {
  const storage = makeSessionStorage();
  const calls: Call[] = [];
  const env = installEnv({
    href: `${ORIGIN}/#token=abc123`,
    meta: "deck-a",
    sessionStorage: storage,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input), `${ORIGIN}/`);
      if (url.pathname === "/api/events") return neverEvents();
      calls.push({ url: url.href, init, headers: new Headers(init.headers) });
      if (url.pathname === "/api/auth-upload") return json({ error: "認証が切れました" }, 401);
      return json({ uploaded: true });
    },
  });
  t.after(() => { env.unload(); env.cleanup(); });

  const apiModule = await loadApiModule();
  const body = new Uint8Array([1, 2, 3]);
  const response = await apiModule.uploadFetch("/api/deck/deck-a/assets?name=a.png", {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body,
  });
  assert.deepEqual(await response.json(), { uploaded: true });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, body);
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.headers.get("content-type"), "image/png");
  assert.equal(call.headers.get("x-studio-token"), "abc123");
  assert.equal(call.headers.get("x-slide-studio-location"), "deck-a");
  assert.doesNotMatch(call.url, /token|secret/i);

  await assert.rejects(apiModule.uploadFetch("https://evil.invalid/upload"), /配信元/);
  assert.equal(calls.length, 1, "a cross-origin upload must not reach fetch");

  const authResponse = await apiModule.uploadFetch("/api/auth-upload", { method: "POST", body });
  assert.equal(authResponse.status, 401);
  assert.equal(storage.getItem(TOKEN_KEY), null, "an upload auth failure must clear the stored token");
});
