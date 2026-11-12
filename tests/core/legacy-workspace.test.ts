import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  OLD_DEFAULT_THEMES,
  OLD_PORTABLE_READMES,
  OLD_THEMES,
  RUNTIME,
  RUNTIME_FILES,
  StudioError,
  TEMPLATES,
  THEME_VARIABLES,
  Workspace,
  blank_qmd,
  check_name,
  default_root,
  figure_steps,
  figure_title,
  location_file,
  pyStr,
  pyTruthy,
  recent_roots,
  remember_root,
  runtime_rel,
  saved_root,
  set_front,
  set_strings_file,
  theme_variables,
} from "../../packages/core/src/legacy-workspace.js";
import { parse } from "../../packages/core/src/legacy-source.js";
import { assetPath } from "../../packages/core/src/assets.js";
import {
  drop_cover_layout,
  preserve_title_header,
  read_vars,
  refresh_heading_options,
} from "../../packages/core/src/legacy-theme-edit.js";
import { with_current_palette } from "../../packages/core/src/legacy-block-design.js";

function scratch(t: TestContext): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "slide-studio-legacy-")));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function repositoryRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      try {
        const value = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
        if (value.name === "slide-studio") return directory;
      } catch {
        // Keep walking until the source package root is found.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("could not locate the slide-studio repository root");
    }
    directory = parent;
  }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test("creates the legacy layout, bundled themes, runtime and agent guidance", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);

  assert.equal(ws.root, realpathSync.native(root));
  for (const directory of [ws.topics, ws.decks, ws.themes, ws.state, ws.runtime]) {
    assert.equal(lstatSync(directory).isDirectory(), true, directory);
  }
  assert.deepEqual(ws.themes_list(), [
    "default", "graphite", "mist", "night", "solarized", "terracotta",
  ]);
  assert.equal(existsSync(join(ws.themes, "_base.css")), false);
  for (const name of RUNTIME_FILES) {
    assert.equal(existsSync(join(ws.runtime, name)), true, name);
  }
  assert.equal(existsSync(join(root, "AGENTS.md")), true);
  assert.equal(existsSync(join(root, "CLAUDE.md")), true);
  assert.equal(existsSync(join(root, ".agents/skills/slide-studio-slides/SKILL.md")), true);
  const skillLink = join(root, ".claude/skills/slide-studio-slides");
  let symlinksSupported = true;
  const probe = join(root, ".symlink-probe");
  try {
    symlinkSync(ws.topics, probe, "dir");
    unlinkSync(probe);
  } catch {
    symlinksSupported = false;
  }
  if (symlinksSupported) {
    assert.equal(lstatSync(skillLink).isSymbolicLink(), true);
  } else {
    // Portable workspaces still receive the guidance files when the OS
    // cannot create directory symlinks (for example Windows without Developer Mode).
    assert.equal(existsSync(join(root, ".agents/skills/slide-studio-slides/SKILL.md")), true);
  }
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.doesNotMatch(readme, /slide-studio build/u);
  assert.doesNotMatch(readme, /uv run|Python 3/u);
  assert.match(readme, /準備中/u);
  assert.equal(existsSync(join(root, "build.py")), false);
  assert.equal(
    OLD_PORTABLE_READMES.has(sha(readFileSync(join(TEMPLATES, "portable", "README.md"), "utf8"))),
    true,
  );
  const record = readJson(join(ws.state, "bundled-themes.json"));
  assert.equal(typeof record["default.css"], "string");
});

test("location helpers remember absolute roots and respect the environment", async (t) => {
  const root = await scratch(t);
  const previousLocation = process.env.SLIDE_STUDIO_LOCATION;
  const previousHome = process.env.SLIDE_STUDIO_HOME;
  process.env.SLIDE_STUDIO_LOCATION = join(root, "config", "location.json");
  delete process.env.SLIDE_STUDIO_HOME;
  try {
    assert.equal(location_file(), join(root, "config", "location.json"));
    assert.equal(saved_root(), null);
    assert.deepEqual(recent_roots(), []);

    const first = join(root, "first");
    const second = join(root, "second");
    remember_root(first);
    remember_root(second, { previous: first });
    assert.equal(saved_root(), second);
    assert.deepEqual(recent_roots(), [second, first]);
    assert.equal(default_root(), second);

    process.env.SLIDE_STUDIO_HOME = join(root, "from-env");
    assert.equal(default_root(), join(root, "from-env"));
  } finally {
    if (previousLocation === undefined) delete process.env.SLIDE_STUDIO_LOCATION;
    else process.env.SLIDE_STUDIO_LOCATION = previousLocation;
    if (previousHome === undefined) delete process.env.SLIDE_STUDIO_HOME;
    else process.env.SLIDE_STUDIO_HOME = previousHome;
  }
});

test("set_front changes only requested front-matter keys and renames figures", async (t) => {
  const root = await scratch(t);
  const source = [
    "---",
    'title: "元の題"',
    "theme: default",
    "figures: alpha",
    "custom: keep",
    "---",
    "",
    "## 表紙 {#cover}",
    "",
    "本文の  空白はそのまま。",
    "",
    "```qmd",
    "theme: not-front-matter",
    "```",
    "",
  ].join("\n");

  const updated = set_front(source, { theme: "night", topic: "beta" });
  assert.match(updated, /^theme: night$/mu);
  assert.match(updated, /^topic: beta$/mu);
  assert.match(updated, /^custom: keep$/mu);
  assert.doesNotMatch(updated, /^figures:/mu);
  assert.match(updated, /本文の  空白はそのまま。/u);
  assert.match(updated, /```qmd\ntheme: not-front-matter\n```/u);
  assert.equal(set_front("## A\n", {}), "## A\n");
  assert.equal(set_front("## A\n", { topic: "x" }), "---\ntopic: x\n---\n\n## A\n");

  const parsed = parse(source);
  assert.deepEqual(parsed.pages.map((page) => page.id), ["cover"]);
  assert.equal(parsed.meta.topic, "alpha");
  assert.equal(theme_variables("/* --ignored: x; */ :root{--one: 1; --one: 2; --two:#fff}").join(","), "--one,--two");
  assert.equal(THEME_VARIABLES.length, 14);
  assert.ok(blank_qmd("topic", "default", "題\n名").includes('title: "題\\n名"'));
});

test("new_deck writes the blank template and detects edited sources", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  const directory = ws.new_deck("talk", "research");

  assert.equal(directory, ws.deck_dir("talk"));
  assert.equal(ws.is_blank("talk"), true);
  assert.equal(ws.is_untouched("talk"), true);
  assert.equal(ws.deck_meta("talk").topic, "research");
  assert.equal(ws.deck_meta("talk").theme, "default");
  assert.equal(existsSync(ws.memo("talk")), true);
  assert.equal(existsSync(join(directory, "styles", "slides.css")), true);
  assert.equal(lstatSync(ws.shelf_dir("research")).isDirectory(), true);
  assert.equal(lstatSync(ws.images_dir("talk")).isDirectory(), true);

  writeFileSync(
    ws.qmd("talk"),
    '---\ntitle: "自分で書いた"\ntopic: research\ntheme: default\n---\n\n## 表紙 {#cover}\n\n本文の  空白。\n',
  );
  assert.equal(ws.is_blank("talk"), false);
  assert.equal(ws.is_untouched("talk"), false);
  assert.equal(ws.deck_meta("talk").title, "自分で書いた");
  assert.equal(ws.deck_theme("talk"), "default");
  assert.equal(ws.deck_shelf("talk"), "research");
});

