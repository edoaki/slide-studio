import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create } from 'tar';
import { Providers } from '../../packages/ai/src/providers.js';
import { Runtime, latestRelease, compareVersions, type Release } from '../../packages/ai/src/runtime.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'studio-runtime-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const providers = new Providers(join(root, 'ai'), {PATH: ''});
  let payload = Buffer.from('fixture binary');
  let release: Release = {version: '1.0.0', url: 'https://fixture.invalid/binary', algorithm: 'sha256', digest: createHash('sha256').update(payload).digest('hex'), archive: false};
  let reject = false, downloads = 0;
  const runtime = new Runtime(providers, 'claude', {
    release: async () => release,
    fetch: async () => { downloads++; return new Response(new Uint8Array(payload), {status: 200}); },
    accept: async path => { assert.deepEqual(await readFile(path), payload); if (reject) throw Error('cannot start'); },
  });
  const next = (version: string, bad = false) => { payload = Buffer.from('fixture ' + version); release = {...release, version, digest: createHash('sha256').update(payload).digest('hex')}; reject = bad; };
  return {root, providers, runtime, next, downloads: () => downloads, corrupt: () => { release.digest = '0'.repeat(64); }};
}

test('runtime verifies and starts a release before switching; failed update retains current and rollback', async t => {
  const f = await fixture(t);
  const [first, same] = await Promise.all([f.runtime.update(), f.runtime.update()]);
  assert.equal(first, same); assert.equal(f.downloads(), 1);
  assert.equal(f.runtime.state().current, '1.0.0');
  f.next('1.1.0', true); await assert.rejects(f.runtime.update(), /cannot start/);
  assert.equal(f.runtime.state().current, '1.0.0');
  assert.equal((await readFile(first)).toString(), 'fixture binary');
  f.next('1.1.0'); await f.runtime.update();
  assert.equal(f.runtime.state().previous, '1.0.0');
  await f.runtime.rollback(); assert.equal(f.runtime.state().current, '1.0.0');
  assert.equal(f.runtime.state().skip, '1.1.0');
  assert.equal(await f.runtime.update(), first);
  await f.runtime.update(true); assert.equal(f.runtime.state().current, '1.1.0');
  assert.equal(f.downloads(), 3);
});

test('runtime checksum mismatch cannot install a candidate', async t => {
  const f = await fixture(t); f.corrupt();
  await assert.rejects(f.runtime.update(), /検証/);
  assert.equal(f.runtime.state().current, null);
});

test('runtime rejects archive links before activation', async t => {
  const f = await fixture(t), source = join(f.root, 'source'), archive = join(f.root, 'archive.tgz');
  await mkdir(join(source, 'bin'), {recursive: true});
  await writeFile(join(source, 'bin/codex'), 'binary');
  const {symlink} = await import('node:fs/promises');
  await symlink('/tmp', join(source, 'escape'));
  await create({file: archive, cwd: source, gzip: true}, ['bin', 'escape']);
  const bytes = await readFile(archive);
  const runtime = new Runtime(f.providers, 'codex', {
    release: async () => ({version:'1.0.0',url:'https://fixture.invalid/a.tgz',algorithm:'sha256',digest:createHash('sha256').update(bytes).digest('hex'),archive:true}),
    fetch: async () => new Response(new Uint8Array(bytes)), accept: async () => {},
  });
  await assert.rejects(runtime.update(), /不正/);
  assert.equal(runtime.state().current, null);
});

test('release selection requires a platform-specific asset and published digest', async () => {
  const release = await latestRelease('codex', async () => Response.json({tag_name:'rust-v1.2.3',assets:[{name:'codex-package-aarch64-apple-darwin.tar.gz',browser_download_url:'https://example.invalid/codex.tar.gz',digest:'sha256:'+'a'.repeat(64)}]}), undefined, 'darwin', 'arm64');
  assert.equal(release.version, '1.2.3'); assert.equal(release.archive, true);
  await assert.rejects(latestRelease('codex', async () => Response.json({tag_name:'rust-v1.2.3',assets:[]}), undefined, 'darwin', 'arm64'), /配布ファイル/);
});

test('runtime reads terminal CLI versions, refreshes its cache, and reports failures without inventing a version', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  for (const [id, output] of [['codex', 'codex-cli 0.160.0'], ['claude', '2.1.322 (Claude Code)'], ['agy', '1.5.4']] as const) {
    const binary = join(f.root, id), response = join(f.root, `${id}.txt`);
    await writeFile(response, output);
    await writeFile(binary, `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(2);\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(response)}));\n`, {mode: 0o700});
    const providers = new Providers(join(f.root, 'ai'), {...process.env, [`SLIDE_STUDIO_${id.toUpperCase()}`]: binary});
    const runtime = new Runtime(providers, id);
    const info = await runtime.info();
    assert.equal(info.version, output.match(/\d+\.\d+\.\d+/u)![0]);
    assert.equal(info.terminal, true);
    await writeFile(response, 'no version available');
    assert.equal((await runtime.info()).version, info.version);
    assert.equal((await runtime.info(true)).version, null);
    await writeFile(binary, `#!${process.execPath}\nconsole.error('9.9.9'); process.exit(1);\n`);
    assert.equal((await runtime.info()).version, null);
    await writeFile(binary, `#!${process.execPath}\nconsole.error('v1.2.3-beta.1');\n`);
    assert.equal((await runtime.info()).version, '1.2.3-beta.1');
    await rm(binary);
    assert.equal((await runtime.info()).version, null);
  }
});

