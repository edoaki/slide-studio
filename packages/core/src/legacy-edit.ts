/**
 * Faithful TypeScript port of `.reference/parity/edit.py`.
 *
 * The DOM half of this module uses cheerio with htmlparser2's HTML parser
 * (the same non-tree-correcting parser family BeautifulSoup's `html.parser`
 * uses), but serializes nodes with a small serializer that follows
 * BeautifulSoup's observable output: lower-case tags/attributes, attributes
 * sorted by name, XML-style escaping and `/>` for HTML void elements.
 *
 * Pandoc conversions only ever receive the fixed argument lists from the
 * legacy implementation. The caller supplies the executable and working
 * directory; source HTML can never choose a filter or another option.
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { PY_WS, pyStrip } from "./legacy-cover.js";
import { run_pandoc } from "./legacy-pandoc.js";
import {
  codePointLength,
  table_rows,
  ValueError,
} from "./legacy-source.js";
import type { Doc } from "./legacy-source.js";

const EDIT_TIMEOUT_MS = 30_000;
const CELL_SEP = "SLIDESTUDIOCELLSEP";
const CELL_BREAK = "SLIDESTUDIOCELLBREAK";
const W_INNER = String.raw`\p{L}\p{N}_`;
const S = `[${PY_WS}]`;
const NS = `[^${PY_WS}]`;
const PY_SPACE = new RegExp(`^${S}$`, "u");

const INLINE_MATH = new RegExp(
  String.raw`(?<!\$)\$(?![${PY_WS}$])(?:\\[^\n]|[^\\$\n])+(?<![${PY_WS}])\$(?![\p{Nd}$])`,
  "gu",
);

const CITATION = new RegExp(
  String.raw`\[[^\]\n]*@[^\]\n]+\]|(?<![${W_INNER}@])-?@[${W_INNER}]+(?:[:.\-]+[${W_INNER}]+)*(?:[ \t]+\[(?!\^)[^\]\n]*\](?!\())?`,
  "gu",
);

const FOOTNOTE = /\[\^[^\]]+\]/gu;
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.\-]*:[^<>\n]*>/gu;
const DANGEROUS = "script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select";
const LIST_TRAILING_SPACES = new RegExp(
  String.raw`^([${PY_WS}]*)([-*+]|\p{Nd}+[.)])[${PY_WS}]{2,}(?=${NS})`,
  "gmu",
);
const COLOR = /^#[0-9a-fA-F]{3,8}$/u;
const FONT_SIZE = new RegExp(String.raw`^\p{Nd}*\.?\p{Nd}+em$`, "u");

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "command",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "isindex",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export interface LegacyEditOptions {
  pandocPath: string;
  cwd: string;
}

export interface TableCellInfo {
  direct: boolean;
  html: string;
}

export interface ChunkEditInfo {
  direct: boolean;
  html: string;
  cells?: TableCellInfo[][];
}

export type ChunkEditMap = Record<string, ChunkEditInfo>;

export interface ChunkInfoRendered {
  html: string;
  doc: Doc;
}

type Node = any;

/** Python string indices are code points; convert to a UTF-16 slice. */
function cpSlice(value: string, start: number, end: number): string {
  if (start <= 0 && end >= codePointLength(value)) return value;
  return Array.from(value).slice(Math.max(0, start), Math.max(0, end)).join("");
}

function cpToUtf16(value: string, index: number): number {
  if (index <= 0) return 0;
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

function isPySpace(character: string): boolean {
  return PY_SPACE.test(character);
}

function splitPyWhitespace(value: string): string[] {
  return value.split(new RegExp(`[${PY_WS}]+`, "u")).filter(Boolean);
}

function loadFragment(html: string): { $: CheerioAPI; root: Node } {
  // `xml` switches Cheerio to htmlparser2; xmlMode stays off so this is the
  // non-tree-correcting HTML mode that mirrors BeautifulSoup's html.parser.
  const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);
  return { $, root: $.root().get(0) as Node };
}

function tagName(node: Node): string {
  return String(node?.tagName ?? "").toLowerCase();
}

function attributes(node: Node): Record<string, string> {
  if (!node || typeof node !== "object") return {};
  if (!node.attribs || typeof node.attribs !== "object") node.attribs = {};
  return node.attribs as Record<string, string>;
}

