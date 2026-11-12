/**
 * Faithful TypeScript port of `.reference/parity/theme_edit.py` for the parts
 * the workspace needs: reading variables, refreshing heading options, dropping
 * legacy cover layout edits, and preserving the title header. The functions are
 * pure so `legacy-workspace.ts` can run them against an instance template root.
 */

// Same required-variable set as `workspace.THEME_VARIABLES` for the bundled
// `_base.css`. `legacy-workspace` passes its instance-scoped list explicitly;
// this default keeps direct helper calls faithful to the Python module.
import { PY_WS } from "./legacy-cover.js";

const DEFAULT_THEME_VARIABLES = [
  "--ink",
  "--accent",
  "--header",
  "--muted",
  "--warn",
  "--good",
  "--mark",
  "--mark-ink",
  "--mark-line",
  "--paper",
  "--rule",
  "--header-ink",
  "--font-body",
  "--font-head",
] as const;

const HEADING_OPTIONS: Record<string, readonly string[]> = {
  "--heading-mode": ["theme", "fill", "rule"],
  "--heading-rule-style": ["solid", "dashed", "dotted", "double"],
  "--heading-rule-width": ["1px", "2px", "3px", "4px", "5px", "6px"],
  "--heading-rule-inset": ["0px", "44px"],
};

const HEADING_DEFAULTS: Record<string, string> = {
  "--heading-mode": "theme",
  "--heading-rule-style": "solid",
  "--heading-rule-width": "2px",
  "--heading-rule-inset": "44px",
};

const HEADING_LAYOUT = "#stage .slide > h2 { margin-inline:calc(-1 * var(--content-inset)); width:auto; max-width:none; padding-inline:calc(var(--content-inset) + var(--text-pad)); border-radius:0; }\n";
const HEADING_RULE = "#stage .slide > h2 { position:relative; background:none; border:0; box-shadow:none; }\n#stage .slide > h2::after { content:''; display:block; position:absolute; left:var(--heading-rule-inset); right:var(--heading-rule-inset); bottom:0; width:auto; height:0; margin:0; background:none; border:0; border-bottom:var(--heading-rule-width) var(--heading-rule-style) var(--rule); }\n";
const HEADING_FILL = "#stage .slide > h2 { background:var(--header-fill, var(--header)); border:0; box-shadow:none; }\n#stage .slide > h2, #stage .slide > h2 * { color:var(--header-ink); }\n#stage .slide > h2::after { display:none; }\n";

const HEADING_RE = /\n\/\* slide-studio heading options \*\/\n.*?\/\* end heading options \*\/\n/su;

export const FILL = "--header-fill";

const TITLE_TEMPLATE = "\n/* slide-studio title header */\n#stage .slide:is(.cover, .section-slide) { --header: %s; }\n";

