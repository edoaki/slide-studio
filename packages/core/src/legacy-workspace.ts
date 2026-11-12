/**
 * Compatibility layer for the legacy Python workspace model.
 *
 * The on-disk contract is identical to `slide_studio/workspace.py`: `decks/`,
 * `topics/`, `themes/` and `.slide-studio/` live directly under the selected
 * root. All writes are atomic, all destructive operations are validated
 * against the canonical root, and originals are moved to `.slide-studio/trash/`
 * before they are replaced or removed.
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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreErrorCode } from "../../contracts/src/desktop.js";
import { assetPath } from "./assets.js";
import { CoreError, isNodeError } from "./errors.js";
import {
  assertInsideRoot,
  canonicalRoot,
  isInsideRoot,
} from "./paths.js";
import { parse } from "./legacy-source.js";
import type { Doc } from "./legacy-source.js";
import {
  drop_cover_layout,
  preserve_title_header,
  refresh_heading_options,
  read_vars,
  OVERRIDE_RE,
} from "./legacy-theme-edit.js";
import { with_current_palette } from "./legacy-block-design.js";
import {
  copy_topic_assets,
  migrateTopics,
} from "./legacy-topic-migrate.js";

export const VERSION = packageVersion();
export { VERSION as __version__ };

/** Bundled templates. The runtime can replace these roots in integration tests. */
export let TEMPLATES = assetPath("templates");
export let RUNTIME = assetPath("runtime");

export function set_templates_root(path: string): void {
  TEMPLATES = resolve(path);
  THEME_VARIABLES = theme_variables(
    readFileSync(join(TEMPLATES, "themes", "_base.css"), "utf8"),
  );
}

export function set_runtime_root(path: string): void {
  RUNTIME = resolve(path);
}

const NAME = /^[a-z0-9][a-z0-9-]*$/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const BOM = "\uFEFF";

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

function packageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      const value = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (value.name === "slide-studio" && typeof value.version === "string") return value.version;
    } catch {
      // Keep walking up until the repository/package root is found.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "0.1.0";
}

