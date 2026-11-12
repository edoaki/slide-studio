import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  codePointLength,
  div_attrs,
  fig_args,
  image_options,
  locate,
  math_breaks,
  move_chunk,
  parse,
  parse_attrs,
  rewrite,
  set_cell,
  table_rows,
  unsupported,
  wrapped_source,
  YAML_ALIAS_LIMIT,
  type Chunk,
} from "../../packages/core/src/legacy-source.js";
import { authors, html_block } from "../../packages/core/src/legacy-cover.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNC = join(HERE, "../../../tests/fixtures/sync");

function source(name: string): string {
  return readFileSync(join(SYNC, name), "utf8");
}

/** Slice with Python code-point indices, independent of the implementation. */
function cpSlice(value: string, start: number, end: number): string {
  return Array.from(value).slice(start, end).join("");
}

interface ExpectedRow {
  file: string;
  pages: number;
  page: number;
  id: string;
  chunks: string;
  raw: boolean;
  fixed: string[];
}

function expectedRows(): ExpectedRow[] {
  const rows: ExpectedRow[] = [];
  for (const line of source("expected.md").split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| ファイル") || line.startsWith("|---")) {
      continue;
    }
    const cells = line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
    rows.push({
      file: cells[0]!,
      pages: Number(cells[1]),
      page: Number(cells[2]),
      id: cells[3]!,
      chunks: cells[4]!,
      raw: cells[5] === "はい",
      fixed: cells[6] ? cells[6]!.split(/\s+/u) : [],
    });
  }
  return rows;
}

function formatChunks(chunks: Chunk[]): string {
  return chunks
    .map((chunk) => `${chunk.path}:${chunk.kind}${chunk.children.length ? `[${formatChunks(chunk.children)}]` : ""}`)
    .join(" ");
}

const ROWS = expectedRows();
const FIXTURES = readdirSync(SYNC).filter((name) => name.endsWith(".qmd")).sort();

test("expected table covers every fixture", () => {
  assert.deepEqual([...new Set(ROWS.map((row) => row.file))].sort(), FIXTURES);
});

test("pages and chunks match the legacy expected table", () => {
  for (const row of ROWS) {
    const doc = parse(source(row.file));
    assert.equal(doc.pages.length, row.pages, `${row.file} page count`);
    const page = doc.pages[row.page]!;
    assert.equal(page.id || "-", row.id, `${row.file} p${row.page} id`);
    assert.equal(page.raw_only, row.raw, `${row.file} p${row.page} raw_only`);
    assert.equal(formatChunks(page.chunks), row.chunks, `${row.file} p${row.page} chunks`);
  }
});

test("chunk text is the original source, and pages concatenate to the body", () => {
  for (const name of FIXTURES) {
    const text = source(name);
    const doc = parse(text);
    for (const page of doc.pages) {
      assert.ok(
        cpSlice(text, page.start, page.end).startsWith(cpSlice(text, page.start, page.head_end)),
        `${name} p${page.index} heading prefix`,
      );
      for (const chunk of page.walk()) {
        const value = cpSlice(text, chunk.start, chunk.end);
        assert.ok(value.length > 0, `${name} p${page.index}/${chunk.path} empty`);
        assert.ok(!value.startsWith("\n"), `${name} p${page.index}/${chunk.path} leading newline`);
      }
    }
    assert.equal(
      doc.pages.map((page) => cpSlice(text, page.start, page.end)).join(""),
      cpSlice(text, doc.pages[0]!.start, codePointLength(text)),
      `${name} page concatenation`,
    );
  }
});

test("fig_args reads named and positional arguments", () => {
  assert.deepEqual(fig_args('{{< fig nco/route-example width=800 title="経路の構成" >}}'), {
    ref: "nco/route-example",
    width: "800",
    title: "経路の構成",
  });
  assert.deepEqual(fig_args("{{< fig ./x >}}"), { ref: "./x" });
  assert.equal(fig_args("{{< other x >}}"), null);
});

