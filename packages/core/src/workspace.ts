import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  DeckDocument,
  DeckSummary,
  Diagnostic,
  OpenWorkspaceOptions,
  PreviewDocument,
  WorkspaceService,
} from "../../contracts/src/desktop.js";
import { atomicWriteFile } from "./atomic.js";
import { assetPath } from "./assets.js";
import { CoreError, isNodeError } from "./errors.js";
import { acquireWorkspaceLock, releaseWorkspaceLock } from "./lock.js";
import { KeyedMutex } from "./mutex.js";
import { PandocRunner } from "./pandoc.js";
import {
  assertAbsoluteRoot,
  assertSafeDeckId,
  canonicalRoot,
  deckSourceFile,
  generatedDeckId,
  optionalFileInside,
  safeTitle,
} from "./paths.js";
import { assemblePreview, prepareSource } from "./render.js";
import type { CuratedMetadata } from "./source.js";
import {
  MAX_SOURCE_BYTES,
  normalizeSource,
  readDeckDocument,
  saveDeckDocument,
  sha256,
} from "./source.js";

function markdownText(value: string): string {
  return value.replace(/([\\`*_{}[\]<>#|])/gu, "\\$1");
}

function starterSource(title: string): string {
  const quoted = JSON.stringify(title);
  const shown = markdownText(title);
  return `---
title: ${quoted}
pagetitle: ${quoted}
lang: ja
---

## ${shown} {#cover .cover}

::: {.cover-title}
${shown}
:::

# はじめに

## 最初のスライド {#first}

- ここに要点を書きます
- もう一つの要点を書きます
- 必要なら箇条書きを増やします

::: {.lead}
補足や説明をここに書きます。
:::

| 項目 | 内容 |
|---|---|
| 例 | 値 |

$$
a^2 + b^2 = c^2
$$
`;
}

async function removeStalePandocDirectories(stateDirectory: string): Promise<void> {
  const entries = await readdir(stateDirectory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.name.startsWith("pandoc-"))
    .map((entry) => rm(join(stateDirectory, entry.name), { recursive: true, force: true })
      .catch(() => undefined)));
}

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      throw new CoreError("INVALID_INPUT", `${label} may not be a symbolic link`);
    }
    if (!entry.isDirectory()) {
      throw new CoreError("INVALID_INPUT", `${label} is not a directory`);
    }
  } catch (error) {
    if (error instanceof CoreError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      try {
        await mkdir(path);
      } catch (mkdirError) {
        if (isNodeError(mkdirError) && mkdirError.code === "EEXIST") {
          const existing = lstatSync(path);
          if (existing.isSymbolicLink()) {
            throw new CoreError("INVALID_INPUT", `${label} may not be a symbolic link`);
          }
          if (!existing.isDirectory()) {
            throw new CoreError("INVALID_INPUT", `${label} is not a directory`);
          }
          return;
        }
        throw new CoreError("INVALID_INPUT", `cannot create ${label}: ${String(mkdirError)}`);
      }
      return;
    }
    throw new CoreError("INVALID_INPUT", `cannot inspect ${label}: ${String(error)}`);
  }
}

function metadataArguments(meta: CuratedMetadata): string[] {
  const args: string[] = [];
  const add = (key: string, value: string): void => {
    args.push("--metadata", `${key}=${value}`);
  };
  if (meta.title) add("title", meta.title);
  if (meta.pagetitle) add("pagetitle", meta.pagetitle);
  add("lang", meta.lang);
  for (const author of meta.authors) add("author", author);
  return args;
}

function mapPandocLine(message: string, removedLines: number): string {
  return message.replace(/\bline (\d+)\b/gu, (_match, value: string) => {
    return `line ${Number.parseInt(value, 10) + removedLines}`;
  });
}

function withReferencePlaceholder(body: string): string {
  const referencesHeading = /^ {0,3}#{1,6}[ \t]+.*\{[^}\n]*#references[^}\n]*\}[ \t]*$/mu;
  if (!referencesHeading.test(body)) return body;
  if (/\{[^}\n]*#refs(?:[}\s])/u.test(body) || /id=["']refs["']/u.test(body)) return body;
  return `${body}\n\n::: {#refs}\n:::\n`;
}

function pandocWarnings(stderr: string, removedLines: number): Diagnostic[] {
  const warnings: Diagnostic[] = [];
  for (const line of stderr.split(/\r?\n/u)) {
    const message = line.trim();
    if (!message) continue;
    const missingCitation = message.match(/Citeproc: citation (\S+) not found/u);
    if (missingCitation) {
      warnings.push({
        code: "MISSING_CITATION",
        severity: "warning",
        message: `Citation not found: ${missingCitation[1] ?? ""}`,
      });
      continue;
    }
    warnings.push({
      code: "PANDOC",
      severity: "warning",
      message: mapPandocLine(message, removedLines),
    });
  }
  return warnings;
}

export async function openWorkspace(
  rootInput: string,
  options: OpenWorkspaceOptions,
): Promise<WorkspaceService> {
  assertAbsoluteRoot(rootInput);
  const candidate = options as unknown as
    | { pandocPath?: unknown; sample?: unknown }
    | null
    | undefined;
  if (
    !candidate
    || typeof candidate.pandocPath !== "string"
    || !candidate.pandocPath
    || !isAbsolute(candidate.pandocPath)
  ) {
    throw new CoreError("INVALID_INPUT", "pandocPath must be an absolute native executable path");
  }
  if (candidate.sample !== undefined && typeof candidate.sample !== "boolean") {
    throw new CoreError("INVALID_INPUT", "sample must be a boolean");
  }
  const pandocPath = candidate.pandocPath;

  try {
    await mkdir(rootInput, { recursive: true });
  } catch (error) {
    throw new CoreError("INVALID_INPUT", `cannot create workspace root: ${String(error)}`);
  }
  const rootReal = canonicalRoot(rootInput);
  if (!statSync(rootReal).isDirectory()) {
    throw new CoreError("INVALID_INPUT", "workspace root is not a directory");
  }

  const decksDirectory = join(rootReal, "decks");
  const stateDirectory = join(rootReal, "state");
  await ensureDirectory(decksDirectory, "decks");
  await ensureDirectory(stateDirectory, "state");

  let lock: { token: string; path: string } | null = null;
  let temporaryDirectory: string | null = null;
  try {
    lock = await acquireWorkspaceLock(stateDirectory);
    await removeStalePandocDirectories(stateDirectory);
    temporaryDirectory = await mkdtemp(join(stateDirectory, "pandoc-"));
    const workspace = new Workspace(
      rootReal,
      decksDirectory,
      stateDirectory,
      lock,
      temporaryDirectory,
      pandocPath,
    );
    if (candidate.sample) {
      const decks = await workspace.listDecks();
      if (decks.length === 0) await workspace.createDeck("サンプル発表");
    }
    return workspace;
  } catch (error) {
    if (lock) await releaseWorkspaceLock(lock.path, lock.token);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

class Workspace implements WorkspaceService {
  readonly root: string;
  readonly #decksDirectory: string;
  readonly #stateDirectory: string;
  readonly #lock: { token: string; path: string };
  readonly #temporaryDirectory: string;
  readonly #mutex = new KeyedMutex();
  readonly #runner: PandocRunner;
  readonly #pending = new Set<Promise<unknown>>();
  #renderTail: Promise<void> = Promise.resolve();
  #closing: Promise<void> | null = null;
  #closed = false;

  constructor(
    rootReal: string,
    decksDirectory: string,
    stateDirectory: string,
    lock: { token: string; path: string },
    temporaryDirectory: string,
    pandocPath: string,
  ) {
    this.root = rootReal;
    this.#decksDirectory = decksDirectory;
    this.#stateDirectory = stateDirectory;
    this.#lock = lock;
    this.#temporaryDirectory = temporaryDirectory;
    this.#runner = new PandocRunner({
      pandocPath,
      luaFilter: assetPath("lua", "slide-studio.lua"),
      csl: assetPath("runtime", "numeric.csl"),
      dataDirectory: join(temporaryDirectory, "data"),
      temporaryDirectory,
    });
  }

  async listDecks(): Promise<DeckSummary[]> {
    this.#assertOpen();
    return this.#track(this.#listDecks());
  }

  async createDeck(title: string): Promise<DeckDocument> {
    this.#assertOpen();
    return this.#track(this.#createDeck(title));
  }

  async readDeck(id: string): Promise<DeckDocument> {
    this.#assertOpen();
    assertSafeDeckId(id);
    const file = deckSourceFile(this.root, id);
    return this.#track(this.#mutex.run(file.file, () => readDeckDocument(this.root, id)));
  }

  async saveDeck(id: string, source: string, expectedVersion: string): Promise<DeckDocument> {
    this.#assertOpen();
    assertSafeDeckId(id);
    return this.#track(saveDeckDocument(this.root, id, source, expectedVersion, this.#mutex));
  }

  async #listDecks(): Promise<DeckSummary[]> {
    const entries = await readdir(this.#decksDirectory, { withFileTypes: true });
    const decks: DeckSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const document = await readDeckDocument(this.root, entry.name);
        decks.push({
          id: document.id,
          title: document.title,
          updatedAt: document.updatedAt,
        });
      } catch {
        // Invalid, missing, or symlinked decks are not advertised.
      }
    }
    decks.sort((left, right) => left.id.localeCompare(right.id));
    return decks;
  }

  async #createDeck(title: string): Promise<DeckDocument> {
    const safe = safeTitle(title);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = generatedDeckId(() => randomUUID());
      assertSafeDeckId(id);
      const directory = join(this.#decksDirectory, id);
      try {
        await mkdir(directory);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") continue;
        throw new CoreError("INVALID_INPUT", `cannot create deck folder: ${String(error)}`);
      }
      try {
        const file = join(directory, "slides.qmd");
        await atomicWriteFile(file, starterSource(safe), 0o644);
        return await readDeckDocument(this.root, id);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        if (error instanceof CoreError) throw error;
        throw new CoreError("INVALID_INPUT", `cannot create deck: ${String(error)}`);
      }
    }
    throw new CoreError("INVALID_INPUT", "cannot allocate a unique deck id");
  }

  async renderDeck(id: string, source?: string): Promise<PreviewDocument> {
    this.#assertOpen();
    assertSafeDeckId(id);
    if (source !== undefined && typeof source !== "string") {
      throw new CoreError("INVALID_INPUT", "source must be a string");
    }
    if (source !== undefined && Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
      throw new CoreError("INVALID_INPUT", "deck source exceeds the 2 MiB limit");
    }

    const document = await this.readDeck(id);
    const text = source === undefined ? document.source : source;
    const prepared = prepareSource(text);
    const version = source === undefined || normalizeSource(source) === document.source
      ? document.version
      : sha256(Buffer.from(source, "utf8"));
    const directory = deckSourceFile(this.root, id).directory;

    const extraArguments = metadataArguments(prepared.meta);
    extraArguments.push("--resource-path", directory);
    const bibliography = optionalFileInside(this.root, join(directory, "reference.bib"));
    if (bibliography) extraArguments.push("--bibliography", bibliography);

    return this.#enqueueRender(async () => {
      let rendered: { stdout: string; stderr: string };
      try {
        rendered = await this.#runner.run(withReferencePlaceholder(prepared.body), directory, extraArguments);
      } catch (error) {
        if (error instanceof CoreError) throw error;
        throw new CoreError("RENDER_FAILED", `render failed: ${String(error)}`);
      }
      const warnings = [...prepared.warnings, ...pandocWarnings(rendered.stderr, prepared.removedLines)];
      try {
        return assemblePreview({
          rootReal: this.root,
          deckId: id,
          deckDirectory: directory,
          meta: prepared.meta,
          pandocHtml: rendered.stdout,
          version,
          warnings,
        });
      } catch (error) {
        if (error instanceof CoreError) throw error;
        throw new CoreError("RENDER_FAILED", `cannot assemble preview: ${String(error)}`);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await this.#runner.close();
      await this.#renderTail.catch(() => undefined);
      await Promise.allSettled([...this.#pending]);
      await releaseWorkspaceLock(this.#lock.path, this.#lock.token);
      await rm(this.#temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    })();
    return this.#closing;
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    void promise.finally(() => {
      this.#pending.delete(promise);
    }).catch(() => undefined);
    return promise;
  }

  #assertOpen(): void {
    if (this.#closed) throw new CoreError("BUSY", "workspace is closed");
  }

  #enqueueRender<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#renderTail.then(async () => {
      this.#assertOpen();
      if (!existsSync(this.#stateDirectory)) {
        throw new CoreError("BUSY", "workspace state is unavailable");
      }
      return operation();
    });
    this.#renderTail = next.then(() => undefined, () => undefined);
    return next;
  }
}
