/**
 * Faithful TypeScript port of the legacy `history.style` route plus the
 * `deckstyle.py` spacing helpers it uses.
 *
 * Both files are version-checked before either is written. A conflict must
 * leave the deck source and `styles/slides.css` untouched.
 *
 * Deck text uses the same byte-level encoding adapter as the source route:
 * one version is `sha256(bytes)`, and BOM/CRLF are preserved across saves.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Workspace } from "../../packages/core/src/legacy-workspace.js";
import { isInsideRoot } from "../../packages/core/src/paths.js";
import {
  decodeDeckBytes,
  encodeSourceForDeck,
  sha256,
} from "../../packages/core/src/source.js";

export class Conflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Conflict";
  }
}

/** A file that cannot be decoded as UTF-8, or a source that cannot be re-encoded. */
export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodingError";
  }
}

const MARK = "/* Slide Studio の余白（画面から変更） */";
const SELECTOR = ".reveal .slides section.slide";
const NAMES = new Set(["--img-pad", "--fig-pad", "--gutter"]);
const VALUE = /^\d+(?:\.\d+)?px(?: \d+(?:\.\d+)?px){0,3}$/u;
const BLOCK = new RegExp(
  `${MARK.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n${SELECTOR.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\{([^{}]*)\\}\\n?`,
  "u",
);

export function read_vars(css: string): Record<string, string> {
  const match = BLOCK.exec(css);
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const declaration of (match[1] ?? "").split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const key = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    values[key] = value;
  }
  return values;
}

export function set_vars(
  css: string,
  values: Record<string, string | null | undefined>,
): string {
  for (const [key, value] of Object.entries(values)) {
    if (!NAMES.has(key) || (value !== null && (typeof value !== "string" || !VALUE.test(value)))) {
      throw new Error(`余白の値が正しくありません: ${key}`);
    }
  }
  const current = read_vars(css);
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete current[key];
    else current[key] = value as string;
  }
  const block = Object.keys(current).length > 0
    ? `${MARK}\n${SELECTOR}{${Object.entries(current).map(([key, value]) => `${key}:${value}`).join(";")}}\n`
    : "";
  const match = BLOCK.exec(css);
  if (match) {
    return `${css.slice(0, match.index)}${block}${css.slice(match.index + match[0].length)}`;
  }
  if (!block) return css;
  return `${css}${!css || css.endsWith("\n") ? "" : "\n"}${block}`;
}

function atomicWriteBytes(path: string, data: Buffer, mode: number): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    try {
      chmodSync(temporary, mode);
    } catch {
      // Windows may not support every mode bit; the replacement is still atomic.
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
      // The temporary file may not exist.
    }
    throw error;
  }
}

function atomicWrite(path: string, text: string): void {
  let mode = 0o666 & ~process.umask();
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing?.isFile()) mode = existing.mode & 0o777;
  atomicWriteBytes(path, Buffer.from(text, "utf8"), mode);
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new EncodingError(`${label} が UTF-8 ではありません`);
  }
}

/** Python's text-mode read uses universal newlines. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

export interface StyleSourceSnapshot {
  text: string;
  version: string;
  bytes: Buffer;
  bom: boolean;
  eol: "lf" | "crlf" | "mixed";
}

/** Source adapter used so style saves use the same version and encoding as the source route. */
export interface StyleSourceAdapter {
  read(): StyleSourceSnapshot;
  write(text: string, snapshot: StyleSourceSnapshot): { version: string };
}

