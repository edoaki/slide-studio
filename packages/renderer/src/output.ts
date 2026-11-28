export { atomicWriteFile } from "../../core/src/atomic.js";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export class OutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputError";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Refuse files, directories, and broken symlinks alike. */
export async function assertOutputAvailable(outputDir: string): Promise<void> {
  try {
    await lstat(outputDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new OutputError(`cannot inspect outputDir: ${outputDir}: ${String(error)}`);
  }
  throw new OutputError(`outputDir already exists; refusing to overwrite: ${outputDir}`);
}

/** A directory this process created. Only this object may delete it. */
export class OwnedOutputDirectory {
  #created = true;

  private constructor(readonly path: string) {}

  static async allocate(outputDir: string): Promise<OwnedOutputDirectory> {
    await assertOutputAvailable(outputDir);
    await mkdir(dirname(outputDir), { recursive: true });
    try {
      await mkdir(outputDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new OutputError(`outputDir already exists; refusing to overwrite: ${outputDir}`);
      }
      throw new OutputError(`cannot create outputDir: ${outputDir}: ${String(error)}`);
    }
    return new OwnedOutputDirectory(outputDir);
  }

  async remove(): Promise<void> {
    if (!this.#created) return;
    await rm(this.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    this.#created = false;
  }
}