test("copies a deck, skips materials and html/pdf, copies figures and bibliography", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("source", "alpha");
  writeFileSync(
    ws.qmd("source"),
    [
      "---",
      'title: "元の発表"',
      "topic: alpha",
      "theme: default",
      "---",
      "",
      "## 表紙 {#cover}",
      "",
      "{{< fig alpha/demo height=150 >}}",
      "",
      "topics/alpha/html/demo/index.html",
      "",
    ].join("\n"),
  );
  const figure = join(ws.shelf_dir("alpha"), "demo");
  mkdirSync(figure, { recursive: true });
  writeFileSync(join(figure, "figure.mjs"), "export default { title: '图', steps: ['A', 'B'] };\n");
  writeFileSync(join(figure, "index.html"), "<!doctype html>\n");
  mkdirSync(join(ws.shelf_dir("alpha"), "_lib"), { recursive: true });
  writeFileSync(join(ws.shelf_dir("alpha"), "_lib", "draw.mjs"), "export {};\n");
  writeFileSync(ws.bib("source"), "@misc{alpha, title={Alpha}}\n");

  mkdirSync(join(ws.deck_dir("source"), "materials"), { recursive: true });
  writeFileSync(join(ws.deck_dir("source"), "materials", "large.pdf"), "pdf");
  writeFileSync(join(ws.deck_dir("source"), "old.html"), "<html>old</html>");
  writeFileSync(join(ws.deck_dir("source"), "old.pdf"), "%PDF-old");
  writeFileSync(join(ws.deck_dir("source"), "keep.txt"), "keep");
  writeFileSync(join(ws.deck_dir("source"), "styles", "slides.css"), ".custom{}\n");

  ws.new_deck("copy", "beta", "night", "source", "新しい題");

  const copied = ws.qmd("copy");
  const text = readFileSync(copied, "utf8");
  assert.match(text, /^topic: beta$/mu);
  assert.match(text, /^theme: night$/mu);
  assert.match(text, /^title: "新しい題"$/mu);
  assert.match(text, /\{\{< fig beta\/demo height=150 >\}\}/u);
  assert.match(text, /topics\/beta\/html\/demo\/index\.html/u);
  assert.equal(existsSync(join(ws.deck_dir("copy"), "materials")), false);
  assert.equal(existsSync(join(ws.deck_dir("copy"), "old.html")), false);
  assert.equal(existsSync(join(ws.deck_dir("copy"), "old.pdf")), false);
  assert.equal(readFileSync(join(ws.deck_dir("copy"), "keep.txt"), "utf8"), "keep");
  assert.equal(readFileSync(join(ws.deck_dir("copy"), "styles", "slides.css"), "utf8"), ".custom{}\n");

  assert.equal(existsSync(join(ws.shelf_dir("beta"), "demo", "figure.mjs")), true);
  assert.equal(existsSync(join(ws.shelf_dir("beta"), "_lib", "draw.mjs")), true);
  assert.equal(existsSync(join(ws.topic_dir("beta"), "reference.bib")), true);
  assert.equal(existsSync(join(ws.deck_dir("copy"), "reference.bib")), false);
  assert.deepEqual(ws.prefs(), { theme: "night", shelf: "beta" });
  assert.equal(ws.recent()[0]?.deck, "copy");
});

test("upgrades untouched bundled themes, preserves edits, and prepends default deck migration", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("legacy", "test");
  const defaultTheme = join(ws.themes, "default.css");
  const customStyle = join(ws.deck_dir("legacy"), "styles", "slides.css");
  writeFileSync(customStyle, ".my-deck{}\n");

  const oldDefault = "/* old untouched default */\n";
  const oldDigest = sha(oldDefault);
  OLD_DEFAULT_THEMES.add(oldDigest);
  try {
    writeFileSync(defaultTheme, oldDefault);
    ws.ensure();
    assert.equal(readFileSync(defaultTheme, "utf8"), readFileSync(join(TEMPLATES, "themes", "default.css"), "utf8"));
    const migrated = readFileSync(customStyle, "utf8");
    assert.match(migrated, /\.method-slide/u);
    assert.match(migrated, /\.my-deck\{\}\s*$/u);
    assert.deepEqual(ws.theme_preparation(), []);

    ws.ensure();
    assert.equal(readFileSync(customStyle, "utf8"), migrated);
  } finally {
    OLD_DEFAULT_THEMES.delete(oldDigest);
  }

  writeFileSync(defaultTheme, "/* my edited theme */\n");
  ws.ensure();
  assert.equal(readFileSync(defaultTheme, "utf8"), "/* my edited theme */\n");
  assert.equal(ws.theme_preparation()[0]?.ok, false);
  assert.match(String(ws.theme_preparation()[0]?.fix), /styles\/slides\.css/u);

  rmSync(join(ws.themes, "night.css"));
  ws.ensure();
  assert.equal(readFileSync(join(ws.themes, "night.css"), "utf8"), readFileSync(join(TEMPLATES, "themes", "night.css"), "utf8"));

  const oldNight = "/* old untouched night */\n";
  const oldNightDigest = sha(oldNight);
  OLD_THEMES["night.css"]?.add(oldNightDigest);
  try {
    writeFileSync(join(ws.themes, "night.css"), oldNight);
    ws.ensure();
    assert.equal(readFileSync(join(ws.themes, "night.css"), "utf8"), readFileSync(join(TEMPLATES, "themes", "night.css"), "utf8"));
  } finally {
    OLD_THEMES["night.css"]?.delete(oldNightDigest);
  }
});

test("migrates serif to terracotta and retires themes with backups", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  const serif = "/* untouched serif */\n";
  writeFileSync(join(ws.themes, "serif.css"), serif);
  const recordPath = join(ws.state, "bundled-themes.json");
  const record = readJson(recordPath);
  record["serif.css"] = sha(serif);
  writeJson(recordPath, record);
  const terracotta = join(ws.themes, "terracotta.css");
  const custom = `${readFileSync(terracotta, "utf8")}\n/* my layout */\n`;
  writeFileSync(terracotta, custom);

  ws.new_deck("legacy", "test", "serif");
  ws.set_prefs({ theme: "serif", recent_themes: ["serif", "night", "terracotta"] });
  ws.ensure();
  ws.ensure();

  assert.equal(ws.deck_theme("legacy"), "terracotta");
  assert.equal(ws.prefs().theme, "terracotta");
  assert.deepEqual(ws.prefs().recent_themes, ["terracotta", "night"]);
  assert.equal(existsSync(join(ws.themes, "serif.css")), false);
  assert.equal(readFileSync(terracotta, "utf8"), custom);
  const backups = readdirSync(join(ws.state, "trash", "themes"));
  assert.equal(backups.some((name) => existsSync(join(ws.state, "trash", "themes", name, "serif.css"))), true);
  assert.equal(
    backups.some((name) => existsSync(join(ws.state, "trash", "themes", name, "decks", "legacy", "slides.qmd"))),
    true,
  );

  ws.new_deck("retired", "test");
  writeFileSync(join(ws.themes, "sage.css"), "/* customized sage */\n");
  writeFileSync(ws.qmd("retired"), '---\ntitle: "retired"\ntopic: test\ntheme: sage\n---\n\n## Keep\n');
  ws.set_prefs({ theme: "sage", recent_themes: ["sage", "night"] });
  ws.ensure();
  assert.equal(ws.deck_theme("retired"), "default");
  assert.equal(ws.prefs().theme, "default");
  assert.deepEqual(ws.prefs().recent_themes, ["default", "night"]);
  assert.equal(existsSync(join(ws.themes, "sage.css")), false);
  const after = readdirSync(join(ws.state, "trash", "themes"));
  assert.equal(after.some((name) => existsSync(join(ws.state, "trash", "themes", name, "sage.css"))), true);
});

