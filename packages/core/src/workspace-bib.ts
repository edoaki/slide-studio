/**
 * Conservative BibTeX entry splitter and deduplicating merger used during
 * workspace topic migration. Rejects ambiguous or malformed input rather than
 * discarding local data.
 */

export function bibEntries(text: string): Array<[string | null, string]> {
  const result: Array<[string | null, string]> = [];
  let position = 0;
  const pattern = /@([\p{L}\p{N}_-]+)\s*([({])/gu;
  const nextEntry = (start: number): RegExpExecArray | null => {
    pattern.lastIndex = start;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
      if (text.slice(lineStart, match.index).includes("%")) {
        const newline = text.indexOf("\n", pattern.lastIndex);
        if (newline < 0) return null;
        pattern.lastIndex = newline + 1;
        continue;
      }
      return match;
    }
    return null;
  };

  let first = nextEntry(position);
  while (first) {
    const match = first;
    if (text.slice(position, match.index).trim()) {
      result.push([null, text.slice(position, match.index).trim()]);
    }
    const opening = match[2]!;
    let depth = 1;
    let quoted = false;
    let escaped = false;
    let brace = 0;
    let index = pattern.lastIndex;
    while (index < text.length) {
      const character = text[index]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"' && (opening === "{" ? depth === 1 : brace === 0)) quoted = !quoted;
      else if (!quoted) {
        if (opening === "{") {
          if (character === "{") depth += 1;
          else if (character === "}") depth -= 1;
        } else {
          if (character === "{") brace += 1;
          else if (character === "}") brace -= 1;
          else if (character === ")" && brace === 0) depth -= 1;
        }
      }
      index += 1;
      if (depth === 0) break;
    }
    if (depth !== 0) throw new Error("BibTeX");
    const raw = text.slice(match.index, index).trim();
    const kind = match[1]!.toLowerCase();
    const body = text.slice(match.index + match[0].length, index - 1);
    let key: string | null;
    if (kind === "comment" || kind === "preamble") {
      key = null;
    } else if (kind === "string") {
      const macro = /^\s*([^=\s]+)\s*=/u.exec(body);
      if (!macro) throw new Error("BibTeX");
      key = `@string:${macro[1]!.toLowerCase()}`;
    } else {
      const keyMatch = /^\s*([^,\s]+)\s*,/u.exec(body);
      if (!keyMatch) throw new Error("BibTeX");
      key = keyMatch[1]!;
    }
    result.push([key, raw]);
    position = index;
    first = nextEntry(position);
  }
  if (text.slice(position).trim()) result.push([null, text.slice(position).trim()]);
  return result;
}

function bibFields(raw: string): Array<[string, string]> {
  const output: Array<[string, string]> = [];
  let index = raw.indexOf(",") + 1;
  const end = raw.length - 1;
  while (index < end) {
    while (index < end && (/\s/u.test(raw[index]!) || raw[index] === ",")) index += 1;
    if (index >= end) break;
    if (raw[index] === "%") {
      index = raw.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    const match = /^([\p{L}\p{N}_-]+)\s*=\s*/u.exec(raw.slice(index));
    if (!match) throw new Error("BibTeX");
    index += match[0].length;
    const valueStart = index;
    let depth = 0;
    let quote = false;
    let escape = false;
    while (index < end) {
      const character = raw[index]!;
      if (escape) escape = false;
      else if (character === "\\") escape = true;
      else if (character === '"' && depth === 0) quote = !quote;
      else if (!quote) {
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        else if (character === "," && depth === 0) break;
      }
      index += 1;
    }
    output.push([match[1]!.toLowerCase(), raw.slice(valueStart, index).trim()]);
    index += 1;
  }
  return output;
}

function bibIdentity(key: string | null, raw: string): unknown {
  if (key === null || key.startsWith("@string:")) return raw;
  const kind = /^@([\p{L}\p{N}_-]+)/u.exec(raw)?.[1]?.toLowerCase() ?? "";
  const valueIdentity = (value: string): [string, string] => {
    if (
      (value.startsWith("{") && value.endsWith("}"))
      || (value.startsWith('"') && value.endsWith('"'))
    ) {
      return ["literal", value.slice(1, -1)];
    }
    if (/^\p{Nd}+$/u.test(value)) return ["literal", value];
    return ["expression", value];
  };
  return [
    kind,
    bibFields(raw)
      .map(([name, value]) => [name, valueIdentity(value)] as const)
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
  ];
}

export function mergeBibtexTexts(texts: string[]): string {
  const seen = new Map<string, string>();
  const output: string[] = [];
  const collisions = new Set<string>();
  for (const text of texts) {
    for (const [key, raw] of bibEntries(text)) {
      const content = JSON.stringify(bibIdentity(key, raw));
      if (key !== null && seen.has(key) && seen.get(key) !== content) collisions.add(key);
      if (key === null || !seen.has(key)) output.push(raw);
      if (key !== null) seen.set(key, content);
    }
  }
  if (collisions.size > 0) {
    throw new Error([...collisions].sort((left, right) => (left < right ? -1 : 1)).join(", "));
  }
  return `${output.join("\n\n")}${output.length > 0 ? "\n" : ""}`;
}
