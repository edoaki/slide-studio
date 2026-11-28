import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "../../packages/core/src/atomic.js";

/** Electron-compatible rectangle in screen DIPs. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normal (un-maximized) bounds plus the maximized flag of the main window. */
export interface WindowState extends Rect {
  maximized: boolean;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Accept only a well-formed saved state; anything else falls back to the default placement. */
export function parseWindowState(value: unknown): WindowState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { x, y, width, height, maximized } = value as Record<string, unknown>;
  if (![x, y, width, height].every(finite) || (width as number) <= 0 || (height as number) <= 0) return undefined;
  return { x: x as number, y: y as number, width: width as number, height: height as number, maximized: maximized === true };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function centerDistance(a: Rect, b: Rect): number {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Fit saved bounds entirely inside the work area of a currently connected
 * display: the one it overlaps most, or the nearest one when the saved display
 * is gone. The size is kept where it fits and the minimum never exceeds the area.
 */
export function placeWindow(
  saved: Rect | undefined,
  workAreas: readonly Rect[],
  minimum: { width: number; height: number },
): Rect | undefined {
  if (!saved || workAreas.length === 0) return undefined;
  let area = workAreas[0]!, best = -1;
  for (const candidate of workAreas) {
    const score = overlap(saved, candidate);
    if (score > best) [area, best] = [candidate, score];
  }
  if (best <= 0) {
    area = workAreas.reduce((near, candidate) => centerDistance(saved, candidate) < centerDistance(saved, near) ? candidate : near);
  }
  const width = Math.round(clamp(saved.width, Math.min(minimum.width, area.width), area.width));
  const height = Math.round(clamp(saved.height, Math.min(minimum.height, area.height), area.height));
  return {
    x: Math.round(clamp(saved.x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(saved.y, area.y, area.y + area.height - height)),
    width,
    height,
  };
}

/** Reads synchronously before the window exists; writes are debounced and atomic. */
export class WindowStateStore {
  private pending: WindowState | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly delay = 400,
    private readonly write: (path: string, data: string) => Promise<void> = (path, data) => atomicWriteFile(path, data, 0o600),
  ) {}

  read(): WindowState | undefined {
    try {
      return parseWindowState(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return undefined;
    }
  }

  schedule(state: WindowState): void {
    this.pending = state;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }

  /** Write the latest scheduled state now; failures are logged and never block closing. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const state = this.pending;
    this.pending = undefined;
    if (state) {
      this.queue = this.queue.then(async () => {
        mkdirSync(dirname(this.path), { recursive: true });
        await this.write(this.path, JSON.stringify(state));
      }).catch(error => { console.error("[desktop] cannot save the window state", error instanceof Error ? error.message : error); });
    }
    return this.queue;
  }
}
