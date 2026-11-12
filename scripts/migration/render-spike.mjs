#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
if (typeof electron !== "string" || electron.length === 0) {
  process.stderr.write("render-spike: cannot locate the Electron executable\n");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../dist/packages/renderer/src/cli.js");

let profile;
try {
  profile = mkdtempSync(join(tmpdir(), "slide-studio-render-"));
} catch (error) {
  process.stderr.write(`render-spike: cannot create temporary profile: ${error.message}\n`);
  process.exit(1);
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`render-spike: cannot remove temporary profile: ${error.message}\n`);
  }
}
process.on("exit", cleanup);

// Keep the launcher as the only owner of the temporary Chromium profile.
function withoutProfileArguments(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--user-data-dir") {
      index++;
      continue;
    }
    if (argument.startsWith("--user-data-dir=")) continue;
    out.push(argument);
  }
  return out;
}

const env = {
  ...process.env,
  SLIDE_STUDIO_RENDER_PROFILE: profile,
};
// The workspace may inherit this. Remove it from the child only so Electron
// starts as a browser-process application, not as plain Node.
delete env.ELECTRON_RUN_AS_NODE;

let child;
try {
  child = spawn(
    electron,
    [`--user-data-dir=${profile}`, cli, ...withoutProfileArguments(process.argv.slice(2))],
    { env, stdio: "inherit" },
  );
} catch (error) {
  process.stderr.write(`render-spike: cannot start Electron: ${error.message}\n`);
  cleanup();
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`render-spike: cannot start Electron: ${error.message}\n`);
  cleanup();
  process.exit(1);
});

child.on("close", (code, signal) => {
  cleanup();
  if (signal) {
    process.exitCode = 128 + (constants.signals[signal] ?? 0);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
