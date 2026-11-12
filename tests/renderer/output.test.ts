import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  OutputError,
  OwnedOutputDirectory,
  assertOutputAvailable,
  atomicWriteFile,
} from "../../packages/renderer/src/output.js";

async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "render-output-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

test("refuses an existing directory without modifying it", async (t) => {
  const root = await scratch(t);
  const target = join(root, "deck");
  await mkdir(target);
  await writeFile(join(target, "sentinel.txt"), "keep");

  await assert.rejects(assertOutputAvailable(target), OutputError);
  await assert.rejects(OwnedOutputDirectory.allocate(target), OutputError);
  assert.equal(await readFile(join(target, "sentinel.txt"), "utf8"), "keep");
});

test("refuses an existing file without modifying it", async (t) => {
  const root = await scratch(t);
  const target = join(root, "deck");
  await writeFile(target, "keep");

  await assert.rejects(assertOutputAvailable(target), OutputError);
  await assert.rejects(OwnedOutputDirectory.allocate(target), OutputError);
  assert.equal(await readFile(target, "utf8"), "keep");
});

test("refuses a broken symlink", async (t) => {
  const root = await scratch(t);
  const target = join(root, "deck");
  try {
    await symlink(join(root, "missing"), target);
  } catch {
    t.skip("symlinks are unavailable");
    return;
  }

  await assert.rejects(assertOutputAvailable(target), OutputError);
  await assert.rejects(OwnedOutputDirectory.allocate(target), OutputError);
  await lstat(target);
});

test("owns a new directory and removes only that directory", async (t) => {
  const root = await scratch(t);
  const target = join(root, "deck");
  const output = await OwnedOutputDirectory.allocate(target);
  await mkdir(join(output.path, "screenshots"));
  await atomicWriteFile(join(output.path, "screenshots", "p01-s0.png"), new Uint8Array([1, 2, 3]));
  assert.deepEqual(
    new Uint8Array(await readFile(join(output.path, "screenshots", "p01-s0.png"))),
    new Uint8Array([1, 2, 3]),
  );

  await output.remove();
  await assert.rejects(stat(target));
  await output.remove();
});

test("atomic writes replace the destination without leaving temporary files", async (t) => {
  const root = await scratch(t);
  const target = join(root, "deck");
  const output = await OwnedOutputDirectory.allocate(target);
  const file = join(output.path, "manifest.json");

  await atomicWriteFile(file, "first");
  await atomicWriteFile(file, "second");
  assert.equal(await readFile(file, "utf8"), "second");
  assert.deepEqual(await readdir(output.path), ["manifest.json"]);
});
