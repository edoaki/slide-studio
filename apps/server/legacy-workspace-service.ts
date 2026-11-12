/**
 * Locked owner for one legacy {@link Workspace}.
 *
 * The desktop process must not run `Workspace.ensure()` until the workspace
 * state directory is a real directory inside the canonical root and the
 * cross-process workspace lock has been acquired. This module owns that
 * ordering and guarantees the lock is released on every failure path.
 */
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CoreError } from "../../packages/core/src/errors.js";
import { Workspace, type WorkspaceOptions } from "../../packages/core/src/legacy-workspace.js";
import { acquireWorkspaceLock, releaseWorkspaceLock } from "../../packages/core/src/lock.js";
import { isInsideRoot } from "../../packages/core/src/paths.js";

export interface OpenLegacyWorkspaceOptions extends WorkspaceOptions {
  /** Create the trial sample only when the workspace has no decks. */
  sample?: boolean;
}

async function directoryAt(path: string, label: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      throw new CoreError("OUTSIDE_ROOT", `${label} may not be a symbolic link`);
    }
    if (!entry.isDirectory()) {
      throw new CoreError("INVALID_INPUT", `${label} is not a directory`);
    }
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && ((error as NodeJS.ErrnoException).code === "ENOENT"
        || (error as NodeJS.ErrnoException).code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Open one canonical root, create `.slide-studio` safely, acquire the lock and
 * only then run the legacy workspace ensure migrations.
 */
export async function openLegacyWorkspace(
  rootInput: string,
  options: OpenLegacyWorkspaceOptions = {},
): Promise<LegacyWorkspaceService> {
  if (typeof rootInput !== "string" || !isAbsolute(rootInput)) {
    throw new CoreError("INVALID_INPUT", "workspace root must be an explicit absolute path");
  }
  let rootStat: Awaited<ReturnType<typeof stat>>;
  try {
    rootStat = await stat(rootInput);
  } catch (error) {
    throw new CoreError("INVALID_INPUT", `workspace folder does not exist: ${String(error)}`);
  }
  if (!rootStat.isDirectory()) {
    throw new CoreError("INVALID_INPUT", "workspace path is not a directory");
  }

  const root = await realpath(rootInput);
  let state = join(root, ".slide-studio");
  if (!(await directoryAt(state, ".slide-studio"))) {
    try {
      await mkdir(state, { recursive: false, mode: 0o700 });
    } catch (error) {
      throw new CoreError("INVALID_INPUT", `cannot create .slide-studio: ${String(error)}`);
    }
  }
  // Re-inspect after creation and resolve the canonical state path. A symlink
  // here could make the lock and ensure migrations write outside the root.
  await directoryAt(state, ".slide-studio");
  state = await realpath(state);
  if (!isInsideRoot(root, state)) {
    throw new CoreError("OUTSIDE_ROOT", ".slide-studio escapes the workspace root");
  }

  const lock = await acquireWorkspaceLock(state);
  try {
    const workspace = new Workspace(root, options);
    workspace.ensure();
    if (options.sample && workspace.list_decks().length === 0) {
      // Use the real legacy creation path so themes, topics, recent state and
      // bibliography migration all run exactly as they do for a user deck.
      workspace.new_deck("sample", "sample", "default", null, "サンプル発表");
    }
    return new LegacyWorkspaceService(workspace, lock.path, lock.token);
  } catch (error) {
    await releaseWorkspaceLock(lock.path, lock.token);
    throw error;
  }
}

export class LegacyWorkspaceService {
  readonly workspace: Workspace;
  readonly root: string;
  #lockPath: string | undefined;
  #lockToken: string | undefined;
  #closing: Promise<void> | undefined;

  constructor(workspace: Workspace, lockPath: string, lockToken: string) {
    this.workspace = workspace;
    this.root = workspace.root;
    this.#lockPath = lockPath;
    this.#lockToken = lockToken;
  }

  /** Release the cross-process lock exactly once. Call only after the host drained requests. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = (async () => {
      const path = this.#lockPath;
      const token = this.#lockToken;
      this.#lockPath = undefined;
      this.#lockToken = undefined;
      if (path !== undefined && token !== undefined) {
        await releaseWorkspaceLock(path, token);
      }
    })();
    return this.#closing;
  }
}
