import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreErrorCode } from "../../contracts/src/desktop.js";
import { assetPath } from "./assets.js";
import { CoreError, isNodeError } from "./errors.js";
import { parse } from "./source.js";
import type { Doc } from "./source.js";

const NAME = /^[a-z0-9][a-z0-9-]*$/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
export const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
export const BOM = "\uFEFF";

export class StudioError extends CoreError {
  constructor(message: string, code: CoreErrorCode = "INVALID_INPUT") {
    super(code, message);
    this.name = "StudioError";
  }
}

export function packageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      const value = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (["slide-studio", "slide-studio-portable"].includes(String(value.name)) && typeof value.version === "string") {
        return value.version;
      }
    } catch {
      // Keep walking up until the repository/package root is found.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "0.1.0";
}

export function expandUser(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function sha256Bytes(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function decodeUtf8(data: Buffer | Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new StudioError(
      `${label} は UTF-8 として読み取れません。元のファイルは変更していません。`
        + "文字コードを UTF-8 に変換してから再実行してください。",
      "CONFLICT",
    );
  }
}

export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

export function existsNoFollow(path: string): boolean {
  return lstatOrNull(path) !== null;
}

export function readIfFile(path: string): Buffer | null {
  const link = lstatOrNull(path);
  if (!link || link.isSymbolicLink() || !link.isFile()) return null;
  return readFileSync(path);
}

export function readJsonObject(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed state is treated as empty.
  }
  return {};
}

export function readJsonArray(path: string): Record<string, unknown>[] {
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

export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`)
      .join(", ")}}`;
  }
  return pyStr(value);
}

export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Number.POSITIVE_INFINITY) return "inf";
    if (value === Number.NEGATIVE_INFINITY) return "-inf";
    if (Object.is(value, -0)) return "-0.0";
    return String(value);
  }
  return pyRepr(value);
}

export function sortedJson(value: Record<string, unknown>, indent = 0): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) ordered[key] = value[key];
  return JSON.stringify(ordered, null, indent);
}

export function timeNs(): string {
  return (BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n).toString();
}

export function sameJson(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

const RETRYABLE_RENAME = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export function renameWithRetry(from: string, to: string): void {
  const delays = process.platform === "win32" ? [0, 10, 20, 40, 80, 120, 200] : [0];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const retryable = isNodeError(error)
        && typeof error.code === "string"
        && RETRYABLE_RENAME.has(error.code);
      if (!retryable || attempt === delays.length - 1) throw error;
      Atomics.wait(sleepBuffer, 0, 0, delays[attempt]);
    }
  }
}

export function atomicWrite(path: string, data: string | Uint8Array, mode?: number): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  let finalMode = mode;
  if (finalMode === undefined) {
    const existing = lstatOrNull(path);
    finalMode = existing && existing.isFile()
      ? existing.mode & 0o777
      : 0o666 & ~process.umask();
  }
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
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
    renameWithRetry(temporary, path);
    if (process.platform !== "win32") {
      let directoryDescriptor: number | undefined;
      try {
        directoryDescriptor = openSync(directory, "r");
        fsyncSync(directoryDescriptor);
      } catch {
        // Directory fsync is a durability improvement; the rename already won.
      } finally {
        if (directoryDescriptor !== undefined) {
          try {
            closeSync(directoryDescriptor);
          } catch {
            // Ignore close failures after a successful rename.
          }
        }
      }
    }
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

export function isReadOnlyError(error: unknown): boolean {
  return isNodeError(error)
    && (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS");
}

// ---------------------------------------------------------------- names

export function check_name(value: unknown, what = "名前"): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new StudioError(`${what}には英小文字・数字・ハイフンを使ってください: ${pyRepr(value)}`);
  }
  return value;
}

export function validateWindowsName(value: string): void {
  if (WINDOWS_RESERVED.test(value.split(".", 1)[0] ?? "")) {
    throw new StudioError(`予約された名前は使えません: ${JSON.stringify(value)}`);
  }
}

export function check_creation_name(value: unknown, what = "名前"): string {
  const name = check_name(value, what);
  validateWindowsName(name);
  return name;
}

