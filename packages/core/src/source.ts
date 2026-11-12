import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { parseDocument } from "yaml";
import type { DeckDocument, Diagnostic } from "../../contracts/src/desktop.js";
import { atomicWriteFile } from "./atomic.js";
import { CoreError } from "./errors.js";
import type { KeyedMutex } from "./mutex.js";
import { deckSourceFile } from "./paths.js";

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const SOURCE_FILE = "slides.qmd";

export interface ParsedFrontMatter {
  body: string;
  yaml: string;
  meta: Record<string, unknown>;
  error?: string;
  /** Number of source lines removed before the body. */
  removedLines: number;
}

export interface CuratedMetadata {
  title?: string;
  pagetitle?: string;
  lang: string;
  authors: string[];
  theme: string;
  ignoredKeys: string[];
  metaError?: string;
}

export interface TextEncoding {
  bom: boolean;
  doubleBom: boolean;
  eol: "lf" | "crlf" | "mixed";
  validUtf8: boolean;
  source: string;
  diagnostics: Diagnostic[];
}

const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);
const RESOURCE_METADATA_KEYS = new Set([
  "bibliography",
  "csl",
  "filter",
  "filters",
  "include-before-body",
  "include-after-body",
  "header-includes",
  "resource-path",
  "defaults",
]);

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** UI source is always UTF-8 text with LF and no leading BOM. */
export function normalizeSource(source: string): string {
  const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  return withoutBom.replace(/\r\n?/gu, "\n");
}

export function decodeDeckBytes(bytes: Buffer): TextEncoding {
  const bom = bytes.length >= 3
    && bytes[0] === BOM_BYTES[0]
    && bytes[1] === BOM_BYTES[1]
    && bytes[2] === BOM_BYTES[2];
  const body = bom ? bytes.subarray(3) : bytes;
  let decoded = "";
  let validUtf8 = true;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    validUtf8 = false;
    decoded = new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
  }
  const doubleBom = decoded.startsWith("\uFEFF");

  const crlf = (decoded.match(/\r\n/gu) ?? []).length;
  const loneCr = (decoded.match(/\r(?!\n)/gu) ?? []).length;
  const loneLf = (decoded.match(/(?<!\r)\n/gu) ?? []).length;
  let eol: "lf" | "crlf" | "mixed";
  if (loneCr > 0 || (crlf > 0 && loneLf > 0)) eol = "mixed";
  else if (crlf > 0 && loneLf === 0) eol = "crlf";
  else eol = "lf";

  const diagnostics: Diagnostic[] = [];
  if (!validUtf8) {
    diagnostics.push({
      code: "INVALID_UTF8",
      severity: "error",
      message: "The deck source is not valid UTF-8 and is open read-only.",
    });
  }
  if (eol === "mixed") {
    diagnostics.push({
      code: "MIXED_EOL",
      severity: "warning",
      message: "The deck source mixes CRLF and LF line endings and is open read-only.",
    });
  }
  if (doubleBom) {
    diagnostics.push({
      code: "BOM",
      severity: "error",
      message: "The deck source contains a second leading BOM and is open read-only.",
    });
  }

  return {
    bom,
    doubleBom,
    eol,
    validUtf8,
    source: normalizeSource(decoded),
    diagnostics,
  };
}

export function encodeSourceForDeck(source: string, encoding: Pick<TextEncoding, "bom" | "eol">): Buffer {
  if (encoding.eol === "mixed") {
    throw new CoreError("READ_ONLY", "mixed line endings cannot be written safely");
  }
  const lf = normalizeSource(source);
  const text = encoding.eol === "crlf" ? lf.replace(/\n/gu, "\r\n") : lf;
  const body = Buffer.from(text, "utf8");
  return encoding.bom ? Buffer.concat([BOM_BYTES, body]) : body;
}

export function splitFrontMatter(text: string): ParsedFrontMatter {
  const lf = normalizeSource(text);
  const lines = lf.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { body: lf, yaml: "", meta: {}, removedLines: 0 };
  }
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && /^(?:---|\.\.\.)\s*$/u.test(line)) {
      close = index;
      break;
    }
  }
  if (close < 0) return { body: lf, yaml: "", meta: {}, removedLines: 0 };
  const yamlText = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  try {
    const document = parseDocument(yamlText, { prettyErrors: false });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((item) => item.message).join("; "));
    }
    const value = document.toJS({ maxAliasCount: 10 }) as unknown;
    if (value === null || value === undefined) {
      return { body, yaml: yamlText, meta: {}, removedLines: close + 1 };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      return {
        body,
        yaml: yamlText,
        meta: {},
        error: "front matter is not a mapping",
        removedLines: close + 1,
      };
    }
    return {
      body,
      yaml: yamlText,
      meta: value as Record<string, unknown>,
      removedLines: close + 1,
    };
  } catch (error) {
    return {
      body,
      yaml: yamlText,
      meta: {},
      error: `cannot read front matter: ${String(error)}`,
      removedLines: close + 1,
    };
  }
}

