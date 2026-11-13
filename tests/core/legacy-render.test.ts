import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import test, { type TestContext } from "node:test";
import * as cheerio from "cheerio";
import { fileURLToPath } from "node:url";
import { Workspace } from "../../packages/core/src/legacy-workspace.js";
import {
  RenderError,
  render_deck,
  render_text,
  warning_issues,
} from "../../packages/core/src/legacy-render.js";
import {
  close_pandoc,
  PandocError,
  run_pandoc,
} from "../../packages/core/src/legacy-pandoc.js";
import { parse } from "../../packages/core/src/legacy-source.js";
import {
  copy_figure,
  ensure_index,
  fig_refs,
  free_name,
  module_files,
  new_figure,
  rewrite_refs,
} from "../../packages/core/src/legacy-figures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const POSIX = process.platform !== "win32";

async function scratch(t: TestContext): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "slide-studio-legacy-render-")));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

function fakePandocScript(output: string, stderr = ""): string {
  const lines = ["#!/bin/sh", "cat >/dev/null"];
  if (stderr) {
    lines.push("cat >&2 <<'ERR'", stderr, "ERR");
  }
  lines.push("cat <<'HTML'", output, "HTML");
  return lines.join("\n");
}

const SOURCE = `---
title: "描画テスト"
topic: test
theme: night
author:
  - name: "山田 太郎"
    affiliations: ["大学"]
cover-authors-layout:
  position: right
---
## 表紙 {#cover .cover}

::: {.cover-title}
表紙
:::

# 章 {#ch1}

## 本文 {#body pdf="2"}

引用 [@alpha] と [@beta]。脚注[^1]。

[^1]: 注の本文。

{{< fig test/demo >}}

::: {.incremental}
- 一
- 二
:::

## 目次 {#toc}

::: {#toc}
:::

## 参考文献 {#references}

::: {#refs}
:::

# 付録 {#appendix}

補足。
`;

const ASSEMBLED_HTML = [
  '<h2 id="cover" class="cover">表紙</h2>',
  '<div class="cover-title"><p>表紙</p></div>',
  '<h1 id="ch1">章</h1>',
  '<h2 id="body">本文</h2>',
  '<div class="slide-studio-c" data-slide-studio="p2/0"><p>本文</p></div>',
  '<p data-cites="alpha beta">引用</p>',
  '<p data-cites="missing">欠落</p>',
  '<p><a class="footnote-ref" href="#fn1"><sup>1</sup></a>脚注</p>',
  '<p><a href="https://example.com">外部</a> <a href="#body" role="doc-biblioref">文献</a></p>',
  '<div class="animation" data-slide-studio-fig="test/demo"><iframe src="../../topics/test/html/demo/index.html"></iframe></div>',
  '<div class="incremental" data-step="2"><ul><li>一</li><li>二</li></ul></div>',
  '<p><img src="pic.png" data-step="1"></p>',
  '<h2 id="toc" class="toc-slide">目次</h2>',
  '<h2 id="references" class="refs-slide">参考文献</h2>',
  '<div id="refs"><div class="csl-entry" id="ref-alpha">Alpha <em>entry</em></div><div class="csl-entry" id="ref-beta">Beta entry</div></div>',
  '<h1 id="appendix">付録</h1>',
  '<p>補足。</p>',
  '<section class="footnotes"><ol><li id="fn1"><p>注の本文</p><a class="footnote-back">↩</a></li></ol></section>',
].join("\n");

