import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync, statSync, readFileSync, type Stats } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, lstat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  protocol,
  session,
  shell,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
  type Session,
} from "electron";
import type {
  CoreErrorCode,
  PreviewDocument,
} from "../../packages/contracts/src/desktop.js";
import type { LegacyExportDocumentInput } from "../server/legacy.js";
import { close_pandoc } from "../../packages/core/src/legacy-pandoc.js";
import { render_text } from "../../packages/core/src/legacy-render.js";
import { default_root } from "../../packages/core/src/legacy-workspace.js";
import { argumentsOf, runCommand, throughBridge, earlyCommand } from "../cli/commands.js";
import { prepareLauncher } from "../cli/launcher.js";
import { atomicWriteFile } from "../../packages/renderer/src/output.js";
import { atomicWriteFile as privateWrite } from "../../packages/core/src/atomic.js";
import { STUDIO_RENDER_SCHEME } from "../../packages/renderer/src/protocol.js";
import {
  startLegacyHost,
  type LegacyDiagnosticItem,
  type LegacyHost,
  type LegacyWorkspace,
} from "../server/legacy.js";
import {
  openLegacyWorkspace,
  type LegacyWorkspaceService,
} from "../server/legacy-workspace-service.js";

type ExportFormat = "html" | "pdf";

interface CodedError extends Error {
  code: CoreErrorCode;
}

/*
 * Native main-process labels are centralized here. Renderer labels live in
 * packages/web/strings.js; dialogs owned by Electron cannot import that module.
 */
const MAIN_STRINGS = Object.freeze({
  unsavedTitle: "未保存の変更",
  unsavedMessage: "保存していない変更があります。",
  unsavedDetail: "変更を破棄して閉じますか？",
  close: "閉じる",
  cancel: "キャンセル",
  exportHtml: "HTMLを書き出す",
  exportPdf: "PDFを書き出す（試験的）",
  chooseWorkspace: "保管フォルダを選ぶ",
  startupError: "Slide Studio を起動できません",
  pandocMissing: (path: string) =>
    `Pandoc が見つかりません: ${path}。「npm run setup:pandoc」を実行してください。`,
  pdfTimeout: (ms: number) => `PDF出力が ${ms}ms でタイムアウトしました`,
});

let mainWindow: BrowserWindow | undefined;
let desktopHost: LegacyHost | undefined;
let workspaceService: LegacyWorkspaceService | undefined;
let pendingWorkspaceService: LegacyWorkspaceService | undefined;
let workspace: LegacyWorkspace | undefined;
let appPath = "";
let uiDirectory = "";
let pandocPath = "";
let hiddenWindow = false;
let shuttingDown = false;
let forceQuit = false;
let pdfTail: Promise<void> = Promise.resolve();
let activePdfDeadline: { abort(reason: string): void; dispose(): void } | undefined;
let pdfTemporaryRoot = "";
let credentialToken = "";
let adminOriginValue = "";
let bootstrapUrl = "";
let uiSession: Session | undefined;
const allowedOrigins = new Set<string>();

function codedError(code: CoreErrorCode, message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

function argumentValue(argv: string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === flag) {
      const value = argv[index + 1];
      return value === undefined || value.startsWith("--") ? undefined : value;
    }
    if (argument?.startsWith(`${flag}=`)) {
      const value = argument.slice(flag.length + 1);
      return value.length === 0 ? undefined : value;
    }
  }
  return undefined;
}

