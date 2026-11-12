import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  close_pandoc,
  run_pandoc,
} from "../../packages/core/src/legacy-pandoc.js";

async function scratch(t: TestContext): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "slide-studio-legacy-pandoc-")));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function waitFor(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(path), true, `timed out waiting for ${path}`);
}

test("close_pandoc cancels runs that start while it is waiting", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await scratch(t);
  const firstMarker = join(root, "first-started");
  const secondMarker = join(root, "second-started");
  const firstPandoc = join(root, "first-pandoc");
  const secondPandoc = join(root, "second-pandoc");
  // Ignore SIGTERM so close_pandoc is still awaiting the hard kill when the
  // second run starts.
  await writeExecutable(firstPandoc, [
    "#!/bin/sh",
    "trap '' TERM",
    "cat >/dev/null",
    `touch '${firstMarker}'`,
    "while :; do sleep 1; done",
  ].join("\n"));
  await writeExecutable(secondPandoc, [
    "#!/bin/sh",
    "trap '' TERM",
    "cat >/dev/null",
    `touch '${secondMarker}'`,
    "while :; do sleep 1; done",
  ].join("\n"));

  const firstRun = run_pandoc("", [], {
    pandocPath: firstPandoc,
    cwd: root,
    timeoutMs: 10_000,
  });
  const firstRejected = assert.rejects(firstRun, (error: any) => error.code === "BUSY");
  await waitFor(firstMarker);

  const closing = close_pandoc();
  const secondRun = run_pandoc("", [], {
    pandocPath: secondPandoc,
    cwd: root,
    timeoutMs: 10_000,
  });
  const secondRejected = assert.rejects(secondRun, (error: any) => error.code === "BUSY");
  await waitFor(secondMarker);
  await closing;

  const closingAgain = close_pandoc();
  await firstRejected;
  await secondRejected;
  await closingAgain;
});
