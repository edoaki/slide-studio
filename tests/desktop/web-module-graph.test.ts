import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { LEGACY_WEB_FILES } from '../../apps/server/index.js';
test('every static module reachable from the editor is served by the UI allowlist', async () => {
 const seen = new Set<string>();
 const visit = async (name: string) => {
  if (seen.has(name)) return; seen.add(name);
  assert.ok(LEGACY_WEB_FILES.includes(name), `UI module is not served: ${name}`);
  const text = await readFile(new URL(`../../packages/web/${name}`, import.meta.url), 'utf8');
  for (const match of text.matchAll(/(?:import\s+(?:[^;'"\n]+\s+from\s+)?|export\s+[^;'"\n]+\s+from\s+)['"](\.[^'"]+)['"]/g)) await visit(posix.normalize(posix.join(posix.dirname(name), match[1]!)));
 };
 await visit('app.js');
});