test("warning_issues maps duplicate attributes and keeps plain Pandoc warnings", () => {
  const text = [
    "---",
    "title: T",
    "---",
    "",
    "## A {#a .x}",
    "",
    '本文 {.lead .lead data-x="1" data-x="2"}',
    "",
    '```',
    '本文 {data-x="1" data-x="2"}',
    '```',
    "",
  ].join("\n");
  const doc = parse(text);
  const rendered = {
    doc,
    warnings: [
      '[WARNING] Ignoring duplicate attribute data-x="2".',
      "[WARNING] Duplicate identifier 'a' at line 6 column 1",
    ],
    slides: [{ index: 0, page: 0 }],
  } as any;
  const issues = warning_issues(rendered);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0], {
    level: "warning",
    kind: "duplicate-attribute",
    message: '[WARNING] Ignoring duplicate attribute data-x="2".',
    attribute: "data-x",
    value: "2",
    source_offset: text.indexOf('data-x="2"'),
    source_line: 7,
    page: 0,
    slide: 0,
  });
  assert.deepEqual(issues[1], {
    level: "warning",
    kind: "pandoc",
    message: "[WARNING] Duplicate identifier 'a' at line 6 column 1",
  });

  // A group that starts in the front matter must not consume body groups.
  const spanning = [
    "---",
    "title: T",
    "affiliation: {King's College}",
    "---",
    "",
    "## A {#a}",
    "",
    '本文 {data-x="1" data-x="2"} は a\' b\' c\' }',
    "",
  ].join("\n");
  const spanningIssues = warning_issues({
    doc: parse(spanning),
    warnings: ['[WARNING] Ignoring duplicate attribute data-x="2".'],
    slides: [{ index: 0, page: 0 }],
  } as any);
  assert.equal(spanningIssues.length, 1);
  assert.equal(spanningIssues[0]!.kind, "duplicate-attribute");
  assert.equal(spanningIssues[0]!.source_offset, spanning.indexOf('data-x="2"'));

  // The legacy scanner does not mark an unclosed fence as code (source._Scan
  // records it as unclosed instead), so its attributes remain candidates.
  const unclosed = [
    "---",
    "title: T",
    "---",
    "",
    "## A {#a}",
    "",
    "```",
    '本文 {data-x="1" data-x="2"}',
    "",
  ].join("\n");
  const unclosedIssues = warning_issues({
    doc: parse(unclosed),
    warnings: ['[WARNING] Ignoring duplicate attribute data-x="2".'],
    slides: [{ index: 0, page: 0 }],
  } as any);
  assert.equal(unclosedIssues[0]!.kind, "duplicate-attribute");
  assert.equal(unclosedIssues[0]!.source_offset, unclosed.indexOf('data-x="2"'));
});

test("render_text assembles the legacy shell, collections and page structure", {
  skip: !POSIX,
}, async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("deck", "test");
  const figure = join(ws.shelf_dir("test"), "demo");
  await mkdir(figure, { recursive: true });
  await writeFile(join(figure, "figure.mjs"), "export default { title: 'デモ' };\n");

  const pandoc = join(root, "fake-pandoc");
  await writeExecutable(
    pandoc,
    fakePandocScript(
      ASSEMBLED_HTML,
      "[WARNING] line 1: test warning\nCiteproc: citation missing not found\n",
    ),
  );

  const rendered = await render_text(ws, "deck", SOURCE, { pandocPath: pandoc });
  assert.deepEqual(JSON.parse(JSON.stringify(rendered.slides)), [
    { index: 0, page: 0, id: "cover", title: "表紙", level: 2, figures: [] },
    { index: 1, page: 1, id: "ch1", title: "章", level: 1, figures: [] },
    { index: 2, page: 2, id: "body", title: "本文", level: 2, figures: ["test/demo"] },
    { index: 3, page: 3, id: "toc", title: "目次", level: 2, figures: [] },
    { index: 4, page: 4, id: "references", title: "参考文献", level: 2, figures: [] },
    { index: 5, page: 5, id: "appendix", title: "付録", level: 1, figures: [] },
  ]);
  assert.equal(rendered.version.length, 64);
  assert.deepEqual(rendered.missing_cites, ["missing"]);
  assert.deepEqual(rendered.cited, ["alpha", "beta", "missing"]);
  assert.deepEqual(rendered.unsupported, []);
  assert.equal(rendered.warnings.length, 1);
  assert.match(rendered.warnings[0]!, /test warning/u);
  assert.deepEqual(warning_issues(rendered), [
    { level: "warning", kind: "pandoc", message: rendered.warnings[0]! },
  ]);

  const $ = cheerio.load(rendered.html);
  assert.equal($("title").text(), "描画テスト");
  assert.equal($("body").attr("data-slide-studio-deck"), "deck");
  assert.equal($("style#slide-studio-base").length, 1);
  assert.equal($("link#slide-studio-theme").attr("href"), "../../themes/night.css");
  assert.equal($("link#slide-studio-deck-style").attr("href"), "styles/slides.css");
  assert.equal($("script#slide-studio-player").length, 1);
  assert.equal($("#stage > section").length, 6);

  assert.match($("#ch1").attr("class") ?? "", /section-slide/u);
  assert.equal($("#ch1").attr("data-chapter"), "01");
  assert.equal($("#ch1 h1 .chapter-number").attr("data-chapter"), "01");
  assert.equal($("#appendix .chapter-number").length, 0);
  assert.equal($("#body").attr("data-page"), "2");
  assert.equal($("#body").attr("data-pdf"), "2");
  assert.equal($("#body").attr("data-group"), "章");
  assert.equal($("#body").attr("data-section-start"), "false");

  assert.equal($("#toc .toc-list li").length, 1);
  assert.equal($("#toc .toc-number").text(), "01");
  assert.equal($("#toc .toc-label").text(), "章");

  assert.match($("#references").attr("class") ?? "", /references-slide/u);
  assert.equal($("#references .csl-entry").length, 2);

  const footer = $("#body footer.citations");
  assert.equal(footer.length, 1);
  assert.deepEqual(
    footer.find("p").toArray().map((element: any) => $(element).text().replace(/\s+/gu, " ").trim()),
    ["Alpha entry", "Beta entry", "文献が見つかりません: missing", "1注の本文"],
  );
  assert.equal($("#body .slide-studio-missing-cite").text(), "文献が見つかりません: missing");
  assert.equal($("#body a.footnote-ref").length, 0);
  assert.equal($("#body sup[data-slide-studio-footnote]").attr("data-slide-studio-footnote"), "#fn1");
  assert.equal($("#body a[role='doc-biblioref']").length, 0);

  assert.equal($("#cover .cover-authors").attr("data-affiliation-position"), "right");
  assert.match($("#cover .cover-authors").text(), /山田 太郎/u);
  assert.match($("#cover .cover-authors").text(), /大学/u);

  assert.equal($("#body li[data-step='2']").length, 1);
  assert.equal($("#body li[data-step='3']").length, 1);
  assert.equal($("#body li[data-slide-studio-step-generated='true']").length, 2);
  assert.equal($("#body p[data-step='1']").length, 1);
  assert.equal($("#body img[data-step]").length, 0);
  assert.equal($("#body p[data-slide-studio='p2/0']").length, 1);

  assert.equal($("#body iframe").attr("title"), "デモ");
  assert.equal(existsSync(join(figure, "index.html")), true);
  assert.equal($("#body .page-number").text(), "3 / 6");
  assert.equal($("#appendix .page-number").text(), "6 / 6");

  const external = $("#body a[href='https://example.com']");
  assert.equal(external.attr("target"), "_blank");
  assert.equal(external.attr("rel"), "noopener");
  assert.equal($("#body a[href='#body']").attr("target"), undefined);

  await writeFile(ws.qmd("deck"), SOURCE);
  const fromFile = await render_deck(ws, "deck", { pandocPath: pandoc });
  assert.deepEqual(JSON.parse(JSON.stringify(fromFile.slides)), JSON.parse(JSON.stringify(rendered.slides)));
});

