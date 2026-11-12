/**
 * Faithful TypeScript port of `.reference/parity/source.py`.
 *
 * Positions are Python string indices, i.e. Unicode code-point offsets, not
 * JavaScript UTF-16 code-unit offsets. The helpers in this file convert at the
 * boundaries so that a chunk spanning an astral character ("😀") keeps the same
 * `start`/`end` values as the Python implementation. Text is always sliced with
 * those code-point offsets; untouched text is returned verbatim.
 */

import { parse as parseYaml } from "yaml";
import {
  authors,
  isPlainObject,
  pyLstrip,
  pyRstrip,
  pyStrip,
  pyTruthy,
} from "./legacy-cover.js";

export { authors, html_block } from "./legacy-cover.js";
export type { LegacyAuthor } from "./legacy-cover.js";

// ---------------------------------------------------------------- 正規表現
//
// Python's `\w` covers Unicode letters/numbers plus "_"; JS `\w` is ASCII-only,
// even with the `u` flag, so the patterns below spell out Python's character
// set. Python's `\d` is likewise expressed as Unicode decimal digits.

const W_INNER = String.raw`\p{L}\p{N}_`;
const WH = String.raw`[${W_INNER}-]`;
const DIGIT = String.raw`\p{Nd}`;
// Python's `.` without re.S matches every character except LF. JavaScript's
// `.` also excludes CR, U+2028 and U+2029, which changes CRLF headings/fences.
const DOT = String.raw`[^\n]`;
// Python's `$` without re.M matches end-of-string or just before a final LF,
// but not before a stray CR (JavaScript's `$` does). This is an absolute end.
const END = String.raw`(?=\n?(?![\s\S]))`;