test("math_breaks matches the legacy cases and keeps the line count", () => {
  const cases: Array<[string, string]> = [
    ["x^2", "x^2"],
    ["\na = b\nc = d\n", "\n\\begin{gathered} a = b \\\\\nc = d \\end{gathered}\n"],
    ["a &= b \\\\\n  &= c", "\\begin{aligned} a &= b \\\\\n  &= c \\end{aligned}"],
    ["a = b \\\\ c = d", "\\begin{gathered} a = b \\\\ c = d \\end{gathered}"],
    ["x \\& y\nz", "\\begin{gathered} x \\& y \\\\\nz \\end{gathered}"],
    [
      "\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}",
      "\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}",
    ],
  ];
  for (const [input, expected] of cases) {
    assert.equal(math_breaks(input), expected);
    assert.equal(math_breaks(input).split("\n").length, input.split("\n").length);
  }
});

test("wrapped_source maps rendered lines back to the original lines", () => {
  const text = "---\ntopic: test\n---\n\n## A {#a}\n\n$$\na = b\nc = d\n$$\n\n本文。\n";
  const doc = parse(text);
  const [wrapped, origin] = wrapped_source(doc);
  const rendered = wrapped.split("\n");
  assert.equal(origin[rendered.indexOf("本文。")], text.split("\n").indexOf("本文。") + 1);

  const nested = source("nested-columns.qmd");
  const [nestedRendered] = wrapped_source(parse(nested));
  for (const path of ["p0/0", "p0/0.0", "p0/0.0.0", "p0/0.0.1", "p0/0.1", "p0/0.1.1", "p0/0.1.1.0", "p0/1"]) {
    assert.ok(nestedRendered.includes(`data-slide-studio="${path}"`), path);
  }

  const definition = source("link-def.qmd");
  const [definitionRendered] = wrapped_source(parse(definition));
  assert.ok(definitionRendered.includes("[doc]: https://example.com/doc"));
  assert.ok(!definitionRendered.includes('data-slide-studio="p0/1"'));
});

test("rewrite round-trips every fixture and changes only the target chunk", () => {
  for (const name of FIXTURES) {
    const text = source(name);
    const doc = parse(text);
    assert.equal(rewrite(doc), text, name);

    for (const page of doc.pages) {
      for (const chunk of page.walk()) {
        if (chunk.kind !== "text") continue;
        const key = `p${page.index}/${chunk.path}`;
        const changed = rewrite(doc, { [key]: cpSlice(text, chunk.start, chunk.end) + "変更" });
        assert.equal(cpSlice(changed, 0, chunk.start), cpSlice(text, 0, chunk.start), `${name} ${key} prefix`);
        assert.equal(
          cpSlice(changed, chunk.end + 2, codePointLength(changed)),
          cpSlice(text, chunk.end, codePointLength(text)),
          `${name} ${key} suffix`,
        );
        assert.equal(cpSlice(changed, 0, page.start), cpSlice(text, 0, page.start));
        assert.equal(
          cpSlice(changed, page.end + 2, codePointLength(changed)),
          cpSlice(text, page.end, codePointLength(text)),
        );
      }
    }
  }
});

test("nested columns can be edited and reordered while definitions survive moves", () => {
  const text = source("nested-columns.qmd");
  const doc = parse(text);

  const target = locate(doc, "p0/0.1.1.0")[1];
  const changed = rewrite(doc, { "p0/0.1.1.0": "変更" });
  assert.equal(locate(parse(changed), "p0/0.1.1.0")[1].kind, "text");
  assert.equal(
    changed,
    cpSlice(text, 0, target.start) + "変更" + cpSlice(text, target.end, codePointLength(text)),
  );

  const moved = move_chunk(doc, "p0/0.0.1", 0, "p0/0.0.0");
  const movedDoc = parse(moved);
  const oldLeft = locate(doc, "p0/0.0.1")[1];
  const newLeft = locate(movedDoc, "p0/0.0.0")[1];
  assert.equal(
    cpSlice(moved, newLeft.start, newLeft.end),
    cpSlice(text, oldLeft.start, oldLeft.end),
  );
  const oldRight = locate(doc, "p0/0.1")[1];
  const newRight = locate(movedDoc, "p0/0.1")[1];
  assert.equal(
    cpSlice(moved, newRight.start, newRight.end),
    cpSlice(text, oldRight.start, oldRight.end),
  );
  assert.throws(() => move_chunk(doc, "p0/0", 0, "p0/0.0.0"), /自分の中/u);

  const linkedText = `${source("link-def.qmd")}\n## 次 {#next}\n\n次の段落。\n`;
  const linked = parse(linkedText);
  const definition = linked.pages[0]!.chunks.find((chunk) => chunk.kind === "def")!;
  const definitionText = cpSlice(linkedText, definition.start, definition.end);
  const linkedMoved = move_chunk(linked, "p0/2", 1);
  assert.ok(linkedMoved.includes(definitionText));
  assert.equal(parse(linkedMoved).pages[1]!.chunks.length, 2);

  const unclosed = source("unclosed-div.qmd");
  assert.ok(rewrite(parse(unclosed), { "p0/0": "編集" }));
  assert.throws(() => move_chunk(parse(unclosed), "p0/0", 1), /原稿/u);
  const fixed = unclosed + "\n:::\n";
  assert.ok(!parse(fixed).pages.some((page) => page.raw_only));
});

