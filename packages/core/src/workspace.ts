/**
 * Workspace storage model for Slide Studio.
 *
 * `decks/`, `topics/`, `themes/`, and `.slide-studio/` live directly under the
 * workspace root. Writes are atomic, destructive operations are validated
 * against the canonical root, and originals are moved to `.slide-studio/trash/`
 * before replacement or removal.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
} from "node:fs";

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkspaceFiles } from "./workspace-files.js";
import { assetPath } from "./assets.js";

import { canonicalRoot, isInsideRoot } from "./paths.js";
import { parse, type Doc } from "./source.js";
import {
  drop_cover_layout,
  preserve_title_header,
  refresh_heading_options,
  read_vars,
  OVERRIDE_RE,
} from "./theme-edit.js";
import { with_current_palette } from "./block-design.js";
import { copy_topic_assets, migrateTopics } from "./topic-migrate.js";
import { mergeBibtexTexts } from "./workspace-bib.js";
import {
  check_creation_name,
  themeName,
  check_name,
  checkLookupName,
  CONTROL_CHARACTER,
  decodeUtf8,
  default_root,
  escapeRegExp,
  existsNoFollow,
  expandUser,
  figure_steps,
  figure_title,
  isIgnoredDeckFile,
  location_file,
  lstatOrNull,
  migrationPreparationMessages,
  normalizeForCompare,
  packageVersion,
  pyStr,
  pyTruthy,
  readIfFile,
  readJsonArray,
  readJsonObject,
  recent_roots,
  remember_root,
  renameWithRetry,
  sameJson,
  saved_root,
  set_front,
  set_strings_file,
  sha256Bytes,
  sortedJson,
  StudioError,
  theme_variables,
  themePreparationMessages,
  timeNs,
  validateWindowsName,
  words,
} from "./workspace-utils.js";

export {
  check_creation_name,
  check_name,
  checkLookupName,
  decodeUtf8,
  default_root,
  figure_steps,
  figure_title,
  location_file,
  pyStr,
  pyTruthy,
  recent_roots,
  remember_root,
  renameWithRetry,
  saved_root,
  set_front,
  set_strings_file,
  StudioError,
  theme_variables,
};

export const VERSION = packageVersion();
export { VERSION as __version__ };

/** Bundled templates. Tests can override these roots. */
export let TEMPLATES = assetPath("templates");
export let RUNTIME = assetPath("runtime");

export function set_templates_root(path: string): void {
  TEMPLATES = resolve(path);
  THEME_VARIABLES = theme_variables(
    readFileSync(join(TEMPLATES, "themes", "_base.css"), "utf8"),
  );
}

export function set_runtime_root(path: string): void {
  RUNTIME = resolve(path);
}

export const RUNTIME_FILES = ["figure.mjs", "motion.mjs", "figure.css"] as const;

/** Previously shipped default themes that may be upgraded in place. */
export const OLD_DEFAULT_THEMES = new Set<string>([
  "6c68f6dd20506ee79b5d70c1e9b98e2bea4fdc82efbd0880d57400b3abf36010",
  "c0d0274749f3d6aaba9a55f871d5cd7cc716ef32d84264e89c72f3d421253e08",
]);

/** Previously shipped non-default themes, keyed by file name. */
export const OLD_THEMES: Record<string, Set<string>> = {
  "graphite.css": new Set(["0658790fab7e283857cec03cb5be6a6e8be57d3c83aa3d6ba02844ebb583314e"]),
  "serif.css": new Set(["cd884b15fed2797d38215860ac8103fba502d14aa1cd6f00a5b221b0006529e9"]),
  "solarized.css": new Set(["85b228bb48b2a3ec9c8abfb978dac05741b9ccf2755f6b614d79f8088e460a2c"]),
  "mist.css": new Set([
    "2656730b18615d99c913560c5be61cde732d2d47fd3a63cb89cdad3785e26255",
    "cc107dfd25460ea4345406efa0287246763e4174efc2035bceb082074d7fd1ea",
  ]),
  "night.css": new Set([
    "b6547be3896e5b0e82d624b0b499409abe40516b8a2d7412af7d815b22d49428",
    "b815b3f3585929435c54c37d6a9c4de1132393bf8e1772a5c9357627b5c9675d",
  ]),
};

/** Themes retired from the bundled set. Decks and prefs move to `default`. */
export const RETIRED_THEMES = ["sage", "simple"] as const;

export let THEME_VARIABLES = theme_variables(
  readFileSync(join(TEMPLATES, "themes", "_base.css"), "utf8"),
);

export function runtime_rel(fig_dir: string, ws: Workspace): string {
  return (relative(fig_dir, ws.runtime) || ".").replaceAll(sep, "/");
}

export function blank_qmd(
  shelf: string,
  theme: string,
  title?: string | null,
  templatesRoot = TEMPLATES,
): string {
  let text = readFileSync(join(templatesRoot, "deck", "slides.qmd"), "utf8")
    .replaceAll("{{SHELF}}", shelf)
    .replaceAll("{{THEME}}", theme);
  if (title) {
    const shown = title.replace(/[\r\n]/gu, " ");
    text = text.replaceAll("発表タイトル", shown);
    text = set_front(text, { title: JSON.stringify(title) });
  }
  return text;
}

export interface WorkspaceOptions {
  templatesRoot?: string;
  runtimeRoot?: string;
  version?: string;
}

export class Workspace {
  readonly root: string;
  readonly #files: WorkspaceFiles;
  readonly #templates: string;
  readonly #runtimeAssets: string;
  readonly #version: string;
  readonly #themeVariables: string[];
  readonly #migrationWarnings: string[] = [];

