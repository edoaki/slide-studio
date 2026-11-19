import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { Workspace } from '../../packages/core/src/workspace.js';
import * as manage from '../../packages/core/src/deck-manage.js';
import { listing, restore } from '../../packages/core/src/trash.js';
function fixture(t:TestContext){const root=mkdtempSync(join(tmpdir(),'home-trash-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const ws=Workspace.open(join(root,'ws'));return ws;}
test('trash survives reopening and restores presentation bytes, recent state, chat and snapshots',async t=>{
 const ws=fixture(t);ws.new_deck('talk','research','default',null,'保存した題');
 const before=readFileSync(ws.qmd('talk'));mkdirSync(join(ws.state,'chat'),{recursive:true});writeFileSync(join(ws.state,'chat/talk.json'),'history');mkdirSync(join(ws.state,'snapshots/talk'),{recursive:true});writeFileSync(join(ws.state,'snapshots/talk/data'),'snapshot');
 const opened=ws.recent()[0]!.opened;await manage.remove(ws,'talk');
 const reopened=Workspace.open(ws.root),item=listing(reopened).find(i=>i.kind==='deck')!;
 assert.equal(item.title,'保存した題');await restore(reopened,item.id);
 assert.deepEqual(readFileSync(ws.qmd('talk')),before);assert.equal(readFileSync(join(ws.state,'chat/talk.json'),'utf8'),'history');assert.equal(readFileSync(join(ws.state,'snapshots/talk/data'),'utf8'),'snapshot');assert.equal(ws.recent()[0]!.opened,opened);assert.deepEqual(listing(ws),[]);
});
test('themes and topics restore bytes and refuse collisions without changing trash',async t=>{
 const ws=fixture(t);ws.register_theme('custom','body {color: red}');ws.new_topic('unused-topic');writeFileSync(join(ws.topic_dir('unused-topic'),'notes.txt'),'materials');
 writeFileSync(join(ws.state,'theme-defaults/custom.css'),'original baseline');ws.remove_theme('custom');ws.remove_topic('unused-topic');
 const items=listing(ws);assert.deepEqual(items.map(i=>i.kind).sort(),['theme','topic']);
 ws.register_theme('custom','collision');ws.new_topic('unused-topic');
 for(const item of items)await assert.rejects(restore(ws,item.id),/既にあります/);
 assert.equal(readFileSync(join(ws.themes,'custom.css'),'utf8'),'collision');assert.equal(listing(ws).length,2);
 rmSync(join(ws.themes,'custom.css'));rmSync(ws.topic_dir('unused-topic'),{recursive:true});
 for(const item of items)await restore(ws,item.id);
 assert.equal(readFileSync(join(ws.themes,'custom.css'),'utf8'),'body {color: red}');assert.equal(readFileSync(join(ws.state,'theme-defaults/custom.css'),'utf8'),'original baseline');assert.equal(readFileSync(join(ws.topic_dir('unused-topic'),'notes.txt'),'utf8'),'materials');assert.deepEqual(listing(ws),[]);
});
test('trash IDs reject traversal, links and replay, and deck collisions keep original bytes',async t=>{
 const ws=fixture(t);ws.new_deck('talk','research');const record=await manage.remove(ws,'talk'),item=listing(ws)[0]!;ws.new_deck('talk','research');await assert.rejects(restore(ws,item.id),/既にあります/);assert.ok(existsSync(join(record.trash,'deck/slides.qmd')));
 for(const id of ['../themes/default.css','/etc/passwd','topics/../../decks/talk',item.id+'/deck'])await assert.rejects(restore(ws,id));
 rmSync(ws.deck_dir('talk'),{recursive:true});await restore(ws,item.id);await assert.rejects(restore(ws,item.id));
 mkdirSync(join(ws.state,'trash/topics'),{recursive:true});symlinkSync(ws.topic_dir('research'),join(ws.state,'trash/topics/fake-123'));assert.deepEqual(listing(ws),[]);
});