test("theme migration leaves a non-UTF-8 slides.qmd untouched", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  const serif = "/* untouched serif */\n";
  writeFileSync(join(ws.themes, "serif.css"), serif);
  const recordPath = join(ws.state, "bundled-themes.json");
  const record = readJson(recordPath);
  record["serif.css"] = sha(serif);
  writeJson(recordPath, record);
  ws.new_deck("legacy", "test", "serif");

  const qmd = ws.qmd("legacy");
  const bytes = Buffer.concat([
    Buffer.from('---\ntitle: "x"\ntopic: test\ntheme: serif\n---\n\n## Keep\n'),
    Buffer.from([0xff]),
  ]);
  writeFileSync(qmd, bytes);

  assert.throws(() => ws.ensure(), StudioError);
  assert.equal(readFileSync(qmd).equals(bytes), true);
  assert.equal(readFileSync(join(ws.themes, "serif.css"), "utf8"), serif);
});

test("theme refresh refuses non-UTF-8 css without rewriting it", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  const night = join(ws.themes, "night.css");
  const bytes = Buffer.concat([Buffer.from("/* custom */\n"), Buffer.from([0xff])]);
  writeFileSync(night, bytes);

  assert.throws(() => ws.ensure(), StudioError);
  assert.equal(readFileSync(night).equals(bytes), true);
});

test("moves an old figures/ layout into topics and updates explicit references", async (t) => {
  const root = await scratch(t);
  const figures = join(root, "figures", "alpha", "demo");
  mkdirSync(figures, { recursive: true });
  writeFileSync(join(figures, "figure.mjs"), "export default { title: 'Old', steps: ['one'] };\n");
  mkdirSync(join(root, "decks", "old"), { recursive: true });
  writeFileSync(
    join(root, "decks", "old", "slides.qmd"),
    [
      "---",
      "topic: alpha",
      "theme: default",
      "---",
      "",
      "## Cover",
      "",
      '![x](figures/alpha/demo/index.html)',
      "",
    ].join("\n"),
  );

  const ws = Workspace.open(root);
  assert.equal(existsSync(join(root, "figures")), false);
  assert.equal(existsSync(join(ws.shelf_dir("alpha"), "demo", "figure.mjs")), true);
  assert.match(readFileSync(ws.qmd("old"), "utf8"), /topics\/alpha\/html\/demo\/index\.html/u);
});

test("figure, shelf, topic and recent/preferences operations keep legacy semantics", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_topic("demo");
  const figure = join(ws.shelf_dir("demo"), "route");
  mkdirSync(figure, { recursive: true });
  writeFileSync(join(figure, "figure.mjs"), "export default { title: 'Route', steps: ['Start', 'End'] };\n");
  assert.equal(figure_title(figure), "Route");
  assert.deepEqual(figure_steps(figure), ["Start", "End"]);
  const runtimePath = runtime_rel(figure, ws);
  assert.equal(runtimePath, "../../../../.slide-studio/runtime");
  assert.equal(resolve(figure, runtimePath), ws.runtime);
  assert.equal(relative(figure, ws.runtime).replaceAll("\\", "/"), runtimePath);

  ws.new_deck("talk", "demo");
  writeFileSync(
    ws.qmd("talk"),
    '---\ntitle: "Talk"\ntopic: demo\ntheme: default\n---\n\n## Cover {#cover}\n\n{{< fig demo/route >}}\n',
  );
  assert.deepEqual(ws.list_figures(undefined, "talk"), [{
    name: "route",
    ref: "demo/route",
    title: "Route",
    steps: ["Start", "End"],
    place: "shelf",
  }]);
  assert.deepEqual(ws.decks_using("demo/route"), ["talk"]);
  assert.throws(() => ws.remove_topic("demo"), StudioError);
  assert.equal(ws.topic_empty("demo"), false);

  ws.new_topic("unused");
  const trash = ws.remove_topic("unused");
  assert.equal(existsSync(trash), true);
  assert.equal(existsSync(ws.topic_dir("unused")), false);
  assert.equal(ws.topic_empty("never-created"), true);

  ws.touch_recent("talk");
  ws.touch_recent("talk");
  const recent = ws.recent();
  assert.equal(recent[0]?.deck, "talk");
  assert.equal(recent[0]?.title, "Talk");
  ws.set_prefs({ theme: "night", recent_themes: ["night"] });
  assert.equal(ws.prefs().theme, "night");
  assert.deepEqual(ws.prefs().recent_themes, ["night"]);
});

