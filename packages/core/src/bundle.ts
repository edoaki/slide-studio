import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import * as cheerio from "cheerio";
import type { Diagnostic } from "../../contracts/src/desktop.js";
import { CoreError } from "./errors.js";
import { resolveAssetInside } from "./paths.js";

const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 12;

const MODULE_SPEC = /^([ \t]*(?:import[ \t]*|(?:import|export)\b[^;'"()=]*?\bfrom[ \t]*))(['"])([^'"\n]+)\2/gmu;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/giu;
const CSS_IMPORT = /@import\b[^;]*(?:;|$)/giu;

const MIME: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".htm": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface BundleResult {
  html: string;
  warnings: Diagnostic[];
}

function isExternalReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("//")) return true;
  if (/^(?:data|blob|about):/iu.test(trimmed)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed);
}

function isSpecialReference(value: string): boolean {
  return value === "" || value.startsWith("#") || /^(?:data|blob|about):/iu.test(value);
}

function mimeType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function dataUri(path: string, bytes: Buffer): string {
  return `data:${mimeType(path)};base64,${bytes.toString("base64")}`;
}

export function bundleHtml(html: string, baseDirectory: string, rootReal: string): BundleResult {
  const bundler = new Bundler(rootReal);
  return { html: bundler.bundle(html, baseDirectory), warnings: bundler.warnings };
}

/** Resolve a stylesheet's url() references against that stylesheet's own directory. */
export function bundleCss(css: string, baseDirectory: string, boundaryReal: string): BundleResult {
  const bundler = new Bundler(boundaryReal);
  return { html: escapeStyleText(bundler.css(css, baseDirectory)), warnings: bundler.warnings };
}

function escapeScriptText(value: string): string {
  return value.replace(/<\/script/giu, "<\\/script");
}

function escapeStyleText(value: string): string {
  return value.replace(/<\/style/giu, "<\\/style");
}

class Bundler {
  readonly #root: string;
  readonly #warnings: Diagnostic[] = [];
  #totalBytes = 0;

  constructor(root: string) {
    this.#root = root;
  }

  get warnings(): Diagnostic[] {
    return this.#warnings;
  }

  bundle(html: string, baseDirectory: string): string {
    return this.#soup(html, baseDirectory, 0, []);
  }

  css(css: string, baseDirectory: string): string {
    return this.#css(css, baseDirectory, 0, []);
  }

