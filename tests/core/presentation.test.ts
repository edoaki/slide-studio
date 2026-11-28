import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from '../../packages/core/src/source.js';
const code = await readFile(new URL('../../packages/web/presentation-model.js', import.meta.url), 'utf8');
const { replaceNote, countedSlides, PresentationClock, noteText, pointerPrefs, pointerDiameter, slideBox } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('presentation clock excludes paused time', () => {
 let now=0; const c=new PresentationClock(()=>now); c.start(); now=4000;c.pause();now=9000;c.start();now=10000;c.tick();
 assert.equal(c.elapsed,5000);assert.equal(c.running,true);
});
test('progress only counts level two pages up to references or a chosen page count',()=>{
 const pages=[{index:0,level:1,title:'章'},{index:1,level:2,title:'本文'},{index:2,level:2,title:'参考文献',generated:'refs'},{index:3,level:2,title:'補足'}];
 const slides=pages.map(p=>({index:p.index,page:p.index}));
 assert.deepEqual(countedSlides(slides,pages),[1]);assert.deepEqual(countedSlides(slides,pages,Infinity),[1,3]);assert.deepEqual(countedSlides(slides,pages,0),[]);
 // A page count skips chapter title pages and the references, so two pages reach past the references.
 assert.deepEqual(countedSlides(slides,pages,1),[1]);assert.deepEqual(countedSlides(slides,pages,2),[1,3]);
 const written=[{index:0,level:2,title:'本文'},{index:1,level:2,title:'参考文献'},{index:2,level:2,title:'補足'}];
 const split=[{index:0,page:0},{index:1,page:0},{index:2,page:1},{index:3,page:2}];
 assert.deepEqual(countedSlides(split,written),[0,1]);assert.deepEqual(countedSlides(split,written,1),[0,1]);assert.deepEqual(countedSlides(split,written,2),[0,1,3]);
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

test('progress excludes skipped pages even when counting through the final page',()=>{
 const pages=[{index:0,level:2,title:'本文'},{index:1,level:2,title:'非表示',skipped:true},{index:2,level:2,title:'最後'}];
 assert.deepEqual(countedSlides(pages.map(p=>({index:p.index,page:p.index})),pages,Infinity),[0,2]);
});
test('pointer prefs fall back to the defaults and keep only known choices',()=>{
 assert.deepEqual(pointerPrefs(undefined),{enabled:true,style:'dot',color:'red',size:'medium'});
 assert.deepEqual(pointerPrefs({enabled:false,style:'glow',color:'blue',size:'large'}),{enabled:false,style:'glow',color:'blue',size:'large'});
 // Shapes that no longer exist fall back to the dot.
 assert.equal(pointerPrefs({style:'ring'}).style,'dot');assert.equal(pointerPrefs({style:'spotlight'}).style,'dot');
 assert.deepEqual(pointerPrefs({enabled:'no',style:'laser',color:'toString',size:9,extra:1}),{enabled:true,style:'dot',color:'red',size:'medium'});
 assert.ok(pointerDiameter(pointerPrefs({style:'dot',size:'small'}))<pointerDiameter(pointerPrefs({style:'dot',size:'large'})));
 assert.ok(pointerDiameter(pointerPrefs({style:'glow'}))>pointerDiameter(pointerPrefs({style:'dot'})));
 assert.ok(pointerDiameter(pointerPrefs({style:'highlight'}))>pointerDiameter(pointerPrefs({style:'glow'})));
});
test('slide box letterboxes the 1280x720 slide like the player',()=>{
 assert.deepEqual(slideBox(1280,720),{scale:1,left:0,top:0});
 assert.deepEqual(slideBox(1920,1200),{scale:1.5,left:0,top:60});
 assert.deepEqual(slideBox(1000,360),{scale:.5,left:180,top:0});
});