test("rejects invalid and escaping names and symlinked workspace entries", async (t) => {
  const root = await scratch(t);
  for (const value of ["Bad", "with space", "NUL", "a/b", ""]) {
    assert.throws(() => check_name(value), StudioError, value);
  }
  // Legacy lookups keep Mac-created reserved Windows names; only creation rejects them.
  assert.equal(check_name("con"), "con");
  assert.equal(check_name("aux"), "aux");
  const relativeRoot = relative(process.cwd(), join(root, "relative-root"));
  const relativeWorkspace = Workspace.open(relativeRoot);
  assert.equal(relativeWorkspace.root, realpathSync.native(join(root, "relative-root")));

  const ws = Workspace.open(root);
  assert.throws(() => ws.figure_dir("../escape/name"), StudioError);
  assert.throws(() => ws.figure_dir("demo/../name"), StudioError);
  assert.equal(ws.figure_dir("demo/CON"), join(ws.shelf_dir("demo"), "CON"));
  assert.throws(() => ws.deck_meta(".."), StudioError);
  assert.throws(() => ws.new_topic("con"), StudioError);

  const outside = join(root, "..", `outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(ws.topics, { recursive: true, force: true });
  symlinkSync(outside, ws.topics, "dir");
  assert.throws(() => ws.ensure(), StudioError);

  const fresh = Workspace.open(join(root, "fresh"));
  fresh.new_deck("talk", "research");
  const qmd = fresh.qmd("talk");
  const target = join(outside, "slides.qmd");
  writeFileSync(target, '---\ntitle: "outside"\n---\n');
  unlinkSync(qmd);
  symlinkSync(target, qmd);
  assert.equal(fresh.has_deck("talk"), false);
  assert.deepEqual(fresh.list_decks(), []);
  assert.throws(() => fresh.deck_meta("talk"));
});

test("set_front preserves CRLF and BOM without the Python double-front bug", async (t) => {
  const root = await scratch(t);
  const crlf = "---\r\ntitle: old\r\n---\r\n\r\n## 題\r\n";
  const updated = set_front(crlf, { title: '"日本語"' });
  assert.equal(updated.startsWith('---\r\ntitle: "日本語"\r\n---\r\n'), true);
  assert.equal((updated.match(/^---/gmu) ?? []).length, 2);
  assert.equal(updated.endsWith("## 題\r\n"), true);

  const bom = `\uFEFF${crlf}`;
  const withBom = set_front(bom, { theme: "night" });
  assert.equal(withBom.startsWith("\uFEFF---\r\ntitle: old\r\n"), true);
  assert.match(withBom, /^theme: night\r$/mu);
  assert.equal((withBom.replace(/^\uFEFF/u, "").match(/^---/gmu) ?? []).length, 2);

  assert.equal(set_front("## A\n", {}), "## A\n");
  assert.equal(pyStr(true), "True");
  assert.equal(pyStr(null), "None");
  assert.equal(pyTruthy([]), false);
  assert.equal(pyTruthy([1]), true);
});

test("bibliography migration preserves paren entries and refuses broken BibTeX", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("talk", "topic");
  const local = join(ws.deck_dir("talk"), "reference.bib");
  const target = ws.bib("talk");

  writeFileSync(local, "@article(paren, title={Keep paren})\n");
  ws.ensure();
  assert.match(readFileSync(target, "utf8"), /Keep paren/u);
  assert.equal(existsSync(local), false);
  assert.equal(
    readdirSync(join(ws.state, "trash")).some((name) => name.startsWith("bib-")),
    true,
  );

  writeFileSync(local, "@article{broken, title={missing close}\n");
  ws.ensure();
  assert.equal(existsSync(local), true);
  assert.equal(readFileSync(local, "utf8"), "@article{broken, title={missing close}\n");
  assert.equal(ws.migration_preparation().some((item) => item.name === "文献の移行"), true);

  writeFileSync(local, "@string{publisher = {ACM}}\n@comment{keep me}\n");
  ws.ensure();
  assert.match(readFileSync(target, "utf8"), /@string\{publisher/u);
  assert.match(readFileSync(target, "utf8"), /@comment\{keep me\}/u);
});

test("bibliography migration reports non-UTF-8 files instead of merging mojibake", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("talk", "topic");
  const local = join(ws.deck_dir("talk"), "reference.bib");
  const target = ws.bib("talk");
  const bytes = Buffer.concat([
    Buffer.from("@article{latin, title={Caf"),
    Buffer.from([0xe9]),
    Buffer.from("}}\n"),
  ]);
  writeFileSync(local, bytes);

  ws.ensure();
  assert.equal(readFileSync(local).equals(bytes), true);
  assert.equal(readFileSync(target, "utf8"), "");
  assert.doesNotMatch(readFileSync(target, "utf8"), /\uFFFD/u);
  const conflict = ws.migration_preparation().find((item) => item.name === "文献の移行");
  assert.equal(typeof conflict?.detail, "string");
  assert.match(String(conflict?.detail), /UTF-8/u);
});

test("agent files back up edits on version changes and forget edited obsolete files", async (t) => {
  const root = await scratch(t);
  Workspace.open(root);
  const agents = join(root, "AGENTS.md");
  writeFileSync(agents, "# my edit\n");
  const next = Workspace.open(root, true, { version: "9.9.9" });
  assert.match(readFileSync(agents, "utf8"), /Slide Studio の置き場/u);
  const trash = join(next.state, "trash", "agent-files");
  assert.equal(
    readdirSync(trash).some((stamp) => existsSync(join(trash, stamp, "AGENTS.md"))),
    true,
  );

  const stampPath = join(next.state, "agent-files.json");
  const stamp = readJson(stampPath);
  const obsolete = ".agents/skills/obsolete/SKILL.md";
  stamp[obsolete] = sha("original obsolete");
  writeJson(stampPath, stamp);
  const obsoletePath = join(root, obsolete);
  mkdirSync(dirname(obsoletePath), { recursive: true });
  writeFileSync(obsoletePath, "user edited obsolete");
  next.ensure();
  assert.equal(existsSync(obsoletePath), true);
  writeFileSync(obsoletePath, "original obsolete");
  next.ensure();
  assert.equal(existsSync(obsoletePath), true);
});

test("agent cleanup never deletes through a symlinked .agents directory", async (t) => {
  const root = await scratch(t);
  const workspace = Workspace.open(root);
  const outside = join(root, "..", `agents-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(join(root, ".agents"), { recursive: true, force: true });
  try {
    symlinkSync(outside, join(root, ".agents"), "dir");
  } catch {
    return;
  }
  writeFileSync(join(outside, "AGENTS.md"), "outside");
  const stampPath = join(workspace.state, "agent-files.json");
  const stamp = readJson(stampPath);
  stamp["AGENTS.md"] = sha("outside");
  writeJson(stampPath, stamp);
  workspace.ensure();
  assert.equal(readFileSync(join(outside, "AGENTS.md"), "utf8"), "outside");
});

test("topic migration does not touch decks when topics/ already exists", async (t) => {
  const root = await scratch(t);
  mkdirSync(join(root, "figures", "alpha", "demo"), { recursive: true });
  writeFileSync(join(root, "figures", "alpha", "demo", "figure.mjs"), "export default {};\n");
  mkdirSync(join(root, "topics", "existing"), { recursive: true });
  mkdirSync(join(root, "decks", "old"), { recursive: true });
  const qmd = join(root, "decks", "old", "slides.qmd");
  const text = "---\ntopic: alpha\ntheme: default\n---\n\n![x](figures/alpha/demo/index.html)\n";
  writeFileSync(qmd, text);

  Workspace.open(root);
  assert.equal(readFileSync(qmd, "utf8"), text);
  assert.equal(existsSync(join(root, "figures", "alpha", "demo", "figure.mjs")), true);
});

test("topic migration refuses symlinks instead of deleting their content", async (t) => {
  const root = await scratch(t);
  const outside = join(root, "..", `figures-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "keep.txt"), "keep");
  mkdirSync(join(root, "figures", "alpha"), { recursive: true });
  try {
    symlinkSync(outside, join(root, "figures", "alpha", "link"), "dir");
  } catch {
    return;
  }
  assert.throws(() => Workspace.open(root), StudioError);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
});

test("new_deck follows internal symlinks, rejects external ones and rolls back", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("source", "alpha");
  writeFileSync(join(ws.deck_dir("source"), "extra.txt"), "content");
  try {
    symlinkSync(join(ws.deck_dir("source"), "extra.txt"), join(ws.deck_dir("source"), "alias.txt"));
  } catch {
    return;
  }
  ws.new_deck("copy", "beta", "default", "source");
  assert.equal(readFileSync(join(ws.deck_dir("copy"), "alias.txt"), "utf8"), "content");
  assert.equal(lstatSync(join(ws.deck_dir("copy"), "alias.txt")).isSymbolicLink(), false);

  const outside = join(root, "..", `deck-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(ws.deck_dir("source"), "external.txt"));
  assert.throws(() => ws.new_deck("bad", "beta", "default", "source"), StudioError);
  assert.equal(existsSync(ws.deck_dir("bad")), false);
  assert.equal(
    readdirSync(ws.decks).some((name) => name.startsWith(".new-")),
    false,
  );
});

test("reserved Windows names stay visible while creation rejects them", async (t) => {
  const root = await scratch(t);
  mkdirSync(join(root, "decks", "con"), { recursive: true });
  writeFileSync(
    join(root, "decks", "con", "slides.qmd"),
    "---\ntopic: aux\ntheme: default\n---\n\n## A\n",
  );
  mkdirSync(join(root, "topics", "aux"), { recursive: true });
  const ws = Workspace.open(root);
  assert.deepEqual(ws.list_decks(), ["con"]);
  assert.equal(ws.deck_shelf("con"), "aux");
  assert.throws(() => ws.new_topic("con"), StudioError);
  assert.throws(() => ws.new_deck("COM1", "aux"), StudioError);
});

test("unreadable memo and symlinked themes do not make the workspace unopenable", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("talk", "topic");
  const memo = ws.memo("talk");
  const target = join(ws.deck_dir("talk"), "memo-target.md");
  writeFileSync(target, readFileSync(memo));
  unlinkSync(memo);
  try {
    symlinkSync(target, memo);
  } catch {
    return;
  }
  assert.equal(ws.is_untouched("talk"), false);

  const outside = join(root, "..", `theme-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "default.css"), "/* outside */\n");
  unlinkSync(join(ws.themes, "default.css"));
  symlinkSync(join(outside, "default.css"), join(ws.themes, "default.css"));
  ws.ensure();
  assert.equal(ws.theme_preparation().length, 1);
  assert.throws(() => ws.theme_default("../../x"), StudioError);
});

test("theme preparation strings come from the configured strings module", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  writeFileSync(join(ws.themes, "default.css"), "/* old */\n");
  const strings = join(root, "strings.js");
  writeFileSync(
    strings,
    'export const THEME_PREPARATION = {"name": "Custom", "detail": "D", "fix": "F"};\n',
  );
  set_strings_file(strings);
  try {
    assert.equal(ws.theme_preparation()[0]?.name, "Custom");
  } finally {
    set_strings_file(null);
  }
});

test("figure helpers and quote stripping match Python code-point semantics", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_topic("demo");
  const figure = join(ws.shelf_dir("demo"), "route");
  mkdirSync(figure, { recursive: true });
  writeFileSync(
    join(figure, "figure.mjs"),
    "export default { steps: ['one\ntwo'] };\n",
  );
  // Python's item pattern has no DOTALL, so a quoted step containing a newline
  // is skipped rather than swallowing text across the newline.
  assert.deepEqual(figure_steps(figure), []);

  ws.new_deck("talk", "demo");
  writeFileSync(
    ws.qmd("talk"),
    '---\ntitle: "Talk"\ntopic: demo\ntheme: default\n---\n\n## Cover\n\n{{< fig \'demo/route\' >}}\n',
  );
  assert.deepEqual(ws.decks_using("demo/route"), []);
  assert.deepEqual(ws.decks_using("'demo/route'"), ["talk"]);
});

test("topic migration resumes a commit interrupted after topics/ is renamed", async (t) => {
  const root = await scratch(t);
  const figure = join(root, "figures", "alpha", "demo");
  mkdirSync(figure, { recursive: true });
  const figureBytes = Buffer.from("export default { title: 'Old', steps: ['one'] };\n");
  writeFileSync(join(figure, "figure.mjs"), figureBytes);
  mkdirSync(join(root, "decks", "old"), { recursive: true });
  const qmd = join(root, "decks", "old", "slides.qmd");
  const qmdBytes = [
    "---",
    "topic: alpha",
    "theme: default",
    "---",
    "",
    "## Cover",
    "",
    "![x](figures/alpha/demo/index.html)",
    "",
  ].join("\n");
  writeFileSync(qmd, qmdBytes);

  // A file where the trash directory belongs makes the first run fail after
  // stage -> topics has already happened.
  mkdirSync(join(root, ".slide-studio"), { recursive: true });
  writeFileSync(join(root, ".slide-studio", "trash"), "not a directory");

  assert.throws(() => Workspace.open(root), StudioError);
  assert.equal(existsSync(join(root, "topics", "alpha", "html", "demo", "figure.mjs")), true);
  assert.equal(readFileSync(join(root, "figures", "alpha", "demo", "figure.mjs")).equals(figureBytes), true);
  assert.equal(readFileSync(qmd, "utf8"), qmdBytes);
  const manifest = join(root, ".slide-studio", "migrate", "topics-v1", "manifest.json");
  assert.equal(readJson(manifest).phase, "prepared");

  rmSync(join(root, ".slide-studio", "trash"), { force: true });
  const ws = Workspace.open(root);
  assert.equal(existsSync(join(root, "figures")), false);
  assert.match(readFileSync(ws.qmd("old"), "utf8"), /topics\/alpha\/html\/demo\/index\.html/u);
  assert.equal(readJson(manifest).phase, "done");

  const trashRoot = join(ws.state, "trash", "topics-v1");
  const runs = readdirSync(trashRoot);
  assert.equal(runs.length, 1);
  const run = join(trashRoot, runs[0]!);
  assert.equal(
    readFileSync(join(run, "figures", "alpha", "demo", "figure.mjs")).equals(figureBytes),
    true,
  );
  assert.equal(readFileSync(join(run, "decks", "old", "slides.qmd"), "utf8"), qmdBytes);
});

test("topic migration uses a fresh trash directory beside an existing one", async (t) => {
  const root = await scratch(t);
  const figure = join(root, "figures", "alpha", "demo");
  mkdirSync(figure, { recursive: true });
  writeFileSync(join(figure, "figure.mjs"), "export default {};\n");
  mkdirSync(join(root, "decks", "old"), { recursive: true });
  writeFileSync(
    join(root, "decks", "old", "slides.qmd"),
    "---\ntopic: alpha\ntheme: default\n---\n\n## A\n",
  );
  const existing = join(root, ".slide-studio", "trash", "topics-v1");
  const oldBackup = join(existing, "figures", "alpha", "demo", "figure.mjs");
  mkdirSync(dirname(oldBackup), { recursive: true });
  writeFileSync(oldBackup, "old backup");
  writeFileSync(join(existing, "sentinel.txt"), "keep");

  const ws = Workspace.open(root);
  assert.equal(readFileSync(join(existing, "sentinel.txt"), "utf8"), "keep");
  assert.equal(readFileSync(oldBackup, "utf8"), "old backup");
  const runs = readdirSync(existing);
  assert.equal(runs.includes("sentinel.txt"), true);
  assert.equal(
    runs.some((name) => existsSync(join(existing, name, "figures", "alpha", "demo", "figure.mjs"))),
    true,
  );
});

test("topic migration aborts on a non-UTF-8 qmd without writing a manifest", async (t) => {
  const root = await scratch(t);
  const figure = join(root, "figures", "alpha", "demo");
  mkdirSync(figure, { recursive: true });
  writeFileSync(join(figure, "figure.mjs"), "export default {};\n");
  mkdirSync(join(root, "decks", "old"), { recursive: true });
  const qmd = join(root, "decks", "old", "slides.qmd");
  const qmdBytes = Buffer.concat([
    Buffer.from("---\ntopic: alpha\ntheme: default\n---\n\n## Cover\n\n"),
    Buffer.from([0xff]),
    Buffer.from("\n"),
  ]);
  writeFileSync(qmd, qmdBytes);

  assert.throws(() => Workspace.open(root), StudioError);
  assert.equal(readFileSync(qmd).equals(qmdBytes), true);
  assert.equal(existsSync(join(root, "figures", "alpha", "demo", "figure.mjs")), true);
  assert.equal(
    existsSync(join(root, ".slide-studio", "migrate", "topics-v1", "manifest.json")),
    false,
  );
});

test("topic migration does not read unrelated unreadable files during commit", async (t) => {
  const root = await scratch(t);
  const figure = join(root, "figures", "alpha", "demo");
  mkdirSync(figure, { recursive: true });
  writeFileSync(join(figure, "figure.mjs"), "export default {};\n");
  const deck = join(root, "decks", "old");
  mkdirSync(join(deck, "materials"), { recursive: true });
  writeFileSync(
    join(deck, "slides.qmd"),
    "---\ntopic: alpha\ntheme: default\n---\n\n## Cover\n",
  );
  const locked = join(deck, "materials", "locked.bin");
  writeFileSync(locked, "locked");
  if (process.platform !== "win32" && process.getuid?.() !== 0) chmodSync(locked, 0o000);

  const ws = Workspace.open(root);
  assert.equal(readJson(join(ws.state, "migrate", "topics-v1", "manifest.json")).phase, "done");
  assert.equal(existsSync(join(root, "figures")), false);
});

test("topic migration deduplicates alias decks and resumes after originals move", async (t) => {
  const root = await scratch(t);
  const figure = join(root, "figures", "alpha", "demo");
  mkdirSync(figure, { recursive: true });
  writeFileSync(join(figure, "figure.mjs"), "export default {};\n");
  const deck = join(root, "decks", "old");
  mkdirSync(deck, { recursive: true });
  writeFileSync(
    join(deck, "slides.qmd"),
    "---\ntopic: alpha\ntheme: default\n---\n\n## Cover\n",
  );
  mkdirSync(join(deck, "images"), { recursive: true });
  writeFileSync(join(deck, "images", "keep.txt"), "keep");
  try {
    symlinkSync(deck, join(root, "decks", "zz-alias"), "dir");
  } catch {
    return;
  }

  // Fail after stage -> topics so the next open resumes the prepared commit.
  mkdirSync(join(root, ".slide-studio"), { recursive: true });
  writeFileSync(join(root, ".slide-studio", "trash"), "not a directory");
  assert.throws(() => Workspace.open(root), StudioError);
  assert.equal(existsSync(join(root, "topics", "alpha", "images", "keep.txt")), true);
  rmSync(join(root, ".slide-studio", "trash"), { force: true });

  const manifestPath = join(root, ".slide-studio", "migrate", "topics-v1", "manifest.json");
  const manifest = readJson(manifestPath) as {
    phase: string;
    trash: string;
    originals: string[];
    qmd: Record<string, { before: string; after: string }>;
  };
  assert.equal(manifest.phase, "prepared");
  // The alias and the real deck share one images directory.
  assert.equal(manifest.originals.filter((rel) => rel.endsWith("/images")).length, 1);

  // Simulate an interrupted run that had already rewritten the qmd and moved
  // the originals before it could record `done`.
  const trash = join(root, manifest.trash);
  for (const rel of manifest.originals) {
    const source = join(root, rel);
    if (!existsSync(source)) continue;
    const destination = join(trash, rel);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
  }
  for (const [rel, values] of Object.entries(manifest.qmd)) {
    writeFileSync(join(root, rel), values.after);
  }

  const ws = Workspace.open(root);
  assert.equal(readJson(manifestPath).phase, "done");
  assert.equal(existsSync(join(root, "figures")), false);
  const runs = readdirSync(join(ws.state, "trash", "topics-v1"));
  const run = runs.find((name) =>
    existsSync(join(ws.state, "trash", "topics-v1", name, "decks"))
  );
  assert.equal(typeof run, "string");
  assert.deepEqual(
    readdirSync(join(ws.state, "trash", "topics-v1", run!, "decks")),
    ["old"],
  );
});

test("topic migration refuses a symlinked slides.qmd", async (t) => {
  const root = await scratch(t);
  const figure = join(root, "figures", "alpha", "demo");
  mkdirSync(figure, { recursive: true });
  writeFileSync(join(figure, "figure.mjs"), "export default {};\n");
  const deck = join(root, "decks", "old");
  mkdirSync(deck, { recursive: true });
  const target = join(deck, "real.qmd");
  const qmdBytes = Buffer.from("---\ntopic: alpha\ntheme: default\n---\n\n## Cover\n");
  writeFileSync(target, qmdBytes);
  try {
    symlinkSync(target, join(deck, "slides.qmd"));
  } catch {
    return;
  }

  assert.throws(() => Workspace.open(root), StudioError);
  assert.equal(lstatSync(join(deck, "slides.qmd")).isSymbolicLink(), true);
  assert.equal(readFileSync(target).equals(qmdBytes), true);
  assert.equal(existsSync(join(root, "figures", "alpha", "demo", "figure.mjs")), true);
});

test("topic migration validates decks/ before moving any figures", async (t) => {
  for (const location of ["inside", "outside"] as const) {
    const root = await scratch(t);
    const figure = join(root, "figures", "alpha", "demo");
    mkdirSync(figure, { recursive: true });
    writeFileSync(join(figure, "figure.mjs"), "export default {};\n");
    const target = location === "inside"
      ? join(root, "real-decks")
      : join(root, "..", `decks-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(target, { recursive: true });
    if (location === "outside") {
      t.after(() => rmSync(target, { recursive: true, force: true }));
    }
    mkdirSync(join(target, "old"), { recursive: true });
    const qmd = join(target, "old", "slides.qmd");
    const text = "---\ntopic: alpha\ntheme: default\n---\n\n## Cover\n";
    writeFileSync(qmd, text);
    try {
      symlinkSync(target, join(root, "decks"), "dir");
    } catch {
      return;
    }

    assert.throws(() => Workspace.open(root), StudioError);
    assert.equal(existsSync(join(root, "figures", "alpha", "demo", "figure.mjs")), true);
    assert.equal(existsSync(join(root, "topics")), false);
    assert.equal(readFileSync(qmd, "utf8"), text);
    assert.equal(
      existsSync(join(root, ".slide-studio", "migrate", "topics-v1", "manifest.json")),
      false,
    );
  }
});

