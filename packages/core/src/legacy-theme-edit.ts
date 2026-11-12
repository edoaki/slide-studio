/**
 * Faithful TypeScript port of `.reference/parity/theme_edit.py` for the parts
 * the workspace needs: reading variables, refreshing heading options, dropping
 * legacy cover layout edits, and preserving the title header. The functions are
 * pure so `legacy-workspace.ts` can run them against an instance template root.
 */

// Same required-variable set as `workspace.THEME_VARIABLES` for the bundled
// `_base.css`. `legacy-workspace` passes its instance-scoped list explicitly;
// this default keeps direct helper calls faithful to the Python module.
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
  escapeRegExp(TITLE_TEMPLATE).replace("%s", "([0-9a-fA-F]{3,8})"),
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
