import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type {
  LegacyRenderText,
  LegacyRendered,
} from "../../packages/contracts/src/legacy.js";
import { render_text } from "../../packages/core/src/legacy-render.js";
import { parse } from "../../packages/core/src/legacy-source.js";
import { encodeSourceForDeck, sha256 } from "../../packages/core/src/source.js";
import { Workspace } from "../../packages/core/src/legacy-workspace.js";
import {
  startLegacyHost,
  type LegacyHost,
} from "../../apps/server/legacy.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function repositoryRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "tests"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`repository root not found from ${start}`);
    current = parent;
  }
}

const ROOT = repositoryRoot(HERE);

function pandocPath(): string {
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
  throw new Error("native Pandoc is required for the source/chunk tests");
}

const PANDOC = pandocPath();

interface ResponseValue {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: unknown;
}

interface RequestOptions {
  method?: string;
  json?: unknown;
}

function adminRequest(
  host: LegacyHost,
  path: string,
  options: RequestOptions = {},
): Promise<ResponseValue> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { "x-studio-token": host.token };
  let body: string | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["content-type"] = "application/json";
    headers.origin = host.adminOrigin;
  }
  const base = new URL(host.adminOrigin);
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      hostname: base.hostname,
      port: base.port,
      path,
      method,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = undefined;
        }
        resolveResponse({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text,
          json,
        });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slide-studio-legacy-source-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function createUi(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "slide-studio-legacy-source-ui-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "app.html"), "<!doctype html><title>UI</title>\n");
  await writeFile(join(directory, "app.js"), "export const app = true;\n");
  return directory;
}

async function launch(
  t: TestContext,
  renderText: LegacyRenderText = render_text,
): Promise<{ host: LegacyHost; workspace: Workspace }> {
  const root = await scratch(t);
  const workspace = Workspace.open(root);
  const uiDirectory = await createUi(t);
  const host = await startLegacyHost({
    workspace,
    uiDirectory,
    pandocPath: PANDOC,
    renderText,
    watch: false,
    shutdownGraceMs: 20,
  });
  t.after(async () => host.close());
  return { host, workspace };
}

const SOURCE = `---
title: Chunk test
topic: test
---

## 本文 {#body}

インライン数式 $a^2+b^2=c^2$ と引用 [@alpha]。

| 名前 | 値 |
|---|---|
| 一 | 二 |
| 三 | 四 |

$$
x+y
$$
`;

interface ChunkPayload {
  version: string;
  structure: {
    pages: Array<{
      chunks: Array<{ kind: string; path: string; start: number; end: number; text: string }>;
    }>;
  };
  chunks: Record<string, {
    direct: boolean;
    html: string;
    cells?: Array<Array<{ direct: boolean; html: string }>>;
  }>;
}

