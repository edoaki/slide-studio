import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openWorkspace} from '../../apps/server/workspace-service.js';

test('first-run tutorial is separate from blank decks and never replaces user edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-tutorial-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const first = await openWorkspace(root, {sample: true});
  const ws = first.workspace;
  try {
    const source = await readFile(ws.qmd('sample'), 'utf8');
    assert.match(source, /## クリック1回で選ぶ、2回で書く/);
    assert.match(source, /## ⇧WASD で並べ替える/);
    assert.match(source, /## 余白は内側と外側/);
    assert.match(source, /\.incremental/);
    assert.match(source, /\[@knuth1984\]/);
    assert.match(source, /## 発表して、書き出す/);
    const bib = await readFile(ws.bib('sample'), 'utf8');
    assert.match(bib, /@book\{knuth1984,/);
    assert.match(bib, /slide-studio-status = \{unverified\}/);
    assert.doesNotMatch(source, /<svg|\{\{IMAGE\}\}|\{\{TOPIC\}\}/);
    assert.match(source, /images\/tutorial-workflow\.svg/);
    assert.match(source, /\{\{< fig sample\/tutorial-flow >\}\}/);
    assert.match(await readFile(join(ws.images_dir('sample'), 'tutorial-workflow.svg'), 'utf8'), /<svg/);
    assert.match(await readFile(join(ws.shelf_dir('sample'), 'tutorial-flow', 'index.html'), 'utf8'), /mount\(figure\)/);
    assert.match(await readFile(join(ws.deck_dir('sample'), 'materials', '発表づくりのメモ.txt'), 'utf8'), /AIへの依頼例/);
    const originalFigure = await readFile(join(ws.shelf_dir('sample'), 'tutorial-flow', 'figure.mjs'), 'utf8');
    ws.new_deck('another', 'sample', 'default', null, '別のガイド', 'tutorial');
    assert.match(await readFile(ws.qmd('another'), 'utf8'), /sample\/tutorial-flow-2/);
    assert.match(await readFile(ws.qmd('another'), 'utf8'), /images\/tutorial-workflow-2\.svg/);
    assert.equal(await readFile(join(ws.shelf_dir('sample'), 'tutorial-flow', 'figure.mjs'), 'utf8'), originalFigure);
    assert.equal((await readFile(ws.bib('sample'), 'utf8')).match(/@book\{knuth1984,/g)?.length, 1);
    assert.equal(ws.deck_meta('sample').topic, 'sample');
    ws.new_deck('mine', 'research');
    assert.equal(ws.is_blank('mine'), true);
    await writeFile(ws.qmd('sample'), source + '\n利用者が書いたメモ。\n');
  } finally { await first.close(); }
  const second = await openWorkspace(root, {sample: true});
  try {
    assert.match(await readFile(second.workspace.qmd('sample'), 'utf8'), /利用者が書いたメモ。/);
    assert.equal(second.workspace.list_decks().length, 3);
  } finally { await second.close(); }
});
