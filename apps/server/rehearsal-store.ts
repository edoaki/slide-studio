import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../packages/core/src/atomic.js';
export interface RehearsalRecord {
  version: 1; date: string; elapsed: number;
  pages: {id: string; title: string; number: number; ms: number; visited: boolean}[];
}
export function validRehearsal(value: unknown): value is RehearsalRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as RehearsalRecord;
  return r.version === 1 && typeof r.date === 'string' && Number.isFinite(Date.parse(r.date))
    && Number.isFinite(r.elapsed) && r.elapsed >= 0 && Array.isArray(r.pages) && r.pages.length <= 10000
    && r.pages.every(p => p && typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 4096
      && typeof p.title === 'string' && p.title.length <= 4096 && Number.isSafeInteger(p.number) && p.number > 0
      && Number.isFinite(p.ms) && p.ms >= 0 && typeof p.visited === 'boolean')
    && new Set(r.pages.map(p => p.id)).size === r.pages.length;
}
export async function readRehearsal(directory: string): Promise<RehearsalRecord | null> {
  let file;
  try {
    file = await open(join(directory,'rehearsals.json'),constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return null;
    const record: unknown = JSON.parse(await file.readFile('utf8'));
    return validRehearsal(record) ? record : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  } finally { await file?.close(); }
}
export async function saveRehearsal(directory: string, record: RehearsalRecord): Promise<void> {
  if (!validRehearsal(record)) throw new TypeError('invalid rehearsal record');
  await atomicWriteFile(join(directory,'rehearsals.json'),JSON.stringify(record) + '\n',0o600);
}