test("front matter resource keys are audited before Pandoc", {
  skip: !POSIX,
}, async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("deck", "test");
  const stdinPath = join(root, "pandoc.stdin");
  const argsPath = join(root, "pandoc.args");
  const pandoc = join(root, "logging-pandoc");
  await writeExecutable(pandoc, [
    "#!/bin/sh",
    `cat > '${stdinPath}'`,
    `printf '%s\\n' "$@" > '${argsPath}'`,
    "cat <<'HTML'",
    '<h2 id="a">A</h2>',
    "HTML",
  ].join("\n"));

  const text = `---
title: "監査"
bibliography: /etc/passwd
csl: /etc/passwd
filters:
  - ../../evil.lua
resource-path: /etc
defaults: /etc/pandoc-defaults.yaml
references:
  - id: alpha
    title: Alpha inline
---
## A {#a}

本文。
`;
  const rendered = await render_text(ws, "deck", text, { pandocPath: pandoc });
  assert.equal(rendered.slides.length, 1);
  const stdin = await readFile(stdinPath, "utf8");
  assert.match(stdin, /title: "監査"/u);
  assert.match(stdin, /references:/u);
  assert.match(stdin, /Alpha inline/u);
  assert.doesNotMatch(stdin, /\/etc\/passwd/u);
  // `filters`/`defaults` are inert as document metadata; keeping them restores
  // Python/Quarto parity. The CLI allowlist is what prevents filter execution.
  assert.match(stdin, /evil\.lua/u);
  assert.match(stdin, /pandoc-defaults/u);

  const args = (await readFile(argsPath, "utf8")).trim().split(/\r?\n/u);
  assert.equal(args.filter((argument) => argument === "--lua-filter").length, 1);
  const filter = args[args.indexOf("--lua-filter") + 1]!;
  assert.match(filter, /slide-studio\.lua$/u);
  assert.doesNotMatch(filter, /evil/u);
  assert.equal(args.includes("--defaults"), false);
  assert.equal(args[0], "--sandbox");
  assert.equal(args[1], "--data-dir");
  assert.ok(args.includes("--bibliography"));
  const abbreviations = args.find((argument) => argument.startsWith("citation-abbreviations=/"));
  assert.ok(abbreviations);
  assert.equal(
    readFileSync(abbreviations.slice("citation-abbreviations=".length), "utf8"),
    "{\"default\":{}}\n",
  );
});

