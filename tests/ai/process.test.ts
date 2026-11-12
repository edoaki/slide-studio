import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../packages/ai/src/process.js';

test('native process keeps arguments literal and decodes split UTF-8 notifications', async () => {
  const lines: string[] = [];
  const result = await execute(process.execPath, ['-e', `const b=Buffer.from('日本語\\n最後');process.stdout.write(b.subarray(0,2));setTimeout(()=>{process.stdout.write(b.subarray(2));process.stderr.write(process.argv[1]);},10)`, '$(echo unexpected); `echo no`'], {onLine: line => lines.push(line)});
  assert.equal(result.code, 0);
  assert.deepEqual(lines, ['日本語', '最後']);
  assert.equal(result.stdout, '日本語\n最後');
  assert.equal(result.stderr, '$(echo unexpected); `echo no`');
});

test('native process propagates parser failure, timeout, cancellation and launch failure', async () => {
  await assert.rejects(execute(process.execPath, ['-e', "console.log('bad');setInterval(()=>{},1000)"], {onLine() { throw Error('invalid event'); }}), /invalid event/);
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {timeoutMs: 20}), /時間切れ/);
  const controller = new AbortController();
  const running = execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {signal: controller.signal});
  controller.abort();
  await assert.rejects(running, /取り消し/);
  await assert.rejects(execute('/no/such/slide-studio-test-executable', []), /ENOENT/);
});

test('native process closes descendants that keep its output pipes open', {skip: process.platform === 'win32'}, async () => {
  const controller = new AbortController();
  const running = execute(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.exit(0)`], {signal: controller.signal});
  const timer = setTimeout(() => controller.abort(), 150);
  try { await assert.rejects(running, /取り消し/); } finally { clearTimeout(timer); }
});
