import type { IncomingMessage, ServerResponse } from "node:http";
import { open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isInsideRoot } from "../../packages/core/src/paths.js";
import type { LegacyWorkspace, PreviewCapability } from "./host-types.js";
import {
  contentCsp,
  contentTypeFor,
  decodeName,
  decodeSegment,
  fileScope,
  headerValue,
  isPublicSegment,
  parseRange,
  sendEmpty,
} from "./http.js";
import { injectPreview, PREVIEW_FILE } from "./web-files.js";

export interface ContentHandlerDeps {
  uiDirectory: string;
  getAdminOrigin: () => string;
  getContentOrigin: () => string;
  getWorkspace: () => LegacyWorkspace;
  hostMatches: (request: IncomingMessage, origin: string) => boolean;
  touchCapability: (code: string) => PreviewCapability | undefined;
  readThemeCss: (ws: LegacyWorkspace, name: string) => Promise<Buffer | null>;
}

async function handleContentStatic(
  request: IncomingMessage,
  response: ServerResponse,
  ws: LegacyWorkspace,
  pathname: string,
  rangeHeader: string | undefined,
  adminOrigin: string,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice("/files/".length));
  } catch {
    sendEmpty(response, 404);
    return;
  }
  if (decoded.includes("\0")) {
    sendEmpty(response, 404);
    return;
  }
  const parts = decoded.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) {
    sendEmpty(response, 404);
    return;
  }
  const scope = fileScope(parts);
  if (scope === null) {
    sendEmpty(response, 404);
    return;
  }
  const lexicalRoot = resolve(ws.root);
  const candidate = resolve(lexicalRoot, ...parts);
  if (!isInsideRoot(lexicalRoot, candidate)) {
    sendEmpty(response, 404);
    return;
  }
  let rootReal: string;
  let scopeReal: string;
  let fileReal: string;
  try {
    rootReal = await realpath(lexicalRoot);
    scopeReal = await realpath(resolve(rootReal, ...scope));
    fileReal = await realpath(candidate);
  } catch {
    sendEmpty(response, 404);
    return;
  }
  if (
    !isInsideRoot(rootReal, scopeReal)
    || !isInsideRoot(rootReal, fileReal)
    || !isInsideRoot(scopeReal, fileReal)
  ) {
    sendEmpty(response, 404);
    return;
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(fileReal, "r");
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      sendEmpty(response, 404);
      return;
    }
    const range = parseRange(rangeHeader, info.size);
    if (range === "invalid") {
      await handle.close();
      sendEmpty(response, 416, {
        "content-range": `bytes */${info.size}`,
        "accept-ranges": "bytes",
      });
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, info.size - 1);
    const length = info.size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = {
      "content-type": contentTypeFor(fileReal),
      "content-length": String(length),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": contentCsp(adminOrigin),
    };
    if (range !== null) headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
    response.writeHead(range === null ? 200 : 206, headers);
    if (request.method === "HEAD" || length === 0) {
      await handle.close();
      response.end();
      return;
    }
    const stream = handle.createReadStream({ start, end, autoClose: true });
    stream.on("error", () => {
      if (!response.destroyed) response.destroy();
    });
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The descriptor may already be closed by the stream.
      }
    }
    if (!response.headersSent) sendEmpty(response, 404);
  }
}

