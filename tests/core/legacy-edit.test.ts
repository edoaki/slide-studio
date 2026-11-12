import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import * as cheerio from "cheerio";
import {
  cell_markdown,
  cells_to_markdown,
  chunk_info,
  prepared_html,
  table_cells,
  to_markdown,
  type ChunkEditInfo,
  type ChunkEditMap,
  type LegacyEditOptions,
} from "../../packages/core/src/legacy-edit.js";
import {
  image_options,
  locate,
  move_chunk,
  parse,
  rewrite,
  set_cell,
  table_rows,
  ValueError,
  codePointLength,
  type Chunk,
  type Doc,
} from "../../packages/core/src/legacy-source.js";
import { render_text } from "../../packages/core/src/legacy-render.js";
import { Workspace } from "../../packages/core/src/legacy-workspace.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function repositoryRoot(start: string): string {
  let current = start;
  for (;;) {
    if (
      existsSync(join(current, "package.json"))
      && existsSync(join(current, "tests", "fixtures"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`repository root not found from ${start}`);
    current = parent;
  }
}

const ROOT = repositoryRoot(HERE);
const SYNC = join(ROOT, "tests/fixtures/sync");
const NCO = join(ROOT, "tests/fixtures/nco-intro");
const EDIT_GOLDEN = join(ROOT, "tests/fixtures/edit-parity/golden.json");
const RENDER_GOLDEN = join(ROOT, "tests/fixtures/render-parity/golden.json");

function source(name: string): string {
  return readFileSync(join(SYNC, name), "utf8");
}

function cpSlice(value: string, start: number, end: number): string {
  return Array.from(value).slice(start, end).join("");
}

async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slide-studio-legacy-edit-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function addDeck(ws: Workspace, deck: string, bib = ""): void {
  ws.new_deck(deck, "test");
  if (bib) writeFileSync(ws.bib(deck), bib, "utf8");
}

function installNco(ws: Workspace, deck: string): void {
  ws.new_deck(deck, "test");
  const text = readFileSync(join(NCO, "slides.qmd"), "utf8");
  const withTopic = text.replace(/^---\n/u, "---\ntopic: test\n");
  writeFileSync(ws.qmd(deck), withTopic, "utf8");
  writeFileSync(ws.bib(deck), readFileSync(join(NCO, "reference.bib"), "utf8"), "utf8");
}

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

const PANDOC = pandocPath();

function requirePandoc(): string {
  assert.notEqual(PANDOC, null, "native Pandoc 3.9 is required for the edit differential");
  return PANDOC!;
}

function editOptions(cwd = ROOT): LegacyEditOptions {
  return { pandocPath: requirePandoc(), cwd };
}

interface ExpectedRow {
  cells: string[];
}

function expectedRows(): ExpectedRow[] {
  const rows: ExpectedRow[] = [];
  for (const line of source("expected.md").split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| ファイル") || line.startsWith("|---")) {
      continue;
    }
    rows.push({
      cells: line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim()),
    });
  }
  return rows;
}

test("roundtrip and isolated changes preserve every untouched source byte", () => {
  const fixtures = readdirSync(SYNC).filter((name) => name.endsWith(".qmd")).sort();
  assert.deepEqual(
    [...new Set(expectedRows().map((row) => row.cells[0]!))].sort(),
    fixtures,
  );
  for (const name of fixtures) {
    const text = source(name);
    const doc = parse(text);
    assert.equal(rewrite(doc), text, name);
    for (const page of doc.pages) {
      for (const chunk of page.walk()) {
        if (chunk.kind !== "text") continue;
        const key = `p${page.index}/${chunk.path}`;
        const changed = rewrite(doc, { [key]: cpSlice(text, chunk.start, chunk.end) + "変更" });
        assert.equal(cpSlice(changed, 0, chunk.start), cpSlice(text, 0, chunk.start), name);
        assert.equal(
          cpSlice(changed, chunk.end + 2, codePointLength(changed)),
          cpSlice(text, chunk.end, codePointLength(text)),
          name,
        );
        assert.equal(cpSlice(changed, 0, page.start), cpSlice(text, 0, page.start), name);
        assert.equal(
          cpSlice(changed, page.end + 2, codePointLength(changed)),
          cpSlice(text, page.end, codePointLength(text)),
          name,
        );
      }
    }
  }
});

