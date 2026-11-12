/**
 * Native Pandoc runner for the legacy renderer.
 *
 * This is the TypeScript replacement for `.reference/parity/pandoc_worker.py`.
 * It intentionally keeps a very small surface: the caller supplies the fixed
 * argument list for one conversion, and this module owns the process, the
 * isolated data/home directories, output bounds, timeouts and shutdown.
 *
 * Security properties:
 * - `--sandbox` is always prepended and cannot be removed by the caller.
 * - Pandoc is spawned with `shell: false`; no command string is ever built.
 * - `PATH`, `HOME`, XDG and temporary variables are replaced with isolated
 *   values; the caller's environment is not inherited.
 * - The source document never chooses a filter. Callers pass only absolute,
 *   validated workspace/packaged paths.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CoreError } from "./errors.js";

/** Legacy one-shot conversions use the same 60-second budget as Python. */
export const PANDOC_TIMEOUT_MS = 60_000;
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
export const MAX_STDERR_BYTES = 1024 * 1024;

export interface RunPandocOptions {
  /** Absolute path to the bundled or test Pandoc executable. */
  pandocPath: string;
  /** Absolute working directory (the deck folder for legacy rendering). */
  cwd: string;
  /** Optional caller-owned isolated directory. A unique directory is used when omitted. */
  temporaryDirectory?: string;
  /** Hard wall-clock limit. Defaults to {@link PANDOC_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface RunPandocResult {
  stdout: string;
  stderr: string;
}

/** Pandoc exited with a non-zero status. The complete output remains available. */
export class PandocError extends CoreError {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    stdout: string,
    stderr: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) {
    const detail = stderr.trim()
      || (exitCode === null ? `Pandoc was terminated by ${signal ?? "a signal"}` : `Pandoc exited with ${exitCode}`);
    super("RENDER_FAILED", detail);
    this.name = "PandocError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

interface ActiveRun {
  child: ChildProcess;
  exited: Promise<void>;
  cancel: () => void;
}

const ACTIVE = new Set<ActiveRun>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== "win32" && pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The process group has already gone away; fall through to child.kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function childEnvironment(temporaryDirectory: string): NodeJS.ProcessEnv {
  // Only OS-essential values are passed through. LUA_PATH, DYLD_*, secrets and
  // the launching terminal's locale must not change Pandoc's behaviour.
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };
  if (process.platform === "win32" && process.env.SystemRoot) {
    env.SystemRoot = process.env.SystemRoot;
  }
  const home = join(temporaryDirectory, "home");
  const xdg = join(temporaryDirectory, "xdg");
  const temp = join(temporaryDirectory, "tmp");
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_DATA_HOME = join(xdg, "data");
  env.XDG_CONFIG_HOME = join(xdg, "config");
  env.XDG_CACHE_HOME = join(xdg, "cache");
  env.XDG_STATE_HOME = join(xdg, "state");
  env.XDG_RUNTIME_DIR = join(xdg, "run");
  env.APPDATA = join(xdg, "config");
  env.LOCALAPPDATA = join(xdg, "cache");
  env.TMPDIR = temp;
  env.TMP = temp;
  env.TEMP = temp;
  env.PANDOC_DATA_DIR = join(xdg, "data", "pandoc");
  return env;
}

async function prepareEnvironment(temporaryDirectory: string): Promise<void> {
  await mkdir(join(temporaryDirectory, "home"), { recursive: true });
  await mkdir(join(temporaryDirectory, "tmp"), { recursive: true });
  await mkdir(join(temporaryDirectory, "xdg", "data"), { recursive: true });
  await mkdir(join(temporaryDirectory, "xdg", "config"), { recursive: true });
  await mkdir(join(temporaryDirectory, "xdg", "cache"), { recursive: true });
  await mkdir(join(temporaryDirectory, "xdg", "state"), { recursive: true });
  await mkdir(join(temporaryDirectory, "xdg", "run"), { recursive: true });
  await mkdir(join(temporaryDirectory, "data"), { recursive: true });
}

function validateOptions(options: RunPandocOptions): number {
  if (typeof options.pandocPath !== "string" || !isAbsolute(options.pandocPath)) {
    throw new CoreError("INVALID_INPUT", "pandocPath must be an absolute path");
  }
  if (typeof options.cwd !== "string" || !isAbsolute(options.cwd)) {
    throw new CoreError("INVALID_INPUT", "Pandoc cwd must be an absolute path");
  }
  if (options.temporaryDirectory !== undefined) {
    if (typeof options.temporaryDirectory !== "string" || !isAbsolute(options.temporaryDirectory)) {
      throw new CoreError("INVALID_INPUT", "temporaryDirectory must be an absolute path");
    }
  }
  const timeoutMs = options.timeoutMs ?? PANDOC_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CoreError("INVALID_INPUT", "Pandoc timeout must be a positive number of milliseconds");
  }
  return timeoutMs;
}

