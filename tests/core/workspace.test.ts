import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { openWorkspace } from "../../packages/core/src/index.js";
import type { CoreFailure } from "../../packages/core/src/index.js";

async function scratch(t: TestContext): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "slide-studio-core-")));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function pandocPath(root: string): string {
  return join(root, "fake-pandoc");
}

async function open(root: string) {
  return openWorkspace(root, { pandocPath: pandocPath(root) });
}

function codeOf(error: unknown): string {
  return (error as CoreFailure).code;
}

test("initializes only decks/state, locks the root, and releases on close", async (t) => {
  const root = await scratch(t);
  const workspace = await open(root);
  t.after(async () => workspace.close().catch(() => undefined));

  assert.equal(workspace.root, realpathSync.native(root));
  assert.deepEqual((await workspace.listDecks()).map((deck) => deck.id), []);
  await assert.rejects(open(root), (error: unknown) => codeOf(error) === "LOCKED");

  await workspace.close();
  const reopened = await open(root);
  await reopened.close();
});

test("creates a Japanese starter deck and lists it", async (t) => {
  const root = await scratch(t);
  const workspace = await open(root);
  t.after(async () => workspace.close().catch(() => undefined));

  const created = await workspace.createDeck("テスト発表");
  assert.match(created.title, /テスト発表/u);
  assert.match(created.source, /^# |^## /mu);
  assert.match(created.source, /::: \{\.cover-title\}/u);
  assert.match(created.source, /^\|---\|/mu);
  assert.match(created.source, /\$\$/u);
  assert.match(created.source, /^lang: ja$/mu);
  assert.doesNotMatch(created.source, /\r/u);
  assert.equal(created.readOnly, false);
  assert.match(created.version, /^[0-9a-f]{64}$/u);

  const listed = await workspace.listDecks();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);
  assert.equal(listed[0]?.title, created.title);
});

test("sample is created only when the workspace has no decks", async (t) => {
  const root = await scratch(t);
  const first = await openWorkspace(root, { pandocPath: pandocPath(root), sample: true });
  assert.equal((await first.listDecks()).length, 1);
  await first.close();

  const second = await openWorkspace(root, { pandocPath: pandocPath(root), sample: true });
  assert.equal((await second.listDecks()).length, 1);
  await second.close();
});

test("CRLF and BOM round-trip byte-exactly when unchanged and are reapplied on edit", async (t) => {
  const root = await scratch(t);
  const workspace = await open(root);
  t.after(async () => workspace.close().catch(() => undefined));
  const created = await workspace.createDeck("改行テスト");
  const file = join(root, "decks", created.id, "slides.qmd");

  const original = Buffer.from(
    "\uFEFF---\r\ntitle: \"改行テスト\"\r\nlang: ja\r\n---\r\n\r\n## 見出し {#one}\r\n\r\n本文\r\n",
    "utf8",
  );
  await writeFile(file, original);
  await chmod(file, 0o640);
  const opened = await workspace.readDeck(created.id);
  assert.equal(opened.bom, true);
  assert.equal(opened.eol, "crlf");
  assert.equal(opened.readOnly, false);
  assert.equal(opened.source.includes("\r"), false);
  assert.equal(opened.source.startsWith("\uFEFF"), false);

  const unchanged = await workspace.saveDeck(created.id, opened.source, opened.version);
  assert.deepEqual(await readFile(file), original);
  assert.equal(unchanged.version, opened.version);

  const edited = `${opened.source}\n## 追加 {#added}\n\n追記\n`;
  const saved = await workspace.saveDeck(created.id, edited, opened.version);
  const bytes = await readFile(file);
  assert.equal(bytes[0], 0xef);
  assert.equal(bytes[1], 0xbb);
  assert.equal(bytes[2], 0xbf);
  assert.match(bytes.toString("utf8"), /\r\n/u);
  assert.equal(bytes.toString("utf8").replace(/\r\n/gu, "").includes("\n"), false);
  assert.equal(saved.eol, "crlf");
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.notEqual(saved.version, opened.version);
});

