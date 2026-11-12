/**
 * Faithful TypeScript port of `.reference/parity/bibliography.py`.
 *
 * BibTeX parsing is deliberately hand-written: nested braces, quoted values,
 * comments and `@string` macros must be preserved byte-for-byte except in the
 * field ranges that an explicit operation is allowed to change.
 *
 * File-writing operations are async so they can use `atomicWriteFile`, the
 * same sibling-temp + rename strategy as the rest of the core.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic.js";
import { pyStrip } from "./legacy-cover.js";
import { ValueError } from "./legacy-source.js";
import type { Workspace } from "./legacy-workspace.js";
import { StudioError } from "./legacy-workspace.js";

export const VENUE_FIELDS = new Set([
  "journal",
  "journaltitle",
  "booktitle",
  "howpublished",
  "publisher",
]);

export const W_INNER = String.raw`\p{L}\p{N}_`;
const PY_SPACE = /[\t\n\v\f\r \x1c-\x1f\x85\p{Z}]/u;
const DECIMAL = /^\p{Nd}+$/u;
const FIELD_NAME = /^([\p{L}\p{N}_-]+)\s*=\s*/u;
const ENTRY_HEAD = new RegExp(String.raw`@([\p{L}\p{N}_-]+)\s*([({])`, "gu");
const ENTRY_KIND = new RegExp(String.raw`^@([\p{L}\p{N}_]+)`, "u");
const LISTING_KIND = new RegExp(String.raw`^@([\p{L}\p{N}_-]+)`, "u");
const STRING_MACRO = /^\s*([^=\s]+)\s*=/u;
const ENTRY_KEY = /^\s*([^,\s]+)\s*,/u;
const CONTROL_FIELD = /^[\p{L}\p{N}_-]+$/u;
const AUTHOR_SPLIT = /[{}]|\s+and\s+/gu;

/** Python's `KeyError` for a missing BibTeX key. */
export class KeyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(key);
    this.name = "KeyError";
    this.key = key;
  }
}

function isPySpace(character: string): boolean {
  return PY_SPACE.test(character);
}

function compareCodePoints(left: string, right: string): number {
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

function timeNs(): string {
  return (BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n).toString();
}

function modeFor(path: string): number {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return stat.mode & 0o777;
  } catch {
    // A new file gets the process default.
  }
  return 0o666 & ~process.umask();
}

async function writeAtomic(path: string, data: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await atomicWriteFile(path, data, modeFor(path));
}

/** Split BibTeX into `(key, raw)` records while preserving nested content. */
export function entries(text: string): Array<[string | null, string]> {
  const result: Array<[string | null, string]> = [];
  let position = 0;

  const nextEntry = (start: number): RegExpExecArray | null => {
    ENTRY_HEAD.lastIndex = start;
    let match = ENTRY_HEAD.exec(text);
    while (match) {
      const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
      if (text.slice(lineStart, match.index).includes("%")) {
        const newline = text.indexOf("\n", ENTRY_HEAD.lastIndex);
        if (newline < 0) return null;
        ENTRY_HEAD.lastIndex = newline + 1;
        match = ENTRY_HEAD.exec(text);
        continue;
      }
      return match;
    }
    return null;
  };

  let match = nextEntry(position);
  while (match) {
    const leading = pyStrip(text.slice(position, match.index));
    if (leading) {
      result.push([null, leading]);
    }
    const opening = match[2]!;
    let depth = 1;
    let quoted = false;
    let escaped = false;
    let index = ENTRY_HEAD.lastIndex;
    let brace = 0;
    while (index < text.length) {
      const character = text[index]!;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"' && (opening === "{" ? depth === 1 : brace === 0)) {
        quoted = !quoted;
      } else if (!quoted) {
        if (opening === "{") {
          if (character === "{") depth += 1;
          else if (character === "}") depth -= 1;
        } else if (character === "{") {
          brace += 1;
        } else if (character === "}") {
          brace -= 1;
        } else if (character === ")" && brace === 0) {
          depth -= 1;
        }
      }
      index += 1;
      if (depth === 0) break;
    }
    if (depth !== 0) throw new ValueError("BibTeX");

    const raw = pyStrip(text.slice(match.index, index));
    const kind = match[1]!.toLowerCase();
    const body = text.slice(ENTRY_HEAD.lastIndex, index - 1);
    let key: string | null;
    if (kind === "comment" || kind === "preamble") {
      key = null;
    } else if (kind === "string") {
      const macro = STRING_MACRO.exec(body);
      if (!macro) throw new ValueError("BibTeX");
      key = `@string:${macro[1]!.toLowerCase()}`;
    } else {
      const keyMatch = ENTRY_KEY.exec(body);
      if (!keyMatch) throw new ValueError("BibTeX");
      key = keyMatch[1]!;
    }
    result.push([key, raw]);
    position = index;
    match = nextEntry(position);
  }
  const trailing = pyStrip(text.slice(position));
  if (trailing) {
    result.push([null, trailing]);
  }
  return result;
}

