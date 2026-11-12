import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test, { type TestContext } from "node:test";
import { bundleCss, bundleHtml, openWorkspace } from "../../packages/core/src/index.js";
import type { CoreFailure } from "../../packages/core/src/index.js";

async function scratch(t: TestContext): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "slide-studio-render-")));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function codeOf(error: unknown): string {
  return (error as CoreFailure).code;
}

function fakePandocScript(output: string, logPath: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > '${logPath}'`,
    "cat >/dev/null",
    "cat <<'HTML'",
    output,
    "HTML",
  ].join("\n");
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

const FAKE_HTML = [
  '<h2 id="cover" class="cover">表紙</h2>',
  '<div class="cover-title"><p>表紙タイトル</p></div>',
  '<h1 id="chapter">章</h1>',
  '<h2 id="first">最初のスライド</h2>',
  '<p>本文です。</p>',
  '<p><img src="pic.png" alt="pic"></p>',
  '<p data-cites="demo">引用</p>',
  '<p><a class="footnote-ref" href="#fn1"><sup>1</sup></a>脚注</p>',
  '<iframe src="figure/index.html" title="図"></iframe>',
  '<img src="https://example.invalid/external.png" alt="external">',
  '<script type="module">import("./dynamic.mjs");</script>',
  '<div id="refs"><div class="csl-entry" id="ref-demo">Demo entry</div></div>',
  '<section class="footnotes"><ol><li id="fn1"><p>注の本文</p><a class="footnote-back">↩</a></li></ol></section>',
].join("\n");

const SOURCE = `---
title: "描画テスト"
pagetitle: "描画テスト"
lang: ja
author:
  - 山田 太郎
---

## 表紙 {#cover .cover}

::: {.cover-title}
表紙タイトル
:::

# 章

## 最初のスライド {#first}

本文です。

{{< include other.qmd >}}

{{< video https://example.invalid/video >}}

@fig-example

~~~{python}
print("x")
~~~
`;

test("renders with fixed Pandoc arguments, slides, footers, bundled assets, and diagnostics", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await scratch(t);
  const logPath = join(root, "pandoc-args.log");
  const pandoc = join(root, "fake-pandoc");
  await writeExecutable(pandoc, fakePandocScript(FAKE_HTML, logPath));

  const workspace = await openWorkspace(root, { pandocPath: pandoc });
  t.after(async () => workspace.close().catch(() => undefined));
  const created = await workspace.createDeck("描画テスト");
  const deckDir = join(root, "decks", created.id);
  await mkdir(join(deckDir, "figure"), { recursive: true });
  await mkdir(join(deckDir, "styles"), { recursive: true });
  const styleImage = Buffer.from([9, 8, 7, 6]);
  await writeFile(join(deckDir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(deckDir, "styles", "style-pic.png"), styleImage);
  await writeFile(join(deckDir, "figure", "index.html"), "<!doctype html><p>図</p><img src=\"../pic.png\">");
  await writeFile(
    join(deckDir, "styles", "slides.css"),
    '@import url("https://example.invalid/theme.css");\nbody{color:#123456;background:url("style-pic.png")}\n',
  );

  const opened = await workspace.readDeck(created.id);
  await workspace.saveDeck(created.id, SOURCE, opened.version);

  const preview = await workspace.renderDeck(created.id);
  assert.match(preview.version, /^[0-9a-f]{64}$/u);
  assert.equal(preview.slides.length, 4);
  assert.deepEqual(preview.slides.map((slide) => slide.level), [2, 1, 2, 2]);
  assert.equal(preview.slides[1]?.id, "chapter");
  assert.equal(preview.slides[2]?.title, "最初のスライド");
  assert.equal(preview.slides[3]?.id, "references");

  assert.match(preview.html, /<section class="slide section-slide" id="chapter"/u);
  assert.match(preview.html, /class="slide cover"/u);
  assert.match(preview.html, /class="page-number">1 \/ 4/u);
  assert.match(preview.html, /class="chapter-number"/u);
  assert.match(preview.html, /id="slide-studio-player"/u);
  assert.match(preview.html, /id="slide-studio-base"/u);
  assert.match(preview.html, /data:image\/png;base64/u);
  assert.ok(preview.html.includes(`data:image/png;base64,${styleImage.toString("base64")}`));
  assert.match(preview.html, /srcdoc=/u);
  assert.match(preview.html, /data-page="3"/u);
  assert.match(preview.html, /Demo entry/u);
  assert.match(preview.html, /注の本文/u);
  assert.match(preview.html, /cover-authors/u);
  assert.doesNotMatch(preview.html, /https:\/\/example\.invalid\/external\.png/u);
  assert.doesNotMatch(preview.html, /@import/u);

  const codes = new Set(preview.warnings.map((warning) => warning.code));
  assert.ok(codes.has("UNSUPPORTED_INCLUDE"));
  assert.ok(codes.has("UNSUPPORTED_SHORTCODE"));
  assert.ok(codes.has("UNSUPPORTED_CROSSREF"));
  assert.ok(codes.has("UNSUPPORTED_EXECUTABLE"));
  assert.ok(codes.has("EXTERNAL_ASSET"));
  assert.ok(codes.has("CSS_IMPORT"));
  assert.ok(codes.has("DYNAMIC_IMPORT"));
  assert.equal(codes.has("MISSING_ASSET"), false);

  const args = (await readFile(logPath, "utf8")).trim().split(/\r?\n/u);
  for (const required of ["--sandbox", "--mathml", "--wrap=none", "--citeproc"]) {
    assert.ok(args.includes(required), `missing Pandoc argument ${required}`);
  }
  assert.equal(
    args[args.indexOf("--from") + 1],
    "markdown-yaml_metadata_block-pandoc_title_block+fenced_divs+tex_math_dollars",
  );
  assert.equal(args[args.indexOf("--to") + 1], "html5");
  assert.ok((args[args.indexOf("--data-dir") + 1]?.length ?? 0) > 0);
  assert.match(args[args.indexOf("--lua-filter") + 1] ?? "", /slide-studio\.lua$/u);
  assert.match(args[args.indexOf("--csl") + 1] ?? "", /numeric\.csl$/u);
  assert.ok(args.some((argument) => argument.startsWith("title=")));
});

test("render failure preserves the raw QMD and reports RENDER_FAILED", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await scratch(t);
  const failing = join(root, "failing-pandoc");
  await writeExecutable(failing, "#!/bin/sh\ncat >/dev/null\necho 'line 2: boom' >&2\nexit 1\n");

  const workspace = await openWorkspace(root, { pandocPath: failing });
  t.after(async () => workspace.close().catch(() => undefined));
  const created = await workspace.createDeck("失敗");
  const opened = await workspace.readDeck(created.id);
  const before = await readFile(join(root, "decks", created.id, "slides.qmd"));

  await assert.rejects(
    workspace.renderDeck(created.id),
    (error: unknown) => codeOf(error) === "RENDER_FAILED" && /boom/u.test((error as Error).message),
  );
  const after = await readFile(join(root, "decks", created.id, "slides.qmd"));
  assert.deepEqual(after, before);
  assert.equal((await workspace.readDeck(created.id)).version, opened.version);
});

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

const REAL_PANDOC = process.env.SLIDE_STUDIO_PANDOC;

test("real Pandoc opt-in render ignores body-level metadata", { skip: !REAL_PANDOC }, async (t) => {
  const pandoc = REAL_PANDOC;
  assert.ok(pandoc, "SLIDE_STUDIO_PANDOC must be set");
  assert.ok(isAbsolute(pandoc), "SLIDE_STUDIO_PANDOC must be absolute");
  const root = await scratch(t);
  const workspace = await openWorkspace(root, { pandocPath: pandoc });
  t.after(async () => workspace.close().catch(() => undefined));
  const created = await workspace.createDeck("実Pandoc");
  const opened = await workspace.readDeck(created.id);
  const source = `${opened.source}
---
bibliography: /etc/passwd
nocite: "@*"
suppress-bibliography: true
---

## 追記 {#extra}

本文です。
`;
  await workspace.saveDeck(created.id, source, opened.version);
  const preview = await workspace.renderDeck(created.id);
  assert.ok(preview.slides.length >= 3);
  assert.match(preview.html, /id="slide-studio-player"/u);
});