test("front matter sanitization fails closed when resource keys cannot be inspected", {
  skip: !POSIX,
}, async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("deck", "test");
  const pandoc = join(root, "never-run-pandoc");
  await writeExecutable(pandoc, "#!/bin/sh\ncat >/dev/null\nprintf '<h2>A</h2>'\n");
  const broken = `---
[
bibliography: /etc/passwd
]
---
## A {#a}

本文。
`;
  await assert.rejects(
    render_text(ws, "deck", broken, { pandocPath: pandoc }),
    /安全確認/u,
  );
});

test("front matter sanitization keeps UTF-16 offsets and handles duplicate keys", {
  skip: !POSIX,
}, async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("deck", "test");
  const stdinPath = join(root, "pandoc.stdin");
  const pandoc = join(root, "logging-pandoc");
  await writeExecutable(pandoc, [
    "#!/bin/sh",
    `cat > '${stdinPath}'`,
    "cat <<'HTML'",
    '<h2 id="a">A</h2>',
    "HTML",
  ].join("\n"));

  const astral = `---
title: "保持"
csl: "${"😀".repeat(11)}"
bibliography: /etc/passwd
theme: default
---
## A {#a}

本文。
`;
  await render_text(ws, "deck", astral, { pandocPath: pandoc });
  const astralStdin = await readFile(stdinPath, "utf8");
  assert.doesNotMatch(astralStdin, /\/etc\/passwd/u);
  assert.match(astralStdin, /^title: "保持"$/mu);
  assert.match(astralStdin, /^theme: default$/mu);
  assert.doesNotMatch(astralStdin, /😀/u);

  const duplicate = `---
title: a
title: b
"bibliography": /etc/passwd
filters: [x.lua]
---
## A {#a}

本文。
`;
  const rendered = await render_text(ws, "deck", duplicate, { pandocPath: pandoc });
  assert.equal(rendered.slides.length, 1);
  const duplicateStdin = await readFile(stdinPath, "utf8");
  assert.doesNotMatch(duplicateStdin, /\/etc\/passwd/u);
  assert.match(duplicateStdin, /filters: \[x\.lua\]/u);
});

test("CRLF input renders as the same document and keeps ordinary metadata", {
  skip: !POSIX,
}, async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("deck", "test");
  const stdinPath = join(root, "pandoc.stdin");
  const pandoc = join(root, "logging-pandoc");
  await writeExecutable(pandoc, [
    "#!/bin/sh",
    `cat > '${stdinPath}'`,
    "cat <<'HTML'",
    '<h2 id="a">A</h2>',
    "HTML",
  ].join("\n"));

  const lf = `---
title: "CRLF"
filters: [x.lua]
---
## A {#a}

本文。
`;
  const first = await render_text(ws, "deck", lf, { pandocPath: pandoc });
  const crlf = lf.replaceAll("\n", "\r\n");
  const second = await render_text(ws, "deck", crlf, { pandocPath: pandoc });
  assert.equal(second.version, first.version);
  assert.deepEqual(second.slides, first.slides);
  assert.equal(second.html, first.html);
  assert.match(await readFile(stdinPath, "utf8"), /filters: \[x\.lua\]/u);
});

test("text extraction skips ruby annotations like BeautifulSoup", {
  skip: !POSIX,
}, async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("deck", "test");
  const pandoc = join(root, "ruby-pandoc");
  await writeExecutable(
    pandoc,
    fakePandocScript([
      '<h2 id="a"><ruby>漢字<rt>かんじ</rt></ruby></h2>',
      '<p data-cites="alpha">引用</p>',
      '<h2 id="toc" class="toc-slide">目次</h2>',
      '<div id="refs"><div class="csl-entry" id="ref-alpha"><ruby>文献<rt>ぶんけん</rt></ruby></div></div>',
    ].join("\n")),
  );
  const source = `---
title: T
---
## <ruby>漢字<rt>かんじ</rt></ruby>

引用 [@alpha]。

## 目次 {#toc}

::: {#toc}
:::
`;
  const rendered = await render_text(ws, "deck", source, { pandocPath: pandoc });
  assert.equal(rendered.slides[0]!.title, "漢字");
  const $ = cheerio.load(rendered.html);
  assert.equal($("#toc .toc-label").text(), "漢字");
  assert.equal($("#a footer.citations p").first().text(), "文献");
});

