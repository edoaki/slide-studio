import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {recordMainError} from '../../apps/desktop/main-log.js';

test('main log rotates and redacts credentials in exception stacks', t => {
  const dir = mkdtempSync(join(tmpdir(),'studio-log-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,'main.log');
  const previous = 'x'.repeat(512 * 1024);
  writeFileSync(path,previous);
  recordMainError(dir,'startup',new Error('secret-token'),s=>s.replaceAll('secret-token','[redacted]'));
  assert.equal(readFileSync(path+'.1','utf8'),previous);
  const entry=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(entry.event,'startup');
  assert.match(entry.detail,/\[redacted\]/);
  assert.ok(!entry.detail.includes('secret-token'));
});