/** Field name, raw value, and the source range that may be replaced. */
export function* fields(
  raw: string,
): Generator<[string, string, number, number]> {
  const firstComma = raw.indexOf(",");
  if (firstComma < 0) throw new ValueError("BibTeX");
  let index = firstComma + 1;
  const end = raw.length - 1;
  while (index < end) {
    while (index < end && (isPySpace(raw[index]!) || raw[index] === ",")) index += 1;
    if (index >= end) break;
    if (raw[index] === "%") {
      index = raw.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    const start = index;
    const match = FIELD_NAME.exec(raw.slice(index));
    if (!match) throw new ValueError("BibTeX");
    index += match[0].length;
    const valueStart = index;
    let depth = 0;
    let quote = false;
    let escape = false;
    while (index < end) {
      const character = raw[index]!;
      if (escape) {
        escape = false;
      } else if (character === "\\") {
        escape = true;
      } else if (character === '"' && depth === 0) {
        quote = !quote;
      } else if (!quote) {
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        else if (character === "," && depth === 0) break;
      }
      index += 1;
    }
    yield [
      match[1]!.toLowerCase(),
      pyStrip(raw.slice(valueStart, index)),
      start,
      Math.min(index + 1, end),
    ];
    index += 1;
  }
}

function valueIdentity(value: string): [string, string] {
  if (
    (value.startsWith("{") && value.endsWith("}"))
    || (value.startsWith('"') && value.endsWith('"'))
  ) {
    return ["literal", value.slice(1, -1)];
  }
  if (DECIMAL.test(value)) return ["literal", value];
  return ["expression", value];
}

/** Equality key that ignores field order but distinguishes values. */
export function identity(key: string | null, raw: string): string {
  if (key === null || key.startsWith("@string:")) return raw;
  const kindMatch = ENTRY_KIND.exec(raw);
  const kind = (kindMatch?.[1] ?? "").toLowerCase();
  const pairs: Array<[string, [string, string]]> = [];
  for (const [name, value] of fields(raw)) pairs.push([name, valueIdentity(value)]);
  pairs.sort((left, right) => {
    const byName = compareCodePoints(left[0], right[0]);
    if (byName !== 0) return byName;
    const byKind = compareCodePoints(left[1][0], right[1][0]);
    if (byKind !== 0) return byKind;
    return compareCodePoints(left[1][1], right[1][1]);
  });
  return JSON.stringify([kind, pairs]);
}

/** Merge bibliography files, rejecting different records with the same key. */
export function merge(paths: string[]): string {
  const seen = new Map<string, string>();
  const output: string[] = [];
  const collisions = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const [key, raw] of entries(readFileSync(path, "utf8"))) {
      const content = identity(key, raw);
      if (key !== null && seen.has(key) && seen.get(key) !== content) {
        collisions.add(key);
      }
      if (key === null || !seen.has(key)) output.push(raw);
      if (key !== null) seen.set(key, content);
    }
  }
  if (collisions.size) {
    throw new ValueError([...collisions].sort(compareCodePoints).join(", "));
  }
  return `${output.join("\n\n")}${output.length ? "\n" : ""}`;
}