test("chunk_info marks exactly the legacy direct-edit exclusions", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test");
  const cache = new Map<string, { doc: Doc; info: ChunkEditMap }>();

  for (const row of expectedRows()) {
    if (row.cells.length !== 7 || !row.cells[0]!.endsWith(".qmd")) continue;
    const name = row.cells[0]!;
    const pageIndex = Number(row.cells[2]);
    const disabled = row.cells[6] ? row.cells[6].split(/\s+/u).filter(Boolean) : [];
    if (!cache.has(name)) {
      const rendered = await render_text(ws, "test", source(name), { pandocPath: pandoc });
      const info = await chunk_info(rendered, {
        pandocPath: pandoc,
        cwd: ws.deck_dir("test"),
      });
      cache.set(name, { doc: rendered.doc, info });
    }
    const { doc, info } = cache.get(name)!;
    const page = doc.pages[pageIndex]!;
    const actual = [...page.walk()]
      .filter((chunk) => chunk.kind === "text" && !info[`p${pageIndex}/${chunk.path}`]!.direct)
      .map((chunk) => chunk.path);
    assert.deepEqual(actual, disabled, name);
  }
});

test("every text chunk in the nco fixture can be changed and restored", async (t) => {
  const ws = Workspace.open(await scratch(t));
  installNco(ws, "nco-intro");
  const text = readFileSync(ws.qmd("nco-intro"), "utf8");
  const doc = parse(text);
  for (const page of doc.pages) {
    for (const chunk of page.walk()) {
      if (chunk.kind !== "text") continue;
      const key = `p${page.index}/${chunk.path}`;
      const original = cpSlice(text, chunk.start, chunk.end);
      const changed = rewrite(doc, { [key]: original + "追記" });
      assert.equal(rewrite(parse(changed), { [key]: original }), text, key);
    }
  }
});

test("nested moves, definitions and raw-only pages keep their legacy behaviour", () => {
  let text = source("nested-columns.qmd");
  let doc = parse(text);
  const chunk = locate(doc, "p0/0.1.1.0")[1];
  const changed = rewrite(doc, { "p0/0.1.1.0": "変更" });
  assert.equal(locate(parse(changed), "p0/0.1.1.0")[1].kind, "text");
  assert.equal(
    changed,
    cpSlice(text, 0, chunk.start) + "変更" + cpSlice(text, chunk.end, codePointLength(text)),
  );

  const moved = move_chunk(doc, "p0/0.0.1", 0, "p0/0.0.0");
  const newDoc = parse(moved);
  const oldLeft = locate(doc, "p0/0.0.1")[1];
  const newLeft = locate(newDoc, "p0/0.0.0")[1];
  assert.equal(cpSlice(moved, newLeft.start, newLeft.end), cpSlice(text, oldLeft.start, oldLeft.end));
  const oldRight = locate(doc, "p0/0.1")[1];
  const newRight = locate(newDoc, "p0/0.1")[1];
  assert.equal(cpSlice(moved, newRight.start, newRight.end), cpSlice(text, oldRight.start, oldRight.end));
  assert.throws(
    () => move_chunk(doc, "p0/0", 0, "p0/0.0.0"),
    (error: unknown) => error instanceof ValueError,
  );

  text = source("link-def.qmd") + "\n## 次 {#next}\n\n次の段落。\n";
  doc = parse(text);
  let definition = "";
  for (const candidate of doc.pages[0]!.chunks) {
    if (candidate.kind === "def") {
      definition = cpSlice(text, candidate.start, candidate.end);
      break;
    }
  }
  const withDefinition = move_chunk(doc, "p0/2", 1);
  assert.ok(withDefinition.includes(definition));
  assert.equal(parse(withDefinition).pages[1]!.chunks.length, 2);

  const raw = source("unclosed-div.qmd");
  assert.ok(rewrite(parse(raw), { "p0/0": "編集" }));
  assert.throws(
    () => move_chunk(parse(raw), "p0/0", 1),
    (error: unknown) => error instanceof ValueError,
  );
  const fixed = raw + "\n:::\n";
  assert.equal(parse(fixed).pages.some((page) => page.raw_only), false);
});

