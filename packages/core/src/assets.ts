import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CoreError } from "./errors.js";

let cachedRoot: string | null = null;

export function assetRoot(): string {
  if (cachedRoot) return cachedRoot;
  const packed = fileURLToPath(new URL("../assets/", import.meta.url));
  const unpacked = packed.replace(/([\\/])app\.asar(?=[\\/])/u, "$1app.asar.unpacked");
  const candidates = unpacked === packed ? [packed] : [unpacked];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "lua", "slide-studio.lua"))) {
      cachedRoot = realpathSync.native(candidate);
      return cachedRoot;
    }
  }
  throw new CoreError("INVALID_INPUT", "core assets are not installed (check asarUnpack)");
}

export function assetPath(...parts: string[]): string {
  return join(assetRoot(), ...parts);
}

export function readAsset(...parts: string[]): string {
  try {
    return readFileSync(assetPath(...parts), "utf8");
  } catch (error) {
    throw new CoreError("INVALID_INPUT", `cannot read bundled asset ${parts.join("/")}: ${String(error)}`);
  }
}
