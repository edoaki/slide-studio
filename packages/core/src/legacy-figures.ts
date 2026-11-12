/**
 * Faithful TypeScript port of `.reference/parity/figures.py`.
 *
 * A figure is a folder containing `index.html`, `figure.mjs` and an optional
 * `style.css`. Copying a figure also copies the static module dependencies it
 * imports into `_lib/`, rewrites relative import specifiers, and keeps the
 * index template in sync with the runtime location.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { atomicWriteFile } from "./atomic.js";
import { codePointLength, fig_args, parse } from "./legacy-source.js";
import type { Workspace } from "./legacy-workspace.js";
import { StudioError, TEMPLATES, check_name, runtime_rel } from "./legacy-workspace.js";

/** Static `import … from './x.mjs'`, `import './x.mjs'` and `export … from`. */
export const IMPORT_SPEC =
  /^([ \t]*(?:import[ \t]*|(?:import|export)\b[^;'"()=]*?\bfrom[ \t]*))(['"])([^'"\n]+)\2/gmu;
export const DYNAMIC = /\bimport\s*\(|\bfetch\s*\(/u;
export const SKIP = new Set(["index.html", "main.mjs", ".DS_Store"]);

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function modeFor(path: string): number {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return stat.mode & 0o777;
  } catch {
    // New file: use the process default.
  }
  return 0o666 & ~process.umask();
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await atomicWriteFile(path, data, modeFor(path));
}

function copyFilePreserve(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  try {
    chmodSync(destination, statSync(source).mode & 0o777);
  } catch {
    // Windows may not support every mode bit; the content is still copied.
  }
}

function cpSlice(value: string, start: number, end: number): string {
  if (start <= 0 && end >= codePointLength(value)) return value;
  return Array.from(value).slice(start, end).join("");
}

function comparePaths(left: string, right: string): number {
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

/** Sorted recursive entries (files and directories), excluding symlinked traversal. */
function rglob(root: string): string[] {
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        output.push(path);
        continue;
      }
      output.push(path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return output.sort(comparePaths);
}

export function imports(code: string): string[] {
  const output: string[] = [];
  for (const match of code.matchAll(IMPORT_SPEC)) {
    const spec = match[3]!;
    if (spec.startsWith(".")) output.push(spec);
  }
  return output;
}

export function index_html(fig_dir: string, ws: Workspace): string {
  const style = existsSync(join(fig_dir, "style.css"))
    ? '<link rel="stylesheet" href="style.css">\n'
    : "";
  return readFileSync(join(TEMPLATES, "figure", "index.html"), "utf8")
    .split("{{RUNTIME}}").join(runtime_rel(fig_dir, ws))
    .split("{{STYLE}}").join(style);
}

export async function write_index(fig_dir: string, ws: Workspace): Promise<void> {
  await writeAtomic(join(fig_dir, "index.html"), index_html(fig_dir, ws));
}

/** Rewrite `index.html` from the template; returns true when it changed. */
export async function ensure_index(fig_dir: string, ws: Workspace): Promise<boolean> {
  if (!existsSync(join(fig_dir, "figure.mjs"))) return false;
  const wanted = index_html(fig_dir, ws);
  try {
    if (readFileSync(join(fig_dir, "index.html"), "utf8") === wanted) return false;
  } catch {
    // Missing or unreadable index.html is recreated.
  }
  await writeAtomic(join(fig_dir, "index.html"), wanted);
  return true;
}

export function free_name(base: string, name: string): string {
  if (!existsSync(join(base, name))) return name;
  let number = 2;
  while (existsSync(join(base, `${name}-${number}`))) number += 1;
  return `${name}-${number}`;
}

export async function new_figure(
  ws: Workspace,
  name: string,
  base: string,
  title?: string | null,
): Promise<string> {
  check_name(name, "図の名前");
  const basePath = canonical(base);
  if (!isInside(canonical(ws.root), basePath)) {
    throw new StudioError("図の置き場は保管フォルダの中にしてください");
  }
  const destination = join(basePath, name);
  if (existsSync(destination)) {
    throw new StudioError(`既にあります: ${destination}`);
  }
  mkdirSync(destination, { recursive: true });
  const template = join(TEMPLATES, "figure");
  const figure = readFileSync(join(template, "figure.mjs"), "utf8")
    .split("{{NAME}}").join(name)
    .split("{{TITLE}}").join(title || name);
  await writeAtomic(join(destination, "figure.mjs"), figure);
  copyFilePreserve(join(template, "style.css"), join(destination, "style.css"));
  await write_index(destination, ws);
  return destination;
}

/** Copy a figure folder and every static dependency into a destination base. */
export class Copier {
  readonly #ws: Workspace;
  readonly #srcDir: string;
  readonly #dstBase: string;
  readonly #allow: string[];
  readonly #libNames: Set<string>;
  readonly #siblings: Map<string, string>;
  readonly placed = new Map<string, string>();
  readonly stack = new Set<string>();
  #figDst = "";

  constructor(
    ws: Workspace,
    src_dir: string,
    dst_base: string,
    lib_names: string[] = ["_lib"],
    siblings: Map<string, string> = new Map(),
    allow?: string | null,
  ) {
    this.#ws = ws;
    this.#srcDir = canonical(src_dir);
    this.#dstBase = canonical(dst_base);
    this.#libNames = new Set(lib_names);
    this.#siblings = new Map(
      [...siblings].map(([source, destination]) => [canonical(source), destination]),
    );
    this.#allow = [canonical(ws.root), canonical(TEMPLATES)];
    if (allow) this.#allow.push(canonical(allow));
  }

  get ws(): Workspace {
    return this.#ws;
  }

  resolve(owner: string, spec: string): string {
    const candidate = resolve(dirname(owner), spec);
    if (!existsSync(candidate)) {
      throw new StudioError(`import 先がありません: ${spec}（${owner}）`);
    }
    const path = canonical(candidate);
    if (!this.#allow.some((root) => isInside(root, path))) {
      throw new StudioError(`置き場の外の部品は使えません: ${spec}（${owner}）`);
    }
    return path;
  }

  async rewrite(owner_src: string, owner_dst: string, code: string): Promise<string> {
    const matches = [...code.matchAll(IMPORT_SPEC)];
    if (matches.length === 0) return code;
    let output = "";
    let last = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      output += code.slice(last, index);
      const prefix = match[1]!;
      const quote = match[2]!;
      const spec = match[3]!;
      if (!spec.startsWith(".")) {
        output += match[0];
      } else {
        const dependency = this.resolve(owner_src, spec);
        const target = await this.target_of(dependency, owner_dst);
        let rel = relative(dirname(owner_dst), target).replaceAll(sep, "/");
        if (!rel.startsWith(".")) rel = `./${rel}`;
        output += `${prefix}${quote}${rel}${quote}`;
      }
      last = index + match[0].length;
    }
    return output + code.slice(last);
  }

  async target_of(dependency: string, owner_dst: string): Promise<string> {
    if (isInside(this.#srcDir, dependency)) {
      return join(this.#figDst, relative(this.#srcDir, dependency));
    }
    for (const [source, destination] of this.#siblings) {
      if (isInside(source, dependency)) return join(destination, relative(source, dependency));
    }
    return this.place_lib(dependency);
  }

  async place_lib(dependency: string): Promise<string> {
    const existing = this.placed.get(dependency);
    if (existing) return existing;
    const lib = join(this.#dstBase, "_lib");
    const parent = dirname(dependency);
    const stemName = this.#libNames.has(basename(parent))
      ? basename(dependency)
      : `${basename(parent)}-${basename(dependency)}`;

    if (this.stack.has(dependency)) {
      // A cycle: decide the name without comparing contents.
      const target = join(lib, stemName);
      this.placed.set(dependency, target);
      return target;
    }

    this.stack.add(dependency);
    try {
      let data: Uint8Array = readFileSync(dependency);
      if (dependency.endsWith(".mjs") || dependency.endsWith(".js")) {
        data = Buffer.from(await this.rewrite(
          dependency,
          join(lib, stemName),
          readFileSync(dependency, "utf8"),
        ));
      }
      const extension = extname(stemName);
      const stem = stemName.slice(0, stemName.length - extension.length);
      let number = 1;
      let candidate = join(lib, stemName);
      for (;;) {
        candidate = join(lib, number === 1 ? stemName : `${stem}-${number}${extension}`);
        if (!existsSync(candidate)) {
          if (basename(candidate) !== stemName
            && (dependency.endsWith(".mjs") || dependency.endsWith(".js"))) {
            data = Buffer.from(await this.rewrite(
              dependency,
              candidate,
              readFileSync(dependency, "utf8"),
            ));
          }
          await writeAtomic(candidate, data);
          break;
        }
        const current = readFileSync(candidate);
        if (current.equals(Buffer.from(data))) break;
        number += 1;
      }
      this.placed.set(dependency, candidate);
      return candidate;
    } finally {
      this.stack.delete(dependency);
    }
  }

  async copy(name: string): Promise<string> {
    this.#figDst = join(this.#dstBase, name);
    if (!isInside(this.#dstBase, resolve(this.#figDst))) {
      throw new StudioError(`図の名前が正しくありません: ${name}`);
    }
    mkdirSync(this.#figDst, { recursive: true });
    for (const path of rglob(this.#srcDir)) {
      let stat: ReturnType<typeof statSync> | undefined;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat || !stat.isFile() || SKIP.has(basename(path))) continue;
      const real = canonical(path);
      if (!this.#allow.some((root) => isInside(root, real))) {
        throw new StudioError(`置き場の外の部品は使えません: ${path}（${this.#srcDir}）`);
      }
      const out = join(this.#figDst, relative(this.#srcDir, path));
      if (path.endsWith(".mjs") || path.endsWith(".js")) {
        await writeAtomic(out, await this.rewrite(path, out, readFileSync(path, "utf8")));
      } else {
        copyFilePreserve(path, out);
      }
    }
    await write_index(this.#figDst, this.#ws);
    return this.#figDst;
  }
}

/** Copy a figure to a shelf or deck `figures/` folder. */
export async function copy_figure(
  ws: Workspace,
  src_dir: string,
  dst_base: string,
  name?: string | null,
  replace = false,
): Promise<string> {
  if (!existsSync(join(src_dir, "figure.mjs"))) {
    throw new StudioError(`図がありません: ${src_dir}`);
  }
  const destinationBase = canonical(dst_base);
  if (!isInside(canonical(ws.root), destinationBase)) {
    throw new StudioError("図の置き場は保管フォルダの中にしてください");
  }
  let selected = name || basename(src_dir);
  if (replace && existsSync(join(destinationBase, selected))) {
    const target = join(destinationBase, selected);
    if (!isInside(destinationBase, target)) {
      throw new StudioError("図の置き場は保管フォルダの中にしてください");
    }
    rmSync(target, { recursive: true, force: true });
  } else if (!replace) {
    selected = free_name(destinationBase, selected);
  }
  if (!isInside(destinationBase, resolve(destinationBase, selected))) {
    throw new StudioError(`図の名前が正しくありません: ${selected}`);
  }
  return new Copier(ws, src_dir, destinationBase).copy(selected);
}

export const FIG_REF = /(\{\{<\s*fig\s+)("?)([^"\s>]+)\2/gu;

export function rewrite_refs(text: string, old: string, next: string): string {
  return text.replace(FIG_REF, (match, prefix: string, quote: string, ref: string) =>
    ref === old ? `${prefix}${quote}${next}${quote}` : match);
}

export function fig_refs(text: string): string[] {
  const doc = parse(text);
  const output: string[] = [];
  for (const page of doc.pages) {
    for (const chunk of page.walk()) {
      if (chunk.kind !== "fig") continue;
      const args = fig_args(cpSlice(text, chunk.start, chunk.end));
      if (args?.ref) output.push(args.ref);
    }
  }
  return output;
}

/** Every `.mjs` the figure reads, including statically imported dependencies. */
export function module_files(fig_dir: string): string[] {
  const seen: string[] = [];
  const pending = rglob(fig_dir)
    .filter((path) => path.endsWith(".mjs") && basename(path) !== "main.mjs");
  while (pending.length) {
    let path = canonical(pending.pop()!);
    if (seen.includes(path) || !existsSync(path)) continue;
    seen.push(path);
    for (const spec of imports(readFileSync(path, "utf8"))) {
      pending.push(resolve(dirname(path), spec));
    }
  }
  return seen;
}
