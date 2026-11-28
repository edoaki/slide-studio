import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WindowStateStore, parseWindowState, placeWindow } from '../../apps/desktop/window-state.js';

const primary = { x: 0, y: 25, width: 1440, height: 875 };
const right = { x: 1440, y: 0, width: 1920, height: 1080 };
const minimum = { width: 900, height: 600 };

test('saved bounds that fit stay where they were', () => {
  assert.deepEqual(placeWindow({ x: 100, y: 80, width: 1000, height: 700 }, [primary, right], minimum), { x: 100, y: 80, width: 1000, height: 700 });
  assert.deepEqual(placeWindow({ x: 1600, y: 100, width: 1200, height: 800 }, [primary, right], minimum), { x: 1600, y: 100, width: 1200, height: 800 });
});

test('a window that hangs off an edge is pulled fully inside the display it overlaps most', () => {
  assert.deepEqual(placeWindow({ x: 1000, y: 500, width: 1000, height: 700 }, [primary], minimum), { x: 440, y: 200, width: 1000, height: 700 });
  // Mostly on the right display: stays there, clamped to its top-left.
  assert.deepEqual(placeWindow({ x: 1300, y: -200, width: 1000, height: 700 }, [primary, right], minimum), { x: 1440, y: 0, width: 1000, height: 700 });
});

test('bounds from a disconnected display move to the nearest connected display', () => {
  assert.deepEqual(placeWindow({ x: 3500, y: 100, width: 1200, height: 800 }, [primary], minimum), { x: 240, y: 100, width: 1200, height: 800 });
  assert.deepEqual(placeWindow({ x: -3000, y: -2000, width: 800, height: 500 }, [primary, right], minimum), { x: 0, y: 25, width: 900, height: 600 });
});

test('sizes are clamped to the work area and the minimum never exceeds it', () => {
  assert.deepEqual(placeWindow({ x: 0, y: 0, width: 4000, height: 3000 }, [primary], minimum), { x: 0, y: 25, width: 1440, height: 875 });
  const small = { x: 0, y: 0, width: 800, height: 500 };
  assert.deepEqual(placeWindow({ x: 50, y: 50, width: 1200, height: 900 }, [small], minimum), { x: 0, y: 0, width: 800, height: 500 });
  assert.deepEqual(placeWindow({ x: 10.4, y: 30.6, width: 999.5, height: 700.2 }, [primary], minimum), { x: 10, y: 31, width: 1000, height: 700 });
});

test('missing saved state or displays fall back to the default placement', () => {
  assert.equal(placeWindow(undefined, [primary], minimum), undefined);
  assert.equal(placeWindow({ x: 0, y: 0, width: 1000, height: 700 }, [], minimum), undefined);
});

test('only well-formed saved state is accepted', () => {
  assert.deepEqual(parseWindowState({ x: 1, y: 2, width: 3, height: 4, maximized: true }), { x: 1, y: 2, width: 3, height: 4, maximized: true });
  assert.deepEqual(parseWindowState({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4, maximized: false });
  for (const bad of [null, [], 'x', { x: 1, y: 2, width: 0, height: 4 }, { x: '1', y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: Infinity, height: 4 }, { y: 2, width: 3, height: 4 }]) {
    assert.equal(parseWindowState(bad), undefined, JSON.stringify(bad));
  }
});

test('the store debounces writes, flushes the latest state atomically and ignores broken files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'slide-studio-window-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'window-state.json');
  const store = new WindowStateStore(path, 10_000);
  assert.equal(store.read(), undefined);
  store.schedule({ x: 1, y: 2, width: 900, height: 600, maximized: false });
  store.schedule({ x: 5, y: 6, width: 1000, height: 700, maximized: true });
  await store.flush();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { x: 5, y: 6, width: 1000, height: 700, maximized: true });
  assert.deepEqual(new WindowStateStore(path).read(), { x: 5, y: 6, width: 1000, height: 700, maximized: true });
  await store.flush(); // Nothing pending: no write, no error.
  await writeFile(path, '{broken');
  assert.equal(new WindowStateStore(path).read(), undefined);
});

test('a failed write is logged and never rejects the flush', async t => {
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const store = new WindowStateStore(join(tmpdir(), 'unused-window-state.json'), 10_000, async () => { throw new Error('disk full'); });
  store.schedule({ x: 0, y: 0, width: 900, height: 600, maximized: false });
  await store.flush();
  assert.equal(errors.length, 1);
});
