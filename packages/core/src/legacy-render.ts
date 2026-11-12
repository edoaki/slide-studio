/**
 * Faithful TypeScript port of `.reference/parity/render.py` plus
 * `.reference/parity/steps.py`.
 *
 * The rendered HTML is produced from the exact same wrapped source as the
 * Python implementation, so every chunk marker and every origin-map line is
 * preserved. DOM assembly uses cheerio 1.2 and keeps the legacy shell IDs,
 * section attributes, TOC/reference insertion, chapter/page numbering and
 * citation/footnote footer semantics.
 *
 * Front matter is left intact for metadata (title, author, theme, lang, cover
 * layout). The resource-selecting keys that Pandoc could otherwise honour
 * (`bibliography`, `csl`, `filters`, `resource-path`, `defaults`, include
 * hooks) are neutralised before conversion. Filters are *never* selected from
 * the source; this module only passes the packaged Lua filter.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, relative, sep } from "node:path";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { isMap, parseDocument } from "yaml";
import type {
  LegacyRendered,
  LegacyRenderOptions,
  LegacySlide,
} from "../../contracts/src/legacy.js";
import { assetPath } from "./assets.js";
import { atomicWriteFile } from "./atomic.js";
import {
  authors as coverAuthors,
  html_block as coverHtml,
  pyStr,
  pyStrip,
  pyTruthy,
} from "./legacy-cover.js";
import { require_ready, with_arxiv_venue } from "./legacy-bibliography.js";
import { ensure_index } from "./legacy-figures.js";
import { PandocError, run_pandoc, PANDOC_TIMEOUT_MS } from "./legacy-pandoc.js";
import {
  ATTR_TOKEN,
  codePointLength,
  FENCE_OPEN,
  fig_args,
  parse,
  unsupported,
  wrapped_source,
} from "./legacy-source.js";
import type { Doc, Page } from "./legacy-source.js";
import {
  RUNTIME,
  StudioError,
  figure_title,
} from "./legacy-workspace.js";
import type { Workspace } from "./legacy-workspace.js";

const LUA = assetPath("lua", "slide-studio.lua");
const READER = "markdown+fenced_divs+tex_math_dollars";

const SHELL = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head><body><div class="reveal"><main id="stage" class="slides"></main></div><nav id="toolbar" aria-label="スライド操作"><button id="menu" aria-label="スライド一覧" title="スライド一覧（o）">☰</button><button id="fullscreen" aria-label="全画面" title="全画面（f）">⛶</button></nav><aside id="overview" aria-label="スライド一覧" role="dialog" aria-modal="true" hidden><button id="close">閉じる</button><p id="help">↑↓ ページ · ←→ step · 左右長押しで先頭／最後 · 画面左30%で戻る／それ以外で進む</p></aside></body></html>`;

const PY_SPACE = /[\t\n\v\f\r \x1c-\x1f\x85\p{Z}]/u;

/** Pandoc failed; `message` has had converted line numbers mapped back. */
export class RenderError extends StudioError {
  constructor(message: string) {
    super(message, "RENDER_FAILED");
    this.name = "RenderError";
  }
}

export interface LegacyWarningIssue {
  level: string;
  kind: string;
  message: string;
  attribute?: string;
  value?: string;
  source_offset?: number;
  source_line?: number;
  page?: number | null;
  slide?: number | null;
}

function isPySpace(character: string): boolean {
  return PY_SPACE.test(character);
}