test("topic migration ignores non-directory deck asset names", async (t) => {
  const root = await scratch(t);
  const figure = join(root, "figures", "alpha", "demo");
  mkdirSync(figure, { recursive: true });
  writeFileSync(join(figure, "figure.mjs"), "export default {};\n");
  const deck = join(root, "decks", "old");
  mkdirSync(deck, { recursive: true });
  writeFileSync(
    join(deck, "slides.qmd"),
    "---\ntopic: alpha\ntheme: default\n---\n\n## Cover\n",
  );
  for (const name of ["images", "html", "figures"]) {
    writeFileSync(join(deck, name), `${name} file`);
  }

  const ws = Workspace.open(root);
  for (const name of ["images", "html", "figures"]) {
    assert.equal(readFileSync(join(ws.deck_dir("old"), name), "utf8"), `${name} file`);
  }
  assert.equal(existsSync(join(ws.topics, "alpha", "images")), false);
  assert.deepEqual(readdirSync(join(ws.topics, "alpha", "html")), ["demo"]);
  assert.equal(readJson(join(ws.state, "migrate", "topics-v1", "manifest.json")).phase, "done");
  assert.doesNotThrow(() => ws.ensure());
});

test("topic migration rolls live topics back to stage on a recoverable conflict", async (t) => {
  const root = await scratch(t);
  const figure = join(root, "figures", "alpha", "demo");
  mkdirSync(figure, { recursive: true });
  const figurePath = join(figure, "figure.mjs");
  writeFileSync(figurePath, "original");
  mkdirSync(join(root, "decks", "old"), { recursive: true });
  writeFileSync(
    join(root, "decks", "old", "slides.qmd"),
    "---\ntopic: alpha\ntheme: default\n---\n\n## Cover\n",
  );

  mkdirSync(join(root, ".slide-studio"), { recursive: true });
  writeFileSync(join(root, ".slide-studio", "trash"), "not a directory");
  assert.throws(() => Workspace.open(root), StudioError);
  assert.equal(existsSync(join(root, "topics", "alpha", "html", "demo", "figure.mjs")), true);
  rmSync(join(root, ".slide-studio", "trash"), { force: true });

  // The original is edited before the resumed commit; it must be preserved and
  // the live topics/ tree returned to the recoverable stage.
  writeFileSync(figurePath, "user edit");
  let detail = "";
  assert.throws(() => Workspace.open(root), (error: unknown) => {
    assert.equal(error instanceof StudioError, true);
    detail = error instanceof Error ? error.message : String(error);
    return true;
  });
  assert.match(detail, /stage|manifest|退避/u);
  assert.equal(existsSync(join(root, "topics")), false);
  const stage = join(root, ".slide-studio", "migrate", "topics-v1", "stage", "topics");
  assert.equal(existsSync(join(stage, "alpha", "html", "demo", "figure.mjs")), true);
  assert.equal(readFileSync(figurePath, "utf8"), "user edit");
  assert.equal(
    readJson(join(root, ".slide-studio", "migrate", "topics-v1", "manifest.json")).phase,
    "prepared",
  );
});