function hasAttribute(node: Node, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(attributes(node), name);
}

function getAttribute(node: Node, name: string): string | null {
  const value = attributes(node)[name];
  return value === undefined ? null : String(value);
}

function setAttribute(node: Node, name: string, value: string): void {
  attributes(node)[name] = String(value);
}

function removeAttribute(node: Node, name: string): void {
  delete attributes(node)[name];
}

function classListOf(node: Node): string[] {
  const value = getAttribute(node, "class");
  return value === null ? [] : splitPyWhitespace(value);
}

function setClassList(node: Node, classes: string[]): void {
  if (classes.length === 0) removeAttribute(node, "class");
  else setAttribute(node, "class", classes.join(" "));
}

function escapeText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/gu, "&quot;");
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index]!.codePointAt(0)!;
    const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

function serializeNode(node: Node): string {
  if (node === null || node === undefined) return "";
  if (node.type === "text") return escapeText(String(node.data ?? ""));
  if (node.type === "comment") return `<!--${String(node.data ?? "")}-->`;
  if (node.type === "cdata") return `<![CDATA[${String(node.data ?? "")}]]>`;
  if (node.type === "directive") {
    const data = String(node.data ?? "");
    return data.startsWith("!") ? `<${data}>` : `<!${data}>`;
  }
  if (node.type === "root" || node.type === "document" || node.type === "Document") {
    return (node.children ?? []).map(serializeNode).join("");
  }
  if (node.type !== "tag" && node.type !== "script" && node.type !== "style") {
    return (node.children ?? []).map(serializeNode).join("");
  }

  const name = tagName(node);
  const attrs = attributes(node);
  const rendered = Object.keys(attrs)
    .sort(compareCodePoints)
    .map((key) => {
      const value = attrs[key];
      return value === undefined || value === null
        ? ` ${key}`
        : ` ${key}="${escapeAttribute(String(value))}"`;
    })
    .join("");
  if (VOID_ELEMENTS.has(name)) return `<${name}${rendered}/>`;
  const content = (node.children ?? []).map((child: Node) =>
    (name === "script" || name === "style") && child?.type === "text"
      ? String(child.data ?? "")
      : serializeNode(child)).join("");
  return `<${name}${rendered}>${content}</${name}>`;
}

function serializeChildren(node: Node): string {
  return (node?.children ?? []).map(serializeNode).join("");
}

function replaceWithContents($: CheerioAPI, element: Node): void {
  // Cheerio's unwrap() removes the parent (jQuery semantics); BeautifulSoup's
  // unwrap() removes the element itself, keeping all of its child text.
  const selection = $(element);
  selection.replaceWith(selection.contents().toArray());
}

function pythonMatchAt(expression: RegExp, value: string, codePointIndex: number): RegExpExecArray | null {
  const sticky = new RegExp(
    expression.source,
    `${expression.flags.replace(/g/gu, "").replace(/y/gu, "")}y`,
  );
  sticky.lastIndex = cpToUtf16(value, codePointIndex);
  const match = sticky.exec(value);
  return match && match.index === sticky.lastIndex - match[0].length ? match : null;
}

function findAll(expression: RegExp, value: string): RegExpExecArray[] {
  const clone = new RegExp(
    expression.source,
    expression.flags.includes("g") ? expression.flags : `${expression.flags}g`,
  );
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = clone.exec(value)) !== null) {
    matches.push(match);
    if (match[0].length === 0) clone.lastIndex += 1;
  }
  return matches;
}

interface MatchRange {
  start: number;
  end: number;
  text: string;
}

/** Match ranges with Python code-point offsets. */
function matchRanges(expression: RegExp, value: string): MatchRange[] {
  return findAll(expression, value).map((match) => ({
    start: codePointLength(value.slice(0, match.index)),
    end: codePointLength(value.slice(0, match.index + match[0].length)),
    text: match[0],
  }));
}

function protectAtoms($: CheerioAPI, atoms: Map<string, string>): void {
  for (const element of $("[data-slide-studio-atom]").toArray() as Node[]) {
    const token = `SLIDESTUDIOATOM${atoms.size}END`;
    atoms.set(token, getAttribute(element, "data-slide-studio-atom") ?? "");
    $(element).replaceWith(token);
  }
}

function styleValue(styles: Map<string, string>, name: string): string {
  return styles.get(name) ?? "";
}