test("image options keep unknown attributes and preserve an existing width", () => {
  const doc = parse('## A\n\n![alt](images/a.png){#img .x width=200 title="a"}\n');
  const result = image_options(doc, "p0/0", 320, "right");
  assert.match(result, /#img \.x/u);
  assert.match(result, /title="a"/u);
  assert.match(result, /width=320/u);
  assert.match(result, /fig-align="right"/u);
  const aligned = image_options(parse(result), "p0/0", null, "left");
  assert.match(aligned, /width=320/u);
  assert.match(aligned, /fig-align="left"/u);
  assert.doesNotMatch(aligned, /fig-align="right"/u);
});

test("atoms survive text edits without changing their source spelling", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  for (const name of ["cite-multi", "two-footnotes", "math"]) {
    const rendered = await render_text(ws, "test", source(`${name}.qmd`), { pandocPath: pandoc });
    const info = await chunk_info(rendered, options);
    const html = info["p0/0"]!.html;
    assert.ok(html, name);
    const markdown = await to_markdown(html.replaceAll("</p>", "追記</p>"), "", options);
    const chunk = rendered.doc.pages[0]!.chunks[0]!;
    assert.equal(
      markdown,
      cpSlice(rendered.doc.text, chunk.start, chunk.end) + "追記",
      name,
    );
  }
});

test("literal atom syntax does not break real atoms", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test", "@misc{a, title={Alpha}, year={2020}}\n");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const literals = [
    "`@code [^code] $code$`",
    "``@code ` [^code] $code$``",
    "`@code\n[^code] $code$`",
    "\\@code \\[^code] \\$code\\$",
    "$ literal `@code [^code] $code$` $",
    "$literal `@code [^code]`$2",
  ];
  for (const [index, literal] of literals.entries()) {
    await t.test(`literal ${index}`, async () => {
      const body = literal + " と [@a] と脚注[^a] と $x$ と本文";
      const text = `---\ntopic: test\n---\n## 本文\n\n${body}\n\n[^a]: 注です\n`;
      const rendered = await render_text(ws, "test", text, { pandocPath: pandoc });
      const html = (await chunk_info(rendered, options))["p0/0"]!.html;
      const $ = cheerio.load(html);
      const atoms = $("[data-slide-studio-atom]").toArray()
        .map((element: any) => $(element).attr("data-slide-studio-atom"));
      assert.deepEqual(atoms, ["[@a]", "[^a]", "$x$"]);
      const edited = await to_markdown(html.replaceAll("本文", "変更"), "", options);
      assert.match(edited, /\[@a\]/u);
      assert.match(edited, /\[\^a\]/u);
      assert.match(edited, /\$x\$/u);
      assert.match(edited, /変更/u);
    });
  }
});

test("a backtick inside maths does not hide following atoms", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test", "@misc{a, title={Alpha}, year={2020}}\n");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  for (const prefix of ["", "\\\\"]) {
    const body = prefix + "$x`$ と `@code [^code]` と [@a] と脚注[^a] と本文";
    const text = `---\ntopic: test\n---\n## 本文\n\n${body}\n\n[^a]: 注です\n`;
    const rendered = await render_text(ws, "test", text, { pandocPath: pandoc });
    const html = (await chunk_info(rendered, options))["p0/0"]!.html;
    const edited = await to_markdown(html.replaceAll("本文", "変更"), "", options);
    assert.match(edited, /\$x`\$/u);
    assert.match(edited, /\[@a\]/u);
    assert.match(edited, /\[\^a\]/u);
  }
});

test("narrative citations keep punctuation, locators and links", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(
    ws,
    "test",
    "@misc{a, title={Alpha}, year={2020}}\n@misc{a.b, title={Beta}, year={2021}}\n",
  );
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const citations = [
    "@a.", "@a:", "@a;", "@a!", "@a.b.", "-@a.",
    "@a [p. 2].", "-@a [pp. 2–3].",
    "https://example.com/@a.", "@a [site](relative/path).", "[@a, p. $x$].",
  ];
  for (const citation of citations) {
    const body = `See ${citation} Text`;
    const rendered = await render_text(
      ws,
      "test",
      `---\ntopic: test\n---\n## Body\n\n${body}\n`,
      { pandocPath: pandoc },
    );
    const html = (await chunk_info(rendered, options))["p0/0"]!.html;
    assert.equal(
      await to_markdown(html.replaceAll("Text", "Changed"), "", options),
      body.replaceAll("Text", "Changed"),
      citation,
    );
  }
});

test("at signs in links or maths do not break real citations", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test", "@misc{a, title={Alpha}, year={2020}}\n");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const literals = [
    "<https://example.com/@a>",
    "[site](https://example.com/@a)",
    "[site](https://example.com/(foo)/@a)",
    '[site](relative/@a "title (and @a)")',
    "$x_{@a}$",
  ];
  for (const literal of literals) {
    const body = `See [@a] with ${literal} and note[^n]. Text`;
    const rendered = await render_text(
      ws,
      "test",
      `---\ntopic: test\n---\n## Body\n\n${body}\n\n[^n]: Note\n`,
      { pandocPath: pandoc },
    );
    const html = (await chunk_info(rendered, options))["p0/0"]!.html;
    assert.equal(
      await to_markdown(html.replaceAll("Text", "Changed"), "", options),
      body.replaceAll("Text", "Changed"),
      literal,
    );
  }
});

