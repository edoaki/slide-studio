import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';

test('portable compiler provisions standalone Node code and keeps user modifications on refresh',t=>{
 const root=mkdtempSync(join(tmpdir(),'studio-portable-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const ws=Workspace.open(root),compiler=join(ws.state,'compiler'),entry=join(compiler,'apps/portable/main.js');
 assert.equal(existsSync(entry),true);assert.equal(existsSync(join(root,'build.mjs')),true);assert.match(readFileSync(join(root,'README.md'),'utf8'),/node build.mjs --setup/);
 const manifest=JSON.parse(readFileSync(join(compiler,'package.json'),'utf8'));assert.ok(manifest.dependencies.electron);assert.ok(manifest.dependencies.yaml);assert.equal(existsSync(join(compiler,'resources/pandoc/manifest.json')),true);
 assert.equal(existsSync(join(compiler,'packages/core/assets/portable')),false,'compiler must not contain itself recursively');
 const before=readFileSync(entry,'utf8');writeFileSync(entry,before+'\n// user customisation\n');writeFileSync(join(root,'build.mjs'),'// custom entry\n');ws.ensure();assert.equal(readFileSync(entry,'utf8'),before+'\n// user customisation\n');assert.equal(readFileSync(join(root,'build.mjs'),'utf8'),'// custom entry\n');
});