function clean($: CheerioAPI): void {
  for (const element of $(DANGEROUS).toArray() as Node[]) {
    $(element).remove();
  }

  for (const element of $("*").toArray() as Node[]) {
    if (hasAttribute(element, "data-slide-studio-step-generated")) {
      removeAttribute(element, "data-step");
      if (hasAttribute(element, "class")) {
        setClassList(element, classListOf(element).filter((name) => name !== "pending"));
      }
    }
    if (tagName(element) === "a") {
      removeAttribute(element, "target");
      removeAttribute(element, "rel");
    }
    if (hasAttribute(element, "class")) {
      setClassList(
        element,
        classListOf(element).filter(
          (name) => name !== "slide-studio-selected" && name !== "slide-studio-editing",
        ),
      );
    }
    for (const name of Object.keys(attributes(element))) {
      if (
        name.startsWith("data-slide-studio")
        || name.startsWith("on")
        || name === "contenteditable"
        || name === "srcdoc"
      ) {
        removeAttribute(element, name);
      }
    }
    if (hasAttribute(element, "style")) {
      const styles = new Map<string, string>();
      for (const declaration of (getAttribute(element, "style") ?? "").split(";")) {
        if (!declaration.includes(":")) continue;
        const colon = declaration.indexOf(":");
        styles.set(
          pyStrip(declaration.slice(0, colon)).toLowerCase(),
          pyStrip(declaration.slice(colon + 1)),
        );
      }
      const keep: Array<[string, string]> = [];
      const color = styleValue(styles, "color");
      if (COLOR.test(color)) keep.push(["color", color]);
      const fontSize = styleValue(styles, "font-size");
      if (FONT_SIZE.test(fontSize)) keep.push(["font-size", fontSize]);
      removeAttribute(element, "style");
      if (keep.length) {
        setAttribute(element, "style", keep.map(([name, value]) => `${name}: ${value}`).join("; "));
      }
    }
  }

  for (const element of ($("span").toArray() as Node[]).reverse()) {
    if (Object.keys(attributes(element)).length === 0) replaceWithContents($, element);
  }
}

async function convert(
  input: string,
  args: string[],
  options: LegacyEditOptions,
): Promise<string> {
  const result = await run_pandoc(input, args, {
    pandocPath: options.pandocPath,
    cwd: options.cwd,
    timeoutMs: EDIT_TIMEOUT_MS,
  });
  return result.stdout;
}

/** Convert rendered slide HTML to Markdown, restoring protected atoms. */
export async function to_markdown(
  html: string,
  original = "",
  options: LegacyEditOptions,
): Promise<string> {
  const { $, root } = loadFragment(html);
  const atoms = new Map<string, string>();
  protectAtoms($, atoms);
  clean($);
  const stdout = await convert(
    serializeChildren(root),
    [
      "--from", "html-native_divs",
      "--to", "markdown-raw_html-simple_tables-multiline_tables-grid_tables",
      "--wrap=none",
    ],
    options,
  );
  let markdown = stdout.replace(
    LIST_TRAILING_SPACES,
    (_match, indent: string, marker: string) => `${indent}${marker} `,
  );
  markdown = pyStrip(markdown);
  for (const [token, raw] of atoms) markdown = markdown.split(token).join(raw);
  const trailing = /[ \t]*$/u.exec(original)?.[0] ?? "";
  return markdown + trailing;
}

