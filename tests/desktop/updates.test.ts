import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopUpdates } from '../../apps/desktop/updates.js';

class Driver extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  downloads = 0;
  installs: unknown[] = [];
  failure = false;
  async checkForUpdates() {
    if (this.failure) throw new Error('offline');
    this.emit('update-available', { version: '0.2.0' });
  }
  async downloadUpdate() { this.downloads++; this.emit('download-progress', { percent: 50 }); this.emit('update-downloaded'); }
  quitAndInstall(...args: unknown[]) { this.installs.push(args); }
}
async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-updates-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const driver = new Driver(), path = join(dir, 'updates.json');
  const updates = new DesktopUpdates(driver, path, '0.1.0');
  await updates.initialize();
  return { updates, driver, path };
}
test('unchecked updates only notify; explicit download still requires explicit install', async t => {
  const { updates, driver } = await setup(t);
  await updates.setAutomatic(false);
  assert.equal(driver.autoDownload, false); assert.equal(driver.autoInstallOnAppQuit, false);
  await updates.check(); assert.equal(updates.snapshot().phase, 'available'); assert.equal(driver.downloads, 0);
  assert.equal(updates.installOnQuit(true), false);
  await updates.download(); assert.equal(updates.snapshot().phase, 'ready');
  assert.equal(updates.installOnQuit(false), false);
  assert.equal(updates.installOnQuit(true), true); assert.deepEqual(driver.installs, [[false, true]]);
});
test('automatic updates default to on and apply downloaded updates only on quit', async t => {
  const { updates, driver, path } = await setup(t);
  assert.equal(updates.snapshot().automatic, true);
  await updates.check();
  assert.equal(driver.downloads, 1); assert.equal(driver.installs.length, 0);
  const restored = new DesktopUpdates(new Driver(), path, '0.1.0'); await restored.initialize();
  assert.equal(restored.snapshot().automatic, true);
  assert.equal(updates.installOnQuit(false), true); assert.deepEqual(driver.installs, [[true, false]]);
});
test('unchecking during download prevents automatic installation', async t => {
  const { updates, driver } = await setup(t);
  let complete!: () => void;
  driver.downloadUpdate = () => new Promise<void>(resolve => { complete = () => { driver.emit('update-downloaded'); resolve(); }; });
  await updates.setAutomatic(true);
  const checking = updates.check(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.snapshot().phase, 'downloading');
  await updates.setAutomatic(false); complete(); await checking;
  assert.equal(updates.installOnQuit(false), false); assert.equal(updates.canInstall(), true);
});
test('network failures are retryable and concurrent checks are ignored', async t => {
  const { updates, driver } = await setup(t);
  await updates.setAutomatic(false);
  driver.failure = true; await updates.check(); assert.equal(updates.snapshot().phase, 'error');
  driver.failure = false; await Promise.all([updates.check(), updates.check()]);
  assert.equal(updates.snapshot().phase, 'available'); assert.equal(updates.snapshot().error, undefined);
});
test('preference writes preserve last requested value; development builds stay disabled', async t => {
  const { path } = await setup(t);
  const updates = new DesktopUpdates(undefined, path, '0.1.0');
  await Promise.all([updates.setAutomatic(true), updates.setAutomatic(false)]);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).automatic, false);
  const restored = new DesktopUpdates(new Driver(), path, '0.1.0');
  await restored.initialize();
  assert.equal(restored.snapshot().automatic, false);
  await updates.check(); await updates.download(); assert.equal(updates.snapshot().phase, 'disabled');
});