function pySplitWhitespace(value: string): string[] {
  const output: string[] = [];
  let current = "";
  for (const character of value) {
    if (isPySpace(character)) {
      if (current) {
        output.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current) output.push(current);
  return output;
}

function cpToUtf16(value: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= codePointLength(value)) return value.length;
  let codePoints = 0;
  let position = 0;
  while (position < value.length) {
    if (codePoints >= index) return position;
    const code = value.codePointAt(position)!;
    position += code > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  return value.length;
}

function cpSlice(value: string, start: number, end: number): string {
  if (start <= 0 && end >= codePointLength(value)) return value;
  return value.slice(cpToUtf16(value, start), cpToUtf16(value, end));
}

function _map_lines(message: string, origin: Array<number | null>): string {
  return message.replace(/line (\d+)/gu, (_match, digits: string) => {
    const number = Number.parseInt(digits, 10);
    const original = number > 0 && number <= origin.length ? origin[number - 1] : null;
    return original ? `line ${original}` : `line ?（変換用の ${number} 行目）`;
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function classList(node: unknown): string[] {
  if (typeof node === "string") return node.split(/\s+/u).filter(Boolean);
  const value = (node as { attribs?: Record<string, string> } | null)?.attribs?.class;
  return (value ?? "").split(/\s+/u).filter(Boolean);
}

function isTagNode(node: any): boolean {
  return node !== null
    && typeof node === "object"
    && node.type !== "text"
    && node.type !== "comment"
    && typeof node.tagName === "string";
}

function isHeadingNode(node: any): boolean {
  return isTagNode(node) && (node.tagName === "h1" || node.tagName === "h2");
}

function collectText(node: any, output: string[]): void {
  if (node === null || typeof node !== "object") return;
  if (node.type === "text") {
    output.push(String(node.data ?? ""));
    return;
  }
  for (const child of node.children ?? []) collectText(child, output);
}

function bsText(node: any): string {
  const output: string[] = [];
  collectText(node, output);
  return output.join("");
}

/** BeautifulSoup's `get_text(separator, strip=True)` semantics. */
function bsGetText(node: any, separator = "", strip = false): string {
  const output: string[] = [];
  const visit = (value: any): void => {
    if (value === null || typeof value !== "object") return;
    if (value.type === "text") {
      const text = String(value.data ?? "");
      if (strip) {
        const trimmed = text.trim();
        if (trimmed.length) output.push(trimmed);
      } else {
        output.push(text);
      }
      return;
    }
    for (const child of value.children ?? []) visit(child);
  };
  visit(node);
  return output.join(separator);
}

function parseStep(value: unknown): number {
  const text = String(value ?? "1").trim();
  if (!/^[+-]?\d+$/u.test(text)) return 1;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
}

function expandIncremental($: CheerioAPI, root: any): void {
  for (const wrapper of root.find(".incremental").toArray() as any[]) {
    if ($(wrapper).parents(".incremental").length > 0) continue;
    const start = parseStep($(wrapper).attr("data-step"));
    let offset = 0;
    for (const item of $(wrapper).find("li").toArray() as any[]) {
      let parent = $(item).parent();
      let nested = false;
      while (parent.length > 0 && parent.get(0) !== wrapper) {
        if (String((parent.get(0) as any).tagName).toLowerCase() === "li") {
          nested = true;
          break;
        }
        parent = parent.parent();
      }
      if (nested) continue;
      $(item).attr("data-step", String(start + offset));
      $(item).attr("data-slide-studio-step-generated", "true");
      offset += 1;
    }
  }
}

/**
 * Replace an element with its own children.
 *
 * Cheerio's `unwrap()` follows jQuery and removes the element's *parent*,
 * whereas BeautifulSoup's `Tag.unwrap()` removes the element itself. Using
 * `replaceWith(contents)` keeps all child nodes (including text/whitespace).
 */
function replaceTagWithContents($: CheerioAPI, element: any): void {
  const selection = $(element);
  selection.replaceWith(selection.contents().toArray());
}

function liftImageSteps($: CheerioAPI, root: any): void {
  for (const image of root.find("img[data-step]").toArray() as any[]) {
    const box = $(image).parent();
    if (box.length === 0) continue;
    const tag = String((box.get(0) as any)?.tagName ?? "").toLowerCase();
    if (tag !== "figure" && tag !== "p") continue;
    if (tag === "p") {
      const other = ((box.get(0) as any).children ?? []).some((child: any) => {
        if (child === image) return false;
        return isTagNode(child) || String(child?.data ?? "").trim().length > 0;
      });
      if (other) continue;
    }
    box.attr("data-step", $(image).attr("data-step"));
    $(image).removeAttr("data-step");
  }
}

// ---------------------------------------------------------------- metadata audit

// Only metadata keys that can make Pandoc read a source-chosen local file (or
// load a source-chosen filter). Inline `references` metadata is a legacy
// feature and must be preserved.
const UNSAFE_METADATA_KEYS = new Set([
  "bibliography",
  "citation-abbreviations",
  "csl",
  "filter",
  "filters",
  "metadata-file",
  "defaults",
  "resource-path",
  "include-before-body",
  "include-after-body",
]);
const UNSAFE_METADATA_PATTERN = new RegExp(
  String.raw`^[ \t]*(?:${[...UNSAFE_METADATA_KEYS]
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|")})[ \t]*:`,
  "mu",
);

function unsafeMetadataPresent(front: string): boolean {
  return UNSAFE_METADATA_PATTERN.test(front);
}

/**
 * Keep all ordinary YAML metadata (title, author, theme, lang, cover layout,
 * inline `references`), but blank the values that could make Pandoc read a
 * source-chosen file or run a source-chosen filter. Newlines are preserved so
 * wrapped-source line numbers and origin maps remain valid.
 *
 * This check is fail-closed: if the front matter cannot be inspected while an
 * unsafe key is present, rendering stops instead of passing it through.
 */
function sanitizeFrontMatter(wrapped: string, doc: Doc): string {
  const frontEnd = doc.front[1];
  if (!frontEnd) return wrapped;
  const front = cpSlice(wrapped, 0, frontEnd);
  const match = /^---[ \t]*\n((?:[\s\S]*?\n)?)(?:---|\.\.\.)[ \t]*(?:\n|$)/u.exec(front);
  if (!match) {
    if (unsafeMetadataPresent(front)) {
      throw new RenderError("front matter の安全確認ができません。front matter を確認してください。");
    }
    return wrapped;
  }
  const contentStart = front.indexOf("\n") + 1;
  let sanitized = front;
  try {
    const parsed = parseDocument(match[1] ?? "", { prettyErrors: false });
    if (parsed.errors.length > 0 && unsafeMetadataPresent(front)) {
      throw new RenderError("front matter の安全確認ができません。front matter を確認してください。");
    }
    if (!isMap(parsed.contents)) {
      if (unsafeMetadataPresent(front)) {
        throw new RenderError("front matter の安全確認ができません。front matter を確認してください。");
      }
      return wrapped;
    }
    const map = parsed.contents as any;
    for (const pair of map.items) {
      const name = String(pair?.key?.value ?? "");
      if (!UNSAFE_METADATA_KEYS.has(name)) continue;
      if (pair?.value === null || pair?.value === undefined) continue;
      const range = pair.value.range;
      if (!Array.isArray(range) || range.length < 2) {
        throw new RenderError(
          `front matter の ${name} を安全に確認できません。front matter を確認してください。`,
        );
      }
      const start = contentStart + Number(range[0]);
      const end = contentStart + Number(range[1]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        throw new RenderError(
          `front matter の ${name} を安全に確認できません。front matter を確認してください。`,
        );
      }
      const value = sanitized.slice(start, end);
      sanitized = sanitized.slice(0, start)
        + value.replace(/[^\r\n]/gu, " ")
        + sanitized.slice(end);
    }
  } catch (error) {
    if (error instanceof RenderError) throw error;
    if (unsafeMetadataPresent(front)) {
      throw new RenderError("front matter の安全確認ができません。front matter を確認してください。");
    }
    return wrapped;
  }
  return sanitized + cpSlice(wrapped, frontEnd, codePointLength(wrapped));
}

// ---------------------------------------------------------------- Pandoc

async function runLegacyPandoc(
  text: string,
  cwd: string,
  extra: string[],
  origin: Array<number | null>,
  pandocPath: string,
): Promise<{ stdout: string; stderr: string }> {
  const args = ["--from", READER, "--to", "html5", "--mathml", "--wrap=none", ...extra];
  try {
    return await run_pandoc(text, args, {
      pandocPath,
      cwd,
      timeoutMs: PANDOC_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof PandocError) {
      const message = error.stderr.trim() || "Pandoc の変換に失敗しました";
      throw new RenderError(_map_lines(message, origin));
    }
    throw error;
  }
}

async function citeprocBibliography(
  ws: Workspace,
  deck: string,
  bib: string,
): Promise<string> {
  const original = readFileSync(bib, "utf8");
  const shown = with_arxiv_venue(original);
  if (shown === original) return bib;
  const path = join(ws.build_dir(deck), "citeproc.bib");
  mkdirSync(dirname(path), { recursive: true });
  await atomicWriteFile(path, shown, 0o666 & ~process.umask());
  return path;
}

function figExists(ws: Workspace, ref: string, deck: string): boolean {
  try {
    return existsSync(join(ws.figure_dir(ref, deck), "figure.mjs"));
  } catch {
    return false;
  }
}

async function ensureFigurePages(ws: Workspace, deck: string, doc: Doc): Promise<void> {
  for (const page of doc.pages) {
    for (const chunk of page.walk()) {
      if (chunk.kind !== "fig") continue;
      const args = fig_args(cpSlice(doc.text, chunk.start, chunk.end));
      const ref = args?.ref;
      if (ref && figExists(ws, ref, deck)) {
        await ensure_index(ws.figure_dir(ref, deck), ws);
      }
    }
  }
}

// ---------------------------------------------------------------- assembly

function assemble(
  ws: Workspace,
  deck: string,
  doc: Doc,
  body: string,
  missing: string[],
): LegacyRendered {
  const folder = ws.deck_dir(deck);
  const $ = cheerio.load(`<div id="slide-studio-root">${body}</div>`, null, false);
  const root = $("#slide-studio-root").first();

  if (pyTruthy(doc.meta.topic)) {
    const base = relative(folder, ws.topic_dir(pyStr(doc.meta.topic))).replaceAll(sep, "/");
    for (const image of root.find('img[src]').toArray() as any[]) {
      const src = String($(image).attr("src") ?? "");
      if (src.startsWith("images/")) $(image).attr("src", `${base}/${src}`);
    }
  }

  expandIncremental($, root);
  liftImageSteps($, root);

  const refs = new Map<string, any>();
  const refsRequested = doc.pages.some((page) => page.generated === "refs");
  const refsDiv = root.find("#refs").first();
  if (refsDiv.length > 0) {
    refsDiv.find(".csl-entry").each((_index: number, element: any) => {
      const id = $(element).attr("id");
      if (id !== undefined) refs.set(id, $(element).clone());
    });
    refsDiv.remove();
  }

  const notes = new Map<string, any>();
  const footnoteSection = root.find("section.footnotes").first();
  if (footnoteSection.length > 0) {
    footnoteSection.find("li[id]").each((_index: number, element: any) => {
      const item = $(element);
      item.find("a.footnote-back").remove();
      const id = item.attr("id");
      if (id !== undefined) notes.set(id, item.clone());
    });
    footnoteSection.remove();
  }

  // Remove chunk wrappers, moving data-slide-studio onto the content element
  // so child-combinator CSS keeps working.
  for (const wrapper of root.find("div.slide-studio-c").toArray().reverse() as any[]) {
    const element = $(wrapper);
    const children = element.contents().toArray() as any[];
    const meaningful = children.filter(
      (child) => !(child.type === "text" && String(child.data ?? "").trim() === ""),
    );
    if (meaningful.length > 0 && meaningful.every((child) => isTagNode(child))) {
      const marker = element.attr("data-slide-studio");
      for (const child of meaningful) {
        if (marker !== undefined) $(child).attr("data-slide-studio", marker);
      }
      replaceTagWithContents($, wrapper);
    }
  }

  for (const box of root.find("[data-slide-studio-fig]").toArray() as any[]) {
    const iframe = $(box).find("iframe").first();
    if (iframe.length === 0 || iframe.attr("title")) continue;
    const ref = String($(box).attr("data-slide-studio-fig") ?? "");
    iframe.attr("title", figExists(ws, ref, deck) ? figure_title(ws.figure_dir(ref, deck)) : ref);
  }

  // Page split: top-level h1/h2 map one-to-one to source pages.
  let sections: any[] = [];
  let group = "";
  let current: any = null;
  // BeautifulSoup's `root.children` includes text nodes (notably the
  // whitespace between top-level blocks). Cheerio's `children()` is
  // elements-only, so iterate `contents()` to preserve that whitespace.
  const children = root.contents().toArray() as any[];
  const heads = children.filter((child) => isHeadingNode(child));
  if (heads.length !== doc.pages.length) {
    throw new RenderError(
      `ページの数が合いません（qmd ${doc.pages.length}・変換結果 ${heads.length}）。Slide Studio の不具合です。`,
    );
  }
  let nextPage = 0;
  for (const child of children) {
    if (isHeadingNode(child)) {
      const page = doc.pages[nextPage]!;
      nextPage += 1;
      const isSection = child.tagName === "h1";
      if (isSection) group = bsGetText(child, " ", true);
      const section = $("<section></section>");
      const classes = ["slide", ...classList(child)];
      section.attr("class", classes.join(" "));
      const id = $(child).attr("id");
      if (id) {
        section.attr("id", id);
        $(child).removeAttr("id");
      }
      for (const [key, value] of Object.entries((child.attribs ?? {}) as Record<string, string>)) {
        if (key.startsWith("data-") || key === "style") {
          section.attr(key, String(value));
          $(child).removeAttr(key);
        }
      }
      section.attr("data-page", String(page.index));
      section.removeAttr("data-pdf");
      const pdf = String(page.attrs.kv.pdf ?? "").trim();
      if (pdf) section.attr("data-pdf", pdf);
      section.attr("data-group", group);
      section.attr("data-section-start", isSection ? "true" : "false");
      if (isSection) {
        const updated = classList(section.get(0));
        updated.push("section-slide");
        section.attr("class", updated.join(" "));
      }
      sections.push(section.get(0));
      current = section;
    }
    if (current !== null) current.append($(child));
  }

  sections = sections.filter((section) => !classList(section).includes("toc-off"));

  const people = coverHtml(coverAuthors(doc.meta), doc.meta["cover-authors-layout"] ?? null);
  const firstCover = sections.find((section) => classList(section).includes("cover"));
  if (people && firstCover) $(firstCover).append(people);

  if (!refsRequested) {
    sections = sections.filter((section) => $(section).attr("id") !== "references");
  }
  const entries = [...refs.values()];
  let refAt: number | null = refsRequested
    ? sections.findIndex((section) => $(section).attr("id") === "references")
    : null;
  let appendixAt: number | null = sections.findIndex(
    (section) => $(section).attr("id") === "appendix",
  );
  let refTitle = "参考文献";
  let refPage = "";
  if (refAt !== null && refAt >= 0) {
    const section = sections[refAt]!;
    const heading = $(section).find("h1, h2").first();
    if (heading.length > 0) refTitle = bsGetText(heading.get(0), " ", true);
    refPage = $(section).attr("data-page") ?? "";
    sections.splice(refAt, 1);
    if (appendixAt !== null && appendixAt > refAt) appendixAt -= 1;
  } else {
    refAt = appendixAt !== null && appendixAt >= 0 ? appendixAt : sections.length;
  }

  const refSections: any[] = [];
  const chunks = [entries];
  if (refsRequested) {
    chunks.forEach((part, number) => {
      const section = $("<section></section>");
      section.attr("class", "slide references-slide");
      section.attr("data-group", refTitle);
      section.attr("data-section-start", "false");
      section.attr("data-page", refPage);
      if (number === 0) section.attr("id", "references");
      const heading = $("<h2></h2>");
      heading.text(refTitle + (number ? `（${number + 1}）` : ""));
      section.append(heading);
      if (part.length === 0) {
        section.append($("<p></p>").attr("class", "slide-studio-no-refs").text("引用なし"));
      }
      for (const entry of part) section.append(entry.clone());
      refSections.push(section.get(0));
    });
  }
  if (refAt === null) refAt = sections.length;
  sections.splice(refAt, 0, ...refSections);

  // TOC: chapter pages in manuscript order, or ordinary pages when no chapters.
  const appendix = sections.findIndex((section) => $(section).attr("id") === "appendix");
  const mainSections = sections.slice(0, appendix < 0 ? sections.length : appendix);
  let targets = mainSections.filter((section) =>
    classList(section).includes("section-slide") && $(section).attr("id") !== "appendix");
  if (targets.length === 0) {
    const excluded = new Set(["cover", "toc-slide", "references-slide", "refs-slide"]);
    targets = mainSections.filter((section) => {
      const classes = classList(section);
      const id = $(section).attr("id") ?? "";
      return !classes.some((name) => excluded.has(name))
        && id !== "references"
        && id !== "appendix";
    });
  }
  for (const section of sections) {
    if (!classList(section).includes("toc-slide")) continue;
    const listing = $("<ol></ol>").attr("class", "toc-list");
    targets.forEach((target, number) => {
      const item = $("<li></li>");
      item.append($("<span></span>").attr("class", "toc-number").text(
        String(number + 1).padStart(2, "0"),
      ));
      const title = $(target).find("h1, h2").first();
      item.append($("<span></span>").attr("class", "toc-label").text(
        title.length > 0 ? bsGetText(title.get(0), " ", true) : "",
      ));
      listing.append(item);
    });
    $(section).append(listing);
  }

  let chapter = 0;
  const cited: string[] = [];
  sections.forEach((section, index) => {
    const classes = classList(section);
    if (classes.includes("section-slide") && index < mainSections.length) {
      chapter += 1;
      const number = String(chapter).padStart(2, "0");
      $(section).attr("data-chapter", number);
      const heading = $(section).find("h1").first();
      if (heading.length > 0) {
        heading.prepend($("<span></span>").attr("class", "chapter-number").attr("data-chapter", number));
      }
    }

    const footer = $("<footer></footer>").attr("class", "citations");
    for (const small of $(section).find(".footnote-small").toArray() as any[]) {
      if ($(small).parents(".footnote-small").length === 0) footer.append($(small));
    }

    const seen = new Set<string>();
    for (const citation of $(section).find("[data-cites]").toArray() as any[]) {
      const keys = String($(citation).attr("data-cites") ?? "").split(/\s+/u).filter(Boolean);
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (!cited.includes(key)) cited.push(key);
        const entry = refs.get(`ref-${key}`);
        const paragraph = $("<p></p>");
        if (entry === undefined) {
          paragraph.attr("class", "slide-studio-missing-cite");
          paragraph.text(`文献が見つかりません: ${key}`);
        } else {
          paragraph.text(pySplitWhitespace(bsText(entry.get(0))).join(" "));
        }
        footer.append(paragraph);
      }
    }

    for (const anchor of $(section).find("a.footnote-ref").toArray() as any[]) {
      const link = $(anchor);
      const href = link.attr("href") ?? "";
      const note = notes.get(href.replace(/^#+/u, ""));
      if (note === undefined) continue;
      const paragraph = $("<p></p>").attr("class", "slide-studio-footnote");
      paragraph.append($("<sup></sup>").text(bsGetText(anchor, "", true)));
      const paragraphs = note.find("p").toArray() as any[];
      const parts = paragraphs.length > 0 ? paragraphs : [note.get(0)];
      for (const part of parts) {
        for (const child of (part?.children ?? []) as any[]) {
          paragraph.append($(child).clone());
        }
      }
      footer.append(paragraph);
      for (const marker of link.find("sup").toArray() as any[]) {
        $(marker).attr("data-slide-studio-footnote", href);
      }
      replaceTagWithContents($, anchor);
    }

    if (footer.contents().length > 0) $(section).append(footer);
    $(section).append(
      $("<span></span>").attr("class", "page-number").text(`${index + 1} / ${sections.length}`),
    );
    for (const anchor of $(section).find('a[role="doc-biblioref"]').toArray() as any[]) {
      replaceTagWithContents($, anchor);
    }
  });

  const shell = cheerio.load(SHELL);
  const titleValue = pyTruthy(doc.meta.title)
    ? doc.meta.title
    : pyTruthy(doc.meta.pagetitle)
      ? doc.meta.pagetitle
      : deck;
  shell("title").text(pyStr(titleValue));

  const base = shell("<style></style>")
    .attr("id", "slide-studio-base")
    .text(readFileSync(join(RUNTIME, "base.css"), "utf8"));
  shell("head").append(base);
  const theme = pyStr(pyTruthy(doc.meta.theme) ? doc.meta.theme : "default");
  shell("head").append(
    shell('<link rel="stylesheet">')
      .attr("id", "slide-studio-theme")
      .attr("href", `../../themes/${theme}.css`),
  );
  if (existsSync(join(folder, "styles", "slides.css"))) {
    shell("head").append(
      shell('<link rel="stylesheet">')
        .attr("id", "slide-studio-deck-style")
        .attr("href", "styles/slides.css"),
    );
  }
  shell("body").attr("data-slide-studio-deck", deck);
  const stage = shell("#stage").first();
  for (const section of sections) stage.append(section);
  for (const anchor of stage.find("a[href]").toArray() as any[]) {
    const link = shell(anchor);
    const href = link.attr("href") ?? "";
    if (href.startsWith("#") || link.attr("download") !== undefined) continue;
    link.attr("target", "_blank");
    link.attr("rel", "noopener");
  }
  shell("body").append(
    shell("<script></script>")
      .attr("id", "slide-studio-player")
      .text(readFileSync(join(RUNTIME, "player.js"), "utf8")),
  );

  const slides: LegacySlide[] = [];
  sections.forEach((section, index) => {
    const element = $(section);
    const heading = element.find("h1, h2").first();
    const level: 1 | 2 = classList(section).includes("section-slide") ? 1 : 2;
    const pageText = element.attr("data-page") ?? "";
    const page = pageText ? Number.parseInt(pageText, 10) : null;
    slides.push({
      index,
      page: page !== null && Number.isFinite(page) ? page : null,
      id: element.attr("id") ?? "",
      title: heading.length > 0 ? bsGetText(heading.get(0), " ", true) : "",
      level,
      figures: element.find("[data-slide-studio-fig]").toArray().map((box: any) =>
        String($(box).attr("data-slide-studio-fig") ?? "")),
    });
  });

  return {
    html: shell.html(),
    slides,
    doc,
    version: createHash("sha256").update(doc.text, "utf8").digest("hex"),
    warnings: [],
    missing_cites: missing,
    cited,
    unsupported: unsupported(doc) as unknown as Array<Record<string, unknown>>,
    timing: {},
  };
}

// ---------------------------------------------------------------- public API

export async function render_text(
  ws: Workspace,
  deck: string,
  text: string,
  options: LegacyRenderOptions,
): Promise<LegacyRendered> {
  const folder = ws.deck_dir(deck);
  const started = performance.now();
  const doc = parse(text);
  const [wrapped, origin] = wrapped_source(doc, options.wrap ?? true);
  const safeWrapped = sanitizeFrontMatter(wrapped, doc);

  const extra = [
    "--lua-filter", LUA,
    "--citeproc",
    "--csl", join(RUNTIME, "numeric.csl"),
    "-M", "link-citations=true",
    "-M", "suppress-bibliography=false",
  ];
  await require_ready(ws, deck, doc.meta);
  if (pyTruthy(doc.meta.topic)) {
    extra.push(
      "--resource-path",
      [ws.topic_dir(pyStr(doc.meta.topic)), folder].join(delimiter),
    );
  }
  const bib = ws.bib(deck, doc.meta);
  if (existsSync(bib)) {
    extra.push("--bibliography", await citeprocBibliography(ws, deck, bib));
  }
  await ensureFigurePages(ws, deck, doc);
  const parsed = performance.now();

  const result = await runLegacyPandoc(safeWrapped, folder, extra, origin, options.pandocPath);
  const converted = performance.now();

  const missing = [...new Set(
    [...result.stderr.matchAll(/Citeproc: citation (\S+) not found/gu)]
      .map((match) => match[1]!),
  )].sort();
  const warnings = result.stderr
    .split(/\r\n|\r|\n/u)
    .filter((line) => line.trim() && !line.includes("Citeproc: citation"));

  const rendered = assemble(ws, deck, doc, result.stdout, missing);
  rendered.warnings = warnings.map((warning) => _map_lines(warning, origin));
  rendered.unsupported = unsupported(doc) as unknown as Array<Record<string, unknown>>;
  const assembled = performance.now();
  rendered.timing = {
    parse_ms: round1(parsed - started),
    pandoc_ms: round1(converted - parsed),
    assemble_ms: round1(assembled - converted),
  };
  return rendered;
}

/** Render a deck's `slides.qmd`; an optional text argument mirrors Python. */
export async function render_deck(
  ws: Workspace,
  deck: string,
  options: LegacyRenderOptions,
  text?: string,
): Promise<LegacyRendered> {
  ws.require_deck(deck);
  const source = text ?? readFileSync(ws.qmd(deck), "utf8");
  return render_text(ws, deck, source, options);
}

// ---------------------------------------------------------------- warning locations

class WarningLines {
  readonly starts: number[] = [];
  readonly ends: number[] = [];
  readonly texts: string[] = [];

  constructor(readonly text: string) {
    let position = 0;
    for (const line of text.split("\n")) {
      const length = codePointLength(line);
      this.starts.push(position);
      this.ends.push(position + length);
      this.texts.push(line);
      position += length + 1;
    }
    if (text.endsWith("\n")) {
      this.starts.pop();
      this.ends.pop();
      this.texts.pop();
    }
  }

  get length(): number {
    return this.starts.length;
  }

  line(index: number): string {
    return this.texts[index] ?? "";
  }

  blank(index: number): boolean {
    return pyStrip(this.line(index)).length === 0;
  }

  indexAt(offset: number): number {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.starts[middle]! <= offset) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }
}

function codeMask(lines: WarningLines, first: number): boolean[] {
  const inCode = new Array<boolean>(lines.length).fill(false);
  let index = first;
  while (index < lines.length) {
    const fence = FENCE_OPEN.exec(lines.line(index));
    if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
      const character = fence[1]![0]!;
      const closing = new RegExp(
        `^ {0,3}${character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}{${fence[1]!.length},}[ \\t]*$`,
        "u",
      );
      let close = -1;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (closing.test(lines.line(next))) {
          close = next;
          break;
        }
      }
      if (close >= 0) {
        for (let line = index; line <= close; line += 1) inCode[line] = true;
        index = close + 1;
        continue;
      }
    }
    index += 1;
  }
  return inCode;
}

/**
 * Map Pandoc's duplicate-attribute warnings back to manuscript positions.
 * The field names are exactly the legacy API's: `level`, `kind`, `message`,
 * `attribute`, `value`, `source_offset`, `source_line`, `page`, `slide`.
 */
export function warning_issues(rendered: LegacyRendered): LegacyWarningIssue[] {
  if (rendered.warnings.length === 0) return [];
  const doc = rendered.doc;
  const lines = new WarningLines(doc.text);
  let first = doc.front[1] < codePointLength(doc.text) ? lines.indexAt(doc.front[1]) : lines.length;
  if (first < 0) first = 0;
  if (doc.front[1] && first < lines.length && lines.starts[first]! < doc.front[1]) first += 1;
  const inCode = codeMask(lines, first);

  interface Candidate {
    key: string;
    value: string;
    offset: number;
    utf16Offset: number;
    line: number;
    page: Page | null;
  }
  const candidates: Candidate[] = [];
  const groups = /\{(?:[^{}"']|"(?:\\.|[^"\\])*"|'[^']*')*\}/gu;
  const frontUtf16 = cpToUtf16(doc.text, doc.front[1]);
  for (const group of doc.text.matchAll(groups)) {
    if (group.index === undefined || group.index < frontUtf16) continue;
    const groupOffset = codePointLength(doc.text.slice(0, group.index));
    if (inCode[lines.indexAt(groupOffset)]) continue;
    const inner = group[0].slice(1, -1);
    const seen = new Set<string>();
    for (const attr of inner.matchAll(ATTR_TOKEN)) {
      const key = attr[3];
      if (key === undefined) continue;
      const value = attr[4] ?? attr[5] ?? attr[6] ?? "";
      if (seen.has(key)) {
        const absolute = group.index + 1 + (attr.index ?? 0);
        const offset = codePointLength(doc.text.slice(0, absolute));
        candidates.push({
          key,
          value,
          offset,
          utf16Offset: doc.text.slice(0, absolute).length,
          line: lines.indexAt(offset) + 1,
          page: doc.page_of(offset),
        });
      }
      seen.add(key);
    }
  }

  const output: LegacyWarningIssue[] = [];
  const emitted = new Set<number>();
  for (const warning of rendered.warnings) {
    const match = /Ignoring duplicate attribute ([^=\s]+)="(.*)"\./u.exec(warning);
    const locations = match
      ? candidates.filter((candidate) => candidate.key === match[1] && candidate.value === match[2])
      : [];
    if (locations.length === 0) {
      output.push({ level: "warning", kind: "pandoc", message: warning });
      continue;
    }
    for (const location of locations) {
      if (emitted.has(location.offset)) continue;
      emitted.add(location.offset);
      const page = location.page;
      const slide = page ? rendered.slides.find((item) => item.page === page.index) : undefined;
      output.push({
        level: "warning",
        kind: "duplicate-attribute",
        message: warning,
        attribute: location.key,
        value: location.value,
        source_offset: location.utf16Offset,
        source_line: location.line,
        page: page ? page.index : null,
        slide: slide ? slide.index : null,
      });
    }
  }
  return output;
}
