import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create } from 'tar';
import { Providers } from '../../packages/ai/src/providers.js';
import { Runtime, latestRelease, type Release } from '../../packages/ai/src/runtime.js';

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