test("a footnote after a narrative citation is not a locator", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test", "@misc{a, title={Alpha}, year={2020}}\n");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const body = "See @a [^n]. Text";
  const rendered = await render_text(
    ws,
    "test",
    `---\ntopic: test\n---\n## Body\n\n${body}\n\n[^n]: Note\n`,
    { pandocPath: pandoc },
  );
  const html = (await chunk_info(rendered, options))["p0/0"]!.html;
  assert.equal(
    await to_markdown(html.replaceAll("Text", "Changed"), "", options),
    body.replaceAll("Text", "Changed"),
  );
});

test("an invalid link keeps real citations", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(
    ws,
    "test",
    "@misc{a, title={Alpha}, year={2020}}\n@misc{b, title={Beta}, year={2021}}\n",
  );
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const body = 'See [@a] with [site](relative/@b "a" tail). Text';
  const rendered = await render_text(
    ws,
    "test",
    `---\ntopic: test\n---\n## Body\n\n${body}\n`,
    { pandocPath: pandoc },
  );
  const html = (await chunk_info(rendered, options))["p0/0"]!.html;
  const $ = cheerio.load(html);
  assert.deepEqual(
    $(".citation").toArray().map((element: any) => $(element).attr("data-slide-studio-atom")),
    ["[@a]", "@b"],
  );
  const edited = await to_markdown(html.replaceAll("Text", "Changed"), "", options);
  assert.match(edited, /\[@a\]/u);
  assert.match(edited, /@b/u);
  assert.match(edited, /Changed/u);
});

test("padded citation with trailing space round-trips through direct editing", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  installNco(ws, "nco-intro");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("nco-intro") };
  const text = readFileSync(ws.qmd("nco-intro"), "utf8");
  const raw = text.split("\n").find((line) => line.startsWith("制約を満たす"))!;
  const padded = '::: {style="padding:0px 12px 71px 12px"}\n' + raw + " \t\n:::";
  const rendered = await render_text(ws, "nco-intro", text.split(raw).join(padded), {
    pandocPath: pandoc,
  });
  let page: any = null;
  let chunk: Chunk | null = null;
  for (const candidatePage of rendered.doc.pages) {
    for (const candidate of candidatePage.walk()) {
      if (
        candidate.kind === "text"
        && cpSlice(rendered.doc.text, candidate.start, candidate.end) === raw + " \t"
      ) {
        page = candidatePage;
        chunk = candidate;
      }
    }
  }
  assert.notEqual(page, null);
  assert.notEqual(chunk, null);
  const info = (await chunk_info(rendered, options))[`p${page.index}/${chunk!.path}`]!;
  assert.equal(info.direct, true);
  const original = cpSlice(rendered.doc.text, chunk!.start, chunk!.end);
  assert.equal(await to_markdown(info.html, original, options), original);
  assert.equal(
    await to_markdown(info.html.replaceAll("制約を満たす", "条件を満たす"), original, options),
    original.replaceAll("制約を満たす", "条件を満たす"),
  );
});

test("formatting spans keep supported colours and sizes only", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const text = '## A {#a}\n\n[強調]{.accent}と[注意 **太字**]{.warn}と[赤]{style="color: #e5484d"}と'
    + '[大きい]{style="font-size: 1.25em"}と[両方]{.good style="font-size: 0.75em"}。\n';
  const rendered = await render_text(ws, "test", text, { pandocPath: pandoc });
  assert.equal((await chunk_info(rendered, options))["p0/0"]!.direct, true);
  assert.equal(
    await to_markdown('<p><span style="font-family: serif">字</span></p>', "", options),
    "字",
  );
});

