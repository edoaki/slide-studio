import { isAbsolute, resolve } from "node:path";
import type { RenderJob } from "./contracts.js";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 600_000;

export class JobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobValidationError";
  }
}

export interface ValidatedRenderJob {
  schemaVersion: 1;
  inputHtml: string;
  outputDir: string;
  timeoutMs: number;
  screenshots: boolean;
  allSteps?: boolean;
  pdf?: boolean;
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobValidationError(`${field} must be a non-empty absolute path`);
  }
  if (value.includes("\0")) {
    throw new JobValidationError(`${field} must not contain NUL`);
  }
  if (!isAbsolute(value)) {
    throw new JobValidationError(`${field} must be an absolute path`);
  }
  return value;
}

/** Validate the on-disk JSON without touching the filesystem. */
export function parseRenderJob(value: unknown): ValidatedRenderJob {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JobValidationError("job must be a JSON object");
  }
  const job = value as Record<string, unknown>;
  if (job.schemaVersion !== 1) {
    throw new JobValidationError("schemaVersion must be 1");
  }

  const inputHtml = absolutePath(job.inputHtml, "inputHtml");
  const outputDir = absolutePath(job.outputDir, "outputDir");
  if (resolve(inputHtml) === resolve(outputDir)) {
    throw new JobValidationError("inputHtml and outputDir must differ");
  }

  const timeoutMs = job.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : job.timeoutMs;
  if (
    typeof timeoutMs !== "number"
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new JobValidationError(`timeoutMs must be a finite number in (0, ${MAX_TIMEOUT_MS}]`);
  }

  const screenshots = job.screenshots === undefined ? true : job.screenshots;
  if (typeof screenshots !== "boolean") {
    throw new JobValidationError("screenshots must be a boolean");
  }

  for (const name of ["allSteps", "pdf"]) if (job[name] !== undefined && typeof job[name] !== "boolean") throw new JobValidationError(`${name} must be a boolean`);
  return {
    ...(job.allSteps === undefined ? {} : { allSteps: job.allSteps as boolean }),
    ...(job.pdf === undefined ? {} : { pdf: job.pdf as boolean }),
    schemaVersion: 1,
    inputHtml,
    outputDir,
    timeoutMs,
    screenshots,
  } satisfies RenderJob & ValidatedRenderJob;
}
