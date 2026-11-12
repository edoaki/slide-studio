/**
 * Faithful TypeScript port of the palette portion of
 * `.reference/parity/block_design.py`. The workspace only repaints existing
 * block palettes, so the source-editing helpers are intentionally kept out.
 */

const PALETTE_MARK = "/* block palette v4:";
const PALETTE_RE = /\/\* block palette v\d+:.*?\*\/\n:root \{\n.*?\n\}\n/su;
const KEPT_RE = /(--block-\w+-shadow|--block-unframed-radius)\s*:\s*([^;\s]+)/gu;
const KINDS = ["plain", "top", "left", "quote", "bracket", "fold"] as const;
const LINE_WIDTH: Record<string, string> = { top: "8px", left: "10px" };
const FILL_CONTRAST: Record<"light" | "dark", number> = { light: 1.22, dark: 1.55 };
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u;

type RGB = [number, number, number];

function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference > 0.5) return floor + 1;
  if (difference < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function rgb(value: string | undefined): RGB | null {
  if (!value || !HEX.test(value)) return null;
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  ];
}

/** Python `colorsys.rgb_to_hls`. */
function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const sum = maximum + minimum;
  const range = maximum - minimum;
  const lightness = sum / 2;
  if (minimum === maximum) return [0, lightness, 0];
  const saturation = lightness <= 0.5 ? range / sum : range / (2 - sum);
  let hue: number;
  if (maximum === r) hue = (g - b) / range + (g < b ? 6 : 0);
  else if (maximum === g) hue = (b - r) / range + 2;
  else hue = (r - g) / range + 4;
  return [hue / 6, lightness, saturation];
}

function hueToRgb(m1: number, m2: number, hue: number): number {
  let value = hue;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return m1 + (m2 - m1) * value * 6;
  if (value < 1 / 2) return m2;
  if (value < 2 / 3) return m1 + (m2 - m1) * (2 / 3 - value) * 6;
  return m1;
}

/** Python `colorsys.hls_to_rgb`. */
function hlsToRgb(hue: number, lightness: number, saturation: number): RGB {
  if (saturation === 0) return [lightness, lightness, lightness];
  const m2 = lightness <= 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const m1 = 2 * lightness - m2;
  return [hueToRgb(m1, m2, hue + 1 / 3), hueToRgb(m1, m2, hue), hueToRgb(m1, m2, hue - 1 / 3)];
}

function luminance(color: RGB): number {
  const weights = [0.2126, 0.7152, 0.0722] as const;
  return color.reduce(
    (sum, value, index) => sum
      + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * weights[index]!,
    0,
  );
}

