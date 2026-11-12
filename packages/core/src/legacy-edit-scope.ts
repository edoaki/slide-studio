/**
 * Faithful TypeScript port of `.reference/parity/edit_scope.py`.
 *
 * `merge3` uses a deterministic port of CPython's `difflib.SequenceMatcher`
 * (junk detection disabled, `autojunk=False`) over Python-style
 * `splitlines(keepends=True)` output. The line boundaries are the ones Python
 * recognizes: LF, CR, CRLF, VT, FF, FS, GS, RS, NEL, LS and PS.
 */

import { PY_WS, pyRstrip } from "./legacy-cover.js";
import { parse, type Doc, type Page } from "./legacy-source.js";

const S = `[${PY_WS}]`;
const FIG = new RegExp(
  String.raw`\{\{<${S}*fig${S}+"?([^"${PY_WS}>]+)"?[^>]*>\}\}`,
  "gu",
);

export interface EditScopePage {
  key: string;
  title?: string | null;
}

export interface EditScope {
  all?: boolean;
  pages: EditScopePage[];
  figures: string[];
}

interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

interface Match {
  a: number;
  b: number;
  size: number;
}

type Opcode = [string, number, number, number, number];

/** Python `str.splitlines(keepends=True)`. */
export function splitLinesKeepEnds(value: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let index = 0;
  while (index < value.length) {
    const character = value[index]!;
    let end: number | null = null;
    if (character === "\r") {
      end = value[index + 1] === "\n" ? index + 2 : index + 1;
    } else if (
      character === "\n"
      || character === "\v"
      || character === "\f"
      || character === "\x1c"
      || character === "\x1d"
      || character === "\x1e"
      || character === "\x85"
      || character === "\u2028"
      || character === "\u2029"
    ) {
      end = index + 1;
    }
    if (end !== null) {
      lines.push(value.slice(start, end));
      start = end;
      index = end;
    } else {
      index += 1;
    }
  }
  if (start < value.length) lines.push(value.slice(start));
  return lines;
}

function compareStrings(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index]!.codePointAt(0)!;
    const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

/** `difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()`. */
function opcodes(a: string[], b: string[]): Opcode[] {
  const b2j = new Map<string, number[]>();
  b.forEach((value, index) => {
    const indices = b2j.get(value);
    if (indices) indices.push(index);
    else b2j.set(value, [index]);
  });

  const findLongestMatch = (
    alo: number,
    ahi: number,
    blo: number,
    bhi: number,
  ): Match => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const size = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, size);
        if (size > bestsize) {
          besti = i - size + 1;
          bestj = j - size + 1;
          bestsize = size;
        }
      }
      j2len = newj2len;
    }

    // No element is junk when isjunk is None. These extensions are still part
    // of difflib and matter for compatibility with its tie-breaking.
    while (
      besti > alo
      && bestj > blo
      && a[besti - 1] === b[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi
      && bestj + bestsize < bhi
      && a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return { a: besti, b: bestj, size: bestsize };
  };

  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  const blocks: Array<[number, number, number]> = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const match = findLongestMatch(alo, ahi, blo, bhi);
    if (match.size) {
      blocks.push([match.a, match.b, match.size]);
      if (alo < match.a && blo < match.b) {
        queue.push([alo, match.a, blo, match.b]);
      }
      if (
        match.a + match.size < ahi
        && match.b + match.size < bhi
      ) {
        queue.push([
          match.a + match.size,
          ahi,
          match.b + match.size,
          bhi,
        ]);
      }
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

  const matching: Array<[number, number, number]> = [];
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) matching.push([i1, j1, k1]);
      i1 = i2;
      j1 = j2;
      k1 = k2;
    }
  }
  if (k1) matching.push([i1, j1, k1]);
  matching.push([a.length, b.length, 0]);

  const result: Opcode[] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj, size] of matching) {
    let tag = "";
    if (i < ai && j < bj) tag = "replace";
    else if (i < ai) tag = "delete";
    else if (j < bj) tag = "insert";
    if (tag) result.push([tag, i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) result.push(["equal", ai, ai + size, bj, bj + size]);
  }
  return result;
}

