/**
 * Faithful TypeScript port of the legacy `memo.py` helpers used by the server.
 *
 * A memo is `decks/<deck>/memo.md`. It is deliberately not part of the render
 * input, so writing it must never trigger a slide re-render.
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
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DIV_CLOSE,
  DIV_OPEN,
  IMAGE_LINE,
  fig_args,
  parse,
  type Chunk,
} from "../../packages/core/src/legacy-source.js";
import {
  StudioError,
  TEMPLATES,
  type Workspace,
} from "../../packages/core/src/legacy-workspace.js";
import { decodeDeckBytes, sha256 } from "../../packages/core/src/source.js";

const ATTRS = String.raw`\{\s*(?:[#.]|[\p{L}\p{M}\p{N}_-]+=)[^}]*\}`;
const SPAN = new RegExp(String.raw`\[([^\[\]]*)\]` + ATTRS, "gu");
const TAIL = new RegExp(String.raw`\s*` + ATTRS + String.raw`\s*$`, "u");

export class MemoConflict extends StudioError {
  constructor(readonly current: MemoReadResult) {
    super("外で変更されました");
    this.name = "MemoConflict";
  }
}

export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodingError";
  }
}

export class MemoFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoFileError";
  }
}

export interface MemoReadResult {
  text: string;
  version: string;
  exists: boolean;
}

export interface MemoWriteResult {
  version: string;
}

export function rel(deck: string): string {
  return `decks/${deck}/memo.md`;
}

function slicePoints(points: readonly string[], start: number, end: number): string {
  return points.slice(start, end).join("");
}

/** Python's text-mode read uses universal newlines. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new EncodingError(`${label} が UTF-8 ではありません`);
  }
}

function readMemoFile(path: string): string {
  const link = lstatSync(path, { throwIfNoEntry: false });
  if (!link) return "";
  if (link.isSymbolicLink()) throw new MemoFileError("memo.md はシンボリックリンクにできません");
  if (!link.isFile()) throw new MemoFileError("memo.md がファイルではありません");
  return normalizeNewlines(decodeUtf8(readFileSync(path), "memo.md"));
}

function atomicWriteText(path: string, text: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new MemoFileError("memo.md はシンボリックリンクにできません");
  if (existing && !existing.isFile()) throw new MemoFileError("memo.md がファイルではありません");
  const mode = existing?.isFile() ? existing.mode & 0o777 : 0o666 & ~process.umask();
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, text, "utf8");
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

function plain(block: string): string {
  let value = block.trim();
  const figure = fig_args(value);
  if (figure) return `html-${figure.ref!.split("/").at(-1)!}`;
  if (IMAGE_LINE.test(value)) return value.replace(TAIL, "");
  let count = 1;
  while (count > 0) {
    const next = value.replace(SPAN, "$1");
    count = next === value ? 0 : 1;
    value = next;
  }
  return value
    .split("\n")
    .map((line) => (line.startsWith("#") ? line.replace(TAIL, "") : line))
    .join("\n");
}

function* blocks(
  points: readonly string[],
  chunks: Chunk[],
  skip: ReadonlySet<string>,
): Generator<string> {
  for (const chunk of chunks) {
    const raw = slicePoints(points, chunk.start, chunk.end);
    if (chunk.container) {
      yield* blocks(points, chunk.children, skip);
    } else if (chunk.kind === "opaque") {
      if (chunk.open && !(chunk.attrs?.classes.includes("notes") ?? false)) {
        const inner = raw
          .split("\n")
          .filter((line) => !DIV_OPEN.test(line) && !DIV_CLOSE.test(line))
          .join("\n");
        for (const piece of inner.split(/\n[ \t]*\n/u)) {
          let block = plain(piece);
          if (!block) continue;
          if (
            (chunk.attrs?.classes.includes("footnote-small") ?? false)
            && !block.startsWith("＊")
          ) {
            block = `＊${block}`;
          }
          yield block;
        }
      }
    } else if (!skip.has(raw.trim())) {
      yield plain(raw);
    }
  }
}

export function from_slides(workspace: Workspace, deck: string): string {
  const blank = parse(readFileSync(join(TEMPLATES, "deck", "slides.qmd"), "utf8"));
  const blankPoints = Array.from(blank.text);
  const skip = new Set<string>();
  for (const page of blank.pages) {
    for (const chunk of page.walk()) {
      if (chunk.kind === "text") {
        skip.add(slicePoints(blankPoints, chunk.start, chunk.end).trim());
      }
    }
  }

  const bytes = readFileSync(workspace.qmd(deck));
  const encoding = decodeDeckBytes(bytes);
  if (!encoding.validUtf8) throw new EncodingError("原稿が UTF-8 ではありません");
  const document = parse(encoding.source);
  const points = Array.from(document.text);
  let found = false;
  const pages: string[] = [];
  for (const page of document.pages) {
    if (page.attrs.classes.includes("cover") || page.generated) continue;
    const body = [...blocks(points, page.chunks, skip)];
    found ||= body.length > 0;
    pages.push([`## ${page.title}`, ...body].join("\n\n"));
  }
  return found ? `${pages.join("\n\n")}\n` : "";
}

export function read(workspace: Workspace, deck: string): MemoReadResult {
  workspace.require_deck(deck);
  const path = workspace.memo(deck);
  const link = lstatSync(path, { throwIfNoEntry: false });
  const exists = Boolean(link?.isFile());
  const text = readMemoFile(path);
  return { text, version: sha256(text), exists };
}

export function write(
  workspace: Workspace,
  deck: string,
  text: string,
  base: unknown,
): MemoWriteResult {
  const current = read(workspace, deck);
  if (base !== current.version) throw new MemoConflict(current);
  if (text !== current.text || !current.exists) {
    atomicWriteText(workspace.memo(deck), text);
  }
  return { version: sha256(text) };
}

/** Result shape used by the server when a memo belongs to no existing deck. */
export function absent(): MemoReadResult {
  return { text: "", version: sha256(""), exists: false };
}
