import { BaseWindow } from "electron";

export const VIEWPORT_WIDTH = 1280;
export const VIEWPORT_HEIGHT = 720;

export function createRenderWindow(): BaseWindow {
  return new BaseWindow({
    show: false,
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    useContentSize: true,
    autoHideMenuBar: true,
  });
}

/** Only the empty native window survives a job. The caller owns it until release. */
export class RenderWindowPool {
  private idle?: BaseWindow;
  private closed = false;

  acquire(): BaseWindow {
    if (this.closed) throw new Error("render window pool is closed");
    const win = this.idle;
    this.idle = undefined;
    return win && !win.isDestroyed() ? win : createRenderWindow();
  }

  release(win: BaseWindow): void {
    if (win.isDestroyed()) return;
    if (this.closed || this.idle) win.destroy();
    else this.idle = win;
  }

  close(): void {
    this.closed = true;
    if (this.idle && !this.idle.isDestroyed()) this.idle.destroy();
    this.idle = undefined;
  }
}