/** Group each topic bibliography with the legacy per-deck copies to merge. */
export function plans(ws: Workspace): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const deck of ws.list_decks()) {
    let target: string;
    try {
      target = ws.bib(deck);
    } catch (error) {
      if (error instanceof StudioError || error instanceof ValueError) continue;
      // Python catches OSError here: one unreadable deck must not break every
      // other deck's render, conflict check or migration.
      if (error !== null && typeof error === "object"
        && typeof (error as { code?: unknown }).code === "string") {
        continue;
      }
      throw error;
    }
    if (dirname(target) === ws.state) continue;
    if (!groups.has(target)) groups.set(target, []);
    const old = join(ws.deck_dir(deck), "reference.bib");
    if (existsSync(old)) groups.get(target)!.push(old);
  }
  return groups;
}

export function conflicts(ws: Workspace): string[] {
  const errors: string[] = [];
  for (const [target, old] of plans(ws)) {
    try {
      merge([target, ...old]);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      errors.push(
        `${basename(dirname(target))}: ${error.message} (${old
          .map((path) => basename(dirname(path)))
          .join(", ")})`,
      );
    }
  }
  return errors;
}

/**
 * Move legacy per-deck bibliographies into their topic after a clean merge.
 *
 * If any conflict exists, the whole topic is left untouched, exactly like the
 * Python migration. `figures/` still present means the topic migration has not
 * completed, so this operation is a no-op.
 */
export async function migrate(ws: Workspace): Promise<void> {
  if (existsSync(join(ws.root, "figures"))) return;
  for (const [target, old] of plans(ws)) {
    let text: string;
    try {
      text = merge([target, ...old]);
    } catch (error) {
      if (error instanceof ValueError) continue;
      throw error;
    }
    if (old.length > 0 || !existsSync(target)) await writeAtomic(target, text);
    for (const path of old) {
      const destination = join(
        ws.state,
        "trash",
        `bib-${timeNs()}`,
        basename(dirname(path)),
        basename(path),
      );
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(path, destination);
    }
  }
}

export const FOLDERS_MESSAGE =
  "旧 figures/ と新しい topics/ が同じ置き場にあります。figures/ の中身を topics/<トピック>/html/ へ移してください。";
export const BIB_MESSAGE = "文献の移行が必要です";
export const BIB_FIX_MESSAGE =
  "発表ごとの reference.bib とトピックの reference.bib を確認してください。";

/**
 * Refuse to render while a bibliography migration is unresolved.
 *
 * The Python version reads these strings from the web bundle; the desktop core
 * has no web bundle, so the same messages used by workspace preparation are
 * kept here. Rendering never reads bibliography paths from front matter.
 */
export async function require_ready(
  ws: Workspace,
  deck: string,
  meta?: Record<string, unknown> | null,
): Promise<void> {
  if (existsSync(join(ws.root, "figures")) && existsSync(ws.topics)) {
    throw new StudioError(FOLDERS_MESSAGE);
  }
  const target = ws.bib(deck, meta ?? null);
  const old = plans(ws).get(target) ?? [];
  if (old.length) {
    try {
      merge([target, ...old]);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      throw new StudioError(
        `${BIB_MESSAGE}: ${basename(dirname(target))}: ${error.message}. ${BIB_FIX_MESSAGE}`,
      );
    }
  }
}

export async function verify(ws: Workspace, deck: string, key: string): Promise<void> {
  await require_ready(ws, deck);
  await verify_path(ws.bib(deck), key);
}

/** Remove only the selected record's unverified marker. */
export async function verify_path(path: string, key: string): Promise<void> {
  const text = readFileSync(path, "utf8");
  for (const [entryKey, raw] of entries(text)) {
    if (entryKey !== key) continue;
    let updated = raw;
    const ranges = [...fields(raw)];
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
      const [name, value, start, end] = ranges[index]!;
      if (name === "slide-studio-status"
        && value.replace(/^[{" ]+|[}" ]+$/gu, "").toLowerCase() === "unverified") {
        updated = updated.slice(0, start) + updated.slice(end);
      }
    }
    await writeAtomic(path, text.replace(raw, () => updated));
    return;
  }
  throw new KeyError(key);
}