  constructor(root: string, options: WorkspaceOptions = {}) {
    const expanded = expandUser(root);
    const resolved = resolve(expanded);
    this.root = existsSync(resolved) ? canonicalRoot(resolved) : resolved;
    this.#files = new WorkspaceFiles(this.root);
    this.#templates = options.templatesRoot ? resolve(options.templatesRoot) : TEMPLATES;
    this.#runtimeAssets = options.runtimeRoot ? resolve(options.runtimeRoot) : RUNTIME;
    this.#version = options.version ?? VERSION;
    this.#themeVariables = theme_variables(
      readFileSync(join(this.#templates, "themes", "_base.css"), "utf8"),
    );
  }

  static open(
    root?: string | null,
    ensure = true,
    options: WorkspaceOptions = {},
  ): Workspace {
    const selected = root ? expandUser(root) : default_root();
    const expanded = resolve(selected);
    if (ensure) mkdirSync(expanded, { recursive: true });
    const workspace = new Workspace(expanded, options);
    if (ensure) workspace.ensure();
    return workspace;
  }

  // ------------------------------------------------------------ 場所
  get topics(): string {
    return join(this.root, "topics");
  }

  get decks(): string {
    return join(this.root, "decks");
  }

  get themes(): string {
    return join(this.root, "themes");
  }

  get state(): string {
    return join(this.root, ".slide-studio");
  }

  get runtime(): string {
    return join(this.state, "runtime");
  }

  build_dir(deck: string): string {
    return join(this.state, "build", this.#deckName(deck));
  }

  deck_dir(deck: string): string {
    return join(this.decks, this.#deckName(deck));
  }

  qmd(deck: string): string {
    return join(this.deck_dir(deck), "slides.qmd");
  }

  memo(deck: string): string {
    return join(this.deck_dir(deck), "memo.md");
  }

  shelf_dir(shelf: string): string {
    return join(this.topic_dir(shelf), "html");
  }

  topic_dir(shelf: string): string {
    return join(this.topics, check_name(shelf, "トピック"));
  }

  asset_root(deck: string): string {
    return this.topic_dir(this.deck_shelf(deck));
  }

  images_dir(deck: string): string {
    return join(this.asset_root(deck), "images");
  }

  // ------------------------------------------------------------ 用意
  ensure(): void {
    this.#migrateTopics();
    this.#ensureRootLayout();

    const recordPath = join(this.state, "bundled-themes.json");
    const placed = readJsonObject(recordPath) as Record<string, string | null>;
    const before: Record<string, unknown> = { ...placed };

    const themeDirectory = join(this.#templates, "themes");
    const bundled = this.#files.listFiles(themeDirectory)
      .filter((name) => name.endsWith(".css") && !name.startsWith("_"))
      .sort();
    for (const name of bundled) {
      const source = join(themeDirectory, name);
      const destination = join(this.themes, name);
      const data = readFileSync(source);
      const digest = sha256Bytes(data);
      const existing = lstatOrNull(destination);
      if (!existing && Object.prototype.hasOwnProperty.call(placed, name) && placed[name] === null) {
        continue;
      }
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile()) {
          // A linked theme may point outside the workspace. Leave it alone and
          // let theme_preparation() surface it instead of making the workspace
          // impossible to open.
          continue;
        }
        const currentDigest = sha256Bytes(readFileSync(destination));
        if (currentDigest === digest) {
          placed[name] = digest;
          continue;
        }
        if (name === "default.css" && OLD_DEFAULT_THEMES.has(currentDigest)) {
          this.#migrateDefaultDeckStyles();
        } else if (
          currentDigest !== placed[name]
          && !(OLD_THEMES[name]?.has(currentDigest) ?? false)
        ) {
          continue;
        }
      }
      this.#files.write(destination, data);
      placed[name] = digest;
    }

    // serif was replaced by terracotta. Keep a copy of untouched files and
    // move decks/preferences forward without touching customized themes.
    const oldSerif = join(this.themes, "serif.css");
    if (this.#files.isRegularFile(oldSerif) && this.#files.isRegularFile(join(this.themes, "terracotta.css"))) {
      const oldSerifBytes = this.#files.read(oldSerif, "serif.css");
      const digest = sha256Bytes(oldSerifBytes);
      const untouched = digest === placed["serif.css"] || (OLD_THEMES["serif.css"]?.has(digest) ?? false);
      if (untouched) {
        const trash = join(this.state, "trash", "themes", timeNs());
        // Decode every affected qmd before writing any backup or rewrite so a
        // non-UTF-8 deck is left completely untouched.
        const decks = this.list_decks()
          .filter((deck) => this.deck_theme(deck) === "serif")
          .map((deck) => {
            const path = this.qmd(deck);
            const bytes = this.#files.read(path, "slides.qmd");
            return { deck, path, bytes, text: decodeUtf8(bytes, "slides.qmd") };
          });
        this.#files.write(join(trash, "serif.css"), oldSerifBytes);
        for (const target of decks) {
          this.#files.write(join(trash, "decks", target.deck, "slides.qmd"), target.bytes);
          this.#files.write(target.path, set_front(target.text, { theme: "terracotta" }));
        }
        const prefs = this.prefs();
        const recent = this.#stringList(prefs.recent_themes).map((name) =>
          name === "serif" ? "terracotta" : name
        ).filter((name, index, all) => all.indexOf(name) === index);
        this.set_prefs({
          recent_themes: recent,
          ...(prefs.theme === "serif" ? { theme: "terracotta" } : {}),
        });
        this.#files.unlinkOptional(oldSerif);
        placed["serif.css"] = null;
      }
    }

    for (const name of RETIRED_THEMES) {
      this.#retireTheme(name);
      delete placed[`${name}.css`];
    }

    this.#refreshThemes();

    if (!sameJson(placed, before)) {
      this.#files.write(recordPath, sortedJson(placed, 1));
    }

    this.#files.ensureDirectory(this.runtime, "runtime");
    for (const name of RUNTIME_FILES) {
      const source = join(this.#runtimeAssets, name);
      const destination = join(this.runtime, name);
      const data = readFileSync(source);
      const current = readIfFile(destination);
      if (!current || !current.equals(data)) {
        if (lstatOrNull(destination)?.isSymbolicLink()) this.#files.unlinkOptional(destination);
        this.#files.write(destination, data);
      }
    }

    this.#migrateBibliography();
    this.#ensureAgentFiles();
    this.#ensurePortable();
  }

  #ensureRootLayout(): void {
    if (!existsNoFollow(this.root)) mkdirSync(this.root, { recursive: true });
    const rootLink = lstatOrNull(this.root);
    if (!rootLink || rootLink.isSymbolicLink() || !rootLink.isDirectory()) {
      throw new StudioError("workspace root is not a directory");
    }
    for (const [path, label] of [
      [this.topics, "topics"],
      [this.decks, "decks"],
      [this.themes, "themes"],
      [this.state, ".slide-studio"],
    ] as const) {
      this.#files.ensureDirectory(path, label);
    }
  }

  #retireTheme(name: string): void {
    const retired = join(this.themes, `${name}.css`);
    const prefs = this.prefs();
    const affected = this.list_decks().filter((deck) => this.deck_theme(deck) === name);
    const exists = this.#files.isRegularFile(retired);
    const recentThemes = this.#stringList(prefs.recent_themes);
    if (exists || affected.length > 0 || prefs.theme === name || recentThemes.includes(name)) {
      const trash = join(this.state, "trash", "themes", timeNs());
      const retiredBytes = exists ? this.#files.read(retired, `${name}.css`) : null;
      // Decode before writing the theme or deck backups: a non-UTF-8 qmd must
      // not be replaced with a lossy round-trip.
      const decks = affected.map((deck) => {
        const path = this.qmd(deck);
        const bytes = this.#files.read(path, "slides.qmd");
        return { deck, path, bytes, text: decodeUtf8(bytes, "slides.qmd") };
      });
      if (retiredBytes) this.#files.write(join(trash, `${name}.css`), retiredBytes);
      for (const target of decks) {
        this.#files.write(join(trash, "decks", target.deck, "slides.qmd"), target.bytes);
        this.#files.write(target.path, set_front(target.text, { theme: "default" }));
      }
      const recent = this.#stringList(prefs.recent_themes).map((value) =>
        value === name ? "default" : value
      ).filter((value, index, all) => all.indexOf(value) === index);
      this.set_prefs({
        recent_themes: recent,
        ...(prefs.theme === name ? { theme: "default" } : {}),
      });
      if (exists) this.#files.unlinkOptional(retired);
    }
    this.#files.unlinkOptional(join(this.state, "theme-defaults", `${name}.css`));
    this.#files.removeTree(join(this.state, "themes", name));
  }

  #migrateDefaultDeckStyles(): void {
    const legacy = readFileSync(join(this.#templates, "migrations", "nco-intro.css"), "utf8");
    for (const deck of this.list_decks()) {
      if (this.deck_theme(deck) !== "default") continue;
      const path = join(this.deck_dir(deck), "styles", "slides.css");
      const css = this.#files.isRegularFile(path) ? this.#files.readText(path, "slides.css") : "";
      if (!css.includes(legacy.trim())) this.#files.write(path, `${legacy}\n${css}`);
    }
  }

  #refreshThemes(): void {
    const directory = this.themes;
    for (const name of this.#files.listEntries(directory)
      .filter((item) => item.name.endsWith(".css"))
      .map((item) => item.name)
      .sort()) {
      const path = join(directory, name);
      if (!this.#files.isRegularFile(path)) continue;
      const bytes = this.#files.read(path, name);
      const css = decodeUtf8(bytes, name);
      let updated = drop_cover_layout(refresh_heading_options(css, this.#themeVariables));
      if (this.#themeVariables.every((variable) => theme_variables(css).includes(variable))) {
        const repainted = with_current_palette(updated, read_vars(css, this.#themeVariables));
        if (repainted !== updated) {
          this.#files.write(join(this.state, "trash", "themes", timeNs(), name), bytes);
          updated = repainted;
        }
      }
      const original = join(this.#templates, "themes", name);
      const colors = read_vars(css, this.#themeVariables);
      if (
        OVERRIDE_RE.test(css)
        && colors["--header"] === colors["--paper"]
        && this.#files.isRegularFile(original)
      ) {
        updated = preserve_title_header(
          updated,
          readFileSync(original, "utf8"),
          this.#themeVariables,
        );
      }
      if (updated !== css) this.#files.write(path, updated);
    }
  }

  theme_preparation(): Array<Record<string, unknown>> {
    const path = join(this.themes, "default.css");
    const link = lstatOrNull(path);
    if (link?.isSymbolicLink()) {
      const messages = themePreparationMessages();
      return [{
        name: messages.name,
        ok: false,
        detail: "themes/default.css はシンボリックリンクです。リンク先を確認してください。",
        fix: messages.fix,
      }];
    }
    if (!this.#files.isRegularFile(path)) return [];
    const css = this.#files.readText(path, "default.css");
    if (this.#themeVariables.every((variable) => theme_variables(css).includes(variable))) return [];
    const messages = themePreparationMessages();
    return [{
      name: messages.name,
      ok: false,
      detail: messages.detail,
      fix: messages.fix,
    }];
  }

  migration_preparation(): Array<Record<string, unknown>> {
    const messages = migrationPreparationMessages();
    const output: Array<Record<string, unknown>> = [];
    if (existsNoFollow(join(this.root, "figures")) && existsNoFollow(this.topics)) {
      output.push({
        name: messages.topics,
        ok: false,
        detail: messages.folders,
        fix: messages.folderFix,
      });
    }
    for (const detail of this.#bibliographyConflicts()) {
      output.push({
        name: messages.bib,
        ok: false,
        detail,
        fix: messages.bibFix,
      });
    }
    for (const detail of this.#migrationWarnings) {
      output.push({
        name: messages.bib,
        ok: false,
        detail,
        fix: messages.bibFix,
      });
    }
    return output;
  }

  // ------------------------------------------------------------ 発表
  list_decks(): string[] {
    const directory = this.decks;
    if (!this.#files.isDirectory(directory)) return [];
    const output: string[] = [];
    for (const entry of this.#files.listEntries(directory)) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      try {
        checkLookupName(entry.name, "発表名");
      } catch {
        continue;
      }
      const deckPath = join(directory, entry.name);
      const deckLink = lstatOrNull(deckPath);
      if (!deckLink) continue;
      let realDeck: string;
      try {
        realDeck = realpathSync.native(deckPath);
      } catch {
        continue;
      }
      if (!isInsideRoot(this.root, realDeck)) continue;
      try {
        if (!statSync(realDeck).isDirectory()) continue;
      } catch {
        continue;
      }
      const qmd = join(deckPath, "slides.qmd");
      let realQmd: string;
      try {
        realQmd = realpathSync.native(qmd);
      } catch {
        continue;
      }
      if (!isInsideRoot(this.root, realQmd)) continue;
      try {
        if (statSync(realQmd).isFile()) output.push(entry.name);
      } catch {
        // Not a readable deck.
      }
    }
    return output.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  has_deck(deck: string): boolean {
    try {
      const path = this.qmd(deck);
      const link = lstatOrNull(path);
      if (!link) return false;
      const real = realpathSync.native(path);
      if (!isInsideRoot(this.root, real)) return false;
      return statSync(real).isFile();
    } catch {
      return false;
    }
  }

  require_deck(deck: string): string {
    if (!this.has_deck(deck)) {
      throw new StudioError(`発表がありません: ${deck}（${this.deck_dir(deck)}）`, "NOT_FOUND");
    }
    return this.deck_dir(deck);
  }

  deck_meta(deck: string): Record<string, unknown> {
    return parse(this.#files.readText(this.qmd(deck), "slides.qmd")).meta;
  }

  deck_shelf(deck: string): string {
    const shelf = this.deck_meta(deck).topic;
    if (!pyTruthy(shelf)) {
      throw new StudioError(`${deck} の front matter に topic:（トピック）がありません`);
    }
    return pyStr(shelf);
  }

  bib(deck: string, meta?: Record<string, unknown> | null): string {
    const topic = (meta ?? this.deck_meta(deck)).topic;
    if (!pyTruthy(topic)) return join(this.state, "missing-topic.bib");
    return join(this.topic_dir(pyStr(topic)), "reference.bib");
  }

  deck_theme(deck: string): string {
    return themeName(this.deck_meta(deck).theme);
  }

  is_blank(deck: string): boolean {
    const text = normalizeForCompare(this.#files.readText(this.qmd(deck), "slides.qmd"));
    const document = parse(text);
    if (document.pages.length === 0) return true;
    const meta = document.meta;
    const title = pyTruthy(meta.title) ? pyStr(meta.title) : "";
    const blank = normalizeForCompare(this.#blank(
      pyTruthy(meta.topic) ? pyStr(meta.topic) : "",
      pyTruthy(meta.theme) ? pyStr(meta.theme) : "",
      title === "" || title === "発表タイトル" ? null : title,
    ));
    return set_front(text, {}).trim() === blank.trim();
  }

  is_untouched(deck: string): boolean {
    if (!this.is_blank(deck)) return false;
    const memo = this.memo(deck);
    if (existsNoFollow(memo) && !this.#files.isRegularFile(memo)) return false;
    if (!this.#files.isRegularFile(memo)) return true;
    const current = normalizeForCompare(this.#files.readText(memo, "memo.md"));
    const template = normalizeForCompare(
      readFileSync(join(this.#templates, "deck", "memo.md"), "utf8"),
    );
    return words(current).join("\u0000") === words(template).join("\u0000");
  }

  new_deck(
    deck: string,
    shelf: string,
    theme = "default",
    source_deck: string | null = null,
    title: string | null = null,
    template: "blank" | "tutorial" = "blank",
  ): string {
    check_creation_name(deck, "フォルダ名");
    check_name(shelf, "トピックの名前");
    if (!existsNoFollow(this.topic_dir(shelf))) validateWindowsName(shelf);
    check_name(theme, "テーマ");
    if (source_deck) check_name(source_deck, "複製する発表");
    const destination = this.deck_dir(deck);
    if (existsNoFollow(destination)) throw new StudioError(`既にあります: ${destination}`);

    const themePath = join(this.themes, `${theme}.css`);
    if (!this.#files.isRegularFile(themePath)) {
      throw new StudioError(`テーマがありません: themes/${theme}.css`);
    }

    this.#files.ensureDirectory(this.decks, "decks");

    // The topic folders are part of the same user-visible commit as the deck.
    // Create them before copying so `images_dir(deck)` does not need the deck
    // to exist yet, and remember exactly which paths this run created so a
    // failure can remove only those.
    const topicHtml = this.shelf_dir(shelf);
    const topicImages = join(this.topic_dir(shelf), "images");
    const createdTopicPaths = new Set<string>();
    for (const path of [topicHtml, topicImages]) {
      let current = path;
      while (current !== this.root && !existsNoFollow(current)) {
        if (!isInsideRoot(this.root, resolve(current))) break;
        createdTopicPaths.add(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    try {
      this.#files.ensureDirectory(topicHtml, "topic html");
      this.#files.ensureDirectory(topicImages, "topic images");
    } catch (error) {
      this.#files.cleanupCreated(createdTopicPaths);
      throw error;
    }

    const created = [...createdTopicPaths];
    const temporary = join(this.decks, `.new-${randomUUID()}`);
    try {
      if (source_deck) {
        const source = this.require_deck(source_deck);
        const ignore = (directory: string, names: string[]): string[] => {
          let sameDirectory = resolve(directory) === resolve(source);
          if (!sameDirectory) {
            try {
              sameDirectory = realpathSync.native(directory) === realpathSync.native(source);
            } catch {
              sameDirectory = false;
            }
          }
          return [
            ...names.filter((name) => isIgnoredDeckFile(name)),
            ...(sameDirectory ? ["materials"] : []),
          ];
        };
        this.#files.copyTree(source, temporary, { ignore });
        const qmd = join(temporary, "slides.qmd");
        const sourceBib = this.bib(source_deck);
        if (shelf !== this.deck_shelf(source_deck) && this.#files.isRegularFile(sourceBib)) {
          this.#files.write(join(temporary, "reference.bib"), this.#files.read(sourceBib, "reference.bib"));
        }
        let text = copy_topic_assets(
          this,
          source_deck,
          deck,
          shelf,
          this.#files.readText(qmd, "slides.qmd"),
          created,
        );
        text = set_front(text, { topic: shelf, theme });
        if (title) text = set_front(text, { title: JSON.stringify(title) });
        this.#files.write(qmd, text);
      } else {
        this.#files.copyTree(join(this.#templates, "deck"), temporary, {
          ignore: (_directory, names) => names.filter((name) => name === ".DS_Store"),
        });
        let text = template === "tutorial"
          ? set_front(readFileSync(join(this.#templates, "tutorial.qmd"), "utf8"), {
            topic: shelf, theme, title: JSON.stringify(title || "サンプル発表"),
          })
          : blank_qmd(shelf, theme, title, this.#templates);
        if (template === "tutorial") {
          // Keep shared topic assets intact when a tutorial is created again.
          let suffix = "";
          for (let n = 2; existsNoFollow(join(topicImages, `tutorial-workflow${suffix}.svg`))
            || existsNoFollow(join(topicHtml, `tutorial-flow${suffix}`)); n++) suffix = `-${n}`;
          const image = `tutorial-workflow${suffix}.svg`, figure = `tutorial-flow${suffix}`;
          const assets = join(this.#templates, "tutorial-assets");
          const imagePath = join(topicImages, image), figurePath = join(topicHtml, figure);
          created.push(imagePath, figurePath);
          this.#files.write(imagePath, readFileSync(join(assets, "workflow.svg")));
          this.#files.copyTree(join(assets, "html"), figurePath);
          this.#files.write(join(figurePath, "index.html"), readFileSync(join(this.#templates, "figure", "index.html"), "utf8")
            .replaceAll("{{RUNTIME}}", runtime_rel(figurePath, this)).replaceAll("{{STYLE}}", ""));
          this.#files.write(join(temporary, "materials", "発表づくりのメモ.txt"), readFileSync(join(assets, "reference.txt")));
          text = text.replaceAll("{{IMAGE}}", image).replaceAll("{{FIGURE}}", figure).replaceAll("{{TOPIC}}", shelf);
        }
        this.#files.write(join(temporary, "slides.qmd"), text);
      }
      renameWithRetry(temporary, destination);
    } catch (error) {
      try {
        this.#files.removeTree(temporary);
      } catch {
        // Keep the original copy/rename failure visible.
      }
      this.#files.cleanupCreated(created);
      throw error;
    }

    // The deck is now visible. Auxiliary work must not make a successful
    // creation look like a failed one (a retry would hit 既にあります).
    const warnings: string[] = [];
    if (template === "tutorial" && !source_deck) {
      // The tutorial cites a sample entry. Add only the keys the topic lacks so
      // a user's existing records are never rewritten.
      try {
        const target = join(this.topic_dir(shelf), "reference.bib");
        const current = this.#files.isRegularFile(target) ? this.#files.readTextStrict(target, "reference.bib") : "";
        const have = new Set([...current.matchAll(/@\w+\s*\{\s*([^,\s]+)/gu)].map((m) => m[1]));
        const sample = readFileSync(join(this.#templates, "tutorial-assets", "reference.bib"), "utf8");
        const missing = sample.split(/\n(?=@)/u).map((entry) => entry.trim())
          .filter((entry) => { const key = /^@\w+\s*\{\s*([^,\s]+)/u.exec(entry)?.[1]; return key && !have.has(key); });
        if (missing.length) {
          this.#files.write(target, `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${missing.join("\n\n")}\n`);
        }
      } catch (error) {
        warnings.push(`サンプルの文献: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      this.#migrateBibliography();
    } catch (error) {
      warnings.push(
        `文献の移行: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      this.touch_recent(deck);
    } catch (error) {
      warnings.push(
        `最近の発表: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      this.set_prefs({ shelf, theme });
    } catch (error) {
      warnings.push(
        `設定の保存: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#migrationWarnings.push(...warnings);
    return destination;
  }

  // ------------------------------------------------------------ 最近
  get recent_file(): string {
    return join(this.state, "recent.json");
  }

  recent(): Array<Record<string, unknown>> {
    const items = readJsonArray(this.recent_file);
    const known = new Set(items.map((item) => String(item.deck)));
    for (const deck of this.list_decks()) {
      if (!known.has(deck)) items.push({ deck, opened: 0 });
    }
    const output: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const deck = typeof item.deck === "string" ? item.deck : "";
      if (!deck || !this.has_deck(deck)) continue;
      const statValue = statSync(this.qmd(deck));
      const meta = this.deck_meta(deck);
      output.push({
        ...item,
        title: pyTruthy(meta.title)
          ? pyStr(meta.title)
          : pyTruthy(meta.pagetitle)
            ? pyStr(meta.pagetitle)
            : deck,
        shelf: pyTruthy(meta.topic) ? pyStr(meta.topic) : "",
        theme: themeName(meta.theme),
        modified: statValue.mtimeMs / 1000,
      });
    }
    output.sort((left, right) => {
      const opened = Number(left.opened ?? 0) - Number(right.opened ?? 0);
      if (opened !== 0) return -opened;
      return Number(right.modified ?? 0) - Number(left.modified ?? 0);
    });
    return output;
  }

  touch_recent(deck: string): void {
    let items = readJsonArray(this.recent_file).filter((item) => item.deck !== deck);
    items.unshift({ deck, opened: Date.now() / 1000 });
    items = items.slice(0, 50);
    this.#files.write(this.recent_file, JSON.stringify(items, null, 1));
  }

  prefs(): Record<string, unknown> {
    return readJsonObject(join(this.state, "prefs.json"));
  }

  set_prefs(values: Record<string, unknown> = {}): void {
    const prefs = this.prefs();
    for (const [key, value] of Object.entries(values)) {
      if (value !== null && value !== undefined) prefs[key] = value;
    }
    this.#files.write(join(this.state, "prefs.json"), JSON.stringify(prefs, null, 1));
  }

  // ------------------------------------------------------------ 棚と図
  shelves(): string[] {
    if (!this.#files.isDirectory(this.topics)) return [];
    const output: string[] = [];
    for (const entry of this.#files.listEntries(this.topics)) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const path = join(this.topics, entry.name);
      if (!this.#files.entryIsDirectory(path)) continue;
      output.push(entry.name);
    }
    return output.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  new_topic(shelf: string): string {
    check_creation_name(shelf, "トピック");
    const destination = this.topic_dir(shelf);
    if (existsNoFollow(destination)) {
      throw new StudioError(`同じ名前のトピックがあります: ${shelf}`);
    }
    this.#files.ensureDirectory(destination, "topic");
    return destination;
  }

  remove_topic(shelf: string): string {
    const base = this.topic_dir(shelf);
    const link = lstatOrNull(base);
    if (!link || link.isSymbolicLink() || !link.isDirectory()) {
      throw new StudioError("topicMissing", "NOT_FOUND");
    }
    const real = realpathSync.native(base);
    const topicsReal = this.#files.isDirectory(this.topics) ? realpathSync.native(this.topics) : this.topics;
    if (dirname(real) !== topicsReal) throw new StudioError("topicMissing", "NOT_FOUND");

    for (const deck of this.list_decks()) {
      const text = this.#files.readText(this.qmd(deck), "slides.qmd");
      const topic = parse(text).meta.topic;
      const metaTopic = pyTruthy(topic) ? pyStr(topic) : "";
      const figurePattern = new RegExp(`\\{\\{<\\s*fig\\s+["']?${escapeRegExp(shelf)}/`, "u");
      if (metaTopic === shelf || text.includes(`topics/${shelf}/`) || figurePattern.test(text)) {
        throw new StudioError("topicInUse", "CONFLICT");
      }
    }

    const trash = join(this.state, "trash", "topics", `${shelf}-${timeNs()}`);
    this.#files.renameWithinRoot(base, trash);
    return trash;
  }

  topic_empty(shelf: string): boolean {
    const base = this.topic_dir(shelf);
    const link = lstatOrNull(base);
    if (!link) return true;
    if (link.isSymbolicLink() || !link.isDirectory()) return false;
    const hasFile = (directory: string): boolean => {
      for (const entry of this.#files.listEntries(directory)) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          if (entry.name !== ".DS_Store") return true;
        } else if (entry.isDirectory()) {
          if (hasFile(path)) return true;
        } else if (entry.isFile() && entry.name !== ".DS_Store") {
          return true;
        }
      }
      return false;
    };
    return !hasFile(base);
  }

  themes_list(): string[] {
    const output: string[] = [];
    for (const entry of this.#files.listEntries(this.themes)) {
      if (entry.name.startsWith("_") || !entry.name.endsWith(".css")) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      output.push(entry.name.slice(0, -4));
    }
    return output.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  theme_default(name: string): string | null {
    check_name(name, "テーマ");
    if (name.startsWith("_")) return null;
    for (const path of [
      join(this.state, "theme-defaults", `${name}.css`),
      join(this.#templates, "themes", `${name}.css`),
    ]) {
      const data = readIfFile(path);
      if (data) return data.toString("utf8");
    }
    return null;
  }

  register_theme(name: string, css: string): void {
    check_creation_name(name, "テーマ");
    if (existsNoFollow(join(this.themes, `${name}.css`))) {
      throw new StudioError("同じ名前のテーマがあります");
    }
    this.#files.write(join(this.state, "theme-defaults", `${name}.css`), css);
    this.#files.write(join(this.themes, `${name}.css`), css);
  }

  remove_theme(name: string): string {
    check_name(name, "テーマ");
    const path = join(this.themes, `${name}.css`);
    if (!this.#files.isRegularFile(path)) throw new StudioError("テーマがありません", "NOT_FOUND");
    if (name === "default") throw new StudioError("default のテーマは削除できません");

    const using = this.list_decks().filter((deck) => this.deck_theme(deck) === name);
    if (using.length > 0) {
      throw new StudioError(`このテーマを使う発表があります：${using.join("、")}`, "CONFLICT");
    }

    const trash = join(this.state, "trash", "themes", timeNs());
    this.#files.renameWithinRoot(path, join(trash, `${name}.css`));
    const defaults = join(this.state, "theme-defaults", `${name}.css`);
    if (this.#files.isRegularFile(defaults)) this.#files.renameWithinRoot(defaults, join(trash, "defaults", `${name}.css`));
    const previews = join(this.state, "themes", name);
    if (this.#files.isDirectory(previews)) this.#files.renameWithinRoot(previews, join(trash, "previews", name));

    const bundled = join(this.#templates, "themes", `${name}.css`);
    if (this.#files.isRegularFile(bundled)) {
      const record = join(this.state, "bundled-themes.json");
      const placed = readJsonObject(record) as Record<string, string | null>;
      this.#files.write(record, sortedJson({ ...placed, [`${name}.css`]: null }, 1));
    }

    const prefs = this.prefs();
    this.set_prefs({
      recent_themes: this.#stringList(prefs.recent_themes).filter((item) => item !== name),
      ...(prefs.theme === name ? { theme: "default" } : {}),
    });
    return join(trash, `${name}.css`);
  }

  figure_dir(ref: string, _deck?: string | null): string {
    const separator = ref.indexOf("/");
    const shelf = separator >= 0 ? ref.slice(0, separator) : "";
    const name = separator >= 0 ? ref.slice(separator + 1) : "";
    const parts = name.split("/");
    if (
      separator < 0
      || shelf === "."
      || !name
      || isAbsolute(name)
      || name.includes("\\")
      || parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new StudioError(`トピック/名前で図を指定してください: ${ref}`);
    }
    check_name(shelf, "トピック");
    const base = join(this.topics, shelf, "html");
    const result = join(base, ...parts);
    if (!isInsideRoot(base, result)) {
      throw new StudioError(`トピック/名前で図を指定してください: ${ref}`, "OUTSIDE_ROOT");
    }
    return result;
  }

  list_figures(shelf: string | null = null, deck: string | null = null): Array<Record<string, unknown>> {
    const selected = deck ? this.deck_shelf(deck) : shelf;
    if (!selected) return [];
    const base = this.shelf_dir(selected);
    if (!this.#files.isDirectory(base)) return [];
    const output: Array<Record<string, unknown>> = [];
    const entries = this.#files.listEntries(base).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const directory = join(base, entry.name);
      if (!this.#files.isRegularFile(join(directory, "figure.mjs"))) continue;
      output.push({
        name: entry.name,
        ref: `${selected}/${entry.name}`,
        title: figure_title(directory),
        steps: figure_steps(directory),
        place: "shelf",
      });
    }
    return output;
  }

  decks_using(ref: string): string[] {
    const output: string[] = [];
    for (const deck of this.list_decks()) {
      const text = this.#files.readText(this.qmd(deck), "slides.qmd");
      for (const match of text.matchAll(/\{\{<\s*fig\s+(\S+)/gu)) {
        if ((match[1] ?? "").replace(/^"+|"+$/gu, "") === ref) {
          output.push(deck);
          break;
        }
      }
    }
    return output;
  }

  // ------------------------------------------------------------ internals
  #parse(text: string): Doc {
    return parse(text);
  }

  #blank(shelf: string, theme: string, title: string | null): string {
    return blank_qmd(shelf, theme, title, this.#templates);
  }

  #deckName(deck: string): string {
    return checkLookupName(deck, "発表名");
  }

  #stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  #migrateTopics(): void {
    migrateTopics(this, set_front);
  }

  #copyTopicAssets(sourceDeck: string, deck: string, shelf: string, text: string): string {
    return copy_topic_assets(this, sourceDeck, deck, shelf, text);
  }

  // ------------------------------------------------------------ bibliography
  #migrateBibliography(): void {
    if (existsNoFollow(join(this.root, "figures"))) return;
    for (const [target, old] of this.#bibliographyPlans()) {
      let merged: string;
      try {
        merged = mergeBibtexTexts([
          this.#files.isRegularFile(target) ? this.#files.readTextStrict(target, "reference.bib") : "",
          ...old.map((path) => this.#files.readTextStrict(path, "reference.bib")),
        ]);
      } catch {
        // A conflict or unreadable BibTeX must never delete the local file.
        continue;
      }
      if (old.length > 0 || !this.#files.isRegularFile(target)) {
        if (this.#files.isRegularFile(target)) {
          this.#backupToTrash(
            `bib-${timeNs()}/topics/${basename(dirname(target))}/${basename(target)}`,
            this.#files.read(target, "reference.bib"),
          );
        }
        this.#files.write(target, merged);
      }
      for (const path of old) {
        const destination = join(
          this.state,
          "trash",
          `bib-${timeNs()}`,
          basename(dirname(path)),
          basename(path),
        );
        this.#files.renameWithinRoot(path, destination);
      }
    }
  }

  #bibliographyPlans(): Array<[string, string[]]> {
    const groups = new Map<string, string[]>();
    for (const deck of this.list_decks()) {
      let target: string;
      try {
        target = this.bib(deck);
      } catch {
        continue;
      }
      if (dirname(target) === this.state) continue;
      if (existsNoFollow(target) && !this.#files.isRegularFile(target)) continue;
      if (!groups.has(target)) groups.set(target, []);
      const old = join(this.deck_dir(deck), "reference.bib");
      if (this.#files.isRegularFile(old)) groups.get(target)!.push(old);
    }
    return [...groups.entries()];
  }

  #bibliographyConflicts(): string[] {
    const errors: string[] = [];
    for (const [target, old] of this.#bibliographyPlans()) {
      try {
        mergeBibtexTexts([
          this.#files.isRegularFile(target) ? this.#files.readTextStrict(target, "reference.bib") : "",
          ...old.map((path) => this.#files.readTextStrict(path, "reference.bib")),
        ]);
      } catch (error) {
        errors.push(
          `${basename(dirname(target))}: ${error instanceof Error ? error.message : String(error)} `
            + `(${old.map((path) => basename(dirname(path))).join(", ")})`,
        );
      }
    }
    return errors;
  }

  // ------------------------------------------------------------ agent files
  #ensureAgentFiles(): void {
    // This writer owns agent-files.json and its version stamp, including the
    // native CLI guidance shipped in the Electron templates.
    const templateDirectory = join(this.#templates, "workspace");
    if (!this.#files.isDirectory(templateDirectory)) return;
    const stamp = join(this.state, "agent-files.json");
    const known = readJsonObject(stamp);
    const files = new Map<string, Buffer>();
    const walk = (directory: string, prefix: string): void => {
      for (const entry of this.#files.listEntries(directory).sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      )) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path, relativePath);
        else if (entry.isFile()) files.set(relativePath, readFileSync(path));
      }
    };
    walk(templateDirectory, "");

    for (const [relativePath, data] of files) {
      const destination = this.#relativeToRoot(relativePath);
      if (!destination) continue;
      try {
        this.#files.assertParentRealInside(destination, relativePath);
      } catch {
        delete known[relativePath];
        continue;
      }
      const digest = sha256Bytes(data);
      const link = lstatOrNull(destination);
      if (link?.isSymbolicLink()) continue;
      if (link && !link.isFile()) continue;
      // Compare the on-disk bytes, not the stamp's digest of the old template:
      // a version change must replace (and back up) a user-edited file.
      if (link?.isFile() && readFileSync(destination).equals(data)) {
        known[relativePath] = digest;
        continue;
      }
      if (
        link?.isFile()
        && typeof known[relativePath] === "string"
        && sha256Bytes(readFileSync(destination)) !== known[relativePath]
        && known["_version"] === this.#version
      ) {
        continue;
      }
      if (link?.isFile()) {
        this.#backupToTrash(
          `agent-files/${timeNs()}/${relativePath}`,
          readFileSync(destination),
        );
      }
      this.#files.write(destination, data);
      known[relativePath] = digest;
    }

    const present = new Set(files.keys());
    for (const relativePath of Object.keys(known)) {
      if (relativePath === "_version" || present.has(relativePath)) continue;
      const digest = known[relativePath];
      delete known[relativePath];
      if (typeof digest !== "string") continue;
      const destination = this.#relativeToRoot(relativePath);
      if (!destination) continue;
      try {
        this.#files.assertParentRealInside(destination, relativePath);
      } catch {
        continue;
      }
      const link = lstatOrNull(destination);
      if (!link || link.isSymbolicLink() || !link.isFile()) continue;
      if (sha256Bytes(readFileSync(destination)) !== digest) continue;
      this.#files.unlinkOptional(destination);
      let parent = dirname(destination);
      while (parent !== this.root) {
        const parentLink = lstatOrNull(parent);
        if (!parentLink || parentLink.isSymbolicLink()) break;
        try {
          rmdirSync(parent);
        } catch {
          break;
        }
        parent = dirname(parent);
      }
    }

    const skills = new Set<string>();
    for (const relativePath of files.keys()) {
      if (!relativePath.startsWith(".agents/skills/")) continue;
      const parts = relativePath.split("/");
      if (parts[2]) skills.add(parts[2]);
    }
    const claude = join(this.root, ".claude");
    const links = join(claude, "skills");
    const linksLink = lstatOrNull(links);
    const claudeLink = lstatOrNull(claude);
    let agentsSafe = true;
    try {
      this.#files.assertParentRealInside(join(this.root, ".agents", "skills", ".probe"), ".agents");
    } catch {
      agentsSafe = false;
    }
    let linksSafe = true;
    try {
      // `.claude` itself may be a symlink even when the `skills` child is not
      // itself a link. Probe the parent chain the same way as `.agents`.
      this.#files.assertParentRealInside(join(links, ".probe"), ".claude/skills");
    } catch {
      linksSafe = false;
    }
    if (
      claudeLink?.isSymbolicLink()
      || linksLink?.isSymbolicLink()
      || (claudeLink !== null && !claudeLink.isDirectory())
      || (linksLink !== null && !linksLink.isDirectory())
      || !agentsSafe
      || !linksSafe
    ) {
      // Never create or clean links through a symlinked `.claude/skills` or
      // `.agents` directory.
      known["_version"] = this.#version;
      this.#files.write(stamp, JSON.stringify(known, null, 1));
      return;
    }
    for (const name of [...skills].sort()) {
      const link = join(links, name);
      if (existsNoFollow(link)) continue;
      this.#files.ensureDirectory(links, "skill links");
      const relativeTarget = `../../.agents/skills/${name}`;
      try {
        symlinkSync(relativeTarget, link, "dir");
      } catch {
        // Windows without Developer Mode: junction with an absolute target.
        if (process.platform === "win32") {
          try {
            symlinkSync(join(this.root, ".agents", "skills", name), link, "junction");
          } catch {
            this.#files.copyTree(join(this.root, ".agents", "skills", name), link);
          }
        } else {
          this.#files.copyTree(join(this.root, ".agents", "skills", name), link);
        }
      }
    }
    if (this.#files.isDirectory(links)) {
      for (const entry of this.#files.listEntries(links)) {
        const link = join(links, entry.name);
        const statValue = lstatOrNull(link);
        if (!statValue?.isSymbolicLink() || existsSync(link)) continue;
        try {
          this.#files.assertParentRealInside(link, entry.name);
          const target = readlinkSync(link).replaceAll("\\", "/");
          const relativeTarget = `../../.agents/skills/${entry.name}`;
          const absoluteTarget = join(this.root, ".agents", "skills", entry.name).replaceAll("\\", "/");
          if (target === relativeTarget || target === absoluteTarget) this.#files.unlinkOptional(link);
        } catch {
          // Leave links we cannot inspect alone.
        }
      }
    }
    known["_version"] = this.#version;
    this.#files.write(stamp, JSON.stringify(known, null, 1));
  }

  #backupToTrash(relativePath: string, data: Buffer): void {
    const destination = join(this.state, "trash", relativePath);
    this.#files.write(destination, data);
  }

  #ensurePortable(): void {
    const compiler = join(this.state, "compiler");
    this.#files.ensureDirectory(compiler, "compiler");
    const bundled = assetPath('portable');
    const stamp = join(this.state,'portable-files.json'), known = readJsonObject(stamp);
    const copy = (directory:string, prefix=''):void => {
      for (const entry of this.#files.listEntries(directory)) {
        if (entry.isSymbolicLink()) continue;
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { copy(join(directory,entry.name),key); continue; }
        if (!entry.isFile()) continue;
        const rel = key === 'build.mjs' ? key : `.slide-studio/${key}`;
        const target = this.#relativeToRoot(rel); if (!target) continue;
        try {
          this.#files.assertParentRealInside(target,rel);
          const current=readIfFile(target),data=readFileSync(join(directory,entry.name));
          if (existsNoFollow(target) && (!current || (!current.equals(data) && known[rel] !== sha256Bytes(current)))) continue;
          if (!current || !current.equals(data)) this.#files.write(target,data);
          known[rel]=sha256Bytes(data);
        } catch { /* Preserve user-owned files and unsafe paths. */ }
      }
    };
    if (this.#files.isDirectory(bundled)) { copy(bundled); this.#files.write(stamp,JSON.stringify(known,null,1)); }
    for (const readme of [join(this.root, "README.md"), join(compiler, "README.md")]) {
      const current = readIfFile(readme);
      // A symlink or directory is neither our README nor safe to overwrite.
      if (existsNoFollow(readme) && !current) continue;
      const untouchedOld = Boolean(current && OLD_PORTABLE_READMES.has(sha256Bytes(current)));
      if (current && !untouchedOld) continue;
      if (current) this.#backupToTrash(`portable/${timeNs()}/${basename(readme)}`, current);
      this.#files.write(readme, PORTABLE_README);
    }
  }

  #relativeToRoot(relativePath: string): string | null {
    if (isAbsolute(relativePath) || CONTROL_CHARACTER.test(relativePath)) return null;
    const parts = relativePath.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
    const candidate = join(this.root, ...parts);
    try {
      this.#files.assertLexicalInside(candidate, relativePath);
    } catch {
      return null;
    }
    return candidate;
  }
}

// ---------------------------------------------------------------- portable

const LEGACY_PORTABLE_README = `# スライドの保管フォルダ

このフォルダは、Slide Studio アプリなしでも編集・再ビルドできます。フォルダ名と置き場所は自由です。共有する際は、隠しフォルダ \`.slide-studio/\` も含めてフォルダ全体をコピーしてください。

- \`decks/<発表名>/slides.qmd\`：原稿。テキストエディタで編集できます。
- \`decks/<発表名>/styles/\`：発表のスタイル。
- \`topics/<トピック>/\`：共有する \`html/\`・\`images/\`・\`reference.bib\`。\`themes/\`：テーマ。
- \`.slide-studio/compiler/\`：このフォルダ用に同梱した変換コード・Lua・スタイル・ランタイム。
- \`.slide-studio/runtime/\`：図が相対パスで読み込む共通コード。

## コンパイル

Python 3.13 以上と \`uv\` を用意し、ターミナルでこのフォルダに移動して実行します。初回は依存パッケージの取得にネットワークが必要です。Slide Studio のリポジトリ・インストールは不要です。

\`\`\`sh
uv run build.py --list
uv run build.py 発表名 --html-only
\`\`\`

検査して HTML と PDF を生成するには、初回に Chromium を準備します。

\`\`\`sh
uv run build.py --setup
uv run build.py 発表名
\`\`\`

出力は \`decks/<発表名>/<発表名>.html\` と \`.pdf\`。HTML はアニメーションを含む単一ファイルで、アプリなし・オフラインでブラウザで開けます。\`--html-only\` は検査を省略します。PDF は各ページの各 step の動きが終わった状態を1枚ずつ出力します。アニメーションの途中のフレームは含めません。

依存パッケージと Chromium の準備後は、外部素材を含まない原稿をオフラインでビルドできます。QMD の図参照などは同梱の変換コードが処理するため、Pandoc 単体での実行では同じ結果になりません。
`;

/** Hash-pinned Python-era READMEs. Pinned by content so a template change cannot orphan them. */
export const OLD_PORTABLE_READMES = new Set<string>([sha256Bytes(LEGACY_PORTABLE_README)]);
try {
  // The bundled asset is also recognised while the pinned copy above remains
  // authoritative after the asset is changed or removed.
  OLD_PORTABLE_READMES.add(
    sha256Bytes(readFileSync(assetPath("templates", "portable", "README.md"))),
  );
} catch {
  // Asset-less test runs keep only the pinned hash.
}

const PREVIOUS_PORTABLE_README = `# スライドの保管フォルダ

このフォルダは Slide Studio で編集・再ビルドできます。フォルダ名と置き場所は自由です。共有する際は、隠しフォルダ \`.slide-studio/\` も含めてフォルダ全体をコピーしてください。

- \`decks/<発表名>/slides.qmd\`：原稿。テキストエディタで編集できます。
- \`decks/<発表名>/styles/\`：発表のスタイル。
- \`topics/<トピック>/\`：共有する \`html/\`・\`images/\`・\`reference.bib\`。\`themes/\`：テーマ。
- \`.slide-studio/runtime/\`：図が相対パスで読み込む共通コード。

## 書き出し

Slide Studio のアプリ画面から HTML と PDF を書き出せます。ソース版では、そのリポジトリで \`npm run cli -- build <発表名> --root <このフォルダの絶対パス>\` を実行して書き出すこともできます。このフォルダに含まれる原稿・図・テーマは、アプリを入れていない環境でもテキストエディタで編集できます。
`;

OLD_PORTABLE_READMES.add(sha256Bytes(PREVIOUS_PORTABLE_README));
const PORTABLE_README = readFileSync(join(TEMPLATES, "portable", "README.md"), "utf8");
