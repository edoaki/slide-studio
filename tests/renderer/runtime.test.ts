import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// Real Electron runs are POSIX-only until the Windows launcher/process-group path exists.
const E2E = process.env.SLIDE_STUDIO_RENDERER_E2E === "1" && process.platform !== "win32";
const TEST_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 25_000;

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface CaseFiles {
  jobPath: string;
  inputHtml: string;
  outputDir: string;
}

function repoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, "scripts/migration/render-spike.mjs"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("cannot locate the repository root");
    current = parent;
  }
}

async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "render-runtime-test-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

function childEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
}

function deckHtml(options: { ready?: boolean; readyDelayMs?: number; script?: string } = {}): string {
  const ready = options.ready ?? true;
  const readyDelay = options.readyDelayMs ?? 0;
  const readyCode = ready
    ? (readyDelay > 0
      ? `setTimeout(() => { window.deckReady = true; dispatchEvent(new Event('deckready')); }, ${readyDelay});`
      : "window.deckReady = true; dispatchEvent(new Event('deckready'));")
    : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; background: #fff; }
#stage, .slide { width: 1280px; height: 720px; }
.slide { display: none; box-sizing: border-box; padding: 48px; }
.slide.active { display: block; }
h1 { margin: 0; font: 48px/1.2 system-ui, sans-serif; }
</style>
</head>
<body>
<div id="stage"><section class="slide"><h1>Runtime test</h1></section></div>
<script>
const slides = [...document.querySelectorAll('#stage > .slide')];
let index = 0;
function go(i, n = 0) {
  index = Math.max(0, Math.min(slides.length - 1, i));
  slides.forEach((slide, k) => slide.classList.toggle('active', k === index));
  return Promise.resolve();
}
window.__slideStudioNoHash = true;
window.deck = { go, get count() { return slides.length; }, pdfSteps() { return [0]; } };
${options.script ?? ""}
${readyCode}
</script>
</body>
</html>`;
}

async function writeCase(
  root: string,
  name: string,
  html: string,
  options: { timeoutMs?: number; screenshots?: boolean; existingOutput?: boolean } = {},
): Promise<CaseFiles> {
  const inputHtml = join(root, `${name}.html`);
  const outputDir = join(root, `${name}-out`);
  await writeFile(inputHtml, html, "utf8");
  if (options.existingOutput) {
    await mkdir(outputDir);
    await writeFile(join(outputDir, "sentinel.txt"), "keep");
  }
  const jobPath = join(root, `${name}.json`);
  await writeFile(jobPath, JSON.stringify({
    schemaVersion: 1,
    inputHtml,
    outputDir,
    timeoutMs: options.timeoutMs ?? 15_000,
    screenshots: options.screenshots ?? false,
  }), "utf8");
  return { jobPath, inputHtml, outputDir };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== "win32" && pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to the direct child if the group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function runJob(
  jobPath: string,
  env: NodeJS.ProcessEnv,
  onSpawn?: (child: ChildProcess) => void,
): Promise<RunResult> {
  const started = Date.now();
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(repoRoot(), "scripts/migration/render-spike.mjs"),
      "--job",
      jobPath,
    ], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: string | Buffer) => { stderr += chunk.toString(); });

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 2_000);
      killTimer.unref?.();
    }, RUN_TIMEOUT_MS);
    timer.unref?.();
    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimers();
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

function parseResult(run: RunResult): Record<string, unknown> {
  const lines = run.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === undefined) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (
        value !== null
        && typeof value === "object"
        && (value as Record<string, unknown>).schemaVersion === 1
      ) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Not a result line.
    }
  }
  throw new Error(`no RenderResult in stdout\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function resultErrors(result: Record<string, unknown>): string[] {
  return stringArray(result.errors);
}

function resultBlocked(result: Record<string, unknown>): string[] {
  return stringArray(result.blockedRequests);
}

function assertBounded(run: RunResult): void {
  assert.ok(run.elapsedMs < 20_000, `job took ${run.elapsedMs}ms\nstderr:\n${run.stderr}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function assertProfilesRemoved(root: string): Promise<void> {
  const entries = await readdir(root);
  assert.deepEqual(
    entries.filter((entry) => entry.startsWith("slide-studio-render-")),
    [],
    "temporary Electron profiles were not removed",
  );
}

test("existing output is preserved", { timeout: TEST_TIMEOUT_MS, skip: !E2E }, async (t) => {
  const root = await scratch(t);
  const files = await writeCase(root, "existing", deckHtml(), {
    timeoutMs: 5_000,
    existingOutput: true,
  });

  const run = await runJob(files.jobPath, childEnv(root));
  assertBounded(run);
  assert.notEqual(run.code, 0);
  const result = parseResult(run);
  assert.equal(result.status, "error");
  assert.match(resultErrors(result).join("\n"), /already exists/);

  assert.equal(await readFile(join(files.outputDir, "sentinel.txt"), "utf8"), "keep");
  assert.deepEqual(await readdir(files.outputDir), ["sentinel.txt"]);
  await assertProfilesRemoved(root);
});

test("never-ready deck times out and removes incomplete output", {
  timeout: TEST_TIMEOUT_MS,
  skip: !E2E,
}, async (t) => {
  const root = await scratch(t);
  const files = await writeCase(root, "timeout", deckHtml({ ready: false }), {
    timeoutMs: 2_000,
  });

  const run = runJob(files.jobPath, childEnv(root));
  await waitFor(() => existsSync(files.outputDir), 10_000, "output allocation");
  const result = await run;

  assertBounded(result);
  assert.notEqual(result.code, 0);
  const parsed = parseResult(result);
  assert.equal(parsed.status, "error");
  assert.match(resultErrors(parsed).join("\n"), /timed out/);
  assert.equal(existsSync(files.outputDir), false);
  await assertProfilesRemoved(root);
});

test("SIGTERM cancels after output allocation and removes incomplete output", {
  timeout: TEST_TIMEOUT_MS,
  skip: !E2E,
}, async (t) => {
  const root = await scratch(t);
  const files = await writeCase(root, "signal", deckHtml({ ready: false }), {
    timeoutMs: 20_000,
  });

  let child: ChildProcess | undefined;
  const run = runJob(files.jobPath, childEnv(root), (spawned) => { child = spawned; });
  try {
    await waitFor(() => existsSync(files.outputDir), 10_000, "output allocation");
    assert.ok(child, "child process was not spawned");
    child.kill("SIGTERM");

    const result = await run;
    assertBounded(result);
    assert.notEqual(result.code, 0);
    const parsed = parseResult(result);
    assert.equal(parsed.status, "error");
    assert.match(resultErrors(parsed).join("\n"), /SIGTERM|cancelled|quit requested|disposed/i);
    assert.equal(existsSync(files.outputDir), false);
    await assertProfilesRemoved(root);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      killGroup(child, "SIGKILL");
    }
  }
});

test("blocked HTTPS image and fetch fail without incomplete output", {
  timeout: TEST_TIMEOUT_MS,
  skip: !E2E,
}, async (t) => {
  const root = await scratch(t);
  const files = await writeCase(root, "network", deckHtml({
    readyDelayMs: 200,
    script: `
      const img = new Image();
      img.src = 'https://example.invalid/runtime-test.png';
      document.body.append(img);
      fetch('https://example.invalid/runtime-test').catch(() => {});
    `,
  }), { timeoutMs: 10_000 });

  const run = await runJob(files.jobPath, childEnv(root));
  assertBounded(run);
  assert.notEqual(run.code, 0);
  const result = parseResult(run);
  assert.equal(result.status, "error");
  assert.ok(
    resultErrors(result).length + resultBlocked(result).length > 0,
    `expected a CSP or blocked-request failure\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );
  assert.equal(existsSync(files.outputDir), false);
  await assertProfilesRemoved(root);
});