test('version order follows release order and never treats a prerelease as newer', () => {
  assert.equal(compareVersions('0.171.0', '0.160.0'), 1);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.3-beta.1'), 1);
  assert.equal(compareVersions('1.2.3-beta.2', '1.2.3-beta.10'), -1);
  assert.equal(compareVersions('1.2.3+build.5', '1.2.3'), 0);
});

test('latest-version checks do not postpone the daily automatic update; old state loads compatibly', async t => {
  const f = await fixture(t), day = 86400;
  await f.runtime.update();
  await mkdir(f.runtime.root, {recursive: true});
  const legacy = {current: '1.0.0', previous: null, latest: '1.0.0', checked: Date.now() / 1000, auto: true, skip: null, error: null};
  await writeFile(join(f.runtime.root, 'state.json'), JSON.stringify(legacy));
  assert.equal(f.runtime.state().autoAttempted, 0);
  f.next('1.1.0');
  // Opening settings may check for the latest version; the automatic update still runs.
  await f.runtime.check();
  const now = Date.now() / 1000;
  assert.equal(f.runtime.state().autoAttempted, 0);
  assert.equal(await f.runtime.automatic(undefined, now), true);
  assert.equal(f.runtime.state().current, '1.1.0');
  assert.equal(f.runtime.state().autoAttempted, now);
  assert.ok(f.runtime.state().checked > 0);
  f.next('1.2.0');
  assert.equal(await f.runtime.automatic(undefined, now + day - 1), false);
  assert.equal(f.runtime.state().current, '1.1.0');
  assert.equal(await f.runtime.automatic(undefined, now + day), true);
  assert.equal(f.runtime.state().current, '1.2.0');
  // Never downgrades, and a rolled-back version is not reinstalled automatically.
  f.next('1.0.5');
  assert.equal(await f.runtime.automatic(undefined, now + 2 * day), false);
  assert.equal(f.runtime.state().current, '1.2.0');
  f.next('1.2.0'); await f.runtime.rollback();
  assert.equal(await f.runtime.automatic(undefined, now + 3 * day), false);
  assert.equal(f.runtime.state().current, '1.1.0');
});

test('automatic update retries a failed attempt after an hour and leaves fixed or absent executables alone', async t => {
  const f = await fixture(t), hour = 3600;
  await f.runtime.update();
  const now = Date.now() / 1000;
  f.next('1.1.0', true);
  await assert.rejects(f.runtime.automatic(undefined, now), /cannot start/);
  assert.equal(f.runtime.state().current, '1.0.0');
  assert.equal(await f.runtime.automatic(undefined, now + hour - 1), false);
  f.next('1.1.0');
  assert.equal(await f.runtime.automatic(undefined, now + hour), true);
  assert.equal(f.runtime.state().current, '1.1.0');

  let asked = 0;
  const fixed = new Runtime(new Providers(join(f.root, 'fixed'), {PATH: '', SLIDE_STUDIO_CLAUDE: join(f.root, 'mine')}), 'claude', {release: async () => { asked++; throw Error('must not check'); }});
  assert.equal(await fixed.automatic(), false);
  class Absent extends Providers { override binary() { return null; } }
  const absent = new Runtime(new Absent(join(f.root, 'absent'), {PATH: ''}), 'claude', {release: async () => { asked++; throw Error('must not download'); }});
  assert.equal(await absent.automatic(), false);
  assert.equal(asked, 0);
  await fixed.close(); await absent.close();
});

test('an outdated terminal CLI is replaced by the managed runtime; a current or newer one is kept', {skip: process.platform === 'win32'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-runtime-terminal-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bin = join(root, 'bin'), terminal = join(bin, 'claude'), answer = join(root, 'version.txt');
  await mkdir(bin);
  await writeFile(terminal, `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(answer)}));\n`, {mode: 0o700});
  const payload = Buffer.from('managed claude');
  const release: Release = {version: '0.171.0', url: 'https://fixture.invalid/claude', algorithm: 'sha256', digest: createHash('sha256').update(payload).digest('hex'), archive: false};
  let downloads = 0;
  const make = (name: string) => {
    const providers = new Providers(join(root, name), {PATH: bin});
    return {providers, runtime: new Runtime(providers, 'claude', {release: async () => release, fetch: async () => { downloads++; return new Response(new Uint8Array(payload)); }, accept: async () => {}})};
  };
  const now = Date.now() / 1000;
  for (const version of ['0.171.0', '0.172.0']) {
    await writeFile(answer, `${version} (Claude Code)`);
    const {providers, runtime} = make('keep-' + version);
    assert.equal(await runtime.automatic(undefined, now), false);
    assert.equal(providers.binary('claude'), terminal);
    assert.equal((await runtime.info(true)).update, false);
    await runtime.close();
  }
  assert.equal(downloads, 0);
  await writeFile(answer, '0.160.0 (Claude Code)');
  const {providers, runtime} = make('old');
  await runtime.check();
  assert.equal((await runtime.info(true)).update, true);
  assert.equal(await runtime.automatic(undefined, now), true);
  assert.equal(downloads, 1);
  assert.equal(providers.binary('claude'), join(runtime.root, '0.171.0', 'claude'));
  assert.equal(runtime.state().current, '0.171.0');
  const info = await runtime.info();
  assert.equal(info.terminal, false); assert.equal(info.version, '0.171.0'); assert.equal(info.update, false);
  await runtime.close();
});
