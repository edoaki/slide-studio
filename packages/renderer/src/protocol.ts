export const STUDIO_RENDER_SCHEME = "studio-render";
export const ENTRY_URL = "studio-render://bundle/index.html";

export type RenderUrlKind = "entry" | "embedded" | "blocked";

/**
 * The render session accepts the exact in-memory entry document and assets that
 * are already embedded in it. Everything else (files, network, other paths) is
 * rejected before it reaches a resolver.
 */
export function classifyRenderUrl(raw: string): RenderUrlKind {
  if (raw.length === 0 || raw !== raw.trim()) return "blocked";
  const colon = raw.indexOf(":");
  if (colon <= 0) return "blocked";
  const scheme = raw.slice(0, colon).toLowerCase();

  if (scheme === "data" || scheme === "blob") return "embedded";
  if (scheme === "about") {
    const target = raw.slice(colon + 1);
    return target === "blank" || target === "srcdoc" ? "embedded" : "blocked";
  }
  if (scheme !== STUDIO_RENDER_SCHEME) return "blocked";

  // Exact equality also rejects credentials, ports, query strings, and any
  // parsing difference between Node and Chromium for this scheme.
  return raw === ENTRY_URL ? "entry" : "blocked";
}

export function isAllowedRenderUrl(raw: string): boolean {
  return classifyRenderUrl(raw) !== "blocked";
}

export { BUNDLE_CSP as RENDER_CSP } from "../../core/src/bundle-policy.js";