/** In source runs Electron may report the script directory; find the repo root from it. */
function resolveSourceRoot(appDirectory: string): string {
  let candidate = appDirectory;
  for (let depth = 0; depth < 5; depth++) {
    if (existsSync(join(candidate, "dist", "packages", "web", "app.html"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return appDirectory;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function installApplicationMenu(): void {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

async function sweepPdfTemporaryDirectories(): Promise<void> {
  try {
    const entries = await readdir(pdfTemporaryRoot, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("slide-studio-pdf-"))
      .map((entry) => rm(join(pdfTemporaryRoot, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })));
  } catch (error) {
    console.error("[desktop] cannot sweep temporary PDF directories", error);
  }
}

function resolveWorkspaceRoot(userData: string): { root: string; sample: boolean } {
  const argv = process.argv.slice(1);
  const requested = argumentValue(argv, "root") ?? process.env.SLIDE_STUDIO_HOME;
  if (requested !== undefined && requested.trim().length > 0) {
    if (!isAbsolute(requested)) {
      throw codedError("INVALID_INPUT", "--root/SLIDE_STUDIO_HOME must be an absolute path");
    }
    let stat: Stats;
    try {
      stat = statSync(requested);
    } catch {
      throw codedError("INVALID_INPUT", `workspace folder does not exist: ${requested}`);
    }
    if (!stat.isDirectory()) {
      throw codedError("INVALID_INPUT", `workspace path is not a directory: ${requested}`);
    }
    return { root: requested, sample: false };
  }
  const saved=readWorkspaceLocations().current;
  if(saved && existsSync(saved) && statSync(saved).isDirectory()) return {root:saved,sample:false};
  const root = join(userData, "trial-workspace");
  mkdirSync(root, { recursive: true });
  return { root, sample: true };
}

function resolvePandocPath(): string {
  const binary = process.platform === "win32" ? "pandoc.exe" : "pandoc";
  if (app.isPackaged) {
    // Packaged builds always use the verified binary staged by electron-builder.
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resources === undefined) {
      throw codedError("INVALID_INPUT", "Electron resources path is unavailable");
    }
    return join(resources, "pandoc", "bin", binary);
  }
  const explicit = process.env.SLIDE_STUDIO_PANDOC;
  if (explicit !== undefined && explicit.length > 0) {
    if (!isAbsolute(explicit)) {
      throw codedError("INVALID_INPUT", "SLIDE_STUDIO_PANDOC must be an absolute path");
    }
    return explicit;
  }
  return join(appPath, "resources", "pandoc", "bin", binary);
}

function assertPandocAvailable(): void {
  let stat: Stats;
  try {
    stat = statSync(pandocPath);
  } catch {
    throw codedError("INVALID_INPUT", MAIN_STRINGS.pandocMissing(pandocPath));
  }
  if (!stat.isFile()) throw codedError("INVALID_INPUT", "Pandoc path is not a file");
}

function isLoopbackOrInternal(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (["about:", "data:", "blob:", "devtools:"].includes(url.protocol)) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "::1"
    || url.hostname === "[::1]";
}

function navigationUrl(args: unknown[]): string | undefined {
  for (const value of args) {
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object" && "url" in value) {
      const url = (value as { url?: unknown }).url;
      if (typeof url === "string") return url;
    }
  }
  return undefined;
}

function redactCredential(text: string): string {
  return credentialToken.length === 0 ? text : text.replaceAll(credentialToken, "[redacted]");
}

function originAllowed(raw: string): boolean {
  try {
    return allowedOrigins.has(new URL(raw).origin);
  } catch {
    return false;
  }
}

function mainNavigationAllowed(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  if (raw === "about:blank") return true;
  return adminOriginValue.length > 0 && originAllowed(raw) && new URL(raw).origin === adminOriginValue;
}

function frameNavigationAllowed(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  if (raw === "about:blank" || raw === "about:srcdoc" || raw.startsWith("about:srcdoc:")) return true;
  const lower = raw.toLowerCase();
  if (lower.startsWith("data:") || lower.startsWith("blob:")) return true;
  return originAllowed(raw);
}

function waitForPdfQueue(): Promise<void> {
  return pdfTail;
}

function enqueuePdf<T>(task: () => Promise<T>): Promise<T> {
  const result = pdfTail.then(task, task);
  pdfTail = result.then(() => undefined, () => undefined);
  return result;
}

function safeFileStem(title: string): string {
  const value = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  return value.length === 0 ? "slides" : value;
}

function applySessionPolicy(target: Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  target.setPermissionCheckHandler(() => false);
  target.on("will-download", (event, item, contents) => {
    // Only authenticated admin UI creates these local export blobs.
    const trusted = mainWindow && contents === mainWindow.webContents && desktopHost
      && item.getURL().startsWith(`blob:${desktopHost.adminOrigin}/`);
    if (!trusted) event.preventDefault();
  });
  target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: !isLoopbackOrInternal(details.url) });
  });
}

