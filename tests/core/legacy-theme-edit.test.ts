import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { TEMPLATES } from '../../packages/core/src/legacy-workspace.js';
import { set_vars, read_vars, restore } from '../../packages/core/src/legacy-theme-edit.js';
import { sha256 } from '../../packages/core/src/source.js';
const cases = JSON.parse(readFileSync('tests/fixtures/theme-parity/edit-golden.json','utf8')) as Array<{name:string;theme:string;values:Record<string,string>;sha256:string;again_sha256:string;vars:unknown;restored:boolean;error?:string}>;
const originals = JSON.parse(readFileSync('tests/fixtures/theme-parity/golden.json','utf8')).cases as Array<{name:string;css:string}>;
for (const row of cases) test(`original theme mutation: ${row.name}`, () => {
  const css = originals.find(c=>c.name===`${row.theme}.css`)!.css;
  if (row.error) { assert.throws(()=>set_vars(css,row.values)); return; }
  const changed = set_vars(css,row.values);
  assert.equal(sha256(changed),row.sha256);
  assert.equal(sha256(set_vars(changed,row.values)),row.again_sha256);
  assert.deepEqual(read_vars(changed),row.vars);
  if(row.restored) assert.equal(restore(changed,css),css);
});

test('theme undo refuses unrelated stylesheet changes', () => {
  const css=readFileSync(join(TEMPLATES,'themes/default.css'),'utf8');
  const changed=set_vars(css,{'--ink':'#123456'});
  assert.throws(()=>restore(changed,css+'\nbody {display:none}'));
});