function cleanText(value: unknown, max = 400): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function authorName(value: unknown): string | undefined {
  if (typeof value === "string") return cleanText(value, 240);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return cleanText((value as Record<string, unknown>).name, 240);
  }
  return undefined;
}

/** Only title/pagetitle/lang/author/theme are allowed to reach the renderer. */
export function curateMetadata(meta: Record<string, unknown>): CuratedMetadata {
  const title = cleanText(meta.title);
  const pagetitle = cleanText(meta.pagetitle);
  const langValue = cleanText(meta.lang, 20);
  const lang = langValue && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*$/u.test(langValue) ? langValue : "ja";
  const authors: string[] = [];
  const rawAuthor = meta.author;
  const values = Array.isArray(rawAuthor) ? rawAuthor : rawAuthor === undefined ? [] : [rawAuthor];
  for (const value of values) {
    const name = authorName(value);
    if (name && !authors.includes(name)) authors.push(name);
  }
  const themeValue = cleanText(meta.theme, 60) ?? "default";
  const theme = /^[A-Za-z0-9_-]+$/u.test(themeValue) ? themeValue : "default";
  const ignoredKeys = Object.keys(meta).filter((key) => RESOURCE_METADATA_KEYS.has(key));
  return { title, pagetitle, lang, authors, theme, ignoredKeys };
}

export function titleOfMeta(meta: Record<string, unknown>, fallback: string): string {
  return cleanText(meta.title, 240) ?? cleanText(meta.pagetitle, 240) ?? fallback;
}

function documentFrom(
  id: string,
  title: string,
  updatedAt: string,
  bytes: Buffer,
  encoding: TextEncoding,
): DeckDocument {
  return {
    id,
    title,
    updatedAt,
    source: encoding.source,
    version: sha256(bytes),
    eol: encoding.eol,
    bom: encoding.bom,
    readOnly: !encoding.validUtf8 || encoding.eol === "mixed" || encoding.doubleBom,
    diagnostics: encoding.diagnostics,
  };
}

export async function readDeckDocument(rootReal: string, id: string): Promise<DeckDocument> {
  const file = deckSourceFile(rootReal, id);
  const statValue = await stat(file.file);
  if (statValue.size > MAX_SOURCE_BYTES) {
    throw new CoreError("INVALID_INPUT", "deck source exceeds the 2 MiB limit");
  }
  const bytes = await readFile(file.file);
  if (bytes.length > MAX_SOURCE_BYTES) {
    throw new CoreError("INVALID_INPUT", "deck source exceeds the 2 MiB limit");
  }
  const encoding = decodeDeckBytes(bytes);
  const parsed = splitFrontMatter(encoding.source);
  const title = titleOfMeta(parsed.meta, id);
  return documentFrom(id, title, statValue.mtime.toISOString(), bytes, encoding);
}

export async function saveDeckDocument(
  rootReal: string,
  id: string,
  source: string,
  expectedVersion: string,
  mutex: KeyedMutex,
): Promise<DeckDocument> {
  if (typeof source !== "string" || typeof expectedVersion !== "string") {
    throw new CoreError("INVALID_INPUT", "source and expectedVersion must be strings");
  }
  const initial = deckSourceFile(rootReal, id);
  return mutex.run(initial.file, async () => {
    const file = deckSourceFile(rootReal, id);
    if (file.file !== initial.file) {
      throw new CoreError("CONFLICT", "deck source changed while acquiring the save lock");
    }
    const statValue = await stat(file.file);
    if (statValue.size > MAX_SOURCE_BYTES) {
      throw new CoreError("INVALID_INPUT", "deck source exceeds the 2 MiB limit");
    }
    const currentBytes = await readFile(file.file);
    if (currentBytes.length > MAX_SOURCE_BYTES) {
      throw new CoreError("INVALID_INPUT", "deck source exceeds the 2 MiB limit");
    }
    const currentVersion = sha256(currentBytes);
    if (currentVersion !== expectedVersion) {
      throw new CoreError("CONFLICT", "deck source was changed by another editor", currentVersion);
    }

    const encoding = decodeDeckBytes(currentBytes);
    if (!encoding.validUtf8 || encoding.eol === "mixed" || encoding.doubleBom) {
      throw new CoreError("READ_ONLY", "deck source is open read-only");
    }

    const normalized = normalizeSource(source);
    if (normalized === encoding.source) {
      const parsed = splitFrontMatter(encoding.source);
      return documentFrom(
        id,
        titleOfMeta(parsed.meta, id),
        statValue.mtime.toISOString(),
        currentBytes,
        encoding,
      );
    }

    const encoded = encodeSourceForDeck(normalized, encoding);
    if (encoded.length > MAX_SOURCE_BYTES) {
      throw new CoreError("INVALID_INPUT", "deck source exceeds the 2 MiB limit");
    }
    try {
      await atomicWriteFile(file.file, encoded, file.mode);
    } catch (error) {
      throw new CoreError("INVALID_INPUT", `cannot save deck source: ${String(error)}`);
    }
    return readDeckDocument(rootReal, id);
  });
}
