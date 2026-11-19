#!/usr/bin/env node
// Build, check and install the working tree into the locally used macOS app.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0
      ? resolvePromise(output.trim())
      : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

async function runningApps() {
  const output = await run('/bin/ps', ['-axo', 'comm='], { stdio: ['ignore', 'pipe', 'inherit'] });
  const suffix = '/Contents/MacOS/Slide Studio';
  return [...new Set(output.split('\n').map(line => line.trim())
    .filter(line => line.endsWith(suffix)).map(line => line.slice(0, -suffix.length)))];
}

export function selectApp(explicit, running, installed) {
  if (explicit) return resolve(explicit);
  if (running.length === 1) return running[0];
  if (running.length > 1 || installed.length > 1) {
    throw new Error('更新先が複数あります。--app /path/to/Slide Studio.app で指定してください。');
  }
  return installed[0] ?? join(homedir(), 'Applications', 'Slide Studio.app');
}

// Keep the old bundle, and restore it if promoting the staged bundle fails.
export async function replaceBundle(staged, destination, backup) {
  const hadApp = existsSync(destination);
  if (hadApp) await rename(destination, backup);
  try {
    await rename(staged, destination);
  } catch (error) {
    if (hadApp) await rename(backup, destination);
    throw error;
  }
  return hadApp;
}

const usage = 'Usage: npm run update:app [-- --app /path/to/Slide Studio.app] [--e2e] [--install-deps]';

export function parseOptions(args) {
  const options = { app: undefined, e2e: false, installDeps: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--e2e') options.e2e = true;
    else if (args[i] === '--install-deps') options.installDeps = true;
    else if (args[i] === '--app' && args[i + 1] && !args[i + 1].startsWith('--') && !options.app) options.app = args[++i];
    else throw new Error(usage);
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(`${usage}\nBuild, back up, replace and launch the local macOS app. --e2e runs visible UI tests.`);
    return;
  }
  const options = parseOptions(args);
  if (process.platform !== 'darwin') throw new Error('この更新スクリプトはmacOS用です。');
  const candidates = [join(homedir(), 'Applications', 'Slide Studio.app'), '/Applications/Slide Studio.app'];
  const destination = selectApp(options.app, await runningApps(), candidates.filter(existsSync));
  if (!destination.endsWith('/Slide Studio.app') || destination.startsWith(join(root, 'release') + '/')) {
    throw new Error(`インストール先の Slide Studio.app を指定してください: ${destination}`);
  }
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const lock = join(parent, '.slide-studio-update.lock');
  await mkdir(lock).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`更新中、または前回の処理が中断されています: ${lock}`);
    throw error;
  });
  let staging;
  try {
    console.log(`更新先: ${destination}`);
    if (options.installDeps || !existsSync(join(root, 'node_modules'))) await run('npm', ['ci']);
    await run('npm', ['run', 'dist:mac']);
    const built = join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Slide Studio.app');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', built]);
    // Visible UI automation is opt-in; routine updates must not take focus.
    if (options.e2e) await run(process.execPath, ['--test', '--test-concurrency=1',
      'dist/tests/e2e/desktop.test.js', 'dist/tests/e2e/workflow.test.js'], {
      env: { ...process.env, SLIDE_STUDIO_TEST_APP: built },
    });
    staging = await mkdtemp(join(parent, '.slide-studio-update-'));
    const staged = join(staging, 'Slide Studio.app');
    await run('/usr/bin/ditto', [built, staged]);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
    if ((await runningApps()).includes(destination)) {
      console.log('保存処理を伴う通常の終了を要求しています。終了できなければ更新を中止します。');
      await run('/usr/bin/osascript', ['-e',
        'on run argv\n tell application (item 1 of argv) to quit\nend run', destination]);
      const deadline = Date.now() + 60_000;
      while ((await runningApps()).includes(destination)) {
        if (Date.now() >= deadline) throw new Error('アプリが終了しなかったため、置き換えを中止しました。');
        await delay(500);
      }
    }
    const backupDir = await mkdtemp(join(parent, '.slide-studio-backup-'));
    const backup = join(backupDir, 'Slide Studio.app');
    const backedUp = await replaceBundle(staged, destination, backup);
    if (backedUp) console.log(`前のアプリ: ${backup}`);
    else await rm(backupDir, { recursive: true });
    await run('/usr/bin/open', ['-g', destination]);
    await delay(2000);
    if (!(await runningApps()).includes(destination)) {
      throw new Error(`更新済みアプリの起動を確認できませんでした。バックアップ: ${backup}`);
    }
    console.log(`更新・起動完了: ${destination}`);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