export function sourceAdapter(workspace: Workspace, deck: string): StyleSourceAdapter {
  const path = workspace.qmd(deck);
  return {
    read(): StyleSourceSnapshot {
      const bytes = readFileSync(path);
      const encoding = decodeDeckBytes(bytes);
      if (!encoding.validUtf8) {
        throw new EncodingError("原稿が UTF-8 ではありません");
      }
      if (encoding.doubleBom) {
        throw new EncodingError("原稿の先頭に BOM が重複しています");
      }
      if (encoding.eol === "mixed") {
        throw new EncodingError("原稿の改行コードが混在しているため保存できません");
      }
      return {
        text: encoding.source,
        version: sha256(bytes),
        bytes,
        bom: encoding.bom,
        eol: encoding.eol,
      };
    },
    write(text: string, snapshot: StyleSourceSnapshot): { version: string } {
      let encoded: Buffer;
      try {
        encoded = encodeSourceForDeck(text, { bom: snapshot.bom, eol: snapshot.eol });
      } catch (error) {
        throw new EncodingError(
          error instanceof Error ? error.message : "原稿を保存できません",
        );
      }
      const link = lstatSync(path, { throwIfNoEntry: false });
      if (!link || link.isSymbolicLink() || !link.isFile()) {
        throw new Error("slides.qmd がファイルではありません");
      }
      atomicWriteBytes(path, encoded, link.mode & 0o777);
      return { version: sha256(encoded) };
    },
  };
}

function cssPath(workspace: Workspace, deck: string): string {
  const deckDirectory = workspace.deck_dir(deck);
  const directory = join(deckDirectory, "styles");
  const link = lstatSync(directory, { throwIfNoEntry: false });
  if (link) {
    if (link.isSymbolicLink()) throw new Error("styles はシンボリックリンクにできません");
    if (!link.isDirectory()) throw new Error("styles がフォルダではありません");
    const real = realpathSync(directory);
    if (!isInsideRoot(realpathSync(deckDirectory), real)) {
      throw new Error("styles が発表の外を指しています");
    }
  }
  const path = join(directory, "slides.css");
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file?.isSymbolicLink()) throw new Error("slides.css はシンボリックリンクにできません");
  if (file && !file.isFile()) throw new Error("slides.css がファイルではありません");
  return path;
}

function readCss(path: string): string | null {
  const link = lstatSync(path, { throwIfNoEntry: false });
  if (!link) return null;
  if (link.isSymbolicLink()) throw new Error("slides.css はシンボリックリンクにできません");
  if (!link.isFile()) throw new Error("slides.css がファイルではありません");
  return normalizeNewlines(decodeUtf8(readFileSync(path), "slides.css"));
}

function removeCss(path: string): void {
  const link = lstatSync(path, { throwIfNoEntry: false });
  if (!link) return;
  if (link.isSymbolicLink()) throw new Error("slides.css はシンボリックリンクにできません");
  if (link.isFile()) unlinkSync(path);
}

export interface StyleResult {
  before: string | null;
  css: string | null;
  text: string;
  version: string;
  vars: Record<string, string>;
}

/** `history.style(ws, deck, body)` from the legacy Python service. */
export function style(
  workspace: Workspace,
  deck: string,
  body: Record<string, unknown>,
  source: StyleSourceAdapter = sourceAdapter(workspace, deck),
): StyleResult {
  const path = cssPath(workspace, deck);
  const before = readCss(path);
  const snapshot = source.read();

  let after: string | null;
  if (Object.prototype.hasOwnProperty.call(body, "css")) {
    if ((body.css_base ?? null) !== before) throw new Conflict("外で変更されました");
    const requested = body.css;
    if (requested === null) after = null;
    else if (typeof requested === "string") after = requested;
    else throw new Error("操作が正しくありません");
  } else {
    const values = body.vars;
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("操作が正しくありません");
    }
    after = set_vars(before ?? "", values as Record<string, string | null | undefined>);
  }

  const result = Object.prototype.hasOwnProperty.call(body, "text") ? body.text : snapshot.text;
  if (typeof result !== "string") throw new Error("原稿がありません");
  if (
    Object.prototype.hasOwnProperty.call(body, "text")
    && body.base !== snapshot.version
  ) {
    throw new Conflict("外で変更されました");
  }

  let version = snapshot.version;
  if (after !== before) {
    if (after === null) removeCss(path);
    else atomicWrite(path, after);
  }
  if (result !== snapshot.text) {
    version = source.write(result, snapshot).version;
  }

  return {
    before,
    css: after,
    text: result,
    version,
    vars: read_vars(after ?? ""),
  };
}