test("render_text maps Pandoc failures through the wrapped-source origin map", {
  skip: !POSIX,
}, async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("deck", "test");
  const pandoc = join(root, "failing-pandoc");
  await writeExecutable(pandoc, "#!/bin/sh\ncat >/dev/null\nprintf 'line 2: boom\\n' >&2\nexit 1\n");
  await assert.rejects(
    render_text(ws, "deck", `---\ntitle: T\n---\n\n## A {#a}\n\n本文。\n`, { pandocPath: pandoc }),
    (error: unknown) =>
      error instanceof RenderError
      && error.code === "RENDER_FAILED"
      && /boom/u.test(error.message)
      && /line 2/u.test(error.message),
  );
});

test("run_pandoc isolates the environment, bounds output and cleans up on close", {
  skip: !POSIX,
}, async (t) => {
  const root = await scratch(t);
  const logs = join(root, "logs");
  await mkdir(logs, { recursive: true });
  const argsPath = join(logs, "args");
  const stdinPath = join(logs, "stdin");
  const homePath = join(logs, "home");
  const pandoc = join(root, "fake-pandoc");
  await writeExecutable(pandoc, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > '${argsPath}'`,
    `cat > '${stdinPath}'`,
    `printf '%s\\n' "$HOME" > '${homePath}'`,
    "printf 'out'",
    "printf 'warn' >&2",
  ].join("\n"));

  const temporaryDirectory = join(root, "pandoc-temp");
  const result = await run_pandoc("hello", ["--from", "markdown", "--to", "html5", "--wrap=none"], {
    pandocPath: pandoc,
    cwd: root,
    temporaryDirectory,
  });
  assert.deepEqual(result, { stdout: "out", stderr: "warn" });
  assert.equal(await readFile(stdinPath, "utf8"), "hello");
  assert.equal((await readFile(homePath, "utf8")).trim(), join(temporaryDirectory, "home"));
  assert.equal(existsSync(join(temporaryDirectory, "xdg", "config")), true);
  assert.equal(existsSync(join(temporaryDirectory, "data")), true);
  const args = (await readFile(argsPath, "utf8")).trim().split(/\r?\n/u);
  assert.equal(args[0], "--sandbox");
  assert.equal(args[1], "--data-dir");
  assert.equal(args[2], join(temporaryDirectory, "data"));
  assert.equal(args.includes("--wrap=none"), true);

  const forbiddenMarker = join(root, "forbidden-started");
  const forbiddenPandoc = join(root, "forbidden-pandoc");
  await writeExecutable(forbiddenPandoc, `#!/bin/sh\ncat >/dev/null\ntouch '${forbiddenMarker}'\n`);
  for (const forbidden of [
    ["--sandbox=false"],
    ["--sand=false"],
    ["--data-dir", join(root, "data")],
    ["-d", join(root, "defaults.yaml")],
    ["--defaults", join(root, "defaults.yaml")],
    ["-F", join(root, "filter.lua")],
    ["--filter", join(root, "filter.lua")],
    ["-o", join(root, "out.html")],
    ["--output", join(root, "out.html")],
    ["--extract-media", join(root, "media")],
    ["--log", join(root, "pandoc.log")],
    [join(root, "input.md")],
    ["--"],
    ["--from"],
    ["--lua-filter", "relative.lua"],
  ]) {
    await assert.rejects(
      run_pandoc("", forbidden, { pandocPath: forbiddenPandoc, cwd: root }),
      (error: any) => error.code === "INVALID_INPUT",
      forbidden.join(" "),
    );
  }
  assert.equal(existsSync(forbiddenMarker), false);

  const failing = join(root, "failing-pandoc");
  await writeExecutable(failing, "#!/bin/sh\ncat >/dev/null\nprintf 'line 1: boom\\n' >&2\nexit 1\n");
  await assert.rejects(
    run_pandoc("", [], { pandocPath: failing, cwd: root, temporaryDirectory }),
    (error: unknown) =>
      error instanceof PandocError
      && error.exitCode === 1
      && /boom/u.test(error.stderr),
  );

  const slow = join(root, "slow-pandoc");
  await writeExecutable(slow, "#!/bin/sh\ncat >/dev/null\nsleep 5\n");
  await assert.rejects(
    run_pandoc("", [], { pandocPath: slow, cwd: root, temporaryDirectory, timeoutMs: 100 }),
    (error: any) => error.code === "RENDER_TIMEOUT",
  );

  const overflowing = join(root, "overflowing-pandoc");
  await writeExecutable(overflowing, "#!/bin/sh\ncat >/dev/null\nyes x | head -c 1100000 >&2\n");
  await assert.rejects(
    run_pandoc("", [], { pandocPath: overflowing, cwd: root, temporaryDirectory }),
    (error: any) => error.code === "RENDER_FAILED" && /bounded/u.test(error.message),
  );

  const marker = join(root, "started");
  const closing = join(root, "closing-pandoc");
  await writeExecutable(closing, `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\nsleep 5\n`);
  const pending = run_pandoc("", [], {
    pandocPath: closing,
    cwd: root,
    temporaryDirectory,
    timeoutMs: 10_000,
  });
  const deadline = Date.now() + 3_000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(marker), true);
  await close_pandoc();
  await assert.rejects(pending, (error: any) => error.code === "BUSY");

  const quick = join(root, "quick-pandoc");
  await writeExecutable(quick, "#!/bin/sh\ncat >/dev/null\nprintf 'ok'\n");
  const after = await run_pandoc("", [], { pandocPath: quick, cwd: root, temporaryDirectory });
  assert.equal(after.stdout, "ok");
});

