import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {_electron, type ElectronApplication} from 'playwright-core';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';

const run = promisify(execFile);
const installed = process.env.SLIDE_STUDIO_LIFECYCLE_APP;

test('macOS manual replacement and app-only removal preserve authored data and workspace selection', {
  skip: process.platform !== 'darwin' || !installed?.endsWith('.app'),
  timeout: 180000,
}, async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'studio-lifecycle-')));
  const ws = Workspace.open(join(temp, '日本語 原稿'));
  ws.new_deck('talk', 'test');
  const profile = join(temp, 'profile');
  const application = join(temp, '日本語 Applications', 'Slide Studio.app');
  await mkdir(profile);
  await mkdir(join(temp, '日本語 Applications'));
  await writeFile(join(profile, 'workspaces.json'), JSON.stringify({current: ws.root, recent: [ws.root]}));
  const protectedFiles = [ws.qmd('talk'), join(ws.themes, 'custom.css'), join(ws.deck_dir('talk'), 'references.bib'), join(ws.deck_dir('talk'), 'images', 'keep.bin')];
  await writeFile(protectedFiles[1]!, '/* user theme */\n:root { --accent: #13579b; }\n');
  await writeFile(protectedFiles[2]!, '@book{keep, title={Preserved bibliography}}\n');
  await mkdir(join(ws.deck_dir('talk'), 'images'), {recursive: true});
  await writeFile(protectedFiles[3]!, Buffer.from([0, 255, 1, 128]));
  const originals = await Promise.all(protectedFiles.map(path => readFile(path)));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SLIDE_STUDIO_ELECTRON_HOME = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SLIDE_STUDIO_HOME;
  for (const provider of ['CODEX', 'CLAUDE', 'AGY']) env[`SLIDE_STUDIO_${provider}`] = 'none';
  // A packaged app must resolve its bundled tools independently of developer PATH.
  const emptyPath = join(temp, 'empty-path');
  await mkdir(emptyPath);
  env.PATH = emptyPath;
  let app: ElectronApplication | undefined;
  t.after(async () => { await app?.close(); await rm(temp, {recursive: true, force: true}); });
  const copy = () => run('/usr/bin/ditto', [installed!, application]);
  const launch = async () => {
    app = await _electron.launch({executablePath: join(application, 'Contents/MacOS/Slide Studio'), args: [], env});
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!sessionStorage.getItem('slide-studio:admin-token'));
    await page.locator('.deck-card-wrap[data-deck="talk"]').waitFor();
    await page.goto(new URL('/deck/talk', page.url()).href);
    await page.locator('[data-tab="memo"]').click();
    return page;
  };
  const close = async () => { await app!.close(); app = undefined; };
  const preserved = async () => {
    for (const [index, path] of protectedFiles.entries()) assert.deepEqual(await readFile(path), originals[index], path);
    assert.equal(JSON.parse(await readFile(join(profile, 'workspaces.json'), 'utf8')).current, ws.root);
  };
  await copy();
  let page = await launch();
  await page.locator('.memo-input').fill('再インストール後にも残す原稿。');
  // Closing immediately exercises the ordinary autosave/quit path.
  await close();
  const memo = await readFile(ws.memo('talk'));
  assert.match(memo.toString(), /再インストール後にも残す原稿/);
  await preserved();

  const previous = join(temp, 'previous.app');
  await rename(application, previous);
  await copy();
  page = await launch();
  assert.match(await page.locator('.memo-input').inputValue(), /再インストール後にも残す原稿/);
  await close();
  assert.deepEqual(await readFile(ws.memo('talk')), memo);
  await preserved();

  // Simulate Finder's app-only removal. Do not remove userData or the workspace.
  await rm(application, {recursive: true});
  await preserved();
  await copy();
  page = await launch();
  assert.match(await page.locator('.memo-input').inputValue(), /再インストール後にも残す原稿/);
  await close();
  assert.deepEqual(await readFile(ws.memo('talk')), memo);
  await preserved();
});
