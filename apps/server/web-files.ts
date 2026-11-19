import { load as loadHtml } from "cheerio";

export const DEFAULT_MAX_UPLOAD_BODY_BYTES = 64 * 1024 * 1024;
export const PREVIEW_FILE = "__slide-studio_preview__.html";

export interface FeatureRoute {
  name: string;
  methods: readonly string[];
  pattern: RegExp;
  /** Optional per-route request limit. Upload routes may exceed the JSON limit. */
  bodyLimit?: number;
}

/** Allowed UI assets served under `/web`. Unknown files are never served. */
export const LEGACY_WEB_FILES: readonly string[] = Object.freeze([
  "bridge/agent-client.js", "bridge/protocol.js", "bridge/theme-contract.js",
  "agents.js", "ai-model.js", "api.js", "app.css", "app.html", "app.js",
  "asset-preview.js", "assets.js", "bib-view.js", "bibliography.js",
  "block-design.js", "block-drag.js", "block-handles.js", "block-nav.js",
  "block-ops.js", "block-context-menu.js", "block-context-model.js", "blocks.js", "chat.js", "checks.js", "clipboard.js",
  "color-picker.js", "cover-authors.js", "cover-form.js", "decoration.js",
  "editor.js", "external-links.js", "history.js",
  "home-updates.js", "home-list.js", "home-trash.js", "home-ai.js", "home-manage.js", "home.js", "icons.js", "inject/edit.css",
  "inject/layout-check.js", "inject/link.js",
  "slide-library.js", "slide-insertion.js", "insert.js", "layout-lint.js", "left-tabs.js",
  "link-input.js", "location.css", "location.html", "location.js",
  "materials.js", "memo.js", "overview.js", "output.js", "page-reorder.js",
  "page-strip.js", "page-operations.js", "source-prose.js", "page-actions.js", "page-templates.js", "pdf-step.js", "present.js", "preview.js",
  "presenter.js", "presentation-model.js", "speaker-notes.js", "projection.html", "projection.js", "presenter.css",
  "manuscript-search.js", "manuscript-search-model.js", "qmd-scan.js", "qmd-blocks.js", "qmd-editor.js", "scroll-anchor.js", "shared.css",
  "settings.js", "settings.css", "preferences.js",
  "shot-thumbs.js", "step-badge.js", "structure.js", "strings.js",
  "table-tools.js", "text-format.js", "text-tools.js", "theme-tab.js",
  "themes.js", "tip.js", "toc-settings.js", "topic.js",
]);

export const IMPLEMENTED_FEATURES: readonly string[] = Object.freeze([
  "home", "env", "new-deck", "new-topic", "deck-read", "deck-source",
  "memo", "style", "structure", "events", "preview", "theme-preview",
  "open-external", "chunks", "warning-issues", "merge3",
  "block-design-migrate", "themes", "materials", "assets", "library", "math", "bibliography", "bib",
  "ai", "chat", "setup", "home-manage", "topic", "location", "inject", "hooks/locks", "edit-scope",
  "location-token", "pandoc-lifecycle", "content-origin-secret", "will-frame-navigate",
]);