/**
 * Replace only the selected record's editable fields.
 *
 * `original` is the raw record the editor started from; if the topic file has
 * been changed by someone else, the edit is rejected instead of overwriting it.
 */
export async function update_path(
  path: string,
  key: string,
  changes: Record<string, string>,
  original: string,
): Promise<void> {
  if (
    changes === null
    || typeof changes !== "object"
    || Array.isArray(changes)
    || Object.entries(changes).some(([name, value]) =>
      typeof name !== "string"
      || !CONTROL_FIELD.test(name)
      || name !== name.toLowerCase()
      || name === "slide-studio-status"
      || typeof value !== "string")
  ) {
    throw new ValueError("文献の入力が正しくありません");
  }

  const text = readFileSync(path, "utf8");
  for (const [entryKey, raw] of entries(text)) {
    if (entryKey !== key) continue;
    if (raw !== original) {
      throw new ValueError("文献が更新されています。開き直してから編集してください");
    }
    let updated = raw;
    const remaining = new Map(Object.entries(changes));
    const ranges = [...fields(raw)];
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
      const [name, , start, end] = ranges[index]!;
      // Python tests membership in the original `changes` map, so every
      // duplicate occurrence is rewritten. `remaining` is bookkeeping for
      // fields that still need to be appended.
      if (!Object.prototype.hasOwnProperty.call(changes, name)) continue;
      const value = pyStrip(changes[name]!);
      updated = updated.slice(0, start)
        + (value ? `${name} = {${value}},` : "")
        + updated.slice(end);
      remaining.delete(name);
    }
    let added = "";
    for (const [name, value] of remaining) {
      const trimmed = pyStrip(value);
      if (trimmed) added += `\n  ${name} = {${trimmed}},`;
    }
    if (added) {
      const prefix = updated.slice(0, -1).replace(/[\t\n\v\f\r \x1c-\x1f\x85\p{Z}]+$/u, "");
      updated = `${prefix}${prefix.endsWith(",") ? "" : ","}${added}\n${updated.slice(-1)}`;
    }

    const parsed = entries(updated);
    const found = new Map<string, string>();
    for (const [name, value] of fields(updated)) found.set(name, value);
    const expected = Object.entries(changes).every(([name, value]) => {
      const trimmed = pyStrip(value);
      return found.get(name) === (trimmed ? `{${trimmed}}` : undefined);
    });
    if (parsed.length !== 1 || parsed[0]![0] !== key || !expected) {
      throw new ValueError("文献の入力を確認してください（括弧の対応など）");
    }
    await writeAtomic(path, text.replace(raw, () => updated));
    return;
  }
  throw new KeyError(key);
}