export const FENCE_OPEN = new RegExp(
  "^ {0,3}(`{3,}|~{3,})(" + DOT + "*)" + END,
  "u",
);
export const DIV_OPEN = new RegExp(
  String.raw`^ {0,3}(:{3,})[ \t]*(\{[^{}]*\}|${WH}+)[ \t]*:*[ \t]*${END}`,
  "u",
);
export const DIV_CLOSE = new RegExp(String.raw`^ {0,3}:{3,}[ \t]*${END}`, "u");
export const HEADING = new RegExp(String.raw`^(#{1,2})[ \t]+(${DOT}*?)[ \t]*${END}`, "u");
export const ATTR_TAIL = new RegExp(String.raw`[ \t]*\{([^{}]*)\}[ \t]*${END}`, "u");
export const FIG_LINE = new RegExp(
  String.raw`^\{\{<\s*fig\s+(${DOT}*?)\s*>\}\}${END}`,
  "u",
);
export const IMAGE_LINE = new RegExp(
  String.raw`^!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?${END}`,
  "u",
);
export const FOOTNOTE_DEF = new RegExp(String.raw`^ {0,3}\[\^[^\]\s]+\]:`, "u");
export const LINK_DEF = new RegExp(String.raw`^ {0,3}\[[^\]^][^\]]*\]:[ \t]*\S`, "u");
export const RAW_HTML = new RegExp(String.raw`^ {0,3}<(?:[A-Za-z]${WH}*|!--)`, "u");
export const LIST_KIND = new RegExp(String.raw`^(?:([-*+])|${DIGIT}+([.)]))[ \t]`, "u");
export const PAGE_ID = new RegExp(String.raw`^[a-z0-9][a-z0-9-]*${END}`, "u");
export const BOX_KEYS = new Set(["style", "data-step"]);
export const COVER_PARTS = new Set(["cover-title", "cover-subtitle"]);
export const SHORTCODE = new RegExp(String.raw`\{\{<\s*(${WH}+)`, "gu");
export const CROSSREF = new RegExp(
  String.raw`(?<![${W_INNER}@])@(fig|tbl|sec|eq|lst|thm)-${WH}+`,
  "gu",
);
export const ATTR_TOKEN = new RegExp(
  String.raw`#([^\s}]+)|\.([^\s}=]+)|([^\s=}]+)=(?:"((?:[^"\\]|\\${DOT})*)"|'([^']*)'|([^\s}]*))`,
  "gu",
);
export const MATH_ENV = /\\(?:begin|end)\{/u;
export const PURE_MATH = /(\s*\$\$)(.*?)(\$\$\s*)/su;
export const TABLE_RULE = /\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*/u;
export const CELL_PART = new RegExp(
  "\\\\" + DOT
    + "|(`+)" + DOT + "+?(?<!`)\\1(?!`)"
    + "|\\$\\$" + DOT + "+?\\$\\$"
    + "|\\$(?!\\s)(?:\\\\" + DOT + "|[^$\\n])*?(?<!\\s)\\$(?!\\p{Nd})"
    + "|</?[A-Za-z][^<>\\n]*>|\\|",
  "gu",
);
const CODE_EXEC = /(?:^|(?<=\n)) {0,3}`{3,}\s*\{(?!=)[\p{L}\p{N}_-]+/gu;
const SINGLE_LINE_MATH = new RegExp(String.raw`^\s*\$\$${DOT}*\$\$\s*${END}`, "u");
const TRAILING_MATH_BREAK = new RegExp(String.raw`\s*\\\\\s*${END}`, "u");
const TRAILING_HASHES = new RegExp(String.raw`[ \t]+#+[ \t]*${END}`, "u");

// ---------------------------------------------------------------- Unicode

/** Python `len(text)` for a JavaScript string. */
export function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

function utf16ToCodePoint(value: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= value.length) return codePointLength(value);
  let codePoints = 0;
  let position = 0;
  while (position < index) {
    const code = value.codePointAt(position)!;
    position += code > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  return codePoints;
}

function codePointToUtf16(value: string, index: number): number {
  if (index <= 0) return 0;
  let codePoints = 0;
  let position = 0;
  while (position < value.length) {
    if (codePoints >= index) return position;
    const code = value.codePointAt(position)!;
    position += code > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  return value.length;
}

function fullMatch(expression: RegExp, value: string): boolean {
  const clone = new RegExp(expression.source, expression.flags.replace(/g/gu, ""));
  const match = clone.exec(value);
  return !!match && match.index === 0 && match[0].length === value.length;
}

function* findAll(expression: RegExp, value: string): Generator<RegExpExecArray> {
  const flags = expression.flags.includes("g") ? expression.flags : `${expression.flags}g`;
  const clone = new RegExp(expression.source, flags);
  let match: RegExpExecArray | null;
  while ((match = clone.exec(value)) !== null) {
    yield match;
    if (match[0].length === 0) clone.lastIndex += 1;
  }
}

/** Python `ValueError`, so callers can distinguish parser errors from bugs. */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

function pythonInt(value: string): number {
  let result = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const digit = decimalDigitValue(code);
    result = result * 10 + digit;
  }
  return result;
}

function decimalDigitValue(code: number): number {
  const character = String.fromCodePoint(code);
  const isDigit = new RegExp(String.raw`^\p{Nd}$`, "u");
  if (!isDigit.test(character)) return 0;
  // Unicode decimal digits form contiguous runs of ten values (0-9).
  let start = code;
  while (start > 0 && isDigit.test(String.fromCodePoint(start - 1))) start -= 1;
  return code - start;
}

// ---------------------------------------------------------------- 属性

export class Attrs {
  constructor(
    public id = "",
    public classes: string[] = [],
    public kv: Record<string, string> = {},
  ) {}

  to_json(): { id: string; classes: string[]; kv: Record<string, string> } {
    return { id: this.id, classes: this.classes, kv: this.kv };
  }
}

export function parse_attrs(inner: string): Attrs {
  const attrs = new Attrs();
  for (const match of findAll(ATTR_TOKEN, inner)) {
    if (match[1]) {
      attrs.id = match[1];
    } else if (match[2]) {
      attrs.classes.push(match[2]);
    } else {
      const value = match[4] !== undefined
        ? match[4]
        : match[5] !== undefined
          ? match[5]
          : match[6] ?? "";
      attrs.kv[match[3]!] = value.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    }
  }
  return attrs;
}

export function div_attrs(line: string): Attrs {
  const match = DIV_OPEN.exec(line);
  if (!match) return new Attrs();
  const spec = match[2]!;
  return spec.startsWith("{") ? parse_attrs(spec.slice(1, -1)) : new Attrs("", [spec], {});
}

// ---------------------------------------------------------------- 構造

function isSubset(value: Set<string>, allowed: Set<string>): boolean {
  for (const item of value) if (!allowed.has(item)) return false;
  return true;
}

export class Chunk {
  constructor(
    public kind: string,
    public start: number,
    public end: number,
    public path: string,
    public children: Chunk[] = [],
    public open: [number, number] | null = null,
    public close: [number, number] | null = null,
    public attrs: Attrs | null = null,
  ) {}

  get container(): boolean {
    return this.kind === "columns" || this.kind === "column" || this.kind === "box";
  }

  *walk(): Generator<Chunk> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }

  to_json(text: string): Record<string, unknown> {
    const result: Record<string, unknown> = {
      kind: this.kind,
      path: this.path,
      start: this.start,
      end: this.end,
      text: new _Lines(text).slice(this.start, this.end),
    };
    if (this.attrs !== null) result.attrs = this.attrs.to_json();
    if (this.open) {
      result.open = new _Lines(text).slice(this.open[0], this.open[1]);
      result.close = this.close
        ? new _Lines(text).slice(this.close[0], this.close[1])
        : "";
    }
    if (this.children.length) result.children = this.children.map((child) => child.to_json(text));
    return result;
  }
}

export class Page {
  constructor(
    public index: number,
    public level: number,
    public title: string,
    public attrs: Attrs,
    public start: number,
    public head_end: number,
    public end: number,
    public generated = "",
    public raw_only = false,
    public chunks: Chunk[] = [],
    public unclosed: string[] = [],
  ) {}

  get id(): string {
    return this.attrs.id;
  }

  *walk(): Generator<Chunk> {
    for (const chunk of this.chunks) yield* chunk.walk();
  }

