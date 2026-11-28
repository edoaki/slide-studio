import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
// The renderer remains plain JavaScript; load its pure list logic without a TS declaration shim.
const source=await readFile(new URL('../../../packages/web/home-list.js',import.meta.url),'utf8');
const {presentationList}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const items=[{deck:'b',title:'Beta 10',shelf:'research',opened:3,modified:1},{deck:'a',title:'Ａlpha',shelf:'work',opened:1,modified:4},{deck:'c',title:'Beta 2',shelf:'research',opened:2,modified:2}];
const names=(rows:typeof items)=>rows.map(i=>i.deck);
test('home supports recent, modified, title and topic sort with numeric titles',()=>{
 assert.deepEqual(names(presentationList(items)),['b','c','a']);assert.deepEqual(names(presentationList(items,'modified')),['a','c','b']);assert.deepEqual(names(presentationList(items,'title')),['a','c','b']);assert.deepEqual(names(presentationList(items,'topic')),['c','b','a']);
 assert.deepEqual(names(items),['b','a','c']);
});