test("unchanged LF source does not rewrite the file", async (t) => {
  const root = await scratch(t);
  const workspace = await open(root);
  t.after(async () => workspace.close().catch(() => undefined));
  const created = await workspace.createDeck("無変更");
  const file = join(root, "decks", created.id, "slides.qmd");
  const before = await stat(file);

  const document = await workspace.readDeck(created.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const saved = await workspace.saveDeck(created.id, document.source, document.version);
  const after = await stat(file);
  assert.equal(saved.version, document.version);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(file, "utf8"), document.source);
});

test("close waits for an in-flight save before releasing the lock", async (t) => {
  const root = await scratch(t);
  const workspace = await open(root);
  const created = await workspace.createDeck("終了待ち");
  const file = join(root, "decks", created.id, "slides.qmd");
  const opened = await workspace.readDeck(created.id);
  const saving = workspace.saveDeck(created.id, `${opened.source}\n## 終了前の保存\n`, opened.version);
  await workspace.close();
  await saving;
  assert.match(await readFile(file, "utf8"), /終了前の保存/u);
  const reopened = await open(root);
  await reopened.close();
});

test("stale version is a conflict and never overwrites the file", async (t) => {
  const root = await scratch(t);
  const workspace = await open(root);
  t.after(async () => workspace.close().catch(() => undefined));
  const created = await workspace.createDeck("競合");
  const file = join(root, "decks", created.id, "slides.qmd");
  const opened = await workspace.readDeck(created.id);

  const external = `${opened.source}\n外部編集\n`;
  await writeFile(file, external);
  const externalVersion = createHash("sha256").update(external).digest("hex");

  await assert.rejects(
    workspace.saveDeck(created.id, `${opened.source}保存\n`, opened.version),
    (error: unknown) => codeOf(error) === "CONFLICT"
      && (error as CoreFailure).currentVersion === externalVersion,
  );
  assert.equal(await readFile(file, "utf8"), external);
});

