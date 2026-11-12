import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test,{type TestContext} from 'node:test';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import * as m from '../../packages/core/src/legacy-materials.js';
function fixture(t:TestContext){const root=mkdtempSync(join(tmpdir(),'legacy-materials-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const ws=Workspace.open(join(root,'workspace'));ws.new_deck('talk','test');return {ws,root,base:join(ws.deck_dir('talk'),'materials')};}
const bytes=(s:string)=>Buffer.from(s);
test('upload retains nested folders, deduplicates bytes and never overwrites',t=>{
  const {ws,base}=fixture(t);
  assert.deepEqual(m.add(ws,'talk','results/run1/loss.csv',bytes('a,b\n')),{path:'results/run1/loss.csv',reused:false});
  assert.equal(m.add(ws,'talk','results/run1/loss.csv',bytes('a,b\n')).reused,true);
  assert.equal(m.add(ws,'talk','results/run1/loss.csv',bytes('other')).path,'results/run1/loss-2.csv');
  assert.equal(readFileSync(join(base,'results/run1/loss.csv'),'utf8'),'a,b\n');
  assert.equal(m.add(ws,'talk','テンプレート.pptx',bytes('PK')).path,'テンプレート.pptx');
});
test('invalid paths and symlink parents do not escape or create partial directories',t=>{
  const {ws,base,root}=fixture(t);
  for(const path of ['../x','a/../../x','.hidden','a/.git/config','','/'])assert.throws(()=>m.add(ws,'talk',path,bytes('x')));
  assert.equal(existsSync(base),false);
  mkdirSync(base);mkdirSync(join(root,'outside'));symlinkSync(join(root,'outside'),join(base,'link'));
  assert.throws(()=>m.add(ws,'talk','link/x',bytes('x')));
  assert.throws(()=>m.copy_in(ws,'talk','link',[]));
  symlinkSync(join(root,'missing'),join(base,'broken.txt'));
  assert.equal(m.add(ws,'talk','broken.txt',bytes('safe')).path,'broken-2.txt');
  assert.equal(existsSync(join(root,'missing')),false);
});
test('listing keeps tree order and later siblings after a large folder',t=>{
  const {ws,base}=fixture(t);
  assert.deepEqual(m.listing(ws,'talk'),{path:'decks/talk/materials',entries:[],more:0});
  for(let i=0;i<501;i++)m.add(ws,'talk',`animations/${i}.txt`,bytes('x'));
  for(const p of ['score-table/slides.md','実験結果/results.csv','notes.txt'])m.add(ws,'talk',p,bytes('x'));
  writeFileSync(join(base,'.DS_Store'),'x');
  const out=m.listing(ws,'talk');assert.equal(out.entries.length,507);assert.equal(out.more,0);
  assert.deepEqual(out.entries.slice(-5).map(e=>e.path),['score-table','score-table/slides.md','実験結果','実験結果/results.csv','notes.txt']);
  assert.match(m.prompt_lines(ws,'talk')[0]!,/score-table\/、実験結果\//);
});
test('create, move, case rename, trash and restore preserve contents and reject collisions',t=>{
  const {ws,base}=fixture(t);
  m.create(ws,'talk','results',true);m.create(ws,'talk','results/memo.md',false);
  assert.throws(()=>m.create(ws,'talk','results',true));assert.throws(()=>m.create(ws,'talk','none/a',false));
  m.move(ws,'talk','results/memo.md','results/notes.md');
  assert.throws(()=>m.move(ws,'talk','results','results/child'));
  m.move(ws,'talk','results','Results');
  const deleted=m.remove(ws,'talk','Results');assert.equal(existsSync(join(base,'Results')),false);
  assert.equal(existsSync(join(ws.root,deleted.trash,'notes.md')),true);
  assert.deepEqual(m.restore(ws,'talk','Results',deleted.trash),{path:'Results'});
  assert.equal(readFileSync(join(base,'Results/notes.md')).length,0);
  assert.throws(()=>m.restore(ws,'talk','other','.slide-studio/trash/elsewhere/stamp/item'));
  const again=m.remove(ws,'talk','Results');m.create(ws,'talk','Results',true);
  assert.throws(()=>m.restore(ws,'talk','Results',again.trash));
  assert.equal(existsSync(join(ws.root,again.trash,'notes.md')),true);
});
test('native opening creates the root and rejects escaped or missing files',async t=>{
  const {ws,base,root}=fixture(t),opened:string[]=[];const opener=async(p:string)=>{opened.push(p);};
  assert.equal(await m.open_in_os(ws,'talk','',opener),'decks/talk/materials');
  m.add(ws,'talk','a.txt',bytes('x'));await m.open_in_os(ws,'talk','a.txt',opener);
  symlinkSync(root,join(base,'outside'));
  await assert.rejects(m.open_in_os(ws,'talk','outside',opener));
  await assert.rejects(m.open_in_os(ws,'talk','missing',opener));
  assert.deepEqual(opened,[base,join(base,'a.txt')]);
});
test('native copy preserves folders, omits hidden files and cleans temporary copies',t=>{
  const {ws,root,base}=fixture(t),pc=join(root,'pc');mkdirSync(join(pc,'results/run1'),{recursive:true});
  writeFileSync(join(pc,'results/run1/loss.csv'),'a,b\n');writeFileSync(join(pc,'results/.DS_Store'),'x');writeFileSync(join(pc,'template.pptx'),'PK');
  assert.deepEqual(m.copy_in(ws,'talk','',[join(pc,'results'),join(pc,'template.pptx'),join(pc,'none')]),{added:['results','template.pptx'],reused:0});
  assert.equal(existsSync(join(base,'results/.DS_Store')),false);
  assert.deepEqual(m.copy_in(ws,'talk','',[join(pc,'template.pptx')]),{added:[],reused:1});
  writeFileSync(join(pc,'template.pptx'),'PK2');
  assert.deepEqual(m.copy_in(ws,'talk','',[join(pc,'template.pptx'),join(pc,'results')]),{added:['template-2.pptx','results-2'],reused:0});
  assert.throws(()=>m.copy_in(ws,'talk','',[base]));assert.throws(()=>m.copy_in(ws,'talk','',[root]));
  assert.equal(readdirSync(base).some(n=>n.startsWith('.')),false);
});
test('trash symlinks cannot redirect deletion outside the workspace',t=>{
  const {ws,root,base}=fixture(t);m.add(ws,'talk','keep.txt',bytes('keep'));
  mkdirSync(join(root,'outside'));symlinkSync(join(root,'outside'),join(ws.state,'trash'));
  assert.throws(()=>m.remove(ws,'talk','keep.txt'));assert.equal(readFileSync(join(base,'keep.txt'),'utf8'),'keep');
});
