import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test,{type TestContext} from 'node:test';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { ChatStore, attachments } from '../../packages/core/src/legacy-chat-store.js';
function fixture(t:TestContext){const root=mkdtempSync(join(tmpdir(),'chat-store-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const ws=Workspace.open(join(root,'ws'));ws.new_deck('talk','test');const events:unknown[]=[];const options={providerOf:(key:string)=>({ok:true,model:key==='codex:test'?{key,effort:'medium',efforts:['low','medium','high']}:null}),defaultModel:()=> 'codex:test',status:()=>null,broadcast:(event:unknown)=>events.push(event)};return {ws,events,options,store:new ChatStore(ws,options)};}
test('chat modes retain drafts, tabs, roles and explicit names across restart',async t=>{
 const {ws,store,options}=fixture(t),state=store.state('talk');assert.deepEqual(state.tabs.map(t=>t.mode),['slides','memo','theme']);const tab=state.tabs[0]!;
 await store.update_tab('talk',tab.id,{drafts:{deck:'構成を直す','@1':{text:'本文',page_title:'見出し'}},model:'codex:test',effort:'high',ai_roles:{consult:{enabled:true}}});assert.equal(tab.name,'構成を直す');await store.update_tab('talk',tab.id,{name:'自分の名前'});await store.update_tab('talk',tab.id,{drafts:{deck:'別の依頼'}});assert.equal(tab.name,'自分の名前');const restarted=new ChatStore(ws,options);assert.equal(restarted.tab('talk',tab.id).drafts.deck,'別の依頼');assert.deepEqual(restarted.tab('talk',tab.id).ai_roles,{consult:{enabled:true}});
 await assert.rejects(store.update_tab('talk',tab.id,{open:false}),/最後のタブ/);const second=await store.add_tab('talk','slides');await store.update_tab('talk',tab.id,{open:false});assert.equal(second.open,true);
});
test('invalid partial patches leave persisted drafts and model preferences untouched',async t=>{
 const {ws,store}=fixture(t),tab=store.state('talk').tabs[0]!;await store.save('talk');const before=readFileSync(join(ws.state,'chat/talk.json'));await assert.rejects(store.update_tab('talk',tab.id,{drafts:{deck:'must not remain'},model:'codex:test',effort:'bad'}));assert.deepEqual(tab.drafts,{});assert.deepEqual(readFileSync(join(ws.state,'chat/talk.json')),before);assert.equal(ws.prefs().ai_last,undefined);
});
test('interrupted runs are shown as errors and opening a view preserves history',async t=>{
 const {ws,store,options}=fixture(t),data=store.state('talk'),tab=data.tabs[0]!;tab.session='session';data.rounds.push({id:'round',tab:tab.id,state:'run',agents:[{state:'run'}],items:[{key:'deck'}]});await store.save('talk');const restarted=new ChatStore(ws,options);assert.equal(restarted.state('talk').rounds[0]?.state,'error');await restarted.open_view('talk');assert.equal(restarted.tab('talk',tab.id).open,false);assert.equal(restarted.state('talk').rounds.length,1);assert.equal(restarted.state('talk').tabs.filter(t=>t.mode==='slides'&&t.open).length,1);
});
test('busy tabs reject model switches and attachments stay within their declared roots',async t=>{
 const {ws,store}=fixture(t),data=store.state('talk'),tab=data.tabs[0]!;data.rounds.push({id:'round',tab:tab.id,state:'run',items:[{key:'deck'}]});await assert.rejects(store.update_tab('talk',tab.id,{open:false}),/作業中/);assert.equal(store.public('talk').locked,true);
 const materials=join(ws.deck_dir('talk'),'materials');mkdirSync(materials);writeFileSync(join(materials,'paper.pdf'),'pdf');assert.equal(attachments(ws,'talk',[{path:'materials/paper.pdf'}])[0]?.kind,'file');symlinkSync(ws.qmd('talk'),join(materials,'link.pdf'));assert.throws(()=>attachments(ws,'talk',[{path:'materials/link.pdf'}]),/シンボリックリンク/);assert.throws(()=>attachments(ws,'talk',[{path:'materials/../slides.qmd'}]));
});