export const FEATURE_ROUTES: readonly FeatureRoute[] = Object.freeze([
  { name: "slide-search", methods: ["GET"], pattern: /^\/api\/slides\/search$/u },
  { name: "slide-take", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/slides\/take$/u },
  { name: "topic", methods: ["GET"], pattern: /^\/api\/topic\/[^/]+$/u },
  { name: "topic", methods: ["POST"], pattern: /^\/api\/topic\/[^/]+\/html\/delete$/u },
  { name: "topic", methods: ["DELETE"], pattern: /^\/api\/topic\/[^/]+$/u },
  { name: "setup", methods: ["POST"], pattern: /^\/api\/setup$/u },
  { name: "download", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/download\/[^/]+$/u },
  { name: "chunks", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/chunks$/u },
  { name: "assets", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/assets$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "assets", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/assets\/[^/]+$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "materials", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/materials$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "materials", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/materials\/read$/u },
  { name: "materials", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/materials\/[^/]+$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "library", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/library$/u, bodyLimit: DEFAULT_MAX_UPLOAD_BODY_BYTES },
  { name: "bibliography", methods: ["POST"], pattern: /^\/api\/topic\/[^/]+\/bib\/verify$/u },
  { name: "bibliography", methods: ["PATCH"], pattern: /^\/api\/topic\/[^/]+\/bib$/u },
  { name: "bibliography", methods: ["GET", "POST", "PATCH"], pattern: /^\/api\/deck\/[^/]+\/bib$/u },
  { name: "math", methods: ["POST"], pattern: /^\/api\/math$/u },
  { name: "checks", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/checks$/u },
  { name: "shots", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/shots$/u },
  { name: "shots", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/shots\/priority$/u },
  { name: "themes", methods: ["GET", "POST"], pattern: /^\/api\/themes$/u },
  { name: "themes", methods: ["POST"], pattern: /^\/api\/themes\/select$/u },
  { name: "themes", methods: ["GET", "PUT", "DELETE"], pattern: /^\/api\/themes\/[^/]+$/u },
  { name: "ai", methods: ["GET"], pattern: /^\/api\/ai\/status$/u },
  { name: "ai", methods: ["GET"], pattern: /^\/api\/ai\/roles$/u },
  { name: "ai", methods: ["PUT"], pattern: /^\/api\/ai\/roles\/[^/]+\/extra$/u },
  { name: "ai", methods: ["GET"], pattern: /^\/api\/ai\/runtimes$/u },
  { name: "ai", methods: ["GET", "POST"], pattern: /^\/api\/ai\/[^/]+\/login$/u },
  { name: "ai", methods: ["POST"], pattern: /^\/api\/ai\/[^/]+\/runtime$/u },
  { name: "ai", methods: ["PUT"], pattern: /^\/api\/ai\/favorites$/u },
  { name: "chat", methods: ["GET"], pattern: /^\/api\/deck\/[^/]+\/chat$/u },
  { name: "chat", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/open$/u },
  { name: "chat", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/tabs$/u },
  { name: "chat", methods: ["PATCH"], pattern: /^\/api\/deck\/[^/]+\/chat\/tabs\/[^/]+$/u },
  { name: "chat", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/tabs\/[^/]+\/send$/u },
  { name: "chat", methods: ["POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/rounds\/[^/]+\/(?:continue|cancel|handoff)$/u },
  { name: "chat", methods: ["GET", "POST"], pattern: /^\/api\/deck\/[^/]+\/chat\/rounds\/[^/]+\/restore$/u },
  { name: "home-manage", methods: ["POST"], pattern: /^\/api\/home\/manage$/u },
]);

export function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

export function injectPreview(
  html: string,
  input: {
    adminOrigin: string;
    contentOrigin: string;
    deck: string;
    version: string;
    generation: string;
    mode: "edit" | "present";
  },
): string {
  const $ = loadHtml(html, null, true);

  const flags: string[] = [
    `window.__slideStudioDeck=${scriptJson(input.deck)};`,
    `window.__slideStudioVersion=${scriptJson(input.version)};`,
    "window.__slideStudioNoHash=true;",
  ];
  if (input.mode !== "present") {
    flags.push("window.__slideStudioFill=true;");
    flags.push("window.__slideStudioNoOverview=true;");
  }
  const injected = [
    `<script data-studio-admin-origin="${escapeAttribute(input.adminOrigin)}"`
      + ` data-studio-deck="${escapeAttribute(input.deck)}"`
      + ` data-studio-version="${escapeAttribute(input.version)}"`
      + ` data-studio-generation="${escapeAttribute(input.generation)}"`
      + ` data-studio-mode="${input.mode}"`
      + ` src="${escapeAttribute(input.contentOrigin)}/bridge/frame-agent.classic.js"></script>`,
    `<script>${flags.join("")}</script>`,
  ].join("");

  $("head").prepend(injected);
  if (input.mode === "edit") {
    $("head").append(`<link rel="stylesheet" href="${escapeAttribute(input.contentOrigin)}/bridge/edit.css">`);
  }
  const serialized = $.html();
  return typeof serialized === "string" ? serialized : "";
}

export function isShellPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/agents" || pathname === "/location") return true;
  if (/^\/deck\/[^/]+$/u.test(pathname)) return true;
  if (/^\/topic\/[^/]+$/u.test(pathname)) return true;
  if (pathname.startsWith("/figure/")) return true;
  return false;
}

export function matchesFeature(method: string, pathname: string): FeatureRoute | null {
  const effective = method === "HEAD" ? "GET" : method;
  for (const route of FEATURE_ROUTES) {
    if (!route.methods.includes(effective)) continue;
    if (route.pattern.test(pathname)) return route;
  }
  return null;
}