function installSessionPolicy(): void {
  uiSession = session.fromPartition("slide-studio-ui", { cache: false });
  applySessionPolicy(uiSession);
  applySessionPolicy(session.defaultSession);
}

function installWindowPolicy(window: BrowserWindow): void {
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    console.error(`[desktop] blocked window.open: ${redactCredential(url)}`);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();
    const reload = key === "f5" || ((input.control || input.meta) && key === "r");
    if (reload && !shuttingDown) {
      // Reload goes through Chromium's unload path, so the legacy UI's
      // beforeunload guard still asks about unsaved changes. The admin token
      // lives in per-origin sessionStorage; the current path must be kept.
      event.preventDefault();
      contents.reload();
    }
  });
  contents.on("will-navigate", (...args: unknown[]) => {
    const raw = navigationUrl(args);
    const event = args.find(
      (value) => value !== null && typeof value === "object" && "preventDefault" in value,
    ) as { preventDefault?: () => void } | undefined;
    if (!mainNavigationAllowed(raw)) {
      event?.preventDefault?.();
      console.error(`[desktop] blocked navigation: ${redactCredential(raw ?? "<unknown>")}`);
    }
  });
  contents.on("will-redirect", (...args: unknown[]) => {
    const raw = navigationUrl(args);
    if (!mainNavigationAllowed(raw)) {
      const event = args.find(
        (value) => value !== null && typeof value === "object" && "preventDefault" in value,
      ) as { preventDefault?: () => void } | undefined;
      event?.preventDefault?.();
      console.error(`[desktop] blocked redirect: ${redactCredential(raw ?? "<unknown>")}`);
    }
  });
  contents.on("will-frame-navigate", (...args: unknown[]) => {
    const raw = navigationUrl(args);
    if (!frameNavigationAllowed(raw)) {
      const event = args.find(
        (value) => value !== null && typeof value === "object" && "preventDefault" in value,
      ) as { preventDefault?: () => void } | undefined;
      event?.preventDefault?.();
      console.error(`[desktop] blocked frame navigation: ${redactCredential(raw ?? "<unknown>")}`);
    }
  });
  contents.on("render-process-gone", () => {
    console.error("[desktop] renderer process gone; reloading the admin UI");
    if (shuttingDown) return;
    setTimeout(() => {
      if (shuttingDown || mainWindow === undefined || mainWindow.isDestroyed()) return;
      const target = mainWindow.webContents.getURL();
      // Keep the current admin route; the per-origin sessionStorage token makes
      // a root bootstrap unnecessary after the initial launch.
      if (mainNavigationAllowed(target)) void mainWindow.loadURL(target);
      else void mainWindow.loadURL(bootstrapUrl);
    }, 250);
  });

  contents.on("will-prevent-unload", (event) => {
    const response = dialog.showMessageBoxSync(window, {
      type: "warning",
      buttons: [MAIN_STRINGS.close, MAIN_STRINGS.cancel],
      defaultId: 1,
      cancelId: 1,
      title: MAIN_STRINGS.unsavedTitle,
      message: MAIN_STRINGS.unsavedMessage,
      detail: MAIN_STRINGS.unsavedDetail,
    });
    // Calling preventDefault() ignores beforeunload and lets the page unload.
    if (response === 0) event.preventDefault();
  });
}

