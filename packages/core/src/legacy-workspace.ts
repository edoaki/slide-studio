/**
 * Compatibility layer for the legacy Python workspace model.
 *
 * The on-disk contract is intentionally identical to the original
 * `slide_studio/workspace.py`: `decks/`, `topics/`, `themes/` and the hidden
 * `.slide-studio/` state directory live directly under the selected root.
 * Every write in this module is atomic.
 *
 * Source parsing is delegated to a parser callback when the integration layer
 * provides `legacy-source.ts`. A small local parser is used until that module
 * is available; it implements the front-matter and page-boundary parts needed
 * by workspace operations without copying the legacy Python application.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { CoreErrorCode } from "../../contracts/src/desktop.js";
import { assetPath } from "./assets.js";
import { CoreError, isNodeError } from "./errors.js";
import {
  assertAbsoluteRoot,
  assertInsideRoot,
  assertSafeDeckId,
  canonicalRoot,
  isInsideRoot,
} from "./paths.js";

export const VERSION = "0.1.0";

/** Bundled templates. The runtime can replace these roots in integration tests. */
export let TEMPLATES = assetPath("templates");
export let RUNTIME = assetPath("runtime");

export function set_templates_root(path: string): void {
  TEMPLATES = resolve(path);
}

export function set_runtime_root(path: string): void {
  RUNTIME = resolve(path);
}

const NAME = /^[a-z0-9][a-z0-9-]*$/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export const RUNTIME_FILES = ["figure.mjs", "motion.mjs", "figure.css"] as const;

/** Previously shipped default themes that may be upgraded in place. */
export const OLD_DEFAULT_THEMES = new Set<string>([
  "6c68f6dd20506ee79b5d70c1e9b98e2bea4fdc82efbd0880d57400b3abf36010",
  "c0d0274749f3d6aaba9a55f871d5cd7cc716ef32d84264e89c72f3d421253e08",
]);

/** Previously shipped non-default themes, keyed by file name. */
export const OLD_THEMES: Record<string, Set<string>> = {
  "graphite.css": new Set(["0658790fab7e283857cec03cb5be6a6e8be57d3c83aa3d6ba02844ebb583314e"]),
  "serif.css": new Set(["cd884b15fed2797d38215860ac8103fba502d14aa1cd6f00a5b221b0006529e9"]),
  "solarized.css": new Set(["85b228bb48b2a3ec9c8abfb978dac05741b9ccf2755f6b614d79f8088e460a2c"]),
  "mist.css": new Set([
    "2656730b18615d99c913560c5be61cde732d2d47fd3a63cb89cdad3785e26255",
    "cc107dfd25460ea4345406efa0287246763e4174efc2035bceb082074d7fd1ea",
  ]),
  "night.css": new Set([
    "b6547be3896e5b0e82d624b0b499409abe40516b8a2d7412af7d815b22d49428",
    "b815b3f3585929435c54c37d6a9c4de1132393bf8e1772a5c9357627b5c9675d",
  ]),
};

/** Themes retired from the bundled set. Decks and prefs move to `default`. */
export const RETIRED_THEMES = ["sage", "simple"] as const;

export class StudioError extends CoreError {
  constructor(message: string, code: CoreErrorCode = "INVALID_INPUT") {
    super(code, message);
    this.name = "StudioError";
  }
}

function expandUser(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function sha256Bytes(data: Buffer | string): string {
  // Kept local so this module has no dependency on the newer source service.
  return createHash("sha256").update(data).digest("hex");
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

function existsNoFollow(path: string): boolean {
  return lstatOrNull(path) !== null;
}

function readIfFile(path: string): Buffer | null {
  const link = lstatOrNull(path);
  if (!link || link.isSymbolicLink() || !link.isFile()) return null;
  return readFileSync(path);
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed state is treated as empty, as in the legacy app.
  }
  return {};
}

function readJsonArray(path: string): Record<string, unknown>[] {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      );
    }
  } catch {
    // Missing or malformed state is treated as empty.
  }
  return [];
}

function primitiveFrontValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  return JSON.stringify(value);
}

function sortedJson(value: Record<string, unknown>, indent = 0): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) ordered[key] = value[key];
  return JSON.stringify(ordered, null, indent);
}

function timeNs(): string {
  return (BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n).toString();
}

function sameJson(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function atomicWrite(path: string, data: string | Uint8Array, mode?: number): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  let finalMode = mode;
  if (finalMode === undefined) {
    const existing = lstatOrNull(path);
    finalMode = existing && existing.isFile()
      ? existing.mode & 0o777
      : 0o666 & ~process.umask();
  }
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", finalMode);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    try {
      chmodSync(temporary, finalMode);
    } catch {
      // Windows may not support every mode bit; the content is still atomic.
    }
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

// ---------------------------------------------------------------- front matter

export interface LegacyAttrs {
  id: string;
  classes: string[];
  kv: Record<string, string>;
  to_json(): { id: string; classes: string[]; kv: Record<string, string> };
}

function makeAttrs(id = "", classes: string[] = [], kv: Record<string, string> = {}): LegacyAttrs {
  return {
    id,
    classes,
    kv,
    to_json() {
      return { id, classes: [...classes], kv: { ...kv } };
    },
  };
}

const ATTR_TOKEN = /#([^\s}]+)|\.([^\s}=]+)|([^\s=}]+)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s}]*))/gu;

function parseAttrs(inner: string): LegacyAttrs {
  const attrs = makeAttrs();
  for (const match of inner.matchAll(ATTR_TOKEN)) {
    if (match[1]) {
      attrs.id = match[1];
    } else if (match[2]) {
      attrs.classes.push(match[2]);
    } else {
      const value = match[4] ?? match[5] ?? match[6] ?? "";
      attrs.kv[match[3] ?? ""] = value.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    }
  }
  return attrs;
}

const DIV_OPEN = /^ {0,3}(:{3,})[ \t]*(\{[^{}]*\}|[\w-]+)[ \t]*:*[ \t]*$/u;
const DIV_CLOSE = /^ {0,3}:{3,}[ \t]*$/u;
const HEADING = /^(#{1,2})[ \t]+(.*?)[ \t]*$/u;
const ATTR_TAIL = /[ \t]*\{([^{}]*)\}[ \t]*$/u;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

function divAttrs(line: string): LegacyAttrs {
  const match = DIV_OPEN.exec(line);
  if (!match) return makeAttrs();
  const spec = match[2] ?? "";
  return spec.startsWith("{") ? parseAttrs(spec.slice(1, -1)) : makeAttrs("", [spec]);
}

export interface LegacyPage {
  index: number;
  level: number;
  title: string;
  attrs: LegacyAttrs;
  start: number;
  head_end: number;
  end: number;
  generated: string;
  raw_only: boolean;
  unclosed: string[];
  id: string;
  to_json(): Record<string, unknown>;
}

export interface LegacyDocument {
  text: string;
  front: [number, number];
  meta: Record<string, unknown>;
  meta_error: string;
  pages: LegacyPage[];
  unclosed_at: number | null;
  body_start: number;
  preamble: string;
  to_json(): Record<string, unknown>;
}

export type LegacySourceParser = (text: string) => LegacyDocument;

let configuredParser: LegacySourceParser | null = null;

/** The integration layer can register `legacy-source.parse` here. */
export function set_source_parser(parser: LegacySourceParser | null): void {
  configuredParser = parser;
}

class Lines {
  readonly text: string;
  readonly starts: number[] = [];
  readonly ends: number[] = [];

  constructor(text: string) {
    this.text = text;
    let position = 0;
    for (const line of text.split("\n")) {
      this.starts.push(position);
      this.ends.push(position + line.length);
      position += line.length + 1;
    }
    if (text.endsWith("\n")) {
      this.starts.pop();
      this.ends.pop();
    }
  }

  get length(): number {
    return this.starts.length;
  }

  line(index: number): string {
    return this.text.slice(this.starts[index] ?? 0, this.ends[index] ?? 0).replace(/\r$/u, "");
  }

  blank(index: number): boolean {
    return !this.line(index).trim();
  }

  indexAt(offset: number): number {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.starts[middle] ?? 0) <= offset) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }
}

interface ScanState {
  code_close: Map<number, number>;
  div_close: Map<number, number | null>;
  unclosed: Array<[number, string]>;
  in_code: boolean[];
  depth: number[];
}

