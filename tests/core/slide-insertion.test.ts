import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from '../../packages/core/src/source.js';
const code = await readFile(new URL('../../packages/web/slide-insertion.js', import.meta.url), 'utf8');
const { slideInsertionPositions } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const positions = (text: string) => slideInsertionPositions({...parse(text).to_json(), text});
test('insertion excludes the cover and puts append before trailing references', () => {
 assert.deepEqual(positions('## 表紙 {#cover .cover}\n\nタイトル\n\n# 章\n\n## 本文\n\n内容\n\n::: {#refs}\n:::\n'), [1, 2, 3]);
 assert.deepEqual(positions('## 表紙 {#cover .cover}\n\nタイトル\n'), [1]);
 assert.deepEqual(positions('## 本文\n\n内容\n'), [0, 1]);
});
test('insertion rejects malformed metadata and unfinished blocks', () => {
 assert.deepEqual(positions('---\ntitle: [\n---\n\n## 本文\n'), []);
 assert.deepEqual(positions('## 本文\n\n```\nunclosed\n'), []);
 assert.deepEqual(positions('```\nunclosed\n'), []);
 assert.deepEqual(positions('---\ntitle: 空\n---\n'), [0]);
});