function createMainWindow(adminOrigin: string, token: string, deck?: string): void {
  credentialToken = token;
  bootstrapUrl = `${adminOrigin}${deck ? '/deck/' + encodeURIComponent(deck) : '/'}#token=${encodeURIComponent(token)}`;
  mainWindow = new BrowserWindow({
    show: !hiddenWindow,
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Slide Studio",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      session: uiSession!,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  installWindowPolicy(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
    void shutdown(0);
  });
  // The fragment carries the per-launch credential; it is never sent over HTTP.
  void mainWindow.loadURL(bootstrapUrl).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message.replaceAll(token, "[redacted]") : "unknown error";
    console.error(`[desktop] cannot load the admin UI: ${detail}`);
  });
}

function defaultExportDirectory(): string {
  try {
    return app.getPath("documents");
  } catch {
    try {
      return app.getPath("home");
    } catch {
      return tmpdir();
    }
  }
}

function showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  return mainWindow === undefined || mainWindow.isDestroyed()
    ? dialog.showSaveDialog(options)
    : dialog.showSaveDialog(mainWindow as BrowserWindow, options);
}

function showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  return mainWindow === undefined || mainWindow.isDestroyed()
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(mainWindow as BrowserWindow, options);
}

function outputWriteError(error: unknown): CodedError {
  const message = error instanceof Error ? error.message : String(error);
  return codedError("READ_ONLY", `出力先に書き込めません: ${message}`);
}

async function writeOutput(filePath: string, data: string | Uint8Array): Promise<void> {
  try {
    await atomicWriteFile(filePath, data);
  } catch (error) {
    throw outputWriteError(error);
  }
}

