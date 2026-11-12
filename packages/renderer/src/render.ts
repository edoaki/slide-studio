import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, session, type Session, type WebContents } from "electron";
import { PDFDocument } from "pdf-lib";
import type { RenderStep } from "./contracts.js";
import type { JobDeadline } from "./deadline.js";
import type { ValidatedRenderJob } from "./job.js";
import { layoutExpression, loadLayoutSource } from "./layout.js";
import { atomicWriteFile } from "./output.js";
import { assertPngSize } from "./png.js";
import {
  ENTRY_URL,
  RENDER_CSP,
  STUDIO_RENDER_SCHEME,
  classifyRenderUrl,
} from "./protocol.js";
import { errorMessage, unique } from "./util.js";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const PDF_WIDTH_INCHES = 40 / 3;
const PDF_HEIGHT_INCHES = 7.5;
const PDF_WIDTH_POINTS = 960;
const PDF_HEIGHT_POINTS = 540;

const READY_EXPRESSION = `new Promise((resolve) => {
  if (window.deckReady === true) { resolve(true); return; }
  addEventListener('deckready', () => resolve(true), { once: true });
})`;

const SETTLE_EXPRESSION = `new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
})`;

// Read the offset from inside the frame. This keeps each frame's coordinates
// with that frame instead of pairing two independent lists by order.
const FRAME_BOX_EXPRESSION = `(() => {
  const el = window.frameElement;
  if (!el || el.tagName !== 'IFRAME' || !el.closest('#stage')) return null;
  const slide = el.closest('.slide');
  if (!slide || !slide.classList.contains('active')) return null;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    visible: rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden'
  };
})()`;

const BROKEN_CONTENT_EXPRESSION = `(() => {
  const slide = document.querySelector('.slide.active');
  if (!slide) return ['no active slide'];
  const broken = [];
  for (const img of slide.querySelectorAll('img')) {
    if (!img.complete || (img.naturalWidth === 0 && img.getAttribute('src'))) {
      broken.push((img.currentSrc || img.getAttribute('src') || 'image').slice(0, 200));
    }
  }
  for (const frame of slide.querySelectorAll('iframe')) {
    const source = (frame.getAttribute('src') || frame.getAttribute('title') || 'iframe').slice(0, 200);
    let ok = false;
    try { ok = !!frame.contentWindow?.animation; } catch { ok = false; }
    if (!ok) broken.push(source);
  }
  return [...new Set(broken)];
})()`;

const VIEWPORT_METRICS_EXPRESSION = `(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio,
  visualViewportScale: window.visualViewport ? window.visualViewport.scale : 1
}))()`;

export interface RenderDeckResult {
  slides: number;
  pdfPages: number;
  steps: RenderStep[];
  pdfFile: string;
  screenshotFiles: string[];
}

export class RenderFailure extends Error {
  constructor(
    message: string,
    readonly errors: string[],
    readonly blockedRequests: string[],
  ) {
    super(message);
    this.name = "RenderFailure";
  }
}

interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

interface NavigationInfo {
  url?: string;
  mainFrame?: boolean;
  sameDocument: boolean;
}

interface ViewportMetrics {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  visualViewportScale: number;
}

function isViewportMetrics(value: unknown): value is ViewportMetrics {
  if (value === null || typeof value !== "object") return false;
  const metrics = value as Record<string, unknown>;
  return ["innerWidth", "innerHeight", "devicePixelRatio", "visualViewportScale"]
    .every((key) => typeof metrics[key] === "number");
}

async function assertViewport(
  contents: WebContents,
  deadline: JobDeadline,
): Promise<void> {
  const value = await deadline.race(
    contents.executeJavaScript(VIEWPORT_METRICS_EXPRESSION, true),
  ) as unknown;
  if (!isViewportMetrics(value)) throw new Error("cannot read renderer viewport metrics");
  if (
    value.innerWidth !== VIEWPORT_WIDTH
    || value.innerHeight !== VIEWPORT_HEIGHT
    || value.devicePixelRatio !== 1
    || value.visualViewportScale !== 1
  ) {
    throw new Error(
      `renderer viewport is ${value.innerWidth}x${value.innerHeight} at DPR `
      + `${value.devicePixelRatio} (visual scale ${value.visualViewportScale}), expected `
      + `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT} at DPR 1 (visual scale 1)`,
    );
  }
}

function isFrameBox(value: unknown): value is FrameBox {
  if (value === null || typeof value !== "object") return false;
  const box = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => typeof box[key] === "number")
    && typeof box.visible === "boolean";
}

function consoleLevel(level: unknown): number | string | undefined {
  if (typeof level === "number" || typeof level === "string") return level;
  return undefined;
}

