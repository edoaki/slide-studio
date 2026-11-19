import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from '../../packages/core/src/source.js';
const code = (await readFile(new URL('../../packages/web/page-operations.js', import.meta.url), 'utf8')).replace("'./source-prose.js'", JSON.stringify(new URL('../../packages/web/source-prose.js', import.meta.url).href));
const { duplicatePage, togglePageSkip } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const unitsCode = (await readFile(new URL('../../packages/web/block-ops.js', import.meta.url), 'utf8')).replace("'./block-design.js'", JSON.stringify(new URL('../../packages/web/block-design.js', import.meta.url).href));
const { units } = await import(`data:text/javascript;base64,${Buffer.from(unitsCode).toString('base64')}`);
const structure = (s: string) => units(s, parse(s).to_json());
test('duplicate preserves surrounding source, Unicode, notes and distinct IDs', () => {
 const text = '---\ntitle: 絵😀\n---\n\n## A {#first}\n\n::: {#box .note}\nメモ😀\n:::\n\n[参照](#box)\n\n## B {#last}\n\n最後';
 const result = duplicatePage(text, structure(text), 0);
 assert.equal(result.page, 1);
 assert.ok(result.text.startsWith(text.slice(0, text.indexOf('## B'))));
 assert.ok(result.text.endsWith('## B {#last}\n\n最後'));
 assert.match(result.text, /## A \{#first-copy-1\}/); assert.match(result.text, /#box-copy-1 \.note/); assert.match(result.text, /\[参照\]\(#box-copy-1\)/);
 assert.equal(parse(result.text).pages.length, 3);
 const twice = duplicatePage(result.text, structure(result.text), 0);
 assert.match(twice.text, /#first-copy-2/);
});
test('duplicate last page without newline and CRLF headings remains parseable', () => {
 for (const text of ['## A\n\n本文', '## A\r\n\r\n本文\r\n']) {
  const result = duplicatePage(text, structure(text), 0);
  assert.equal(parse(result.text).pages.length, 2);
  assert.match(result.text, /#page-copy-1/);
  if (text.includes('\r')) assert.equal(result.text.replaceAll('\r\n', '').includes('\n'), false);
 }
});
test('skip round-trips page attributes and generated marker pages without losing content', () => {
 for (const text of ['## A {#a .class pdf="1"}\n\n内容😀\n', '## A\r\n\r\n内容\r\n', '::: {#toc}\n:::\n', '::: {#refs}\n:::\n']) {
  const result = togglePageSkip(text, structure(text), 0);
  assert.equal(structure(result.text).pages[0].skipped, true);
  const restored = togglePageSkip(result.text, structure(result.text), 0);
  assert.equal(!!structure(restored.text).pages[0].skipped, false);
  assert.ok(restored.text.includes(text.includes('内容') ? '内容' : ':::'));
 }
});
test('generated and unfinished pages cannot be duplicated', () => {
 for (const text of ['::: {#refs}\n:::\n', '## A\n\n```\nunclosed']) assert.equal(duplicatePage(text, structure(text), 0), null);
});