test("new_deck refuses a symlinked destination topic html", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("source", "alpha");
  const outside = join(root, "..", `topic-html-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "sentinel.txt"), "keep");
  mkdirSync(ws.topic_dir("beta"), { recursive: true });
  try {
    symlinkSync(outside, join(ws.topic_dir("beta"), "html"), "dir");
  } catch {
    return;
  }

  assert.throws(() => ws.new_deck("copy", "beta", "default", "source"), StudioError);
  assert.equal(existsSync(ws.deck_dir("copy")), false);
  assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "keep");
  assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
});

test("new_deck refuses a symlinked destination topic", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("source", "alpha");
  const outside = join(root, "..", `topic-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "sentinel.txt"), "keep");
  try {
    symlinkSync(outside, ws.topic_dir("beta"), "dir");
  } catch {
    return;
  }

  assert.throws(() => ws.new_deck("copy", "beta", "default", "source"), StudioError);
  assert.equal(existsSync(ws.deck_dir("copy")), false);
  assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "keep");
  assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
});

test("new_deck rolls back topic assets copied before a mid-copy failure", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("source", "alpha");
  const first = join(ws.shelf_dir("alpha"), "A");
  mkdirSync(first, { recursive: true });
  writeFileSync(join(first, "index.html"), "<!doctype html>\n");
  const library = join(ws.shelf_dir("alpha"), "_lib");
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "draw.mjs"), "export {};\n");

  const outside = join(root, "..", `topic-lib-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "sentinel.txt"), "keep");
  const betaHtml = join(ws.topic_dir("beta"), "html");
  mkdirSync(betaHtml, { recursive: true });
  writeFileSync(join(betaHtml, "keep.txt"), "keep");
  try {
    symlinkSync(outside, join(betaHtml, "_lib"), "dir");
  } catch {
    return;
  }

  assert.throws(() => ws.new_deck("copy", "beta", "default", "source"), StudioError);
  assert.equal(existsSync(ws.deck_dir("copy")), false);
  // The first figure was copied before _lib failed; it must be rolled back.
  assert.equal(existsSync(join(betaHtml, "A")), false);
  assert.equal(readFileSync(join(betaHtml, "keep.txt"), "utf8"), "keep");
  assert.equal(existsSync(join(ws.topic_dir("beta"), "images")), false);
  assert.equal(lstatSync(join(betaHtml, "_lib")).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);

  unlinkSync(join(betaHtml, "_lib"));
  ws.new_deck("copy", "beta", "default", "source");
  assert.equal(existsSync(join(betaHtml, "A", "index.html")), true);
  assert.equal(existsSync(join(betaHtml, "A-2")), false);
  assert.equal(existsSync(join(ws.topic_dir("beta"), "images")), true);
});

test("new_deck removes a new topic folder when copying fails", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("source", "alpha");
  const outside = join(root, "..", `fresh-topic-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "secret.txt"), "secret");
  try {
    symlinkSync(join(outside, "secret.txt"), join(ws.deck_dir("source"), "external.txt"));
  } catch {
    return;
  }

  assert.throws(() => ws.new_deck("bad", "fresh", "default", "source"), StudioError);
  assert.equal(existsSync(ws.deck_dir("bad")), false);
  assert.equal(existsSync(ws.topic_dir("fresh")), false);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret");
});