  to_json(text: string): Record<string, unknown> {
    return {
      index: this.index,
      level: this.level,
      title: this.title,
      id: this.id,
      classes: this.attrs.classes,
      kv: this.attrs.kv,
      start: this.start,
      head_end: this.head_end,
      end: this.end,
      generated: this.generated,
      raw_only: this.raw_only,
      unclosed: this.unclosed,
      chunks: this.chunks.map((chunk) => chunk.to_json(text)),
    };
  }
}

export class Doc {
  constructor(
    public text: string,
    public front: [number, number],
    public meta: Record<string, unknown>,
    public meta_error: string,
    public pages: Page[],
    public unclosed_at: number | null,
  ) {}

  get body_start(): number {
    return this.front[1];
  }

  get preamble(): string {
    const end = this.pages.length ? this.pages[0]!.start : codePointLength(this.text);
    return new _Lines(this.text).slice(this.body_start, end);
  }

  page_of(offset: number): Page | null {
    for (const page of this.pages) {
      if (page.start <= offset && offset < page.end) return page;
    }
    return null;
  }

  to_json(): Record<string, unknown> {
    return {
      front: [this.front[0], this.front[1]],
      meta: this.meta,
      meta_error: this.meta_error,
      authors: authors(this.meta),
      pages: this.pages.map((page) => page.to_json(this.text)),
    };
  }
}

class _Lines {
  readonly text: string;
  readonly starts: number[] = [];
  readonly ends: number[] = [];
  readonly total: number;
  private readonly lineTexts: string[] = [];
  private readonly unitStarts: number[] = [];

  constructor(text: string) {
    this.text = text;
    this.total = codePointLength(text);
    let codePointPosition = 0;
    let unitPosition = 0;
    for (const line of text.split("\n")) {
      const lineLength = codePointLength(line);
      this.starts.push(codePointPosition);
      this.ends.push(codePointPosition + lineLength);
      this.lineTexts.push(line);
      this.unitStarts.push(unitPosition);
      codePointPosition += lineLength + 1;
      unitPosition += line.length + 1;
    }
    if (text.endsWith("\n")) {
      this.starts.pop();
      this.ends.pop();
      this.lineTexts.pop();
      this.unitStarts.pop();
    }
  }

  get length(): number {
    return this.starts.length;
  }

  line(index: number): string {
    return this.lineTexts[index]!;
  }

  slice(start: number, end: number): string {
    const from = Math.max(0, Math.min(start, this.text.length));
    const to = Math.max(0, Math.min(end, this.text.length));
    if (from >= to) return "";
    return this.text.slice(this.unitAt(from), this.unitAt(to));
  }

  blank(index: number): boolean {
    return pyStrip(this.line(index)).length === 0;
  }

  index_at(offset: number): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  private unitAt(offset: number): number {
    if (this.starts.length === 0) return 0;
    const index = this.index_at(offset);
    if (index < 0) return 0;
    const line = this.lineTexts[index]!;
    const lineCodePoints = this.ends[index]! - this.starts[index]!;
    const local = offset - this.starts[index]!;
    if (local <= lineCodePoints) {
      return this.unitStarts[index]! + codePointToUtf16(line, local);
    }
    return this.unitStarts[index]! + line.length + (local - lineCodePoints);
  }
}

function sliceText(text: string, start: number, end: number): string {
  return new _Lines(text).slice(start, end);
}

function allBlank(lines: _Lines, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (!lines.blank(index)) return false;
  }
  return true;
}

const FRONT_MATTER = new RegExp(
  String.raw`^---[ \t]*\n(.*?\n)?(?:---|\.\.\.)[ \t]*(\n|${END})`,
  "su",
);

