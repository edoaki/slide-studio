import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  find_page,
  mentions,
  merge3,
  splitLinesKeepEnds,
  touched,
  type EditScope,
} from "../../packages/core/src/legacy-edit-scope.js";
import { parse } from "../../packages/core/src/legacy-source.js";

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
const MERGE_GOLDEN = join(ROOT, "tests/fixtures/edit-parity/merge-golden.json");

const BASE = "## 一 {#one}\n\n本文一\n\n## 二 {#two}\n\n本文二\n\n{{< fig nco/a width=3 >}}\n\n## 三 {#three}\n\n本文三\n";

function scope(
  pages: Array<[string, string | null]> = [],
  figures: string[] = [],
): EditScope {
  return {
    all: false,
    pages: pages.map(([key, title]) => ({ key, title })),
    figures: [...figures],
  };
}

test("splitLinesKeepEnds recognizes every Python line boundary and keeps CRLF", () => {
  assert.deepEqual(
    splitLinesKeepEnds("a\r\nb\rc\nd\ve\ff\x1cg\x1dh\x1ei\x85j\u2028k\u2029l"),
    [
      "a\r\n", "b\r", "c\n", "d\v", "e\f", "f\x1c", "g\x1d", "h\x1e",
      "i\x85", "j\u2028", "k\u2029", "l",
    ],
  );
  assert.deepEqual(splitLinesKeepEnds(""), []);
  assert.deepEqual(splitLinesKeepEnds("\n"), ["\n"]);
  assert.deepEqual(splitLinesKeepEnds("😀\r\n本文"), ["😀\r\n", "本文"]);
});

test("merge3 keeps both sides when different lines change", () => {
  const mine = BASE.replace("本文一", "利用者");
  const theirs = BASE.replace("本文三", "AI");
  const merged = merge3(BASE, mine, theirs);
  assert.notEqual(merged, null);
  assert.match(merged!, /利用者/u);
  assert.match(merged!, /AI/u);
});

test("merge3 keeps pages added by the other side", () => {
  const theirs = BASE.replace("## 三 {#three}", "## 新 {#new}\n\nAI\n\n## 三 {#three}");
  const merged = merge3(BASE, BASE.replace("本文一", "利用者"), theirs);
  assert.notEqual(merged, null);
  assert.match(merged!, /利用者/u);
  assert.match(merged!, /## 新 \{#new\}/u);
});

test("merge3 stops when both sides change the same line", () => {
  assert.equal(
    merge3(BASE, BASE.replace("本文二", "利用者"), BASE.replace("本文二", "AI")),
    null,
  );
});

test("merge3 applies the same change once", () => {
  const both = BASE.replace("本文二", "同じ");
  assert.equal(merge3(BASE, both, both), both);
});

test("merge3 preserves a missing final newline and CRLF spellings", () => {
  assert.equal(merge3("A\r\nB", "A\r\nC", "A\r\nB"), "A\r\nC");
  assert.equal(merge3("A\r\nB", "A\r\nB", "A\r\nC\r\n"), "A\r\nC\r\n");
  assert.equal(merge3("A\nB\n", "A\nB\n", "A\nB"), "A\nB");
});

test("merge3 matches all committed legacy differential cases", () => {
  assert.equal(existsSync(MERGE_GOLDEN), true, `missing ${MERGE_GOLDEN}`);
  const cases = JSON.parse(readFileSync(MERGE_GOLDEN, "utf8")) as Array<{
    base: string;
    mine: string;
    theirs: string;
    result: string | null;
  }>;
  assert.equal(cases.length, 240);
  cases.forEach((entry, index) => {
    assert.equal(
      merge3(entry.base, entry.mine, entry.theirs),
      entry.result,
      `merge case ${index}`,
    );
  });
});

test("touched reports changes only inside a locked page", () => {
  const locked = scope([["two", null]]);
  assert.equal(touched(BASE, BASE.replace("本文二", "x"), locked), true);
  assert.equal(touched(BASE, BASE.replace("本文一", "x"), locked), false);
  assert.equal(
    touched(
      BASE,
      BASE.replace("## 二 {#two}\n\n本文二\n\n{{< fig nco/a width=3 >}}\n\n", ""),
      locked,
    ),
    true,
  );
});

test("touched follows pages without ids when pages are inserted", () => {
  const text = "## 一\n\n本文一\n\n## 二\n\n本文二\n";
  const locked = scope([["@1", "二"]]);
  const added = "## 零\n\n本文零\n\n" + text;
  assert.equal(touched(text, added, locked), false);
  assert.equal(touched(text, added.replace("本文二", "x"), locked), true);
});

test("touched reports changes to a locked figure line", () => {
  const locked = scope([], ["nco/a"]);
  assert.equal(touched(BASE, BASE.replace("width=3", "width=5"), locked), true);
  assert.equal(touched(BASE, BASE.replace("本文二", "x"), locked), false);
});

test("mentions looks only inside locked page source", () => {
  const locked = scope([["two", null]]);
  assert.equal(mentions(BASE, locked, "本文二"), true);
  assert.equal(mentions(BASE, locked, "本文一"), false);
  assert.equal(mentions(BASE, scope([["missing", null]]), "本文二"), false);
});

test("find_page resolves ids and title-based page numbers", () => {
  const doc = parse("## 一\n\n本文一\n\n## 二\n\n本文二\n\n## 二\n\n別\n");
  assert.equal(find_page(doc, { key: "two" }), null);
  const titled = find_page(doc, { key: "@1", title: "二" });
  assert.equal(titled?.index, 1);
  const missingTitle = find_page(doc, { key: "@2", title: "なし" });
  assert.equal(missingTitle?.index, 2);
  assert.equal(find_page(doc, { key: "@9", title: "なし" }), null);
  assert.equal(find_page(parse("## A {#a}\n"), { key: "a" })?.index, 0);
});
