import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CoreError, isNodeError } from "./errors.js";

const MAX_DECK_ID_LENGTH = 120;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const PATH_SEPARATOR = /[\\/]/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;

export function assertAbsoluteRoot(root: string): void {
  if (typeof root !== "string" || !root || !isAbsolute(root)) {
    throw new CoreError("INVALID_INPUT", "workspace root must be an explicit absolute path");
  }
}

/** Real path used for every workspace boundary comparison. */
export function canonicalRoot(root: string): string {
  assertAbsoluteRoot(root);
  try {
    return realpathSync.native(root);
  } catch (error) {
    throw new CoreError("INVALID_INPUT", `cannot resolve workspace root: ${String(error)}`);
  }
}

export function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const rel = relative(rootReal, candidateReal);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function assertInsideRoot(rootReal: string, candidateReal: string, label: string): void {
  if (!isInsideRoot(rootReal, candidateReal)) {
    throw new CoreError("OUTSIDE_ROOT", `refusing to access outside the workspace root: ${label}`);
  }
}

/** Resolve an existing file and re-check it against the canonical root. */
export function resolveExistingInside(rootReal: string, candidate: string, label: string): string {
  let real: string;
  try {
    real = realpathSync.native(candidate);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new CoreError("NOT_FOUND", `${label} was not found`);
    }
    throw new CoreError("INVALID_INPUT", `cannot resolve ${label}: ${String(error)}`);
  }
  assertInsideRoot(rootReal, real, label);
  return real;
}

export function assertSafeDeckId(id: string): void {
  if (
    typeof id !== "string"
    || id.length === 0
    || id.length > MAX_DECK_ID_LENGTH
    || id === "."
    || id === ".."
    || id.startsWith(".")
    || id.endsWith(".")
    || id.endsWith(" ")
    || id.includes(":")
    || PATH_SEPARATOR.test(id)
    || CONTROL_CHARACTER.test(id)
    || WINDOWS_RESERVED.test(id.split(".", 1)[0] ?? "")
  ) {
    throw new CoreError("INVALID_INPUT", "invalid deck id");
  }
}

/** Safe generated ids are ASCII, never derived directly from user titles. */
export function generatedDeckId(random: () => string): string {
  const suffix = random().toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 20);
  return `deck-${Date.now().toString(36)}-${suffix || "new"}`;
}

export function safeTitle(value: unknown, fallback = "無題の発表"): string {
  if (typeof value !== "string") return fallback;
  const title = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return (title || fallback).slice(0, 240);
}

export function deckDirectory(rootReal: string, id: string): string {
  assertSafeDeckId(id);
  const candidate = join(rootReal, "decks", id);
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(candidate);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new CoreError("NOT_FOUND", `deck not found: ${id}`);
    }
    throw new CoreError("INVALID_INPUT", `cannot inspect deck: ${String(error)}`);
  }
  if (link.isSymbolicLink()) {
    let target: string | null = null;
    try {
      target = realpathSync.native(candidate);
    } catch {
      // A broken symlink is still an invalid deck.
    }
    if (target && !isInsideRoot(rootReal, target)) {
      throw new CoreError("OUTSIDE_ROOT", `deck path escapes the workspace root: ${id}`);
    }
    throw new CoreError("INVALID_INPUT", "deck directories may not be symbolic links");
  }
  if (!link.isDirectory()) {
    throw new CoreError("NOT_FOUND", `deck not found: ${id}`);
  }
  const real = resolveExistingInside(rootReal, candidate, `deck ${id}`);
  if (!statSync(real).isDirectory()) throw new CoreError("NOT_FOUND", `deck not found: ${id}`);
  return real;
}

export interface DeckFile {
  directory: string;
  file: string;
  mode: number;
  mtime: Date;
}

export function deckSourceFile(rootReal: string, id: string): DeckFile {
  const directory = deckDirectory(rootReal, id);
  const candidate = join(directory, "slides.qmd");
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(candidate);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new CoreError("NOT_FOUND", `slides.qmd not found in deck: ${id}`);
    }
    throw new CoreError("INVALID_INPUT", `cannot inspect slides.qmd: ${String(error)}`);
  }
  if (link.isSymbolicLink()) {
    let target: string | null = null;
    try {
      target = realpathSync.native(candidate);
    } catch {
      // A broken symlink is still an invalid source file.
    }
    if (target && !isInsideRoot(rootReal, target)) {
      throw new CoreError("OUTSIDE_ROOT", "slides.qmd points outside the workspace root");
    }
    throw new CoreError("INVALID_INPUT", "slides.qmd may not be a symbolic link");
  }
  if (!link.isFile()) throw new CoreError("NOT_FOUND", `slides.qmd not found in deck: ${id}`);
  const file = resolveExistingInside(rootReal, candidate, "slides.qmd");
  const stat = statSync(file);
  return { directory, file, mode: stat.mode & 0o777, mtime: stat.mtime };
}

export function optionalFileInside(rootReal: string, candidate: string): string | null {
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(candidate);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw new CoreError("INVALID_INPUT", `cannot inspect optional file: ${String(error)}`);
  }
  if (link.isSymbolicLink()) {
    let target: string | null = null;
    try {
      target = realpathSync.native(candidate);
    } catch {
      // A broken symlink is still not a validated workspace file.
    }
    if (target && !isInsideRoot(rootReal, target)) {
      throw new CoreError("OUTSIDE_ROOT", "workspace file points outside the workspace root");
    }
    throw new CoreError("INVALID_INPUT", "optional workspace files may not be symbolic links");
  }
  if (!link.isFile()) return null;
  const real = resolveExistingInside(rootReal, candidate, "workspace file");
  return real;
}

/** Resolve a URL-ish local asset against a base directory and enforce the root boundary. */
export function resolveAssetInside(rootReal: string, baseDirectory: string, value: string): string {
  const withoutSuffix = value.split("#", 1)[0]?.split("?", 1)[0] ?? value;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    throw new CoreError("INVALID_INPUT", `invalid asset reference: ${value}`);
  }
  const candidate = isAbsolute(decoded) ? resolve(decoded) : resolve(baseDirectory, decoded);
  return resolveExistingInside(rootReal, candidate, value);
}

export function pathMode(mode: number): number {
  return mode & 0o777;
}