function frontMatter(text: string): [number, Record<string, unknown>, string] {
  if (!text.startsWith("---")) return [0, {}, ""];
  const match = FRONT_MATTER.exec(text);
  if (!match) return [0, {}, ""];
  const end = utf16ToCodePoint(text, match[0].length);
  try {
    const loaded = parseYaml(match[1] ?? "");
    // Python uses `yaml.safe_load(...) or {}`, so every falsey value becomes {}.
    const value = pyTruthy(loaded) ? loaded : {};
    if (!isPlainObject(value)) return [end, {}, "front matter が辞書ではありません"];
    if (
      !Object.prototype.hasOwnProperty.call(value, "topic")
      && Object.prototype.hasOwnProperty.call(value, "figures")
    ) {
      value.topic = value.figures;
    }
    return [end, value, ""];
  } catch (error) {
    return [end, {}, `front matter を読めません: ${String(error)}`];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function closingFence(openLine: string): RegExp {
  const match = FENCE_OPEN.exec(openLine)!;
  const character = match[1]![0]!;
  return new RegExp(
    `^ {0,3}${escapeRegExp(character)}{${match[1]!.length},}[ \\t]*${END}`,
    "u",
  );
}

class _Scan {
  readonly code_close = new Map<number, number>();
  readonly div_close = new Map<number, number | null>();
  readonly unclosed: Array<[number, string]> = [];
  readonly in_code: boolean[];
  readonly depth: number[];

  constructor(lines: _Lines, first: number) {
    const count = lines.length;
    const inCode = new Array<boolean>(count).fill(false);
    const depth = new Array<number>(count).fill(0);
    const stack: number[] = [];
    let index = first;
    while (index < count) {
      const value = lines.line(index);
      const fence = FENCE_OPEN.exec(value);
      if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
        const close = closingFence(value);
        let closeIndex: number | null = null;
        for (let next = index + 1; next < count; next += 1) {
          if (close.test(lines.line(next))) {
            closeIndex = next;
            break;
          }
        }
        if (closeIndex === null) {
          // Pandoc reads an unclosed ``` as ordinary text; stop structural edits.
          this.unclosed.push([index, "```"]);
          index += 1;
          continue;
        }
        this.code_close.set(index, closeIndex);
        for (let line = index; line <= closeIndex; line += 1) inCode[line] = true;
        index = closeIndex + 1;
        continue;
      }
      if (DIV_OPEN.test(value)) {
        stack.push(index);
      } else if (DIV_CLOSE.test(value) && stack.length) {
        this.div_close.set(stack.pop()!, index);
      }
      index += 1;
    }
    for (const opening of stack) {
      this.div_close.set(opening, null);
      this.unclosed.push([opening, ":::"]);
    }
    for (const [opening, closing] of this.div_close) {
      if (closing !== null) {
        for (let line = opening + 1; line < closing; line += 1) depth[line]! += 1;
      }
    }
    this.unclosed.sort((a, b) => a[0] - b[0]);
    this.in_code = inCode;
    this.depth = depth;
  }
}

export function parse(text: string): Doc {
  const [frontEnd, meta, metaError] = frontMatter(text);
  const lines = new _Lines(text);
  let first = frontEnd < lines.total ? lines.index_at(frontEnd) : lines.length;
  if (first < 0) first = 0;
  if (frontEnd && first < lines.length && lines.starts[first]! < frontEnd) first += 1;
  const scan = new _Scan(lines, first);

  // 1. Page splitting: headings inside code, inside a closed :::, or in the
  // middle of a paragraph are not headings.
  const heads: number[] = [];
  const markers = new Map<number, [string, number]>();
  for (let index = first; index < lines.length; index += 1) {
    if (scan.in_code[index] || scan.depth[index]) continue;
    const value = lines.line(index);
    const marker = DIV_OPEN.test(value) ? div_attrs(value).id : "";
    const close = scan.div_close.get(index);
    if (
      (marker === "toc" || marker === "refs")
      && close !== undefined
      && close !== null
      && allBlank(lines, index + 1, close)
    ) {
      const previous = heads.length ? HEADING.exec(lines.line(heads[heads.length - 1]!)) : null;
      const previousAttrs = previous ? ATTR_TAIL.exec(previous[2]!) : null;
      const expectedId = marker === "refs" ? "references" : "toc";
      if (
        previousAttrs
        && parse_attrs(previousAttrs[1]!).id === expectedId
        && allBlank(lines, heads[heads.length - 1]! + 1, index)
      ) {
        markers.set(heads[heads.length - 1]!, [marker, close]);
      } else {
        heads.push(index);
        markers.set(index, [marker, close]);
      }
      continue;
    }
    const heading = HEADING.exec(value);
    if (!heading) continue;
    const previousOk = index === first
      || lines.blank(index - 1)
      || (heads.length > 0 && heads[heads.length - 1] === index - 1);
    if (previousOk) heads.push(index);
  }

  const pages: Page[] = [];
  for (let count = 0; count < heads.length; count += 1) {
    const index = heads[count]!;
    const heading = HEADING.exec(lines.line(index));
    const marker = markers.get(index);
    if (marker) {
      const [kind, close] = marker;
      const end = count + 1 < heads.length ? lines.starts[heads[count + 1]!]! : lines.total;
      const title = kind === "toc" ? "目次" : "参考文献";
      const pageId = kind === "toc" ? "toc" : "references";
      let divLine = index;
      while (divLine < close && !DIV_OPEN.test(lines.line(divLine))) divLine += 1;
      const classes = [kind + "-slide", ...div_attrs(lines.line(divLine)).classes];
      pages.push(new Page(
        count,
        2,
        title,
        new Attrs(pageId, classes, {}),
        lines.starts[index]!,
        lines.ends[close]!,
        end,
        kind,
      ));
      continue;
    }

    let rawTitle = heading![2]!;
    let attrs = new Attrs();
    const attributeMatch = ATTR_TAIL.exec(rawTitle);
    if (attributeMatch) {
      attrs = parse_attrs(attributeMatch[1]!);
      // match.index is already a UTF-16 boundary; slicing there produces the
      // same prefix as Python's `raw_title[:am.start()]` (code-point boundary).
      rawTitle = rawTitle.slice(0, attributeMatch.index);
    }
    rawTitle = pyStrip(rawTitle.replace(TRAILING_HASHES, ""));
    const end = count + 1 < heads.length ? lines.starts[heads[count + 1]!]! : lines.total;
    pages.push(new Page(
      count,
      heading![1]!.length,
      rawTitle,
      attrs,
      lines.starts[index]!,
      lines.ends[index]!,
      end,
      attrs.id === "references" ? "refs" : "",
    ));
  }

  // 2. From the first unclosed fence/div to the end, keep the source as-is.
  let unclosedAt: number | null = null;
  if (scan.unclosed.length) {
    unclosedAt = lines.starts[scan.unclosed[0]![0]]!;
    for (const page of pages) {
      if (page.end > unclosedAt) page.raw_only = true;
    }
    for (const [line, kind] of scan.unclosed) {
      const start = lines.starts[line]!;
      const page = pages.find((candidate) => candidate.start <= start && start < candidate.end);
      if (page) page.unclosed.push(kind);
    }
  }

  // 3. Chunk splitting.
  for (const page of pages) {
    if (page.raw_only || page.generated) continue;
    const start = lines.index_at(page.head_end) + 1;
    const end = page.end > page.head_end + 1 ? lines.index_at(page.end - 1) + 1 : start;
    page.chunks = chunks(lines, scan, start, end, "");
  }

  return new Doc(text, [0, frontEnd], meta, metaError, pages, unclosedAt);
}

function listKind(value: string): string | null {
  const match = LIST_KIND.exec(value);
  if (!match) return null;
  return match[1] ? "-" : match[2]!;
}

function blocks(lines: _Lines, scan: _Scan, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let current: number | null = null;
  let last = -1;
  let index = start;
  while (index < end) {
    const value = lines.line(index);
    if (current === null) {
      if (lines.blank(index)) {
        index += 1;
        continue;
      }
      const previous = out.length ? out[out.length - 1]! : null;
      // Indented continuations and same-kind list items rejoin the prior block.
      if (
        previous
        && (/^[ \t]/u.test(value) || (listKind(value) && listKind(value) === listKind(lines.line(previous[0]))))
      ) {
        current = out.pop()![0];
      } else {
        current = index;
      }
    }
    const closer = scan.code_close.has(index)
      ? scan.code_close.get(index)
      : scan.div_close.get(index);
    if (closer !== undefined && closer !== null) {
      const openedBlock = current === index;
      last = Math.min(closer, end - 1);
      index = last + 1;
      if (openedBlock) {
        out.push([current, last]);
        current = null;
      }
      continue;
    }
    if (/^\s*\$\$/u.test(value) && !SINGLE_LINE_MATH.test(value)) {
      let close: number | null = null;
      for (let next = index + 1; next < end; next += 1) {
        if (lines.line(next).includes("$$")) {
          close = next;
          break;
        }
      }
      if (close !== null) {
        last = close;
        index = close + 1;
        continue;
      }
    }
    if (lines.blank(index)) {
      out.push([current, last]);
      current = null;
      index += 1;
      continue;
    }
    last = index;
    index += 1;
  }
  if (current !== null) out.push([current, last]);
  return out;
}

function chunks(lines: _Lines, scan: _Scan, start: number, end: number, prefix: string): Chunk[] {
  return blocks(lines, scan, start, end).map(([first, last], index) =>
    classify(lines, scan, first, last, `${prefix}${index}`));
}

function classify(lines: _Lines, scan: _Scan, first: number, last: number, path: string): Chunk {
  const start = lines.starts[first]!;
  const end = lines.ends[last]!;
  const firstLine = lines.line(first);
  const one = pyStrip(lines.slice(start, end));
  const chunk = new Chunk("text", start, end, path);

  if (scan.code_close.has(first)) {
    const info = pyStrip(FENCE_OPEN.exec(firstLine)![2]!);
    chunk.kind = scan.code_close.get(first) === last && info.startsWith("{=") ? "opaque" : "text";
    if (scan.code_close.get(first) !== last) chunk.kind = "text";
    return chunk;
  }

  if (scan.div_close.has(first) && scan.div_close.get(first) === last) {
    const attrs = div_attrs(firstLine);
    chunk.attrs = attrs;
    chunk.open = [lines.starts[first]!, lines.ends[first]!];
    chunk.close = [lines.starts[last]!, lines.ends[last]!];
    if (attrs.classes.includes("columns")) {
      const columns: Chunk[] = [];
      let validColumns = true;
      for (const [columnFirst, columnLast] of blocks(lines, scan, first + 1, last)) {
        if (!(
          scan.div_close.has(columnFirst)
          && scan.div_close.get(columnFirst) === columnLast
          && div_attrs(lines.line(columnFirst)).classes.includes("column")
        )) {
          validColumns = false;
          break;
        }
        const column = new Chunk(
          "column",
          lines.starts[columnFirst]!,
          lines.ends[columnLast]!,
          `${path}.${columns.length}`,
        );
        column.attrs = div_attrs(lines.line(columnFirst));
        column.open = [lines.starts[columnFirst]!, lines.ends[columnFirst]!];
        column.close = [lines.starts[columnLast]!, lines.ends[columnLast]!];
        column.children = chunks(
          lines,
          scan,
          columnFirst + 1,
          columnLast,
          `${path}.${columns.length}.`,
        );
        columns.push(column);
      }
      if (validColumns) {
        chunk.kind = "columns";
        chunk.children = columns;
        return chunk;
      }
      chunk.kind = "opaque";
      return chunk;
    }

    const classes = new Set(attrs.classes);
    const coverParts = [...classes].filter((name) => COVER_PARTS.has(name));
    const coverClasses = new Set([...classes].filter((name) => !COVER_PARTS.has(name)));
    const cover = coverParts.length === 1 && isSubset(coverClasses, new Set(["incremental"]));
    const boxClasses = isSubset(classes, new Set(["row", "incremental"]));
    const boxKeys = isSubset(new Set(Object.keys(attrs.kv)), BOX_KEYS);
    if ((cover || boxClasses) && boxKeys) {
      chunk.kind = "box";
      chunk.children = chunks(lines, scan, first + 1, last, `${path}.`);
      return chunk;
    }
    chunk.kind = "opaque";
    return chunk;
  }

  if (first === last && FIG_LINE.test(one)) {
    chunk.kind = "fig";
  } else if (first === last && IMAGE_LINE.test(one)) {
    chunk.kind = "image";
  } else if (FOOTNOTE_DEF.test(firstLine) || LINK_DEF.test(firstLine)) {
    chunk.kind = "def";
  } else if (RAW_HTML.test(firstLine) || DIV_OPEN.test(firstLine)) {
    chunk.kind = "opaque";
  }
  return chunk;
}

// ---------------------------------------------------------------- 図の参照

export function fig_args(line: string): Record<string, string> | null {
  const match = FIG_LINE.exec(pyStrip(line));
  if (!match) return null;
  const token = new RegExp(
    String.raw`(${WH}+)=(?:"((?:[^"\\]|\\${DOT})*)"|'([^']*)'|(\S+))|("(?:[^"\\]|\\${DOT})*"|\S+)`,
    "gu",
  );
  const out: Record<string, string> = {};
  for (const item of findAll(token, match[1]!)) {
    const key = item[1];
    const doubleQuoted = item[2] ?? "";
    const singleQuoted = item[3] ?? "";
    const bare = item[4] ?? "";
    const positional = item[5] ?? "";
    if (key) {
      out[key] = (doubleQuoted || (!singleQuoted && !bare))
        ? doubleQuoted
        : singleQuoted || bare;
    } else if (!("ref" in out)) {
      out.ref = positional.replace(/^"+|"+$/gu, "");
    }
  }
  return "ref" in out ? out : null;
}

// ---------------------------------------------------------------- 描画用の原稿

class _Emitter {
  readonly lines: string[] = [];
  readonly origin: Array<number | null> = [];

  constructor(readonly L: _Lines) {}

  raw(start: number, end: number): void {
    const first = this.L.index_at(start);
    const value = this.L.slice(start, end);
    value.split("\n").forEach((line, index) => {
      this.lines.push(line);
      this.origin.push(first + index + 1);
    });
  }

  same_lines(start: number, _end: number, text: string): void {
    const first = this.L.index_at(start);
    text.split("\n").forEach((line, index) => {
      this.lines.push(line);
      this.origin.push(first + index + 1);
    });
  }

  gen(text: string): void {
    for (const line of text.split("\n")) {
      this.lines.push(line);
      this.origin.push(null);
    }
  }

  blank(): void {
    if (this.lines.length && this.lines[this.lines.length - 1] !== "") this.gen("");
  }

  result(): [string, Array<number | null>] {
    return [`${this.lines.join("\n")}\n`, this.origin];
  }
}

export function math_breaks(tex: string): string {
  const lines = tex.split("\n");
  const body: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (pyStrip(lines[index]!).length) body.push(index);
  }
  if (
    body.length === 0
    || (body.length < 2 && !tex.includes("\\\\"))
    || MATH_ENV.test(tex)
  ) {
    return tex;
  }
  const environment = body.some((index) => /(?<!\\)&/u.test(lines[index]!))
    ? "aligned"
    : "gathered";
  for (const index of body.slice(0, -1)) {
    lines[index] = `${lines[index]!.replace(TRAILING_MATH_BREAK, "")} \\\\`;
  }
  const firstBodyLine = body[0]!;
  const lastBodyLine = body[body.length - 1]!;
  lines[firstBodyLine] = `\\begin{${environment}} ${lines[firstBodyLine]!}`;
  lines[lastBodyLine] = `${lines[lastBodyLine]!} \\end{${environment}}`;
  return lines.join("\n");
}

