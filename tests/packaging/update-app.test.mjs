import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseOptions, replaceBundle, selectApp } from '../../scripts/update-app.mjs';

test('selects the running app and rejects ambiguous installations', () => {
  assert.equal(selectApp(undefined, ['/active/Slide Studio.app'], ['/other/Slide Studio.app']), '/active/Slide Studio.app');
  assert.equal(selectApp('/chosen/Slide Studio.app', ['/active/Slide Studio.app'], []), '/chosen/Slide Studio.app');
  assert.throws(() => selectApp(undefined, [], ['/one', '/two']), /--app/);
  assert.throws(() => selectApp(undefined, ['/one', '/two'], []), /--app/);
});

test('keeps the previous bundle and restores it if replacement fails', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'studio-update-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const destination = join(temp, 'Slide Studio.app');
  const backup = join(temp, 'previous.app');
  const staged = join(temp, 'new.app');
  await mkdir(destination);
  await writeFile(join(destination, 'version'), 'old');
  await assert.rejects(replaceBundle(staged, destination, backup), /ENOENT/);
  assert.equal(await readFile(join(destination, 'version'), 'utf8'), 'old');
  await mkdir(staged);
  await writeFile(join(staged, 'version'), 'new');
  assert.equal(await replaceBundle(staged, destination, backup), true);
  assert.equal(await readFile(join(destination, 'version'), 'utf8'), 'new');
  assert.equal(await readFile(join(backup, 'version'), 'utf8'), 'old');
});

test('routine updates do not reinstall dependencies or run visible UI tests', () => {
  assert.deepEqual(parseOptions([]), { app: undefined, e2e: false, installDeps: false });
  assert.deepEqual(parseOptions(['--e2e', '--app', '/Applications/Slide Studio.app', '--install-deps']), {
    app: '/Applications/Slide Studio.app', e2e: true, installDeps: true,
  });
  for (const args of [['--app'], ['--app', '--e2e'], ['--unknown'], ['--app', '/one', '--app', '/two']]) {
    assert.throws(() => parseOptions(args), /Usage:/);
  }
});
