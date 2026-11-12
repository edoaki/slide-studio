import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test,{type TestContext} from 'node:test';
import { parse } from 'yaml';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import * as manage from '../../packages/core/src/legacy-deck-manage.js';
function fixture(t:TestContext){const root=mkdtempSync(join(tmpdir(),'deck-manage-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const ws=Workspace.open(join(root,'ws'));ws.new_deck('talk','test');return ws;}
test('title change preserves YAML flow maps, anchors, aliases, block scalars and CRLF',()=>{
 for(const front of ['title: Old\n# comment\ntopic: test\n','{title: Old, topic: test}\n','title: &name Old\nother: *name\n','other: &name Old\ntitle: *name\n','title: |\n  Old title\n  second line\ntopic: test\n'])for(const eol of ['\n','\r\n']){
  const text=('---\n'+front+'---\n\n## 😀 Slide\n\nKeep.\n').replaceAll('\n',eol),out=manage.title_text(text,'新しい: 発表');
  assert.equal(parse(out.split(eol+'---')[0]!.slice(3)).title,'新しい: 発表',out);assert.equal(out.slice(out.indexOf(eol+'---')),text.slice(text.indexOf(eol+'---')));if(eol==='\r\n')assert.doesNotMatch(out,/(?<!\r)\n/);
 }
});
test('rename moves history and exports, rewrites only recorded paths, and undo restores source bytes',async t=>{
 const ws=fixture(t),before=readFileSync(ws.qmd('talk'),'utf8'),snap=join(ws.state,'snapshots','talk','one');mkdirSync(join(snap,'files/decks/talk'),{recursive:true});writeFileSync(join(snap,'files/decks/talk/talk.html'),'html');writeFileSync(join(snap,'snapshot.json'),JSON.stringify({deck:'talk',path:'decks/talk/talk.html',text:'decks/talk/talk.html'}));mkdirSync(join(ws.state,'chat'),{recursive:true});writeFileSync(join(ws.state,'chat/talk.json'),JSON.stringify({file:'decks/talk/slides.qmd',text:'decks/talk/slides.qmd'}));
 const record=await manage.rename(ws,'talk','renamed','新しい発表');assert.equal(ws.has_deck('talk'),false);assert.equal(ws.has_deck('renamed'),true);
 const info=JSON.parse(readFileSync(join(ws.state,'snapshots/renamed/one/snapshot.json'),'utf8'));assert.equal(info.deck,'renamed');assert.equal(info.path,'decks/renamed/renamed.html');assert.equal(info.text,'decks/talk/talk.html');assert.ok(existsSync(join(ws.state,'snapshots/renamed/one/files/decks/renamed/renamed.html')));
 await manage.undo(ws,record);assert.equal(readFileSync(ws.qmd('talk'),'utf8'),before);assert.ok(existsSync(join(ws.state,'chat/talk.json')));
});
test('delete and undo keep data and reject overwriting a recreated deck',async t=>{
 const ws=fixture(t),before=readFileSync(ws.qmd('talk'));const record=await manage.remove(ws,'talk');assert.equal(ws.has_deck('talk'),false);ws.new_deck('talk','test');await assert.rejects(manage.undo(ws,record),/既にあります/);assert.deepEqual(readFileSync(join(record.trash,'deck/slides.qmd')),before);rmSync(ws.deck_dir('talk'),{recursive:true});await manage.undo(ws,record);assert.deepEqual(readFileSync(ws.qmd('talk')),before);
});
test('rename failure rolls back moved directories and refuses symlink history',async t=>{
 const ws=fixture(t);mkdirSync(join(ws.state,'chat'),{recursive:true});writeFileSync(join(ws.state,'chat/talk.json'),'malformed json');const before=readFileSync(ws.qmd('talk'));await assert.rejects(manage.rename(ws,'talk','renamed'));assert.deepEqual(readFileSync(ws.qmd('talk')),before);assert.equal(ws.has_deck('renamed'),false);
 rmSync(join(ws.state,'chat/talk.json'));symlinkSync(ws.qmd('talk'),join(ws.state,'chat/talk.json'));await assert.rejects(manage.rename(ws,'talk','renamed'),/シンボリックリンク/);assert.deepEqual(readFileSync(ws.qmd('talk')),before);
});
test('rename undo refuses changed manuscripts',async t=>{const ws=fixture(t),record=await manage.rename(ws,'talk','renamed');writeFileSync(ws.qmd('renamed'),'changed');await assert.rejects(manage.undo(ws,record),/原稿が変わった/);assert.equal(readFileSync(ws.qmd('renamed'),'utf8'),'changed');});