function addConsoleMessage(
  message: string,
  level: number | string | undefined,
  addError: (message: string) => void,
): void {
  if (level === "error" || level === 3) addError(`JavaScript error: ${message}`);
}

function preventDefault(args: unknown[]): void {
  const event = args[0] as { preventDefault?: () => void } | undefined;
  event?.preventDefault?.();
}

function navigationInfo(args: unknown[]): NavigationInfo {
  const records = args.filter(
    (value): value is Record<string, unknown> => value !== null && typeof value === "object",
  );
  const strings = args.filter((value): value is string => typeof value === "string");
  const booleans = args.filter((value): value is boolean => typeof value === "boolean");
  const recordUrl = records.find((record) => typeof record.url === "string")?.url;
  const url = strings[0] ?? (typeof recordUrl === "string" ? recordUrl : undefined);
  const mainRecord = records.find((record) => typeof record.isMainFrame === "boolean");
  const mainFrame = mainRecord
    ? mainRecord.isMainFrame === true
    : booleans.length >= 2 ? booleans[1] : undefined;
  const sameDocument = records.some(
    (record) => record.isSameDocument === true || record.isInPlace === true,
  ) || booleans[0] === true;
  return { url, mainFrame, sameDocument };
}

function pdfFileName(inputHtml: string): string {
  const name = inputHtml.slice(Math.max(inputHtml.lastIndexOf("/"), inputHtml.lastIndexOf("\\")) + 1);
  const stem = name.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return `${stem || "slides"}.pdf`;
}

/** Set the player flag before any bundle script runs. Current bundles have a head. */
function withNoHashBootstrap(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (!head) throw new Error("input HTML is missing a <head> element");
  const end = head.index + head[0].length;
  return `${html.slice(0, end)}<script>window.__slideStudioNoHash = true;</script>${html.slice(end)}`;
}

async function mergePdfPages(pages: Buffer[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const bytes of pages) {
    const source = await PDFDocument.load(bytes);
    if (source.getPageCount() !== 1) {
      throw new Error(
        `printToPDF returned ${source.getPageCount()} pages for one step, expected 1`,
      );
    }
    const [page] = source.getPages();
    if (!page) throw new Error("printToPDF returned no pages");
    const size = page.getSize();
    if (
      Math.abs(size.width - PDF_WIDTH_POINTS) > 0.5
      || Math.abs(size.height - PDF_HEIGHT_POINTS) > 0.5
    ) {
      throw new Error(
        `PDF page is ${size.width}x${size.height}pt, expected `
        + `${PDF_WIDTH_POINTS}x${PDF_HEIGHT_POINTS}pt`,
      );
    }
    const copied = await merged.copyPages(source, [0]);
    for (const copy of copied) merged.addPage(copy);
  }
  return merged.save();
}