function contrast(left: RGB, right: RGB): number {
  const values = [luminance(left), luminance(right)].sort((a, b) => a - b);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

function hexColor(color: RGB): string {
  return `#${color.map((value) => pythonRound(value * 255).toString(16).padStart(2, "0")).join("")}ff`;
}

function mix(left: RGB, right: RGB, weight: number): RGB {
  return [
    left[0] * weight + right[0] * (1 - weight),
    left[1] * weight + right[1] * (1 - weight),
    left[2] * weight + right[2] * (1 - weight),
  ];
}

function sameColor(left: RGB, right: RGB): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

export function theme_palette(colors: Record<string, string>, keep: Record<string, string> = {}): string {
  const ink = rgb(colors["--ink"]);
  const paper = rgb(colors["--paper"]);
  const accent = rgb(colors["--accent"]);
  if (!ink || !paper || !accent) return "";
  const inkColor: RGB = ink;
  const paperColor: RGB = paper;
  const accentColor: RGB = accent;

  const dark = luminance(paperColor) < 0.2;

  const tint = (line: RGB): RGB => {
    const [hue, , saturation] = rgbToHls(...line);
    let level = rgbToHls(...paperColor)[1];
    const strength = Math.max(0.12, Math.min(dark ? 0.2 : 0.36, saturation * 0.6));
    const target = FILL_CONTRAST[dark ? "dark" : "light"];
    const step = dark ? 0.01 : -0.01;
    let fill = hlsToRgb(hue, level, strength);
    while (contrast(fill, paperColor) < target && level + step > 0 && level + step < 1) {
      level += step;
      fill = hlsToRgb(hue, level, strength);
    }
    return fill;
  };

  const bold = (line: RGB, fill: RGB): RGB => {
    const [hue, , saturation] = rgbToHls(...line);
    let level = rgbToHls(...line)[1];
    let value = line;
    const step = dark ? 0.01 : -0.01;
    while (contrast(value, fill) < 3 && level + step > 0 && level + step < 1) {
      level += step;
      value = hlsToRgb(hue, level, saturation);
    }
    return value;
  };

  const legible = (fill: RGB): RGB => {
    const end: RGB = luminance(fill) < 0.2 ? [1, 1, 1] : [0, 0, 0];
    for (let step = 0; step <= 50; step += 1) {
      const candidate = mix(end, inkColor, step / 50);
      if (contrast(candidate, fill) >= 5 || sameColor(candidate, end)) return candidate;
    }
    return end;
  };

  const [hue, , saturation] = rgbToHls(...accentColor);
  const light = dark ? 0.72 : 0.38;
  const good = rgb(colors["--good"]) ?? hlsToRgb((hue + 0.17) % 1, light, Math.max(0.2, saturation * 0.55));
  const memo = rgb(colors["--mark-line"]) ?? hlsToRgb(0.09, light, 0.5);
  const lines: RGB[] = [
    mix(inkColor, paperColor, 0.6),
    accentColor,
    good,
    rgb(colors["--muted"]) ?? hlsToRgb(hue, light, 0.12),
    hlsToRgb((hue + 0.09) % 1, light, Math.max(0.28, saturation * 0.55)),
    memo,
  ];

  const css = [`${PALETTE_MARK} 整理・結論・補足・引用・定義・メモ */`, ":root {"];
  for (let index = 0; index < KINDS.length; index += 1) {
    const kind = KINDS[index]!;
    const fill = kind === "plain" ? paperColor : tint(lines[index]!);
    const line = bold(lines[index]!, fill);
    const width = LINE_WIDTH[kind] ?? "3.5px";
    const radius = kind === "bracket" ? "0px" : "10px";
    const shadow = keep[`--block-${kind}-shadow`] ?? "0.18";
    const lineKey = kind === "plain" ? "--block-border" : `--block-${kind}-line`;
    const fillKey = kind === "plain" ? "--block-background" : `--block-${kind}-fill`;
    css.push(
      `  ${lineKey}:${width} solid ${hexColor(line)};`,
      `  ${fillKey}:${hexColor(fill)};`,
      `  --block-${kind}-ink:${hexColor(legible(fill))};`,
      `  --block-${kind}-radius:${radius};`,
      `  --block-${kind}-shadow:${shadow};`,
    );
    if (kind === "quote" || kind === "bracket" || kind === "fold") {
      css.push(
        `  --block-${kind}-accent:${hexColor(line)};`,
        `  --block-${kind}-width:${width};`,
      );
    }
  }
  css.push(
    `  --block-unframed-radius:${keep["--block-unframed-radius"] ?? "0px"}; `
      + `--block-unframed-shadow:${keep["--block-unframed-shadow"] ?? "0.18"};`,
    "}",
  );
  return `${css.join("\n")}\n`;
}

export function with_current_palette(css: string, colors: Record<string, string>): string {
  if (css.includes(PALETTE_MARK)) return css;
  const old = PALETTE_RE.exec(css);
  const keep: Record<string, string> = {};
  if (old) {
    for (const match of old[0].matchAll(KEPT_RE)) {
      if (match[1] && match[2]) keep[match[1]] = match[2];
    }
  }
  const palette = theme_palette(colors, keep);
  if (!palette) return css;
  if (old) return css.slice(0, old.index) + palette + css.slice(old.index + old[0].length);
  const marker = css.indexOf("/* slide-studio block ");
  return marker >= 0 ? css.slice(0, marker) + palette + css.slice(marker) : `${css}\n${palette}`;
}

export { PALETTE_MARK, PALETTE_RE };
