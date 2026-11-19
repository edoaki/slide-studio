import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from '../../packages/core/src/atomic.js';

export interface UpdateDriver {
  autoRunAppAfterInstall?: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}
export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
export interface UpdateState {
  version: string;
  availableVersion?: string;
  automatic: boolean;
  phase: UpdatePhase;
  progress: number;
  error?: string;
}

/** Owns update policy; the native driver owns download verification and installation. */
export class DesktopUpdates {
  private state: UpdateState;
  private busy = false;
  private downloaded = false;
  private timer?: ReturnType<typeof setInterval>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private driver: UpdateDriver | undefined, private settingsPath: string, version: string) {
    this.state = { version, automatic: true, phase: driver ? 'idle' : 'disabled', progress: 0 };
    if (!driver) return;
    driver.autoDownload = false;
    driver.autoInstallOnAppQuit = false;
    driver.on('update-available', info => { this.state.availableVersion = info.version; this.state.phase = 'available'; });
    driver.on('update-not-available', () => { this.state.phase = 'current'; delete this.state.availableVersion; });
    driver.on('download-progress', info => { this.state.progress = Math.max(0, Math.min(100, Math.round(info.percent))); });
    driver.on('update-downloaded', () => { this.downloaded = true; this.state.phase = 'ready'; this.state.progress = 100; });
    driver.on('error', error => this.fail(error));
  }
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.settingsPath, 'utf8'));
      if (typeof saved.automatic === 'boolean') this.state.automatic = saved.automatic;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[updates] cannot read preferences', error); }
  }
  snapshot(): UpdateState { return { ...this.state }; }
  private fail(error: unknown) {
    this.state.phase = 'error';
    this.state.error = error instanceof Error ? error.message : String(error);
  }
  async setAutomatic(automatic: boolean) {
    const write = this.writes.then(async () => {
      await atomicWriteFile(this.settingsPath, JSON.stringify({ automatic }), 0o600);
      this.state.automatic = automatic;
    });
    this.writes = write.catch(() => {});
    await write;
    if (automatic && this.state.phase === 'available') void this.download();
    return this.snapshot();
  }
  async check() {
    if (!this.driver || this.busy || this.downloaded) return this.snapshot();
    this.busy = true; this.state.phase = 'checking'; delete this.state.error;
    try { await this.driver.checkForUpdates(); }
    catch (error) { this.fail(error); }
    finally { this.busy = false; }
    if (this.state.automatic && this.snapshot().phase === 'available') await this.download();
    return this.snapshot();
  }
  async download() {
    if (!this.driver || this.busy || this.state.phase !== 'available') return this.snapshot();
    this.busy = true; this.state.phase = 'downloading'; this.state.progress = 0; delete this.state.error;
    try { await this.driver.downloadUpdate(); }
    catch (error) { this.fail(error); }
    finally { this.busy = false; }
    return this.snapshot();
  }
  start() {
    if (!this.driver || this.timer) return;
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, 4 * 60 * 60 * 1000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  canInstall() { return this.downloaded; }
  installOnQuit(manual: boolean) {
    this.stop();
    if (!this.driver || !this.downloaded || (!manual && !this.state.automatic)) return false;
    this.driver.autoRunAppAfterInstall = manual;
    this.driver.quitAndInstall(!manual, manual);
    return true;
  }
}
