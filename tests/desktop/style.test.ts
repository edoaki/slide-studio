import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Workspace } from '../../packages/core/src/workspace.js';
import { sourceAdapter, style } from '../../apps/server/history.js';

for (const operation of ['create', 'replace', 'delete'] as const) {
  test(`style rolls back CSS ${operation} when manuscript writing fails`, t => {
    const root = mkdtempSync(join(tmpdir(), 'studio-style-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const ws = Workspace.open(join(root, 'ws'));
    ws.new_deck('talk', 'test');
    const path = join(ws.deck_dir('talk'), 'styles/slides.css');
    const original = Buffer.from('\uFEFF/* original */\r\np { color: red; }\r\n');
    if (operation === 'create') rmSync(path, { force: true });
    else { writeFileSync(path, original); chmodSync(path, 0o640); }
    const adapter = sourceAdapter(ws, 'talk'), snapshot = adapter.read();
    const failure = new Error('ENOSPC: manuscript write failed');
    const body = operation === 'delete'
      ? { css: null, css_base: original.toString('utf8').replaceAll('\r\n', '\n') }
      : { vars: { '--img-pad': '12px' } };
    assert.throws(() => style(ws, 'talk', { ...body, text: snapshot.text + '\nchanged', base: snapshot.version }, {
      read: () => snapshot,
      write: () => { throw failure; },
    }), error => error === failure);
    assert.deepEqual(readFileSync(ws.qmd('talk')), snapshot.bytes);
    if (operation === 'create') assert.equal(existsSync(path), false);
    else {
      assert.deepEqual(readFileSync(path), original);
      assert.equal(lstatSync(path).mode & 0o777, 0o640);
    }
  });
}
