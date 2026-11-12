import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { layoutExpression, loadLayoutSource } from "../../packages/renderer/src/layout.js";

test("loads the bundled layout asset after changing cwd", async (t) => {
  const original = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "render-layout-test-"));
  t.after(async () => {
    process.chdir(original);
    await rm(root, { recursive: true, force: true });
  });

  process.chdir(root);
  const source = await loadLayoutSource();
  const originalAsset = await readFile(
    new URL("../../../packages/renderer/assets/layout-check.js", import.meta.url),
    "utf8",
  );

  assert.equal(source, originalAsset);
  assert.match(source, /^export const EDGE/m);
  assert.match(source, /^export function layoutIssues/m);
});

test("layoutExpression strips ESM export markers and returns layoutIssues", async () => {
  const source = await loadLayoutSource();
  const expression = layoutExpression(source, { audit: true, dx: 12 });

  assert.doesNotMatch(expression, /^export /m);
  assert.match(expression, /^\(\(\) => \{\n/);
  assert.match(expression, /function layoutIssues\(opt = \{\}\)/);
  assert.match(expression, /return layoutIssues\(\{"audit":true,"dx":12\}\);/);
  assert.doesNotThrow(() => new Function(expression));
});

test("fixture hash matches the adjacent manifest", async () => {
  const [fixture, manifestText] = await Promise.all([
    readFile(new URL("../../../tests/fixtures/render/nco-intro.html", import.meta.url)),
    readFile(new URL("../../../tests/fixtures/render/manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as { file?: unknown; sha256?: unknown };

  assert.equal(manifest.file, "nco-intro.html");
  assert.equal(typeof manifest.sha256, "string");
  assert.equal(createHash("sha256").update(fixture).digest("hex"), manifest.sha256);
});
