import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';

// 選択欄は custom-select.js の <studio-select> を使い、OS 標準の <select> を画面に出さない（T-19）。
// 例外を足すときは理由を書く。許可した file が使わなくなったら失敗するので、そのときは外す。
const ALLOWED = new Set<string>();
// <select …>、createElement('select') や el('select') のような作り方、<select> 専用の API
const NATIVE = [/<select[\s>]/i, /\b(?:createElement|el)\(\s*['"`]select['"`]\s*[,)]/, /new Option\(/, /HTMLSelectElement/, /\.selectedOptions\b/];

test('the UI never renders a native <select>', async () => {
  const root = new URL('../../packages/web/', import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter(name => /\.(js|html)$/.test(name)).map(name => name.split('\\').join('/'));
  assert.ok(files.includes('custom-select.js'));
  const found: string[] = [];
  for (const name of files) {
    const text = await readFile(new URL(name, root), 'utf8');
    const hit = NATIVE.find(pattern => pattern.test(text));
    if (ALLOWED.has(name)) assert.ok(hit, `${name} no longer uses a native <select>; remove it from ALLOWED`);
    else if (hit) found.push(`${name}: ${hit}`);
  }
  assert.deepEqual(found, [], 'use <studio-select> from packages/web/custom-select.js instead of a native <select>');
});
