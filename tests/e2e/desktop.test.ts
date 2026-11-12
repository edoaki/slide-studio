import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { PDFDocument } from "pdf-lib";

const require = createRequire(import.meta.url);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = findRepositoryRoot(moduleDirectory);
const mainEntry = resolve(repositoryRoot, "dist/apps/desktop/main.js");
const defaultPandoc = resolve(repositoryRoot, "resources/pandoc/bin/pandoc");
let electronPath: unknown;
try {
  electronPath = require("electron");
} catch {
  electronPath = undefined;
}

const TESTIDS = {
  app: "app",
  newTitle: "new-title",
  newDeck: "new-deck",
  deckList: "deck-list",
  sourceEditor: "source-editor",
  save: "save",
  saveStatus: "save-status",
  previewFrame: "preview-frame",
  previewStatus: "preview-status",
  exportHtml: "export-html",
  exportPdf: "export-pdf",
  previousSlide: "previous-slide",
  nextSlide: "next-slide",
  slideSelect: "slide-select",
  selectWorkspace: "select-workspace",
  workspacePath: "workspace-path",
} as const;

function findRepositoryRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(start, "../../..");
}

function testId(id: string): string {
  return `[data-testid="${id}"]`;
}

function locator(page: Page, id: string): Locator {
  return page.locator(testId(id)).first();
}

async function waitForTestId(page: Page, id: string): Promise<Locator> {
  const element = locator(page, id);
  await element.waitFor({ state: "visible", timeout: 20_000 });
  return element;
}

async function waitForStatus(page: Page, id: string, pattern: RegExp): Promise<void> {
  await page.waitForFunction(
    ({ selector, source }) => {
      const element = document.querySelector(selector);
      return new RegExp(source).test(element?.textContent ?? "");
    },
    { selector: testId(id), source: pattern.source },
    { timeout: 30_000 },
  );
}

async function workspaceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function findDeckFile(root: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = (await workspaceFiles(root)).find((file) => file.endsWith(".qmd"));
    if (found !== undefined) return found;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`no .qmd file appeared below ${root}`);
}

async function waitForFileBytes(
  file: string,
  predicate: (bytes: Buffer) => boolean,
  timeoutMs = 20_000,
): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const bytes = await readFile(file);
      if (predicate(bytes)) return bytes;
    } catch {
      // Atomic replacement can briefly remove the old path.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`file did not reach the expected state: ${file}`);
}

async function waitForExport(file: string, kind: "html" | "pdf"): Promise<Buffer> {
  return waitForFileBytes(file, (bytes) => {
    if (bytes.byteLength === 0) return false;
    if (kind === "pdf" && bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error("exported PDF does not start with %PDF-");
    }
    return true;
  }, 240_000);
}

function trackSave(page: Page): Promise<import("playwright-core").Response> {
  return page.waitForResponse((response) => {
    return response.request().method() === "PUT" && response.url().includes("/source");
  }, { timeout: 30_000 });
}

async function triggerSave(page: Page): Promise<void> {
  const button = locator(page, TESTIDS.save);
  // Some UI builds also auto-save after a debounce, which can leave the button
  // disabled by the time input dispatch finishes.
  await page.waitForTimeout(50);
  if (await button.isEnabled()) await button.click();
}

async function createDeck(page: Page, title: string): Promise<void> {
  await waitForTestId(page, TESTIDS.app);
  const titleInput = await waitForTestId(page, TESTIDS.newTitle);
  await titleInput.fill(title);
  await locator(page, TESTIDS.newDeck).click();
  const button = deckButton(page, title);
  await button.waitFor({ state: "visible", timeout: 20_000 });
  await button.click();
  await waitForTestId(page, TESTIDS.sourceEditor);
}

function deckButton(page: Page, title: string): Locator {
  return page.locator("button[data-deck-id]").filter({ hasText: title }).first();
}

async function openDeck(page: Page, title: string): Promise<Locator> {
  const button = deckButton(page, title);
  await button.waitFor({ state: "visible", timeout: 20_000 });
  await button.click();
  return waitForTestId(page, TESTIDS.sourceEditor);
}