function expandUser(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function sha256Bytes(data: Buffer | string): string {
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

function primitiveFrontValue(value: unknown): string {
  return pyStr(value);
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
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

const RETRYABLE_RENAME = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function renameWithRetry(from: string, to: string): void {
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

function isReadOnlyError(error: unknown): boolean {
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

function validateWindowsName(value: string): void {
  if (WINDOWS_RESERVED.test(value.split(".", 1)[0] ?? "")) {
    throw new StudioError(`予約された名前は使えません: ${JSON.stringify(value)}`);
  }
}

function check_creation_name(value: unknown, what = "名前"): string {
  const name = check_name(value, what);
  validateWindowsName(name);
  return name;
}

function checkLookupName(value: unknown, what: string): string {
  if (
    typeof value !== "string"
    || !value
    || value === "."
    || value === ".."
    || isAbsolute(value)
    || /[\\/]/u.test(value)
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

// ---------------------------------------------------------------- themes

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

export let THEME_VARIABLES = theme_variables(
  readFileSync(join(TEMPLATES, "themes", "_base.css"), "utf8"),
);

// ---------------------------------------------------------------- source helpers

export function runtime_rel(fig_dir: string, ws: Workspace): string {
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
    for (const item of (match[1] ?? "").matchAll(/(['"`])([^\n]*?)\1/gu)) {
      if (item[2] !== undefined) steps.push(item[2]);
    }
    return steps;
  } catch {
    return [];
  }
}

function escapeRegExp(value: string): string {
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
    const lines = entries.map(([key, value]) => `${key}: ${primitiveFrontValue(value)}\n`).join("");
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
    const rendered = `${key}: ${primitiveFrontValue(value)}`;
    if (hit !== null) {
      lines[hit] = rendered;
    } else {
      lines.splice(close, 0, rendered);
      close += 1;
    }
  }
  return lines.join("\n") + rest;
}

export function blank_qmd(
  shelf: string,
  theme: string,
  title?: string | null,
  templatesRoot = TEMPLATES,
): string {
  let text = readFileSync(join(templatesRoot, "deck", "slides.qmd"), "utf8")
    .replaceAll("{{SHELF}}", shelf)
    .replaceAll("{{THEME}}", theme);
  if (title) {
    const shown = title.replace(/[\r\n]/gu, " ");
    text = text.replaceAll("発表タイトル", shown);
    text = set_front(text, { title: JSON.stringify(title) });
  }
  return text;
}

function words(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

// ---------------------------------------------------------------- strings

interface ThemePreparationMessages {
  name: string;
  detail: string;
  fix: string;
}
interface MigrationPreparationMessages {
  topics: string;
  folders: string;
  folderFix: string;
  bib: string;
  bibFix: string;
}

const FALLBACK_THEME_PREPARATION: ThemePreparationMessages = {
  name: "テーマの準備",
  detail: "同梱テーマの default.css が古い形式のままです。",
  fix: "テーマを現在の版に戻すか、発表ごとの styles/slides.css に調整を移してください。",
};
const FALLBACK_MIGRATION_PREPARATION: MigrationPreparationMessages = {
  topics: "トピックの移行",
  folders: "旧 figures/ と新しい topics/ が同じ置き場にあります。",
  folderFix: "figures/ の中身を topics/<トピック>/html/ へ移してください。",
  bib: "文献の移行",
  bibFix: "発表ごとの reference.bib とトピックの reference.bib を確認してください。",
};

let STRINGS_FILE: string | null = null;

/** Integration/tests can point at the renderer's canonical strings module. */
export function set_strings_file(path: string | null): void {
  STRINGS_FILE = path ? resolve(path) : null;
}

function stringsCandidates(): string[] {
  const values = STRINGS_FILE ? [STRINGS_FILE] : [];
  values.push(join(process.cwd(), "packages", "web", "strings.js"));
  values.push(join(dirname(fileURLToPath(import.meta.url)), "../../../web/strings.js"));
  try {
    values.push(assetPath("strings.js"));
  } catch {
    // Assets may be unavailable in a pure unit test.
  }
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

function themePreparationMessages(): ThemePreparationMessages {
  const found = readStringsConstant("THEME_PREPARATION");
  return {
    name: typeof found?.name === "string" ? found.name : FALLBACK_THEME_PREPARATION.name,
    detail: typeof found?.detail === "string" ? found.detail : FALLBACK_THEME_PREPARATION.detail,
    fix: typeof found?.fix === "string" ? found.fix : FALLBACK_THEME_PREPARATION.fix,
  };
}

function migrationPreparationMessages(): MigrationPreparationMessages {
  const found = readStringsConstant("MIGRATION_PREPARATION");
  return {
    topics: typeof found?.topics === "string" ? found.topics : FALLBACK_MIGRATION_PREPARATION.topics,
    folders: typeof found?.folders === "string" ? found.folders : FALLBACK_MIGRATION_PREPARATION.folders,
    folderFix: typeof found?.folderFix === "string" ? found.folderFix : FALLBACK_MIGRATION_PREPARATION.folderFix,
    bib: typeof found?.bib === "string" ? found.bib : FALLBACK_MIGRATION_PREPARATION.bib,
    bibFix: typeof found?.bibFix === "string" ? found.bibFix : FALLBACK_MIGRATION_PREPARATION.bibFix,
  };
}

// ---------------------------------------------------------------- workspace

export interface WorkspaceOptions {
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
  readonly #themeVariables: string[];

  constructor(root: string, options: WorkspaceOptions = {}) {
    const expanded = expandUser(root);
    const resolved = resolve(expanded);
    this.root = existsSync(resolved) ? canonicalRoot(resolved) : resolved;
    this.#templates = options.templatesRoot ? resolve(options.templatesRoot) : TEMPLATES;
    this.#runtimeAssets = options.runtimeRoot ? resolve(options.runtimeRoot) : RUNTIME;
    this.#version = options.version ?? VERSION;
    this.#themeVariables = theme_variables(
      readFileSync(join(this.#templates, "themes", "_base.css"), "utf8"),
    );
  }

  static open(
    root?: string | null,
    ensure = true,
    options: WorkspaceOptions = {},
  ): Workspace {
    const selected = root ? expandUser(root) : default_root();
    const expanded = resolve(selected);
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
    const bundled = this.#listFiles(themeDirectory)
      .filter((name) => name.endsWith(".css") && !name.startsWith("_"))
      .sort();
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
          // A linked theme may point outside the workspace. Leave it alone and
          // let theme_preparation() surface it instead of making the workspace
          // impossible to open.
          continue;
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
        this.#unlinkOptional(oldSerif);
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
      if (exists) this.#unlinkOptional(retired);
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
    for (const name of this.#listEntries(directory)
      .filter((item) => item.name.endsWith(".css"))
      .map((item) => item.name)
      .sort()) {
      const path = join(directory, name);
      if (!this.#isRegularFile(path)) continue;
      const css = this.#readText(path, name);
      let updated = drop_cover_layout(refresh_heading_options(css, this.#themeVariables));
      if (this.#themeVariables.every((variable) => theme_variables(css).includes(variable))) {
        const repainted = with_current_palette(updated, read_vars(css, this.#themeVariables));
        if (repainted !== updated) {
          this.#write(join(this.state, "trash", "themes", timeNs(), name), css);
          updated = repainted;
        }
      }
      const original = join(this.#templates, "themes", name);
      const colors = read_vars(css, this.#themeVariables);
      if (
        OVERRIDE_RE.test(css)
        && colors["--header"] === colors["--paper"]
        && this.#isRegularFile(original)
      ) {
        updated = preserve_title_header(
          updated,
          readFileSync(original, "utf8"),
          this.#themeVariables,
        );
      }
      if (updated !== css) this.#write(path, updated);
    }
  }

  theme_preparation(): Array<Record<string, unknown>> {
    const path = join(this.themes, "default.css");
    const link = lstatOrNull(path);
    if (link?.isSymbolicLink()) {
      const messages = themePreparationMessages();
      return [{
        name: messages.name,
        ok: false,
        detail: "themes/default.css はシンボリックリンクです。リンク先を確認してください。",
        fix: messages.fix,
      }];
    }
    if (!this.#isRegularFile(path)) return [];
    const css = this.#readText(path, "default.css");
    if (this.#themeVariables.every((variable) => theme_variables(css).includes(variable))) return [];
    const messages = themePreparationMessages();
    return [{
      name: messages.name,
      ok: false,
      detail: messages.detail,
      fix: messages.fix,
    }];
  }

  migration_preparation(): Array<Record<string, unknown>> {
    const messages = migrationPreparationMessages();
    const output: Array<Record<string, unknown>> = [];
    if (existsNoFollow(join(this.root, "figures")) && existsNoFollow(this.topics)) {
      output.push({
        name: messages.topics,
        ok: false,
        detail: messages.folders,
        fix: messages.folderFix,
      });
    }
    for (const detail of this.#bibliographyConflicts()) {
      output.push({
        name: messages.bib,
        ok: false,
        detail,
        fix: messages.bibFix,
      });
    }
    return output;
  }

  // ------------------------------------------------------------ 発表
  list_decks(): string[] {
    const directory = this.decks;
    if (!this.#isDirectory(directory)) return [];
    const output: string[] = [];
    for (const entry of this.#listEntries(directory)) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const deckPath = join(directory, entry.name);
      const deckLink = lstatOrNull(deckPath);
      if (!deckLink) continue;
      let realDeck: string;
      try {
        realDeck = realpathSync.native(deckPath);
      } catch {
        continue;
      }
      if (!isInsideRoot(this.root, realDeck)) continue;
      try {
        if (!statSync(realDeck).isDirectory()) continue;
      } catch {
        continue;
      }
      const qmd = join(deckPath, "slides.qmd");
      let realQmd: string;
      try {
        realQmd = realpathSync.native(qmd);
      } catch {
        continue;
      }
      if (!isInsideRoot(this.root, realQmd)) continue;
      try {
        if (statSync(realQmd).isFile()) output.push(entry.name);
      } catch {
        // Not a readable deck.
      }
    }
    return output.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  has_deck(deck: string): boolean {
    try {
      const path = this.qmd(deck);
      const link = lstatOrNull(path);
      if (!link) return false;
      const real = realpathSync.native(path);
      if (!isInsideRoot(this.root, real)) return false;
      return statSync(real).isFile();
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
    return parse(this.#readText(this.qmd(deck), "slides.qmd")).meta;
  }

  deck_shelf(deck: string): string {
    const shelf = this.deck_meta(deck).topic;
    if (!pyTruthy(shelf)) {
      throw new StudioError(`${deck} の front matter に topic:（トピック）がありません`);
    }
    return pyStr(shelf);
  }

  bib(deck: string, meta?: Record<string, unknown> | null): string {
    const topic = (meta ?? this.deck_meta(deck)).topic;
    if (!pyTruthy(topic)) return join(this.state, "missing-topic.bib");
    return join(this.topic_dir(pyStr(topic)), "reference.bib");
  }

  deck_theme(deck: string): string {
    const theme = this.deck_meta(deck).theme;
    return pyTruthy(theme) ? pyStr(theme) : "default";
  }

  is_blank(deck: string): boolean {
    const text = normalizeForCompare(this.#readText(this.qmd(deck), "slides.qmd"));
    const document = parse(text);
    if (document.pages.length === 0) return true;
    const meta = document.meta;
    const title = pyTruthy(meta.title) ? pyStr(meta.title) : "";
    const blank = normalizeForCompare(this.#blank(
      pyTruthy(meta.topic) ? pyStr(meta.topic) : "",
      pyTruthy(meta.theme) ? pyStr(meta.theme) : "",
      title === "" || title === "発表タイトル" ? null : title,
    ));
    return set_front(text, {}).trim() === blank.trim();
  }

  is_untouched(deck: string): boolean {
    if (!this.is_blank(deck)) return false;
    const memo = this.memo(deck);
    if (existsNoFollow(memo) && !this.#isRegularFile(memo)) return false;
    if (!this.#isRegularFile(memo)) return true;
    const current = normalizeForCompare(this.#readText(memo, "memo.md"));
    const template = normalizeForCompare(
      readFileSync(join(this.#templates, "deck", "memo.md"), "utf8"),
    );
    return words(current).join("\u0000") === words(template).join("\u0000");
  }

  new_deck(
    deck: string,
    shelf: string,
    theme = "default",
    source_deck: string | null = null,
    title: string | null = null,
  ): string {
    check_creation_name(deck, "フォルダ名");
    check_name(shelf, "トピックの名前");
    if (!existsNoFollow(this.topic_dir(shelf))) validateWindowsName(shelf);
    check_name(theme, "テーマ");
    if (source_deck) check_name(source_deck, "複製する発表");
    const destination = this.deck_dir(deck);
    if (existsNoFollow(destination)) throw new StudioError(`既にあります: ${destination}`);

    const themePath = join(this.themes, `${theme}.css`);
    if (!this.#isRegularFile(themePath)) {
      throw new StudioError(`テーマがありません: themes/${theme}.css`);
    }

    this.#ensureDirectory(this.decks, "decks");
    const temporary = join(this.decks, `.new-${randomUUID()}`);
    try {
      if (source_deck) {
        const source = this.require_deck(source_deck);
        const ignore = (directory: string, names: string[]): string[] => [
          ...names.filter((name) => isIgnoredDeckFile(name)),
          ...(resolve(directory) === resolve(source) ? ["materials"] : []),
        ];
        this.#copyTree(source, temporary, { ignore });
        const qmd = join(temporary, "slides.qmd");
        const sourceBib = this.bib(source_deck);
        if (shelf !== this.deck_shelf(source_deck) && this.#isRegularFile(sourceBib)) {
          this.#write(join(temporary, "reference.bib"), this.#read(sourceBib, "reference.bib"));
        }
        let text = copy_topic_assets(
          this,
          source_deck,
          deck,
          shelf,
          this.#readText(qmd, "slides.qmd"),
        );
        text = set_front(text, { topic: shelf, theme });
        if (title) text = set_front(text, { title: JSON.stringify(title) });
        this.#write(qmd, text);
      } else {
        this.#copyTree(join(this.#templates, "deck"), temporary, {
          ignore: (_directory, names) => names.filter((name) => name === ".DS_Store"),
        });
        this.#write(join(temporary, "slides.qmd"), blank_qmd(shelf, theme, title, this.#templates));
      }
      renameWithRetry(temporary, destination);
    } catch (error) {
      this.#removeTree(temporary);
      throw error;
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
        title: pyTruthy(meta.title)
          ? pyStr(meta.title)
          : pyTruthy(meta.pagetitle)
            ? pyStr(meta.pagetitle)
            : deck,
        shelf: pyTruthy(meta.topic) ? pyStr(meta.topic) : "",
        theme: pyTruthy(meta.theme) ? pyStr(meta.theme) : "",
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
    const output: string[] = [];
    for (const entry of this.#listEntries(this.topics)) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const path = join(this.topics, entry.name);
      if (!this.#entryIsDirectory(path)) continue;
      output.push(entry.name);
    }
    return output.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  new_topic(shelf: string): string {
    check_creation_name(shelf, "トピック");
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
      const topic = parse(text).meta.topic;
      const metaTopic = pyTruthy(topic) ? pyStr(topic) : "";
      const figurePattern = new RegExp(`\\{\\{<\\s*fig\\s+["']?${escapeRegExp(shelf)}/`, "u");
      if (metaTopic === shelf || text.includes(`topics/${shelf}/`) || figurePattern.test(text)) {
        throw new StudioError("topicInUse", "CONFLICT");
      }
    }

    const trash = join(this.state, "trash", "topics", `${shelf}-${timeNs()}`);
    this.#renameWithinRoot(base, trash);
    return trash;
  }

  topic_empty(shelf: string): boolean {
    const base = this.topic_dir(shelf);
    const link = lstatOrNull(base);
    if (!link) return true;
    if (link.isSymbolicLink() || !link.isDirectory()) return false;
    const hasFile = (directory: string): boolean => {
      for (const entry of this.#listEntries(directory)) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          if (entry.name !== ".DS_Store") return true;
        } else if (entry.isDirectory()) {
          if (hasFile(path)) return true;
        } else if (entry.isFile() && entry.name !== ".DS_Store") {
          return true;
        }
      }
      return false;
    };
    return !hasFile(base);
  }

  themes_list(): string[] {
    const output: string[] = [];
    for (const entry of this.#listEntries(this.themes)) {
      if (entry.name.startsWith("_") || !entry.name.endsWith(".css")) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      output.push(entry.name.slice(0, -4));
    }
    return output.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  theme_default(name: string): string | null {
    check_name(name, "テーマ");
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
    check_creation_name(name, "テーマ");
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
    this.#renameWithinRoot(path, join(trash, `${name}.css`));
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
      || parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new StudioError(`トピック/名前で図を指定してください: ${ref}`);
    }
    check_name(shelf, "トピック");
    const base = join(this.topics, shelf, "html");
    const result = join(base, ...parts);
    if (!isInsideRoot(base, result)) {
      throw new StudioError(`トピック/名前で図を指定してください: ${ref}`, "OUTSIDE_ROOT");
    }
    return result;
  }

  list_figures(shelf: string | null = null, deck: string | null = null): Array<Record<string, unknown>> {
    const selected = deck ? this.deck_shelf(deck) : shelf;
    if (!selected) return [];
    const base = this.shelf_dir(selected);
    if (!this.#isDirectory(base)) return [];
    const output: Array<Record<string, unknown>> = [];
    const entries = this.#listEntries(base).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of entries) {
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
        if ((match[1] ?? "").replace(/^"+|"+$/gu, "") === ref) {
          output.push(deck);
          break;
        }
      }
    }
    return output;
  }

  // ------------------------------------------------------------ internals
  #parse(text: string): Doc {
    return parse(text);
  }

  #blank(shelf: string, theme: string, title: string | null): string {
    return blank_qmd(shelf, theme, title, this.#templates);
  }

  #deckName(deck: string): string {
    return checkLookupName(deck, "発表名");
  }

  #assertLexicalInside(path: string, label: string): void {
    const target = resolve(path);
    if (!isInsideRoot(this.root, target)) {
      throw new StudioError(`refusing to access outside the workspace root: ${label}`, "OUTSIDE_ROOT");
    }
  }

  #nearestExisting(path: string): string {
    let current = path;
    while (!existsNoFollow(current)) {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return current;
  }

  #assertParentRealInside(path: string, label: string): void {
    const parent = this.#nearestExisting(dirname(path));
    const real = realpathSync.native(parent);
    assertInsideRoot(this.root, real, label);
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

  #entryIsDirectory(path: string): boolean {
    const link = lstatOrNull(path);
    if (!link) return false;
    if (link.isSymbolicLink()) {
      try {
        const real = realpathSync.native(path);
        return isInsideRoot(this.root, real) && statSync(real).isDirectory();
      } catch {
        return false;
      }
    }
    return link.isDirectory();
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
      let target: string;
      try {
        target = realpathSync.native(path);
      } catch {
        throw new StudioError(`${label} がありません`, "NOT_FOUND");
      }
      assertInsideRoot(this.root, target, label);
      if (!statSync(target).isFile()) throw new StudioError(`${label} is not a file`, "NOT_FOUND");
      return readFileSync(target);
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
    try {
      atomicWrite(path, data, mode ?? (link?.isFile() ? link.mode & 0o777 : undefined));
    } catch (error) {
      if (isReadOnlyError(error)) {
        throw new StudioError(
          `${basename(path)} は読み取り専用のため書き換えられません（元のファイルは残しています）`,
          "READ_ONLY",
        );
      }
      throw error;
    }
  }

  #unlinkOptional(path: string): void {
    const link = lstatOrNull(path);
    if (!link || link.isDirectory()) return;
    const realParent = realpathSync.native(dirname(path));
    assertInsideRoot(this.root, realParent, basename(path));
    try {
      unlinkSync(join(realParent, basename(path)));
    } catch (error) {
      if (isReadOnlyError(error)) {
        throw new StudioError(
          `${basename(path)} は読み取り専用のため削除できません（元のファイルは残しています）`,
          "READ_ONLY",
        );
      }
      throw error;
    }
  }

  #removeTree(path: string): void {
    this.#assertLexicalInside(path, basename(path));
    if (!existsNoFollow(dirname(path))) return;
    const realParent = realpathSync.native(dirname(path));
    assertInsideRoot(this.root, realParent, basename(path));
    const target = join(realParent, basename(path));
    const link = lstatOrNull(target);
    if (!link) return;
    if (link.isSymbolicLink()) {
      unlinkSync(target);
      return;
    }
    if (!link.isDirectory()) {
      unlinkSync(target);
      return;
    }
    rmSync(target, { recursive: true, force: true });
  }

  #renameWithinRoot(from: string, to: string): void {
    const fromParent = realpathSync.native(dirname(from));
    assertInsideRoot(this.root, fromParent, basename(from));
    this.#ensureDirectory(dirname(to), "trash");
    const toParent = realpathSync.native(dirname(to));
    assertInsideRoot(this.root, toParent, basename(to));
    try {
      renameWithRetry(join(fromParent, basename(from)), join(toParent, basename(to)));
    } catch (error) {
      if (isReadOnlyError(error)) {
        throw new StudioError(
          `${basename(from)} は読み取り専用のため移動できません（元のファイルは残しています）`,
          "READ_ONLY",
        );
      }
      throw error;
    }
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

  #copyTree(
    source: string,
    destination: string,
    options: CopyOptions = {},
    visited: Set<string> = new Set(),
  ): void {
    const sourceLink = lstatOrNull(source);
    if (!sourceLink) throw new StudioError(`コピー元がありません: ${source}`);
    if (sourceLink.isSymbolicLink()) {
      const real = realpathSync.native(source);
      assertInsideRoot(this.root, real, relative(this.root, source));
      if (visited.has(real)) {
        throw new StudioError(`シンボリックリンクが循環しています: ${source}`, "CONFLICT");
      }
      const statValue = statSync(real);
      if (statValue.isDirectory()) {
        this.#copyTree(real, destination, options, new Set([...visited, real]));
        return;
      }
      if (statValue.isFile()) {
        this.#write(destination, readFileSync(real), statValue.mode & 0o777);
        return;
      }
      throw new StudioError(`コピーできない種類のファイルです: ${source}`, "CONFLICT");
    }

    this.#ensureDirectory(destination, basename(destination));
    const entries = this.#listEntries(source);
    const names = entries.filter((entry) => !entry.isSymbolicLink()).map((entry) => entry.name).sort();
    const ignored = new Set(options.ignore?.(source, names) ?? []);
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      const link = lstatSync(from);
      if (link.isSymbolicLink()) {
        const real = realpathSync.native(from);
        if (!isInsideRoot(this.root, real)) {
          throw new StudioError(
            `ワークスペースの外を指すリンクはコピーできません: ${relative(this.root, from)}`,
            "OUTSIDE_ROOT",
          );
        }
        if (visited.has(real)) {
          throw new StudioError(`シンボリックリンクが循環しています: ${relative(this.root, from)}`, "CONFLICT");
        }
        const statValue = statSync(real);
        if (statValue.isDirectory()) {
          this.#copyTree(real, to, options, new Set([...visited, real]));
        } else if (statValue.isFile()) {
          this.#write(to, readFileSync(real), statValue.mode & 0o777);
        } else {
          throw new StudioError(`コピーできない種類のファイルです: ${relative(this.root, from)}`, "CONFLICT");
        }
      } else if (link.isDirectory()) {
        this.#copyTree(from, to, options, visited);
      } else if (link.isFile()) {
        this.#write(to, readFileSync(from), link.mode & 0o777);
      } else {
        throw new StudioError(`コピーできない種類のファイルです: ${relative(this.root, from)}`, "CONFLICT");
      }
    }
  }

  #migrateTopics(): void {
    migrateTopics(this, set_front);
  }

  #copyTopicAssets(sourceDeck: string, deck: string, shelf: string, text: string): string {
    return copy_topic_assets(this, sourceDeck, deck, shelf, text);
  }

  // ------------------------------------------------------------ bibliography
  #migrateBibliography(): void {
    if (existsNoFollow(join(this.root, "figures"))) return;
    for (const [target, old] of this.#bibliographyPlans()) {
      let merged: string;
      try {
        merged = mergeBibtexTexts([
          this.#isRegularFile(target) ? this.#readText(target, "reference.bib") : "",
          ...old.map((path) => this.#readText(path, "reference.bib")),
        ]);
      } catch {
        // A conflict or unreadable BibTeX must never delete the local file.
        continue;
      }
      if (old.length > 0 || !this.#isRegularFile(target)) {
        if (this.#isRegularFile(target)) {
          this.#backupToTrash(
            `bib-${timeNs()}/topics/${basename(dirname(target))}/${basename(target)}`,
            this.#read(target, "reference.bib"),
          );
        }
        this.#write(target, merged);
      }
      for (const path of old) {
        const destination = join(
          this.state,
          "trash",
          `bib-${timeNs()}`,
          basename(dirname(path)),
          basename(path),
        );
        this.#renameWithinRoot(path, destination);
      }
    }
  }

  #bibliographyPlans(): Array<[string, string[]]> {
    const groups = new Map<string, string[]>();
    for (const deck of this.list_decks()) {
      let target: string;
      try {
        target = this.bib(deck);
      } catch {
        continue;
      }
      if (dirname(target) === this.state) continue;
      if (existsNoFollow(target) && !this.#isRegularFile(target)) continue;
      if (!groups.has(target)) groups.set(target, []);
      const old = join(this.deck_dir(deck), "reference.bib");
      if (this.#isRegularFile(old)) groups.get(target)!.push(old);
    }
    return [...groups.entries()];
  }

  #bibliographyConflicts(): string[] {
    const errors: string[] = [];
    for (const [target, old] of this.#bibliographyPlans()) {
      try {
        mergeBibtexTexts([
          this.#isRegularFile(target) ? this.#readText(target, "reference.bib") : "",
          ...old.map((path) => this.#readText(path, "reference.bib")),
        ]);
      } catch (error) {
        errors.push(
          `${basename(dirname(target))}: ${error instanceof Error ? error.message : String(error)} `
            + `(${old.map((path) => basename(dirname(path))).join(", ")})`,
        );
      }
    }
    return errors;
  }

  // ------------------------------------------------------------ agent files
  #ensureAgentFiles(): void {
    // PENDING integration: the generated agent-file writer must own
    // `agent-files.json` and `_version`; this copy path stays the legacy port
    // until that generator is wired.
    const templateDirectory = join(this.#templates, "workspace");
    if (!this.#isDirectory(templateDirectory)) return;
    const stamp = join(this.state, "agent-files.json");
    const known = readJsonObject(stamp);
    const files = new Map<string, Buffer>();
    const walk = (directory: string, prefix: string): void => {
      for (const entry of this.#listEntries(directory).sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      )) {
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
      try {
        this.#assertParentRealInside(destination, relativePath);
      } catch {
        delete known[relativePath];
        continue;
      }
      const digest = sha256Bytes(data);
      const link = lstatOrNull(destination);
      if (link?.isSymbolicLink()) continue;
      if (link && !link.isFile()) continue;
      // Compare the on-disk bytes, not the stamp's digest of the old template:
      // a version change must replace (and back up) a user-edited file.
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
      if (link?.isFile()) {
        this.#backupToTrash(
          `agent-files/${timeNs()}/${relativePath}`,
          readFileSync(destination),
        );
      }
      this.#write(destination, data);
      known[relativePath] = digest;
    }

    const present = new Set(files.keys());
    for (const relativePath of Object.keys(known)) {
      if (relativePath === "_version" || present.has(relativePath)) continue;
      const digest = known[relativePath];
      delete known[relativePath];
      if (typeof digest !== "string") continue;
      const destination = this.#relativeToRoot(relativePath);
      if (!destination) continue;
      try {
        this.#assertParentRealInside(destination, relativePath);
      } catch {
        continue;
      }
      const link = lstatOrNull(destination);
      if (!link || link.isSymbolicLink() || !link.isFile()) continue;
      if (sha256Bytes(readFileSync(destination)) !== digest) continue;
      this.#unlinkOptional(destination);
      let parent = dirname(destination);
      while (parent !== this.root) {
        const parentLink = lstatOrNull(parent);
        if (!parentLink || parentLink.isSymbolicLink()) break;
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
    const linksLink = lstatOrNull(links);
    let agentsSafe = true;
    try {
      this.#assertParentRealInside(join(this.root, ".agents", "skills", ".probe"), ".agents");
    } catch {
      agentsSafe = false;
    }
    if (linksLink?.isSymbolicLink() || !agentsSafe) {
      // Never create or clean links through a symlinked `.claude/skills` or
      // `.agents` directory.
      known["_version"] = this.#version;
      this.#write(stamp, JSON.stringify(known, null, 1));
      return;
    }
    for (const name of [...skills].sort()) {
      const link = join(links, name);
      if (existsNoFollow(link)) continue;
      this.#ensureDirectory(links, "skill links");
      const relativeTarget = `../../.agents/skills/${name}`;
      try {
        symlinkSync(relativeTarget, link, "dir");
      } catch {
        // Windows without Developer Mode: junction with an absolute target.
        if (process.platform === "win32") {
          try {
            symlinkSync(join(this.root, ".agents", "skills", name), link, "junction");
          } catch {
            this.#copyTree(join(this.root, ".agents", "skills", name), link);
          }
        } else {
          this.#copyTree(join(this.root, ".agents", "skills", name), link);
        }
      }
    }
    if (this.#isDirectory(links)) {
      for (const entry of this.#listEntries(links)) {
        const link = join(links, entry.name);
        const statValue = lstatOrNull(link);
        if (!statValue?.isSymbolicLink() || existsSync(link)) continue;
        try {
          this.#assertParentRealInside(link, entry.name);
          const target = readlinkSync(link).replaceAll("\\", "/");
          const relativeTarget = `../../.agents/skills/${entry.name}`;
          const absoluteTarget = join(this.root, ".agents", "skills", entry.name).replaceAll("\\", "/");
          if (target === relativeTarget || target === absoluteTarget) this.#unlinkOptional(link);
        } catch {
          // Leave links we cannot inspect alone.
        }
      }
    }
    known["_version"] = this.#version;
    this.#write(stamp, JSON.stringify(known, null, 1));
  }

  #backupToTrash(relativePath: string, data: Buffer): void {
    const destination = join(this.state, "trash", relativePath);
    this.#write(destination, data);
  }

  #ensurePortable(): void {
    // PENDING: compiler provisioning and the generated CLI are not bundled.
    // The README below deliberately does not advertise a command that is not
    // available yet.
    const compiler = join(this.state, "compiler");
    this.#ensureDirectory(compiler, "compiler");
    for (const readme of [join(this.root, "README.md"), join(compiler, "README.md")]) {
      const current = readIfFile(readme);
      const untouchedOld = Boolean(current && OLD_PORTABLE_READMES.has(sha256Bytes(current)));
      if (current && !untouchedOld) continue;
      if (current) this.#backupToTrash(`portable/${timeNs()}/${basename(readme)}`, current);
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

function normalizeForCompare(text: string): string {
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n?/gu, "\n");
}

function isIgnoredDeckFile(name: string): boolean {
  if (name === ".DS_Store") return true;
  if (process.platform !== "win32") return name.endsWith(".html") || name.endsWith(".pdf");
  const lower = name.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".pdf");
}

// ---------------------------------------------------------------- BibTeX
//
// This is a conservative port of `.reference/parity/bibliography.py`. The core
// worker owns the full `legacy-bibliography.ts`; until that module is wired we
// keep the exact entry splitter/merge here so no local file can be deleted
// after an ambiguous parse. When `legacy-bibliography.ts` lands these helpers
// can be replaced by its `entries`/`merge` imports without changing callers.

function bibEntries(text: string): Array<[string | null, string]> {
  const result: Array<[string | null, string]> = [];
  let position = 0;
  const pattern = /@([\p{L}\p{N}_-]+)\s*([({])/gu;
  const nextEntry = (start: number): RegExpExecArray | null => {
    pattern.lastIndex = start;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
      if (text.slice(lineStart, match.index).includes("%")) {
        const newline = text.indexOf("\n", pattern.lastIndex);
        if (newline < 0) return null;
        pattern.lastIndex = newline + 1;
        continue;
      }
      return match;
    }
    return null;
  };

  let first = nextEntry(position);
  while (first) {
    const match = first;
    if (text.slice(position, match.index).trim()) {
      result.push([null, text.slice(position, match.index).trim()]);
    }
    const opening = match[2]!;
    let depth = 1;
    let quoted = false;
    let escaped = false;
    let brace = 0;
    let index = pattern.lastIndex;
    while (index < text.length) {
      const character = text[index]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"' && (opening === "{" ? depth === 1 : brace === 0)) quoted = !quoted;
      else if (!quoted) {
        if (opening === "{") {
          if (character === "{") depth += 1;
          else if (character === "}") depth -= 1;
        } else {
          if (character === "{") brace += 1;
          else if (character === "}") brace -= 1;
          else if (character === ")" && brace === 0) depth -= 1;
        }
      }
      index += 1;
      if (depth === 0) break;
    }
    if (depth !== 0) throw new Error("BibTeX");
    const raw = text.slice(match.index, index).trim();
    const kind = match[1]!.toLowerCase();
    const body = text.slice(match.index + match[0].length, index - 1);
    let key: string | null;
    if (kind === "comment" || kind === "preamble") {
      key = null;
    } else if (kind === "string") {
      const macro = /^\s*([^=\s]+)\s*=/u.exec(body);
      if (!macro) throw new Error("BibTeX");
      key = `@string:${macro[1]!.toLowerCase()}`;
    } else {
      const keyMatch = /^\s*([^,\s]+)\s*,/u.exec(body);
      if (!keyMatch) throw new Error("BibTeX");
      key = keyMatch[1]!;
    }
    result.push([key, raw]);
    position = index;
    first = nextEntry(position);
  }
  if (text.slice(position).trim()) result.push([null, text.slice(position).trim()]);
  return result;
}

function bibFields(raw: string): Array<[string, string]> {
  const output: Array<[string, string]> = [];
  let index = raw.indexOf(",") + 1;
  const end = raw.length - 1;
  while (index < end) {
    while (index < end && (/\s/u.test(raw[index]!) || raw[index] === ",")) index += 1;
    if (index >= end) break;
    if (raw[index] === "%") {
      index = raw.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    const match = /^([\p{L}\p{N}_-]+)\s*=\s*/u.exec(raw.slice(index));
    if (!match) throw new Error("BibTeX");
    index += match[0].length;
    const valueStart = index;
    let depth = 0;
    let quote = false;
    let escape = false;
    while (index < end) {
      const character = raw[index]!;
      if (escape) escape = false;
      else if (character === "\\") escape = true;
      else if (character === '"' && depth === 0) quote = !quote;
      else if (!quote) {
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        else if (character === "," && depth === 0) break;
      }
      index += 1;
    }
    output.push([match[1]!.toLowerCase(), raw.slice(valueStart, index).trim()]);
    index += 1;
  }
  return output;
}

function bibIdentity(key: string | null, raw: string): unknown {
  if (key === null || key.startsWith("@string:")) return raw;
  const kind = /^@([\p{L}\p{N}_-]+)/u.exec(raw)?.[1]?.toLowerCase() ?? "";
  const valueIdentity = (value: string): [string, string] => {
    if (
      (value.startsWith("{") && value.endsWith("}"))
      || (value.startsWith('"') && value.endsWith('"'))
    ) {
      return ["literal", value.slice(1, -1)];
    }
    if (/^\p{Nd}+$/u.test(value)) return ["literal", value];
    return ["expression", value];
  };
  return [
    kind,
    bibFields(raw)
      .map(([name, value]) => [name, valueIdentity(value)] as const)
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
  ];
}

function mergeBibtexTexts(texts: string[]): string {
  const seen = new Map<string, string>();
  const output: string[] = [];
  const collisions = new Set<string>();
  for (const text of texts) {
    for (const [key, raw] of bibEntries(text)) {
      const content = JSON.stringify(bibIdentity(key, raw));
      if (key !== null && seen.has(key) && seen.get(key) !== content) collisions.add(key);
      if (key === null || !seen.has(key)) output.push(raw);
      if (key !== null) seen.set(key, content);
    }
  }
  if (collisions.size > 0) {
    throw new Error([...collisions].sort((left, right) => (left < right ? -1 : 1)).join(", "));
  }
  return `${output.join("\n\n")}${output.length > 0 ? "\n" : ""}`;
}

// ---------------------------------------------------------------- portable

const LEGACY_PORTABLE_README = `# スライドの保管フォルダ

このフォルダは、Slide Studio アプリなしでも編集・再ビルドできます。フォルダ名と置き場所は自由です。共有する際は、隠しフォルダ \`.slide-studio/\` も含めてフォルダ全体をコピーしてください。

- \`decks/<発表名>/slides.qmd\`：原稿。テキストエディタで編集できます。
- \`decks/<発表名>/styles/\`：発表のスタイル。
- \`topics/<トピック>/\`：共有する \`html/\`・\`images/\`・\`reference.bib\`。\`themes/\`：テーマ。
- \`.slide-studio/compiler/\`：このフォルダ用に同梱した変換コード・Lua・スタイル・ランタイム。
- \`.slide-studio/runtime/\`：図が相対パスで読み込む共通コード。

## コンパイル

Python 3.13 以上と \`uv\` を用意し、ターミナルでこのフォルダに移動して実行します。初回は依存パッケージの取得にネットワークが必要です。Slide Studio のリポジトリ・インストールは不要です。

\`\`\`sh
uv run build.py --list
uv run build.py 発表名 --html-only
\`\`\`

検査して HTML と PDF を生成するには、初回に Chromium を準備します。

\`\`\`sh
uv run build.py --setup
uv run build.py 発表名
\`\`\`

出力は \`decks/<発表名>/<発表名>.html\` と \`.pdf\`。HTML はアニメーションを含む単一ファイルで、アプリなし・オフラインでブラウザで開けます。\`--html-only\` は検査を省略します。PDF は各ページの各 step の動きが終わった状態を1枚ずつ出力します。アニメーションの途中のフレームは含めません。

依存パッケージと Chromium の準備後は、外部素材を含まない原稿をオフラインでビルドできます。QMD の図参照などは同梱の変換コードが処理するため、Pandoc 単体での実行では同じ結果になりません。
`;

/** Hash-pinned Python-era READMEs. Pinned by content so a template change cannot orphan them. */
export const OLD_PORTABLE_READMES = new Set<string>([sha256Bytes(LEGACY_PORTABLE_README)]);
try {
  // The bundled asset is also recognised while the pinned copy above remains
  // authoritative after the asset is changed or removed.
  OLD_PORTABLE_READMES.add(
    sha256Bytes(readFileSync(assetPath("templates", "portable", "README.md"))),
  );
} catch {
  // Asset-less test runs keep only the pinned hash.
}

const PORTABLE_README = `# スライドの保管フォルダ

このフォルダは Slide Studio で編集・再ビルドできます。フォルダ名と置き場所は自由です。共有する際は、隠しフォルダ \`.slide-studio/\` も含めてフォルダ全体をコピーしてください。

- \`decks/<発表名>/slides.qmd\`：原稿。テキストエディタで編集できます。
- \`decks/<発表名>/styles/\`：発表のスタイル。
- \`topics/<トピック>/\`：共有する \`html/\`・\`images/\`・\`reference.bib\`。\`themes/\`：テーマ。
- \`.slide-studio/runtime/\`：図が相対パスで読み込む共通コード。

## 書き出し

Slide Studio のアプリ画面から HTML と PDF を書き出します。コマンドラインからの書き出しは準備中です。このフォルダに含まれる原稿・図・テーマは、アプリを入れていない環境でもテキストエディタで編集できます。
`;
