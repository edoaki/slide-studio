import {appendFileSync, lstatSync, renameSync} from 'node:fs';
import {join} from 'node:path';

const limit = 512 * 1024;
export function recordMainError(directory: string, event: string, error: unknown, redact: (text:string)=>string): void {
  const path = join(directory, 'main.log');
  try {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    const text = redact(detail).slice(0, 8192);
    const line = JSON.stringify({time:new Date().toISOString(), event, detail:text})+'\n';
    const info = lstatSync(path, {throwIfNoEntry:false});
    if (info && !info.isFile()) return;
    if (info && info.size + Buffer.byteLength(line) > limit) renameSync(path, path+'.1');
    appendFileSync(path, line, {mode:0o600});
  } catch {
    // An unwritable log must not mask the original exception during shutdown.
  }
}
