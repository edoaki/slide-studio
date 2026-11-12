import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import type { Diagnostic, PreviewDocument, SlideInfo } from "../../contracts/src/desktop.js";
import { assetPath, assetRoot, readAsset } from "./assets.js";
import { bundleCss, bundleHtml } from "./bundle.js";
import { optionalFileInside } from "./paths.js";
import { curateMetadata, normalizeSource, splitFrontMatter } from "./source.js";
import type { CuratedMetadata } from "./source.js";

const SHELL = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head><body><div class="reveal"><main id="stage" class="slides"><div id="slide-studio-root"></div></main></div><nav id="toolbar" aria-label="スライド操作"><button id="menu" aria-label="スライド一覧" title="スライド一覧（o）">☰</button><button id="fullscreen" aria-label="全画面" title="全画面（f）">⛶</button></nav><aside id="overview" aria-label="スライド一覧" role="dialog" aria-modal="true" hidden><button id="close">閉じる</button><p id="help">↑↓ ページ · ←→ step · 左右長押しで先頭／最後 · 画面左30%で戻る／それ以外で進む</p></aside></body></html>`;

export interface PreparedSource {
  body: string;
  meta: CuratedMetadata;
  warnings: Diagnostic[];
  removedLines: number;
}

export interface AssembleOptions {
  rootReal: string;
  deckId: string;
  deckDirectory: string;
  meta: CuratedMetadata;
  pandocHtml: string;
  version: string;
  warnings: Diagnostic[];
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function diagnostic(code: string, message: string, line?: number): Diagnostic {
  const value: Diagnostic = { code, severity: "warning", message };
  if (line !== undefined) value.line = line;
  return value;
}

export function prepareSource(source: string): PreparedSource {
  const normalized = normalizeSource(source);
  const parsed = splitFrontMatter(normalized);
  const meta = curateMetadata(parsed.meta);
  const warnings: Diagnostic[] = [];
  if (parsed.error) {
    warnings.push(diagnostic("FRONT_MATTER", parsed.error));
  }
  for (const key of meta.ignoredKeys) {
    warnings.push(diagnostic(
      "METADATA_IGNORED",
      `Metadata field "${key}" is not used; resources are only read from validated workspace files.`,
    ));
  }

  const offset = Math.max(0, normalized.length - parsed.body.length);
  const seen = new Set<string>();
  const add = (code: string, message: string, index: number): void => {
    const line = lineAt(normalized, offset + index);
    const key = `${code}:${line}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push(diagnostic(code, message, line));
  };

  const includePattern = /\{\{<\s*include\b/gu;
  for (const match of parsed.body.matchAll(includePattern)) {
    add("UNSUPPORTED_INCLUDE", "{{< include >}} is not supported in this desktop slice.", match.index ?? 0);
  }
  const shortcodePattern = /\{\{<\s*([A-Za-z][\w-]*)/gu;
  for (const match of parsed.body.matchAll(shortcodePattern)) {
    if (match[1] === "fig" || match[1] === "include") continue;
    add("UNSUPPORTED_SHORTCODE", `Quarto shortcode {{< ${match[1] ?? ""} >}} is not supported.`, match.index ?? 0);
  }
  const executablePattern = /^ {0,3}(?:`{3,}|~{3,})[ \t]*\{(?!\s*=)([A-Za-z][\w-]*)[^}\n]*\}/gmu;
  for (const match of parsed.body.matchAll(executablePattern)) {
    add("UNSUPPORTED_EXECUTABLE", `Executable cell "${match[1] ?? ""}" is not supported.`, match.index ?? 0);
  }
  const crossrefPattern = /(?<![\w@])@(?:fig|tbl|sec|eq|lst|thm)-[\w-]+/gu;
  for (const match of parsed.body.matchAll(crossrefPattern)) {
    add("UNSUPPORTED_CROSSREF", `Cross-reference ${match[0]} is not resolved.`, match.index ?? 0);
  }

  return { body: parsed.body, meta, warnings, removedLines: parsed.removedLines };
}

function classesOf(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/u).filter(Boolean);
}

interface Stylesheet {
  css: string;
  baseDirectory: string;
  boundary: string;
}

function loadTheme(rootReal: string, theme: string, appBoundary: string): Stylesheet {
  const rootTheme = optionalFileInside(rootReal, join(rootReal, "themes", `${theme}.css`));
  if (rootTheme) {
    return { css: readFileSync(rootTheme, "utf8"), baseDirectory: dirname(rootTheme), boundary: rootReal };
  }
  const bundled = assetPath("themes", `${theme}.css`);
  if (existsSync(bundled)) {
    return { css: readFileSync(bundled, "utf8"), baseDirectory: assetPath("themes"), boundary: appBoundary };
  }
  return {
    css: readAsset("themes", "default.css"),
    baseDirectory: assetPath("themes"),
    boundary: appBoundary,
  };
}

function loadDeckStyle(rootReal: string, deckDirectory: string): Stylesheet | null {
  const path = optionalFileInside(rootReal, join(deckDirectory, "styles", "slides.css"));
  return path
    ? { css: readFileSync(path, "utf8"), baseDirectory: dirname(path), boundary: rootReal }
    : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function isInsideIncremental(node: any, wrapper: any): boolean {
  let parent = node.parent;
  while (parent && parent !== wrapper) {
    if (Array.isArray(parent.attribs?.class)) {
      if (parent.attribs.class.includes("incremental")) return true;
    } else if (typeof parent.attribs?.class === "string"
      && parent.attribs.class.split(/\s+/u).includes("incremental")) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

export function assemblePreview(options: AssembleOptions): PreviewDocument {
  const { rootReal, deckId, deckDirectory, meta, pandocHtml, version } = options;
  const warnings = [...options.warnings];
  const $: any = cheerio.load(SHELL);
  $("html").attr("lang", meta.lang);

  const title = meta.title ?? meta.pagetitle ?? deckId;
  $("title").text(title);
  $("body").attr("data-slide-studio-deck", deckId);

  const appBoundary = realpathSync.native(assetRoot());
  const baseStyles: Stylesheet[] = [
    { css: readAsset("runtime", "base.css"), baseDirectory: assetPath("runtime"), boundary: appBoundary },
    { css: readAsset("themes", "_base.css"), baseDirectory: assetPath("themes"), boundary: appBoundary },
    loadTheme(rootReal, meta.theme, appBoundary),
  ];
  const baseCss = baseStyles.map((stylesheet) => {
    const bundled = bundleCss(stylesheet.css, stylesheet.baseDirectory, stylesheet.boundary);
    warnings.push(...bundled.warnings);
    return bundled.html;
  }).join("\n");
  $("head").append(
    $("<style></style>")
      .attr("id", "slide-studio-base")
      .attr("data-ss-bundled", "true")
      .text(baseCss),
  );
  const deckStyle = loadDeckStyle(rootReal, deckDirectory);
  if (deckStyle) {
    const bundled = bundleCss(deckStyle.css, deckStyle.baseDirectory, deckStyle.boundary);
    warnings.push(...bundled.warnings);
    $("head").append(
      $("<style></style>")
        .attr("id", "slide-studio-deck-style")
        .attr("data-ss-bundled", "true")
        .text(bundled.html),
    );
  }

  const root = $("#slide-studio-root");
  root.append(pandocHtml);
  const stage = $("#stage");
  const preamble: any[] = [];
  let current: any = null;
  let group = "";
  let pageIndex = 0;

  for (const node of root.contents().toArray() as any[]) {
    const tag = node.type === "tag" ? String(node.tagName).toLowerCase() : "";
    if (tag === "h1" || tag === "h2") {
      const heading = $(node);
      const isSection = tag === "h1";
      const classes = classesOf(heading.attr("class"));
      if (isSection) group = heading.text().replace(/\s+/gu, " ").trim();
      const section = $("<section></section>");
      const sectionClasses = ["slide", ...classes];
      if (isSection) sectionClasses.push("section-slide");
      section.attr("class", sectionClasses.join(" "));
      const inheritable = ["style"];
      const id = heading.attr("id");
      if (id) {
        section.attr("id", id);
        heading.removeAttr("id");
      }
      for (const [key, value] of Object.entries(node.attribs ?? {})) {
        if (key.startsWith("data-") || inheritable.includes(key)) {
          section.attr(key, String(value));
          heading.removeAttr(key);
        }
      }
      section.attr("data-page", String(pageIndex));
      section.attr("data-group", group);
      section.attr("data-section-start", String(isSection));
      pageIndex += 1;
      stage.append(section);
      section.append(node);
      current = section;
      continue;
    }
    if (current) current.append(node);
    else preamble.push(node);
  }

  if (current === null) {
    if (preamble.length) {
      const section = $("<section></section>").attr("class", "slide").attr("data-page", "0")
        .attr("data-group", "").attr("data-section-start", "false");
      stage.append(section);
      for (const node of preamble.splice(0)) section.append(node);
      current = section;
    }
  } else if (preamble.length) {
    // Content before the first heading is rare raw HTML; keep it with the first page.
    const firstHeading = current.children("h1,h2").first();
    for (const node of preamble.splice(0)) {
      if (firstHeading.length) firstHeading.after(node);
      else current.append(node);
    }
  }
  root.remove();

  const notes = new Map<string, string>();
  const footnoteSection = $("section.footnotes").first();
  if (footnoteSection.length) {
    footnoteSection.find("li[id]").each((_index: number, element: any) => {
      const item = $(element);
      item.find("a.footnote-back").remove();
      notes.set(item.attr("id") ?? "", item.html() ?? "");
    });
    footnoteSection.remove();
  }

  const refs = new Map<string, string>();
  let refsDivFound = false;
  const refsDiv = $("#refs").first();
  if (refsDiv.length) {
    refsDivFound = true;
    refsDiv.find(".csl-entry").each((_index: number, element: any) => {
      const entry = $(element);
      refs.set(entry.attr("id") ?? "", entry.html() ?? "");
    });
    refsDiv.remove();
  }

  stage.find(".incremental").each((_index: number, element: any) => {
    const wrapper = $(element);
    const startValue = Number.parseInt(wrapper.attr("data-step") ?? "1", 10);
    const start = Number.isFinite(startValue) ? Math.max(0, startValue) : 1;
    let offset = 0;
    wrapper.find("li").each((_liIndex: number, item: any) => {
      if (isInsideIncremental(item, element)) return;
      const node = $(item);
      node.attr("data-step", String(start + offset));
      node.attr("data-slide-studio-step-generated", "true");
      offset += 1;
    });
  });

  stage.find("img[data-step]").each((_index: number, element: any) => {
    const image = $(element);
    const box = image.parent();
    if (box.length === 0) return;
    if (!["figure", "p"].includes(String(box[0].tagName).toLowerCase())) return;
    if (String(box[0].tagName).toLowerCase() === "p") {
      const otherContent = box.contents().toArray().some((child: any) => {
        if (child === element) return false;
        return child.type === "tag" ? true : String(child.data ?? "").trim().length > 0;
      });
      if (otherContent) return;
    }
    box.attr("data-step", image.attr("data-step"));
    image.removeAttr("data-step");
  });

  // References: replace the placeholder with captured entries at its original position.
  const referenceSection = $("#stage > section#references").first();
  const referenceTitle = referenceSection.find("h1,h2").first().text().trim() || "参考文献";
  if (referenceSection.length && refsDivFound) {
    referenceSection.children().not("h1,h2").remove();
    referenceSection.attr("class", `${referenceSection.attr("class") ?? "slide"} references-slide`);
    if (refs.size === 0) {
      referenceSection.append($("<p></p>").attr("class", "slide-studio-no-refs").text("引用なし"));
    } else {
      for (const [id, html] of refs) {
        referenceSection.append(`<div class="csl-entry" id="${escapeHtml(id)}">${html}</div>`);
      }
    }
  } else if (refsDivFound && referenceSection.length === 0) {
    const section = $("<section></section>")
      .attr("class", "slide references-slide")
      .attr("id", "references")
      .attr("data-group", referenceTitle)
      .attr("data-section-start", "false")
      .attr("data-page", "");
    section.append($("<h2></h2>").text(referenceTitle));
    if (refs.size === 0) {
      section.append($("<p></p>").attr("class", "slide-studio-no-refs").text("引用なし"));
    } else {
      for (const [id, html] of refs) {
        section.append(`<div class="csl-entry" id="${escapeHtml(id)}">${html}</div>`);
      }
    }
    const appendix = $("#stage > section#appendix").first();
    if (appendix.length) appendix.before(section);
    else stage.append(section);
  }

  const sectionsBeforeAppendix = (): any[] => {
    const result: any[] = [];
    for (const element of $("#stage > section").toArray() as any[]) {
      const section = $(element);
      if (section.attr("id") === "appendix") break;
      result.push(section);
    }
    return result;
  };

  const tocTargets = sectionsBeforeAppendix().filter((section: any) => {
    const classes = classesOf(section.attr("class"));
    return classes.includes("section-slide");
  });
  const fallbackTargets = tocTargets.length > 0 ? tocTargets : sectionsBeforeAppendix().filter((section: any) => {
    const classes = classesOf(section.attr("class"));
    const excluded = ["cover", "toc-slide", "references-slide", "refs-slide"];
    return !classes.some((name: string) => excluded.includes(name))
      && !["references", "appendix"].includes(section.attr("id") ?? "");
  });
  $("#stage > section.toc-slide").each((_index: number, element: any) => {
    const section = $(element);
    section.children(".toc-list").remove();
    const list = $("<ol></ol>").attr("class", "toc-list");
    fallbackTargets.forEach((target: any, number: number) => {
      const item = $("<li></li>");
      item.append($("<span></span>").attr("class", "toc-number").text(String(number + 1).padStart(2, "0")));
      const label = target.find("h1,h2").first().text().replace(/\s+/gu, " ").trim();
      item.append($("<span></span>").attr("class", "toc-label").text(label));
      list.append(item);
    });
    section.append(list);
  });

  let chapter = 0;
  for (const section of sectionsBeforeAppendix()) {
    const classes = classesOf(section.attr("class"));
    if (!classes.includes("section-slide")) continue;
    chapter += 1;
    const number = String(chapter).padStart(2, "0");
    section.attr("data-chapter", number);
    const h1 = section.find("h1").first();
    if (h1.length) {
      h1.prepend($("<span></span>").attr("class", "chapter-number").attr("data-chapter", number));
    }
  }

  for (const element of $("#stage > section").toArray() as any[]) {
    const section = $(element);
    const footer = $("<footer></footer>").attr("class", "citations");
    section.children(".footnote-small").each((_index: number, small: any) => {
      footer.append(small);
    });

    const cited = new Set<string>();
    section.find("[data-cites]").each((_index: number, node: any) => {
      const keys = String($(node).attr("data-cites") ?? "").split(/\s+/u).filter(Boolean);
      for (const key of keys) {
        if (cited.has(key)) continue;
        cited.add(key);
        const entry = refs.get(`ref-${key}`);
        const paragraph = $("<p></p>");
        if (entry === undefined) {
          paragraph.attr("class", "slide-studio-missing-cite").text(`文献が見つかりません: ${key}`);
          warnings.push(diagnostic("MISSING_CITATION", `Citation not found: ${key}`));
        } else {
          const holder = $("<div></div>").html(entry);
          paragraph.text(holder.text().replace(/\s+/gu, " ").trim());
        }
        footer.append(paragraph);
      }
    });

    section.find("a.footnote-ref").each((_index: number, node: any) => {
      const anchor = $(node);
      const href = anchor.attr("href") ?? "";
      const note = notes.get(href.replace(/^#/u, ""));
      if (note === undefined) return;
      const paragraph = $("<p></p>").attr("class", "slide-studio-footnote");
      paragraph.append($("<sup></sup>").text(anchor.text().trim()));
      paragraph.append(note);
      footer.append(paragraph);
      anchor.find("sup").attr("data-slide-studio-footnote", href);
      anchor.replaceWith(anchor.contents());
    });

    if (footer.children().length > 0) section.append(footer);
    section.find('a[role="doc-biblioref"]').each((_index: number, node: any) => {
      const anchor = $(node);
      anchor.replaceWith(anchor.contents());
    });
  }

  const cov = $("#stage > section.cover").first();
  if (cov.length && meta.authors.length > 0 && cov.find(".cover-authors").length === 0) {
    const block = $("<div></div>").attr("class", "cover-authors");
    const names = $("<p></p>").attr("class", "cover-names");
    meta.authors.forEach((name, index) => {
      if (index > 0) names.append("・");
      names.append($("<span></span>").attr("class", "cover-name").text(name));
    });
    block.append(names);
    cov.append(block);
  }

  const finalSections = $("#stage > section").toArray() as any[];
  finalSections.forEach((element: any, index: number) => {
    const section = $(element);
    section.attr("data-page", String(index));
    section.children(".page-number").remove();
    section.append($("<span></span>").attr("class", "page-number").text(`${index + 1} / ${finalSections.length}`));
  });

  $("#stage a[href]").each((_index: number, element: any) => {
    const anchor = $(element);
    const href = anchor.attr("href") ?? "";
    if (href.startsWith("#") || anchor.attr("download") !== undefined) return;
    anchor.attr("target", "_blank");
    anchor.attr("rel", "noopener");
  });

  $("body").append($("<script></script>").attr("id", "slide-studio-player").text(readAsset("runtime", "player.js")));

  const slides: SlideInfo[] = finalSections.map((element: any, index: number) => {
    const section = $(element);
    const heading = section.find("h1,h2").first();
    const classes = classesOf(section.attr("class"));
    return {
      index,
      id: section.attr("id") ?? "",
      title: heading.text().replace(/\s+/gu, " ").trim(),
      level: classes.includes("section-slide") ? 1 : 2,
    };
  });

  const bundled = bundleHtml($.html(), deckDirectory, rootReal);
  warnings.push(...bundled.warnings);
  return { html: bundled.html, version, slides, warnings };
}
