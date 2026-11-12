#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("electron");

if (typeof electron !== "string" || electron.length === 0) {
  process.stderr.write(
    "dev-desktop: cannot locate the local Electron executable. Run npm install first.\n",
  );
  process.exit(1);
}

const main = resolve(root, "dist/apps/desktop/main.js");
if (!existsSync(main)) {
  process.stderr.write("dev-desktop: dist/apps/desktop/main.js is missing. Run npm run build first.\n");
  process.exit(1);
}

const pandocBinary = process.platform === "win32" ? "pandoc.exe" : "pandoc";
const pandoc = resolve(root, "resources/pandoc/bin", pandocBinary);
const explicitPandoc = process.env.SLIDE_STUDIO_PANDOC;
if (explicitPandoc === undefined || explicitPandoc.length === 0) {
  // The setup script is idempotent: it verifies an existing 3.9 binary first and
  // only downloads a pinned, SHA-256-verified archive when needed.
  const setup = spawnSync(process.execPath, [resolve(root, "scripts/setup-pandoc.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (setup.error !== undefined) {
    process.stderr.write(`dev-desktop: cannot run setup-pandoc: ${setup.error.message}\n`);
    process.exit(1);
  }
  if (setup.status !== 0) {
    process.stderr.write("dev-desktop: Pandoc setup failed.\n");
    process.exit(setup.status ?? 1);
  }
  if (!existsSync(pandoc)) {
    process.stderr.write("dev-desktop: Pandoc is unavailable after setup.\n");
    process.exit(1);
  }
}

const env = { ...process.env };
// Remove this from the child only. The developer's shell keeps its own value.
delete env.ELECTRON_RUN_AS_NODE;

let child;
try {
  child = spawn(electron, [main, ...process.argv.slice(2)], {
    cwd: root,
    env,
    stdio: "inherit",
  });
} catch (error) {
  process.stderr.write(`dev-desktop: cannot start Electron: ${error.message}\n`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`dev-desktop: cannot start Electron: ${error.message}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.exitCode = 128 + (constants.signals[signal] ?? 0);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
