import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { _electron, chromium, type ElectronApplication, type Browser } from 'playwright-core';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
const require = createRequire(import.meta.url);
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('browser mode serves the same editor to Chrome and exports through the bundled renderer', {timeout: 90000, skip: !existsSync(chrome)}, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'studio-browser-')), profile = join(temp, 'profile');
  const ws = Workspace.open(join(temp, 'workspace')); ws.new_deck('talk', 'test');
  await writeFile(ws.qmd('talk'), '---\ntitle: ブラウザー版\ntopic: test\ntheme: default\n---\n\n## 本文 {#intro}\n\nブラウザーから編集する本文。\n');
  let app: ElectronApplication | undefined, browser: Browser | undefined;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(temp, {recursive: true, force: true}); });
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {SLIDE_STUDIO_ELECTRON_HOME: profile, SLIDE_STUDIO_CODEX: 'none', SLIDE_STUDIO_CLAUDE: 'none', SLIDE_STUDIO_AGY: 'none'});
  app = await _electron.launch({executablePath: require('electron'), args: [join(process.cwd(), 'dist/apps/desktop/main.js'), '--studio-browser', '--root', ws.root, '--port', '0', '--no-browser'], env});
  let bootstrap = '';
  for (let attempt = 0; attempt < 100; attempt++) { try { bootstrap = await readFile(join(profile, 'browser-connection.html'), 'utf8'); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
  const url = /href="([^"]+)"/u.exec(bootstrap)?.[1]; assert.ok(url);
  browser = await chromium.launch({executablePath: chrome, headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 860}, acceptDownloads: true}), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.locator('.deck-card-wrap[data-deck=talk] .card').click();
  await page.locator('#stage[data-blocks=ready]').waitFor();
  const frame = page.frameLocator('#slideBox > iframe:not(.loading)');
  const paragraph = frame.locator('.slide.active [data-slide-studio]').filter({hasText: 'ブラウザーから編集する本文。'});
  await paragraph.click(); await paragraph.click();
  const editing = frame.locator('.slide-studio-editing'); await editing.fill('Chromeで編集して保存した本文。'); await editing.press('Escape');
  for (let attempt = 0; attempt < 100; attempt++) { if ((await readFile(ws.qmd('talk'), 'utf8')).includes('Chromeで編集')) break; await new Promise(r => setTimeout(r, 50)); }
  assert.match(await readFile(ws.qmd('talk'), 'utf8'), /Chromeで編集して保存した本文/);
  await page.getByRole('button', {name: '書き出し', exact: true}).click();
  const download = page.waitForEvent('download');
  await page.locator('.output-popover [data-format=html]').click();
  const saved = join(temp, 'export.html'); await (await download).saveAs(saved);
  assert.match(await readFile(saved, 'utf8'), /Chromeで編集して保存した本文/);
  await page.screenshot({path: '/tmp/slide-studio-desktop/browser-original-ui.png'});
  assert.deepEqual(errors, []);
});
