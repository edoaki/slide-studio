import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isNodeError } from "./errors.js";
import { assertInsideRoot, isInsideRoot } from "./paths.js";
import {
  atomicWrite,
  decodeUtf8,
  existsNoFollow,
  isReadOnlyError,
  lstatOrNull,
  renameWithRetry,
  StudioError,
} from "./workspace-utils.js";

interface CopyOptions {
  ignore?: (directory: string, names: string[]) => string[];
}

export class WorkspaceFiles {
  constructor(readonly root: string) {}

  assertLexicalInside(path: string, label: string): void {
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

  assertParentRealInside(path: string, label: string): void {
    const parent = this.#nearestExisting(dirname(path));
    const real = realpathSync.native(parent);
    assertInsideRoot(this.root, real, label);
  }

  ensureDirectory(path: string, label: string): string {
    this.assertLexicalInside(path, label);
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
    if (parent !== path) this.ensureDirectory(parent, `${label} parent`);
    try {
      mkdirSync(path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw new StudioError(`cannot create ${label}: ${String(error)}`);
      }
    }
    return this.ensureDirectory(path, label);
  }

  entryIsDirectory(path: string): boolean {
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

  isDirectory(path: string): boolean {
    const link = lstatOrNull(path);
    return Boolean(link && !link.isSymbolicLink() && link.isDirectory());
  }

  isRegularFile(path: string): boolean {
    const link = lstatOrNull(path);
    if (!link || link.isSymbolicLink() || !link.isFile()) return false;
    const real = realpathSync.native(path);
    return isInsideRoot(this.root, real) || !isInsideRoot(this.root, resolve(path));
  }

  read(path: string, label: string): Buffer {
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

  readText(path: string, label: string): string {
    return this.read(path, label).toString("utf8");
  }

  readTextStrict(path: string, label: string): string {
    return decodeUtf8(this.read(path, label), label);
  }

  write(path: string, data: string | Uint8Array, mode?: number): void {
    this.ensureDirectory(dirname(path), `folder for ${basename(path)}`);
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

  unlinkOptional(path: string): void {
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

  removeTree(path: string): void {
    this.assertLexicalInside(path, basename(path));
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
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  cleanupCreated(paths: Iterable<string>): void {
    const unique = [...new Set(paths)].sort((left, right) => {
      const depth = right.split(sep).length - left.split(sep).length;
      return depth !== 0 ? depth : (left < right ? 1 : left > right ? -1 : 0);
    });
    for (const path of unique) {
      if (resolve(path) === this.root) continue;
      try {
        this.removeTree(path);
      } catch {
        // Best-effort rollback; never hide the original failure.
      }
    }
  }

  renameWithinRoot(from: string, to: string): void {
    const fromParent = realpathSync.native(dirname(from));
    assertInsideRoot(this.root, fromParent, basename(from));
    this.ensureDirectory(dirname(to), "trash");
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

  listEntries(directory: string): Dirent[] {
    try {
      return readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
      throw error;
    }
  }

  listFiles(directory: string): string[] {
    return this.listEntries(directory)
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  }

  copyTree(
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
        this.copyTree(real, destination, options, new Set([...visited, real]));
        return;
      }
      if (statValue.isFile()) {
        this.write(destination, readFileSync(real), statValue.mode & 0o777);
        return;
      }
      throw new StudioError(`コピーできない種類のファイルです: ${source}`, "CONFLICT");
    }

    this.ensureDirectory(destination, basename(destination));
    const entries = this.listEntries(source);
    // Python's copytree passes every name to the ignore callback, including
    // symlinks. Filtering them out would follow a linked materials/ or PDF.
    const names = entries.map((entry) => entry.name).sort();
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
          this.copyTree(real, to, options, new Set([...visited, real]));
        } else if (statValue.isFile()) {
          this.write(to, readFileSync(real), statValue.mode & 0o777);
        } else {
          throw new StudioError(`コピーできない種類のファイルです: ${relative(this.root, from)}`, "CONFLICT");
        }
      } else if (link.isDirectory()) {
        this.copyTree(from, to, options, visited);
      } else if (link.isFile()) {
        this.write(to, readFileSync(from), link.mode & 0o777);
      } else {
        throw new StudioError(`コピーできない種類のファイルです: ${relative(this.root, from)}`, "CONFLICT");
      }
    }
  }
}