export function checkLookupName(value: unknown, what: string): string {
  if (
    typeof value !== "string"
    || !value
    || value === "."
    || value === ".."
    || isAbsolute(value)
    || value.includes("/")
    || (process.platform === "win32" && value.includes("\\"))
    || CONTROL_CHARACTER.test(value)
  ) {
    throw new StudioError(`${what}が正しくありません: ${JSON.stringify(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------- location

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
  const values = [root, ...(options.previous ? [options.previous] : []), ...recent_roots()];
  const recent: string[] = [];
  for (const value of values) if (!recent.includes(value)) recent.push(value);
  atomicWrite(location_file(), JSON.stringify({ root, recent: recent.slice(0, 12) }));
}

// ---------------------------------------------------------------- themes & source helpers

export function theme_variables(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: string[] = [];
  const pattern = /(?<![\p{L}\p{N}_-])(--[\p{L}\p{N}_-]+)\s*:\s*[^;{}\s][^;{}]*(?=[;}])/gu;
  for (const match of withoutComments.matchAll(pattern)) {
    const name = match[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
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
    for (const item of (match[1] ?? "").matchAll(/(['"`])([^\n]*?)\1/gu)) {
      if (item[2] !== undefined) steps.push(item[2]);
    }
    return steps;
  } catch {
    return [];
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function set_front(text: string, values: Record<string, unknown>): string {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : body.includes("\r") && !body.includes("\n") ? "\r" : "\n";
  const normalized = body.replace(/\r\n?/gu, "\n");
  let updated = setFrontNormalized(normalized, values);
  if (eol !== "\n") updated = updated.replaceAll("\n", eol);
  return `${bom ? BOM : ""}${updated}`;
}

function setFrontNormalized(text: string, values: Record<string, unknown>): string {
  let document: Doc = parse(text);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    normalized[key === "figures" ? "topic" : key] = value;
  }

  if (document.front[1] && "figures" in document.meta) {
    let head = text.slice(0, document.front[1]);
    if (/^topic\s*:/mu.test(head)) {
      head = head.replace(/^figures\s*:.*\n/gmu, "");
    } else {
      head = head.replace(/^figures(?=\s*:)/gmu, "topic");
    }
    text = head + text.slice(document.front[1]);
    document = parse(text);
  }

  const entries = Object.entries(normalized);
  if (!document.front[1]) {
    if (entries.length === 0) return text;
    const lines = entries.map(([key, value]) => `${key}: ${pyStr(value)}\n`).join("");
    return `---\n${lines}---\n\n${text}`;
  }

  const head = text.slice(0, document.front[1]);
  const rest = text.slice(document.front[1]);
  const lines = head.split("\n");
  let close = -1;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "---" || line === "...") {
      close = index;
      break;
    }
  }
  if (close < 0) return text;
  for (const [key, value] of entries) {
    const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:`, "u");
    let hit: number | null = null;
    for (let index = 1; index < close; index += 1) {
      if (pattern.test(lines[index] ?? "")) {
        hit = index;
        break;
      }
    }
    const rendered = `${key}: ${pyStr(value)}`;
    if (hit !== null) {
      lines[hit] = rendered;
    } else {
      lines.splice(close, 0, rendered);
      close += 1;
    }
  }
  return lines.join("\n") + rest;
}

export function words(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

export function normalizeForCompare(text: string): string {
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n?/gu, "\n");
}

export function isIgnoredDeckFile(name: string): boolean {
  if (name === ".DS_Store") return true;
  if (process.platform !== "win32") return name.endsWith(".html") || name.endsWith(".pdf");
  const lower = name.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".pdf");
}

// ---------------------------------------------------------------- strings

export interface ThemePreparationMessages {
  name: string;
  detail: string;
  fix: string;
}

export interface MigrationPreparationMessages {
  topics: string;
  folders: string;
  folderFix: string;
  bib: string;
  bibFix: string;
}

let STRINGS_FILE: string | null = null;

/** Integration/tests can point at the renderer's canonical strings module. */
export function set_strings_file(path: string | null): void {
  STRINGS_FILE = path ? resolve(path) : null;
}

function stringsCandidates(): string[] {
  const values = STRINGS_FILE ? [STRINGS_FILE] : [];
  values.push(join(dirname(fileURLToPath(import.meta.url)), "../../web/strings.js"));
  try {
    values.push(assetPath("strings.js"));
  } catch {
    // Assets may be unavailable in a pure unit test.
  }
  values.push(join(process.cwd(), "packages", "web", "strings.js"));
  return values;
}

function readStringsConstant(name: string): Record<string, string> | null {
  for (const path of stringsCandidates()) {
    try {
      const text = readFileSync(path, "utf8");
      const marker = `export const ${name} = `;
      const start = text.indexOf(marker);
      if (start < 0) continue;
      const source = text.slice(start + marker.length);
      const match = /^(\{[\s\S]*?\});/u.exec(source);
      if (!match) continue;
      const parsed = JSON.parse(match[1]!) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function requireStringsConstant(name: string): Record<string, string> {
  const found = readStringsConstant(name);
  if (!found) {
    throw new StudioError(
      `UI 文言（${name}）を読み込めません。strings.js の配置を確認してください。`,
      "INVALID_INPUT",
    );
  }
  return found;
}

export function themePreparationMessages(): ThemePreparationMessages {
  const found = requireStringsConstant("THEME_PREPARATION");
  if (
    typeof found.name !== "string"
    || typeof found.detail !== "string"
    || typeof found.fix !== "string"
  ) {
    throw new StudioError("UI 文言（THEME_PREPARATION）が不完全です。", "INVALID_INPUT");
  }
  return { name: found.name, detail: found.detail, fix: found.fix };
}

export function migrationPreparationMessages(): MigrationPreparationMessages {
  const found = requireStringsConstant("MIGRATION_PREPARATION");
  if (
    typeof found.topics !== "string"
    || typeof found.folders !== "string"
    || typeof found.folderFix !== "string"
    || typeof found.bib !== "string"
    || typeof found.bibFix !== "string"
  ) {
    throw new StudioError("UI 文言（MIGRATION_PREPARATION）が不完全です。", "INVALID_INPUT");
  }
  return {
    topics: found.topics,
    folders: found.folders,
    folderFix: found.folderFix,
    bib: found.bib,
    bibFix: found.bibFix,
  };
}