async function exportDocument(
  document: PreviewDocument,
  format: ExportFormat,
  title: string,
): Promise<string | null> {
  const extension = format === "html" ? ".html" : ".pdf";
  const result = await showSaveDialog({
    title: format === "html" ? MAIN_STRINGS.exportHtml : MAIN_STRINGS.exportPdf,
    defaultPath: join(defaultExportDirectory(), `${safeFileStem(title)}${extension}`),
    filters: format === "html"
      ? [{ name: "HTML", extensions: ["html"] }]
      : [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (result.canceled || result.filePath === undefined || result.filePath.length === 0) {
    return null;
  }
  if (shuttingDown) return null;
  if (format === "html") {
    await writeOutput(result.filePath, document.html);
    return basename(result.filePath);
  }
  return enqueuePdf(async () => {
    if (shuttingDown) return null;
    return writePdf(document, result.filePath!);
  });
}

/** Adapt the legacy export input to the existing PDF/HTML writer. */
function exportLegacyDocument(
  input: LegacyExportDocumentInput,
  format: ExportFormat,
  title: string,
): Promise<string | null> {
  const rendered = input.rendered;
  const document: PreviewDocument = {
    html: input.html,
    version: input.version,
    slides: rendered?.slides ?? [],
    warnings: (rendered?.warnings ?? []).map((message) => ({
      code: "PANDOC",
      severity: "warning",
      message,
    })),
  };
  return exportDocument(document, format, title);
}

function safeExternalUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "http:"
    && parsed.protocol !== "https:"
    && parsed.protocol !== "mailto:"
  ) {
    return false;
  }
  if (/[\u0000-\u001f]/u.test(raw)) return false;
  return parsed.protocol === "mailto:"
    ? parsed.pathname.trim().length > 0
    : parsed.hostname.length > 0;
}

async function openExternalUrl(raw: string): Promise<boolean> {
  if (!safeExternalUrl(raw)) return false;
  await shell.openExternal(raw);
  return true;
}

function legacyDiagnostics(): LegacyDiagnosticItem[] {
  let pandocOk = false;
  let pandocDetail = "";
  try {
    pandocOk = statSync(pandocPath).isFile();
    pandocDetail = pandocOk ? pandocPath : `not a file: ${pandocPath}`;
  } catch (error) {
    pandocDetail = error instanceof Error ? error.message : String(error);
  }
  const chromium = typeof process.versions.chrome === "string" ? process.versions.chrome : "";
  return [
    {
      name: "Pandoc",
      ok: pandocOk,
      detail: pandocDetail,
      fix: MAIN_STRINGS.pandocMissing(pandocPath),
    },
    {
      name: "Chromium",
      ok: chromium.length > 0,
      detail: chromium.length > 0 ? `Electron Chromium ${chromium}` : "Chromium is unavailable",
      fix: "",
    },
  ];
}

async function inspectLegacy(html: string, options: { pdf: boolean; screenshots: boolean; allSteps: boolean }) {
  return enqueuePdf(async () => {
    const [{ parseRenderJob }, { renderDeck }, { JobDeadline }] = await Promise.all([
      import('../../packages/renderer/src/job.js'), import('../../packages/renderer/src/render.js'), import('../../packages/renderer/src/deadline.js'),
    ]);
    const temporary = await mkdtemp(join(tmpdir(), 'slide-studio-inspect-'));
    const deadline = new JobDeadline(180000, '描画が時間内に完了しませんでした');
    activePdfDeadline = deadline;
    try {
      const inputHtml = join(temporary, 'input.html'), outputDir = join(temporary, 'output');
      await writeOutput(inputHtml, html);
      const result = await renderDeck(parseRenderJob({ schemaVersion: 1, inputHtml, outputDir, timeoutMs: 180000, ...options }), outputDir, deadline);
      const screenshots = await Promise.all(result.steps.filter(s => s.screenshot).map(async s => ({ slide: s.slide, step: s.step, bytes: await readFile(join(outputDir, s.screenshot!)) })));
      return { slides: result.slides, steps: result.steps, screenshots, ...(options.pdf ? { pdf: await readFile(join(outputDir, result.pdfFile)) } : {}) };
    } finally {
      if (activePdfDeadline === deadline) activePdfDeadline = undefined;
      deadline.dispose(); await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}

async function writePdf(document: PreviewDocument, filePath: string): Promise<string> {
  const [{ parseRenderJob }, { renderDeck, RenderFailure }, { JobDeadline }] = await Promise.all([
    import("../../packages/renderer/src/job.js"),
    import("../../packages/renderer/src/render.js"),
    import("../../packages/renderer/src/deadline.js"),
  ]);
  if (pdfTemporaryRoot.length === 0) {
    pdfTemporaryRoot = join(app.getPath("userData"), "tmp");
  }
  await mkdir(pdfTemporaryRoot, { recursive: true });
  const temporary = await mkdtemp(join(pdfTemporaryRoot, "slide-studio-pdf-"));
  const timeoutMs = 180_000;
  const deadline = new JobDeadline(timeoutMs, MAIN_STRINGS.pdfTimeout(timeoutMs));
  activePdfDeadline = deadline;
  try {
    const inputHtml = join(temporary, "input.html");
    const outputDir = join(temporary, "output");
    await writeOutput(inputHtml, document.html);
    const job = parseRenderJob({
      schemaVersion: 1,
      inputHtml,
      outputDir,
      timeoutMs,
      screenshots: false,
    });
    const result = await renderDeck(job, outputDir, deadline);
    const pdf = await readFile(join(outputDir, result.pdfFile));
    await writeOutput(filePath, pdf);
    return basename(filePath);
  } catch (error) {
    if (deadline.aborted) {
      throw codedError("RENDER_TIMEOUT", deadline.reason.message);
    }
    if (error instanceof RenderFailure) {
      throw codedError("RENDER_FAILED", error.message);
    }
    throw error;
  } finally {
    if (activePdfDeadline === deadline) activePdfDeadline = undefined;
    deadline.dispose();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      (error: unknown) => {
        console.error("[desktop] cannot remove the temporary PDF files", error);
      },
    );
  }
}

function readWorkspaceLocations(): {current:string|null;recent:string[]} {
  try {
    const value=JSON.parse(readFileSync(join(app.getPath("userData"),"workspaces.json"),"utf8"));
    const recent=Array.isArray(value.recent) ? value.recent.filter((p:unknown):p is string=>typeof p==="string"&&isAbsolute(p)).slice(0,12) : [];
    return {current:typeof value.current==="string"&&isAbsolute(value.current)?value.current:null,recent};
  } catch {return {current:null,recent:[]};}
}
async function chooseWorkspacePath(input:string,mode:"new"|"existing"):Promise<LegacyWorkspace> {
  const selected=input==="~"?homedir():input.startsWith("~/")?join(homedir(),input.slice(2)):input;
  if(!selected.trim()||!isAbsolute(selected))throw codedError("INVALID_INPUT","保管場所を絶対パスで指定してください");
  const info=await lstat(selected).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  if(mode==="new"){
    if(info)throw codedError("INVALID_INPUT","同じ名前のフォルダがあります。既存フォルダを選ぶか、名前を変えてください");
    await mkdir(dirname(selected),{recursive:true});await mkdir(selected,{mode:0o700});
  } else {
    if(!info || !(await stat(selected)).isDirectory())throw codedError("INVALID_INPUT","既存のフォルダを選んでください");
    const names=await readdir(selected);
    const directory=async(name:string)=>(await stat(join(selected,name)).catch(()=>null))?.isDirectory();
    if(names.length && !(await directory('decks') && (await directory('topics') || await directory('figures'))))throw codedError("INVALID_INPUT","空のフォルダか、スライドの保管フォルダを選んでください");
  }
  return prepareWorkspace(selected);
}
async function selectWorkspace(): Promise<LegacyWorkspace | null> {
  const result = await showOpenDialog({
    title: MAIN_STRINGS.chooseWorkspace,
    properties: ["openDirectory", "createDirectory"],
  });
  const selected = result.filePaths[0];
  if (result.canceled || selected === undefined || selected.length === 0) return null;
  if (shuttingDown) return null;
  return chooseWorkspacePath(selected,"existing");
}
async function prepareWorkspace(selected:string):Promise<LegacyWorkspace> {

  if (
    workspaceService !== undefined
    && canonicalPath(selected) === canonicalPath(workspaceService.root)
  ) {
    return workspaceService.workspace;
  }
  const next = await openLegacyWorkspace(selected);
  if (shuttingDown) {
    await next.close().catch((error: unknown) => {
      console.error("[desktop] cannot close a workspace opened during shutdown", error);
    });
    throw codedError("INVALID_INPUT", "アプリを終了しています");
  }
  if (pendingWorkspaceService !== undefined) {
    await pendingWorkspaceService.close().catch((error: unknown) => {
      console.error("[desktop] cannot close an uncommitted workspace", error);
    });
  }
  // Ownership transfer is completed by onWorkspaceChanged after the host has
  // committed this workspace and rejected other in-flight operations.
  pendingWorkspaceService = next;
  return next.workspace;
}

async function legacyWorkspaceChanged(
  next: LegacyWorkspace,
  previous: LegacyWorkspace,
): Promise<void> {
  const pending = pendingWorkspaceService;
  workspace = next;
  if (pending === undefined || pending.workspace !== next) {
    console.error("[desktop] host selected an unknown workspace; old lock was not released");
    return;
  }
  pendingWorkspaceService = undefined;
  const old = workspaceService;
  workspaceService = pending;
  const recent=[...new Set([next.root,previous.root,...readWorkspaceLocations().recent])].slice(0,12);
  if (old !== undefined && old.workspace === previous && old !== pending) {
    try {
      await old.close();
    } catch (error) {
      console.error("[desktop] cannot release the previous workspace lock", error);
    }
  }
  await atomicWriteFile(join(app.getPath("userData"),"workspaces.json"),JSON.stringify({current:next.root,recent}));

}

async function start(): Promise<void> {
  try {
    const cli = cliMode ? argumentsOf(process.argv.slice(process.argv.indexOf("--studio-cli") + 1)) : null;
    if (cli && earlyCommand(cli)) { await shutdown(0); return; }
    if (cli) {
      const root = cli.values.root ?? default_root();
      process.env.SLIDE_STUDIO_HOME = resolve(root.startsWith("~/") ? join(homedir(), root.slice(2)) : root);
      const bridged = await throughBridge(process.env.SLIDE_STUDIO_HOME, cli);
      if (bridged !== null) { await shutdown(bridged); return; }
      if (["new", "import", "fig"].includes(cli.positionals[0] ?? "")) mkdirSync(process.env.SLIDE_STUDIO_HOME, {recursive: true});
    }
    appPath = app.isPackaged ? app.getAppPath() : resolveSourceRoot(app.getAppPath());
    uiDirectory = join(appPath, "dist", "packages", "web");
    pdfTemporaryRoot = join(app.getPath("userData"), "tmp");
    mkdirSync(pdfTemporaryRoot, { recursive: true });
    await sweepPdfTemporaryDirectories();
    const userData = app.getPath("userData");
    const requested = resolveWorkspaceRoot(userData);
    pandocPath = resolvePandocPath();
    assertPandocAvailable();
    if (!cliMode) process.env.SLIDE_STUDIO_CLI_BIN = await prepareLauncher(join(userData, "bin"), process.execPath, app.isPackaged ? undefined : join(appPath, "dist/apps/desktop/main.js"));

    workspaceService = await openLegacyWorkspace(requested.root, {
      sample: requested.sample,
    });
    workspace = workspaceService.workspace;
    if (cli && cli.positionals[0] && cli.positionals[0] !== "open") {
      const code = await runCommand(workspaceService.workspace, cli, {pandocPath, inspect: inspectLegacy, diagnostics: async () => legacyDiagnostics()});
      await shutdown(code); return;
    }
    if (shuttingDown) {
      await workspaceService.close();
      workspaceService = undefined;
      workspace = undefined;
      app.exit(0);
      return;
    }

    desktopHost = await startLegacyHost({
      workspace: workspaceService.workspace,
      uiDirectory,
      pandocPath,
      renderText: render_text,
      selectWorkspace,
      openWorkspace:chooseWorkspacePath,
      recentWorkspaces:()=>readWorkspaceLocations().recent,
      onWorkspaceChanged: legacyWorkspaceChanged,
      openExternal: openExternalUrl,
      openPath: async path => {
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
      },
      exportDocument: exportLegacyDocument,
      inspect: inspectLegacy,
      aiStorage: join(app.getPath("userData"), "ai"),
      adminPort: browserMode ? Number(argumentValue(process.argv, "port") ?? 4320) : undefined,
      diagnostics: legacyDiagnostics,
      onShutdown: async () => {
        // Accepted host operations have settled by now. Cancel any remaining
        // Pandoc subprocess and wait for the desktop PDF queue before the
        // workspace lock is released.
        await close_pandoc();
        await waitForPdfQueue();
      },
    });
    if (shuttingDown) {
      await desktopHost.close();
      desktopHost = undefined;
      app.exit(0);
      return;
    }
    allowedOrigins.add(desktopHost.adminOrigin);
    allowedOrigins.add(desktopHost.contentOrigin);
    adminOriginValue = desktopHost.adminOrigin;

    if (browserMode) {
      const deck = argumentValue(process.argv, "deck");
      const url = `${desktopHost.adminOrigin}${deck ? '/deck/' + encodeURIComponent(deck) : '/'}#token=${encodeURIComponent(desktopHost.token)}`;
      // Keep the credential out of terminal logs; the owner-only bootstrap is
      // available when --no-browser is requested or the OS browser cannot open.
      const bootstrap = join(app.getPath("userData"), "browser-connection.html");
      await privateWrite(bootstrap, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><a href="${url}">Slide Studio を開く</a>`, 0o600);
      process.stdout.write(`Slide Studio: ${desktopHost.adminOrigin}\n接続用ファイル: ${bootstrap}\n終了: Ctrl+C\n`);
      if (!process.argv.includes("--no-browser")) await shell.openExternal(url);
      return;
    }

    installSessionPolicy();
    createMainWindow(desktopHost.adminOrigin, desktopHost.token, cli?.positionals[0] === "open" ? cli.positionals[1] : argumentValue(process.argv, "deck"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[desktop] startup failed", error);
    try {
      if (cliMode || browserMode) { await shutdown(1); return; }
      dialog.showErrorBox(MAIN_STRINGS.startupError, message);
    } catch {
      // The dialog module can be unavailable if Electron is still starting.
    }
    await shutdown(1);
  }
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  activePdfDeadline?.abort("quit requested");
  try {
    await desktopHost?.close();
  } catch (error) {
    console.error("[desktop] cannot close the desktop host", error);
  }
  desktopHost = undefined;
  if (browserMode) await rm(join(app.getPath("userData"), "browser-connection.html"), {force: true});
  await close_pandoc();
  try {
    await pdfTail;
  } catch (error) {
    console.error("[desktop] PDF queue did not settle cleanly", error);
  }
  const pending = pendingWorkspaceService;
  pendingWorkspaceService = undefined;
  if (pending !== undefined) {
    try {
      await pending.close();
    } catch (error) {
      console.error("[desktop] cannot release an uncommitted workspace lock", error);
    }
  }
  const service = workspaceService;
  workspaceService = undefined;
  workspace = undefined;
  if (service !== undefined) {
    // The host has drained accepted writes and its onShutdown has closed
    // Pandoc, so it is now safe to release the cross-process workspace lock.
    try {
      await service.close();
    } catch (error) {
      console.error("[desktop] cannot release the workspace lock", error);
    }
  }
  forceQuit = true;
  app.exit(exitCode);
}

// Everything below must be synchronous and must happen before app.whenReady().
const userDataOverride = process.env.SLIDE_STUDIO_ELECTRON_HOME;
const cliMode = process.argv.includes("--studio-cli");
const browserMode = process.argv.includes("--studio-browser") || cliMode && (process.argv.includes("--browser") || process.argv.includes("--no-browser"));
const cliTemporaryProfile = cliMode && !userDataOverride ? mkdtempSync(join(tmpdir(), "slide-studio-cli-")) : null;
const profileDirectory = userDataOverride !== undefined && userDataOverride.length > 0
  ? (isAbsolute(userDataOverride) ? userDataOverride : resolve(process.cwd(), userDataOverride))
  : cliTemporaryProfile ?? join(app.getPath("appData"), app.isPackaged ? "Slide Studio" : "Slide Studio Dev");
const logsDirectory = join(profileDirectory, "logs");
const crashDumpsDirectory = join(profileDirectory, "crashDumps");
const sessionDataDirectory = join(profileDirectory, "sessionData");
mkdirSync(profileDirectory, { recursive: true });
mkdirSync(logsDirectory, { recursive: true });
mkdirSync(crashDumpsDirectory, { recursive: true });
mkdirSync(sessionDataDirectory, { recursive: true });
app.setPath("userData", profileDirectory);
app.setPath("sessionData", sessionDataDirectory);
app.setPath("logs", logsDirectory);
app.setPath("crashDumps", crashDumpsDirectory);
if (cliTemporaryProfile) app.once("quit", () => { try { rmSync(cliTemporaryProfile, {recursive: true, force: true}); } catch {} });
app.enableSandbox();
app.commandLine.appendSwitch("dns-prefetch-disable");
protocol.registerSchemesAsPrivileged([{
  scheme: STUDIO_RENDER_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);
installApplicationMenu();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(130);
  });
}

// requestSingleInstanceLock is scoped by the userData path above, so packaged
// and source runs have separate single-instance domains.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("before-quit", (event) => {
    if (forceQuit || shuttingDown) return;
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      event.preventDefault();
      void shutdown(0);
      return;
    }
    event.preventDefault();
    mainWindow.close();
  });

  app.on("window-all-closed", () => {
    if (cliMode || browserMode) return;
    void shutdown(0);
  });

  app.whenReady().then(async () => {
    if (cliMode || browserMode) app.dock?.hide();
    hiddenWindow = process.argv.includes("--hidden");
    await start();
  }).catch((error: unknown) => {
    console.error("[desktop] cannot start Electron", error);
    void shutdown(1);
  });
}
