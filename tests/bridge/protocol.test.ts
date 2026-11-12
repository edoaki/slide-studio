import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

interface ProtocolModule {
  PROTOCOL: string;
  COMMAND_METHODS: readonly string[];
  parseNonceFragment(hash: string): { hash: string; nonce: string | null };
  stripNonceFromHash(hash: string): string;
  capabilityHash(index: number, step: number, nonce: string): string;
  makeHello(nonce: string): Record<string, unknown>;
  validateHello(value: unknown, expected?: { nonce?: string }): boolean;
  makeRequest(identity: Identity, id: number, method: string, params?: Record<string, unknown>): Record<string, unknown>;
  validateRequest(value: unknown, expected: Identity): boolean;
  makeResponse(identity: Identity, id: number, ok: boolean, result?: unknown, error?: { code: string; message: string }): Record<string, unknown>;
  validateResponse(value: unknown, expected: Identity): boolean;
  makeEvent(identity: Identity, event: string, data: unknown): Record<string, unknown>;
  validateEvent(value: unknown, expected: Identity): boolean;
  validateSnapshot(value: unknown, expected: Identity): boolean;
  parseSnapshot(value: unknown, expected: Identity): Snapshot | null;
  validateThemeName(name: string): boolean;
  parsePreviewCapability(value: unknown): { url: string; origin: string; version: string };
}

interface Identity { deck: string; version: string; generation: string }
interface Slide {
  index: number; page: number | null; id: string; title: string; chapter: boolean;
  group: string; sectionStart: boolean; maxStep: number; pdfMarks: number[];
  stageNumbers?: number[];
}
interface Snapshot extends Identity {
  index: number; step: number; maxStep: number; slides: Slide[];
  background: string; scale: number; stageAt?: number;
}

function repoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, "packages/web/bridge/protocol.js"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("cannot locate the repository root");
    current = parent;
  }
}

const moduleUrl = pathToFileURL(join(repoRoot(), "packages/web/bridge/protocol.js")).href;
const p = await import(moduleUrl) as ProtocolModule;

const identity: Identity = { deck: "deck-a", version: "v1", generation: "g1" };
const slide: Slide = {
  index: 0, page: 0, id: "slide-1", title: "Title", chapter: false,
  group: "", sectionStart: false, maxStep: 2, pdfMarks: [0, 1, 2], stageNumbers: [1, 2, 3],
};
const snapshot: Snapshot = {
  ...identity, index: 0, step: 1, maxStep: 2, slides: [slide],
  background: "rgb(255, 255, 255)", scale: 0.5, stageAt: 1,
};

test("nonce fragment is removed without touching the legacy page/step hash", () => {
  assert.deepEqual(p.parseNonceFragment("#3/0&n=abc123"), { hash: "#3/0", nonce: "abc123" });
  assert.deepEqual(p.parseNonceFragment("#3/0&x=1&n=a%2Fb"), { hash: "#3/0&x=1", nonce: "a/b" });
  assert.deepEqual(p.parseNonceFragment("#3/0"), { hash: "#3/0", nonce: null });
  assert.deepEqual(p.parseNonceFragment(""), { hash: "", nonce: null });
  assert.equal(p.stripNonceFromHash("#12/4&n=nonce"), "#12/4");
  assert.equal(p.capabilityHash(2, 3, "n"), "#3/3&n=n");
  assert.equal(p.capabilityHash(2, 3, ""), "#3/3");
});

test("hello requires the exact protocol, type, and nonce", () => {
  const hello = p.makeHello("nonce");
  assert.equal(hello.protocol, p.PROTOCOL);
  assert.equal(p.validateHello(hello, { nonce: "nonce" }), true);
  assert.equal(p.validateHello(hello, { nonce: "other" }), false);
  assert.equal(p.validateHello({ ...hello, protocol: "slide-studio-edit/2" }, { nonce: "nonce" }), false);
  assert.equal(p.validateHello({ ...hello, type: "request" }, { nonce: "nonce" }), false);
  assert.equal(p.validateHello({ ...hello, nonce: "" }, { nonce: "" }), false);
});

