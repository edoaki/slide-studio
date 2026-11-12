import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLauncher } from '../../apps/cli/launcher.js';
import { RequestBridge } from '../../packages/ai/src/bridge.js';
import { execute } from '../../packages/ai/src/process.js';

test('macOS sandbox launcher preserves Japanese arguments, JSON, stdout and exit status without Electron', {skip: process.platform !== 'darwin'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio cli 日本語 '));
  t.after(() => rm(root, {recursive: true, force: true}));
  const received: Record<string, unknown>[] = [];
  const host = await new RequestBridge(root, async body => {received.push(body); return {errors: 1, summary: '検査：エラー 1', result: {errors: ['確認']}};}).start();
  t.after(() => host.close());
  const bin = await prepareLauncher(join(root, 'private bin'), '/missing/electron');
  const launcher = join(bin, 'slide-studio');
  const codex = process.env.SLIDE_STUDIO_SANDBOX_TEST_CODEX;
  const run = (args: string[]) => execute(codex || launcher, codex ? ['sandbox', '-c', 'default_permissions="slide-studio"', '-c', 'permissions.slide-studio.extends=":workspace"', '--', launcher, ...args] : args, {cwd: root, env: {...process.env, SLIDE_STUDIO_SANDBOX: '1', SLIDE_STUDIO_HOME: root}});
  const result = await run(['check', '発表 と引用"', '--page', 'intro', '--json']);
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {errors: ['確認']});
  assert.deepEqual(received[0], {operation: 'check', deck: '発表 と引用"', page: 'intro'});
  const invalid = await run(['build', 'talk']);
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /check・consult・audit/);
  assert.equal(received.length, 1);
});
