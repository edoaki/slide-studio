import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  OLD_DEFAULT_THEMES,
  OLD_THEMES,
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
  parseLegacySource,
  recent_roots,
  remember_root,
  runtime_rel,
  saved_root,
  set_front,
  theme_variables,
} from "../../packages/core/src/legacy-workspace.js";

function scratch(t: TestContext): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "slide-studio-legacy-")));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
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
  assert.match(readme, /slide-studio build/u);
  assert.doesNotMatch(readme, /uv run|Python 3/u);
  assert.equal(existsSync(join(root, "build.py")), false);
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

  const parsed = parseLegacySource(source);
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
  for (const value of ["Bad", "with space", "con", "NUL", "a/b", ""]) {
    assert.throws(() => check_name(value), StudioError, value);
  }
  assert.throws(() => Workspace.open("relative-root"), /absolute/u);

  const ws = Workspace.open(root);
  assert.throws(() => ws.figure_dir("../escape/name"), StudioError);
  assert.throws(() => ws.figure_dir("demo/../name"), StudioError);
  assert.throws(() => ws.figure_dir("demo/CON"), StudioError);
  assert.throws(() => ws.deck_meta(".."), StudioError);

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
