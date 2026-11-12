import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import * as roles from '../../packages/core/src/legacy-ai-roles.js';
const provider=(key:string)=>({ok:true,model:key==='codex:fixture'?{key,effort:'medium',efforts:['low','medium','high']}:null});
test('role settings migrate old reviewers and preserve explicit switches when selecting or clearing models',()=>{
 assert.deepEqual(roles.migrate({slide_review:{model:'codex:fixture'},html_review:{model:'other'},consult:{enabled:true}},'slides'),{review:{model:'codex:fixture'},consult:{enabled:true}});
 const current={review:{enabled:false},consult:{enabled:true}};
 const changed=roles.tab_settings('slides',current,{review:{model:'codex:fixture',effort:'high'}},provider);assert.deepEqual(changed.review,{model:'codex:fixture',effort:'high',enabled:false});assert.deepEqual(current,{review:{enabled:false},consult:{enabled:true}});
 assert.deepEqual(roles.tab_settings('slides',changed,{review:null},provider).review,{enabled:false});
 assert.throws(()=>roles.tab_settings('slides',current,{review:{model:'codex:fixture',effort:'impossible',enabled:false}},provider));assert.throws(()=>roles.tab_settings('slides',current,{chat:{enabled:false}},provider));
 assert.deepEqual(roles.resolveRole('consult',{model:'codex:fixture'},{},provider),{enabled:false});
});
test('instruction catalog uses workspace skills and saves only per-role extras',t=>{
 const root=mkdtempSync(join(tmpdir(),'role-instructions-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const ws=Workspace.open(join(root,'ws'));ws.new_deck('talk','test');
 const before=roles.catalog(ws);assert.equal(before.roles.length,5);assert.ok(before.roles.find(r=>r.id==='chat')!.base[0]!.text.length);assert.equal(roles.set_extra(ws,'chat','  日本語で説明  '),'日本語で説明');assert.equal(roles.extra(ws,'review'),'');assert.match(roles.with_extra(ws,'chat','依頼'),/日本語で説明\n\n依頼/);assert.throws(()=>roles.set_extra(ws,'chat','あ'.repeat(4001)));assert.equal(roles.extra(ws,'chat'),'日本語で説明');roles.set_extra(ws,'chat','');assert.equal(roles.extra(ws,'chat'),'');
});
test('question cleanup bounds item indices and deduplicates choices',()=>{
 assert.deepEqual(roles.clean_questions([{item:20,text:' 確認 ',options:[{label:' A ',description:' 説明 '},{label:'A'},{label:'B'}],multiple:true}],1),[{item:1,text:'確認',options:[{label:'A',description:'説明'},{label:'B',description:''}],multiple:true}]);
});
