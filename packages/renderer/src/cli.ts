import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import * as electronModule from "electron";
import type { RenderResult } from "./contracts.js";
import { JobDeadline } from "./deadline.js";
import { parseRenderJob, type ValidatedRenderJob } from "./job.js";
import { assertOutputAvailable, atomicWriteFile, OwnedOutputDirectory } from "./output.js";
import { STUDIO_RENDER_SCHEME } from "./protocol.js";
import type { RenderDeckResult } from "./render.js";
import { errorMessage, unique } from "./util.js";

type ElectronModule = typeof import("electron");

interface RenderFailureLike extends Error {
  errors: string[];
  blockedRequests: string[];
}

const startedAt = Date.now();
const PROFILE_ENV = "SLIDE_STUDIO_RENDER_PROFILE";

// Electron exposes a CommonJS module object. The default export is the same
// object inside Electron and a path string under ELECTRON_RUN_AS_NODE.
const electronNamespace = electronModule as unknown as Partial<ElectronModule> & {
  default?: Partial<ElectronModule> | string;
};
const electron = (
  electronNamespace.default !== null && typeof electronNamespace.default === "object"
    ? electronNamespace.default
    : electronNamespace
) as Partial<ElectronModule>;
const app = electron.app;
const protocol = electron.protocol;

let jobFinished = false;
let quitRequested = false;
let activeDeadline: JobDeadline | undefined;

function runtimeVersions(): RenderResult["versions"] {
  return {
    electron: process.versions.electron ?? "",
    chromium: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  };
}

function emptyResult(versions: RenderResult["versions"]): RenderResult {
  return {
    schemaVersion: 1,
    status: "error",
    slides: 0,
    pdfPages: 0,
    steps: [],
    errors: [],
    blockedRequests: [],
    elapsedMs: Date.now() - startedAt,
    versions,
  };
}

function isRenderFailure(error: unknown): error is RenderFailureLike {
  if (!(error instanceof Error) || error.name !== "RenderFailure") return false;
  const candidate = error as unknown as Record<string, unknown>;
  return Array.isArray(candidate.errors)
    && candidate.errors.every((value) => typeof value === "string")
    && Array.isArray(candidate.blockedRequests)
    && candidate.blockedRequests.every((value) => typeof value === "string");
}

function parseJobPath(argv: string[]): string {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--job") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("usage: cli.js --job <JSON path>");
      }
      values.push(value);
      index++;
    } else if (argument.startsWith("--job=")) {
      const value = argument.slice("--job=".length);
      if (value.length === 0 || value.startsWith("--")) {
        throw new Error("usage: cli.js --job <JSON path>");
      }
      values.push(value);
    }
  }
  if (values.length === 0) throw new Error("usage: cli.js --job <JSON path>");
  if (values.length > 1) throw new Error("exactly one --job is allowed per process");
  return resolve(values[0]!);
}

function profileDirectory(): string | undefined {
  const value = process.env[PROFILE_ENV];
  if (!value || !isAbsolute(value)) return undefined;
  try {
    return statSync(value).isDirectory() ? value : undefined;
  } catch {
    return undefined;
  }
}

/*
 * All Electron setup that must happen before `ready` runs synchronously during
 * module evaluation, before the first await. The launcher owns the temporary
 * profile and removes it after this process exits.
 */
