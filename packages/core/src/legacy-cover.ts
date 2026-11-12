/**
 * Faithful TypeScript port of `.reference/parity/cover.py`.
 *
 * Only the cover helpers used by the source parser (and their HTML helpers) live
 * here. String conversion follows Python's truthiness/`str()` behavior where it
 * is observable, because front matter values are YAML and can be arbitrary.
 */

export interface LegacyAuthor {
  name: string;
  affiliations: string[];
}

/** True for values Python would call a `dict` for the purposes of this module. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Python truthiness (not JavaScript truthiness). */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0; // NaN is truthy in Python.
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python's `str()` for the primitive/container values YAML can produce. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isPlainObject(value)) {
    const parts = Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`);
    return `{${parts.join(", ")}}`;
  }
  return String(value);
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    return `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;
  }
  return pyStr(value);
}

// Python's str.isspace() set. It is close to JS \s but deliberately excludes
// U+FEFF (a JS whitespace character, not a Python one).
export const PY_WS = String.raw`\t\n\v\f\r \x1c-\x1f\x85\p{Z}`;
const PY_LSTRIP = new RegExp(String.raw`^[${PY_WS}]+`, "u");
const PY_RSTRIP = new RegExp(String.raw`[${PY_WS}]+$`, "u");

export function pyLstrip(value: string): string {
  return value.replace(PY_LSTRIP, "");
}

export function pyRstrip(value: string): string {
  return value.replace(PY_RSTRIP, "");
}

/** Python's `str.strip()` (Unicode whitespace, excluding the JS-only BOM case). */
export function pyStrip(value: string): string {
  return pyRstrip(pyLstrip(value));
}

/** Values produced by iterating a Python value with `for ... in ...`. */
function pyIterable(value: unknown): unknown[] {
  if (!pyTruthy(value)) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (isPlainObject(value)) return Object.keys(value);
  return [];
}

function text(value: unknown): string {
  if (isPlainObject(value)) {
    if (pyTruthy(value.literal)) return pyStrip(pyStr(value.literal));
    return ["family", "given"]
      .filter((key) => pyTruthy(value[key]))
      .map((key) => pyStrip(pyStr(value[key])))
      .join(" ");
  }
  return value === null || value === undefined ? "" : pyStrip(pyStr(value));
}