function resolvePackagedExecutable(raw: string): string {
  const requested = resolve(raw);
  if (
    process.platform === "darwin"
    && existsSync(requested)
    && requested.endsWith(".app")
    && statSync(requested).isDirectory()
  ) {
    const macos = join(requested, "Contents", "MacOS");
    const entries = readdirSync(macos).filter((name) => !name.startsWith("."));
    const first = entries[0];
    if (first !== undefined) return join(macos, first);
  }
  return requested;
}

function launchEnvironment(
  workspace: string,
  userData: string,
  home: string,
  emptyPath: string,
  pandoc: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  env.HOME = home;
  env.PATH = emptyPath;
  env.SLIDE_STUDIO_ELECTRON_HOME = userData;
  env.SLIDE_STUDIO_HOME = workspace;
  env.SLIDE_STUDIO_PANDOC = pandoc;
  return env;
}

const enabled = process.env.SLIDE_STUDIO_DESKTOP_E2E === "1";
const testAppSetting = process.env.SLIDE_STUDIO_TEST_APP;
const packagedMode = testAppSetting !== undefined && testAppSetting.length > 0;
const packagedApp = packagedMode ? resolvePackagedExecutable(testAppSetting as string) : undefined;
const configuredPandoc = process.env.SLIDE_STUDIO_PANDOC;
const devPandoc = configuredPandoc !== undefined && configuredPandoc.length > 0
  ? configuredPandoc
  : defaultPandoc;
const skipReason = !enabled
  ? "set SLIDE_STUDIO_DESKTOP_E2E=1 to run the desktop E2E"
  : packagedMode
    ? packagedApp === undefined || !existsSync(packagedApp) || !statSync(packagedApp).isFile()
      ? `SLIDE_STUDIO_TEST_APP does not exist: ${packagedApp ?? ""}`
      : false
    : typeof electronPath !== "string"
      ? "the local Electron executable is unavailable"
      : !existsSync(mainEntry)
        ? "dist/apps/desktop/main.js is missing; run npm run build"
        : !existsSync(devPandoc)
          ? `Pandoc is missing at ${devPandoc}; run npm run setup:pandoc`
          : false;

