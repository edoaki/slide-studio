import type { CoreErrorCode, CoreFailure } from "../../contracts/src/desktop.js";

/** A core failure that carries one of the frozen contract error codes. */
export class CoreError extends Error implements CoreFailure {
  readonly code: CoreErrorCode;
  readonly currentVersion?: string;

  constructor(code: CoreErrorCode, message: string, currentVersion?: string) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    if (currentVersion !== undefined) this.currentVersion = currentVersion;
  }
}

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