test("figure helpers write indexes, copy dependencies and rewrite imports", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_topic("test");
  const created = await new_figure(ws, "demo", ws.shelf_dir("test"));
  assert.equal(created, join(ws.shelf_dir("test"), "demo"));
  assert.match(await readFile(join(created, "figure.mjs"), "utf8"), /id: 'demo'/u);
  assert.match(await readFile(join(created, "figure.mjs"), "utf8"), /title: 'demo'/u);
  const index = await readFile(join(created, "index.html"), "utf8");
  assert.match(index, /\.slide-studio\/runtime\/figure\.css/u);
  assert.match(index, /<link rel="stylesheet" href="style.css">/u);
  assert.equal(await ensure_index(created, ws), false);

  await rm(join(created, "style.css"));
  assert.equal(await ensure_index(created, ws), true);
  assert.doesNotMatch(await readFile(join(created, "index.html"), "utf8"), /style\.css/u);

  await mkdir(join(ws.shelf_dir("test"), "a"));
  await mkdir(join(ws.shelf_dir("test"), "a-2"));
  assert.equal(free_name(ws.shelf_dir("test"), "a"), "a-3");

  const source = join(ws.shelf_dir("test"), "uses-lib");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "figure.mjs"), 'import {x} from "../shared/parts.mjs";\nexport default {x};\n');
  const shared = join(ws.shelf_dir("test"), "shared");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "parts.mjs"), 'import {y} from "./inner.mjs";\nexport const x = y;\n');
  await writeFile(join(shared, "inner.mjs"), "export const y = 1;\n");

  const copied = await copy_figure(ws, source, join(ws.shelf_dir("test"), ".."), "copied");
  assert.equal(copied, join(ws.shelf_dir("test"), "..", "copied"));
  assert.match(await readFile(join(copied, "figure.mjs"), "utf8"), /\.\.\/_lib\/shared-parts\.mjs/u);
  assert.equal(existsSync(join(ws.shelf_dir("test"), "..", "_lib", "shared-parts.mjs")), true);
  assert.equal(existsSync(join(ws.shelf_dir("test"), "..", "_lib", "shared-inner.mjs")), true);
  assert.match(
    await readFile(join(ws.shelf_dir("test"), "..", "_lib", "shared-parts.mjs"), "utf8"),
    /\.\/shared-inner\.mjs/u,
  );

  const withFigure = "## A\n\n{{< fig test/demo >}}\n";
  assert.deepEqual(fig_refs(withFigure), ["test/demo"]);
  assert.equal(rewrite_refs(withFigure, "test/demo", "copy/demo"),
    "## A\n\n{{< fig copy/demo >}}\n");
  const modules = module_files(source);
  assert.ok(modules.some((path) => path.endsWith("figure.mjs")));
  assert.ok(modules.some((path) => path.endsWith("shared/parts.mjs")));
  assert.ok(modules.some((path) => path.endsWith("shared/inner.mjs")));

  const outside = join(dirname(root), `outside-${Date.now()}.mjs`);
  await writeFile(outside, "export default {};\n");
  t.after(async () => rm(outside, { force: true }));
  const escaping = join(ws.shelf_dir("test"), "escaping");
  await mkdir(escaping, { recursive: true });
  let spec = relative(escaping, outside).replaceAll(sep, "/");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  await writeFile(join(escaping, "figure.mjs"), `import x from ${JSON.stringify(spec)};\n`);
  await assert.rejects(copy_figure(ws, escaping, ws.shelf_dir("test"), "bad-copy"), /置き場の外/u);
});

