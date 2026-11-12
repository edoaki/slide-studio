import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

function candidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, "../../../../slide_studio/web/inject/layout-check.js"),
    resolve(process.cwd(), "slide_studio/web/inject/layout-check.js"),
  ];
}

/** Load the existing check.py layout asset, never a rewritten copy. */
export async function loadLayoutSource(): Promise<string> {
  if (cached !== undefined) return cached;
  const tried: string[] = [];
  for (const path of candidates()) {
    tried.push(path);
    try {
      cached = await readFile(path, "utf8");
      return cached;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  throw new Error(`layout-check.js not found (tried ${tried.join(", ")})`);
}

/** Mirror check.py: remove ESM export markers and evaluate the function. */
export function layoutExpression(source: string, options: Record<string, unknown>): string {
  const body = source.replace(/^export /gm, "");
  return `(() => {\n${body}\nreturn layoutIssues(${JSON.stringify(options)});\n})()`;
}
