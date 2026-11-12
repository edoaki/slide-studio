import { randomUUID } from "node:crypto";
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
  mode: number,
): Promise<void> {
  const directory = dirname(filePath);
  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.chmod(mode);
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