/**
 * Run one Pandoc conversion with bounded output and isolated state.
 *
 * The fixed `--sandbox` flag is always the first argument. Callers own the
 * remaining arguments and must derive them exclusively from validated paths.
 */
export async function run_pandoc(
  input: string,
  args: string[],
  options: RunPandocOptions,
): Promise<RunPandocResult> {
  const timeoutMs = validateOptions(options);
  if (!Array.isArray(args) || args.some((argument) =>
    typeof argument !== "string" || argument.includes("\u0000"))) {
    throw new CoreError("INVALID_INPUT", "Pandoc arguments must be NUL-free strings");
  }

  const ownsTemporary = options.temporaryDirectory === undefined;
  const temporaryDirectory = ownsTemporary
    ? await mkdtemp(join(tmpdir(), "slide-studio-pandoc-"))
    : resolve(options.temporaryDirectory!);
  const dataDirectory = join(temporaryDirectory, "data");

  try {
    await prepareEnvironment(temporaryDirectory);
    const pandocArguments = [
      "--sandbox",
      "--data-dir", dataDirectory,
      ...args,
    ];

    return await new Promise<RunPandocResult>((resolvePromise, rejectPromise) => {
      let child: ChildProcess;
      try {
        child = spawn(options.pandocPath, pandocArguments, {
          cwd: options.cwd,
          env: childEnvironment(temporaryDirectory),
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        rejectPromise(new CoreError("RENDER_FAILED", `cannot start Pandoc: ${String(error)}`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let overflow = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const hardKill = (): void => {
        if (killTimer === undefined) {
          killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 1_500);
          killTimer.unref?.();
        }
      };
      const kill = (): void => {
        killGroup(child, "SIGTERM");
        hardKill();
      };

      let markExited!: () => void;
      const exited = new Promise<void>((done) => {
        markExited = done;
      });
      const active: ActiveRun = {
        child,
        exited,
        cancel: () => {
          cancelled = true;
          kill();
        },
      };
      ACTIVE.add(active);

      const finish = (error?: CoreError): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        ACTIVE.delete(active);
        markExited();
        if (error) rejectPromise(error);
        else resolvePromise({ stdout, stderr });
      };

      timeout = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      timeout.unref?.();

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string | Buffer) => {
        const text = chunk.toString();
        stdoutBytes += Buffer.byteLength(text);
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          overflow = true;
          kill();
          return;
        }
        stdout += text;
      });
      child.stderr?.on("data", (chunk: string | Buffer) => {
        const text = chunk.toString();
        stderrBytes += Buffer.byteLength(text);
        if (stderrBytes > MAX_STDERR_BYTES) {
          overflow = true;
          kill();
          return;
        }
        stderr += text;
      });

      child.on("error", (error) => {
        finish(new CoreError("RENDER_FAILED", `cannot run Pandoc: ${error.message}`));
      });
      child.on("close", (code, signal) => {
        if (timedOut) {
          finish(new CoreError(
            "RENDER_TIMEOUT",
            `Pandoc timed out after ${timeoutMs} milliseconds`,
          ));
          return;
        }
        if (cancelled) {
          finish(new CoreError("BUSY", "Pandoc was cancelled while the workspace was closing"));
          return;
        }
        if (overflow) {
          finish(new CoreError("RENDER_FAILED", "Pandoc output exceeded the bounded stream size"));
          return;
        }
        if (code !== 0) {
          finish(new PandocError(stdout, stderr, code, signal));
          return;
        }
        finish();
      });

      if (!child.stdin) {
        finish(new CoreError("RENDER_FAILED", "Pandoc stdin is unavailable"));
        return;
      }
      child.stdin.on("error", () => {
        // The process may have been killed before consuming stdin.
      });
      child.stdin.end(input);
    });
  } finally {
    if (ownsTemporary) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Terminate every Pandoc process started by this module.
 *
 * This is called by the host during shutdown (and by tests). It does not
 * permanently close the module: a later explicit conversion can start again.
 */
export async function close_pandoc(): Promise<void> {
  const running = [...ACTIVE];
  for (const active of running) active.cancel();
  await Promise.all(running.map((active) => active.exited));
  ACTIVE.clear();
}
