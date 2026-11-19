import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { bundleCss, bundleHtml } from "../../packages/core/src/index.js";
import type { CoreFailure } from "../../packages/core/src/index.js";

async function scratch(t: TestContext): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "slide-studio-bundle-")));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function codeOf(error: unknown): string {
  return (error as CoreFailure).code;
}

test("bundle rejects assets outside the workspace and diagnoses external ones", async (t) => {
  const root = await scratch(t);
  const deck = join(root, "decks", "d");
  await mkdir(deck, { recursive: true });
  const outside = join(root, "..", `slide-studio-outside-${process.pid}.png`);
  t.after(async () => rm(outside, { force: true }));

  await writeFile(outside, Buffer.from([1, 2, 3]));
  try {
    await symlink(outside, join(deck, "escape.png"));
  } catch {
    t.skip("symlinks are unavailable");
    return;
  }
  assert.throws(
    () => bundleHtml('<img src="escape.png">', deck, root),
    (error: unknown) => codeOf(error) === "OUTSIDE_ROOT",
  );

  const external = bundleHtml('<img src="https://example.invalid/x.png">', deck, root);
  assert.ok(external.warnings.some((warning) => warning.code === "EXTERNAL_ASSET"));
  assert.doesNotMatch(external.html, /example\.invalid/u);
});

test("bundleCss resolves url() against its own stylesheet directory", async (t) => {
  const root = await scratch(t);
  const styles = join(root, "assets", "styles");
  await mkdir(styles, { recursive: true });
  const image = Buffer.from([5, 4, 3, 2]);
  await writeFile(join(styles, "pic.png"), image);
  const result = bundleCss('body{background:url("pic.png")}', styles, root);
  assert.ok(result.html.includes(`data:image/png;base64,${image.toString("base64")}`));
  assert.equal(result.warnings.some((warning) => warning.code === "MISSING_ASSET"), false);
});

test("inlined modules are processed once and closing tags are escaped", async (t) => {
  const root = await scratch(t);
  const deck = join(root, "decks", "d");
  await mkdir(join(deck, "assets"), { recursive: true });
  await writeFile(
    join(deck, "assets", "module.mjs"),
    'import("./dynamic.mjs");\nconst closing = "</script>";\n',
  );
  await writeFile(join(deck, "assets", "style.css"), 'body::after{content:"</style>"}\n');
  const modules = bundleHtml('<script type="module" src="assets/module.mjs"></script>', deck, root);
  assert.equal(modules.warnings.filter((warning) => warning.code === "DYNAMIC_IMPORT").length, 1);
  assert.ok(modules.html.includes("<\\/script"));
  assert.doesNotMatch(modules.html, /data-ss-bundled/u);

  const styles = bundleHtml('<link rel="stylesheet" href="assets/style.css">', deck, root);
  assert.ok(styles.html.includes("<\\/style"));
  assert.match(styles.html, /<style[^>]*>/u);
  assert.doesNotMatch(styles.html, /data-ss-bundled/u);
});
