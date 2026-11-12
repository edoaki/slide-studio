import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** Load the renderer's bundled layout asset, never a rewritten copy. */
export async function loadLayoutSource(): Promise<string> {
  if (cached !== undefined) return cached;
  const path = fileURLToPath(new URL("../assets/layout-check.js", import.meta.url));
  try {
    cached = await readFile(path, "utf8");
    return cached;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`layout-check.js not found (${path})`);
    }
    throw error;
  }
}

/** Mirror legacy slide_studio/check.py at 5075930: remove ESM export markers and evaluate the function. */
export function layoutExpression(source: string, options: Record<string, unknown>): string {
  const body = source.replace(/^export /gm, "");
  return `(() => {\n${body}\nreturn layoutIssues(${JSON.stringify(options)});\n})()`;
}