test("plain newlines stay in one editable block", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const body = "**Open**：拠点に戻らなくてよい　**Multi-Depot**：拠点が複数ある\n"
    + "**Skill**：能力による適合制約　**Time Window**：時間窓制約";
  const rendered = await render_text(ws, "test", `## A {#a}\n\n${body}\n\n別のブロック\n`, {
    pandocPath: pandoc,
  });
  assert.equal(rendered.doc.pages[0]!.chunks.length, 2);
  const info = await chunk_info(rendered, options);
  assert.equal(info["p0/0"]!.direct, true);
  assert.equal(info["p0/1"]!.direct, true);
  const block = cheerio.load(info["p0/0"]!.html);
  assert.equal(block("p").length, 1);
  assert.equal(block("br").length, 1);
  assert.deepEqual(
    block("strong").toArray().map((element: any) => block(element).text()),
    ["Open", "Multi-Depot", "Skill", "Time Window"],
  );
  const changed = await to_markdown(info["p0/0"]!.html.replaceAll("能力", "技能"), body, options);
  const updated = await render_text(ws, "test", `## A {#a}\n\n${changed}\n`, {
    pandocPath: pandoc,
  });
  assert.equal(updated.doc.pages[0]!.chunks.length, 1);
  assert.equal(
    cheerio.load(updated.html)('[data-slide-studio="p0/0"] br').length,
    1,
  );
});

test("cover title and subtitle wrappers are directly editable", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const text = '---\ntitle: "発表"\ntopic: test\ntheme: default\n---\n\n## 発表 {#cover .cover}\n\n'
    + '::: {.cover-title}\n発表<br>タイトル\n:::\n\n::: {.cover-subtitle style="padding: 8px"}\n副題\n:::\n\n# 章 {#c}\n';
  const rendered = await render_text(ws, "test", text, { pandocPath: pandoc });
  const chunks = [...rendered.doc.pages[0]!.walk()].map((chunk) => [chunk.path, chunk.kind]);
  assert.deepEqual(chunks, [["0", "box"], ["0.0", "text"], ["1", "box"], ["1.0", "text"]]);
  const info = await chunk_info(rendered, options);
  assert.equal(info["p0/0.0"]!.direct, true);
  assert.equal(info["p0/1.0"]!.direct, true);
  assert.equal(
    await to_markdown(info["p0/0.0"]!.html, "発表<br>タイトル", options),
    "発表\\\nタイトル",
  );
});

const TABLE = `## 表

| 項目 | 方式 [@a] | $x|y$ |
|:---|---:|---|
| 成功率<br>（数） | **100%** | - |
|  | a \\| b | \`c|d\` |
`;

async function tableFixture(
  ws: Workspace,
  options: LegacyEditOptions,
): Promise<{ doc: Doc; info: ChunkEditInfo; html: string }> {
  const rendered = await render_text(ws, "test", TABLE, { pandocPath: options.pandocPath });
  const info = await chunk_info(rendered, options);
  return { doc: rendered.doc, info: info["p0/0"]!, html: rendered.html };
}

test("table rows follow Pandoc cell splitting", () => {
  const raw = TABLE.split("\n\n", 2)[1]!.trim();
  const rows = table_rows(raw);
  assert.notEqual(rows, null);
  assert.deepEqual(
    rows!.map((row) => row.map(([start, end]) => cpSlice(raw, start, end).trim())),
    [
      ["項目", "方式 [@a]", "$x|y$"],
      ["成功率<br>（数）", "**100%**", "-"],
      ["", "a \\| b", "`c|d`"],
    ],
  );
  assert.equal(table_rows("普通の段落"), null);
  assert.equal(table_rows("a\n---"), null);
});

test("table cells can be edited one by one", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const { doc, info, html } = await tableFixture(ws, options);
  assert.equal(info.direct, false);
  assert.equal(info.cells!.every((row) => row.every((cell) => cell.direct)), true);
  assert.match(info.cells![0]![1]!.html, /data-slide-studio-atom="\[@a\]"/u);

  const tableChunk = locate(doc, "p0/0")[1];
  const rawTable = cpSlice(doc.text, tableChunk.start, tableChunk.end);
  const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);
  const tableNode = $('[data-slide-studio="p0/0"]').first().get(0)
    ?? $("table").first().get(0);
  assert.notEqual(tableNode, undefined);
  const directCells = table_cells(tableNode, rawTable, options);
  assert.notEqual(directCells, null);
  assert.equal(directCells!.every((row) => row.every((cell) => cell.direct)), true);

  const cases: Array<[string, string]> = [
    ["<td>新しい</td>", "| 新しい | 方式 [@a] |"],
    [
      '<td><strong>太</strong>と<span style="font-size: 1.2em">大</span></td>',
      '| **太**と[大]{style="font-size: 1.2em"} | 方式 [@a] |',
    ],
    ["<th>一<br>二<br><br></th>", "| 一<br>二 | 方式 [@a] |"],
    ["<td>a|b</td>", "| a\\|b | 方式 [@a] |"],
  ];
  for (const [html, expected] of cases) {
    const out = set_cell(doc, "p0/0", 0, 0, await cell_markdown(html, options));
    assert.ok(out.includes(expected), out);
    assert.deepEqual(out.split("\n").slice(3), doc.text.split("\n").slice(3));
  }
});

