import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../../packages/core/src/workspace.js';
import { parse } from '../../packages/core/src/source.js';
import { readAsset } from '../../packages/core/src/assets.js';
import { OutputService, static_issues, version } from '../../apps/server/output.js';
import type { RenderedDeck } from '../../packages/contracts/src/server.js';

test('static checks retain placeholder, missing-image, external-image and required-theme diagnostics', t => {
  const root=mkdtempSync(join(tmpdir(),'studio-static-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const ws=Workspace.open(root);ws.new_deck('talk','topic');
  const placeholders=JSON.parse(/export const PAGE_PLACEHOLDERS = (\{[\s\S]*?\});/u.exec(readAsset('strings.js'))![1]!);
  const source=`---\ntitle: Test\ntopic: topic\ntheme: broken\n---\n\n## Test {#test}\n\n${Object.values(placeholders)[0]}\n\n![](images/missing.png)\n\n![](https://example.invalid/image.png)\n`;
  writeFileSync(join(ws.themes,'broken.css'),':root { --unrelated: red; }');
  const rendered={html:'<main id="stage"><section class="slide"><button onclick="return false">例</button></section></main>',doc:parse(source),slides:[{index:0,page:0}],missing_cites:[],cited:[],unsupported:[],warnings:[]} as unknown as RenderedDeck;
  const issues=static_issues(ws,'talk',rendered);
  for(const kind of ['placeholder','missing','external','theme','active-content'])assert.ok(issues.some(i=>i.kind===kind),kind);
  assert.equal(issues.find(i=>i.kind==='placeholder')?.level,'warning');
  assert.equal(issues.find(i=>i.kind==='missing')?.resource,'/topics/topic/images/missing.png');
});


test('a repeated render republishes current saved checks without rerunning inspection', async t => {
 const root=mkdtempSync(join(tmpdir(),'studio-current-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const ws=Workspace.open(root);ws.new_deck('talk','topic');
 const result={version:version(ws,'talk'),checked_at:1,errors:[],warnings:[],slides:1};
 mkdirSync(join(ws.state,'build','talk'),{recursive:true});
 writeFileSync(join(ws.state,'build','talk','checks.json'),JSON.stringify({result,slides:[]}));
 let resolveEvent!:(event:Record<string,unknown>)=>void;
 const event=new Promise<Record<string,unknown>>(resolve=>{resolveEvent=resolve;});
 const output=new OutputService({pandocPath:'unused',inspect:async()=>{throw Error('current checks must be reused');},broadcast:resolveEvent});
 t.after(()=>output.close());output.schedule(ws,'talk',0);
 const received=await Promise.race([event,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('checks event missing')),1000);timer.unref();})]);
 assert.deepEqual(received,{type:'checks',deck:'talk',result,busy:false,stale:false});
});

test('saved output remains readable during inspection and identical HTML reuses shots', async t => {
  const pandocPath = process.env.SLIDE_STUDIO_PANDOC || join(process.cwd(), 'resources/pandoc/bin', process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');
  if (!(await import('node:fs')).existsSync(pandocPath)) return t.skip('Pandoc unavailable');
  const root = mkdtempSync(join(tmpdir(), 'studio-output-read-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const ws = Workspace.open(root);
  ws.new_deck('talk', 'topic');
  const source = '---\ntopic: topic\ntheme: default\ntitle: Talk\n---\n\n## Page {#page}\n\nText.\n';
  writeFileSync(ws.qmd('talk'), source);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let inspections = 0;
  const output = new OutputService({pandocPath, broadcast() {}, inspect: async () => {
    inspections++; entered(); await gate;
    return {slides:1,steps:[],screenshots:[{slide:0,step:0,bytes:Buffer.from('png')}]};
  }});
  const check = output.check(ws, 'talk');
  try {
    await started;
    const directory = join(ws.state, 'build', 'talk', 'shots');
    const obsolete = join(directory, 'a'.repeat(64));
    mkdirSync(obsolete, {recursive:true});
    const response = await Promise.race([
      output.handle(ws, {method:'GET', pathname:'/api/deck/talk/shots', query:new URLSearchParams(), body:null,bytes:Buffer.alloc(0),headers:{}}),
      new Promise<never>((_, reject) => setTimeout(() => reject(Error('read waited for rendering')), 1000).unref()),
    ]);
    assert.deepEqual(response?.body, {slides:[]});
    release(); await check;
    assert.equal((await import('node:fs')).existsSync(obsolete), false);
    writeFileSync(ws.qmd('talk'), source+'\n');
    await output.check(ws, 'talk');
    assert.equal(inspections, 1);
  } finally {
    release(); await check; await output.close();
  }
});
