import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile } from '../../packages/core/src/atomic.js';

export const defaults = { theme: 'system', zoom: 100, keyHints: true, tooltips: true, tooltipKeys: true };
export type UiSettings = typeof defaults;
export function validateSettings(value: unknown): Partial<UiSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid settings');
  const patch = value as Record<string, unknown>;
  const ranges: Record<string, number[]> = { zoom: [75, 150] };
  for (const [key, v] of Object.entries(patch)) {
    if (!(Object.hasOwn(defaults, key))) throw Error('Unknown setting');
    if (key === 'theme' ? !['system', 'light', 'dark'].includes(v as string)
      : ranges[key] ? typeof v !== 'number' || !Number.isFinite(v) || v < ranges[key][0]! || v > ranges[key][1]!
      : typeof v !== 'boolean') throw Error('Invalid setting value');
  }
  return patch as Partial<UiSettings>;
}
export class UiSettingsStore {
  value = { ...defaults };
  private queue = Promise.resolve();
  constructor(private path: string) {}
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      // Retire the former editing/presentation preferences without resetting appearance.
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const key of ['editorFontSize', 'speakerFontSize', 'duration']) delete saved[key];
      }
      this.value = { ...defaults, ...validateSettings(saved) };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[settings] Failed to load', error); }
  }
  save(patch: Partial<UiSettings>) {
    const work = this.queue.then(async () => {
      const next = { ...this.value, ...validateSettings(patch) };
      await mkdir(dirname(this.path), { recursive: true });
      await atomicWriteFile(this.path, JSON.stringify(next), 0o600);
      this.value = next;
      return { ...next };
    });
    this.queue = work.then(() => {}, () => {});
    return work;
  }
}
