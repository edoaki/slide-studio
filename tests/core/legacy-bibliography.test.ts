import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  authors,
  cites,
  clean,
  conflicts,
  entries,
  fields,
  identity,
  KeyError,
  listing,
  merge,
  migrate,
  plans,
  require_ready,
  update_path,
  verify,
  verify_path,
  with_arxiv_venue,
} from "../../packages/core/src/legacy-bibliography.js";
import { Workspace } from "../../packages/core/src/legacy-workspace.js";

const BIB = '@article{one,\n title = {A {nested} title},\n slide-studio-status = {unverified}\n}\n';

function scratch(t: TestContext): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "slide-studio-bib-")));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function write(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

test("entries preserves comments, nesting, quotes and @string records", () => {
  const text = [
    "% @article{ignored, title={Not an entry}}",
    "@article{one, title={A {nested} title}, note=\"a, b\", year=2025}",
    '@string{prefix = "arXiv:"}',
    "@comment{free text}",
    "trailing prose",
  ].join("\n");
  const records = entries(text);
  assert.deepEqual(records.map(([key]) => key), [null, "one", "@string:prefix", null, null]);
  assert.match(records[1]![1], /^@article\{one,/u);
  assert.equal(records[2]![1], '@string{prefix = "arXiv:"}');
  assert.equal(records[4]![1], "trailing prose");
  assert.throws(() => entries("@article{broken, title={x}"), /BibTeX/u);
});

test("fields keeps commas inside braces and quotes and yields exact ranges", () => {
  const raw = '@article{one, title={A, B}, year="2020", note=macro, author={Doe, Jane}}';
  const parsed = [...fields(raw)];
  assert.deepEqual(
    parsed.map(([name, value]) => [name, value]),
    [
      ["title", "{A, B}"],
      ["year", '"2020"'],
      ["note", "macro"],
      ["author", "{Doe, Jane}"],
    ],
  );
  for (const [name, value, start, end] of parsed) {
    assert.equal(
      raw.slice(start, end).trim().replace(/,+$/u, "").replace(/\s+/gu, ""),
      `${name}=${value}`.replace(/\s+/gu, ""),
    );
  }
});

test("identity ignores field order but merge still detects different values", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "slide-studio-bib-merge-")));
  try {
    const first = join(root, "first.bib");
    const second = join(root, "second.bib");
    write(first, "% @article{not-an-entry\n@article{one, title={A, B}, year=2025}\n");
    write(second, "@article{one,\n year = 2025, title = {A, B}\n}\n");
    assert.equal(merge([first, second]).match(/@article\{one,/gu)?.length, 1);
    assert.equal(identity("one", "@article{one, year=2025, title={A, B}}"),
      identity("one", "@article{one, title={A, B}, year=2025}"));

    write(second, "@article{one, title={A,  B}, year=2025}\n");
    assert.throws(() => merge([first, second]), /one/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean, arXiv venue injection and author parsing match the legacy display rules", () => {
  assert.equal(clean("{A {nested} title}"), "A nested title");
  assert.equal(clean("\\& 100\\% -- x --- y ~ z"), "& 100% – x — y z");
  assert.deepEqual(authors("{{Gurobi Optimization}}"), [
    { name: "Gurobi Optimization", family: "Gurobi Optimization" },
  ]);
  assert.deepEqual(authors("Doe, Jane and van Hoof, Herke"), [
    { name: "Doe, Jane", family: "Doe" },
    { name: "van Hoof, Herke", family: "van Hoof" },
  ]);
  assert.deepEqual(authors("A and {B and C}"), [
    { name: "A", family: "A" },
    { name: "B and C", family: "B and C" },
  ]);

  const arxiv = "@article{p, title={P}, archivePrefix={arXiv}, eprint={1234.5678}}";
  assert.match(with_arxiv_venue(arxiv), /howpublished = \{arXiv:1234\.5678\}/u);
  const venue = "@article{p, title={P}, journal={J}, archivePrefix={arXiv}, eprint={1234.5678}}";
  assert.equal(with_arxiv_venue(venue), venue);
  assert.equal(with_arxiv_venue("@article{broken"), "@article{broken");
});

test("cites follows Pandoc's punctuation and boundary rules", () => {
  for (const sample of ["[@a]", "[see @a; @b]", "@a." , "(@a)"]) {
    assert.equal(cites(sample, "a"), true, sample);
  }
  assert.equal(cites("x@a", "a"), false);
  assert.equal(cites("[@a-b]", "a"), false);
  assert.equal(cites("[@a-b]", "a-b"), true);
});

test("listing exposes editable fields and renders unverified status", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "slide-studio-bib-list-")));
  try {
    const path = join(root, "reference.bib");
    write(path, [
      "@article{ready, title={Complete}, note={slide-studio-status = {unverified}}}",
      '  @article(pending, title={Complete}, author={Doe}, year={2025}, doi={10.1/example}, SLIDE-STUDIO-STATUS = "UNVERIFIED")',
      "@article{other, title={Other}, slide-studio-status={unverified-extra}}",
      "",
    ].join("\n"));
    const result = listing(path);
    assert.deepEqual(result.filter((entry) => entry.unverified).map((entry) => entry.key), ["pending"]);
    assert.equal(result[0]!.type, "article");
    assert.equal(result[0]!.editable.title, "Complete");
    assert.deepEqual(result[0]!.authors, []);
    assert.deepEqual(listing(join(root, "missing.bib")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify_path removes only the selected unverified marker", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "slide-studio-bib-verify-")));
  try {
    const path = join(root, "reference.bib");
    const text = `@article{ready, title={Complete}, note={slide-studio-status = {unverified}}}
  @article(pending, title={Complete}, author={Doe}, year={2025}, doi={10.1/example}, SLIDE-STUDIO-STATUS = "UNVERIFIED")
@article{other, title={Other}, slide-studio-status={unverified-extra}}
`;
    write(path, text);
    assert.deepEqual(
      listing(path).filter((entry) => entry.unverified).map((entry) => entry.key),
      ["pending"],
    );
    await verify_path(path, "pending");
    assert.equal(
      readFileSync(path, "utf8"),
      text.replace('SLIDE-STUDIO-STATUS = "UNVERIFIED"', ""),
    );
    await assert.rejects(verify_path(path, "absent"), (error: unknown) => error instanceof KeyError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update_path rewrites selected fields and preserves TeX and neighbours", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "slide-studio-bib-edit-")));
  try {
    const path = join(root, "reference.bib");
    const raw = '@article{paper, title={{DNA} and \\LaTeX}, year="2020", note=macro, author={Doe, Jane}}';
    const other = "\n% Keep this comment\n@book{other, title={Other}}\n";
    write(path, raw + other);
    assert.equal(listing(path)[0]!.editable.title, "{DNA} and \\LaTeX");

    await update_path(path, "paper", { year: "2024", doi: "10.1/example", author: "" }, raw);
    const result = readFileSync(path, "utf8");
    assert.ok(result.endsWith(other));
    assert.ok(result.includes("title={{DNA} and \\LaTeX}"));
    assert.ok(result.includes("note=macro"));
    const entry = listing(path)[0]!;
    assert.equal((entry.fields as Record<string, string>).year, "2024");
    assert.equal((entry.fields as Record<string, string>).doi, "10.1/example");
    assert.equal("author" in (entry.fields as Record<string, string>), false);

    await assert.rejects(
      update_path(path, "paper", { year: "2025" }, raw),
      /更新/u,
    );
    await assert.rejects(
      update_path(path, "paper", { year: "2025}" }, entry.raw as string),
      /文献の入力/u,
    );
    assert.equal(readFileSync(path, "utf8"), result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plans, conflicts and migrate follow the topic-sharing migration", async (t) => {
  const root = scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("a", "test");
  ws.new_deck("b", "test");
  write(join(ws.deck_dir("a"), "reference.bib"), BIB);
  write(join(ws.deck_dir("b"), "reference.bib"), `${BIB}@book{two, title={Second}}\n`);

  const grouped = plans(ws);
  assert.deepEqual(grouped.get(ws.bib("a")), [
    join(ws.deck_dir("a"), "reference.bib"),
    join(ws.deck_dir("b"), "reference.bib"),
  ]);
  assert.deepEqual(conflicts(ws), []);

  await migrate(ws);
  assert.equal(existsSync(join(ws.deck_dir("a"), "reference.bib")), false);
  assert.equal(existsSync(join(ws.deck_dir("b"), "reference.bib")), false);
  assert.equal(readFileSync(ws.bib("a"), "utf8").match(/@article\{one,/gu)?.length, 1);
  const backups = readdirSync(join(ws.state, "trash"))
    .filter((name) => name.startsWith("bib-"))
    .flatMap((name) => [join(ws.state, "trash", name, "a", "reference.bib"),
      join(ws.state, "trash", name, "b", "reference.bib")])
    .filter((path) => existsSync(path));
  assert.equal(backups.length, 2);

  const before = readFileSync(ws.bib("a"), "utf8");
  await migrate(ws);
  assert.equal(readFileSync(ws.bib("a"), "utf8"), before);
});

test("conflicts, require_ready and verify share the same conflict detection", async (t) => {
  const root = scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("a", "test");
  ws.new_deck("b", "test");
  write(join(ws.deck_dir("a"), "reference.bib"), BIB);
  write(join(ws.deck_dir("b"), "reference.bib"), BIB.replace("title}", "different}"));
  const target = ws.bib("a");
  write(target, BIB);

  const errors = conflicts(ws);
  assert.ok(errors.some((message) => message.includes("one") && message.includes("a, b")), errors.join("\n"));
  await assert.rejects(require_ready(ws, "a"), /one/u);
  await assert.rejects(verify(ws, "a", "one"), /one/u);

  write(join(ws.deck_dir("b"), "reference.bib"), BIB);
  await migrate(ws);
  await verify(ws, "a", "one");
  assert.equal(
    readFileSync(target, "utf8").includes("slide-studio-status"),
    false,
  );
});

test("require_ready rejects the old figures/topics overlap", async (t) => {
  const root = scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("talk", "test");
  mkdirSync(join(root, "figures"));
  await assert.rejects(require_ready(ws, "talk"), /figures/u);
  await migrate(ws);
  assert.equal(existsSync(join(root, "figures")), true);
});
