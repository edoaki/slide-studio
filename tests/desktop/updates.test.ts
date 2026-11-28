import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopUpdates, isNewerRelease } from '../../apps/desktop/updates.js';
const release = (tag = 'v0.2.0') => ({ tag_name: tag, draft: false, prerelease: false, assets: [{ name: `Slide-Studio-${tag}-mac-arm64.dmg` }] });
const request = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });

test('compares numeric stable versions and rejects prereleases and malformed tags', () => {
  assert.equal(isNewerRelease('v0.10.0', '0.9.0'), true);
  for (const tag of ['v0.1.0', 'v0.0.9', 'v0.2.0-beta.1', 'latest', 'v00.2.0']) assert.equal(isNewerRelease(tag, '0.1.0'), false);
});
test('finds a public release without downloading or installing', async () => {
  const urls: string[] = [];
  const updates = new DesktopUpdates('0.1.0', async (url, options) => {
    urls.push(String(url)); assert.ok(options?.signal);
    return request(release())(url, options);
  });
  const state = await updates.check();
  assert.equal(state.phase, 'available'); assert.equal(state.availableVersion, '0.2.0');
  assert.deepEqual(urls, ['https://api.github.com/repos/edoaki/slide-studio/releases/latest']);
});
test('handles no published release and releases without installers', async () => {
  for (const fetcher of [request({}, 404), request({ ...release(), assets: [] })]) {
    assert.equal((await new DesktopUpdates('0.1.0', fetcher).check()).phase, 'unpublished');
  }
});
test('same and older releases never prompt a downgrade', async () => {
  for (const tag of ['v0.1.0', 'v0.0.9']) assert.equal((await new DesktopUpdates('0.1.0', request(release(tag))).check()).phase, 'current');
});
test('errors retain a known update; successful rechecks clear stale notices', async () => {
  let response = request(release());
  const updates = new DesktopUpdates('0.1.0', (...args) => response(...args));
  await updates.check();
  response = request({}, 403);
  assert.equal((await updates.check()).phase, 'error');
  assert.equal(updates.snapshot().availableVersion, '0.2.0');
  response = request(release('v0.1.0'));
  assert.equal((await updates.check()).phase, 'current');
  assert.equal(updates.snapshot().availableVersion, undefined);
});
test('drafts, prereleases, and malformed responses are not advertised', async () => {
  for (const body of [{ ...release(), draft: true }, { ...release(), prerelease: true }, {}, null]) {
    assert.equal((await new DesktopUpdates('0.1.0', request(body)).check()).phase, 'error');
  }
});
test('launch checks only once and concurrent checks do not duplicate requests', async t => {
  let calls = 0, complete!: (response: Response) => void;
  const updates = new DesktopUpdates('0.1.0', () => { calls++; return new Promise(resolve => { complete = resolve; }); });
  t.after(() => updates.stop());
  updates.start(); updates.start(); await updates.check();
  assert.equal(calls, 1);
  complete(new Response(JSON.stringify(release())));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.snapshot().phase, 'available');
});