function frontMatter(text: string): { end: number; meta: Record<string, unknown>; error: string } {
  if (!text.startsWith("---")) return { end: 0, meta: {}, error: "" };
  const match = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!match) return { end: 0, meta: {}, error: "" };
  const end = match[0].length;
  try {
    const document = parseDocument(match[1] ?? "", { prettyErrors: false });
    if (document.errors.length > 0) throw new Error(document.errors.map((item) => item.message).join("; "));
    let meta = document.toJS({ maxAliasCount: 10 }) as unknown;
    if (meta === null || meta === undefined) meta = {};
    if (typeof meta !== "object" || Array.isArray(meta)) {
      return { end, meta: {}, error: "front matter が辞書ではありません" };
    }
    const result = meta as Record<string, unknown>;
    if (!("topic" in result) && "figures" in result) result.topic = result.figures;
    return { end, meta: result, error: "" };
  } catch (error) {
    return { end, meta: {}, error: `front matter を読めません: ${String(error)}` };
  }
}

function scanDocument(lines: Lines, first: number): ScanState {
  const codeClose = new Map<number, number>();
  const divClose = new Map<number, number | null>();
  const unclosed: Array<[number, string]> = [];
  const inCode = new Array<boolean>(lines.length).fill(false);
  const depth = new Array<number>(lines.length).fill(0);
  const stack: number[] = [];
  let index = first;
  while (index < lines.length) {
    const source = lines.line(index);
    const fence = FENCE_OPEN.exec(source);
    if (fence && !(fence[1]?.[0] === "`" && (fence[2] ?? "").includes("`"))) {
      const character = fence[1]?.[0] ?? "`";
      const minimum = fence[1]?.length ?? 3;
      const close = new RegExp(`^ {0,3}${character}{${minimum},}[ \\t]*$`, "u");
      let closing = -1;
      for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
        if (close.test(lines.line(candidate))) {
          closing = candidate;
          break;
        }
      }
      if (closing < 0) {
        unclosed.push([index, "```"]);
        index += 1;
        continue;
      }
      codeClose.set(index, closing);
      for (let line = index; line <= closing; line += 1) inCode[line] = true;
      index = closing + 1;
      continue;
    }
    if (DIV_OPEN.test(source)) {
      stack.push(index);
    } else if (DIV_CLOSE.test(source) && stack.length > 0) {
      const opening = stack.pop();
      if (opening !== undefined) divClose.set(opening, index);
    }
    index += 1;
  }
  for (const opening of stack) {
    divClose.set(opening, null);
    unclosed.push([opening, ":::"]);
  }
  for (const [opening, closing] of divClose) {
    if (closing !== null) {
      for (let line = opening + 1; line < closing; line += 1) depth[line] = (depth[line] ?? 0) + 1;
    }
  }
  unclosed.sort((left, right) => left[0] - right[0]);
  return { code_close: codeClose, div_close: divClose, unclosed, in_code: inCode, depth };
}

function makePage(
  index: number,
  level: number,
  title: string,
  attrs: LegacyAttrs,
  start: number,
  headEnd: number,
  end: number,
  generated = "",
): LegacyPage {
  const page = {
    index,
    level,
    title,
    attrs,
    start,
    head_end: headEnd,
    end,
    generated,
    raw_only: false,
    unclosed: [] as string[],
    get id() {
      return attrs.id;
    },
  } as unknown as LegacyPage;
  page.to_json = () => ({
    index,
    level,
    title,
    id: attrs.id,
    classes: [...attrs.classes],
    kv: { ...attrs.kv },
    start,
    head_end: headEnd,
    end,
    generated,
    raw_only: page.raw_only,
    unclosed: [...page.unclosed],
    chunks: [],
  });
  return page;
}

export function parseLegacySource(text: string): LegacyDocument {
  const front = frontMatter(text);
  const lines = new Lines(text);
  let first = front.end < text.length ? lines.indexAt(front.end) : lines.length;
  if (first < 0) first = 0;
  if (front.end && first < lines.length && (lines.starts[first] ?? 0) < front.end) first += 1;
  const scan = scanDocument(lines, first);

  const heads: number[] = [];
  const markers = new Map<number, { marker: string; close: number }>();
  for (let index = first; index < lines.length; index += 1) {
    if (scan.in_code[index] || (scan.depth[index] ?? 0) > 0) continue;
    const marker = DIV_OPEN.test(lines.line(index)) ? divAttrs(lines.line(index)).id : "";
    const closing = scan.div_close.get(index);
    if (
      (marker === "toc" || marker === "refs")
      && closing !== undefined
      && closing !== null
      && rangeBlank(lines, index + 1, closing)
    ) {
      const previousIndex = heads[heads.length - 1];
      const previous = previousIndex === undefined ? null : HEADING.exec(lines.line(previousIndex));
      const previousAttrs = previous ? ATTR_TAIL.exec(previous[2] ?? "") : null;
      const expected = marker === "refs" ? "references" : "toc";
      if (
        previousAttrs
        && parseAttrs(previousAttrs[1] ?? "").id === expected
        && previousIndex !== undefined
        && rangeBlank(lines, previousIndex + 1, index)
      ) {
        markers.set(previousIndex, { marker, close: closing });
      } else {
        heads.push(index);
        markers.set(index, { marker, close: closing });
      }
      continue;
    }
    const heading = HEADING.exec(lines.line(index));
    if (!heading) continue;
    const previousBlank = index === first
      || lines.blank(index - 1)
      || (heads.length > 0 && heads[heads.length - 1] === index - 1);
    if (previousBlank) heads.push(index);
  }

  const pages: LegacyPage[] = [];
  for (let number = 0; number < heads.length; number += 1) {
    const index = heads[number] ?? 0;
    const next = heads[number + 1];
    const end = next === undefined ? text.length : (lines.starts[next] ?? text.length);
    const marker = markers.get(index);
    if (marker) {
      const title = marker.marker === "toc" ? "目次" : "参考文献";
      const id = marker.marker === "toc" ? "toc" : "references";
      let classes: string[] = [];
      for (let line = index; line <= marker.close; line += 1) {
        if (DIV_OPEN.test(lines.line(line))) {
          classes = divAttrs(lines.line(line)).classes;
          break;
        }
      }
      const page = makePage(
        number,
        2,
        title,
        makeAttrs(id, [`${marker.marker}-slide`, ...classes]),
        lines.starts[index] ?? 0,
        lines.ends[marker.close] ?? 0,
        end,
        marker.marker,
      );
      pages.push(page);
      continue;
    }
    const heading = HEADING.exec(lines.line(index));
    if (!heading) continue;
    let rawTitle = heading[2] ?? "";
    let attrs = makeAttrs();
    const attributeMatch = ATTR_TAIL.exec(rawTitle);
    if (attributeMatch) {
      attrs = parseAttrs(attributeMatch[1] ?? "");
      rawTitle = rawTitle.slice(0, attributeMatch.index);
    }
    rawTitle = rawTitle.replace(/[ \t]+#+[ \t]*$/u, "").trim();
    const page = makePage(
      number,
      (heading[1] ?? "").length,
      rawTitle,
      attrs,
      lines.starts[index] ?? 0,
      lines.ends[index] ?? 0,
      end,
      attrs.id === "references" ? "refs" : "",
    );
    pages.push(page);
  }

  let unclosedAt: number | null = null;
  if (scan.unclosed.length > 0) {
    const firstUnclosed = scan.unclosed[0];
    if (firstUnclosed) unclosedAt = lines.starts[firstUnclosed[0]] ?? null;
    if (unclosedAt !== null) {
      for (const page of pages) if (page.end > unclosedAt) page.raw_only = true;
      for (const [line, kind] of scan.unclosed) {
        const page = pages.find((item) => item.start <= (lines.starts[line] ?? 0) && (lines.starts[line] ?? 0) < item.end);
        if (page) page.unclosed.push(kind);
      }
    }
  }

  const bodyStart = front.end;
  const preambleEnd = pages[0]?.start ?? text.length;
  const document: LegacyDocument = {
    text,
    front: [0, front.end],
    meta: front.meta,
    meta_error: front.error,
    pages,
    unclosed_at: unclosedAt,
    body_start: bodyStart,
    preamble: text.slice(bodyStart, preambleEnd),
    to_json() {
      return {
        front: [0, front.end],
        meta: front.meta,
        meta_error: front.error,
        pages: pages.map((page) => page.to_json()),
      };
    },
  };
  return document;
}

function rangeBlank(lines: Lines, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) if (!lines.blank(index)) return false;
  return true;
}