test("empty cells get text and invalid cells are rejected", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const { doc } = await tableFixture(ws, options);
  assert.ok(set_cell(doc, "p0/0", 2, 0, "埋めた").includes("| 埋めた | a \\| b |"));
  assert.throws(
    () => set_cell(doc, "p0/0", 9, 0, "x"),
    (error: unknown) => error instanceof ValueError,
  );
});

test("table cell conversion does not require identical markdown", async (t) => {
  const pandoc = requirePandoc();
  const ws = Workspace.open(await scratch(t));
  addDeck(ws, "test");
  const options = { pandocPath: pandoc, cwd: ws.deck_dir("test") };
  const raw = '## 表\n\n| 名前 | 説明 |\n|---|---|\n| [色]{style="color: #c00;"} | 複数   空白 |\n';
  const rendered = await render_text(ws, "test", raw, { pandocPath: pandoc });
  const info = (await chunk_info(rendered, options))["p0/0"]!;
  assert.equal(info.cells!.every((row) => row.every((cell) => cell.direct && cell.html)), true);
  assert.match(
    await cell_markdown(info.cells![1]![1]!.html.replaceAll("空白", "変更"), options),
    /変更/u,
  );
});

interface EditGolden {
  chunks: Array<{ name: string; chunks: ChunkEditMap }>;
  markdown: Array<{ html: string; original: string; markdown: string }>;
  cells: Array<{ html: string; markdown: string }>;
}

interface RenderGolden {
  name: string;
  text: string;
  html: string;
}

test("the committed edit fixtures are present and complete", () => {
  assert.equal(existsSync(EDIT_GOLDEN), true, `missing ${EDIT_GOLDEN}`);
  assert.equal(existsSync(RENDER_GOLDEN), true, `missing ${RENDER_GOLDEN}`);
  const edit = JSON.parse(readFileSync(EDIT_GOLDEN, "utf8")) as EditGolden;
  assert.equal(edit.chunks.length, 20);
  assert.equal(edit.markdown.length, 4);
  assert.equal(edit.cells.length, 5);
});

test("chunk_info matches all committed chunk goldens", async () => {
  const edit = JSON.parse(readFileSync(EDIT_GOLDEN, "utf8")) as EditGolden;
  const render = JSON.parse(readFileSync(RENDER_GOLDEN, "utf8")) as RenderGolden[];
  const byName = new Map(render.map((entry) => [entry.name, entry]));
  const options: LegacyEditOptions = { pandocPath: PANDOC ?? "", cwd: ROOT };
  for (const entry of edit.chunks) {
    const sourceEntry = byName.get(entry.name);
    assert.notEqual(sourceEntry, undefined, `${entry.name} source HTML`);
    const info = await chunk_info({
      html: sourceEntry!.html,
      doc: parse(sourceEntry!.text),
    }, options);
    assert.deepEqual(
      JSON.parse(JSON.stringify(info)),
      entry.chunks,
      entry.name,
    );
  }
});

test("to_markdown and cell_markdown match all committed conversion goldens", async (t) => {
  const options = editOptions();
  const edit = JSON.parse(readFileSync(EDIT_GOLDEN, "utf8")) as EditGolden;
  for (const [index, entry] of edit.markdown.entries()) {
    await t.test(`markdown ${index}`, async () => {
      assert.equal(
        await to_markdown(entry.html, entry.original, options),
        entry.markdown,
      );
    });
  }
  for (const [index, entry] of edit.cells.entries()) {
    await t.test(`cell ${index}`, async () => {
      assert.equal(await cell_markdown(entry.html, options), entry.markdown);
    });
  }
});

test("prepared_html is synchronous and leaves unmatched fragments alone", () => {
  assert.equal(prepared_html("<p>text</p>", "text"), "<p>text</p>");
  assert.match(
    prepared_html('<p><span class="citation">[a]</span></p>', "[@a]"),
    /data-slide-studio-atom="\[@a\]"/u,
  );
});

test("cells_to_markdown converts arrays of cells in one call", async () => {
  const options = editOptions();
  assert.deepEqual(
    await cells_to_markdown(["一<br>二", "<strong>太字</strong>"], options),
    ["一<br>二", "**太字**"],
  );
});
