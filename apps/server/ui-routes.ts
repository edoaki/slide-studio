import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { adminCsp, contentTypeFor, sendApiError, sendEmpty } from "./http.js";
import { WEB_FILES } from "./web-files.js";

function uiFile(pathname: string): string | undefined {
  if (!pathname.startsWith("/web/")) return pathname === "/location" ? "location.html" : "app.html";
  try {
    const name = decodeURIComponent(pathname.slice("/web/".length));
    const parts = name.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || part.includes("\\"))) return;
    if (WEB_FILES.includes(name)) return name;
  } catch {
    // Malformed URL escapes do not identify a bundled file.
  }
}

export async function serveUi(
  request: IncomingMessage, response: ServerResponse, pathname: string, uiDirectory: string, contentOrigin: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendEmpty(response, 405);
    return;
  }
  const file = uiFile(pathname);
  if (!file) {
    sendApiError(response, 404, "not found");
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(join(uiDirectory, file));
  } catch {
    sendApiError(response, 404, "not found");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypeFor(file),
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": adminCsp(contentOrigin),
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}