export function parse_source(text: string): LegacyDocument {
  if (configuredParser) return configuredParser(text);
  return parseLegacySource(text);
}

// ---------------------------------------------------------------- public helpers

export function check_name(value: unknown, what = "名前"): string {
  if (
    typeof value !== "string"
    || !NAME.test(value)
    || WINDOWS_RESERVED.test(value.split(".", 1)[0] ?? "")
  ) {
    throw new StudioError(`${what}には英小文字・数字・ハイフンを使ってください: ${JSON.stringify(value)}`);
  }
  return value;
}

function validateWindowsDeckName(value: string): void {
  if (WINDOWS_RESERVED.test(value.split(".", 1)[0] ?? "")) {
    throw new StudioError(`予約された名前は使えません: ${JSON.stringify(value)}`);
  }
}

export function default_root(): string {
  const configured = process.env.SLIDE_STUDIO_HOME;
  if (configured) return resolve(expandUser(configured));
  return saved_root() ?? join(homedir(), "Slides");
}

export function location_file(): string {
  const override = process.env.SLIDE_STUDIO_LOCATION;
  if (override) return resolve(expandUser(override));
  return join(homedir(), ".config", "slide-studio", "location.json");
}

export function saved_root(): string | null {
  try {
    const value = readJsonObject(location_file()).root;
    if (typeof value !== "string") return null;
    const path = expandUser(value);
    return isAbsolute(path) ? resolve(path) : null;
  } catch {
    return null;
  }
}

export function recent_roots(): string[] {
  try {
    const data = readJsonObject(location_file());
    const recent = Array.isArray(data.recent) ? data.recent : [];
    const values: unknown[] = [data.root, ...recent];
    const seen: string[] = [];
    for (const value of values) {
      if (typeof value !== "string" || !isAbsolute(value)) continue;
      if (!seen.includes(value)) seen.push(value);
    }
    return seen.slice(0, 12);
  } catch {
    return [];
  }
}

export function remember_root(
  root: string,
  options: { previous?: string | null } = {},
): void {
  const values = [
    root,
    ...(options.previous ? [options.previous] : []),
    ...recent_roots(),
  ];
  const recent: string[] = [];
  for (const value of values) {
    if (!recent.includes(value)) recent.push(value);
  }
  atomicWrite(location_file(), JSON.stringify({ root, recent: recent.slice(0, 12) }));
}

