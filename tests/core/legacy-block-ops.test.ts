import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {parse} from '../../packages/core/src/legacy-source.js';
const base=pathToFileURL(resolve('packages/web')+'/').href;
const op=await import(base+'block-ops.js');
const st=async(text:string)=>({...op.units(text,parse(text).to_json()),text});
const fixture=JSON.parse(readFileSync('tests/fixtures/block-ops-parity.json','utf8')) as {cases:Array<{legacy_test:string;script:string;text:string;expected:unknown}>};
for(const [i,row] of fixture.cases.entries())test(`legacy block operations ${row.legacy_test} case ${i+1}`,async()=>{
 const script=row.script.replaceAll("'/web/",`'${base}`);
 const actual=await new Function('op','st','text',`return (async()=>{${script}})()`)(op,st,row.text);
 assert.deepEqual(JSON.parse(JSON.stringify(actual)),row.expected);
});