test("mixed EOL and invalid UTF-8 are read-only and cannot be saved", async (t) => {
  const root = await scratch(t);
  const workspace = await open(root);
  t.after(async () => workspace.close().catch(() => undefined));
  const created = await workspace.createDeck("読み取り専用");
  const file = join(root, "decks", created.id, "slides.qmd");

  await writeFile(file, "a\r\nb\n");
  const mixed = await workspace.readDeck(created.id);
  assert.equal(mixed.eol, "mixed");
  assert.equal(mixed.readOnly, true);
  assert.ok(mixed.diagnostics.some((item) => item.code === "MIXED_EOL"));
  await assert.rejects(
    workspace.saveDeck(created.id, mixed.source, mixed.version),
    (error: unknown) => codeOf(error) === "READ_ONLY",
  );

  await writeFile(file, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  const invalid = await workspace.readDeck(created.id);
  assert.equal(invalid.readOnly, true);
  assert.ok(invalid.diagnostics.some((item) => item.code === "INVALID_UTF8"));
  await assert.rejects(
    workspace.saveDeck(created.id, invalid.source, invalid.version),
    (error: unknown) => codeOf(error) === "READ_ONLY",
  );

  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await writeFile(file, Buffer.concat([bom, bom, Buffer.from("---\ntitle: double\n---\n")]));
  const doubleBom = await workspace.readDeck(created.id);
  assert.equal(doubleBom.readOnly, true);
  assert.ok(doubleBom.diagnostics.some((item) => item.code === "BOM"));
  await assert.rejects(
    workspace.saveDeck(created.id, doubleBom.source, doubleBom.version),
    (error: unknown) => codeOf(error) === "READ_ONLY",
  );
});

test("rejects deck id path escapes and symlinked source files", async (t) => {
  const root = await scratch(t);
  const workspace = await open(root);
  t.after(async () => workspace.close().catch(() => undefined));
  const created = await workspace.createDeck("境界");

  await assert.rejects(workspace.readDeck("../escape"), (error: unknown) => codeOf(error) === "INVALID_INPUT");
  await assert.rejects(workspace.readDeck(".."), (error: unknown) => codeOf(error) === "INVALID_INPUT");
  for (const invalid of ["CON", "con.txt", "NUL", "a:b", "name.", "name "]) {
    await assert.rejects(
      workspace.readDeck(invalid),
      (error: unknown) => codeOf(error) === "INVALID_INPUT",
      `expected invalid deck id: ${JSON.stringify(invalid)}`,
    );
  }

  const file = join(root, "decks", created.id, "slides.qmd");
  const outside = join(root, "..", `outside-${created.id}.qmd`);
  try {
    await writeFile(outside, "---\ntitle: outside\n---\n");
    await unlink(file);
    await symlink(outside, file);
  } catch {
    t.skip("symlinks are unavailable");
    return;
  }
  t.after(async () => unlink(outside).catch(() => undefined));
  await assert.rejects(
    workspace.readDeck(created.id),
    (error: unknown) => codeOf(error) === "OUTSIDE_ROOT" || codeOf(error) === "INVALID_INPUT",
  );
});

test("reclaims a stale local lock but never removes a foreign lock", async (t) => {
  const root = await scratch(t);
  const first = await open(root);
  await first.close();

  const lockPath = join(root, "state", "workspace.lock");
  await writeFile(lockPath, JSON.stringify({
    token: "stale",
    pid: 999999,
    hostname: hostname(),
    startedAt: new Date(0).toISOString(),
  }));
  const reclaimed = await open(root);
  await reclaimed.close();
  await assert.rejects(stat(lockPath));

  await writeFile(lockPath, JSON.stringify({
    token: "foreign",
    pid: 999999,
    hostname: "another-host.invalid",
    startedAt: new Date(0).toISOString(),
  }));
  await assert.rejects(open(root), (error: unknown) => codeOf(error) === "LOCKED");
  const remaining = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
  assert.equal(remaining.token, "foreign");
  await unlink(lockPath);
});

test("parallel acquisition has exactly one owner", async (t) => {
  const root = await scratch(t);
  const settled = await Promise.allSettled([open(root), open(root)]);
  const fulfilled = settled.filter((result) => result.status === "fulfilled");
  assert.equal(fulfilled.length, 1);
  for (const result of settled) {
    if (result.status === "rejected") {
      assert.equal(codeOf(result.reason), "LOCKED");
    }
  }
  const owner = fulfilled[0];
  if (owner && owner.status === "fulfilled") await owner.value.close();
  const leftovers = (await readdir(join(root, "state")))
    .filter((name) => name.startsWith(".workspace.lock."));
  assert.deepEqual(leftovers, []);
  await assert.rejects(stat(join(root, "state", "workspace.lock")));
});

test("reclaims a lock from the same live pid after a reboot", async (t) => {
  const root = await scratch(t);
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  const lockPath = join(state, "workspace.lock");
  await writeFile(lockPath, JSON.stringify({
    token: "pid-reuse",
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date(0).toISOString(),
    bootTime: 1,
  }));
  const workspace = await open(root);
  await workspace.close();
  await assert.rejects(stat(lockPath));
});

test("unreadable lock is preserved and temp lock files are cleaned up", async (t) => {
  const root = await scratch(t);
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  const lockPath = join(state, "workspace.lock");
  await writeFile(lockPath, "{broken");
  await assert.rejects(open(root), (error: unknown) => codeOf(error) === "LOCKED");
  assert.equal(await readFile(lockPath, "utf8"), "{broken");
  const leftovers = (await readdir(state)).filter((name) => name.startsWith(".workspace.lock."));
  assert.deepEqual(leftovers, []);
  await unlink(lockPath);
});

test("removes crash-leftover Pandoc temp directories after acquiring the lock", async (t) => {
  const root = await scratch(t);
  const stale = join(root, "state", "pandoc-dead");
  await mkdir(stale, { recursive: true });
  const workspace = await open(root);
  await assert.rejects(stat(stale));
  await workspace.close();
});

test("rejects a relative workspace root and relative Pandoc path", async (t) => {
  const root = await scratch(t);
  await assert.rejects(
    openWorkspace("relative-root", { pandocPath: process.execPath }),
    (error: unknown) => codeOf(error) === "INVALID_INPUT",
  );
  await assert.rejects(
    openWorkspace(root, { pandocPath: "pandoc" }),
    (error: unknown) => codeOf(error) === "INVALID_INPUT",
  );
});
