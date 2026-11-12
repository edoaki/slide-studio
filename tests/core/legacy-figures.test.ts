import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test, { type TestContext } from "node:test";
import {
  copy_figure,
  module_files,
  new_figure,
} from "../../packages/core/src/legacy-figures.js";
import { Workspace } from "../../packages/core/src/legacy-workspace.js";

async function scratch(t: TestContext): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "slide-studio-legacy-figures-")));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

test("copy_figure rejects a dot name without touching the destination base", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_topic("test");
  const shelf = ws.shelf_dir("test");
  const existing = await new_figure(ws, "kept", shelf);
  const before = await readFile(join(existing, "figure.mjs"), "utf8");

  await assert.rejects(
    copy_figure(ws, existing, shelf, ".", true),
    /図の名前/u,
  );
  assert.equal(existsSync(existing), true);
  assert.equal(await readFile(join(existing, "figure.mjs"), "utf8"), before);

  await assert.rejects(
    copy_figure(ws, existing, shelf, "a/..", true),
    /図の名前/u,
  );
  assert.equal(existsSync(existing), true);
});

test("a failed replacement leaves the old figure intact", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_topic("test");
  const shelf = ws.shelf_dir("test");
  const target = await new_figure(ws, "target", shelf);
  const before = await readFile(join(target, "figure.mjs"), "utf8");

  const outside = join(dirname(root), `outside-${Date.now()}.mjs`);
  await writeFile(outside, "export default {};\n");
  t.after(async () => rm(outside, { force: true }));

  const escaping = join(shelf, "escaping");
  await mkdir(escaping, { recursive: true });
  let spec = relative(escaping, outside).replaceAll(sep, "/");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  await writeFile(join(escaping, "figure.mjs"), `import x from ${JSON.stringify(spec)};\n`);

  await assert.rejects(
    copy_figure(ws, escaping, shelf, "target", true),
    /置き場の外/u,
  );
  assert.equal(await readFile(join(target, "figure.mjs"), "utf8"), before);
});

test("a BOM-prefixed import on the first line is rewritten", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_topic("test");
  const shelf = ws.shelf_dir("test");
  const shared = join(shelf, "shared");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "parts.mjs"), "export const x = 1;\n");

  const source = join(shelf, "bom");
  await mkdir(source, { recursive: true });
  const bom = `\uFEFFimport {x} from "../shared/parts.mjs";\r\nexport default {x};\r\n`;
  await writeFile(join(source, "figure.mjs"), bom);

  const copied = await copy_figure(ws, source, shelf, "bom-copy");
  const code = readFileSync(join(copied, "figure.mjs"), "utf8");
  assert.equal(code.startsWith("\uFEFF"), true);
  assert.doesNotMatch(code, /\.\.\/shared\/parts\.mjs/u);
  assert.match(code, /\.\.\/_lib\/shared-parts\.mjs/u);
  assert.ok(code.includes("export default {x};\r\n"));
  assert.equal(existsSync(join(shelf, "_lib", "shared-parts.mjs")), true);
  assert.ok(module_files(source).some((path) => path.endsWith("shared/parts.mjs")));
});

test("new_figure escapes a title containing a single quote", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_topic("test");
  const figure = await new_figure(ws, "quoted", ws.shelf_dir("test"), "O'Reilly");
  const code = await readFile(join(figure, "figure.mjs"), "utf8");
  assert.match(code, /title: 'O\\'Reilly'/u);
});
