import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Write a sibling temporary file, preserve the destination mode, flush it,
 * and then atomically rename over the destination.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const directory = dirname(filePath);
  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", mode ?? 0o644);
    if (mode !== undefined) await handle.chmod(mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export function atomicWriteBytesSync(path: string, data: Buffer, mode: number): void {
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
