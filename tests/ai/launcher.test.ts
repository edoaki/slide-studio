import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const review={reviewer:'確認者',states:[],decisions:[],visual_issues:[]};
  const file=join(root,'確認 結果.json');await writeFile(file,JSON.stringify(review));
  const reviewed=await run(['audit','review','発表','audit-1','--file',file]);
  assert.equal(reviewed.code,1,reviewed.stderr); // fixture result is not complete
  assert.deepEqual(received[1],{operation:'audit_review',deck:'発表',audit_id:'audit-1',review});
});