test("image_options keeps unknown attributes while replacing size and alignment", () => {
  const doc = parse('## A\n\n![alt](images/a.png){#img .x width=200 title="a"}\n');
  const result = image_options(doc, "p0/0", 320, "right");
  assert.ok(result.includes("#img .x"));
  assert.ok(result.includes('title="a"'));
  assert.ok(result.includes("width=320"));
  assert.ok(result.includes('fig-align="right"'));

  const aligned = image_options(parse(result), "p0/0", null, "left");
  assert.ok(aligned.includes("width=320"));
  assert.ok(aligned.includes('fig-align="left"'));
  assert.ok(!aligned.includes('fig-align="right"'));
});

const TABLE = [
  "## 表",
  "",
  "| 項目 | 方式 [@a] | $x|y$ |",
  "|:---|---:|---|",
  "| 成功率<br>（数） | **100%** | - |",
  "|  | a \\| b | `c|d` |",
  "",
].join("\n");

test("table_rows follows Pandoc cell splitting", () => {
  const raw = TABLE.split("\n\n")[1]!.trim();
  const rows = table_rows(raw)!;
  assert.deepEqual(
    rows.map((row) => row.map(([start, end]) => cpSlice(raw, start, end).trim())),
    [
      ["項目", "方式 [@a]", "$x|y$"],
      ["成功率<br>（数）", "**100%**", "-"],
      ["", "a \\| b", "`c|d`"],
    ],
  );
  assert.equal(table_rows("普通の段落"), null);
  assert.equal(table_rows("a\n---"), null);
});

test("set_cell replaces only the selected cell and preserves whitespace", () => {
  const doc = parse(TABLE);
  const edited = set_cell(doc, "p0/0", 0, 0, "新しい");
  assert.ok(edited.includes("| 新しい | 方式 [@a] | $x|y$ |"));
  assert.deepEqual(edited.split("\n").slice(3), doc.text.split("\n").slice(3));

  assert.ok(set_cell(doc, "p0/0", 2, 0, "埋めた").includes("| 埋めた | a \\| b | `c|d` |"));
  assert.throws(() => set_cell(doc, "p0/0", 9, 0, "x"), /セルが見つかりません/u);
});