const COVER_RE = /\n\/\* slide-studio cover layout \*\/\n(?:#stage \.slide\.cover > \.cover-(?:title|subtitle|authors) \{[^{}\n]*\}\n)*/gu;

const OVERRIDE = "\n/* slide-studio heading fill */\n:root { --header-fill: %s; }\n#stage h2 { background: var(--header-fill); }\n#stage h2, #stage h2 * { color: var(--header-ink); }\n#stage .cover .cover-title, #stage .cover .cover-title p { color: var(--header); }\n";
const HEADING_INK_RULE = "#stage h2, #stage h2 * { color: var(--header-ink); }\n";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const TITLE_RE = new RegExp(
  escapeRegExp(TITLE_TEMPLATE).replace("%s", "(#[0-9a-fA-F]{3,8})"),
  "u",
);

export const OVERRIDE_RE = new RegExp(
  escapeRegExp(OVERRIDE)
    .replace("%s", "([^;{}]+)")
    .replace(escapeRegExp(HEADING_INK_RULE), `(?:${escapeRegExp(HEADING_INK_RULE)})?`),
  "u",
);

const BACKGROUND = "--background-fill";
const KINDS: Record<string, [string, string]> = {
  [BACKGROUND]: ["page", "#stage .slide:not(.cover):not(.section-slide)"],
  "--section-fill": ["section", "#stage .slide.section-slide"],
  "--cover-fill": ["cover", "#stage .slide.cover"],
};
const KIND_TEMPLATE = "\n/* slide-studio %s background */\n:root { %s: %s; }\n%s { background: var(%s); box-shadow: none; }\n";

function kindOverride(key: string, value: string): string {
  const entry = KINDS[key]!;
  return KIND_TEMPLATE
    .replace("%s", entry[0])
    .replace("%s", key)
    .replace("%s", value)
    .replace("%s", entry[1])
    .replace("%s", key);
}

const KIND_RES: Record<string, RegExp> = Object.fromEntries(
  Object.keys(KINDS).map((key): [string, RegExp] => [
    key,
    new RegExp(escapeRegExp(kindOverride(key, "VALUE")).replace("VALUE", "([^;{}]+)"), "u"),
  ]),
);

const BG_OVERRIDE = "\n/* slide-studio background fill */\n:root { --background-fill: %s; }\n#stage .slide { background: var(--background-fill); box-shadow: none; }\n";
const BG_RE = new RegExp(
  escapeRegExp(BG_OVERRIDE)
    .replace("%s", "([^;{}]+)")
    .replace(escapeRegExp(" box-shadow: none;"), "(?: box-shadow: none;)?"),
  "u",
);

const BLOCK_KEYS: Record<string, string> = {
  "--block-border": "border",
  "--block-background": "background-color",
  "--block-top-line": "top-line",
  "--block-top-fill": "top-fill",
  "--block-left-line": "left-line",
  "--block-left-fill": "left-fill",
  "--block-shadow-fill": "shadow-fill",
  "--block-shadow-color": "shadow-color",
  "--block-corner-top": "corner-top",
  "--block-corner-left": "corner-left",
  "--block-corner-fill": "corner-fill",
};
const BLOCK_LINES = new Set([
  "--block-border",
  "--block-top-line",
  "--block-left-line",
  "--block-corner-top",
  "--block-corner-left",
]);
const BLOCK_RADII = new Set(
  ["unframed", "plain", "top", "left", "quote", "bracket", "fold"].map((kind) => `--block-${kind}-radius`),
);
const BLOCK_SHADOWS = new Set(
  ["unframed", "plain", "top", "left", "quote", "bracket", "fold"].map((kind) => `--block-${kind}-shadow`),
);
for (const kind of ["plain", "top", "left", "quote", "bracket", "fold"]) {
  const parts = ["quote", "bracket", "fold"].includes(kind) ? ["ink", "line", "fill"] : ["ink"];
  for (const part of parts) {
    const key = `--block-${kind}-${part}`;
    BLOCK_KEYS[key] = `${kind}-${part}`;
    if (part === "line") BLOCK_LINES.add(key);
  }
}
for (const kind of ["quote", "fold"]) BLOCK_KEYS[`--block-${kind}-accent`] = `${kind}-accent`;
for (const key of [...BLOCK_RADII, ...BLOCK_SHADOWS]) BLOCK_KEYS[key] = key.replace(/^--block-/u, "");

const BLOCK_TEMPLATE = "\n/* slide-studio block %s */\n:root { %s: %s; }\n";
const LEGACY_BLOCK_SELECTOR = '#stage :is(p, ul, ol, h3, h4, blockquote, table, pre, img, .animation):not(:is(ul, ol, blockquote, table, .cover, .section-slide) *):not(p:has(img)):not([style*="border:"] *):not([style*="background-color:"] *)';

function blockOverride(key: string, value: string): string {
  let css = BLOCK_TEMPLATE
    .replace("%s", BLOCK_KEYS[key]!)
    .replace("%s", key)
    .replace("%s", value);
  if (["--block-quote-line", "--block-bracket-line", "--block-fold-line"].includes(key)) {
    const match = /^([\d.]+px) (?:solid|dashed|dotted|double) (#[0-9a-fA-F]{8})$/u.exec(value);
    if (match) {
      const stem = key.replace(/-line$/u, "");
      css += `/* block detail ${stem} */\n:root { ${stem}-accent:${match[2]}; ${stem}-width:${match[1]}; }\n`;
    }
  }
  return css;
}

const BLOCK_RES: Record<string, RegExp> = Object.fromEntries(
  Object.entries(BLOCK_KEYS).map(([key, property]): [string, RegExp] => {
    const source = escapeRegExp(blockOverride(key, "VALUE")).replace("VALUE", "([^;{}]+)")
      + `(?:${escapeRegExp(`${LEGACY_BLOCK_SELECTOR} { ${property}: var(${key}); }\n`)})?`
      + `(?:/\\* block detail ${escapeRegExp(key.replace(/-line$/u, ""))} \\*/\\n:root \\{[^{}]*\\}\\n)?`;
    return [key, new RegExp(source, "u")];
  }),
);

const CONTENT_KEYS = ["--table-header-bg", "--table-header-ink", "--table-ink", "--math-ink"] as const;

function headingOptions(values: Record<string, string>): string {
  const mode = values["--heading-mode"]!;
  return "\n/* slide-studio heading options */\n:root { "
    + Object.keys(HEADING_OPTIONS).map((key) => `${key}: ${values[key]};`).join(" ")
    + " }\n"
    + HEADING_LAYOUT
    + (mode === "rule" ? HEADING_RULE : mode === "fill" ? HEADING_FILL : "")
    + "/* end heading options */\n";
}

function headingFill(css: string): string {
  const match = OVERRIDE_RE.exec(css);
  if (match) return match[1]!;
  if (css.includes("linear-gradient(105deg,#123c62,#205c8b)")) {
    return "linear-gradient(105deg, var(--header), #205c8b)";
  }
  return "theme";
}

function kindFill(css: string, key: string): string {
  const match = KIND_RES[key]!.exec(css) ?? BG_RE.exec(css);
  return match ? match[1]! : "theme";
}

function declarations(css: string, knownVars: ReadonlySet<string>): Array<[string, number, number]> {
  const masked = css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => " ".repeat(comment.length));
  let depth = 0;
  let previous = 0;
  const output: Array<[string, number, number]> = [];
  for (const block of masked.matchAll(/[{}]/gu)) {
    const start = block.index ?? 0;
    const selector = masked.slice(previous, start);
    previous = start + 1;
    if (block[0] === "}") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && selector.trim() === ":root") {
      const end = masked.indexOf("}", start + 1);
      if (end >= 0) {
        const body = masked.slice(start + 1, end);
        for (const match of body.matchAll(/(--[\p{L}\p{N}_-]+)\s*:\s*([^;{}]+)/gu)) {
          if (!knownVars.has(match[1]!)) continue;
          const declarationStart = start + 1 + (match.index ?? 0);
          let valueStart = declarationStart + match[0].indexOf(":") + 1;
          while (valueStart < declarationStart + match[0].length && /\s/u.test(css[valueStart] ?? "")) {
            valueStart += 1;
          }
          let valueStop = declarationStart + match[0].length;
          while (valueStop > valueStart && /\s/u.test(css[valueStop - 1] ?? "")) valueStop -= 1;
          const priority = /\s*!important\s*$/iu.exec(masked.slice(valueStart, valueStop));
          if (priority) valueStop = valueStart + (priority.index ?? 0);
          const comment = css.indexOf("/*", valueStart);
          if (comment >= 0 && comment < valueStop) {
            valueStop = comment;
            while (valueStop > valueStart && /\s/u.test(css[valueStop - 1] ?? "")) valueStop -= 1;
          }
          output.push([match[1]!, valueStart, valueStop]);
        }
      }
    }
    depth += 1;
  }
  return output;
}