interface GoldenEntry {
  name: string;
  text: string;
  html: string;
  slides: Array<Record<string, unknown>>;
  version: string;
  warnings: string[];
  missing_cites: string[];
  cited: string[];
  unsupported: Array<Record<string, unknown>>;
  warning_issues: Array<Record<string, unknown>>;
}

const GOLDEN_FILE = join(ROOT, "tests/fixtures/render-parity/golden.json");

function pandocPath(): string | null {
  const candidates = [
    process.env.SLIDE_STUDIO_PANDOC,
    join(ROOT, "resources/pandoc/bin/pandoc"),
    "/opt/homebrew/bin/pandoc",
    "/usr/local/bin/pandoc",
  ].filter((value): value is string => typeof value === "string" && isAbsolute(value));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next known location.
    }
  }
  return null;
}

function normalizeNode(node: any): any {
  if (node === null || node === undefined) return null;
  if (node.type === "text") return ["#text", node.data ?? ""];
  if (node.type === "comment") return ["#comment", node.data ?? ""];
  const attrs = Object.entries(node.attribs ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  return [node.tagName, attrs, (node.children ?? []).map(normalizeNode)];
}

function stageSignature(html: string): string {
  const $ = cheerio.load(html);
  return JSON.stringify(normalizeNode($("#stage").get(0)));
}

function headSignature(html: string): Record<string, unknown> {
  const $ = cheerio.load(html);
  return {
    title: $("title").text(),
    base: $("style#slide-studio-base").text(),
    theme: [$("#slide-studio-theme").get(0)?.tagName, $("#slide-studio-theme").attr("href")],
    deckStyle: [$("#slide-studio-deck-style").get(0)?.tagName, $("#slide-studio-deck-style").attr("href")],
    deck: $("body").attr("data-slide-studio-deck"),
    player: $("#slide-studio-player").text(),
  };
}

// The isolated preview supplies fractional dimensions through its validated
// bridge. Keep every other byte of the original player comparison unchanged.
function migratedHeadSignature(html: string): Record<string, unknown> {
  const head = headSignature(html);
  head.player = String(head.player).replace('function resize() {',
    'let previewSize = null;\nfunction resize(size) {\n  if (size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0) previewSize = size;')
    .replace('const frame = window.__slideStudioFill ? window.frameElement?.getBoundingClientRect() : null;',
      'const frame = window.__slideStudioFill ? previewSize ?? window.frameElement?.getBoundingClientRect() : null;');
  return head;
}

const PANDOC = pandocPath();

test("the render differential uses native Pandoc 3.9", () => {
  assert.notEqual(PANDOC, null, "native Pandoc 3.9 is required for the render differential");
  const version = execFileSync(PANDOC!, ["--version"], { encoding: "utf8" });
  assert.match(version, /^pandoc 3\.9(?:[.\s]|$)/u);
});

test("native Pandoc ignores body bibliography metadata and keeps inline references", async (t) => {
  assert.notEqual(PANDOC, null, "native Pandoc 3.9 is required for this regression");
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("bib", "test");
  const secret = join(root, "secret.json");
  await writeFile(secret, JSON.stringify([
    {
      id: "leak",
      type: "article-journal",
      title: "LEAK-SECRET",
    },
  ]));

  const leaking = `---
title: T
---

---
bibliography: ${secret}
---

## A {#a}

[@leak]
`;
  const rendered = await render_text(ws, "bib", leaking, { pandocPath: PANDOC! });
  assert.doesNotMatch(rendered.html, /LEAK-SECRET/u);
  assert.ok(rendered.missing_cites.includes("leak"), rendered.missing_cites.join(", "));

  const inline = `---
title: T
references:
  - id: inline
    type: article-journal
    title: "Inline Entry"
---
## A {#a}

[@inline]
`;
  const withInline = await render_text(ws, "bib", inline, { pandocPath: PANDOC! });
  assert.match(withInline.html, /Inline Entry/u);
  assert.deepEqual(withInline.missing_cites, []);
});

test("the committed render golden is present at the source root", () => {
  assert.equal(existsSync(GOLDEN_FILE), true, `missing ${GOLDEN_FILE}`);
  const entries = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as GoldenEntry[];
  assert.equal(entries.length, 20);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    "callout.qmd",
    "chapter.qmd",
    "cite-multi.qmd",
    "code-heading.qmd",
    "data-step.qmd",
    "duplicate-id.qmd",
    "fig-width.qmd",
    "footnote-def.qmd",
    "formatting.qmd",
    "letter-spacing.qmd",
    "link-def.qmd",
    "math-blank.qmd",
    "math.qmd",
    "mid-paragraph-hash.qmd",
    "nested-columns.qmd",
    "no-id.qmd",
    "raw-html.qmd",
    "two-footnotes.qmd",
    "unclosed-div.qmd",
    "unknown-attrs.qmd",
  ]);
});