test("new_deck leaves reused shared topic files untouched", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("source", "alpha");
  const sourceFigure = join(ws.shelf_dir("alpha"), "demo");
  mkdirSync(sourceFigure, { recursive: true });
  writeFileSync(join(sourceFigure, "figure.mjs"), "export default { title: 'Demo' };\n");
  const sourceIndex = "<!doctype html>\n<script type=\"module\" src=\"./figure.mjs\"></script>\n";
  writeFileSync(join(sourceFigure, "index.html"), sourceIndex);

  const betaFigure = join(ws.shelf_dir("beta"), "demo");
  mkdirSync(betaFigure, { recursive: true });
  writeFileSync(join(betaFigure, "figure.mjs"), "export default { title: 'Demo' };\n");
  writeFileSync(join(betaFigure, "index.html"), sourceIndex);
  const before = statSync(join(betaFigure, "index.html"));

  ws.new_deck("copy", "beta", "default", "source");
  const after = statSync(join(betaFigure, "index.html"));
  assert.equal(readFileSync(join(betaFigure, "index.html"), "utf8"), sourceIndex);
  // A rewrite would replace the file through the atomic temp+rename path.
  assert.equal(after.ino, before.ino);
});

test("new_deck reports post-commit auxiliary failures without failing creation", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  const prefs = join(ws.state, "prefs.json");
  rmSync(prefs, { force: true });
  mkdirSync(prefs);

  const directory = ws.new_deck("talk", "alpha");
  assert.equal(directory, ws.deck_dir("talk"));
  assert.equal(existsSync(ws.qmd("talk")), true);
  const warning = ws.migration_preparation().find((item) =>
    String(item.detail).startsWith("設定の保存:")
  );
  assert.equal(typeof warning?.detail, "string");
});