function emitText(emitter: _Emitter, start: number, end: number): void {
  const raw = emitter.L.slice(start, end);
  // Anchor at the absolute end so the non-greedy middle expands to a full
  // match, exactly like Python's `PURE_MATH.fullmatch(raw)`.
  const fullMath = new RegExp(`^(?:${PURE_MATH.source})(?![\\s\\S])`, PURE_MATH.flags);
  const match = fullMath.exec(raw);
  if (match && !match[2]!.includes("$$")) {
    emitter.same_lines(start, end, match[1]! + math_breaks(match[2]!) + match[3]!);
  } else {
    emitter.raw(start, end);
  }
}

export function wrapped_source(doc: Doc, wrap = true): [string, Array<number | null>] {
  const lines = new _Lines(doc.text);
  const emitter = new _Emitter(lines);
  if (doc.front[1]) emitter.raw(0, doc.front[1]);
  if (doc.pages.length) {
    const preEnd = doc.pages[0]!.start;
    if (preEnd > doc.front[1]) emitter.raw(doc.front[1], preEnd);
  }
  for (const page of doc.pages) {
    emitter.blank();
    if (page.generated) {
      const classes = page.attrs.classes.map((name) => `.${name}`).join(" ");
      emitter.gen(`## ${page.title} {#${page.id} ${classes}}`);
      if (page.generated === "refs") {
        emitter.blank();
        emitter.gen("::: {#refs}");
        emitter.gen(":::");
      }
    } else {
      emitter.raw(page.start, page.head_end);
    }
    emitter.blank();
    if (page.raw_only) {
      if (page.end > page.head_end + 1) {
        emitter.raw(
          page.head_end + 1,
          lines.slice(page.end - 1, page.end) === "\n" ? page.end - 1 : page.end,
        );
      }
      for (const kind of page.unclosed) {
        if (kind !== ":::") continue;
        emitter.blank();
        emitter.gen(":::");
      }
      continue;
    }
    for (const chunk of page.chunks) {
      emitter.blank();
      if (wrap) {
        emitChunk(emitter, chunk, page.index);
      } else if (chunk.kind === "text") {
        emitText(emitter, chunk.start, chunk.end);
      } else {
        emitter.raw(chunk.start, chunk.end);
      }
    }
  }
  return emitter.result();
}

