import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CoreError } from "./errors.js";

export const PANDOC_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

export interface PandocPaths {
  pandocPath: string;
  luaFilter: string;
  csl: string;
  dataDirectory: string;
  temporaryDirectory: string;
}

interface ActiveProcess {
  child: ChildProcess;
  exited: Promise<void>;
  kill: () => void;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== "win32" && pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through when the group has already gone away.
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

/** Runs one bounded Pandoc process at a time and owns its process group. */
export class PandocRunner {
  readonly #paths: PandocPaths;
  #active: ActiveProcess | null = null;
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(paths: PandocPaths) {
    this.#paths = paths;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async run(body: string, cwd: string, extraArguments: string[]): Promise<{ stdout: string; stderr: string }> {
    if (this.#closed) throw new CoreError("BUSY", "workspace is closing");
    if (this.#active !== null) throw new CoreError("BUSY", "another Pandoc render is already running");
    await this.#prepareEnvironment();
    if (this.#closed) throw new CoreError("BUSY", "workspace is closing");

    const args = [
      "--sandbox",
      "--data-dir", this.#paths.dataDirectory,
      "--from", "markdown-yaml_metadata_block-pandoc_title_block+fenced_divs+tex_math_dollars",
      "--to", "html5",
      "--mathml",
      "--wrap=none",
      "--lua-filter", this.#paths.luaFilter,
      "--citeproc",
      "--csl", this.#paths.csl,
      ...extraArguments,
    ];

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.#paths.pandocPath, args, {
          cwd,
          env: childEnvironment(this.#paths.temporaryDirectory),
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(new CoreError("RENDER_FAILED", `cannot start Pandoc: ${String(error)}`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let overflow = false;
      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const hardKill = () => {
        if (killTimer === undefined) {
          killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 1_500);
          killTimer.unref?.();
        }
      };

      const kill = () => {
        killGroup(child, "SIGTERM");
        hardKill();
      };

      let markExited!: () => void;
      const exited = new Promise<void>((done) => {
        markExited = done;
      });
      this.#active = { child, exited, kill };

      const finish = (error?: CoreError): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (this.#active?.child === child) this.#active = null;
        markExited();
        if (error) reject(error);
        else resolve({ stdout, stderr });
      };

      timeout = setTimeout(() => {
        timedOut = true;
        kill();
      }, PANDOC_TIMEOUT_MS);
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
          finish(new CoreError("RENDER_TIMEOUT", "Pandoc preview timed out after 30 seconds"));
          return;
        }
        if (overflow) {
          finish(new CoreError("RENDER_FAILED", "Pandoc output exceeded the bounded stream size"));
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() || `Pandoc exited with ${signal ?? code}`;
          finish(new CoreError("RENDER_FAILED", detail));
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
      child.stdin.end(body);
    });
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      const active = this.#active;
      if (active) {
        active.kill();
        await active.exited;
      }
    })();
    return this.#closing;
  }

  async #prepareEnvironment(): Promise<void> {
    const temp = this.#paths.temporaryDirectory;
    await mkdir(join(temp, "home"), { recursive: true });
    await mkdir(join(temp, "tmp"), { recursive: true });
    await mkdir(join(temp, "xdg", "data"), { recursive: true });
    await mkdir(join(temp, "xdg", "config"), { recursive: true });
    await mkdir(join(temp, "xdg", "cache"), { recursive: true });
    await mkdir(join(temp, "xdg", "state"), { recursive: true });
    await mkdir(join(temp, "xdg", "run"), { recursive: true });
    await mkdir(this.#paths.dataDirectory, { recursive: true });
  }
}