test("new_deck ignores symlinked materials and PDFs like Python copytree", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  ws.new_deck("source", "alpha");
  const outside = join(root, "..", `deck-ignore-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "secret.pdf"), "secret");
  try {
    symlinkSync(outside, join(ws.deck_dir("source"), "materials"), "dir");
    symlinkSync(join(outside, "secret.pdf"), join(ws.deck_dir("source"), "linked.pdf"), "file");
  } catch {
    return;
  }

  ws.new_deck("copy", "beta", "default", "source");
  assert.equal(existsSync(join(ws.deck_dir("copy"), "materials")), false);
  assert.equal(existsSync(join(ws.deck_dir("copy"), "linked.pdf")), false);
  assert.equal(readFileSync(join(outside, "secret.pdf"), "utf8"), "secret");

  ws.new_deck("source2", "alpha");
  mkdirSync(join(ws.deck_dir("source2"), "materials"), { recursive: true });
  writeFileSync(join(ws.deck_dir("source2"), "materials", "large.pdf"), "large");
  try {
    symlinkSync(ws.deck_dir("source2"), join(ws.decks, "source2-link"), "dir");
  } catch {
    return;
  }
  ws.new_deck("copy2", "beta", "default", "source2-link");
  assert.equal(existsSync(join(ws.deck_dir("copy2"), "materials")), false);
});

test("ensure survives symlinked agent, portable and runtime entries", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  const outside = join(root, "..", `ensure-outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  rmSync(join(root, ".claude"), { recursive: true, force: true });
  try {
    symlinkSync(outside, join(root, ".claude"), "dir");
  } catch {
    return;
  }
  assert.doesNotThrow(() => ws.ensure());
  assert.equal(existsSync(join(outside, "skills")), false);

  // Also cover a real .claude whose skills child resolves outside.
  rmSync(join(root, ".claude"), { recursive: true, force: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  symlinkSync(outside, join(root, ".claude", "skills"), "dir");
  assert.doesNotThrow(() => ws.ensure());
  assert.equal(existsSync(join(outside, "skills")), false);

  const readme = join(root, "README.md");
  const outsideReadme = join(outside, "README.md");
  writeFileSync(outsideReadme, "outside readme");
  rmSync(readme, { force: true });
  symlinkSync(outsideReadme, readme);
  assert.doesNotThrow(() => ws.ensure());
  assert.equal(readFileSync(outsideReadme, "utf8"), "outside readme");
  assert.equal(lstatSync(readme).isSymbolicLink(), true);

  rmSync(readme, { force: true });
  mkdirSync(readme);
  assert.doesNotThrow(() => ws.ensure());
  assert.equal(lstatSync(readme).isDirectory(), true);

  const runtimeFile = join(ws.runtime, "figure.mjs");
  const outsideRuntime = join(outside, "figure.mjs");
  writeFileSync(outsideRuntime, "outside runtime");
  rmSync(runtimeFile, { force: true });
  symlinkSync(outsideRuntime, runtimeFile);
  assert.doesNotThrow(() => ws.ensure());
  assert.equal(readFileSync(outsideRuntime, "utf8"), "outside runtime");
  assert.equal(lstatSync(runtimeFile).isSymbolicLink(), false);
  assert.equal(
    readFileSync(runtimeFile, "utf8"),
    readFileSync(join(RUNTIME, "figure.mjs"), "utf8"),
  );
});

test("list_decks skips names that cannot be looked up safely", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  if (process.platform !== "win32") {
    const control = "bad\u0001name";
    const backslash = "bad\\name";
    for (const name of [control, backslash]) {
      mkdirSync(join(ws.decks, name), { recursive: true });
      writeFileSync(
        join(ws.decks, name, "slides.qmd"),
        "---\ntopic: alpha\ntheme: default\n---\n\n## A\n",
      );
    }
    assert.doesNotThrow(() => ws.ensure());
    assert.equal(ws.list_decks().includes(control), false);
    // A backslash is a legal POSIX filename; only Windows treats it as a
    // separator for lookup rejection.
    assert.equal(ws.list_decks().includes(backslash), true);
    assert.equal(ws.deck_shelf(backslash), "alpha");
  } else {
    // Windows treats a stamp key such as ..\x as escaping when joined;
    // #relativeToRoot must drop it instead of aborting the whole ensure.
    const stampPath = join(ws.state, "agent-files.json");
    const stamp = readJson(stampPath);
    stamp["..\\x"] = sha("outside");
    writeJson(stampPath, stamp);
    assert.doesNotThrow(() => ws.ensure());
  }
});

test("preparation messages load canonical strings without set_strings_file from another cwd", async (t) => {
  const root = await scratch(t);
  const ws = Workspace.open(root);
  writeFileSync(join(ws.themes, "default.css"), "/* old */\n");
  mkdirSync(join(root, "figures", "alpha"), { recursive: true });
  writeFileSync(join(root, "figures", "alpha", "figure.mjs"), "export default {};\n");

  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "slide-studio-cwd-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const previous = process.cwd();
  set_strings_file(null);
  process.chdir(temp);
  try {
    const theme = ws.theme_preparation();
    assert.equal(theme[0]?.name, "テーマ default");
    assert.equal(
      theme[0]?.detail,
      "編集済みの旧テーマを保護しました。テーマの型への移行が必要です。",
    );
    assert.equal(
      theme[0]?.fix,
      "themes/default.css を控え、テーマの型にある必須の変数を補ってください。図高や表など発表固有の指定は、その発表の styles/slides.css に移してください。",
    );

    const topic = ws.migration_preparation().find((item) => item.name === "トピックの移行");
    assert.equal(topic?.detail, "figures/ と topics/ が両方あります。自動移行を停止しました。");
    assert.equal(
      topic?.fix,
      "内容を確認して topics/ にまとめ、旧 figures/ を別の場所に保管して再起動してください。",
    );

    // When the build provides the packaged asset, it must be the same source
    // of truth as the canonical module.
    try {
      const packaged = assetPath("strings.js");
      if (existsSync(packaged)) {
        assert.equal(
          sha(readFileSync(packaged)),
          sha(readFileSync(join(repositoryRoot(), "packages", "web", "strings.js"))),
        );
      }
    } catch {
      // Assets are unavailable in an asset-less source test.
    }
  } finally {
    process.chdir(previous);
    set_strings_file(null);
  }
});

test("theme helpers match the original Python golden outputs", async () => {
  const goldenPath = join(repositoryRoot(), "tests", "fixtures", "theme-parity", "golden.json");
  assert.equal(existsSync(goldenPath), true, `missing theme golden fixture: ${goldenPath}`);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
    variables: string[];
    cases: Array<{
      name: string;
      css: string;
      values: Record<string, string>;
      drop: string;
      refresh: string;
      title: string;
      palette: string;
    }>;
  };
  assert.ok(golden.cases.length > 0, "theme golden fixture has no cases");
  for (const item of golden.cases) {
    assert.deepEqual(
      read_vars(item.css, golden.variables),
      item.values,
      `${item.name}: read_vars`,
    );
    assert.equal(
      refresh_heading_options(item.css, golden.variables),
      item.refresh,
      `${item.name}: refresh`,
    );
    assert.equal(
      preserve_title_header(item.css, undefined, golden.variables),
      item.title,
      `${item.name}: title`,
    );
    assert.equal(drop_cover_layout(item.css), item.drop, `${item.name}: drop`);
    assert.equal(
      with_current_palette(item.css, item.values),
      item.palette,
      `${item.name}: palette`,
    );
  }
});
