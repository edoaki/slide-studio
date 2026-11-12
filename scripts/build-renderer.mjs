import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const source = resolve(root, "packages/renderer/assets");
const target = resolve(dist, "packages/renderer/assets");

if (process.argv.includes("--clean")) {
  await rm(dist, { recursive: true, force: true });
} else {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
}
