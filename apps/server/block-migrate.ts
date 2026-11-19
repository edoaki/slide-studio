import { pyStrip } from "../../packages/core/src/cover.js";
import { parse } from "../../packages/core/src/source.js";

const BLOCK_DECORATION = new Set([
  "border",
  "background-color",
  "--block-design",
  "border-top",
  "border-left",
  "border-radius",
  "box-shadow",
]);

const BLOCK_DESIGNS: Record<string, Record<string, string>> = {
  plain: {},
  top: {},
  left: {},
  quote: {},
  bracket: {},
  fold: {},
  shadow: {
    border: "0 solid transparent",
    "border-radius": "10px",
    "background-color": "var(--block-shadow-fill)",
    "box-shadow": "0 4px 14px var(--block-shadow-color)",
  },
  corner: {
    border: "0 solid transparent",
    "border-radius": "10px",
    "border-top": "var(--block-corner-top)",
    "border-left": "var(--block-corner-left)",
    "background-color": "var(--block-corner-fill)",
  },
};

const BLOCK_COLOR = "#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?";
const BLOCK_BORDER = new RegExp(
  String.raw`^[\d.]+px (?:solid|dashed|dotted|double) ${BLOCK_COLOR}$`,
  "u",
);
const BLOCK_COLOR_FULL = new RegExp(String.raw`^${BLOCK_COLOR}$`, "u");
const BLOCK_STYLE = /(\{[^{}\n]*?\bstyle=")([^"]*)(")/gu;
const BLOCK_EXTRA_KEYS = new Set([
  "--block-design",
  "border-top",
  "border-left",
  "border-radius",
  "box-shadow",
]);
const BLOCK_COLUMN_DECORATION = new Set([...BLOCK_DECORATION, "--block-shadow"]);

function blockProps(style: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of style.split(";")) {
    if (!part.includes(":")) continue;
    const colon = part.indexOf(":");
    pairs.push([
      pyStrip(part.slice(0, colon)),
      pyStrip(part.slice(colon + 1)),
    ]);
  }
  return pairs;
}

function blockKind(props: Record<string, string>): string | null | false {
  const design = props["--block-design"];
  if (design !== undefined && Object.prototype.hasOwnProperty.call(BLOCK_DESIGNS, design)) {
    return design;
  }
  const border = props.border;
  const fill = props["background-color"];
  if (
    (border === undefined && fill === undefined)
    || Object.keys(props).some((key) => BLOCK_EXTRA_KEYS.has(key))
  ) {
    return false;
  }
  if (border !== undefined && !(border === "none" || BLOCK_BORDER.test(border))) {
    return false;
  }
  if (fill !== undefined && !(fill === "transparent" || BLOCK_COLOR_FULL.test(fill))) {
    return false;
  }
  return (border !== undefined && border !== "none")
    || (fill !== undefined && fill !== "transparent")
    ? "plain"
    : null;
}

function blockDesignValues(kind: string | null): Array<[string, string]> {
  if (kind === null) return [];
  return [["--block-design", kind], ...Object.entries(BLOCK_DESIGNS[kind] ?? {})];
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) && right[key] === left[key]);
}

function migrateBlockStyles(text: string): string {
  return text.replace(BLOCK_STYLE, (_match, prefix: string, style: string, suffix: string) => {
    const props = blockProps(style);
    const kind = blockKind(Object.fromEntries(props));
    if (kind === false) return _match;
    const rest = [
      ...props.filter(([key]) => !BLOCK_DECORATION.has(key)),
      ...blockDesignValues(kind),
    ];
    if (rest.length === 0) return _match;
    if (sameRecord(Object.fromEntries(rest), Object.fromEntries(props))) return _match;
    return `${prefix}${rest.map(([key, value]) => `${key}:${value}`).join(";")}${suffix}`;
  });
}

export function cpSlice(value: string, start: number, end: number): string {
  return Array.from(value).slice(Math.max(0, start), Math.max(0, end)).join("");
}

function normalizeBlockColumns(text: string): string {
  let current = text;
  while (true) {
    let edits: Array<[number, number, string]> | null = null;
    for (const page of parse(current).pages) {
      for (const column of page.walk()) {
        if (column.kind !== "column" || column.children.length !== 1 || !column.open) continue;
        const box = column.children[0]!;
        if (
          box.kind !== "box"
          || !box.open
          || !box.close
          || !box.attrs
          || box.attrs.id
          || box.attrs.classes.length > 0
        ) {
          continue;
        }
        const outer = Object.fromEntries(blockProps(column.attrs?.kv.style ?? ""));
        const inner = Object.fromEntries(blockProps(box.attrs.kv.style ?? ""));
        if (
          Object.keys(outer).some((key) => BLOCK_COLUMN_DECORATION.has(key))
          && Object.keys(inner).some((key) => BLOCK_COLUMN_DECORATION.has(key))
        ) {
          continue;
        }
        if (
          Object.keys(inner).some((key) =>
            !["padding", "text-box", "--block-space"].includes(key)
            && Object.prototype.hasOwnProperty.call(outer, key))
        ) {
          continue;
        }
        if (Object.entries(box.attrs.kv).some(([key, value]) =>
          key !== "style"
          && Object.prototype.hasOwnProperty.call(column.attrs!.kv, key)
          && column.attrs!.kv[key] !== value)) {
          continue;
        }
        const kv: Record<string, string> = { ...column.attrs!.kv, ...box.attrs.kv };
        if (Object.keys(outer).length > 0 || Object.keys(inner).length > 0) {
          const style: Record<string, string> = { ...outer, ...inner };
          if (Object.prototype.hasOwnProperty.call(outer, "--block-space")) {
            style["--block-space"] = outer["--block-space"]!;
          }
          kv.style = Object.entries(style).map(([key, value]) => `${key}:${value}`).join(";");
        }
        const attrs: string[] = [];
        if (column.attrs!.id) attrs.push(`#${column.attrs!.id}`);
        for (const name of column.attrs!.classes) attrs.push(`.${name}`);
        for (const [key, value] of Object.entries(kv)) {
          attrs.push(
            `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
          );
        }
        const openLine = cpSlice(current, column.open[0], column.open[1]);
        const fence = /^\s*:{3,}/u.exec(openLine)?.[0];
        if (fence === undefined) continue;
        edits = [
          [column.open[0], column.open[1], `${fence} {${attrs.join(" ")}}`],
          [box.open[0], box.open[1], ""],
          [box.close[0], box.close[1], ""],
        ];
        break;
      }
      if (edits !== null) break;
    }
    if (edits === null) return current;
    edits.sort((left, right) => right[0] - left[0] || right[1] - left[1]);
    for (const [start, end, replacement] of edits) {
      current = cpSlice(current, 0, start) + replacement + cpSlice(current, end, Number.POSITIVE_INFINITY);
    }
  }
}

/** Migrate per-block decoration colors to the current kind-only source form. */
export function migrateBlockDesign(text: string): string {
  return normalizeBlockColumns(migrateBlockStyles(text));
}