let bootstrapError: string | undefined;
if (!app || !protocol) {
  bootstrapError = "must run inside Electron with ELECTRON_RUN_AS_NODE removed; "
    + "use scripts/migration/render-spike.mjs";
} else {
  const profile = profileDirectory();
  if (!profile) {
    bootstrapError = `${PROFILE_ENV} must be an existing absolute directory created by `
      + "scripts/migration/render-spike.mjs";
  } else {
    try {
      app.setPath("userData", profile);
      app.setPath("sessionData", profile);
      app.enableSandbox();
      app.commandLine.appendSwitch("force-device-scale-factor", "1");
      app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
      app.commandLine.appendSwitch("dns-prefetch-disable");
      protocol.registerSchemesAsPrivileged([{
        scheme: STUDIO_RENDER_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true },
      }]);
      // renderDeck destroys its hidden window before the result is written.
      app.on("window-all-closed", () => {});
      app.on("will-quit", (event) => {
        if (jobFinished) return;
        event.preventDefault();
        if (activeDeadline) activeDeadline.abort("quit requested");
        else quitRequested = true;
      });
    } catch (error) {
      bootstrapError = `cannot configure Electron before ready: ${errorMessage(error)}`;
    }
  }
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  const versions = runtimeVersions();
  const result = emptyResult(versions);

  let output: OwnedOutputDirectory | undefined;
  let job: ValidatedRenderJob | undefined;
  let rendered: RenderDeckResult | undefined;
  let deadline: JobDeadline | undefined;
  let interrupted: string | undefined;

  const onSignal = (signal: string) => {
    if (deadline) deadline.abort(`cancelled by ${signal}`);
    else interrupted = signal;
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    if (bootstrapError) throw new Error(bootstrapError);
    if (!app) throw new Error("Electron app is unavailable");
    if (quitRequested) throw new Error("quit requested");

    const jobPath = parseJobPath(process.argv);
    const rawJob = JSON.parse(await readFile(jobPath, "utf8")) as unknown;
    const validatedJob = parseRenderJob(rawJob);
    job = validatedJob;
    if (interrupted) throw new Error(`cancelled by ${interrupted}`);
    if (quitRequested) throw new Error("quit requested");

    const jobDeadline = new JobDeadline(
      validatedJob.timeoutMs - (Date.now() - startedAt),
      `job timed out after ${validatedJob.timeoutMs}ms`,
    );
    deadline = jobDeadline;
    activeDeadline = jobDeadline;
    if (interrupted) jobDeadline.abort(`cancelled by ${interrupted}`);
    if (quitRequested) jobDeadline.abort("quit requested");
    const ensureActive = () => {
      if (jobDeadline.aborted) throw jobDeadline.reason;
    };
    ensureActive();

    // Local filesystem work is awaited, never abandoned, so a timeout cannot
    // leave an output directory or temporary file behind.
    const inputStat = await stat(validatedJob.inputHtml);
    ensureActive();
    if (!inputStat.isFile()) {
      throw new Error(`inputHtml is not a regular file: ${validatedJob.inputHtml}`);
    }

    await assertOutputAvailable(validatedJob.outputDir);
    ensureActive();
    const outputDirectory = await OwnedOutputDirectory.allocate(validatedJob.outputDir);
    output = outputDirectory;
    ensureActive();

    await jobDeadline.race(app.whenReady());
    if (process.platform === "darwin") app.dock?.hide();
    ensureActive();

    const renderModule = await import("./render.js");
    ensureActive();
    rendered = await renderModule.renderDeck(validatedJob, outputDirectory.path, jobDeadline);
    ensureActive();

    result.status = "ok";
    result.slides = rendered.slides;
    result.pdfPages = rendered.pdfPages;
    result.steps = rendered.steps;
  } catch (error) {
    result.status = "error";
    result.slides = 0;
    result.pdfPages = 0;
    result.steps = [];
    if (isRenderFailure(error)) {
      result.errors = unique(error.errors.length > 0 ? error.errors : [error.message]);
      result.blockedRequests = unique(error.blockedRequests);
    } else {
      result.errors = [errorMessage(error)];
      result.blockedRequests = [];
    }

    for (const message of result.errors) {
      process.stderr.write(`render-spike: ${message}\n`);
    }
    for (const url of result.blockedRequests) {
      process.stderr.write(`render-spike: blocked ${url}\n`);
    }
    if (
      error instanceof Error
      && !isRenderFailure(error)
      && error.name !== "JobValidationError"
      && error.stack
    ) {
      process.stderr.write(`${error.stack}\n`);
    }

    if (output) {
      try {
        await output.remove();
      } catch (cleanupError) {
        process.stderr.write(`render-spike: cannot remove incomplete output: ${errorMessage(cleanupError)}\n`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    activeDeadline = undefined;
    deadline?.dispose();
  }

  if (result.status === "ok" && output && job && rendered) {
    // The manifest is written after cleanup so its elapsedMs is the final job time.
    result.elapsedMs = Date.now() - startedAt;
    const manifest = {
      ...result,
      inputHtml: job.inputHtml,
      output: {
        directory: output.path,
        pdf: rendered.pdfFile,
        screenshots: rendered.screenshotFiles,
        manifest: "manifest.json",
      },
    };
    try {
      await atomicWriteFile(
        join(output.path, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    } catch (error) {
      result.status = "error";
      result.slides = 0;
      result.pdfPages = 0;
      result.steps = [];
      result.errors = [errorMessage(error)];
      result.blockedRequests = [];
      process.stderr.write(`render-spike: cannot write manifest: ${errorMessage(error)}\n`);
      try {
        await output.remove();
      } catch (cleanupError) {
        process.stderr.write(`render-spike: cannot remove incomplete output: ${errorMessage(cleanupError)}\n`);
      }
    }
  }

  result.elapsedMs = Date.now() - startedAt;
  const code = result.status === "ok" ? 0 : 1;
  let wroteResult = true;
  try {
    await writeStdout(`${JSON.stringify(result)}\n`);
  } catch (writeError) {
    wroteResult = false;
    process.stderr.write(`render-spike: cannot write result: ${errorMessage(writeError)}\n`);
  }

  const exitCode = wroteResult ? code : 1;
  jobFinished = true;
  process.exitCode = exitCode;
  if (app) app.exit(exitCode);
  else process.exit(exitCode);
}

void main().catch((error: unknown) => {
  process.stderr.write(`render-spike: fatal: ${errorMessage(error)}\n`);
  process.exitCode = 1;
  if (app) app.exit(1);
  else process.exit(1);
});