test("render_text matches the Python render golden", async (t) => {
  assert.notEqual(PANDOC, null, "native Pandoc 3.9 is required for the render differential");
  const GOLDEN = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as GoldenEntry[];
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("parity", "test");
  for (const entry of GOLDEN) {
    await t.test(entry.name, async () => {
      const rendered = await render_text(ws, "parity", entry.text, { pandocPath: PANDOC! });
      assert.deepEqual(JSON.parse(JSON.stringify(rendered.slides)), entry.slides, `${entry.name} slides`);
      assert.equal(rendered.version, entry.version, `${entry.name} version`);
      assert.deepEqual(rendered.warnings, entry.warnings, `${entry.name} warnings`);
      assert.deepEqual(rendered.missing_cites, entry.missing_cites, `${entry.name} missing`);
      assert.deepEqual(rendered.cited, entry.cited, `${entry.name} cited`);
      assert.deepEqual(rendered.unsupported, entry.unsupported, `${entry.name} unsupported`);
      assert.deepEqual(
        JSON.parse(JSON.stringify(warning_issues(rendered))),
        entry.warning_issues,
        `${entry.name} warning_issues`,
      );
      assert.deepEqual(headSignature(rendered.html), migratedHeadSignature(entry.html), `${entry.name} head`);
      assert.equal(stageSignature(rendered.html), stageSignature(entry.html), `${entry.name} stage`);
    });
  }
});


test("render_text retains legacy raw HTML, cover, figure and bibliography edge cases", async (t) => {
 const entries=JSON.parse(readFileSync(join(ROOT,"tests/fixtures/render-parity/edge-golden.json"),"utf8")) as (GoldenEntry & {files:Record<string,string>})[];
 for(const entry of entries) await t.test(entry.name,async()=>{
  const root=await scratch(t),ws=Workspace.open(root);ws.new_deck("parity","test");
  for(const [path,content] of Object.entries(entry.files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),content);}
  const rendered=await render_text(ws,"parity",entry.text,{pandocPath:PANDOC!});
  assert.deepEqual(JSON.parse(JSON.stringify(rendered.slides)),entry.slides);
  assert.deepEqual(rendered.warnings,entry.warnings);
  assert.deepEqual(rendered.missing_cites,entry.missing_cites);
  assert.deepEqual(rendered.cited,entry.cited);
  assert.deepEqual(rendered.unsupported,entry.unsupported);
  assert.deepEqual(JSON.parse(JSON.stringify(warning_issues(rendered))),entry.warning_issues);
  assert.deepEqual(headSignature(rendered.html),migratedHeadSignature(entry.html));
  // BeautifulSoup collapses whitespace-only nodes. Ignore their count only in
  // the empty author placeholder; visible author names/styles remain exact.
  const signature=(html:string)=>{if(entry.name!=="cover-authors")return stageSignature(html);const $=cheerio.load(html);$(".cover-authors[data-slide-studio]").each((_,el)=>{for(const child of [...el.children])if(child.type==="text"&&/^\s*$/u.test(child.data))child.data="\n";});return stageSignature($.html());};
  assert.equal(signature(rendered.html),signature(entry.html));
 });
});
