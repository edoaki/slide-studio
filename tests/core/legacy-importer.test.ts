import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { add_page_ids, ensure_tail, import_deck } from '../../packages/core/src/legacy-importer.js';
import { parse } from '../../packages/core/src/legacy-source.js';

test('import supplies stable unique page IDs without changing existing IDs or Unicode content', () => {
  const source = '# 日本語😀\n\n## Same\n\n## Same\n\n## 表題  {.wide}\n\n# Appendix {#appendix}\n';
  const text = ensure_tail(add_page_ids(source)), doc = parse(text);
  assert.equal(doc.pages[0]?.title, '日本語😀');
  assert.deepEqual(doc.pages.map(p => p.id), ['chapter-1', 'same', 'same-2', 'page-3', 'references', 'appendix']);
  assert.ok(text.includes('## 表題  {#page-3 .wide}'));
  assert.equal(ensure_tail(add_page_ids(text)), text);
});

test('imports the original NCO fixture with figures, bibliography and source ready for rendering', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-import-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const ws = Workspace.open(root);
  const deck = await import_deck(ws, resolve('tests/fixtures/nco-intro'), 'nco', {name: 'intro'});
  const text = await readFile(join(deck, 'slides.qmd'), 'utf8');
  assert.ok(!text.includes('<iframe'));
  assert.ok(text.includes('{{< fig nco/'));
  assert.ok(parse(text).pages.every(p => !!p.id));
  assert.ok(ws.list_figures('nco').length > 0);
  assert.ok((await readFile(ws.bib('intro'), 'utf8')).length > 0);
  await assert.rejects(import_deck(ws, resolve('tests/fixtures/nco-intro'), 'nco', {name: 'intro'}), /既にあります/);
});

test('import refuses linked input and does not create a partial deck', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-import-links-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'slides.qmd'), '# Test\n');
  await symlink('/tmp', join(source, 'linked'));
  const ws = Workspace.open(join(root, 'workspace'));
  await assert.rejects(import_deck(ws, source, 'topic'), /シンボリックリンク/);
  assert.equal(ws.has_deck('source'), false);
});