test("attributes, div_attrs, and JSON names stay compatible with the Python API", () => {
  const attrs = parse_attrs('#a .x .y k="v" q=\'z\' empty=');
  assert.deepEqual(attrs.to_json(), {
    id: "a",
    classes: ["x", "y"],
    kv: { k: "v", q: "z", empty: "" },
  });
  assert.deepEqual(div_attrs("::: {.columns .extra}").to_json(), {
    id: "",
    classes: ["columns", "extra"],
    kv: {},
  });
  assert.deepEqual(div_attrs("::: columns").classes, ["columns"]);

  const doc = parse('---\ntitle: T\n---\n\n## A {#a .x k="v"}\n\nbody\n');
  const json = doc.to_json();
  assert.deepEqual(Object.keys(json), ["front", "meta", "meta_error", "authors", "pages"]);
  const page = (json.pages as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(Object.keys(page), [
    "index",
    "level",
    "title",
    "id",
    "classes",
    "kv",
    "start",
    "head_end",
    "end",
    "generated",
    "raw_only",
    "unclosed",
    "chunks",
  ]);
  assert.equal(page.id, "a");
  assert.deepEqual(page.classes, ["x"]);
  assert.deepEqual(page.kv, { k: "v" });
});

test("unsupported syntax reports shortcodes, cross references, callouts, and code execution", () => {
  const doc = parse([
    "## A",
    "",
    "{{< video x >}}",
    "",
    "@fig-x と @tbl-y",
    "",
    "::: {.callout-note}",
    "本文",
    ":::",
    "",
    "```{python}",
    "print(1)",
    "```",
    "",
  ].join("\n"));
  const messages = unsupported(doc).map((item) => item.message);
  assert.ok(messages.some((message) => message.includes("ショートコード {{< video >}}")));
  assert.ok(messages.some((message) => message.includes("相互参照 @fig-x")));
  assert.ok(messages.some((message) => message.includes("相互参照 @tbl-y")));
  assert.ok(messages.some((message) => message.includes("callout")));
  assert.ok(messages.some((message) => message.includes("コードの実行")));
});

test("authors and cover HTML follow the legacy cover helper", () => {
  assert.deepEqual(authors({}), []);
  assert.deepEqual(authors({ author: "A" }), [{ name: "A", affiliations: [] }]);
  assert.deepEqual(authors({ author: ["A", "B"] }), [
    { name: "A", affiliations: [] },
    { name: "B", affiliations: [] },
  ]);
  assert.deepEqual(
    authors({ author: [{ name: { family: "山田", given: "太郎" }, affiliations: ["所属"] }] }),
    [{ name: "山田 太郎", affiliations: ["所属"] }],
  );
  assert.deepEqual(
    authors({
      affiliations: [{ id: "x", name: "所属" }],
      author: [{ name: "A", affiliations: [{ ref: "x" }, { name: "別" }] }],
    }),
    [{ name: "A", affiliations: ["所属", "別"] }],
  );
  assert.deepEqual(authors({ author: [{ name: "" }] }), []);

  const people = [
    { name: "A&B", affiliations: ["大学"] },
    { name: "C", affiliations: ["大学", "会社"] },
  ];
  const html = html_block(people, { position: "right", font: "serif", bold: true });
  assert.match(html, /data-affiliation-position="right"/u);
  assert.match(html, /data-name-font="serif"/u);
  assert.match(html, /data-name-bold="true"/u);
  assert.match(html, /A&amp;B/u);
});

interface GoldenEntry {
  name: string;
  source: string;
  doc: Record<string, unknown>;
  wrapped: string;
  origin: Array<number | null>;
  unsupported: Array<{ page: number; message: string }>;
  unchanged: string;
}

const GOLDEN_CANDIDATES = [
  // The integration worktree copies the reference fixture here.
  join(HERE, "../../../tests/fixtures/source-parity/golden.json"),
  // This worktree keeps the supplied reference under .reference/.
  join(HERE, "../../../.reference/parity/source-golden.json"),
];
const GOLDEN_PATH = GOLDEN_CANDIDATES.find((candidate) => existsSync(candidate));
const GOLDEN = GOLDEN_PATH
  ? JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenEntry[]
  : null;

test("golden differential cases match the Python reference", { skip: GOLDEN === null }, () => {
  for (const entry of GOLDEN!) {
    const doc = parse(entry.source);
    assert.deepEqual(doc.to_json(), entry.doc, `${entry.name} doc`);
    const [wrapped, origin] = wrapped_source(doc);
    assert.equal(wrapped, entry.wrapped, `${entry.name} wrapped`);
    assert.deepEqual(origin, entry.origin, `${entry.name} origin`);
    assert.deepEqual(unsupported(doc), entry.unsupported, `${entry.name} unsupported`);
    assert.equal(rewrite(doc), entry.unchanged, `${entry.name} unchanged`);
  }
});

test("CRLF is preserved and parsed with Python's dot/end-of-line behavior", () => {
  const text = "---\r\ntitle: CRLF\r\n---\r\n\r\n## 題\r\n\r\n本文\r\n";
  const doc = parse(text);
  assert.deepEqual(doc.front, [0, 0]);
  assert.equal(doc.pages.length, 1);
  const page = doc.pages[0]!;
  assert.equal(page.title, "題");
  assert.equal(page.start, 25);
  assert.equal(page.head_end, 30);
  assert.equal(page.end, 37);
  const chunk = page.chunks[0]!;
  assert.equal(chunk.start, 33);
  assert.equal(chunk.end, 36);
  assert.equal(cpSlice(text, chunk.start, chunk.end), "本文\r");

  const [wrapped, origin] = wrapped_source(doc);
  assert.equal(
    wrapped,
    "---\r\ntitle: CRLF\r\n---\r\n\r\n\n## 題\r\n\n::: {.slide-studio-c data-slide-studio=\"p0/0\"}\n\n本文\r\n\n:::\n\n",
  );
  assert.deepEqual(origin, [1, 2, 3, 4, 5, 5, null, null, null, 7, null, null, null]);
  assert.equal(rewrite(doc), text);
});

test("offsets use Python code-point positions across astral characters", () => {
  const text = "## A\n\n😀本文。\n";
  const doc = parse(text);
  const chunk = doc.pages[0]!.chunks[0]!;
  assert.equal(text.length, 12); // UTF-16 code units
  assert.equal(codePointLength(text), 11); // Python len()
  assert.equal(chunk.start, 6);
  assert.equal(chunk.end, 10);
  assert.equal(cpSlice(text, chunk.start, chunk.end), "😀本文。");

  const headingText = "---\ntitle: 日本語\n---\n\n## 😀 題 {#emoji}\n\n𝄞 音楽 **太字**\n";
  const headingDoc = parse(headingText);
  assert.equal(headingDoc.pages[0]!.title, "😀 題");
  assert.equal(headingDoc.pages[0]!.id, "emoji");

  const jsonPage = doc.to_json().pages as Array<Record<string, unknown>>;
  const jsonChunk = (jsonPage[0]!.chunks as Array<Record<string, unknown>>)[0]!;
  assert.equal(jsonChunk.text, "😀本文。");
  assert.equal(rewrite(doc, { "p0/0": "変更" }), "## A\n\n変更\n");
});

test("Python whitespace sets drive the parser regexes", () => {
  // U+FEFF is JS whitespace but not Python whitespace, so this is not a math
  // block start: Python splits it into two chunks.
  const feffMath = "## A\n\n\uFEFF$$\na\n\nb\n$$";
  const feffDoc = parse(feffMath);
  assert.deepEqual(feffDoc.pages[0]!.chunks.map((chunk) => chunk.path), ["0", "1"]);
  assert.ok(!wrapped_source(feffDoc)[0].includes("\\begin{gathered}"));

  // U+0085 is Python whitespace but not JS whitespace, so this is one block.
  const nelMath = "## A\n\n\u0085$$\na\n\nb\n$$";
  const nelDoc = parse(nelMath);
  assert.equal(nelDoc.pages[0]!.chunks.length, 1);
  assert.ok(wrapped_source(nelDoc)[0].includes("\\begin{gathered}"));

  // Attribute tokens use Python's whitespace boundaries in both directions.
  assert.equal(parse_attrs("#a\u0085b").id, "a");
  assert.equal(parse_attrs("#a\uFEFFb").id, "a\uFEFFb");

  // Link definitions use Python's \S.
  const defs = parse("## A\n\n[x]:\uFEFFhttps://example.com\n\n[y]:\u0085https://example.com\n");
  assert.deepEqual(defs.pages[0]!.chunks.map((chunk) => chunk.kind), ["def", "text"]);

  // Figure lines and arguments use Python's \s.
  assert.deepEqual(fig_args("{{<\u0085fig x width=1 >}}"), { ref: "x", width: "1" });
  assert.equal(fig_args("{{<\uFEFFfig x >}}"), null);
});

test("an empty columns div is opaque like the Python reference", () => {
  const text = "## A\n\n::: {.columns}\n:::\n";
  const doc = parse(text);
  const chunk = doc.pages[0]!.chunks[0]!;
  assert.equal(chunk.kind, "opaque");
  assert.equal(chunk.container, false);

  const [wrapped] = wrapped_source(doc);
  assert.ok(wrapped.includes("::: {.columns}\n:::"));
  assert.ok(!wrapped.includes("::: {.columns}\n\n:::"));
});

test("__proto__ keys are preserved as own properties", () => {
  // JSON.parse creates a normal own "__proto__" data property, unlike an
  // object literal (which would change the prototype).
  const expectedKv = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
  const attrs = parse_attrs("__proto__=x");
  assert.deepEqual(attrs.to_json(), { id: "", classes: [], kv: expectedKv });
  assert.equal(Object.getPrototypeOf(attrs.kv), Object.prototype);
  assert.ok(Object.prototype.hasOwnProperty.call(attrs.kv, "__proto__"));

  const args = fig_args("{{< fig x __proto__=y >}}")!;
  assert.equal(Object.getPrototypeOf(args), Object.prototype);
  assert.ok(Object.prototype.hasOwnProperty.call(args, "__proto__"));
  assert.equal(args["__proto__"], "y");
  assert.deepEqual(Object.keys(args).sort(), ["__proto__", "ref"]);

  const doc = parse("## A\n\n::: {__proto__=x}\ntext\n:::\n");
  const chunk = doc.pages[0]!.chunks[0]!;
  assert.equal(chunk.kind, "opaque");
  const chunkAttrs = chunk.attrs!;
  assert.ok(Object.prototype.hasOwnProperty.call(chunkAttrs.kv, "__proto__"));
});

test("front matter uses PyYAML 1.1 semantics", () => {
  const duplicate = parse("---\na: 1\na: 2\n---\n\n## A\n");
  assert.equal(duplicate.meta_error, "");
  assert.equal(duplicate.meta.a, 2);

  const scalars = parse(
    "---\na: yes\nb: no\nc: on\nd: off\ne: 010\nf: 1e3\ng: 1:30\n---\n\n## A\n",
  );
  assert.equal(scalars.meta_error, "");
  assert.deepEqual(scalars.meta, {
    a: true,
    b: false,
    c: true,
    d: false,
    e: 8,
    f: "1e3",
    g: 90,
  });

  const merged = parse(
    "---\nbase: &base\n  x: 1\n  z: 3\nchild:\n  <<: *base\n  y: 2\n---\n\n## A\n",
  );
  assert.equal(merged.meta_error, "");
  assert.deepEqual(merged.meta.child, { x: 1, z: 3, y: 2 });

  const dated = parse([
    "---",
    "date: 2024-11-12",
    "stamp: 2024-11-12 01:30:00",
    "tz: 2024-11-12T01:30:00+09:00",
    "---",
    "",
    "## A",
    "",
  ].join("\n"));
  assert.equal(dated.meta_error, "");
  assert.equal(dated.meta.date, "2024-11-12");
  assert.equal(dated.meta.stamp, "2024-11-12 01:30:00");
  assert.equal(dated.meta.tz, "2024-11-12 01:30:00+09:00");

  const unknown = parse("---\nx: !expr 1+1\n---\n\n## A\n");
  assert.deepEqual(unknown.meta, {});
  assert.match(unknown.meta_error, /front matter を読めません/u);
  assert.match(unknown.meta_error, /!expr/u);

  const notMap = parse("---\n- a\n---\n\n## A\n");
  assert.deepEqual(notMap.meta, {});
  assert.match(notMap.meta_error, /辞書ではありません/u);
});

test("front matter resolves many aliases but rejects alias bombs with a diagnostic", () => {
  // More than the yaml package's default limit of 100 aliases must work.
  const aliases = Array.from({ length: 150 }, () => "*a").join(", ");
  const many = parse(`---\nbase: &a shared\nitems: [${aliases}]\n---\n\n## A\n`);
  assert.equal(many.meta_error, "");
  assert.equal((many.meta.items as unknown[]).length, 150);

  const bomb = [
    "a: &a [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]",
    "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
    "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
    "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
    "items: [*d, *d]",
  ].join("\n");
  const rejected = parse(`---\n${bomb}\n---\n\n## A\n`);
  assert.deepEqual(rejected.meta, {});
  assert.match(rejected.meta_error, /別名/u);
  assert.ok(rejected.meta_error.includes(String(YAML_ALIAS_LIMIT)));
});

test("locate reads adjacent Unicode decimal digit runs like Python int()", () => {
  const doc = parse("## A\n\n本文。\n\n## B\n\n本文2。\n");
  const [zeroPage, zeroChunk] = locate(doc, "p𝟘/0");
  assert.equal(zeroPage.index, 0);
  assert.equal(zeroChunk.path, "0");
  assert.equal(locate(doc, "p𝟙/0")[0].index, 1);
});