test("desktop slice: create, edit, preview, save, reopen, export", { skip: skipReason }, async (t: TestContext) => {
  const scratch = await mkdtemp(join(tmpdir(), "slide-studio-e2e-"));
  const workspace = join(scratch, "workspace");
  const userData = join(scratch, "user-data");
  const home = join(scratch, "home");
  const emptyPath = join(scratch, "empty-path");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(emptyPath, { recursive: true }),
  ]);

  const title = "デスクトップ試験";
  const secondTitle = "二つ目のデッキ";
  const source = `---\ntitle: "${title}"\n---\n\n## 一枚目\n\n- 一つ目\n- 二つ目\n\n## 二枚目\n\n本文\n`;
  const htmlPath = join(scratch, "export.html");
  const pdfPath = join(scratch, "export.pdf");
  const artifactDirectory = process.env.SLIDE_STUDIO_TEST_ARTIFACTS;
  const screenshotPath = artifactDirectory !== undefined && artifactDirectory.length > 0
    ? join(artifactDirectory, `slide-studio-${packagedMode ? "packaged" : "dev"}-${process.pid}.png`)
    : join(tmpdir(), `slide-studio-desktop-e2e-${process.pid}.png`);
  await mkdir(dirname(screenshotPath), { recursive: true });

  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let applicationClosed = false;

  t.after(async () => {
    if (page !== undefined) {
      const failureShot = screenshotPath.replace(/\.png$/i, "-failure.png");
      await page.screenshot({ path: failureShot, fullPage: true }).catch(() => {});
    }
    if (artifactDirectory !== undefined && artifactDirectory.length > 0) {
      const suffix = packagedMode ? "packaged" : "dev";
      if (existsSync(htmlPath)) {
        await copyFile(htmlPath, join(artifactDirectory, `slide-studio-${suffix}-export.html`)).catch(() => {});
      }
      if (existsSync(pdfPath)) {
        await copyFile(pdfPath, join(artifactDirectory, `slide-studio-${suffix}-export.pdf`)).catch(() => {});
      }
    }
    if (application !== undefined && !applicationClosed) {
      try {
        await application.evaluate(({ app }) => app.exit(0));
      } catch {
        // The process may already be gone.
      }
      try {
        await application.close();
      } catch {
        // Closing an already closed app is fine.
      }
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // In packaged mode an explicit Pandoc override is deliberately wrong. A
  // packaged host must ignore it and use resources/pandoc/bin instead.
  const launchPandoc = packagedMode ? join(scratch, "ignored-pandoc") : devPandoc;
  const env = launchEnvironment(workspace, userData, home, emptyPath, launchPandoc);
  const common = { env, timeout: 60_000 };
  const launchOptions = packagedMode
    ? {
      ...common,
      executablePath: packagedApp as string,
      args: [] as string[],
      cwd: dirname(packagedApp as string),
    }
    : {
      ...common,
      executablePath: electronPath as string,
      args: [mainEntry],
      cwd: repositoryRoot,
    };
  application = await electron.launch(launchOptions);
  application.on("close", () => {
    applicationClosed = true;
  });

  const runtime = await application.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string })?.resourcesPath ?? "",
  }));
  assert.equal(runtime.isPackaged, packagedMode, "app.isPackaged must match the launched mode");
  if (process.platform === "darwin") {
    const roles = await application.evaluate(({ Menu }) => {
      const found: string[] = [];
      const visit = (items: any[]): void => {
        for (const item of items) {
          if (typeof item.role === "string") found.push(item.role);
          if (item.submenu != null) visit(item.submenu.items);
        }
      };
      visit(Menu.getApplicationMenu()?.items ?? []);
      return found;
    });
    for (const role of ["copy", "paste", "undo", "quit"]) {
      assert.ok(roles.includes(role), `application menu must include ${role}`);
    }
    assert.equal(roles.includes("reload"), false, "application menu must not add reload");
  }
  if (packagedMode) {
    const binary = process.platform === "win32" ? "pandoc.exe" : "pandoc";
    assert.ok(
      existsSync(join(runtime.resourcesPath, "pandoc", "bin", binary)),
      "packaged app must ship resources/pandoc/bin",
    );
  }

  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await createDeck(page, title);
  let editor = await waitForTestId(page, TESTIDS.sourceEditor);
  const initialSave = trackSave(page);
  await editor.fill(source);
  await triggerSave(page);
  assert.ok((await initialSave).ok(), "initial save should succeed");
  const deckFile = await findDeckFile(workspace);
  await waitForFileBytes(deckFile, (bytes) => bytes.toString("utf8").includes("二枚目"));

  const previewFrame = await waitForTestId(page, TESTIDS.previewFrame);
  const previewHandle = await previewFrame.elementHandle();
  assert.notEqual(previewHandle, null);
  const preview = await previewHandle!.contentFrame();
  assert.notEqual(preview, null);
  await preview!.locator("body").waitFor({ state: "attached", timeout: 30_000 });
  const activeHeading = preview!.locator(".slide.active h1, .slide.active h2").filter({ hasText: "一枚目" }).first();
  await activeHeading.waitFor({ state: "visible", timeout: 30_000 });
  await waitForTestId(page, TESTIDS.previewStatus);
  await waitForTestId(page, TESTIDS.previousSlide);
  await waitForTestId(page, TESTIDS.slideSelect);
  await waitForTestId(page, TESTIDS.selectWorkspace);
  await waitForTestId(page, TESTIDS.workspacePath);

  // The content bridge and controls must navigate the preview.
  const nextSlide = locator(page, TESTIDS.nextSlide);
  await page.waitForFunction(
    (selector) => !(document.querySelector(selector) as HTMLButtonElement | null)?.disabled,
    testId(TESTIDS.nextSlide),
    { timeout: 30_000 },
  );
  const slideSelect = locator(page, TESTIDS.slideSelect);
  const firstSlideValue = await slideSelect.inputValue();
  await nextSlide.click();
  await page.waitForFunction(
    ({ selector, previous }) => {
      const element = document.querySelector(selector) as HTMLSelectElement | null;
      return element !== null && element.value !== previous;
    },
    { selector: testId(TESTIDS.slideSelect), previous: firstSlideValue },
    { timeout: 30_000 },
  );

  // Deck content is isolated: a preview script cannot call the admin API.
  const adminOrigin = new URL(page.url()).origin;
  const adminApiResult = await preview!.evaluate(async (origin) => {
    try {
      const response = await fetch(`${origin}/api/workspace`, {
        headers: { "X-Studio-Token": "stolen" },
      });
      return response.status;
    } catch {
      return "blocked";
    }
  }, adminOrigin);
  assert.notEqual(adminApiResult, 200);

  // Reopen by switching decks and verify the saved source is read back.
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await createDeck(page, secondTitle);
  editor = await openDeck(page, title);
  assert.match(await editor.inputValue(), /二枚目/);

  // A CRLF file keeps its EOL style when the textarea is saved with an edit.
  const crlfSource = (await readFile(deckFile, "utf8")).replace(/\n/g, "\r\n");
  await writeFile(deckFile, crlfSource, "utf8");
  await openDeck(page, secondTitle);
  editor = await openDeck(page, title);
  const crlfSave = trackSave(page);
  await editor.fill(`${source}\nCRLF追加\n`);
  await triggerSave(page);
  assert.ok((await crlfSave).ok(), "CRLF save should succeed");
  const afterCrlfSave = await waitForFileBytes(
    deckFile,
    (bytes) => {
      const text = bytes.toString("utf8");
      return text.includes("CRLF追加") && text.includes("\r\n");
    },
  );
  assert.match(afterCrlfSave.toString("utf8"), /\r\n/);

  // An external edit must win: the stale editor save gets a conflict and the
  // file on disk is not overwritten.
  const external = `${source}\n外部で追加\n`;
  await writeFile(deckFile, external, "utf8");
  const conflictResponse = trackSave(page);
  await editor.fill(`${source}\nエディターで追加\n`);
  await triggerSave(page);
  assert.equal((await conflictResponse).status(), 409);
  await waitForStatus(page, TESTIDS.saveStatus, /競合|409|CONFLICT|保存(?:できません|に失敗)/);
  assert.match(await readFile(deckFile, "utf8"), /外部で追加/);
  assert.doesNotMatch(await readFile(deckFile, "utf8"), /エディターで追加/);

  // Reopen the externally edited file before exporting so the export starts from
  // the on-disk version rather than the conflicted editor buffer.
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await openDeck(page, secondTitle);
  editor = await openDeck(page, title);
  assert.match(await editor.inputValue(), /外部で追加/);

  await application.evaluate(async ({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, htmlPath);
  await locator(page, TESTIDS.exportHtml).click();
  const html = (await waitForExport(htmlPath, "html")).toString("utf8");
  assert.match(html, /<!doctype html/i);
  assert.doesNotMatch(html, /slide-studio:go/);

  await application.evaluate(async ({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, pdfPath);
  await locator(page, TESTIDS.exportPdf).click();
  const pdfBytes = await waitForExport(pdfPath, "pdf");
  const pdf = await PDFDocument.load(pdfBytes);
  assert.ok(pdf.getPageCount() > 0);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  t.diagnostic(`screenshot: ${screenshotPath}`);

  // Dirty close: cancel first, then allow the page to unload.
  await editor.fill(`${source}\n未保存\n`);
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 1;
  });
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.ok((await application.windows()).length > 0, "the window stayed open after cancel");

  const closed = application.waitForEvent("close", { timeout: 15_000 });
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await closed;
  applicationClosed = true;

  // Relaunching on the same root proves the workspace lock was released.
  const relaunched = await electron.launch(launchOptions);
  try {
    const relaunchedPage = await relaunched.firstWindow();
    await relaunchedPage.waitForLoadState("domcontentloaded");
    await waitForTestId(relaunchedPage, TESTIDS.app);
  } finally {
    const relaunchedClosed = relaunched.waitForEvent("close", { timeout: 15_000 }).catch(() => undefined);
    try {
      await relaunched.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close();
      });
    } catch {
      // The process may already be gone.
    }
    await relaunchedClosed;
    try {
      await relaunched.close();
    } catch {
      // Closing an already closed app is fine.
    }
  }
});