/** Display value: strip outer quotes/braces, TeX escapes and spacing. */
export function clean(value: string): string {
  let result = value;
  if (result.length > 1 && (result.startsWith("{") || result.startsWith('"'))) {
    result = result.slice(1, -1);
  }
  result = result.replace(/\\([&%$#_{}])/gu, "$1");
  result = result
    .replace(/\{/gu, "")
    .replace(/\}/gu, "")
    .replace(/---/gu, "—")
    .replace(/--/gu, "–")
    .replace(/~/gu, " ");
  return pyStrip(result.replace(/[\t\n\v\f\r \x1c-\x1f\x85\p{Z}]+/gu, " "));
}

/**
 * Add an arXiv `howpublished` to records that have no venue.
 * Unreadable BibTeX is returned unchanged, as in the legacy renderer.
 */
export function with_arxiv_venue(text: string): string {
  let output = text;
  try {
    for (const [key, raw] of entries(text)) {
      if (key === null || key.startsWith("@string:")) continue;
      const found: Record<string, string> = {};
      for (const [name, value] of fields(raw)) found[name] = clean(value);
      const archive = found.archiveprefix || found.eprinttype || "";
      const eprint = found.eprint;
      if (archive.toLowerCase() !== "arxiv"
        || !eprint
        || Object.keys(found).some((name) => VENUE_FIELDS.has(name))) {
        continue;
      }
      const number = eprint.replace(/^arxiv:/iu, "");
      const body = raw.slice(0, -1).replace(/[\t\n\v\f\r \x1c-\x1f\x85\p{Z}]+$/u, "");
      const separator = body.endsWith(",") ? "" : ",";
      const replacement = `${body}${separator}\n  howpublished = {arXiv:${number}}\n${raw.slice(-1)}`;
      output = output.replace(raw, () => replacement);
    }
  } catch (error) {
    if (error instanceof ValueError) return text;
    throw error;
  }
  return output;
}

export interface LegacyBibliographyEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
  authors: Array<{ name: string; family: string }>;
  unverified: boolean;
  raw: string;
  editable: Record<string, string>;
  [name: string]: unknown;
}

/** Entries for the bibliography screen. Unreadable files yield `[]`. */
export function listing(path: string): LegacyBibliographyEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const output: LegacyBibliographyEntry[] = [];
  for (const [key, raw] of entries(text)) {
    if (key === null || key.startsWith("@string:")) continue;
    const found: Record<string, string> = {};
    for (const [name, value] of fields(raw)) found[name] = value;
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(found)) values[name] = clean(value);
    const editable: Record<string, string> = {};
    for (const [name, value] of Object.entries(found)) {
      editable[name] = value.startsWith("{") || value.startsWith('"')
        ? value.slice(1, -1)
        : value;
    }
    output.push({
      key,
      type: (LISTING_KIND.exec(raw)?.[1] ?? "").toLowerCase(),
      fields: values,
      authors: authors(found.author ?? ""),
      unverified: (values["slide-studio-status"] ?? "").toLowerCase() === "unverified",
      raw,
      editable,
    });
  }
  return output;
}

/** Split a BibTeX author list into display/family names. */
export function authors(value: string): Array<{ name: string; family: string }> {
  let text = value;
  if (text.length > 1 && (text.startsWith("{") || text.startsWith('"'))) {
    text = text.slice(1, -1);
  }
  const people: string[] = [];
  let depth = 0;
  let start = 0;
  for (const match of text.matchAll(AUTHOR_SPLIT)) {
    if (match[0] === "{") {
      depth += 1;
    } else if (match[0] === "}") {
      depth -= 1;
    } else if (depth === 0) {
      people.push(text.slice(start, match.index));
      start = match.index + match[0].length;
    }
  }
  people.push(text.slice(start));

  const output: Array<{ name: string; family: string }> = [];
  for (const person of people.map((item) => pyStrip(item))) {
    if (!person) continue;
    const name = clean(person);
    let family: string;
    if (person.startsWith("{") && person.endsWith("}")) {
      family = name;
    } else if (name.includes(",")) {
      family = pyStrip(name.split(",")[0]!);
    } else {
      family = name.split(" ").slice(-1)[0]!;
    }
    output.push({ name, family });
  }
  return output;
}

// The trailing word character must not be reachable through citation-key
// punctuation. The hyphen is first in the class so it is unambiguously literal.
const CITE_AFTER = /^[-\p{L}\p{N}_:.#$%&+?<>~\/]*[\p{L}\p{N}_]/u;
const CITE_BEFORE = /^[\p{L}\p{N}_.]$/u;

/** Does the manuscript cite `key` with Pandoc's punctuation rules? */
export function cites(text: string, key: string): boolean {
  for (let index = text.indexOf("@"); index >= 0; index = text.indexOf("@", index + 1)) {
    const before = index > 0 ? Array.from(text.slice(0, index)).at(-1) ?? "" : "";
    if (CITE_BEFORE.test(before)) continue;
    const rest = text.slice(index + 1);
    if (rest.startsWith(`{${key}}`)) return true;
    if (!rest.startsWith(key)) continue;
    const after = rest.slice(key.length);
    if (!CITE_AFTER.test(after)) return true;
  }
  return false;
}
