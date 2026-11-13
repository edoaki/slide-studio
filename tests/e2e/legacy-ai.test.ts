import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {_electron} from 'playwright-core';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';
const require=createRequire(import.meta.url);

for(const mode of ['memo','theme'] as const)test(`original AI panel sends a ${mode} request through a native process, reviews it, restores and reopens history`, {timeout:90000},async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-ai-ui-')),ws=Workspace.open(join(temp,'workspace'));ws.new_deck('talk','topic');
 const binary=join(temp,'fixture-codex');
 await writeFile(binary,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});
 const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let cwd;let serial=0;
 rl.on('line',line=>{const m=JSON.parse(line),reply=result=>send({id:m.id,result});if(m.method==='initialized')return;
 if(m.method==='initialize'){reply({});return;}
 if(m.method==='account/read'){reply({account:{type:'chatgpt'}});return;}
 if(m.method==='account/rateLimits/read'){reply({rateLimits:{primary:{usedPercent:12,resetsAt:2000000000}}});return;}
 if(m.method==='model/list'){reply({data:[{id:'fixture',displayName:'Fixture Codex',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}]});return;}
 if(m.method==='thread/start'||m.method==='thread/resume'){cwd=m.params.cwd;reply({thread:{id:'fixture-thread'}});return;}
 if(m.method==='turn/start'){
  const id='turn-'+(++serial),review=!!m.params.outputSchema?.properties?.issues;
  const mode=${JSON.stringify(mode)},file=path.join(cwd,mode==='theme'?'themes/default.css':'decks/talk/memo.md');if(!review)fs.appendFileSync(file,mode==='theme'?'\\n#stage .slide > h2 {background:#123456;border-radius:16px}\\n':'\\nAI の動作確認で追加した下書き。\\n');
  const result=review?{summary:'確認済み',issues:[]}:{reply:'下書きを更新しました',slides:'',rebuild:false,questions:[]};
  reply({turn:{id}});send({method:'item/completed',params:{threadId:'fixture-thread',item:{type:'agentMessage',id:'message-'+id,text:JSON.stringify(result)}}});send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id,status:'completed'}}});return;
 }reply({});});\n`,{mode:0o700});
 const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
 Object.assign(env,{SLIDE_STUDIO_ELECTRON_HOME:join(temp,'profile'),SLIDE_STUDIO_CODEX:binary,SLIDE_STUDIO_CLAUDE:'none',SLIDE_STUDIO_AGY:'none'});
 const installed=process.env.SLIDE_STUDIO_TEST_APP;
 const app=await _electron.launch({executablePath:installed?.endsWith('.app')?join(installed,'Contents/MacOS/Slide Studio'):installed||require('electron'),args:[...(installed?[]:[join(process.cwd(),'dist/apps/desktop/main.js')]),'--root',ws.root,'--deck','talk'],env});
 t.after(async()=>{await app.close();await rm(temp,{recursive:true,force:true});});
 const page=await app.firstWindow();await page.locator(`[data-tab="${mode}"]`).click();
 if(mode==='memo'){await page.locator('.memo-audience').fill('開発者');await page.locator('.memo-duration').fill('5分');await page.locator('.memo-input').fill('保存済みの下書き。');}
 const file=mode==='theme'?join(ws.themes,'default.css'):ws.memo('talk');const before=await readFile(file,'utf8');
 await page.locator('.chat-input').fill('動作確認の一文を追加してください');
 const sent=page.waitForResponse(r=>r.url().endsWith('/send')&&r.request().method()==='POST');await page.locator('.chat-send').click();
 const response=await sent;assert.equal(response.status(),200,await response.text());
 const round=await response.json();
 await page.locator(`.chat-round[data-round="${round.id}"]`).getByText('下書きを更新しました',{exact:true}).waitFor();
 await page.getByRole('button',{name:'この送信の前に戻す',exact:true}).waitFor();
 const changed=await readFile(file,'utf8');assert.match(changed,mode==='theme'?/background:#123456/:/AI の動作確認/);
 if(mode==='theme'){assert.equal(await page.locator('.tv-heading-modes,.tv-fill-open').count(),0);assert.equal(await page.getByLabel('見出しの文字',{exact:true}).isVisible(),true);}
 await page.getByRole('button',{name:'この送信の前に戻す',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.locator('[data-a="yes"]').click();
 await page.getByText('この送信の前に戻しました',{exact:true}).waitFor();
 const restored=await readFile(file,'utf8');if(mode==='theme')assert.equal(restored,before);else{assert.match(restored,/保存済みの下書き/);assert.doesNotMatch(restored,/AI の動作確認/);}
 await page.reload();await page.locator(`[data-tab="${mode}"]`).click();
 await page.locator('.chat-actions > [data-act="hist"]').click();
 await page.locator('.chat-hrow').filter({hasText:'動作確認の一文'}).click();
 await page.getByText('この送信の前に戻しました',{exact:true}).waitFor();
 const state=JSON.parse(await readFile(join(ws.state,'chat/talk.json'),'utf8'));
 assert.equal(state.rounds[0].state,'done');assert.ok(state.rounds[0].restored);assert.ok(state.rounds[0].agents.some((a:{role:string;state:string})=>a.role==='review'&&a.state==='complete'));
});