export function read_vars(
  css: string,
  themeVariables: readonly string[] = DEFAULT_THEME_VARIABLES,
): Record<string, string> {
  const known = new Set<string>([
    ...themeVariables,
    ...CONTENT_KEYS,
    "--link",
    FILL,
    ...Object.keys(KINDS),
    ...Object.keys(BLOCK_KEYS),
    ...Object.keys(HEADING_OPTIONS),
  ]);
  const colors: Record<string, string> = {};
  for (const [name, start, stop] of declarations(css, known)) colors[name] = css.slice(start, stop);
  const values: Record<string, string> = {
    ...HEADING_DEFAULTS,
    "--link": "#2167a8",
    ...Object.fromEntries(CONTENT_KEYS.map((key) => [key, "#000000"] as const)),
    ...colors,
    [FILL]: headingFill(css),
    ...Object.fromEntries(Object.keys(KINDS).map((key) => [key, kindFill(css, key)] as const)),
  };
  for (const [key, regex] of Object.entries(BLOCK_RES)) {
    const match = regex.exec(css);
    values[key] = match?.[1] ?? colors[key] ?? "theme";
  }
  return values;
}

export function refresh_heading_options(
  css: string,
  themeVariables: readonly string[] = DEFAULT_THEME_VARIABLES,
): string {
  const match = HEADING_RE.exec(css);
  if (!match) return css;
  const values = read_vars(css, themeVariables);
  const options: Record<string, string> = {};
  for (const key of Object.keys(HEADING_OPTIONS)) {
    const value = values[key];
    if (value === undefined || !HEADING_OPTIONS[key]!.includes(value)) return css;
    options[key] = value;
  }
  return css.slice(0, match.index) + headingOptions(options) + css.slice(match.index + match[0].length);
}