export function createContentHandler(deps: ContentHandlerDeps) {
  return async function handleContent(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const adminOrigin = deps.getAdminOrigin();
      const contentOrigin = deps.getContentOrigin();
      if (!deps.hostMatches(request, contentOrigin)) {
        sendEmpty(response, 403);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendEmpty(response, 405);
        return;
      }
      const rawUrl = request.url ?? "/";
      let url: URL;
      try {
        url = new URL(rawUrl, contentOrigin);
      } catch {
        sendEmpty(response, 400);
        return;
      }
      const pathname = url.pathname;
      const ws = deps.getWorkspace();

      const servePreview = (capability: PreviewCapability): void => {
        const html = Buffer.from(injectPreview(capability.html, {
          adminOrigin,
          contentOrigin,
          deck: capability.deck,
          version: capability.version,
          generation: capability.generation,
          mode: capability.mode,
        }), "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(html.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": contentCsp(adminOrigin),
        });
        response.end(request.method === "HEAD" ? undefined : html);
      };

      if (pathname.startsWith("/preview/")) {
        const match = /^\/preview\/([A-Za-z0-9_-]+)$/u.exec(pathname);
        const capability = match === null ? undefined : deps.touchCapability(match[1] as string);
        if (capability === undefined) {
          sendEmpty(response, 404);
          return;
        }
        servePreview(capability);
        return;
      }

      const deckPreview = /^\/files\/decks\/([^/]+)\/__slide-studio_preview__\.html$/u.exec(pathname);
      if (deckPreview) {
        const code = url.searchParams.get("c");
        const capability = code === null ? undefined : deps.touchCapability(code);
        if (capability === undefined || capability.kind !== "deck") {
          sendEmpty(response, 404);
          return;
        }
        let deck: string;
        try {
          deck = decodeName(deckPreview[1] as string, "発表名");
        } catch {
          sendEmpty(response, 404);
          return;
        }
        if (deck !== capability.deck) {
          sendEmpty(response, 404);
          return;
        }
        servePreview(capability);
        return;
      }
      if (pathname === `/files/themes/${PREVIEW_FILE}`) {
        const code = url.searchParams.get("c");
        const capability = code === null ? undefined : deps.touchCapability(code);
        if (capability === undefined || capability.kind !== "theme") {
          sendEmpty(response, 404);
          return;
        }
        servePreview(capability);
        return;
      }

      const themeMatch = /^\/theme\/([^/]+)\.css$/u.exec(pathname);
      if (themeMatch) {
        const name = decodeName(themeMatch[1] as string, "テーマ名");
        const css = await deps.readThemeCss(ws, name);
        if (css === null) {
          sendEmpty(response, 404);
          return;
        }
        response.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "content-length": String(css.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(request.method === "HEAD" ? undefined : css);
        return;
      }

      const themeShotMatch = /^\/theme-shots\/([^/]+)\/([0-3]\.png)$/u.exec(pathname);
      const shotMatch = themeShotMatch ?? /^\/shots\/([^/]+)\/([^/]+\.png)$/u.exec(pathname);
      if (shotMatch) {
        let deck: string;
        let file: string;
        try {
          deck = decodeName(shotMatch[1] as string, "発表名");
          file = decodeSegment(shotMatch[2] as string, "画像名");
        } catch {
          sendEmpty(response, 404);
          return;
        }
        if (!isPublicSegment(file)) {
          sendEmpty(response, 404);
          return;
        }
        const rootReal = await realpath(resolve(ws.root));
        const shotRoot = resolve(rootReal, ".slide-studio", themeShotMatch ? "themes" : "shots", deck);
        let shotReal: string;
        let rootScopeReal: string;
        try {
          shotReal = await realpath(resolve(shotRoot, file));
          rootScopeReal = await realpath(shotRoot);
        } catch {
          sendEmpty(response, 404);
          return;
        }
        if (!isInsideRoot(rootReal, rootScopeReal) || !isInsideRoot(rootScopeReal, shotReal)) {
          sendEmpty(response, 404);
          return;
        }
        let bytes: Buffer;
        try {
          bytes = await readFile(shotReal);
        } catch {
          sendEmpty(response, 404);
          return;
        }
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
        return;
      }

      if (pathname === "/bridge/edit.css") {
        const bytes = await readFile(join(deps.uiDirectory, "inject", "edit.css"));
        response.writeHead(200, {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
        return;
      }
      if (pathname === "/bridge/frame-agent.classic.js") {
        let bytes: Buffer;
        try {
          bytes = await readFile(join(deps.uiDirectory, "bridge", "frame-agent.classic.js"));
        } catch {
          sendEmpty(response, 404);
          return;
        }
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
        return;
      }

      if (pathname.startsWith("/files/")) {
        await handleContentStatic(
          request,
          response,
          ws,
          pathname,
          headerValue(request.headers.range),
          adminOrigin,
        );
        return;
      }

      sendEmpty(response, 404);
    } catch (error) {
      console.error("[server] content request failure", error);
      if (response.headersSent || response.destroyed || response.writableEnded) {
        if (!response.destroyed) response.destroy();
      } else {
        sendEmpty(response, 500);
      }
    }
  };
}