export function theme_variables(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: string[] = [];
  const pattern = /(?<![\w-])(--[\w-]+)\s*:\s*[^;{}\s][^;{}]*(?=[;}])/gu;
  for (const match of withoutComments.matchAll(pattern)) {
    const name = match[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

export const THEME_VARIABLES = theme_variables(
  readFileSync(join(TEMPLATES, "themes", "_base.css"), "utf8"),
);

export function runtime_rel(fig_dir: string, ws: Workspace): string {
  // Python: os.path.relpath(ws.runtime, fig_dir). Node's relative(from, to)
  // takes the arguments in the opposite order.
  return (relative(fig_dir, ws.runtime) || ".").replaceAll(sep, "/");
}

export function figure_title(directory: string): string {
  const fallback = basename(directory);
  try {
    const data = readIfFile(join(directory, "figure.mjs"));
    if (!data) return fallback;
    const match = /\btitle\s*:\s*(['"`])([^\n]*?)\1/u.exec(data.toString("utf8"));
    return match?.[2] ?? fallback;
  } catch {
    return fallback;
  }
}

export function figure_steps(directory: string): string[] {
  try {
    const data = readIfFile(join(directory, "figure.mjs"));
    if (!data) return [];
    const text = data.toString("utf8");
    const match = /\bsteps\s*:\s*\[([\s\S]*?)\]/u.exec(text);
    if (!match) return [];
    const steps: string[] = [];
    for (const item of (match[1] ?? "").matchAll(/(['"`])([\s\S]*?)\1/gu)) {
      if (item[2] !== undefined) steps.push(item[2]);
    }
    return steps;
  } catch {
    return [];
  }
}

export function set_front(text: string, values: Record<string, unknown>): string {
  let document = parse_source(text);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) normalized[key === "figures" ? "topic" : key] = value;

  if (document.front[1] && "figures" in document.meta) {
    let head = text.slice(0, document.front[1]);
    if (/^topic\s*:/mu.test(head)) {
      head = head.replace(/^figures\s*:.*\r?\n/gmu, "");
    } else {
      head = head.replace(/^figures(?=\s*:)/gmu, "topic");
    }
    text = head + text.slice(document.front[1]);
    document = parse_source(text);
  }

  const entries = Object.entries(normalized);
  if (!document.front[1]) {
    if (entries.length === 0) return text;
    const lines = entries.map(([key, value]) => `${key}: ${primitiveFrontValue(value)}\n`).join("");
    return `---\n${lines}---\n\n${text}`;
  }

  const head = text.slice(0, document.front[1]);
  const rest = text.slice(document.front[1]);
  const lines = head.split("\n");
  let close = 0;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---" || line.trim() === "...") {
      close = index;
      break;
    }
  }
  const eol = head.includes("\r\n") ? "\r" : "";
  for (const [key, value] of entries) {
    const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:`, "u");
    let hit: number | null = null;
    for (let index = 1; index < close; index += 1) {
      if (pattern.test(lines[index] ?? "")) {
        hit = index;
        break;
      }
    }
    const rendered = `${key}: ${primitiveFrontValue(value)}${eol}`;
    if (hit !== null) {
      lines[hit] = rendered;
    } else {
      lines.splice(close, 0, rendered);
      close += 1;
    }
  }
  return lines.join("\n") + rest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function blank_qmd(shelf: string, theme: string, title?: string | null): string {
  let text = readFileSync(join(TEMPLATES, "deck", "slides.qmd"), "utf8")
    .split("{{SHELF}}").join(shelf)
    .split("{{THEME}}").join(theme);
  if (title) {
    const shown = title.replace(/[\r\n]/gu, " ");
    text = text.split("発表タイトル").join(shown);
    text = set_front(text, { title: JSON.stringify(title) });
  }
  return text;
}

// ---------------------------------------------------------------- workspace

export interface WorkspaceOptions {
  parser?: LegacySourceParser | null;
  templatesRoot?: string;
  runtimeRoot?: string;
  version?: string;
}

interface CopyOptions {
  ignore?: (directory: string, names: string[]) => string[];
}

export class Workspace {
  readonly root: string;
  readonly #templates: string;
  readonly #runtimeAssets: string;
  readonly #version: string;
  #parser: LegacySourceParser | null;

  constructor(root: string, options: WorkspaceOptions = {}) {
    const expanded = expandUser(root);
    if (!isAbsolute(expanded)) {
      throw new StudioError("workspace root must be an absolute path");
    }
    this.root = existsSync(expanded) ? canonicalRoot(expanded) : resolve(expanded);
    this.#templates = options.templatesRoot ? resolve(options.templatesRoot) : TEMPLATES;
    this.#runtimeAssets = options.runtimeRoot ? resolve(options.runtimeRoot) : RUNTIME;
    this.#version = options.version ?? VERSION;
    this.#parser = options.parser ?? null;
  }

  static open(
    root?: string | null,
    ensure = true,
    options: WorkspaceOptions = {},
  ): Workspace {
    const selected = root ?? default_root();
    const expanded = expandUser(selected);
    assertAbsoluteRoot(expanded);
    if (ensure) mkdirSync(expanded, { recursive: true });
    const workspace = new Workspace(expanded, options);
    if (ensure) workspace.ensure();
    return workspace;
  }

  // ------------------------------------------------------------ 場所
  get topics(): string {
    return join(this.root, "topics");
  }

  get decks(): string {
    return join(this.root, "decks");
  }

  get themes(): string {
    return join(this.root, "themes");
  }

  get state(): string {
    return join(this.root, ".slide-studio");
  }

  get runtime(): string {
    return join(this.state, "runtime");
  }

  build_dir(deck: string): string {
    return join(this.state, "build", this.#deckName(deck));
  }

  deck_dir(deck: string): string {
    return join(this.decks, this.#deckName(deck));
  }

  qmd(deck: string): string {
    return join(this.deck_dir(deck), "slides.qmd");
  }

  memo(deck: string): string {
    return join(this.deck_dir(deck), "memo.md");
  }

  shelf_dir(shelf: string): string {
    return join(this.topic_dir(shelf), "html");
  }

  topic_dir(shelf: string): string {
    return join(this.topics, check_name(shelf, "トピック"));
  }

  asset_root(deck: string): string {
    return this.topic_dir(this.deck_shelf(deck));
  }

  images_dir(deck: string): string {
    return join(this.asset_root(deck), "images");
  }

  // ------------------------------------------------------------ 用意
  ensure(): void {
    this.#migrateTopics();
    this.#ensureRootLayout();

    const recordPath = join(this.state, "bundled-themes.json");
    const placed = readJsonObject(recordPath) as Record<string, string | null>;
    const before: Record<string, unknown> = { ...placed };

    const themeDirectory = join(this.#templates, "themes");
    const bundled = this.#listFiles(themeDirectory).filter(
      (name) => name.endsWith(".css") && !name.startsWith("_"),
    ).sort();
    for (const name of bundled) {
      const source = join(themeDirectory, name);
      const destination = join(this.themes, name);
      const data = readFileSync(source);
      const digest = sha256Bytes(data);
      const existing = lstatOrNull(destination);
      if (!existing && Object.prototype.hasOwnProperty.call(placed, name) && placed[name] === null) {
        continue;
      }
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new StudioError(`theme may not be a symbolic link: ${name}`, "INVALID_INPUT");
        }
        const currentDigest = sha256Bytes(readFileSync(destination));
        if (currentDigest === digest) {
          placed[name] = digest;
          continue;
        }
        if (name === "default.css" && OLD_DEFAULT_THEMES.has(currentDigest)) {
          this.#migrateDefaultDeckStyles();
        } else if (
          currentDigest !== placed[name]
          && !(OLD_THEMES[name]?.has(currentDigest) ?? false)
        ) {
          continue;
        }
      }
      this.#write(destination, data);
      placed[name] = digest;
    }

    // serif was replaced by terracotta. Keep a copy of untouched files and
    // move decks/preferences forward without touching customized themes.
    const oldSerif = join(this.themes, "serif.css");
    if (this.#isRegularFile(oldSerif) && this.#isRegularFile(join(this.themes, "terracotta.css"))) {
      const digest = sha256Bytes(this.#read(oldSerif, "serif.css"));
      const untouched = digest === placed["serif.css"] || (OLD_THEMES["serif.css"]?.has(digest) ?? false);
      if (untouched) {
        const trash = join(this.state, "trash", "themes", timeNs());
        this.#write(join(trash, "serif.css"), this.#read(oldSerif, "serif.css"));
        for (const deck of this.list_decks()) {
          if (this.deck_theme(deck) !== "serif") continue;
          const path = this.qmd(deck);
          const text = this.#readText(path, "slides.qmd");
          this.#write(join(trash, "decks", deck, "slides.qmd"), text);
          this.#write(path, set_front(text, { theme: "terracotta" }));
        }
        const prefs = this.prefs();
        const recent = this.#stringList(prefs.recent_themes).map((name) =>
          name === "serif" ? "terracotta" : name
        ).filter((name, index, all) => all.indexOf(name) === index);
        this.set_prefs({
          recent_themes: recent,
          ...(prefs.theme === "serif" ? { theme: "terracotta" } : {}),
        });
        unlinkSync(oldSerif);
        placed["serif.css"] = null;
      }
    }

    for (const name of RETIRED_THEMES) {
      this.#retireTheme(name);
      delete placed[`${name}.css`];
    }

    this.#refreshThemes();

    if (!sameJson(placed, before)) {
      this.#write(recordPath, sortedJson(placed, 1));
    }

    this.#ensureDirectory(this.runtime, "runtime");
    for (const name of RUNTIME_FILES) {
      const source = join(this.#runtimeAssets, name);
      const destination = join(this.runtime, name);
      const data = readFileSync(source);
      const current = readIfFile(destination);
      if (!current || !current.equals(data)) this.#write(destination, data);
    }

    this.#migrateBibliography();
    this.#ensureAgentFiles();
    this.#ensurePortable();
  }

  #ensureRootLayout(): void {
    if (!existsNoFollow(this.root)) mkdirSync(this.root, { recursive: true });
    const rootLink = lstatOrNull(this.root);
    if (!rootLink || rootLink.isSymbolicLink() || !rootLink.isDirectory()) {
      throw new StudioError("workspace root is not a directory");
    }
    for (const [path, label] of [
      [this.topics, "topics"],
      [this.decks, "decks"],
      [this.themes, "themes"],
      [this.state, ".slide-studio"],
    ] as const) {
      this.#ensureDirectory(path, label);
    }
  }

  #retireTheme(name: string): void {
    const retired = join(this.themes, `${name}.css`);
    const prefs = this.prefs();
    const affected = this.list_decks().filter((deck) => this.deck_theme(deck) === name);
    const exists = this.#isRegularFile(retired);
    const recentThemes = this.#stringList(prefs.recent_themes);
    if (exists || affected.length > 0 || prefs.theme === name || recentThemes.includes(name)) {
      const trash = join(this.state, "trash", "themes", timeNs());
      if (exists) this.#write(join(trash, `${name}.css`), this.#read(retired, `${name}.css`));
      for (const deck of affected) {
        const path = this.qmd(deck);
        const text = this.#readText(path, "slides.qmd");
        this.#write(join(trash, "decks", deck, "slides.qmd"), text);
        this.#write(path, set_front(text, { theme: "default" }));
      }
      const recent = this.#stringList(prefs.recent_themes).map((value) =>
        value === name ? "default" : value
      ).filter((value, index, all) => all.indexOf(value) === index);
      this.set_prefs({
        recent_themes: recent,
        ...(prefs.theme === name ? { theme: "default" } : {}),
      });
      if (exists) unlinkSync(retired);
    }
    this.#unlinkOptional(join(this.state, "theme-defaults", `${name}.css`));
    this.#removeTree(join(this.state, "themes", name));
  }

  #migrateDefaultDeckStyles(): void {
    const legacy = readFileSync(join(this.#templates, "migrations", "nco-intro.css"), "utf8");
    for (const deck of this.list_decks()) {
      if (this.deck_theme(deck) !== "default") continue;
      const path = join(this.deck_dir(deck), "styles", "slides.css");
      const css = this.#isRegularFile(path) ? this.#readText(path, "slides.css") : "";
      if (!css.includes(legacy.trim())) this.#write(path, `${legacy}\n${css}`);
    }
  }

  #refreshThemes(): void {
    const directory = this.themes;
    for (const name of this.#listFiles(directory).filter((item) => item.endsWith(".css")).sort()) {
      const path = join(directory, name);
      if (!this.#isRegularFile(path)) continue;
      const css = this.#readText(path, name);
      let updated = css;
      if (THEME_VARIABLES.every((variable) => theme_variables(css).includes(variable))) {
        const repainted = withCurrentPalette(css, readVars(css));
        if (repainted !== updated) {
          this.#write(join(this.state, "trash", "themes", timeNs(), name), css);
          updated = repainted;
        }
      }
      if (updated !== css) this.#write(path, updated);
    }
  }

  theme_preparation(): Array<Record<string, unknown>> {
    const path = join(this.themes, "default.css");
    if (!this.#isRegularFile(path)) return [];
    const css = this.#readText(path, "default.css");
    if (THEME_VARIABLES.every((variable) => theme_variables(css).includes(variable))) return [];
    return [{
      name: "テーマの準備",
      ok: false,
      detail: "同梱テーマの default.css が古い形式のままです。",
      fix: "テーマを現在の版に戻すか、発表ごとの styles/slides.css に調整を移してください。",
    }];
  }

  migration_preparation(): Array<Record<string, unknown>> {
    const output: Array<Record<string, unknown>> = [];
    if (existsNoFollow(join(this.root, "figures")) && existsNoFollow(this.topics)) {
      output.push({
        name: "トピックの移行",
        ok: false,
        detail: "旧 figures/ と新しい topics/ が同じ置き場にあります。",
        fix: "figures/ の中身を topics/<トピック>/html/ へ移してください。",
      });
    }
    for (const detail of this.#bibliographyConflicts()) {
      output.push({
        name: "文献の移行",
        ok: false,
        detail,
        fix: "発表ごとの reference.bib とトピックの reference.bib を確認してください。",
      });
    }
    return output;
  }

  // ------------------------------------------------------------ 発表
  list_decks(): string[] {
    const directory = this.decks;
    if (!this.#isDirectory(directory)) return [];
    return this.#listEntries(directory)
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(("_")) && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          assertSafeDeckId(name);
          validateWindowsDeckName(name);
          const qmd = join(directory, name, "slides.qmd");
          const link = lstatOrNull(qmd);
          return Boolean(link && !link.isSymbolicLink() && link.isFile());
        } catch {
          return false;
        }
      })
      .sort();
  }

  has_deck(deck: string): boolean {
    try {
      const path = this.qmd(deck);
      const link = lstatOrNull(path);
      if (!link || link.isSymbolicLink() || !link.isFile()) return false;
      const real = realpathSync.native(path);
      return isInsideRoot(this.root, real);
    } catch {
      return false;
    }
  }

  require_deck(deck: string): string {
    if (!this.has_deck(deck)) {
      throw new StudioError(`発表がありません: ${deck}（${this.deck_dir(deck)}）`, "NOT_FOUND");
    }
    return this.deck_dir(deck);
  }

  deck_meta(deck: string): Record<string, unknown> {
    return this.#parse(this.#readText(this.qmd(deck), "slides.qmd")).meta;
  }

  deck_shelf(deck: string): string {
    const shelf = this.deck_meta(deck).topic;
    if (!shelf) throw new StudioError(`${deck} の front matter に topic:（トピック）がありません`);
    return String(shelf);
  }

  bib(deck: string, meta?: Record<string, unknown> | null): string {
    const topic = (meta ?? this.deck_meta(deck)).topic;
    if (!topic) return join(this.state, "missing-topic.bib");
    return join(this.topic_dir(String(topic)), "reference.bib");
  }

  deck_theme(deck: string): string {
    return String(this.deck_meta(deck).theme || "default");
  }

  is_blank(deck: string): boolean {
    const text = this.#readText(this.qmd(deck), "slides.qmd");
    const document = this.#parse(text);
    if (document.pages.length === 0) return true;
    const meta = document.meta;
    const title = String(meta.title ?? "");
    const blank = blank_qmd(
      String(meta.topic ?? ""),
      String(meta.theme ?? ""),
      title === "" || title === "発表タイトル" ? null : title,
    );
    return set_front(text, {}).trim() === blank.trim();
  }

  is_untouched(deck: string): boolean {
    if (!this.is_blank(deck)) return false;
    const memo = this.memo(deck);
    if (!this.#isRegularFile(memo)) return true;
    const current = this.#readText(memo, "memo.md");
    const template = readFileSync(join(this.#templates, "deck", "memo.md"), "utf8");
    return words(current).join("\u0000") === words(template).join("\u0000");
  }

  new_deck(
    deck: string,
    shelf: string,
    theme = "default",
    source_deck: string | null = null,
    title: string | null = null,
  ): string {
    check_name(deck, "フォルダ名");
    check_name(shelf, "トピックの名前");
    check_name(theme, "テーマ");
    if (source_deck) check_name(source_deck, "複製する発表");
    const destination = this.deck_dir(deck);
    if (existsNoFollow(destination)) throw new StudioError(`既にあります: ${destination}`);

    const themePath = join(this.themes, `${theme}.css`);
    if (!this.#isRegularFile(themePath)) {
      throw new StudioError(`テーマがありません: themes/${theme}.css`);
    }

    if (source_deck) {
      const source = this.require_deck(source_deck);
      const ignore = (directory: string, names: string[]): string[] => [
        ...names.filter((name) =>
          name === ".DS_Store" || name.endsWith(".html") || name.endsWith(".pdf")
        ),
        ...(resolve(directory) === resolve(source) ? ["materials"] : []),
      ];
      this.#copyTree(source, destination, { ignore });
      const qmd = join(destination, "slides.qmd");
      const sourceBib = this.bib(source_deck);
      if (shelf !== this.deck_shelf(source_deck) && this.#isRegularFile(sourceBib)) {
        this.#write(join(destination, "reference.bib"), this.#read(sourceBib, "reference.bib"));
      }
      let text = this.#copyTopicAssets(source_deck, shelf, this.#readText(qmd, "slides.qmd"));
      text = set_front(text, { topic: shelf, theme });
      if (title) text = set_front(text, { title: JSON.stringify(title) });
      this.#write(qmd, text);
    } else {
      this.#copyTree(join(this.#templates, "deck"), destination, {
        ignore: (_directory, names) => names.filter((name) => name === ".DS_Store"),
      });
      this.#write(join(destination, "slides.qmd"), blank_qmd(shelf, theme, title));
    }

    this.#ensureDirectory(this.shelf_dir(shelf), "topic html");
    this.#ensureDirectory(this.images_dir(deck), "topic images");
    this.#migrateBibliography();
    this.touch_recent(deck);
    this.set_prefs({ shelf, theme });
    return destination;
  }

  // ------------------------------------------------------------ 最近
  get recent_file(): string {
    return join(this.state, "recent.json");
  }

  recent(): Array<Record<string, unknown>> {
    const items = readJsonArray(this.recent_file);
    const known = new Set(items.map((item) => String(item.deck)));
    for (const deck of this.list_decks()) {
      if (!known.has(deck)) items.push({ deck, opened: 0 });
    }
    const output: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const deck = typeof item.deck === "string" ? item.deck : "";
      if (!deck || !this.has_deck(deck)) continue;
      const statValue = statSync(this.qmd(deck));
      const meta = this.deck_meta(deck);
      output.push({
        ...item,
        title: String(meta.title || meta.pagetitle || deck),
        shelf: String(meta.topic || ""),
        theme: String(meta.theme || ""),
        modified: statValue.mtimeMs / 1000,
      });
    }
    output.sort((left, right) => {
      const opened = Number(left.opened ?? 0) - Number(right.opened ?? 0);
      if (opened !== 0) return -opened;
      return Number(right.modified ?? 0) - Number(left.modified ?? 0);
    });
    return output;
  }

  touch_recent(deck: string): void {
    let items = readJsonArray(this.recent_file).filter((item) => item.deck !== deck);
    items.unshift({ deck, opened: Date.now() / 1000 });
    items = items.slice(0, 50);
    this.#write(this.recent_file, JSON.stringify(items, null, 1));
  }

  prefs(): Record<string, unknown> {
    return readJsonObject(join(this.state, "prefs.json"));
  }

  set_prefs(values: Record<string, unknown> = {}): void {
    const prefs = this.prefs();
    for (const [key, value] of Object.entries(values)) {
      if (value !== null && value !== undefined) prefs[key] = value;
    }
    this.#write(join(this.state, "prefs.json"), JSON.stringify(prefs, null, 1));
  }

  // ------------------------------------------------------------ 棚と図
  shelves(): string[] {
    if (!this.#isDirectory(this.topics)) return [];
    return this.#listEntries(this.topics)
      .filter((entry) =>
        entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_")
      )
      .map((entry) => entry.name)
      .sort();
  }

  new_topic(shelf: string): string {
    const destination = this.topic_dir(shelf);
    if (existsNoFollow(destination)) {
      throw new StudioError(`同じ名前のトピックがあります: ${shelf}`);
    }
    this.#ensureDirectory(destination, "topic");
    return destination;
  }

  remove_topic(shelf: string): string {
    const base = this.topic_dir(shelf);
    const link = lstatOrNull(base);
    if (!link || link.isSymbolicLink() || !link.isDirectory()) {
      throw new StudioError("topicMissing", "NOT_FOUND");
    }
    const real = realpathSync.native(base);
    const topicsReal = this.#isDirectory(this.topics) ? realpathSync.native(this.topics) : this.topics;
    if (dirname(real) !== topicsReal) throw new StudioError("topicMissing", "NOT_FOUND");

    for (const deck of this.list_decks()) {
      const text = this.#readText(this.qmd(deck), "slides.qmd");
      const metaTopic = String(this.#parse(text).meta.topic ?? "");
      const figurePattern = new RegExp(`\\{\\{<\\s*fig\\s+["']?${escapeRegExp(shelf)}/`, "u");
      if (
        metaTopic === shelf
        || text.includes(`topics/${shelf}/`)
        || figurePattern.test(text)
      ) {
        throw new StudioError("topicInUse", "CONFLICT");
      }
    }

    const trash = join(this.state, "trash", "topics", `${shelf}-${timeNs()}`);
    this.#ensureDirectory(dirname(trash), "topic trash");
    renameSync(base, trash);
    return trash;
  }

  topic_empty(shelf: string): boolean {
    const base = this.topic_dir(shelf);
    const link = lstatOrNull(base);
    if (!link) return true;
    if (link.isSymbolicLink() || !link.isDirectory()) return false;
    return !this.#walkEntries(base).some(([path, entry]) =>
      entry.isFile() && basename(path) !== ".DS_Store"
    );
  }

  themes_list(): string[] {
    return this.#listFiles(this.themes)
      .filter((name) => name.endsWith(".css") && !name.startsWith("_"))
      .map((name) => name.slice(0, -4))
      .sort();
  }

  theme_default(name: string): string | null {
    if (name.startsWith("_")) return null;
    for (const path of [
      join(this.state, "theme-defaults", `${name}.css`),
      join(this.#templates, "themes", `${name}.css`),
    ]) {
      const data = readIfFile(path);
      if (data) return data.toString("utf8");
    }
    return null;
  }

  register_theme(name: string, css: string): void {
    check_name(name, "テーマ");
    if (existsNoFollow(join(this.themes, `${name}.css`))) {
      throw new StudioError("同じ名前のテーマがあります");
    }
    this.#write(join(this.state, "theme-defaults", `${name}.css`), css);
    this.#write(join(this.themes, `${name}.css`), css);
  }

  remove_theme(name: string): string {
    check_name(name, "テーマ");
    const path = join(this.themes, `${name}.css`);
    if (!this.#isRegularFile(path)) throw new StudioError("テーマがありません", "NOT_FOUND");
    if (name === "default") throw new StudioError("default のテーマは削除できません");

    const using = this.list_decks().filter((deck) => this.deck_theme(deck) === name);
    if (using.length > 0) {
      throw new StudioError(`このテーマを使う発表があります：${using.join("、")}`, "CONFLICT");
    }

    const trash = join(this.state, "trash", "themes", timeNs());
    this.#ensureDirectory(trash, "theme trash");
    renameSync(path, join(trash, `${name}.css`));
    this.#unlinkOptional(join(this.state, "theme-defaults", `${name}.css`));
    this.#removeTree(join(this.state, "themes", name));

    const bundled = join(this.#templates, "themes", `${name}.css`);
    if (this.#isRegularFile(bundled)) {
      const record = join(this.state, "bundled-themes.json");
      const placed = readJsonObject(record) as Record<string, string | null>;
      this.#write(record, sortedJson({ ...placed, [`${name}.css`]: null }, 1));
    }

    const prefs = this.prefs();
    this.set_prefs({
      recent_themes: this.#stringList(prefs.recent_themes).filter((item) => item !== name),
      ...(prefs.theme === name ? { theme: "default" } : {}),
    });
    return join(trash, `${name}.css`);
  }

  figure_dir(ref: string, _deck?: string | null): string {
    const separator = ref.indexOf("/");
    const shelf = separator >= 0 ? ref.slice(0, separator) : "";
    const name = separator >= 0 ? ref.slice(separator + 1) : "";
    const parts = name.split("/");
    if (
      separator < 0
      || shelf === "."
      || !name
      || isAbsolute(name)
      || name.includes("\\")
      || parts.some((part) =>
        part === ""
        || part === "."
        || part === ".."
        || WINDOWS_RESERVED.test(part.split(".", 1)[0] ?? "")
      )
    ) {
      throw new StudioError(`トピック/名前で図を指定してください: ${ref}`);
    }
    return join(this.shelf_dir(shelf), name);
  }

  list_figures(shelf: string | null = null, deck: string | null = null): Array<Record<string, unknown>> {
    const selected = deck ? this.deck_shelf(deck) : shelf;
    if (!selected) return [];
    const base = this.shelf_dir(selected);
    if (!this.#isDirectory(base)) return [];
    const output: Array<Record<string, unknown>> = [];
    for (const entry of this.#listEntries(base).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const directory = join(base, entry.name);
      if (!this.#isRegularFile(join(directory, "figure.mjs"))) continue;
      output.push({
        name: entry.name,
        ref: `${selected}/${entry.name}`,
        title: figure_title(directory),
        steps: figure_steps(directory),
        place: "shelf",
      });
    }
    return output;
  }

  decks_using(ref: string): string[] {
    const output: string[] = [];
    for (const deck of this.list_decks()) {
      const text = this.#readText(this.qmd(deck), "slides.qmd");
      for (const match of text.matchAll(/\{\{<\s*fig\s+(\S+)/gu)) {
        if ((match[1] ?? "").replace(/^["']|["']$/gu, "") === ref) {
          output.push(deck);
          break;
        }
      }
    }
    return output;
  }

  // ------------------------------------------------------------ internals
  #parse(text: string): LegacyDocument {
    const parser = this.#parser ?? configuredParser;
    return parser ? parser(text) : parseLegacySource(text);
  }

  #deckName(deck: string): string {
    try {
      assertSafeDeckId(deck);
    } catch (error) {
      if (error instanceof CoreError) throw new StudioError(error.message, error.code);
      throw error;
    }
    validateWindowsDeckName(deck);
    return deck;
  }

  #assertLexicalInside(path: string, label: string): void {
    const target = resolve(path);
    if (!isInsideRoot(this.root, target)) {
      throw new StudioError(`refusing to access outside the workspace root: ${label}`, "OUTSIDE_ROOT");
    }
  }

  #ensureDirectory(path: string, label: string): string {
    this.#assertLexicalInside(path, label);
    if (resolve(path) === this.root) {
      if (!existsNoFollow(this.root)) mkdirSync(this.root, { recursive: true });
      const rootLink = lstatOrNull(this.root);
      if (!rootLink || rootLink.isSymbolicLink() || !rootLink.isDirectory()) {
        throw new StudioError("workspace root is not a directory");
      }
      return this.root;
    }
    const link = lstatOrNull(path);
    if (link) {
      if (link.isSymbolicLink()) {
        throw new StudioError(`${label} may not be a symbolic link`, "OUTSIDE_ROOT");
      }
      if (!link.isDirectory()) throw new StudioError(`${label} is not a directory`);
      const real = realpathSync.native(path);
      assertInsideRoot(this.root, real, label);
      return real;
    }
    const parent = dirname(path);
    if (parent !== path) this.#ensureDirectory(parent, `${label} parent`);
    try {
      mkdirSync(path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw new StudioError(`cannot create ${label}: ${String(error)}`);
      }
    }
    return this.#ensureDirectory(path, label);
  }

  #isDirectory(path: string): boolean {
    const link = lstatOrNull(path);
    return Boolean(link && !link.isSymbolicLink() && link.isDirectory());
  }

  #isRegularFile(path: string): boolean {
    const link = lstatOrNull(path);
    if (!link || link.isSymbolicLink() || !link.isFile()) return false;
    const real = realpathSync.native(path);
    return isInsideRoot(this.root, real) || !isInsideRoot(this.root, resolve(path));
  }

  #read(path: string, label: string): Buffer {
    const link = lstatOrNull(path);
    if (!link) throw new StudioError(`${label} がありません`, "NOT_FOUND");
    if (link.isSymbolicLink()) {
      let target: string | null = null;
      try {
        target = realpathSync.native(path);
      } catch {
        // A broken symlink is still not a valid workspace file.
      }
      if (target && !isInsideRoot(this.root, target)) {
        throw new StudioError(`refusing to access outside the workspace root: ${label}`, "OUTSIDE_ROOT");
      }
      throw new StudioError(`${label} may not be a symbolic link`);
    }
    if (!link.isFile()) throw new StudioError(`${label} is not a file`, "NOT_FOUND");
    const real = realpathSync.native(path);
    assertInsideRoot(this.root, real, label);
    return readFileSync(real);
  }

  #readText(path: string, label: string): string {
    return this.#read(path, label).toString("utf8");
  }

  #write(path: string, data: string | Uint8Array, mode?: number): void {
    this.#ensureDirectory(dirname(path), `folder for ${basename(path)}`);
    const link = lstatOrNull(path);
    if (link?.isSymbolicLink()) {
      throw new StudioError(`${basename(path)} may not be a symbolic link`);
    }
    if (link && !link.isFile()) throw new StudioError(`${basename(path)} is not a file`);
    atomicWrite(path, data, mode ?? (link?.isFile() ? link.mode & 0o777 : undefined));
  }

  #unlinkOptional(path: string): void {
    const link = lstatOrNull(path);
    if (link && !link.isDirectory()) unlinkSync(path);
  }

  #removeTree(path: string): void {
    this.#assertLexicalInside(path, basename(path));
    rmSync(path, { recursive: true, force: true });
  }

  #listEntries(directory: string): Dirent[] {
    try {
      return readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
      throw error;
    }
  }

  #listFiles(directory: string): string[] {
    return this.#listEntries(directory)
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  }

  #walkEntries(directory: string, prefix = ""): Array<[string, Dirent]> {
    const output: Array<[string, Dirent]> = [];
    for (const entry of this.#listEntries(directory)) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      output.push([path, entry]);
      if (entry.isDirectory()) output.push(...this.#walkEntries(path, prefix));
    }
    return output;
  }

  #stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  #copyTree(source: string, destination: string, options: CopyOptions = {}): void {
    this.#ensureDirectory(destination, basename(destination));
    const names = this.#listEntries(source)
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
    const ignored = new Set(options.ignore?.(source, names) ?? []);
    for (const entry of this.#listEntries(source)) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      if (entry.isDirectory()) {
        this.#copyTree(from, to, options);
      } else if (entry.isFile()) {
        const sourceStat = lstatSync(from);
        this.#write(to, readFileSync(from), sourceStat.mode & 0o777);
      }
    }
  }

  #migrateTopics(): void {
    const figures = join(this.root, "figures");
    const topics = this.topics;
    const hadFigures = this.#isDirectory(figures);
    if (hadFigures && !existsNoFollow(topics)) {
      this.#ensureDirectory(topics, "topics");
      for (const entry of this.#listEntries(figures)) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const source = join(figures, entry.name);
        const html = join(topics, entry.name, "html");
        this.#ensureDirectory(html, "topic html");
        const nested = join(source, "html");
        const sourceRoot = this.#isDirectory(nested) ? nested : source;
        for (const child of this.#listEntries(sourceRoot)) {
          if (child.name === ".DS_Store") continue;
          const from = join(sourceRoot, child.name);
          const to = join(html, child.name);
          if (existsNoFollow(to)) continue;
          if (child.isDirectory()) this.#copyTree(from, to);
          else if (child.isFile()) this.#write(to, readFileSync(from));
          rmSync(from, { recursive: true, force: true });
        }
        if (this.#listEntries(sourceRoot).every((child) => child.name === ".DS_Store")) {
          rmSync(sourceRoot, { recursive: true, force: true });
        }
      }
    }

    if (this.#isDirectory(figures)) {
      for (const entry of this.#listEntries(figures)) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const source = join(figures, entry.name);
        if (this.#listEntries(source).every((child) => child.name === ".DS_Store")) {
          rmSync(source, { recursive: true, force: true });
        }
      }
      if (this.#listEntries(figures).every((entry) => entry.name === ".DS_Store")) {
        rmSync(figures, { recursive: true, force: true });
      }
    }

    // Old decks referenced figures/<topic>/... directly. The new layout keeps
    // the same figures under topics/<topic>/html/.
    if (hadFigures) {
      for (const deck of this.list_decks()) {
        const path = this.qmd(deck);
        const text = this.#readText(path, "slides.qmd");
        if (!text.includes("figures/")) continue;
        this.#write(
          path,
          text.replace(
            /(^|["'(])figures\/([a-z0-9][a-z0-9-]*)\//gmu,
            "$1topics/$2/html/",
          ),
        );
      }
    }

    if (this.#isDirectory(topics)) {
      for (const entry of this.#listEntries(topics)) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        const topic = join(topics, entry.name);
        const html = join(topic, "html");
        if (existsNoFollow(html)) continue;
        const candidates = this.#listEntries(topic).filter((item) =>
          item.isDirectory()
          && item.name !== "images"
          && !item.name.startsWith(".")
          && (
            existsNoFollow(join(topic, item.name, "figure.mjs"))
            || existsNoFollow(join(topic, item.name, "index.html"))
            || item.name === "_lib"
          )
        );
        if (candidates.length === 0) continue;
        this.#ensureDirectory(html, "topic html");
        for (const candidate of candidates) {
          const from = join(topic, candidate.name);
          const to = join(html, candidate.name);
          if (!existsNoFollow(to)) renameSync(from, to);
        }
      }
    }
  }

  #copyTopicAssets(sourceDeck: string, shelf: string, text: string): string {
    const sourceShelf = this.deck_shelf(sourceDeck);
    if (sourceShelf === shelf) return text;
    const sourceHtml = this.shelf_dir(sourceShelf);
    let updated = text.replace(
      new RegExp(`\\{\\{<\\s*fig\\s+["']?${escapeRegExp(sourceShelf)}/`, "gu"),
      (match) => match.replace(new RegExp(`${escapeRegExp(sourceShelf)}/$`, "u"), `${shelf}/`),
    );
    updated = updated.split(`topics/${sourceShelf}/`).join(`topics/${shelf}/`);
    if (!this.#isDirectory(sourceHtml)) return updated;
    const references = new Set<string>();
    for (const match of updated.matchAll(new RegExp(`\\{\\{<\\s*fig\\s+["']?${escapeRegExp(shelf)}/([^\\s>]+)`, "gu"))) {
      if (match[1]) references.add(match[1].replace(/["']$/u, ""));
    }
    for (const name of references) {
      const from = join(sourceHtml, name);
      const to = join(this.shelf_dir(shelf), name);
      if (this.#isDirectory(from) && !existsNoFollow(to)) this.#copyTree(from, to);
    }
    const shared = join(sourceHtml, "_lib");
    if (this.#isDirectory(shared) && !existsNoFollow(join(this.shelf_dir(shelf), "_lib"))) {
      this.#copyTree(shared, join(this.shelf_dir(shelf), "_lib"));
    }
    return updated;
  }

  #migrateBibliography(): void {
    for (const deck of this.list_decks()) {
      const local = join(this.deck_dir(deck), "reference.bib");
      if (!this.#isRegularFile(local)) continue;
      const meta = this.deck_meta(deck);
      const topic = meta.topic;
      if (!topic) continue;
      const target = join(this.topic_dir(String(topic)), "reference.bib");
      const localBytes = this.#read(local, "reference.bib");
      if (!this.#isRegularFile(target)) {
        this.#write(target, localBytes);
        unlinkSync(local);
        continue;
      }
      const targetBytes = this.#read(target, "reference.bib");
      if (localBytes.equals(targetBytes)) {
        unlinkSync(local);
        continue;
      }
      const merged = mergeBibtex(targetBytes.toString("utf8"), localBytes.toString("utf8"));
      if (merged !== null) {
        this.#write(target, merged);
        unlinkSync(local);
      }
    }
  }

  #bibliographyConflicts(): string[] {
    const conflicts: string[] = [];
    for (const deck of this.list_decks()) {
      const local = join(this.deck_dir(deck), "reference.bib");
      if (!this.#isRegularFile(local)) continue;
      const topic = this.deck_meta(deck).topic;
      if (!topic) continue;
      const target = join(this.topic_dir(String(topic)), "reference.bib");
      if (!this.#isRegularFile(target)) continue;
      if (!this.#read(local, "reference.bib").equals(this.#read(target, "reference.bib"))) {
        conflicts.push(`decks/${deck}/reference.bib と topics/${String(topic)}/reference.bib が違います`);
      }
    }
    return conflicts;
  }

  #ensureAgentFiles(): void {
    const templateDirectory = join(this.#templates, "workspace");
    if (!this.#isDirectory(templateDirectory)) return;
    const stamp = join(this.state, "agent-files.json");
    const known = readJsonObject(stamp);
    const files = new Map<string, Buffer>();
    const walk = (directory: string, prefix: string): void => {
      for (const entry of this.#listEntries(directory).sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path, relativePath);
        else if (entry.isFile()) files.set(relativePath, readFileSync(path));
      }
    };
    walk(templateDirectory, "");

    for (const [relativePath, data] of files) {
      const destination = this.#relativeToRoot(relativePath);
      if (!destination) continue;
      const digest = sha256Bytes(data);
      const link = lstatOrNull(destination);
      if (link?.isSymbolicLink()) continue;
      if (link?.isFile() && known[relativePath] === digest) continue;
      if (link?.isFile() && readFileSync(destination).equals(data)) {
        known[relativePath] = digest;
        continue;
      }
      if (
        link?.isFile()
        && typeof known[relativePath] === "string"
        && sha256Bytes(readFileSync(destination)) !== known[relativePath]
        && known["_version"] === this.#version
      ) {
        continue;
      }
      this.#write(destination, data);
      known[relativePath] = digest;
    }

    const present = new Set(files.keys());
    for (const relativePath of Object.keys(known)) {
      if (relativePath === "_version" || present.has(relativePath)) continue;
      const digest = known[relativePath];
      if (typeof digest !== "string") {
        delete known[relativePath];
        continue;
      }
      const destination = this.#relativeToRoot(relativePath);
      if (!destination) {
        delete known[relativePath];
        continue;
      }
      const link = lstatOrNull(destination);
      if (!link || link.isSymbolicLink() || !link.isFile()) {
        delete known[relativePath];
        continue;
      }
      if (sha256Bytes(readFileSync(destination)) !== digest) continue;
      unlinkSync(destination);
      delete known[relativePath];
      let parent = dirname(destination);
      while (parent !== this.root) {
        try {
          rmdirSync(parent);
        } catch {
          break;
        }
        parent = dirname(parent);
      }
    }

    const skills = new Set<string>();
    for (const relativePath of files.keys()) {
      if (!relativePath.startsWith(".agents/skills/")) continue;
      const parts = relativePath.split("/");
      if (parts[2]) skills.add(parts[2]);
    }
    const links = join(this.root, ".claude", "skills");
    for (const name of [...skills].sort()) {
      const link = join(links, name);
      if (existsNoFollow(link)) continue;
      this.#ensureDirectory(links, "skill links");
      try {
        symlinkSync(`../../.agents/skills/${name}`, link, "dir");
      } catch {
        // Windows may require Developer Mode for directory links.
      }
    }
    if (this.#isDirectory(links)) {
      for (const entry of this.#listEntries(links)) {
        const link = join(links, entry.name);
        const statValue = lstatOrNull(link);
        if (!statValue?.isSymbolicLink() || existsSync(link)) continue;
        try {
          if (readlinkSync(link) === `../../.agents/skills/${entry.name}`) unlinkSync(link);
        } catch {
          // Leave links we cannot inspect alone.
        }
      }
    }
    known["_version"] = this.#version;
    this.#write(stamp, JSON.stringify(known, null, 1));
  }

  #ensurePortable(): void {
    const compiler = join(this.state, "compiler");
    this.#ensureDirectory(compiler, "compiler");
    const oldTemplate = readIfFile(join(this.#templates, "portable", "README.md"));
    for (const readme of [join(this.root, "README.md"), join(compiler, "README.md")]) {
      const current = readIfFile(readme);
      const untouchedOld = Boolean(oldTemplate && current && oldTemplate.equals(current));
      if (current && !untouchedOld) continue;
      this.#write(readme, PORTABLE_README);
    }
  }

  #relativeToRoot(relativePath: string): string | null {
    if (isAbsolute(relativePath) || CONTROL_CHARACTER.test(relativePath)) return null;
    const parts = relativePath.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
    const candidate = join(this.root, ...parts);
    this.#assertLexicalInside(candidate, relativePath);
    return candidate;
  }
}

function words(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

function readVars(css: string): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const values: Record<string, string> = {};
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/gu)) {
    if (match[1] && match[2] !== undefined) values[match[1]] = match[2].trim();
  }
  return values;
}

function paletteSection(css: string): string | null {
  const match = /\/\* block palette v\d+:[^*]*\*\/\s*:root\s*\{[^}]*\}/u.exec(css);
  return match ? match[0] : null;
}

function currentPaletteFor(variables: Record<string, string>): string | null {
  const themeDirectory = join(TEMPLATES, "themes");
  let bundled: string[];
  try {
    bundled = readdirSync(themeDirectory).filter((name) => name.endsWith(".css") && !name.startsWith("_"));
  } catch {
    return null;
  }
  const colorKeys = [
    "--ink", "--link", "--accent", "--header", "--muted", "--warn", "--good",
    "--mark", "--mark-ink", "--mark-line", "--paper", "--rule", "--header-ink",
  ];
  for (const name of bundled) {
    const candidate = readFileSync(join(themeDirectory, name), "utf8");
    const candidateVars = readVars(candidate);
    if (!colorKeys.every((key) => candidateVars[key] === variables[key])) continue;
    const palette = paletteSection(candidate);
    if (palette) return palette;
  }
  return null;
}

function withCurrentPalette(css: string, variables: Record<string, string>): string {
  const existing = /\/\* block palette v(\d+):[^*]*\*\/\s*:root\s*\{[^}]*\}/u.exec(css);
  const palette = currentPaletteFor(variables);
  if (!palette) return css;
  if (existing?.[1] === "4") return css;
  if (!existing) return `${css.replace(/\s*$/u, "")}\n\n${palette}\n`;

  const before = css.slice(0, existing.index);
  const after = css.slice(existing.index + existing[0].length)
    .replace(/\/\* block palette v\d+:[^*]*\*\/\s*:root\s*\{[^}]*\}/gu, "");
  const overrides = new Map<string, string>();
  const overrideSource = `${before.replace(/\/\* block palette v\d+:[^*]*\*\/\s*:root\s*\{[^}]*\}/gu, "")}\n${after}`;
  for (const match of overrideSource.matchAll(/(--block-[\w-]+)\s*:\s*([^;}]+)/gu)) {
    if (match[1] && match[2] !== undefined) overrides.set(match[1], match[2].trim());
  }
  const overrideCss = overrides.size > 0
    ? `\n:root {\n${[...overrides].map(([key, value]) => `  ${key}:${value};`).join("\n")}\n}\n`
    : "";
  return `${before.replace(/\s*$/u, "")}\n\n${palette}\n${after}${overrideCss}`;
}