/** `authors(meta)` from cover.py: `[{name, affiliations: [所属名]}]`. */
export function authors(meta: Record<string, unknown>): LegacyAuthor[] {
  const raw = meta.author;
  if (raw === null || raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : [raw];

  const table = new Map<string, string>();
  for (const affiliation of pyIterable(meta.affiliations)) {
    if (isPlainObject(affiliation) && affiliation.id !== null && affiliation.id !== undefined) {
      table.set(pyStr(affiliation.id), text(affiliation.name));
    }
  }

  const out: LegacyAuthor[] = [];
  for (const item of items) {
    let name: string;
    let affiliationValue: unknown;
    if (isPlainObject(item)) {
      name = text(item.name);
      affiliationValue = Object.prototype.hasOwnProperty.call(item, "affiliations")
        ? item.affiliations
        : item.affiliation;
    } else {
      name = text(item);
      affiliationValue = null;
    }
    if (!name) continue;

    let affiliations: unknown[];
    if (affiliationValue === null || affiliationValue === undefined) affiliations = [];
    else if (Array.isArray(affiliationValue)) affiliations = affiliationValue;
    else affiliations = [affiliationValue];

    const names: string[] = [];
    for (const affiliation of affiliations) {
      let resolved: string;
      if (isPlainObject(affiliation)) {
        resolved = affiliation.ref !== null && affiliation.ref !== undefined
          ? table.get(pyStr(affiliation.ref)) ?? ""
          : text(affiliation.name);
      } else {
        resolved = text(affiliation);
      }
      if (resolved && !names.includes(resolved)) names.push(resolved);
    }
    out.push({ name, affiliations: names });
  }
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#x27;");
}

/** `html_block(people, layout=None)` from cover.py. */
export function html_block(people: LegacyAuthor[], layout: unknown = null): string {
  const body = htmlBlockBody(people);
  if (!body) return body;

  const settings = isPlainObject(layout) ? layout : {};
  const requestedPosition = settings.position;
  let position = typeof requestedPosition === "string" ? requestedPosition : "bottom";
  if (position !== "bottom" && position !== "right" && position !== "left") position = "bottom";

  const styles: string[] = [];
  for (const [key, property] of [
    ["x", "left"],
    ["y", "top"],
    ["size", "--cover-name-size"],
    ["affSize", "--cover-aff-size"],
  ] as const) {
    const value = settings[key];
    if (
      typeof value === "number"
      && -10000 <= value
      && value <= 10000
      && (key === "x" || key === "y" || value >= 1)
    ) {
      styles.push(`${property}:${value}px`);
    }
  }

  const attrs = [`data-affiliation-position="${position}"`];
  for (const [key, attribute] of [["font", "name-font"], ["affFont", "aff-font"]] as const) {
    const font = settings[key];
    if (font === "sans" || font === "serif" || font === "mono") {
      attrs.push(`data-${attribute}="${font}"`);
    }
  }
  for (const [key, attribute] of [["bold", "name-bold"], ["affBold", "aff-bold"]] as const) {
    if (typeof settings[key] === "boolean") {
      attrs.push(`data-${attribute}="${settings[key] ? "true" : "false"}"`);
    }
  }

  const search = '<div class="cover-authors';
  const replacement = `<div ${attrs.join(" ")} style="${styles.join(";")}" class="cover-authors`;
  return body.replace(search, () => replacement);
}

function htmlBlockBody(people: LegacyAuthor[]): string {
  if (people.length === 0) return "";

  const order: string[] = [];
  for (const person of people) {
    for (const affiliation of person.affiliations) {
      if (!order.includes(affiliation)) order.push(affiliation);
    }
  }

  const sets = new Set(people.map((person) => JSON.stringify(person.affiliations)));

  // Everyone has the same affiliations: list the names and one affiliation row.
  if (people.length > 1 && sets.size === 1) {
    const names = people
      .map((person) => `<span class="cover-author">${escapeHtml(person.name)}</span>`)
      .join("");
    const affiliations = order
      .map((affiliation) => `<span class="cover-affiliation">${escapeHtml(affiliation)}</span>`)
      .join("");
    return `<div class="cover-authors"><p class="cover-names">${names}</p>`
      + (affiliations ? `<p class="cover-affiliations">${affiliations}</p>` : "")
      + "</div>";
  }

  const shared = order.some(
    (affiliation) => people.filter((person) => person.affiliations.includes(affiliation)).length > 1,
  );

  // No shared affiliations: one name/affiliation row per person.
  if (!shared) {
    const rows = people.map((person) => {
      const affiliation = person.affiliations.length
        ? `<span class="cover-affiliation">${escapeHtml(person.affiliations.join("・"))}</span>`
        : "";
      return `<p class="cover-author"><span class="cover-name">${escapeHtml(person.name)}</span>${affiliation}</p>`;
    }).join("");
    return `<div class="cover-authors each">${rows}</div>`;
  }

  // Shared affiliations: mark names and collect affiliations below.
  const marks = new Map(order.map((affiliation, index) => [affiliation, `*${index + 1}`]));
  const names = people.map((person) => {
    const marksForPerson = person.affiliations.map((affiliation) => marks.get(affiliation)!).join(",");
    const sup = person.affiliations.length ? `<sup>${marksForPerson}</sup>` : "";
    return `<span class="cover-author">${escapeHtml(person.name)}${sup}</span>`;
  }).join("");
  const affiliations = order
    .map((affiliation) => `<span class="cover-affiliation"><sup>${marks.get(affiliation)}</sup>${escapeHtml(affiliation)}</span>`)
    .join("");
  return `<div class="cover-authors marked"><p class="cover-names">${names}</p><p class="cover-affiliations">${affiliations}</p></div>`;
}
