import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { TEMPLATES } from '../../packages/core/src/workspace.js';
import { set_vars, read_vars, restore, PAGE_NUMBER_DEFAULTS } from '../../packages/core/src/theme-edit.js';
import { sha256 } from '../../packages/core/src/encoding.js';
const cases = JSON.parse(readFileSync('tests/fixtures/theme-parity/edit-golden.json','utf8')) as Array<{name:string;theme:string;values:Record<string,string>;sha256:string;again_sha256:string;vars:unknown;restored:boolean;error?:string}>;
const originals = JSON.parse(readFileSync('tests/fixtures/theme-parity/golden.json','utf8')).cases as Array<{name:string;css:string}>;
for (const row of cases) test(`original theme mutation: ${row.name}`, () => {
  const css = originals.find(c=>c.name===`${row.theme}.css`)!.css;
  if (row.error) { assert.throws(()=>set_vars(css,row.values)); return; }
  const changed = set_vars(css,row.values);
  assert.equal(sha256(changed),row.sha256);
  assert.equal(sha256(set_vars(changed,row.values)),row.again_sha256);
  assert.deepEqual(read_vars(changed),{ ...PAGE_NUMBER_DEFAULTS, ...row.vars as Record<string, string> });
  if(row.restored) assert.equal(restore(changed,css),css);
});

test('theme undo refuses unrelated stylesheet changes', () => {
  const css=readFileSync(join(TEMPLATES,'themes/default.css'),'utf8');
  const changed=set_vars(css,{'--ink':'#123456'});
  assert.throws(()=>restore(changed,css+'\nbody {display:none}'));
});


test('page number options round trip, reset, and reject invalid settings', () => {
  const css = readFileSync(join(TEMPLATES, 'themes/default.css'), 'utf8');
  for (const position of ['top-right', 'bottom-right', 'bottom-left']) {
    const values = {'--page-number-format': 'number', '--page-number-position': position, '--page-number-size': '28px'};
    const changed = set_vars(css, values);
    for (const [key, value] of Object.entries(values)) assert.equal(read_vars(changed)[key], value);
    assert.match(changed, /font-size:28px/);
    assert.match(changed, /page-number-total \{ display:none/);
    assert.equal(set_vars(changed, values), changed);
    assert.equal(restore(changed, css), css);
    assert.equal(restore(css, changed), changed);
    assert.equal(set_vars(changed, PAGE_NUMBER_DEFAULTS), css);
    assert.throws(() => restore(css, changed.replace('font-size:28px', 'font-size:99px')));
  }
  for (const [key, value] of [['--page-number-format', 'bad'], ['--page-number-position', 'left'], ['--page-number-size', '7px'], ['--page-number-size', '61px'], ['--page-number-size', '12px; color:red']]) {
    assert.throws(() => set_vars(css, {[key!]: value}));
  }
});