test("chunks GET and POST cover math, citation, table cells and never write", async (t) => {
  const { host, workspace } = await launch(t);
  workspace.new_deck("deck-1", "test");
  const path = workspace.qmd("deck-1");
  await writeFile(path, SOURCE, "utf8");

  const read = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(read.status, 200);
  const readBody = read.json as { text: string; version: string };
  const before = await readFile(path);

  const chunks = await adminRequest(host, "/api/deck/deck-1/chunks");
  assert.equal(chunks.status, 200);
  const payload = chunks.json as ChunkPayload;
  assert.equal(payload.version, readBody.version);
  assert.equal(payload.version, sha256(before));
  assert.equal(payload.structure.pages.length, 1);

  const textChunks = payload.structure.pages[0]!.chunks.filter((chunk) => chunk.kind === "text");
  const tableKey = Object.entries(payload.chunks)
    .find(([, info]) => info.cells !== undefined)?.[0];
  assert.ok(tableKey, "table chunk has cell metadata");
  const paragraphKey = Object.entries(payload.chunks)
    .find(([, info]) => info.direct)?.[0];
  assert.ok(paragraphKey, "paragraph chunk is directly editable");

  const paragraph = textChunks.find((chunk) => chunk.kind === "text")!;
  const inlineMath = payload.chunks[paragraphKey]!;
  const roundtrip = await adminRequest(host, "/api/deck/deck-1/chunks", {
    method: "POST",
    json: {
      action: "markdown",
      html: inlineMath.html,
      original: paragraph.text,
    },
  });
  assert.equal(roundtrip.status, 200);
  assert.match((roundtrip.json as { markdown: string }).markdown, /\$a\^2\+b\^2=c\^2\$/u);
  assert.match((roundtrip.json as { markdown: string }).markdown, /\[@alpha\]/u);

  const freshHeading = await adminRequest(host, "/api/deck/deck-1/chunks", {
    method: "POST",
    json: { action: "markdown", html: "<h3>新しい見出し</h3>" },
  });
  assert.equal(freshHeading.status, 200);
  assert.match((freshHeading.json as { markdown: string }).markdown, /### 新しい見出し/u);

  const cell = await adminRequest(host, "/api/deck/deck-1/chunks", {
    method: "POST",
    json: {
      action: "cell",
      text: readBody.text,
      key: tableKey,
      row: 1,
      col: 1,
      html: "<td>変更</td>",
    },
  });
  assert.equal(cell.status, 200);
  const cellText = (cell.json as { text: string }).text;
  assert.match(cellText, /変更/u);
  assert.match(cellText, /一/u);
  assert.match(cellText, /三/u);

  const html = await adminRequest(host, "/api/deck/deck-1/chunks", {
    method: "POST",
    json: {
      action: "html",
      text: readBody.text,
      base: payload.version,
      key: paragraphKey,
      html: "<p>書き換え <strong>本文</strong></p>",
    },
  });
  assert.equal(html.status, 200);
  const changed = (html.json as { text: string }).text;
  assert.match(changed, /書き換え/u);
  assert.match(changed, /\| 名前 \| 値 \|/u);
  assert.doesNotMatch(changed, /インライン数式/u);

  assert.deepEqual(await readFile(path), before, "chunk conversion must not write files");
});

test("stale chunk conversions use the bounded old render cache keyed by raw bytes", async (t) => {
  const { host, workspace } = await launch(t);
  workspace.new_deck("deck-1", "test");
  const path = workspace.qmd("deck-1");
  await writeFile(path, SOURCE, "utf8");

  const firstRead = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(firstRead.status, 200);
  const first = firstRead.json as { text: string; version: string };
  const firstChunks = await adminRequest(host, "/api/deck/deck-1/chunks");
  assert.equal(firstChunks.status, 200);
  const firstPayload = firstChunks.json as ChunkPayload;
  const key = Object.entries(firstPayload.chunks).find(([, info]) => info.direct)?.[0];
  assert.ok(key);

  const external = `${first.text}\n## 追加\n\n外部の追加。\n`;
  await writeFile(path, external, "utf8");
  const secondRead = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(secondRead.status, 200);
  const second = secondRead.json as { text: string; version: string };
  assert.notEqual(second.version, first.version);
  const secondChunks = await adminRequest(host, "/api/deck/deck-1/chunks");
  assert.equal(secondChunks.status, 200);
  assert.equal((secondChunks.json as ChunkPayload).version, second.version);

  const cached = await adminRequest(host, "/api/deck/deck-1/chunks", {
    method: "POST",
    json: {
      action: "html",
      text: first.text,
      base: first.version,
      key,
      html: "<p>古い版への編集</p>",
    },
  });
  assert.equal(cached.status, 200);
  const cachedText = (cached.json as { text: string }).text;
  assert.match(cachedText, /古い版への編集/u);
  assert.doesNotMatch(cachedText, /外部の追加/u);

  const stale = await adminRequest(host, "/api/deck/deck-1/chunks", {
    method: "POST",
    json: {
      action: "delete",
      text: first.text,
      base: "not-a-cached-version",
      key,
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(
    (stale.json as { error: string }).error,
    "表示が古いので、更新を待ってください",
  );
});

test("source saves rebase independent edits and preserve BOM/CRLF bytes", async (t) => {
  const { host, workspace } = await launch(t);
  workspace.new_deck("deck-1", "test");
  const path = workspace.qmd("deck-1");
  const originalText = "---\ntitle: Rebase\n---\n\n## One\n\none\n\n## Two\n\ntwo\n";
  const originalBytes = encodeSourceForDeck(originalText, { bom: true, eol: "crlf" });
  await writeFile(path, originalBytes);

  const read = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(read.status, 200);
  const base = read.json as { text: string; version: string };
  assert.equal(base.version, sha256(originalBytes));

  const externalText = originalText.replace("two\n", "two external\n");
  await writeFile(path, encodeSourceForDeck(externalText, { bom: true, eol: "crlf" }));

  const mine = originalText.replace("one\n", "one mine\n");
  const saved = await adminRequest(host, "/api/deck/deck-1/source", {
    method: "PUT",
    json: { text: mine, base: base.version, base_text: base.text },
  });
  assert.equal(saved.status, 200);
  const savedBody = saved.json as { version: string; text: string };
  assert.match(savedBody.text, /one mine/u);
  assert.match(savedBody.text, /two external/u);

  const bytes = await readFile(path);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(bytes.toString("utf8").includes("\r\n"));
  assert.equal(savedBody.version, sha256(bytes));

  const reread = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(reread.status, 200);
  assert.equal((reread.json as { text: string }).text, savedBody.text);
  assert.equal((reread.json as { version: string }).version, savedBody.version);

  const conflictBase = reread.json as { text: string; version: string };
  const conflictExternal = `${conflictBase.text}外部の同一行\n`;
  await writeFile(path, encodeSourceForDeck(conflictExternal, { bom: true, eol: "crlf" }));
  const conflicting = `${conflictBase.text}エディターの同一行\n`;
  const conflict = await adminRequest(host, "/api/deck/deck-1/source", {
    method: "PUT",
    json: {
      text: conflicting,
      base: conflictBase.version,
      base_text: conflictBase.text,
    },
  });
  assert.equal(conflict.status, 409);
  const conflictBody = conflict.json as { error: string; text: string; version: string };
  assert.equal(conflictBody.error, "外で変更されました");
  assert.equal(conflictBody.text, conflictExternal);
  assert.equal(conflictBody.version, sha256(await readFile(path)));
  assert.match(await readFile(path, "utf8"), /外部の同一行/u);
  assert.doesNotMatch(await readFile(path, "utf8"), /エディターの同一行/u);
});

test("deck reads migrate old block design source under the deck lock without changing bytes format", async (t) => {
  const fake: LegacyRenderText = async (_workspace, _deck, text) => {
    const rendered: LegacyRendered = {
      html: "<!doctype html><html><body><div id=\"stage\"></div></body></html>",
      slides: [],
      doc: parse(text),
      version: sha256(text),
      warnings: [],
      missing_cites: [],
      cited: [],
      unsupported: [],
      timing: {},
    };
    return rendered;
  };
  const { host, workspace } = await launch(t, fake);
  workspace.new_deck("deck-1", "test");
  const path = workspace.qmd("deck-1");
  const source = "---\ntitle: Blocks\n---\n\n## Slide\n\n::: {style=\"border: 1px solid #abcdef; padding: 1em\"}\ntext\n:::\n";
  await writeFile(path, encodeSourceForDeck(source, { bom: true, eol: "crlf" }));

  const read = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(read.status, 200);
  const body = read.json as { text: string; version: string };
  assert.match(body.text, /style="padding:1em;--block-design:plain"/u);
  assert.doesNotMatch(body.text, /border: 1px solid/u);

  const bytes = await readFile(path);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(bytes.toString("utf8").includes("\r\n"));
  assert.equal(body.version, sha256(bytes));
  assert.equal(body.text, bytes.toString("utf8").replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n"));

  const second = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(second.status, 200);
  assert.equal((second.json as { version: string }).version, body.version);
  assert.deepEqual(await readFile(path), bytes, "migration is idempotent");
});

test("deck reads use the real warning_issues helper", async (t) => {
  const warning = "[WARNING] Ignoring duplicate attribute data-x=\"2\".";
  const fake: LegacyRenderText = async (_workspace, _deck, text) => ({
    html: "<!doctype html><html><body><div id=\"stage\"></div></body></html>",
    slides: [{ index: 0, page: 0, id: "slide", title: "Slide", level: 1, figures: [] }],
    doc: parse(text),
    version: sha256(text),
    warnings: [warning],
    missing_cites: [],
    cited: [],
    unsupported: [],
    timing: {},
  });
  const { host, workspace } = await launch(t, fake);
  workspace.new_deck("deck-1", "test");
  await writeFile(
    workspace.qmd("deck-1"),
    "---\ntitle: Warnings\n---\n\n## Slide {data-x=\"1\" data-x=\"2\"}\n\nbody\n",
    "utf8",
  );

  const read = await adminRequest(host, "/api/deck/deck-1");
  assert.equal(read.status, 200);
  const issues = (read.json as {
    render: { warning_issues: Array<Record<string, unknown>> };
  }).render.warning_issues;
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    level: "warning",
    kind: "duplicate-attribute",
    message: warning,
    attribute: "data-x",
    value: "2",
    source_offset: (await readFile(workspace.qmd("deck-1"), "utf8")).indexOf('data-x="2"'),
    source_line: 5,
    page: 0,
    slide: 0,
  });
});
