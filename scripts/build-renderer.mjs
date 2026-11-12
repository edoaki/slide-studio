import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

const copies = [
  {
    source: resolve(root, "packages/renderer/assets"),
    target: resolve(dist, "packages/renderer/assets"),
    required: true,
    label: "renderer assets",
  },
  {
    source: resolve(root, "packages/core/assets"),
    target: resolve(dist, "packages/core/assets"),
    required: true,
    label: "core assets",
  },
  {
    source: resolve(root, "packages/web"),
    target: resolve(dist, "packages/web"),
    required: false,
    label: "web assets",
  },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyAssets(entry) {
  if (!(await exists(entry.source))) {
    if (entry.required) {
      throw new Error(`missing ${entry.label}: ${entry.source}`);
    }
    process.stderr.write(
      `build-renderer: ${entry.label} are not present at ${entry.source}; skipped\n`,
    );
    return;
  }
  await rm(entry.target, { recursive: true, force: true });
  await mkdir(dirname(entry.target), { recursive: true });
  await cp(entry.source, entry.target, { recursive: true });
}

if (process.argv.includes("--clean")) {
  await rm(dist, { recursive: true, force: true });
}

for (const entry of copies) {
  await copyAssets(entry);
}

// The content agent must execute before authored slide scripts. Keep the
// preserved UI as ES modules and bundle only this first-head bootstrap.
const frameAgent = resolve(root, "packages/web/bridge/frame-agent.js");
if (!process.argv.includes("--clean") && await exists(frameAgent)) {
  await build({
    entryPoints: [frameAgent],
    outfile: resolve(dist, "packages/web/bridge/frame-agent.classic.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome156",
    sourcemap: false,
    legalComments: "inline",
  });
}