test("requests are identity scoped and reject unknown methods or arbitrary URLs", () => {
  const go = p.makeRequest(identity, 1, "go", { index: 2, step: 1 });
  assert.equal(p.validateRequest(go, identity), true);
  assert.equal(p.validateRequest(go, { ...identity, generation: "g2" }), false);
  assert.equal(p.validateRequest({ ...go, method: "eval", params: {} }, identity), false);
  assert.equal(p.validateRequest({ ...go, method: "theme.swap", params: { name: "https://evil.test/x", version: "1" } }, identity), false);
  assert.equal(p.validateRequest({ ...go, method: "theme.swap", params: { name: "../x", version: "1" } }, identity), false);
  assert.equal(p.validateRequest({ ...go, method: "theme.swap", params: { name: "accent", version: "1" } }, identity), true);
  assert.equal(p.validateRequest({ ...go, method: "theme.swap", params: { name: "accent", version: "1", sourceVersion: "rev-2" } }, identity), true);
  assert.equal(p.validateRequest({ ...go, method: "theme.swap", params: { name: "accent", version: "1", sourceVersion: 2 } }, identity), false);
  assert.equal(p.validateRequest({ ...go, method: "setFilter", params: { indices: [0, 2] } }, identity), true);
  assert.equal(p.validateRequest({ ...go, method: "setFilter", params: { indices: [0, -1] } }, identity), false);
  assert.equal(p.validateRequest({ ...go, method: "pageWheel", params: {
    deltaX: 1, deltaY: 0, deltaMode: 0,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
  } }, identity), true);
  assert.equal(p.validateThemeName("accent"), true);
  assert.equal(p.validateThemeName("a/b"), false);
});

test("responses and snapshots are validated before they reach the cache", () => {
  const response = p.makeResponse(identity, 1, true, snapshot);
  assert.equal(p.validateResponse(response, identity), true);
  assert.equal(p.validateResponse(response, { ...identity, deck: "other" }), false);
  assert.equal(p.validateResponse({ ...response, result: undefined }, identity), true);
  assert.equal(p.validateSnapshot(snapshot, identity), true);
  assert.equal(p.validateSnapshot({ ...snapshot, sourceVersion: "rev-2" }, identity), true);
  assert.equal(p.validateSnapshot({ ...snapshot, sourceVersion: 2 }, identity), false);
  assert.equal(p.validateSnapshot({ ...snapshot, scale: Number.NaN }, identity), false);
  assert.equal(p.validateSnapshot({ ...snapshot, index: -1 }, identity), false);
  assert.equal(p.validateSnapshot({ ...snapshot, slides: [{ ...slide, pdfMarks: [0, Number.NaN] }] }, identity), false);
  const parsed = p.parseSnapshot(snapshot, identity);
  assert.ok(parsed);
  if (!parsed) throw new Error("expected a parsed snapshot");
  assert.notEqual(parsed, snapshot);
  assert.notEqual(parsed.slides, snapshot.slides);
  assert.notEqual(parsed.slides[0]?.pdfMarks, slide.pdfMarks);
});

test("events only accept known types and safe link targets", () => {
  assert.equal(p.validateEvent(p.makeEvent(identity, "ready", snapshot), identity), true);
  assert.equal(p.validateEvent(p.makeEvent(identity, "link.open", { url: "https://example.com/a" }), identity), true);
  assert.equal(p.validateEvent(p.makeEvent(identity, "link.open", { url: "javascript:alert(1)" }), identity), false);
  assert.equal(p.validateEvent({ ...p.makeEvent(identity, "ready", snapshot), event: "eval" }, identity), false);
  assert.equal(p.validateEvent(p.makeEvent(identity, "failure", { code: "x", message: "y" }), identity), true);
  const key = {
    type: "keydown", key: "Escape", code: "Escape", repeat: false, isComposing: false,
    mods: { shift: false, alt: false, ctrl: false, meta: false },
  };
  assert.equal(p.validateEvent(p.makeEvent(identity, "key", key), identity), true);
  assert.equal(p.validateEvent(p.makeEvent(identity, "key", { ...key, key: "f" }), identity), true);
  assert.equal(p.validateEvent(p.makeEvent(identity, "key", { ...key, key: "F" }), identity), false);
  assert.equal(p.validateEvent(p.makeEvent(identity, "key", { key: "Escape" }), identity), false);
});

test("preview capability requires a matching absolute http(s) origin", () => {
  const capability = { url: "http://127.0.0.1:4321/files/deck/a.html?v=1", origin: "http://127.0.0.1:4321", version: "v1" };
  assert.deepEqual(p.parsePreviewCapability(capability), capability);
  assert.throws(() => p.parsePreviewCapability({ ...capability, origin: "http://localhost:4321" }));
  assert.throws(() => p.parsePreviewCapability({ ...capability, url: "javascript:alert(1)" }));
  assert.throws(() => p.parsePreviewCapability({ ...capability, url: "file:///tmp/a.html" }));
  assert.throws(() => p.parsePreviewCapability({ ...capability, version: "" }));
});
