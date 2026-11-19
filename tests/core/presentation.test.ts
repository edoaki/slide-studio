import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from '../../packages/core/src/source.js';
const code = await readFile(new URL('../../packages/web/presentation-model.js', import.meta.url), 'utf8');
const { replaceNote, countedSlides, RehearsalClock, noteText } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('rehearsal counts revisits and fragments, excludes paused time and unvisited pages', () => {
 let now=0; const c=new RehearsalClock(()=>now); c.start(); now=1000;c.go(0);now=3000;c.go(1);now=4000;c.pause();now=9000;c.go(0);c.start();now=10000;c.pause();
 assert.equal(c.elapsed,5000);assert.equal(c.times.get(0),4000);assert.equal(c.times.get(1),1000);assert.equal(c.times.has(2),false);
});
test('progress only counts level two pages up to references or chosen endpoint',()=>{
 const pages=[{index:0,level:1,title:'章'},{index:1,level:2,title:'本文'},{index:2,level:2,title:'参考文献',generated:'refs'},{index:3,level:2,title:'補足'}];
 const slides=pages.map(p=>({index:p.index,page:p.index}));
 assert.deepEqual(countedSlides(slides,pages),[1]);assert.deepEqual(countedSlides(slides,pages,Infinity),[1,3]);assert.deepEqual(countedSlides(slides,pages,0),[]);
});
test('speaker note edits preserve surrounding source and fence embedded markdown',()=>{
 const text='---\ntitle: 絵😀\n---\n\n## ページ\n\n本文\n';
 const next=replaceNote(text,[],text.length,'メモ😀\n::: {.box}\n## 見出し\n:::');
 assert.ok(next.startsWith(text));assert.match(next,/:::: \{\.note\}/);const doc=parse(next);assert.equal(doc.pages.length,1);
 const chunk=doc.pages[0]!.chunks.at(-1)!;assert.ok(chunk.open);assert.ok(chunk.close);
 const unit=(n:number)=>Array.from(next).slice(0,n).join('').length;
 const c={start:unit(chunk.start),end:unit(chunk.end),openEnd:unit(chunk.open![1]),closeStart:unit(chunk.close![0]),close:'::::'};
 assert.match(noteText(next,[c]),/^メモ😀/);
 const updated=replaceNote(next,[c],0,'変更');assert.ok(updated.startsWith(text));assert.match(updated,/変更\n~~~/);assert.equal(parse(updated).pages.length,1);const crlf=text.replaceAll('\n','\r\n');assert.ok(replaceNote(crlf,[],crlf.length,'メモ').startsWith(crlf));
});

test('rehearsal records group rendered reference pages and retain unvisited pages, excluding skips', async () => {
 const {rehearsalRecord} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
 const c = new RehearsalClock(); c.elapsed=4500;c.times=new Map([[0,1000],[1,2000],[2,1500]]);
 const pages=[{id:'intro',title:'本文'},{id:'refs',title:'文献'},{id:'later',title:'補足'},{id:'skip',title:'非表示',skipped:true}];
 const slides=[{id:'intro',page:0,index:0},{id:'refs',page:1,index:1},{id:'refs-2',page:1,index:2},{id:'later',page:2,index:3},{id:'skip',page:3,index:4}];
 const record=rehearsalRecord(c,slides,pages,'2026-11-18T00:00:00Z');
 assert.deepEqual(record.pages.map((p:any)=>[p.id,p.ms,p.visited]),[['intro',1000,true],['refs',3500,true],['later',0,false]]);

});
test('progress excludes skipped pages even when counting through the final page',()=>{
 const pages=[{index:0,level:2,title:'本文'},{index:1,level:2,title:'非表示',skipped:true},{index:2,level:2,title:'最後'}];
 assert.deepEqual(countedSlides(pages.map(p=>({index:p.index,page:p.index})),pages,Infinity),[0,2]);
});
