import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parse } from '../../packages/core/src/source.js';
const base = pathToFileURL(resolve('packages/web') + '/').href;
const op = await import(base + 'block-ops.js');
const { duplicateBlock, blockContextActions } = await import(base + 'block-context-model.js');
const structure = (text: string) => ({...op.units(text, parse(text).to_json()), text});

test('block duplicate preserves source outside the copied range and creates unique local anchors', () => {
  const text = '## Page\n\n::: {#example .box}\n[link](#example)\n:::\n\nKeep untouched.\n';
  const st = structure(text), c = st.pages[0].chunks[0];
  const result = duplicateBlock(text, st, c.key);
  assert.ok(result);
  assert.equal(result.text.slice(0, c.end), text.slice(0, c.end));
  assert.equal(result.text.slice(result.end), text.slice(c.end));
  assert.match(result.text.slice(result.at, result.end), /#example-copy/);
  assert.match(result.text.slice(result.at, result.end), /\[link\]\(#example-copy\)/);
  const again = duplicateBlock(result.text, structure(result.text), c.key);
  assert.match(again.text, /#example-copy-2/);
});

test('block context disables unavailable moves and supports delete, reorder, and cross-page movement', () => {
  const text = '## First\n\nAlpha\n\nBeta\n\n## Second\n\nGamma\n';
  const st = structure(text), first = st.pages[0].chunks[0], last = st.pages[0].chunks[1];
  const actions = blockContextActions(text, st, first.key);
  assert.equal(actions.up, null);
  assert.ok(actions.down.text.indexOf('Beta') < actions.down.text.indexOf('Alpha'));
  assert.ok(!actions.remove.text.includes('Alpha'));
  assert.equal(blockContextActions(text, st, last.key).pages[0].enabled, false);
  assert.equal(actions.pages[1].enabled, true);
  const moved = op.move(text, st, first.key, {pageEnd: 1});
  assert.ok(moved.text.indexOf('Alpha') > moved.text.indexOf('Gamma'));
  assert.equal(blockContextActions(text, st, 'missing'), null);
});
test('duplicating blocks does not rewrite example anchors or links inside code', () => {
 const text = '## A\n\n::: {#box}\n[link](#box) and `[link](#box)`\n\n```\n{#box} [link](#box)\n```\n:::\n';
 const st = structure(text), result = duplicateBlock(text, st, st.pages[0].chunks[0].key);
 const copy = result.text.slice(result.at, result.end);
 assert.match(copy, /\[link\]\(#box-copy\) and `\[link\]\(#box\)`/);
 assert.ok(copy.includes('```\n{#box} [link](#box)\n```'));
});