/** Convert table-cell HTML to piped-table Markdown with one Pandoc call. */
export async function cells_to_markdown(
  cells: readonly string[],
  options: LegacyEditOptions,
): Promise<string[]> {
  const atoms = new Map<string, string>();
  const parts: string[] = [];
  for (const html of cells) {
    const { $, root } = loadFragment(html.replace(/\u00a0/gu, " "));
    protectAtoms($, atoms);
    clean($);
    for (const element of $("br").toArray() as Node[]) {
      $(element).replaceWith(CELL_BREAK);
    }
    parts.push(`<div>${serializeChildren(root)}</div>`);
  }

  const stdout = await convert(
    parts.join(`<p>${CELL_SEP}</p>`),
    [
      "--from", "html-native_divs",
      "--to", "markdown-raw_html-simple_tables-multiline_tables-grid_tables-smart",
      "--wrap=none",
    ],
    options,
  );

  const stripped = pyStrip(stdout);
  const separator = new RegExp(String.raw`\n*^${CELL_SEP}$\n*`, "gmu");
  const markdownCells = stripped.split(separator);
  const output: string[] = [];
  for (let markdown of markdownCells) {
    let value = pyStrip(markdown);
    value = value.replace(
      new RegExp(String.raw`(?:[${PY_WS}]*${CELL_BREAK})+[${PY_WS}]*$`, "gu"),
      "",
    );
    value = value.replace(
      new RegExp(String.raw`[${PY_WS}]*${CELL_BREAK}[${PY_WS}]*`, "gu"),
      "<br>",
    );
    value = value.replace(
      new RegExp(String.raw`[${PY_WS}]*\n[${PY_WS}]*\n[${PY_WS}]*`, "gu"),
      "<br>",
    );
    value = value.replace(
      new RegExp(String.raw`[${PY_WS}]*\n[${PY_WS}]*`, "gu"),
      " ",
    );
    for (const [token, raw] of atoms) value = value.split(token).join(raw);
    output.push(value);
  }
  if (output.length !== cells.length) throw new ValueError("セルを変換できません");
  return output;
}

/** Convert the contents of one edited table cell (td/th outerHTML) to Markdown. */
export async function cell_markdown(
  html: string,
  options: LegacyEditOptions,
): Promise<string> {
  const { $ } = loadFragment(html);
  const cell = $("td, th").first().get(0) as Node | undefined;
  const contents = cell ? serializeChildren(cell) : html;
  return (await cells_to_markdown([contents], options))[0]!;
}

function atomSource(raw: string): string {
  const text = Array.from(raw);
  const length = text.length;
  let position = 0;
  while (position < length) {
    if (text[position] === "\\" && position + 1 < length) {
      text[position] = " ";
      if (text[position + 1] !== "\n") text[position + 1] = " ";
      position += 2;
    } else if (text[position] === "$") {
      const math = pythonMatchAt(INLINE_MATH, raw, position);
      if (math) {
        position = codePointLength(raw.slice(0, math.index + math[0].length));
      } else {
        position += 1;
      }
    } else if (text[position] === "`") {
      let ticks = 0;
      while (position + ticks < length && text[position + ticks] === "`") ticks += 1;
      const openings = "`".repeat(ticks);
      let end = position + ticks;
      const rest = cpSlice(raw, end, codePointLength(raw));
      const close = new RegExp(`(?<!\`)${openings}(?!\`)`, "gu").exec(rest);
      if (close) {
        end += codePointLength(rest.slice(0, close.index + close[0].length));
        for (let index = position; index < end; index += 1) {
          text[index] = text[index] === "\n" ? "\n" : " ";
        }
      }
      position = end;
    } else {
      position += 1;
    }
  }
  return text.join("");
}

function citationSource(source: string): string {
  const text = Array.from(source);
  for (const pattern of [INLINE_MATH, AUTOLINK]) {
    for (const match of matchRanges(pattern, source)) {
      text.fill(" ", match.start, match.end);
    }
  }

  const brackets: number[] = [];
  for (let position = 0; position < text.length; position += 1) {
    const character = text[position]!;
    if (character === "[") {
      brackets.push(position);
    } else if (character === "]" && brackets.length) {
      brackets.pop();
      if (position + 1 >= text.length || text[position + 1] !== "(") continue;
      let depth = 1;
      let quote = "";
      for (let end = position + 2; end < text.length; end += 1) {
        const current = text[end]!;
        if (quote) {
          if (current === quote) quote = "";
        } else if ((current === '"' || current === "'") && isPySpace(text[end - 1] ?? "")) {
          quote = current;
        } else if (current === "(") {
          depth += 1;
        } else if (current === ")") {
          depth -= 1;
          if (!depth) {
            text.fill(" ", position + 2, end);
            break;
          }
        }
      }
    }
  }
  return text.join("");
}

