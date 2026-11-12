/** M1 batch prototype contract. No editor, admin API, or Electron IPC is exposed. */
export interface RenderJob {
  schemaVersion: 1;
  /** Absolute path to one self-contained, Python-built HTML bundle. */
  inputHtml: string;
  /** A new directory; existing paths must be rejected without modification. */
  outputDir: string;
  /** Whole-job deadline, including readiness and printing. Default 60 seconds. */
  timeoutMs?: number;
  /** Capture every PDF-selected step at 1280x720. Default true. */
  screenshots?: boolean;
  allSteps?: boolean;
  pdf?: boolean;
}

export interface RenderStep {
  slide: number;
  step: number;
  screenshot?: string;
  layout: unknown;
}

export interface RenderResult {
  schemaVersion: 1;
  status: "ok" | "error";
  slides: number;
  pdfPages: number;
  steps: RenderStep[];
  errors: string[];
  blockedRequests: string[];
  elapsedMs: number;
  versions: { electron: string; chromium: string; node: string };
}