function hunks(base: string[], other: string[]): Hunk[] {
  return opcodes(base, other)
    .filter(([tag]) => tag !== "equal")
    .map(([, i1, i2, j1, j2]) => ({
      start: i1,
      end: i2,
      lines: other.slice(j1, j2),
    }));
}

function sameHunk(left: Hunk | null, right: Hunk): boolean {
  if (left === null) return false;
  if (left.start !== right.start || left.end !== right.end) return false;
  if (left.lines.length !== right.lines.length) return false;
  return left.lines.every((line, index) => line === right.lines[index]);
}

/** Line-based three-way merge; `null` means both sides changed the same line. */
export function merge3(base: string, mine: string, theirs: string): string | null {
  const lines = splitLinesKeepEnds(base);
  const all = [
    ...hunks(lines, splitLinesKeepEnds(mine)),
    ...hunks(lines, splitLinesKeepEnds(theirs)),
  ];
  all.sort((left, right) => left.start - right.start || left.end - right.end);

  const output: string[] = [];
  let at = 0;
  let last: Hunk | null = null;
  for (const hunk of all) {
    if (sameHunk(last, hunk)) continue;
    const { start, end, lines: replacement } = hunk;
    if (
      start < at
      || (last !== null && last.start === last.end && last.start === start && start === end)
    ) {
      return null;
    }
    output.push(...lines.slice(at, start), ...replacement);
    at = end;
    last = hunk;
  }
  return [...output, ...lines.slice(at)].join("");
}

function pythonDigitValue(character: string): number {
  const code = character.codePointAt(0)!;
  const isDigit = new RegExp(String.raw`^\p{Nd}$`, "u");
  if (!isDigit.test(character)) return 0;
  let start = code;
  while (start > 0 && isDigit.test(String.fromCodePoint(start - 1))) start -= 1;
  return (code - start) % 10;
}

function pythonInt(value: string): number {
  let result = 0;
  for (const character of value) result = result * 10 + pythonDigitValue(character);
  return result;
}

/** Mirror `edit_scope.find_page`; headings identify pages without an id. */
export function find_page(doc: Doc, spec: EditScopePage): Page | null {
  const key = spec.key;
  if (!key.startsWith("@")) {
    return doc.pages.find((page) => page.id === key) ?? null;
  }
  const tail = key.slice(1);
  const index = /^\p{Nd}+$/u.test(tail) ? pythonInt(tail) : -1;
  const title = spec.title ?? null;
  const same = doc.pages.filter((page) => !page.id && page.title === title);
  if (same.length) {
    let closest = same[0]!;
    for (const page of same.slice(1)) {
      if (Math.abs(page.index - index) < Math.abs(closest.index - index)) closest = page;
    }
    return closest;
  }
  return index >= 0 && index < doc.pages.length ? doc.pages[index]! : null;
}

function cpSlice(value: string, start: number, end: number): string {
  return Array.from(value).slice(Math.max(0, start), Math.max(0, end)).join("");
}

function figureLines(text: string, ref: string): string[] {
  const clone = new RegExp(FIG.source, FIG.flags);
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = clone.exec(text)) !== null) {
    if (match[1] === ref) matches.push(match[0]);
    if (match[0].length === 0) clone.lastIndex += 1;
  }
  return matches.sort(compareStrings);
}

/** Whether the edit changed a locked page or figure. */
export function touched(before: string, after: string, scope: EditScope): boolean {
  const oldDoc = parse(before);
  const newDoc = parse(after);
  for (const spec of scope.pages) {
    const page = find_page(oldDoc, spec);
    if (page === null) continue;
    const now = find_page(newDoc, spec);
    if (
      now === null
      || pyRstrip(cpSlice(before, page.start, page.end))
        !== pyRstrip(cpSlice(after, now.start, now.end))
    ) {
      return true;
    }
  }
  return scope.figures.some((ref) =>
    compareStringLists(figureLines(before, ref), figureLines(after, ref)) !== 0);
}

function compareStringLists(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareStrings(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

/** Whether `path` is written in the source of a locked page. */
export function mentions(text: string, scope: EditScope, path: string): boolean {
  const doc = parse(text);
  for (const spec of scope.pages) {
    const page = find_page(doc, spec);
    if (page !== null && cpSlice(text, page.start, page.end).includes(path)) return true;
  }
  return false;
}
