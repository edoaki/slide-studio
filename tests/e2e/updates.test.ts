import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright-core';
const require = createRequire(import.meta.url);

test('home update controls display native availability and manual/automatic states', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'studio-update-ui-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env.SLIDE_STUDIO_ELECTRON_HOME = join(temp, 'profile');
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: require('electron'), args: [join(process.cwd(), 'dist/apps/desktop/main.js')], env });
  t.after(async () => { await app.close(); await rm(temp, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const panel = page.locator('.home-updates');
  await panel.getByText('このビルドはアプリ内更新に対応していません。').waitFor();
  assert.equal(await panel.locator('input').isDisabled(), true);
  const unauthorized = await page.evaluate(async () => (await fetch('/api/updates')).status);
  assert.equal(unauthorized, 401);
  let state = { version: '0.1.0', availableVersion: '0.2.0', automatic: false, phase: 'available', progress: 0 };
  const actions: string[] = [];
  await page.route('**/api/updates', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); actions.push(body.action);
      if (body.action === 'automatic') state.automatic = body.value;
      if (body.action === 'download') state.phase = 'ready';
    }
    await route.fulfill({ json: state });
  });
  await panel.getByText('バージョン 0.2.0 に更新できます。').waitFor();
  await panel.getByRole('button', { name: '更新する', exact: true }).click();
  await panel.getByRole('button', { name: '再起動して更新' }).waitFor();
  await panel.locator('input').check();
  await panel.getByText('更新の準備ができました。アプリの終了時に適用します。').waitFor();
  await panel.locator('input').uncheck();
  await panel.getByText('更新の準備ができました。「再起動して更新」で適用します。').waitFor();
  await panel.getByRole('button', { name: '再起動して更新' }).click();
  assert.deepEqual(actions, ['download', 'automatic', 'automatic', 'install']);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/slide-studio-updates.png' });
});