function mergeBibtex(target: string, local: string): string | null {
  const keysOf = (text: string): Set<string> => {
    const keys = new Set<string>();
    for (const match of text.matchAll(/@\w+\s*\{\s*([^,\s]+)/gu)) {
      if (match[1]) keys.add(match[1]);
    }
    return keys;
  };
  const targetKeys = keysOf(target);
  const localKeys = keysOf(local);
  const missing = [...localKeys].filter((key) => !targetKeys.has(key));
  if (missing.length !== localKeys.size) return null;
  if (missing.length === 0) return target;
  return `${target.replace(/\s*$/u, "")}\n\n${local}`;
}

const PORTABLE_README = `# スライドの保管フォルダ

このフォルダは Slide Studio で編集・再ビルドできます。フォルダ名と置き場所は自由です。共有する際は、隠しフォルダ \`.slide-studio/\` も含めてフォルダ全体をコピーしてください。

- \`decks/<発表名>/slides.qmd\`：原稿。テキストエディタで編集できます。
- \`decks/<発表名>/styles/\`：発表のスタイル。
- \`topics/<トピック>/\`：共有する \`html/\`・\`images/\`・\`reference.bib\`。\`themes/\`：テーマ。
- \`.slide-studio/runtime/\`：図が相対パスで読み込む共通コード。

## コンパイル

Slide Studio の CLI から書き出します。

\`\`\`sh
slide-studio build <発表名>
\`\`\`

HTML と PDF は \`decks/<発表名>/\` に保存されます。アプリの画面から書き出す場合も同じ成果物になります。Python・uv の準備は不要です。
`;
