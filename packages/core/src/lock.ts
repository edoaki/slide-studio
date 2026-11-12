import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { link, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { join } from "node:path";
import { CoreError, isNodeError } from "./errors.js";

const LOCK_FILE = "workspace.lock";
const MAX_LOCK_BYTES = 16 * 1024;

interface LockRecord {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
  bootTime?: number;
}

function currentBootTime(): number {
  return Math.round(Date.now() / 1000 - uptime());
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    // EPERM means the process exists but belongs to another user.
    return true;
  }
}

function isValidRecord(value: unknown): value is LockRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.token === "string"
    && typeof record.pid === "number"
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.hostname === "string"
    && typeof record.startedAt === "string"
    && (record.bootTime === undefined || typeof record.bootTime === "number");
}

function readLock(lockPath: string): LockRecord | null {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(lockPath);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw new CoreError("LOCKED", `cannot inspect workspace lock: ${String(error)}`);
  }
  if (entry.isSymbolicLink()) {
    throw new CoreError("LOCKED", "workspace lock is a symbolic link; refusing to follow it");
  }
  if (!entry.isFile()) throw new CoreError("LOCKED", "workspace lock is not a regular file");
  if (entry.size > MAX_LOCK_BYTES) throw new CoreError("LOCKED", "workspace lock is too large");
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    return isValidRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isStale(record: LockRecord): boolean {
  if (record.hostname !== hostname()) return false;
  if (typeof record.bootTime === "number" && Math.abs(record.bootTime - currentBootTime()) > 120) {
    return true;
  }
  return !isPidAlive(record.pid);
}

/**
 * Publish a fully written lock file atomically. A hard link is the create
 * operation, so readers never observe a partially written lock at lockPath.
 */
async function publishLock(stateDirectory: string, record: LockRecord): Promise<boolean> {
  const lockPath = join(stateDirectory, LOCK_FILE);
  const temporary = join(stateDirectory, `.workspace.lock.${record.token}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, lockPath);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return false;
      throw new CoreError("LOCKED", `cannot publish workspace lock: ${String(error)}`);
    }
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("LOCKED", `cannot write workspace lock: ${String(error)}`);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original failure.
      }
    }
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Move the observed stale lock aside and verify its token before removing it.
 * A mismatch means another owner replaced it, so it is restored instead.
 */
async function reclaimStale(stateDirectory: string, expected: LockRecord): Promise<void> {
  const lockPath = join(stateDirectory, LOCK_FILE);
  const grave = join(stateDirectory, `.workspace.lock.stale.${randomUUID()}`);
  try {
    await rename(lockPath, grave);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new CoreError("LOCKED", `cannot reclaim stale workspace lock: ${String(error)}`);
  }
  let moved: LockRecord | null = null;
  try {
    moved = readLock(grave);
  } catch {
    try {
      await link(grave, lockPath);
    } catch {
      // Another lock already exists; do not remove it.
    }
    await unlink(grave).catch(() => undefined);
    throw new CoreError("LOCKED", "workspace lock changed while reclaiming a stale lock");
  }
  if (moved === null || moved.token !== expected.token) {
    try {
      await link(grave, lockPath);
    } catch {
      // Another fresh owner already published a lock; leave it untouched.
    }
    await unlink(grave).catch(() => undefined);
    throw new CoreError("LOCKED", "workspace lock changed while reclaiming a stale lock");
  }
  await unlink(grave).catch(() => undefined);
}

/** Acquire one exclusive lock per workspace root. Only dead local PIDs are reclaimed. */
export async function acquireWorkspaceLock(stateDirectory: string): Promise<{ token: string; path: string }> {
  const lockPath = join(stateDirectory, LOCK_FILE);
  const token = randomUUID();
  const record: LockRecord = {
    token,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    bootTime: currentBootTime(),
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await publishLock(stateDirectory, record)) return { token, path: lockPath };

    const existing = readLock(lockPath);
    if (existing === null) {
      // An unreadable or foreign-format lock must never be removed automatically.
      throw new CoreError("LOCKED", "workspace is locked by another process");
    }
    if (!isStale(existing)) {
      throw new CoreError(
        "LOCKED",
        `workspace is already open by pid ${existing.pid} on ${existing.hostname}`,
      );
    }
    await reclaimStale(stateDirectory, existing);
  }

  throw new CoreError("LOCKED", "workspace is locked by another process");
}

/** Release only our own lock; a foreign lock is left untouched. */
export async function releaseWorkspaceLock(lockPath: string, token: string): Promise<void> {
  try {
    const existing = readLock(lockPath);
    if (existing === null || existing.token !== token) return;
    const confirmed = readLock(lockPath);
    if (confirmed === null || confirmed.token !== token) return;
    await unlink(lockPath);
  } catch {
    // Shutdown must not fail because a lock was already removed or replaced.
  }
}