export async function renderDeck(
  job: ValidatedRenderJob,
  outputDir: string,
  deadline: JobDeadline,
): Promise<RenderDeckResult> {
  const errors = new Set<string>();
  const blocked = new Set<string>();
  const addError = (message: string) => errors.add(message);
  const addBlocked = (url: string) => blocked.add(url);
  const ensureActive = () => {
    if (deadline.aborted) throw deadline.reason;
  };
  const throwIfTracked = () => {
    if (errors.size > 0 || blocked.size > 0) {
      throw new RenderFailure(
        "renderer reported JavaScript errors or blocked requests",
        unique(errors),
        unique(blocked),
      );
    }
  };

  let win: BrowserWindow | undefined;
  let renderSession: Session | undefined;
  let onAbort: (() => void) | undefined;
  let loadedOnce = false;

  try {
    const html = await readFile(job.inputHtml, "utf8");
    ensureActive();
    const entryHtml = withNoHashBootstrap(html);
    const layoutSource = await loadLayoutSource();
    ensureActive();
    const pdfFile = pdfFileName(job.inputHtml);

    renderSession = session.fromPartition(
      `studio-render-${process.pid}-${randomUUID()}`,
      { cache: false },
    );
    renderSession.setPermissionRequestHandler((_contents, permission, callback) => {
      addBlocked(`permission:${permission}`);
      callback(false);
    });
    renderSession.setPermissionCheckHandler(() => false);
    await deadline.race(renderSession.setProxy({
      mode: "fixed_servers",
      proxyRules: "http=127.0.0.1:1;https=127.0.0.1:1",
    }));

    const filter = { urls: ["<all_urls>"] };
    renderSession.webRequest.onBeforeRequest(filter, (details, callback) => {
      if (classifyRenderUrl(details.url) === "blocked") {
        addBlocked(details.url);
        callback({ cancel: true });
      } else {
        callback({});
      }
    });

    renderSession.protocol.handle(STUDIO_RENDER_SCHEME, (request) => {
      if (classifyRenderUrl(request.url) === "entry") {
        return new Response(entryHtml, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": RENDER_CSP,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
      addBlocked(request.url);
      return new Response("Blocked", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    });

    win = new BrowserWindow({
      show: false,
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      useContentSize: true,
      autoHideMenuBar: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        session: renderSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: false,
        spellcheck: false,
      },
    });

    const contents = win.webContents;
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    onAbort = () => {
      if (!win?.isDestroyed()) win?.destroy();
    };
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    if (deadline.aborted) onAbort();

    contents.setWindowOpenHandler(({ url }) => {
      addBlocked(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (...args: unknown[]) => {
      const info = navigationInfo(args);
      preventDefault(args);
      addBlocked(info.url ?? "<unknown main-frame navigation>");
    });
    contents.on("will-redirect", (...args: unknown[]) => {
      const info = navigationInfo(args);
      preventDefault(args);
      addBlocked(info.url ?? "<unknown main-frame redirect>");
    });
    contents.on("will-frame-navigate", (...args: unknown[]) => {
      const info = navigationInfo(args);
      if (info.url !== undefined && classifyRenderUrl(info.url) === "embedded") return;
      preventDefault(args);
      addBlocked(info.url ?? "<unknown frame navigation>");
    });
    contents.on("did-start-navigation", (...args: unknown[]) => {
      if (!loadedOnce) return;
      const info = navigationInfo(args);
      if (info.sameDocument || info.mainFrame === false) return;
      addError(`unexpected main-frame navigation: ${info.url ?? "<unknown>"}`);
      deadline.abort("unexpected main-frame navigation");
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("render-process-gone", (_event, details) => {
      addError(`renderer process gone: ${details.reason} (exit ${details.exitCode})`);
      deadline.abort("renderer process gone");
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (code === -3) return;
      if (isMainFrame) {
        addError(`failed to load ${url}: ${description} (${code})`);
        deadline.abort("failed to load the input HTML");
      } else {
        addError(`failed to load frame ${url}: ${description} (${code})`);
      }
    });
    contents.on("console-message", (...args: unknown[]) => {
      const details = args.find(
        (value) => value !== null && typeof value === "object" && "message" in value,
      ) as { level?: unknown; message?: unknown } | undefined;
      if (details && typeof details.message === "string") {
        addConsoleMessage(details.message, consoleLevel(details.level), addError);
        return;
      }
      const level = args.find((value) => typeof value === "number" || typeof value === "string");
      const message = args.find((value) => typeof value === "string" && value !== level);
      if (typeof message === "string") {
        addConsoleMessage(message, consoleLevel(level), addError);
      }
    });

    await deadline.race(contents.loadURL(ENTRY_URL));
    loadedOnce = true;
    // The renderer target exists only after the load starts. Pin the CDP
    // viewport to one CSS pixel per captured pixel (Retina macOS otherwise
    // captures at 2x despite force-device-scale-factor).
    contents.debugger.attach("1.3");
    await deadline.race(contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    }));
    await assertViewport(contents, deadline);
    await deadline.race(contents.executeJavaScript(
      "window.__slideStudioNoHash = true; true",
      true,
    ));
    await deadline.race(contents.executeJavaScript(READY_EXPRESSION, true));
    await deadline.race(contents.executeJavaScript(
      "document.body.classList.add('export'); true",
      true,
    ));
    await deadline.race(contents.executeJavaScript(SETTLE_EXPRESSION, true));

    const count = await deadline.race(contents.executeJavaScript("deck.count", true)) as unknown;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      throw new Error(`deck.count is not a positive integer: ${String(count)}`);
    }

    const screenshotDirectory = join(outputDir, "screenshots");
    if (job.screenshots) {
      await mkdir(screenshotDirectory, { recursive: true });
      ensureActive();
    }

    const steps: RenderStep[] = [];
    const screenshotFiles: string[] = [];
    const pdfPages: Buffer[] = [];

    const collectLayout = async (): Promise<unknown> => {
      const mainSource = layoutExpression(layoutSource, { dx: 0, dy: 0, audit: false });
      const mainIssues = await deadline.race(contents.executeJavaScript(mainSource, true));
      const found: unknown[] = Array.isArray(mainIssues) ? [...mainIssues] : [];

      for (const frame of contents.mainFrame.frames) {
        let box: unknown;
        try {
          box = await deadline.race(frame.executeJavaScript(FRAME_BOX_EXPRESSION));
        } catch {
          if (deadline.aborted) throw deadline.reason;
          continue; // cross-origin or detached frame
        }
        if (!isFrameBox(box) || !box.visible) continue;
        const expression = layoutExpression(layoutSource, {
          dx: box.x,
          dy: box.y,
          frame: true,
          audit: false,
        });
        let issues: unknown;
        try {
          issues = await deadline.race(frame.executeJavaScript(expression));
        } catch (error) {
          if (deadline.aborted) throw deadline.reason;
          addError(`iframe layout failed: ${errorMessage(error)}`);
          continue;
        }
        if (!Array.isArray(issues)) continue;
        for (const issue of issues) {
          if (issue !== null && typeof issue === "object") {
            (issue as Record<string, unknown>).figure = frame.url;
          }
          found.push(issue);
        }
      }
      return found;
    };

    for (let slide = 0; slide < count; slide++) {
      if (errors.size > 0 || blocked.size > 0) break;
      await deadline.race(contents.executeJavaScript(`deck.go(${slide}, 0, false)`, true));
      await deadline.race(contents.executeJavaScript(SETTLE_EXPRESSION, true));
      const broken = await deadline.race(
        contents.executeJavaScript(BROKEN_CONTENT_EXPRESSION, true),
      ) as unknown;
      if (Array.isArray(broken) && broken.length > 0) {
        for (const item of broken) addError(`missing or broken content: ${String(item)}`);
        throw new Error("missing or broken content");
      }

      const selected = await deadline.race(
        contents.executeJavaScript(`deck.pdfSteps(${slide})`, true),
      ) as unknown;
      if (!Array.isArray(selected) || selected.length === 0) {
        throw new Error(`deck.pdfSteps(${slide}) returned no steps`);
      }

      for (const value of selected) {
        const step = Number(value);
        if (!Number.isInteger(step) || step < 0) {
          throw new Error(`deck.pdfSteps(${slide}) returned an invalid step: ${String(value)}`);
        }
        await deadline.race(contents.executeJavaScript(
          `deck.go(${slide}, ${step}, false)`,
          true,
        ));
        await deadline.race(contents.executeJavaScript(SETTLE_EXPRESSION, true));

        const layout = await collectLayout();
        let screenshot: string | undefined;
        if (job.screenshots) {
          await assertViewport(contents, deadline);
          const shot = await deadline.race(contents.debugger.sendCommand(
            "Page.captureScreenshot",
            { format: "png", fromSurface: true, captureBeyondViewport: false },
          )) as unknown;
          if (
            shot === null
            || typeof shot !== "object"
            || typeof (shot as Record<string, unknown>).data !== "string"
          ) {
            throw new Error("Page.captureScreenshot returned no PNG data");
          }
          const png = Buffer.from((shot as { data: string }).data, "base64");
          assertPngSize(png, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
          const relative = `screenshots/p${String(slide + 1).padStart(2, "0")}-s${step}.png`;
          await atomicWriteFile(join(outputDir, relative), png);
          ensureActive();
          screenshot = relative;
          screenshotFiles.push(relative);
        }

        pdfPages.push(await deadline.race(contents.printToPDF({
          printBackground: true,
          pageSize: { width: PDF_WIDTH_INCHES, height: PDF_HEIGHT_INCHES },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          pageRanges: "1",
          preferCSSPageSize: false,
          landscape: false,
        })));

        steps.push({
          slide,
          step,
          ...(screenshot === undefined ? {} : { screenshot }),
          layout,
        });
        if (errors.size > 0 || blocked.size > 0) break;
      }
      if (errors.size > 0 || blocked.size > 0) break;
    }

    throwIfTracked();
    if (pdfPages.length === 0) throw new Error("no PDF steps were selected");

    const merged = await mergePdfPages(pdfPages);
    throwIfTracked();
    ensureActive();
    const pdfPagesCount = (await PDFDocument.load(merged)).getPageCount();
    if (pdfPagesCount !== pdfPages.length) {
      throw new Error(
        `merged PDF has ${pdfPagesCount} pages, expected ${pdfPages.length}`,
      );
    }
    await atomicWriteFile(join(outputDir, pdfFile), merged);
    throwIfTracked();
    ensureActive();

    return {
      slides: count,
      pdfPages: pdfPagesCount,
      steps,
      pdfFile,
      screenshotFiles,
    };
  } catch (error) {
    const messages = unique(errors);
    if (deadline.aborted) messages.push(deadline.reason.message);
    const errorList = error instanceof RenderFailure
      ? unique([...error.errors, ...messages])
      : unique([errorMessage(error), ...messages]);
    const blockedList = unique([
      ...(error instanceof RenderFailure ? error.blockedRequests : []),
      ...blocked,
    ]);
    throw new RenderFailure(errorMessage(error), errorList, blockedList);
  } finally {
    if (onAbort) deadline.signal.removeEventListener("abort", onAbort);
    if (win && !win.isDestroyed()) {
      try {
        if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
      } catch {
        // The renderer may already be gone.
      }
      win.destroy();
    }
    try {
      renderSession?.protocol.unhandle(STUDIO_RENDER_SCHEME);
    } catch {
      // The in-memory session is discarded with the process.
    }
  }
}