function emitChunk(emitter: _Emitter, chunk: Chunk, page: number): void {
  if (chunk.kind === "def") {
    emitter.raw(chunk.start, chunk.end);
    emitter.blank();
    return;
  }
  emitter.gen(`::: {.slide-studio-c data-slide-studio="p${page}/${chunk.path}"}`);
  emitter.blank();
  if (chunk.container) {
    emitter.raw(chunk.open![0], chunk.open![1]);
    for (const child of chunk.children) {
      emitter.blank();
      emitChunk(emitter, child, page);
    }
    emitter.blank();
    emitter.raw(chunk.close![0], chunk.close![1]);
  } else if (chunk.kind === "text") {
    emitText(emitter, chunk.start, chunk.end);
  } else {
    emitter.raw(chunk.start, chunk.end);
  }
  emitter.blank();
  emitter.gen(":::");
  emitter.blank();
}

// ---------------------------------------------------------------- 未対応の記法

export function unsupported(doc: Doc): Array<{ page: number; message: string }> {
  const out: Array<{ page: number; message: string }> = [];
  const lines = new _Lines(doc.text);
  for (const page of doc.pages) {
    const body = lines.slice(page.head_end, page.end);
    for (const match of findAll(SHORTCODE, body)) {
      if (match[1] !== "fig") {
        out.push({
          page: page.index,
          message: `Slide Studio では未対応の記法：ショートコード {{< ${match[1]} >}}`,
        });
      }
    }
    for (const match of findAll(CROSSREF, body)) {
      out.push({
        page: page.index,
        message: `Slide Studio では未対応の記法：相互参照 ${match[0]}`,
      });
    }
    for (const chunk of page.walk()) {
      if (chunk.attrs && chunk.attrs.classes.some((name) => name.startsWith("callout"))) {
        out.push({
          page: page.index,
          message: "Slide Studio では未対応の記法：callout",
        });
      }
    }
    for (const _match of findAll(CODE_EXEC, body)) {
      out.push({
        page: page.index,
        message: "Slide Studio では未対応の記法：コードの実行",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 原文への書き戻し

export function locate(doc: Doc, key: string): [Page, Chunk] {
  const match = new RegExp(
    String.raw`^p(${DIGIT}+)/([${DIGIT}.]+)(?![\s\S])`,
    "u",
  ).exec(key);
  if (!match) throw new ValueError("チャンクが見つかりません");
  const pageIndex = pythonInt(match[1]!);
  const page = doc.pages.find((candidate) => candidate.index === pageIndex);
  if (!page || page.raw_only) throw new ValueError("このページは原稿で編集してください");
  let chunk: Chunk | null = null;
  for (const candidate of page.walk()) {
    if (candidate.path === match[2]) {
      chunk = candidate;
      break;
    }
  }
  if (!chunk || chunk.kind === "def") throw new ValueError("チャンクが見つかりません");
  return [page, chunk];
}

function compareEdits(a: [number, number, string], b: [number, number, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

export function rewrite(doc: Doc, replacements: Record<string, string> | null = null): string {
  const edits: Array<[number, number, string]> = Object.entries(replacements ?? {}).map(
    ([key, value]) => {
      const chunk = locate(doc, key)[1];
      return [chunk.start, chunk.end, value];
    },
  );
  edits.sort(compareEdits);
  for (let index = 0; index + 1 < edits.length; index += 1) {
    if (edits[index]![1] > edits[index + 1]![0]) {
      throw new ValueError("囲みと中身を同時に変更できません");
    }
  }

  let text = doc.text;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const [start, end, value] = edits[index]!;
    const current = new _Lines(text);
    text = current.slice(0, start) + value + current.slice(end, Number.POSITIVE_INFINITY);
  }
  return text;
}

export function move_chunk(
  doc: Doc,
  key: string,
  page_index: number,
  before: string | null = null,
): string {
  const [, chunk] = locate(doc, key);
  const page = doc.pages.find((candidate) => candidate.index === page_index);
  if (!page || page.raw_only) throw new ValueError("このページは原稿で編集してください");

  let position: number;
  if (before) {
    const [targetPage, target] = locate(doc, before);
    if (targetPage !== page) throw new ValueError("移動先のページが違います");
    position = target.start;
  } else {
    position = page.end;
  }
  if (chunk.start <= position && position <= chunk.end) {
    if (position === chunk.start) return doc.text;
    throw new ValueError("自分の中には移動できません");
  }

  const raw = sliceText(doc.text, chunk.start, chunk.end);
  // Preserve definition/surrounding source and guarantee blank-line boundaries.
  const insertion = `\n\n${raw}\n\n`;
  const edits: Array<[number, number, string]> = [
    [chunk.start, chunk.end, ""],
    [position, position, insertion],
  ];
  edits.sort((a, b) => compareEdits(b, a));

  let text = doc.text;
  for (const [start, end, value] of edits) {
    const current = new _Lines(text);
    text = current.slice(0, start) + value + current.slice(end, Number.POSITIVE_INFINITY);
  }
  return text;
}

// ---------------------------------------------------------------- 表のセル

export function table_rows(raw: string): Array<Array<[number, number]>> | null {
  const lines = raw.split("\n");
  if (lines.length < 2 || !fullMatch(TABLE_RULE, lines[1]!)) return null;

  const rows: Array<Array<[number, number]>> = [];
  let position = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index !== 1) {
      const bars: number[] = [];
      for (const match of findAll(CELL_PART, line)) {
        if (match[0] === "|") bars.push(utf16ToCodePoint(line, match.index));
      }
      if (!bars.length) return null;
      const cuts: number[] = [];
      if (pyStrip(sliceText(line, 0, bars[0]!)).length) cuts.push(-1);
      cuts.push(...bars);
      if (pyStrip(sliceText(line, bars[bars.length - 1]! + 1, codePointLength(line))).length) {
        cuts.push(codePointLength(line));
      }
      const row: Array<[number, number]> = [];
      for (let cell = 0; cell + 1 < cuts.length; cell += 1) {
        row.push([position + cuts[cell]! + 1, position + cuts[cell + 1]!]);
      }
      rows.push(row);
    }
    position += codePointLength(line) + 1;
  }
  return rows;
}

export function set_cell(
  doc: Doc,
  key: string,
  row: number,
  col: number,
  markdown: string,
): string {
  const [, chunk] = locate(doc, key);
  const raw = sliceText(doc.text, chunk.start, chunk.end);
  const rows = chunk.kind === "text" ? table_rows(raw) : null;
  if (
    !rows
    || row < 0
    || row >= rows.length
    || col < 0
    || col >= rows[row]!.length
  ) {
    throw new ValueError("セルが見つかりません");
  }

  const [start, end] = rows[row]![col]!;
  const old = sliceText(raw, start, end);
  let lead: string;
  let trail: string;
  if (pyStrip(old).length) {
    const left = pyLstrip(old);
    const right = pyRstrip(old);
    lead = sliceText(old, 0, codePointLength(old) - codePointLength(left));
    trail = sliceText(old, codePointLength(right), codePointLength(old));
  } else {
    lead = " ";
    trail = " ";
  }

  const replacement = sliceText(raw, 0, start)
    + lead
    + markdown
    + trail
    + sliceText(raw, end, codePointLength(raw));
  return rewrite(doc, { [key]: replacement });
}

export function image_options(
  doc: Doc,
  key: string,
  width: number | null,
  align: string,
): string {
  const [, chunk] = locate(doc, key);
  if (
    chunk.kind !== "image"
    || (width !== null && !(width >= 1 && width <= 1280))
    || (align !== "left" && align !== "center" && align !== "right")
  ) {
    throw new ValueError("画像の幅・揃えが正しくありません");
  }

  const raw = sliceText(doc.text, chunk.start, chunk.end);
  const match = ATTR_TAIL.exec(raw);
  let attrs = match ? match[1]! : "";
  const keys = width === null ? "fig-align" : "width|fig-align";
  attrs = pyStrip(attrs.replace(
    new RegExp(String.raw`(?:^|\s)(?:${keys})=(?:"[^"]*"|'[^']*'|\S+)`, "gu"),
    "",
  ));
  const base = match ? raw.slice(0, match.index) : raw;
  const size = width === null ? "" : `width=${width} `;
  return rewrite(doc, {
    [key]: `${base}{${attrs ? `${attrs} ` : ""}${size}fig-align="${align}"}`,
  });
}