  #warn(code: string, message: string): void {
    this.#warnings.push({ code, severity: "warning", message });
  }

  #read(path: string): Buffer {
    const stat = statSync(path);
    if (!stat.isFile()) {
      throw new CoreError("NOT_FOUND", `asset is not a file: ${path}`);
    }
    const size = stat.size;
    if (size > MAX_ASSET_BYTES) {
      throw new CoreError("INVALID_INPUT", `asset exceeds the per-file limit: ${path}`);
    }
    this.#totalBytes += size;
    if (this.#totalBytes > MAX_TOTAL_BYTES) {
      throw new CoreError("INVALID_INPUT", "bundled assets exceed the workspace size limit");
    }
    return readFileSync(path);
  }

  #local(baseDirectory: string, value: string, missingCode: string): { path: string; bytes: Buffer } | null {
    try {
      const path = resolveAssetInside(this.#root, baseDirectory, value);
      return { path, bytes: this.#read(path) };
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND") {
        this.#warn(missingCode, `Local asset was not found: ${value}`);
        return null;
      }
      throw error;
    }
  }

  #css(css: string, baseDirectory: string, depth: number, stack: string[]): string {
    const withoutImports = css.replace(CSS_IMPORT, (match) => {
      this.#warn("CSS_IMPORT", `CSS @import is not supported and was removed: ${match.trim()}`);
      return "";
    });
    return withoutImports.replace(CSS_URL, (match, _quote: string, raw: string) => {
      const value = raw.trim();
      if (isSpecialReference(value)) return match;
      if (isExternalReference(value)) {
        this.#warn("EXTERNAL_ASSET", `External CSS asset was blocked: ${value}`);
        return 'url("")';
      }
      const local = this.#local(baseDirectory, value, "MISSING_ASSET");
      return local ? `url("${dataUri(local.path, local.bytes)}")` : 'url("")';
    });
  }

  #moduleSource(code: string, baseDirectory: string, depth: number, stack: string[]): string {
    if (depth > MAX_DEPTH) {
      throw new CoreError("INVALID_INPUT", "module import nesting is too deep");
    }
    if (/\bimport\s*\(/u.test(code)) {
      this.#warn("DYNAMIC_IMPORT", "Dynamic import() is not bundled and may not work offline.");
    }
    return code.replace(MODULE_SPEC, (match: string, pre: string, quote: string, spec: string) => {
      if (spec.startsWith("data:")) return match;
      if (!spec.startsWith(".")) {
        this.#warn("EXTERNAL_MODULE", `Non-relative module import was not bundled: ${spec}`);
        return match;
      }
      let local: { path: string; bytes: Buffer } | null;
      try {
        local = this.#local(baseDirectory, spec, "MISSING_ASSET");
      } catch (error) {
        if (error instanceof CoreError && error.code === "OUTSIDE_ROOT") throw error;
        throw error;
      }
      if (!local) return match;
      if (stack.includes(local.path)) {
        throw new CoreError("INVALID_INPUT", `module import cycle: ${local.path}`);
      }
      const inner = this.#moduleSource(
        local.bytes.toString("utf8"),
        dirname(local.path),
        depth + 1,
        [...stack, local.path],
      );
      return `${pre}${quote}data:text/javascript;base64,${Buffer.from(inner, "utf8").toString("base64")}${quote}`;
    });
  }

  #soup(html: string, baseDirectory: string, depth: number, stack: string[]): string {
    if (depth > MAX_DEPTH) {
      throw new CoreError("INVALID_INPUT", "embedded document nesting is too deep");
    }
    const $ = cheerio.load(html);

    $("script[src]").each((_index, element) => {
      const node = $(element);
      const src = node.attr("src") ?? "";
      if (!src) {
        node.removeAttr("src");
        return;
      }
      if (isExternalReference(src)) {
        this.#warn("EXTERNAL_ASSET", `External script was blocked: ${src}`);
        node.remove();
        return;
      }
      const local = this.#local(baseDirectory, src, "MISSING_ASSET");
      if (!local) {
        node.removeAttr("src");
        return;
      }
      if (stack.includes(local.path)) {
        throw new CoreError("INVALID_INPUT", `script cycle: ${local.path}`);
      }
      const source = local.bytes.toString("utf8");
      const isModule = node.attr("type") === "module";
      const processed = isModule
        ? this.#moduleSource(source, dirname(local.path), depth + 1, [...stack, local.path])
        : source;
      node.text(escapeScriptText(processed));
      if (isModule) node.attr("data-ss-bundled", "true");
      node.removeAttr("src");
      node.removeAttr("integrity");
      node.removeAttr("crossorigin");
    });

    $("script[type='module']:not([src])").each((_index, element) => {
      const node = $(element);
      if (node.attr("data-ss-bundled") !== undefined) {
        node.removeAttr("data-ss-bundled");
        return;
      }
      const source = node.html() ?? node.text();
      node.text(escapeScriptText(this.#moduleSource(source, baseDirectory, depth + 1, stack)));
    });

    $('link[rel="stylesheet"]').each((_index, element) => {
      const node = $(element);
      const href = node.attr("href") ?? "";
      if (!href || isSpecialReference(href)) {
        node.remove();
        return;
      }
      if (isExternalReference(href)) {
        this.#warn("EXTERNAL_ASSET", `External stylesheet was blocked: ${href}`);
        node.remove();
        return;
      }
      const local = this.#local(baseDirectory, href, "MISSING_ASSET");
      if (!local) {
        node.remove();
        return;
      }
      const style = $("<style></style>");
      const id = node.attr("id");
      if (id) style.attr("id", id);
      const media = node.attr("media");
      if (media) style.attr("media", media);
      style.text(escapeStyleText(
        this.#css(local.bytes.toString("utf8"), dirname(local.path), depth + 1, [...stack, local.path]),
      ));
      style.attr("data-ss-bundled", "true");
      node.replaceWith(style);
    });

    $("img[src], source[src], video[src], audio[src]").each((_index, element) => {
      const node = $(element);
      const src = node.attr("src") ?? "";
      if (!src) {
        node.removeAttr("src");
        return;
      }
      if (isSpecialReference(src)) return;
      if (isExternalReference(src)) {
        this.#warn("EXTERNAL_ASSET", `External media was blocked: ${src}`);
        node.removeAttr("src");
        return;
      }
      const local = this.#local(baseDirectory, src, "MISSING_ASSET");
      if (!local) {
        node.removeAttr("src");
        return;
      }
      node.attr("src", dataUri(local.path, local.bytes));
    });

    $("iframe[src]").each((_index, element) => {
      const node = $(element);
      const src = node.attr("src") ?? "";
      if (!src) {
        node.removeAttr("src");
        return;
      }
      if (isSpecialReference(src)) return;
      if (isExternalReference(src)) {
        this.#warn("EXTERNAL_ASSET", `External iframe was blocked: ${src}`);
        node.removeAttr("src");
        return;
      }
      const local = this.#local(baseDirectory, src, "MISSING_FIGURE");
      if (!local) {
        node.removeAttr("src");
        node.attr("srcdoc", `<!doctype html><html><body><p>Missing figure: ${escapeHtml(src)}</p></body></html>`);
        return;
      }
      if (stack.includes(local.path)) {
        throw new CoreError("INVALID_INPUT", `iframe cycle: ${local.path}`);
      }
      const child = this.#soup(
        local.bytes.toString("utf8"),
        dirname(local.path),
        depth + 1,
        [...stack, local.path],
      );
      node.attr("srcdoc", child);
      node.removeAttr("src");
      node.attr("tabindex", "-1");
    });

    $("object[data]").each((_index, element) => {
      const node = $(element);
      const src = node.attr("data") ?? "";
      if (!src) {
        node.remove();
        return;
      }
      if (isSpecialReference(src)) return;
      if (isExternalReference(src)) {
        this.#warn("EXTERNAL_ASSET", `External object was blocked: ${src}`);
        node.remove();
        return;
      }
      const local = this.#local(baseDirectory, src, "MISSING_ASSET");
      if (!local) {
        node.remove();
        return;
      }
      node.attr("data", dataUri(local.path, local.bytes));
    });

    $("[srcset]").each((_index, element) => {
      this.#warn("SRCSET_UNSUPPORTED", "srcset is not bundled; use a single src attribute.");
      $(element).removeAttr("srcset");
    });

    $("style").each((_index, element) => {
      const node = $(element);
      if (node.attr("data-ss-bundled") !== undefined) {
        node.removeAttr("data-ss-bundled");
        return;
      }
      node.text(escapeStyleText(this.#css(node.text(), baseDirectory, depth + 1, stack)));
    });

    $("[style]").each((_index, element) => {
      const node = $(element);
      node.attr("style", this.#css(node.attr("style") ?? "", baseDirectory, depth + 1, stack));
    });

    return $.html();
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function assetBasename(path: string): string {
  return basename(path);
}
