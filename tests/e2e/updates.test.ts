import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright-core';
const require = createRequire(import.meta.url);

test('home update controls link to manual release downloads', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'studio-update-ui-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env.SLIDE_STUDIO_ELECTRON_HOME = join(temp, 'profile');
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: require('electron'), args: [join(process.cwd(), 'dist/apps/desktop/main.js')], env });
  t.after(async () => { await app.close(); await rm(temp, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const panel = page.locator('.home-updates');
  assert.equal(await panel.locator('input').count(), 0);
  const unauthorized = await page.evaluate(async () => (await fetch('/api/updates')).status);
  assert.equal(unauthorized, 401);
  let state = { version: '0.1.0', availableVersion: '0.2.0', phase: 'available' };
  const actions: string[] = [];
  await page.route('**/api/updates', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); actions.push(body.action);
    }
    await route.fulfill({ json: state });
  });
  await panel.getByText('バージョン 0.2.0 に更新できます。').waitFor();
  assert.equal(await panel.getByRole('link', {name: 'ダウンロードページを開く'}).getAttribute('href'), 'https://github.com/edoaki/slide-studio/releases');
  await panel.getByRole('button', {name: '更新を確認', exact: true}).click();
  assert.deepEqual(actions, ['check']);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/slide-studio-updates.png' });
});