export function preserve_title_header(
  css: string,
  original?: string | null,
  themeVariables: readonly string[] = DEFAULT_THEME_VARIABLES,
): string {
  // The marker is the authoritative shape; the regex below is still kept for
  // parity/consumers, but an existing header must never be duplicated.
  if (TITLE_RE.test(css) || css.includes("/* slide-studio title header */")) return css;
  // Python uses `original or css`; an empty string means "fall back to css".
  const value = read_vars(original || css, themeVariables)["--header"] ?? "";
  if (/^#[0-9a-fA-F]{3,8}$/u.test(value)) return css + TITLE_TEMPLATE.replace("%s", value);
  return css;
}

export function drop_cover_layout(css: string): string {
  return css.replace(COVER_RE, "");
}

export { HEADING_OPTIONS, BG_RE };

export const FONTS = ['"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif', '"Hiragino Mincho ProN","Yu Mincho",serif', '"Menlo",monospace'];
const CONTENT_COLORS: Record<string, [string, string]> = {
  '--table-header-bg': ['#stage table th', 'background'],
  '--table-header-ink': ['#stage table th, #stage table th *', 'color'],
  '--table-ink': ['#stage table td, #stage table td *', 'color'],
  '--math-ink': ['#stage :is(.math, math), #stage :is(.math, math) *', 'color'],
};
function contentOverride(key: string, value: string): string {
  const [selector, property] = CONTENT_COLORS[key]!;
  return `\n/* slide-studio ${key.slice(2)} */\n:root { ${key}: ${value}; }\n${selector} { ${property}: var(${key}); }\n`;
}
const CONTENT_RES = Object.fromEntries(Object.keys(CONTENT_COLORS).map(key => [key, new RegExp(escapeRegExp(contentOverride(key, 'VALUE')).replace('VALUE', '(#[0-9a-fA-F]{6})'), 'u')]));
const TABLE_HEADER_TEMPLATE = '\n/* slide-studio table header */\n#stage table { --header: %s; }\n';
const TABLE_HEADER_RE = new RegExp(escapeRegExp(TABLE_HEADER_TEMPLATE).replace('%s', '(#[0-9a-fA-F]{3,8})'), 'u');
const INK_OVERRIDE = '\n/* slide-studio heading ink */\n#stage h2, #stage h2 * { color: var(--header-ink); }\n';
const RULE_OVERRIDE = '\n/* slide-studio heading rule */\n#stage h2 { border-color: var(--rule); } #stage h2::after { background-color: var(--rule); }\n';
const INK_RE = new RegExp(escapeRegExp(INK_OVERRIDE), 'u');
const RULE_RE = new RegExp(escapeRegExp(RULE_OVERRIDE), 'u');
const LINK_RE = /\n\/\* slide-studio link ink \*\/\n:root \{ --link: [^;{}]+; \}\n/u;
const ANGLE = '(?:[0-9]|[1-9][0-9]|[12][0-9]{2}|3[0-5][0-9])';
const STOP = '(?: (?:100|[0-9]{1,2})%)?';
const HEX = '#[0-9a-fA-F]{6}';
const POS = '-?(?:150|1[0-4][0-9]|[1-9]?[0-9])%';
const SIZE = '(?:200|1[0-9]{2}|[1-9][0-9]?)%';
const SPOT = String.raw`radial-gradient\(ellipse (?:${SIZE} ${SIZE} )?at ${POS} ${POS}, color-mix\(in srgb, ${HEX} (?:100|[0-9]{1,2})%, transparent\), transparent (?:1[0-4][0-9]|150|[1-9][0-9]?)%\)`;
const GROUND = String.raw`linear-gradient\(${ANGLE}deg, ${HEX}${STOP}, ${HEX}${STOP}\), `;
const BG_VALUE = new RegExp(String.raw`^(?:var\(--paper\)|${HEX}|linear-gradient\(${ANGLE}deg, var\(--paper\)${STOP}, ${HEX}${STOP}\)|(?:${SPOT}, ){1,8}(?:${GROUND})?var\(--paper\))$`, 'u');
const GRADIENT = new RegExp(String.raw`^linear-gradient\(${ANGLE}deg, var\(--header\)${STOP}, ${HEX}${STOP}\)$`, 'u');
const HEADING_POINTS = new RegExp(String.raw`^(?:${SPOT}, ){1,8}var\(--header\)$`, 'u');
const KNOWN = new Set([...DEFAULT_THEME_VARIABLES, ...CONTENT_KEYS, '--link', FILL, ...Object.keys(KINDS), ...Object.keys(BLOCK_KEYS), ...Object.keys(HEADING_OPTIONS)]);
const FONT_VALUE = new RegExp(`^[\\p{L}\\p{N}_${PY_WS},"'-]+$`, 'u');
const COLOR_VALUE = new RegExp(String.raw`^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]+|(?:rgba?|hsla?|var)\([\p{L}\p{N}_${PY_WS}.,%#+/-]+\))$`, 'u');
function strip(css: string, regex: RegExp): string { return css.replace(new RegExp(regex.source, regex.flags.replace('g', '') + 'g'), ''); }
export function valid_heading(value: unknown): value is string {
  return typeof value === 'string' && (value === 'theme' || value === 'var(--header)' || GRADIENT.test(value) || HEADING_POINTS.test(value));
}
export function valid_background(value: unknown): value is string {
  return typeof value === 'string' && (value === 'theme' || BG_VALUE.test(value));
}
export function valid_block(key: string, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === 'theme') return true;
  if (BLOCK_RADII.has(key)) return /^(?:[0-9]|[1-3][0-9]|40)px$/u.test(value);
  if (BLOCK_SHADOWS.has(key)) return /^(?:0(?:\.[0-9]{1,2})?|1(?:\.0{1,2})?)$/u.test(value);
  if (BLOCK_LINES.has(key)) return value === 'none' || /^(?:(?:[1-9]|1[0-9])(?:\.5)?|20)px (?:solid|dashed|dotted|double) #[0-9a-fA-F]{8}$/u.test(value);
  return value === 'transparent' || /^#[0-9a-fA-F]{8}$/u.test(value);
}
export function set_vars(css: string, input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('テーマの値が正しくありません');
  const values: Record<string, unknown> = { ...input };
  const has = (key: string) => Object.hasOwn(values, key);
  if (has('--header')) {
    const before = read_vars(css)['--header'] ?? '';
    if (!TABLE_HEADER_RE.test(css) && /^#[0-9a-fA-F]{3,8}$/u.test(before)) css += TABLE_HEADER_TEMPLATE.replace('%s', before);
    css = preserve_title_header(css);
  }
  for (const [key, regex] of Object.entries(CONTENT_RES)) {
    if (!has(key)) continue;
    const value = values[key]; delete values[key];
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(value)) throw new Error('表・数式の色が正しくありません');
    css = strip(css, regex) + contentOverride(key, value);
  }
  const current = read_vars(css);
  const options = Object.fromEntries(Object.keys(HEADING_OPTIONS).map(key => [key, current[key]!]));
  if (values[FILL] === 'theme' && !has('--heading-mode')) options['--heading-mode'] = 'theme';
  let changed = Object.keys(HEADING_OPTIONS).some(has);
  for (const [key, choices] of Object.entries(HEADING_OPTIONS)) {
    if (!has(key)) continue;
    const value = values[key]; delete values[key];
    if (typeof value !== 'string' || !choices.includes(value)) throw new Error('見出しの装飾が正しくありません');
    options[key] = value;
  }
  if (has('--header') || (has(FILL) ? values[FILL] : 'theme') !== 'theme') { options['--heading-mode'] = 'fill'; changed = true; }
  else if (has('--rule')) { options['--heading-mode'] = 'rule'; changed = true; }
  if (values[FILL] === 'theme' && options['--heading-mode'] === 'theme') { changed = false; css = strip(css, HEADING_RE); }
  if (changed) css = strip(css, HEADING_RE) + headingOptions(options);
  for (const [key, regex] of Object.entries(BLOCK_RES)) {
    if (!has(key)) continue;
    const value = values[key]; delete values[key];
    if (!valid_block(key, value)) throw new Error('ブロックの装飾が正しくありません');
    css = strip(css, regex);
    if (value !== 'theme') css += blockOverride(key, value);
  }
  if (Object.keys(KINDS).some(has)) {
    const legacy = BG_RE.test(css);
    const backgrounds = Object.fromEntries(Object.keys(KINDS).map(key => [key, kindFill(css, key)]));
    css = strip(css, BG_RE);
    for (const [key, regex] of Object.entries(KIND_RES)) {
      if (!has(key) && !legacy) continue;
      const value = has(key) ? values[key] : backgrounds[key]; delete values[key];
      if (!valid_background(value)) throw new Error('背景のグラデーションが正しくありません');
      css = strip(css, regex);
      if (value !== 'theme') css += kindOverride(key, value);
    }
  }
  if (has(FILL) && values[FILL] === null) throw new Error('見出しのグラデーションが正しくありません');
  let fill = values[FILL]; delete values[FILL];
  if (fill !== undefined && !valid_heading(fill)) throw new Error('見出しのグラデーションが正しくありません');
  if (fill !== undefined || has('--header') || has('--header-ink')) {
    fill = fill || headingFill(css);
    if (fill === 'theme' && has('--header')) fill = 'var(--header)';
    css = strip(css, OVERRIDE_RE);
    if (fill !== 'theme') css += OVERRIDE.replace('%s', String(fill));
  }
  if (has('--rule')) css = strip(css, RULE_RE) + RULE_OVERRIDE;
  if (has('--header-ink')) css = strip(css, INK_RE) + INK_OVERRIDE;
  for (const [key, value] of Object.entries(values)) {
    if (!(DEFAULT_THEME_VARIABLES as readonly string[]).includes(key) && key !== '--link' || typeof value !== 'string' || !(key.startsWith('--font-') ? FONT_VALUE : COLOR_VALUE).test(value)) throw new Error(`テーマの値が正しくありません: ${key}`);
  }
  if (has('--link') && !declarations(css, KNOWN).some(([key]) => key === '--link')) css += `\n/* slide-studio link ink */\n:root { --link: ${values['--link']}; }\n`;
  const spans = declarations(css, KNOWN);
  if (Object.keys(values).some(key => !spans.some(([name]) => name === key))) throw new Error('テーマの :root に変数がありません');
  for (const [key, start, end] of spans.reverse()) if (has(key)) css = css.slice(0, start) + String(values[key]) + css.slice(end);
  return css;
}
export function restore(css: string, previous: unknown): string {
  if (typeof previous !== 'string') throw new Error('テーマの値が正しくありません');
  for (const [key, regex] of Object.entries(BLOCK_RES)) {
    const match = regex.exec(previous);
    if (match && !valid_block(key, match[1])) throw new Error('ブロックの装飾が正しくありません');
  }
  const optionMatch = HEADING_RE.exec(previous);
  if (optionMatch) {
    const all = read_vars(previous), options = Object.fromEntries(Object.keys(HEADING_OPTIONS).map(key => [key, all[key]!]));
    if (Object.entries(options).some(([key, value]) => !HEADING_OPTIONS[key]!.includes(value)) || headingOptions(options) !== optionMatch[0]) throw new Error('見出しの装飾が正しくありません');
  }
  for (const regex of [BG_RE, ...Object.values(KIND_RES)]) {
    const match = regex.exec(previous);
    if (match && !BG_VALUE.test(match[1]!)) throw new Error('背景のグラデーションが正しくありません');
  }
  const fill = OVERRIDE_RE.exec(previous);
  if (fill && !valid_heading(fill[1])) throw new Error('見出しのグラデーションが正しくありません');
  function skeleton(text: string): string {
    for (const regex of [TITLE_RE, TABLE_HEADER_RE, ...Object.values(CONTENT_RES), HEADING_RE, OVERRIDE_RE, BG_RE, INK_RE, LINK_RE, RULE_RE, ...Object.values(BLOCK_RES), ...Object.values(KIND_RES)]) text = strip(text, regex);
    for (const [, start, end] of declarations(text, KNOWN).reverse()) text = text.slice(0, start) + '\0' + text.slice(end);
    return text;
  }
  if (skeleton(css) !== skeleton(previous)) throw new Error('テーマの変数以外は変更できません');
  return previous;
}
