import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { manuscriptMatches: find, replaceManuscriptMatches: replace } = await import(pathToFileURL(resolve('packages/web/manuscript-search-model.js')).href);

test('search scans the full manuscript and maps matches to authored pages, ignoring code and nested headings', () => {
  const text = '---\ntitle: target\n---\n\n# Chapter\n\ntarget 😀\n\n```md\n## fake\ntarget\n```\n\n::: {.box}\n## fake too\ntarget\n:::\n\n## Next\n\nTARGET';
  const found = find(text, 'target');
  assert.deepEqual(found.map((m: {page: number}) => m.page), [-1, 0, 0, 0, 1]);
  assert.deepEqual(found.map((m: {start: number; end: number}) => text.slice(m.start, m.end)), ['target','target','target','target','TARGET']);
  assert.equal(find(text, 'target', {caseSensitive: true}).length, 4);
});

test('search treats regex punctuation literally and keeps Unicode UTF-16 offsets', () => {
  const text = '## 😀\n\n[.*] İ I ı i 😀';
  assert.equal(find(text, '[.*]')[0].start, text.indexOf('[.*]'));
  const matches = find(text, 'i');
  assert.deepEqual(matches.map((m: {start: number}) => m.start), [text.indexOf(' I ') + 1, text.indexOf(' i ') + 1]);
  assert.equal(find(text, '').length, 0);
  assert.equal(find('aaaa', 'aa').length, 2);
});

test('replace uses literal replacement text and original non-overlapping ranges without normalizing source', () => {
  const text = '---\ntitle: X\n---\n\n## X\n\nX\n\n\n';
  const matches = find(text, 'X');
  assert.equal(replace(text, matches, '$&😀'), '---\ntitle: $&😀\n---\n\n## $&😀\n\n$&😀\n\n\n');
  assert.equal(replace(text, [matches[1]], ''), '---\ntitle: X\n---\n\n## \n\nX\n\n\n');
  assert.equal(replace(text.replace('X', 'Y'), matches, 'Z'), null);
  assert.equal(replace(text, [matches[0], matches[0]], 'Z'), null);
});
