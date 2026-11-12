/**
 * Faithful port of the copying/rewrite helpers in
 * `.reference/parity/topic_migrate.py`. The migration itself stages every
 * byte, verifies the copies, and only then replaces `topics/`. Originals are
 * moved to `.slide-studio/trash/topics-v1/` instead of being deleted.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
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
import { fig_args } from "./legacy-source.js";
import { isInsideRoot } from "./paths.js";
import { StudioError } from "./legacy-workspace.js";
import type { Workspace } from "./legacy-workspace.js";

type SetFront = (text: string, values: Record<string, unknown>) => string;
type WorkspaceView = Pick<
  Workspace,
  | "root"
  | "topics"
  | "state"
  | "list_decks"
  | "deck_shelf"
  | "deck_dir"
  | "qmd"
  | "topic_dir"
  | "shelf_dir"
  | "figure_dir"
>;

const TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".svg"]);

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  const link = lstatOrNull(path);
  return Boolean(link && !link.isSymbolicLink() && link.isDirectory());
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o666 & ~process.umask());
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function assertInside(root: string, path: string, label: string): void {
  const real = existsSync(path) ? realpathSync.native(path) : path;
  if (!isInsideRoot(root, real)) {
    throw new StudioError(`workspace の外を指しています: ${label}`, "OUTSIDE_ROOT");
  }
}

function safeMkdir(root: string, path: string): void {
  if (resolve(path) === resolve(root)) {
    mkdirSync(path, { recursive: true });
    return;
  }
  const parent = dirname(path);
  if (parent !== path) {
    let ancestor = parent;
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    assertInside(root, ancestor, relative(root, path));
  }
  mkdirSync(path, { recursive: true });
  assertInside(root, path, relative(root, path));
}

function safeRemove(root: string, path: string): void {
  const link = lstatOrNull(path);
  if (!link) return;
  assertInside(root, dirname(path), relative(root, path));
  const realParent = realpathSync.native(dirname(path));
  const target = join(realParent, basename(path));
  const targetLink = lstatOrNull(target);
  if (!targetLink) return;
  if (targetLink.isSymbolicLink() || !targetLink.isDirectory()) {
    if (!targetLink.isDirectory()) rmSync(target, { force: true });
    return;
  }
  rmSync(target, { recursive: true, force: true });
}

function safeRename(root: string, from: string, to: string): void {
  assertInside(root, dirname(from), relative(root, from));
  safeMkdir(root, dirname(to));
  assertInside(root, dirname(to), relative(root, to));
  renameSync(from, to);
}

function assertNoSymlinks(root: string, path: string): void {
  const link = lstatOrNull(path);
  if (!link) return;
  if (link.isSymbolicLink()) {
    throw new StudioError(
      `シンボリックリンクは自動移行できません。リンク先をコピーしてから再実行してください: ${relative(root, path)}`,
      "CONFLICT",
    );
  }
  if (!link.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    assertNoSymlinks(root, join(path, entry.name));
  }
}

function filesUnder(root: string): Array<{ relative: string; absolute: string }> {
  const output: Array<{ relative: string; absolute: string }> = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const path = join(directory, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const link = lstatSync(path);
      if (link.isSymbolicLink()) {
        throw new StudioError(`シンボリックリンクはコピーできません: ${path}`, "CONFLICT");
      }
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile()) output.push({ relative: rel, absolute: path });
    }
  };
  const link = lstatOrNull(root);
  if (!link) return output;
  if (link.isFile()) return [{ relative: "", absolute: root }];
  if (link.isDirectory()) walk(root, "");
  return output;
}

export function hashes(root: string): Record<string, string> {
  const link = lstatOrNull(root);
  if (!link) return {};
  if (link.isFile()) return { "": sha256(readFileSync(root)) };
  return Object.fromEntries(
    filesUnder(root).map(({ relative: rel, absolute }): [string, string] =>
      [rel, sha256(readFileSync(absolute))]
    ),
  );
}

export function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const inState = resolve(directory) === resolve(root, ".slide-studio");
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (inState && (entry.name === "migrate" || entry.name === "trash")) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) result[relative(root, path).replaceAll(sep, "/")] = sha256(readFileSync(path));
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

export function signature(path: string): Record<string, string> {
  const base = isDirectory(path) ? path : dirname(path);
  const allowed = resolve(dirname(dirname(resolve(path))));
  const result = hashes(path);
  const pending = isDirectory(path) ? filesUnder(path).map((item) => item.absolute) : [path];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    let file: string;
    try {
      file = realpathSync.native(next);
    } catch {
      continue;
    }
    if (seen.has(file)) continue;
    seen.add(file);
    let statValue: Stats;
    try {
      statValue = statSync(file);
    } catch {
      continue;
    }
    if (!statValue.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/["'(]([^\s"'()<>]+)["')]/gu)) {
      const value = (match[1] ?? "").split("#")[0]?.split("?")[0] ?? "";
      if (!value || /^(?:[\p{L}\p{N}_+-]+:|\/)/u.test(value)) continue;
      const dependency = resolve(dirname(file), value);
      if (!isInsideRoot(allowed, dependency) || !existsSync(dependency)) continue;
      const stat = lstatOrNull(dependency);
      if (!stat?.isFile()) continue;
      result[`dependency:${relative(base, dependency).replaceAll(sep, "/")}`] = sha256(
        readFileSync(dependency),
      );
      pending.push(dependency);
    }
  }
  return result;
}

function sameSignature(left: string, right: string): boolean {
  const leftSignature = signature(left);
  const rightSignature = signature(right);
  const keys = new Set([...Object.keys(leftSignature), ...Object.keys(rightSignature)]);
  for (const key of keys) if (leftSignature[key] !== rightSignature[key]) return false;
  return true;
}

export function reserve(
  source: string,
  target: string,
  original?: (candidate: string) => string,
): string {
  let candidate = target;
  let suffix = 2;
  while (existsSync(candidate)) {
    const sourceDirectory = isDirectory(source);
    const candidateDirectory = isDirectory(candidate);
    const comparison = original ? original(candidate) : candidate;
    if (sourceDirectory === candidateDirectory && sameSignature(source, comparison)) return candidate;
    const extension = extname(target);
    candidate = join(dirname(target), `${basename(target, extension)}-${suffix}${extension}`);
    suffix += 1;
  }
  if (isDirectory(source)) {
    mkdirSync(candidate, { recursive: true });
    for (const file of filesUnder(source)) {
      writeAtomic(join(candidate, file.relative), readFileSync(file.absolute));
    }
  } else {
    writeAtomic(candidate, readFileSync(source));
  }
  return candidate;
}

export function copy_group(
  ws: WorkspaceView,
  source: string,
  target: string,
  mapping: Map<string, string>,
  final?: string,
): void {
  if (!isDirectory(source)) return;
  const destinationRoot = final ?? target;
  mkdirSync(target, { recursive: true });
  const original = (candidate: string): string => {
    const destination = join(destinationRoot, relative(target, candidate));
    for (const [owner, placed] of mapping) {
      if (placed === destination) return owner;
      if (isInsideRoot(destination, placed)) {
        let result = owner;
        for (const _part of relative(destination, placed).split(sep)) result = dirname(result);
        return result;
      }
    }
    return candidate;
  };
  const entries = readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const item of entries) {
    const itemPath = join(source, item.name);
    if (item.name === "_lib" || basename(target) === "images") {
      const files = item.isDirectory() ? filesUnder(itemPath) : [{ relative: "", absolute: itemPath }];
      for (const file of files) {
        const rel = item.isDirectory() ? `${item.name}/${file.relative}` : item.name;
        const out = reserve(file.absolute, join(target, rel), original);
        mapping.set(realpathSync.native(file.absolute), resolve(destinationRoot, relative(target, out)));
      }
    } else {
      const out = reserve(itemPath, join(target, item.name), original);
      const files = item.isDirectory() ? filesUnder(itemPath) : [{ relative: "", absolute: itemPath }];
      for (const file of files) {
        const placed = item.isDirectory()
          ? join(destinationRoot, relative(target, out), file.relative)
          : resolve(destinationRoot, relative(target, out));
        mapping.set(realpathSync.native(file.absolute), placed);
      }
    }
  }
}

export function rewrite(
  text: string,
  oldPath: string,
  newPath: string,
  mapping: Map<string, string>,
  root: string,
): string {
  return text.replace(
    /(["'(])([^\s"'()<>]+)(["')])/gu,
    (whole, open: string, value: string, close: string) => {
      if (!value || /^(?:[\p{L}\p{N}_+-]+:|\/|#)/u.test(value)) return whole;
      const cut = value.search(/[?#]/u);
      const path = cut < 0 ? value : value.slice(0, cut);
      const suffix = cut < 0 ? "" : value.slice(cut);
      const lexical = resolve(dirname(oldPath), path);
      const resolved = existsSync(lexical) ? realpathSync.native(lexical) : lexical;
      let destination = mapping.get(resolved);
      if (
        destination === undefined
        && isInsideRoot(root, resolved)
        && (
          existsSync(resolved)
          && lstatOrNull(resolved)?.isFile()
          || isInsideRoot(join(root, ".slide-studio", "runtime"), resolved)
        )
      ) {
        destination = resolved;
      }
      if (destination === undefined) return whole;
      let rel = relative(dirname(newPath), destination).replaceAll(sep, "/");
      if (value.startsWith("./") && !rel.startsWith(".")) rel = `./${rel}`;
      return `${open}${rel}${suffix}${close}`;
    },
  );
}

export function replaceFigureRefs(text: string, replace: (ref: string) => string | null): string {
  return text.replace(/\{\{<\s*fig\s+[^>]*>\}\}/gu, (whole) => {
    const parsed = fig_args(whole);
    const ref = parsed?.ref;
    if (!ref) return whole;
    const next = replace(ref);
    if (!next || next === ref) return whole;
    return whole.replace(ref, next);
  });
}

export function copy_topic_assets(
  ws: WorkspaceView,
  sourceDeck: string,
  _deck: string,
  shelf: string,
  text: string,
): string {
  const previous = ws.deck_shelf(sourceDeck);
  if (previous === shelf) return text;
  for (const kind of ["html", "images"]) {
    const source = join(ws.topic_dir(previous), kind);
    if (existsSync(source)) assertNoSymlinks(ws.root, source);
  }
  const mapping = new Map<string, string>();
  for (const kind of ["html", "images"]) {
    copy_group(ws, join(ws.topic_dir(previous), kind), join(ws.topic_dir(shelf), kind), mapping);
  }
  for (const [source, destination] of mapping) {
    if (!TEXT_EXTENSIONS.has(extname(source).toLowerCase())) continue;
    if (!existsSync(destination)) continue;
    writeAtomic(
      destination,
      rewrite(readFileSync(source, "utf8"), source, destination, mapping, ws.root),
    );
  }
  let updated = replaceFigureRefs(text, (ref) => {
    if (!ref.startsWith(`${previous}/`)) return null;
    let key: string;
    try {
      key = realpathSync.native(join(ws.figure_dir(ref), "figure.mjs"));
    } catch {
      return null;
    }
    const destination = mapping.get(key);
    if (!destination) return null;
    return `${shelf}/${relative(ws.shelf_dir(shelf), dirname(destination)).replaceAll(sep, "/")}`;
  });
  updated = updated.replace(
    /!?\[[^\]]*\]\(<?(images\/[^\s)>]+)>?/gu,
    (whole, image: string) => {
      const source = join(ws.topic_dir(previous), image);
      let key: string;
      try {
        key = realpathSync.native(source);
      } catch {
        return whole;
      }
      const destination = mapping.get(key);
      if (!destination) return whole;
      return whole.replace(
        image,
        relative(ws.topic_dir(shelf), destination).replaceAll(sep, "/"),
      );
    },
  );
  // Only `html/` and `images/` are copied as whole groups. Rewriting those two
  // prefixes cannot point at a file that was not copied.
  return updated
    .split(`topics/${previous}/html/`).join(`topics/${shelf}/html/`)
    .split(`topics/${previous}/images/`).join(`topics/${shelf}/images/`);
}

export function migrateTopics(ws: WorkspaceView, setFront: SetFront): void {
  const legacy = join(ws.root, "figures");
  if (!isDirectory(legacy) || existsSync(ws.topics)) return;
  assertNoSymlinks(ws.root, legacy);

  const journal = join(ws.state, "migrate", "topics-v1");
  const stage = join(journal, "stage", "topics");
  safeRemove(ws.root, stage);
  safeMkdir(ws.root, stage);

  const mapping = new Map<string, string>();
  const originals: string[] = [];
  const movedTopics = new Set<string>();
  const entries = readdirSync(legacy, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const entry of entries) {
    const source = join(legacy, entry.name);
    if (entry.isDirectory()) {
      movedTopics.add(entry.name);
      copy_group(ws, source, join(stage, entry.name, "html"), mapping, join(ws.topic_dir(entry.name), "html"));
    } else if (entry.isFile()) {
      writeAtomic(join(stage, entry.name), readFileSync(source));
      mapping.set(realpathSync.native(source), join(ws.topics, entry.name));
    }
  }
  // The whole legacy folder is moved to trash after the staged copy is
  // verified, exactly like topic_migrate.finish().
  originals.push(relative(ws.root, legacy).replaceAll(sep, "/"));

  for (const deck of ws.list_decks()) {
    const shelf = ws.deck_shelf(deck);
    const folder = ws.deck_dir(deck);
    for (const name of ["images", "html", "figures"]) {
      const source = join(folder, name);
      if (!existsSync(source)) continue;
      assertNoSymlinks(ws.root, source);
      const kind = name === "images" ? "images" : "html";
      copy_group(ws, source, join(stage, shelf, kind), mapping, join(ws.topic_dir(shelf), kind));
      originals.push(relative(ws.root, source).replaceAll(sep, "/"));
    }
  }

  const qmds: Array<{ path: string; relative: string; before: string; after: string }> = [];
  for (const deck of ws.list_decks()) {
    const shelf = ws.deck_shelf(deck);
    const folder = ws.deck_dir(deck);
    const path = ws.qmd(deck);
    const text = readFileSync(path, "utf8");
    let updated = replaceFigureRefs(text, (ref) => {
      const source = ref.startsWith("./")
        ? join(folder, "figures", ref.slice(2))
        : join(legacy, ref);
      let key: string;
      try {
        key = realpathSync.native(join(source, "figure.mjs"));
      } catch {
        return null;
      }
      const destination = mapping.get(key);
      if (!destination) return null;
      const parts = relative(ws.topics, destination).split(sep);
      return `${parts[0]}/${parts.slice(2, -1).join("/")}`;
    });
    updated = updated.replace(
      /!?\[[^\]]*\]\(<?(images\/[^\s)>]+)>?/gu,
      (whole, image: string) => {
        let key: string;
        try {
          key = realpathSync.native(join(folder, image));
        } catch {
          return whole;
        }
        const destination = mapping.get(key);
        return destination
          ? whole.replace(image, relative(ws.topic_dir(shelf), destination).replaceAll(sep, "/"))
          : whole;
      },
    );
    updated = rewrite(updated, path, path, mapping, ws.root);
    for (const [source, destination] of mapping) {
      if (!isInsideRoot(legacy, source)) continue;
      updated = updated.replace(
        `../../figures/${relative(legacy, source).replaceAll(sep, "/")}`,
        `../../topics/${relative(ws.topics, destination).replaceAll(sep, "/")}`,
      );
    }
    // Only topics that actually moved in this run are rewritten. If topics/
    // already existed the migration returned before reaching this point.
    for (const topic of movedTopics) {
      updated = updated.replace(
        new RegExp(`(^|["'(])figures/${escapeRegExp(topic)}/`, "gmu"),
        `$1topics/${topic}/html/`,
      );
    }
    updated = updated.replace(`../../topics/${shelf}/images/`, "images/");
    updated = setFront(updated, {});
    qmds.push({
      path,
      relative: relative(ws.root, path).replaceAll(sep, "/"),
      before: text,
      after: updated,
    });
  }

  for (const [source, destination] of mapping) {
    const copied = join(stage, relative(ws.topics, destination));
    const link = lstatOrNull(copied);
    if (!link?.isFile() || sha256(readFileSync(copied)) !== sha256(readFileSync(source))) {
      throw new StudioError(`コピーを確認できませんでした: ${relative(ws.root, source)}`, "CONFLICT");
    }
  }

  const changed = new Set<string>();
  for (const [source, destination] of mapping) {
    if (changed.has(destination) || !TEXT_EXTENSIONS.has(extname(source).toLowerCase())) continue;
    changed.add(destination);
    let text: string;
    try {
      text = readFileSync(source, "utf8");
    } catch {
      continue;
    }
    writeAtomic(
      join(stage, relative(ws.topics, destination)),
      rewrite(text, source, destination, mapping, ws.root),
    );
  }

  if (existsSync(ws.topics)) {
    throw new StudioError("topics/ が移行中に作られました", "CONFLICT");
  }
  safeRename(ws.root, stage, ws.topics);

  const trash = join(ws.state, "trash", "topics-v1");
  for (const rel of originals) {
    const source = join(ws.root, rel);
    if (!existsSync(source)) continue;
    safeRename(ws.root, source, join(trash, rel));
  }
  for (const qmd of qmds) {
    writeAtomic(join(trash, qmd.relative), qmd.before);
    writeAtomic(qmd.path, qmd.after);
  }
}
