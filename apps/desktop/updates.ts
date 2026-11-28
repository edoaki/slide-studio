const LATEST_RELEASE_API = 'https://api.github.com/repos/edoaki/slide-studio/releases/latest';
export type UpdatePhase = 'idle' | 'checking' | 'current' | 'unpublished' | 'available' | 'error';
export interface UpdateState {
  version: string;
  availableVersion?: string;
  phase: UpdatePhase;
  error?: string;
}

function stableVersion(value: string): number[] | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\w.-]+)?$/.exec(value);
  if (!match) return;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}
export function isNewerRelease(candidate: string, installed: string): boolean {
  const next = stableVersion(candidate), current = stableVersion(installed);
  if (!next || !current) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i]! > current[i]!;
  }
  return false;
}

/** Checks public releases only. Downloads and installation are always manual. */
export class DesktopUpdates {
  private state: UpdateState;
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(version: string, private request: typeof fetch = fetch) {
    this.state = { version, phase: 'idle' };
  }
  snapshot(): UpdateState { return { ...this.state }; }
  async check() {
    if (this.busy) return this.snapshot();
    this.busy = true;
    this.state.phase = 'checking'; delete this.state.error;
    try {
      const response = await this.request(LATEST_RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Slide-Studio', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) {
        this.state.phase = this.state.availableVersion ? 'available' : 'unpublished';
        return this.snapshot();
      }
      if (!response.ok) throw new Error(`GitHub Releases: HTTP ${response.status}`);
      const release = await response.json() as { tag_name?: unknown; draft?: boolean; prerelease?: boolean; assets?: { name?: string }[] };
      if (typeof release.tag_name !== 'string' || !stableVersion(release.tag_name) || release.draft || release.prerelease || !Array.isArray(release.assets)) {
        throw new Error('Invalid stable release');
      }
      if (!release.assets.some(asset => typeof asset?.name === 'string' && /\.(dmg|exe)$/.test(asset.name))) {
        this.state.phase = 'unpublished'; delete this.state.availableVersion;
      } else if (isNewerRelease(release.tag_name, this.state.version)) {
        this.state.availableVersion = release.tag_name.replace(/^v/, '');
        this.state.phase = 'available';
      } else {
        this.state.phase = 'current'; delete this.state.availableVersion;
      }
    } catch (error) {
      this.state.phase = 'error';
      this.state.error = error instanceof Error ? error.message : String(error);
    } finally { this.busy = false; }
    return this.snapshot();
  }
  start() {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, 4 * 60 * 60 * 1000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = undefined; }
}