/** Attach the original inline atom spelling to its rendered element. */
export function prepared_html(html: string, raw: string): string {
  const { $, root } = loadFragment(html);
  const source = atomSource(raw);
  const groups: Array<{
    elements: Node[];
    pattern: RegExp;
    matchSource: string;
  }> = [
    {
      elements: $(".citation").toArray() as Node[],
      pattern: CITATION,
      matchSource: citationSource(source),
    },
    {
      elements: $("a.footnote-ref, sup[data-slide-studio-footnote]").toArray() as Node[],
      pattern: FOOTNOTE,
      matchSource: source,
    },
    {
      elements: $("span.math.inline, math:not([display=block])").toArray() as Node[],
      pattern: INLINE_MATH,
      matchSource: source,
    },
  ];

  for (const group of groups) {
    let originals = matchRanges(group.pattern, group.matchSource).map((match) =>
      cpSlice(raw, match.start, match.end));
    if (group.elements.length !== originals.length && group.matchSource !== source) {
      const fallback = matchRanges(group.pattern, source).map((match) =>
        cpSlice(raw, match.start, match.end));
      if (group.elements.length === fallback.length) originals = fallback;
    }
    if (group.elements.length === originals.length) {
      group.elements.forEach((element, index) => {
        setAttribute(element, "data-slide-studio-atom", originals[index]!);
        setAttribute(element, "contenteditable", "false");
      });
    }
  }
  return serializeChildren(root);
}

/**
 * The direct-edit status and editable HTML for every table cell.
 *
 * This step only prepares HTML (no Markdown conversion), so like the Python
 * implementation it is synchronous. The optional options argument keeps the
 * call site uniform if a caller shares one conversion configuration.
 */
export function table_cells(
  table: Node,
  raw: string,
  _options?: LegacyEditOptions,
): TableCellInfo[][] | null {
  const rows = table_rows(raw);
  const { $ } = loadFragment(serializeNode(table));
  const tableNode = $("table").first().get(0) as Node | undefined;
  if (!tableNode) return null;
  const trs = $(tableNode).find("tr").toArray() as Node[];
  const first = $(tableNode).find("thead").length ? 0 : 1;
  if (!rows || trs.length + first !== rows.length) return null;

  const output: TableCellInfo[][] = Array.from({ length: first }, () => []);
  for (let index = 0; index < trs.length; index += 1) {
    const row: TableCellInfo[] = [];
    const cells = $(trs[index]!).children("th, td").toArray() as Node[];
    cells.forEach((cell, column) => {
      const info: TableCellInfo = { direct: false, html: "" };
      row.push(info);
      const sourceRow = rows[index + first]!;
      if (column < sourceRow.length) {
        const [start, end] = sourceRow[column]!;
        const sourceText = pyStrip(cpSlice(raw, start, end));
        info.html = prepared_html(serializeChildren(cell), sourceText);
        info.direct = true;
      }
    });
    output.push(row);
  }
  return output;
}

/** Mirror `edit.chunk_info`: editability and direct-edit HTML per chunk. */
export async function chunk_info(
  rendered: ChunkInfoRendered,
  options?: LegacyEditOptions,
): Promise<ChunkEditMap> {
  const { $ } = loadFragment(rendered.html);
  const elements = new Map<string, Node>();
  for (const element of $("[data-slide-studio]").toArray() as Node[]) {
    const key = getAttribute(element, "data-slide-studio");
    if (key !== null) elements.set(key, element);
  }

  const info: ChunkEditMap = {};
  for (const page of rendered.doc.pages) {
    for (const chunk of page.walk()) {
      const key = `p${page.index}/${chunk.path}`;
      info[key] = { direct: false, html: "" };
      if (chunk.kind !== "text") continue;

      const element = elements.get(key);
      const raw = cpSlice(rendered.doc.text, chunk.start, chunk.end);
      const found = element !== undefined && table_rows(raw)
        ? (tagName(element) === "table" ? [element] : $(element).find("table").toArray() as Node[])
        : [];
      if (found.length === 1) {
        const cells = table_cells(found[0]!, raw, options);
        if (cells !== null) info[key]!.cells = cells;
        continue;
      }

      const html = element !== undefined ? prepared_html(serializeNode(element), raw) : "";
      const { $: fragment, root } = loadFragment(html);
      for (const wrapper of fragment(".slide-studio-c").toArray() as Node[]) {
        replaceWithContents(fragment, wrapper);
      }
      const prepared = serializeChildren(root);
      const direct = chunk.kind === "text"
        && html.length > 0
        && fragment("span.math.display, math[display=block]").length === 0;
      info[key] = { direct, html: direct ? prepared : "" };
    }
  }
  return info;
}
