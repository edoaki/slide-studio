import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test,{type TestContext} from 'node:test';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import * as library from '../../packages/core/src/legacy-library.js';
import { add } from '../../packages/core/src/legacy-assets.js';
import { new_figure } from '../../packages/core/src/legacy-figures.js';
import { LegacyInsertion } from '../../apps/server/legacy-insertion.js';
function fixture(t:TestContext){const root=mkdtempSync(join(tmpdir(),'legacy-library-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const ws=Workspace.open(join(root,'ws'));ws.new_deck('talk','test');return ws;}
const pandocPath=resolve('resources/pandoc/bin/pandoc');
test('math collection respects Unicode offsets, code spans, topic and current-deck ordering',t=>{const ws=fixture(t);ws.new_deck('other','test');ws.new_deck('outside','other');writeFileSync(ws.qmd('talk'),'---\ntopic: test\n---\n\n## 😀数式\n\n数式 $a+b$ と `$$ignored$$`\n\n$$\na + b\n$$\n\n```tex\n$$code$$\n```\n');writeFileSync(ws.qmd('other'),'---\ntopic: test\n---\n\n## 数式\n\n$$x+y$$\n');const out=library.collect(ws,'talk');assert.deepEqual(out.decks,['talk','other']);assert.deepEqual(out.math,[{tex:'a+b',display:true,count:2,decks:['talk']},{tex:'x+y',display:true,count:1,decks:['other']}]);});
test('native Pandoc renders math preview and batches candidates as MathML',async t=>{const ws=fixture(t);assert.equal(await library.math_html(' ',pandocPath,ws.root),'');assert.match(await library.math_html('\\frac{a}{b}',pandocPath,ws.root),/<math/);const out=await library.math_many(['a+b','a+b','$$bad$$'],pandocPath,ws.root);assert.match(out[0]!,/<math/);assert.equal(out[0],out[1]);assert.equal(out[2],null);});
test('taking images and figures shares a topic or copies safely across topics',async t=>{const ws=fixture(t);ws.new_deck('same','test');ws.new_deck('other','other');add(ws,'talk','plot.png',Buffer.from('png'));assert.equal((await library.take(ws,'same','image','talk','images/plot.png')).reused,true);assert.equal((await library.take(ws,'other','image','talk','images/plot.png')).reused,false);assert.equal((await library.take(ws,'other','image','talk','images/plot.png')).reused,true);await new_figure(ws,'chart',ws.shelf_dir('test'));assert.deepEqual(await library.take(ws,'other','figure','talk','chart'),{ref:'other/chart',reused:false});assert.deepEqual(await library.take(ws,'other','figure','talk','chart'),{ref:'other/chart',reused:true});await assert.rejects(library.take(ws,'other','figure','talk','../chart'));symlinkSync(ws.qmd('talk'),join(ws.asset_root('talk'),'images/escape.png'));await assert.rejects(library.take(ws,'other','image','talk','images/escape.png'));});
test('bibliography API edits shared topic entries, verifies and rejects stale edits',async t=>{const ws=fixture(t),changes:string[]=[];const h=new LegacyInsertion({pandocPath,changed:p=>changes.push(p)});writeFileSync(ws.bib('talk'),'@article{key, title={Original}, author={Doe, Jane and Roe, Richard}, year={2025}, slide-studio-status={unverified}}');const request=(method:string,body:unknown=null,query='view=full')=>h.handle(ws,{method,pathname:'/api/deck/talk/bib',body,query:new URLSearchParams(query),bytes:new Uint8Array(),headers:{}});const r=(await request('GET'))!.body as {entries:{raw:string}[]};const original=r.entries[0]!.raw;assert.equal((await request('PATCH',{key:'key',fields:{title:'Edited'},original}))?.status,undefined);assert.equal((await request('PATCH',{key:'key',fields:{title:'Lost'},original}))?.status,400);await request('POST',{key:'key'});const compact=(await request('GET',null,''))!.body as {entries:{title:string;author:string;unverified:boolean}[]};assert.equal(compact.entries[0]?.title,'Edited');assert.equal(compact.entries[0]?.author,'Doe ほか');assert.equal(compact.entries[0]?.unverified,false);assert.equal(changes.length,2);assert.match(readFileSync(ws.bib('talk'),'utf8'),/Edited/);});
test('topic listing tracks cross-deck use and deletes only unused HTML, retaining scripts',async t=>{
 const ws=fixture(t);await new_figure(ws,'chart',ws.shelf_dir('test'));add(ws,'talk','free.html',Buffer.from('<p>free</p>'));
 writeFileSync(ws.qmd('talk'),'---\ntopic: test\n---\n\n## Figure\n\n{{< fig test/chart >}}\n');
 let items=library.topic_listing(ws,'test');assert.deepEqual(items.html.find(i=>i.path==='chart/index.html')?.decks,['talk']);
 assert.throws(()=>library.delete_topic_html(ws,'test',['free.html','chart/index.html']),/htmlInUse/);
 assert.equal(readFileSync(join(ws.shelf_dir('test'),'free.html'),'utf8'),'<p>free</p>');
 const moved=library.delete_topic_html(ws,'test',['free.html']);assert.equal(readFileSync(join(ws.root,moved[0]!.trash),'utf8'),'<p>free</p>');
 assert.ok(readFileSync(join(ws.shelf_dir('test'),'chart/figure.mjs')).length);items=library.topic_listing(ws,'test');assert.equal(items.html.some(i=>i.path==='free.html'),false);
});
test('topic bibliography refuses symlinks instead of writing outside its workspace',async t=>{
 const ws=fixture(t),outside=join(ws.root,'external.bib');writeFileSync(outside,'@article{key,title={Keep}}');rmSync(ws.bib('talk'));symlinkSync(outside,ws.bib('talk'));
 const h=new LegacyInsertion({pandocPath,changed:()=>assert.fail('must not broadcast a rejected write')});
 const result=await h.handle(ws,{method:'POST',pathname:'/api/topic/test/bib/verify',query:new URLSearchParams(),body:{key:'key'},bytes:new Uint8Array(),headers:{}});
 assert.equal(result?.status,400);assert.equal(readFileSync(outside,'utf8'),'@article{key,title={Keep}}');
});
