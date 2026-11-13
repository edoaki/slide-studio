import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createRequire} from 'node:module';
import {_electron} from 'playwright-core';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';
const require=createRequire(import.meta.url);
const liveProvider=process.env.SLIDE_STUDIO_LIVE_PROVIDER||'codex';
// Explicit opt-in: this test sends real inference requests using an existing login.
test(`live ${liveProvider} edits a scratch memo through chat and restores the saved original`,{
 skip:process.env.SLIDE_STUDIO_LIVE_AI!=='1',timeout:300000,
},async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-live-ai-')),ws=Workspace.open(join(temp,'workspace'));ws.new_deck('talk','test');
 const before='接続確認用の原稿。\n';await writeFile(ws.memo('talk'),before);
 const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
 assert.ok(['codex','claude','agy'].includes(liveProvider));
 Object.assign(env,{SLIDE_STUDIO_ELECTRON_HOME:join(temp,'profile')});
 for(const id of ['codex','claude','agy'])if(id!==liveProvider)env[`SLIDE_STUDIO_${id.toUpperCase()}`]='none';
 if(liveProvider==='codex')env.SLIDE_STUDIO_CODEX_HOME=process.env.SLIDE_STUDIO_CODEX_HOME||join(homedir(),'.codex');
 const installed=process.env.SLIDE_STUDIO_TEST_APP;
 const app=await _electron.launch({executablePath:installed?.endsWith('.app')?join(installed,'Contents/MacOS/Slide Studio'):installed||require('electron'),args:[...(installed?[]:[join(process.cwd(),'dist/apps/desktop/main.js')]),'--root',ws.root,'--deck','talk'],env});
 t.after(async()=>{await app.close();if(process.env.SLIDE_STUDIO_KEEP_LIVE_AI!=='1')await rm(temp,{recursive:true,force:true});});
 const page=await app.firstWindow();page.setDefaultTimeout(20000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('[data-tab="memo"]').click();
 await page.locator('.chat-input').fill('接続確認です。decks/talk/memo.md の末尾に「実AI接続確認済み。」という一文だけを追加してください。他のファイルは変更しないでください。外部の情報収集は不要です。');
 const sent=page.waitForResponse(r=>r.url().endsWith('/send')&&r.request().method()==='POST');await page.locator('.chat-send').click();const response=await sent;assert.equal(response.status(),200,await response.text());const round=await response.json();
 let state:any;
 for(let i=0;i<260;i++){state=JSON.parse(await readFile(join(ws.state,'chat/talk.json'),'utf8')).rounds.find((r:any)=>r.id===round.id);if(['done','error','cancelled'].includes(state?.state))break;await page.waitForTimeout(1000);}
 console.log(JSON.stringify({round:state?.id,state:state?.state,error:state?.error,model:state?.model,agents:state?.agents?.map((a:any)=>({role:a.role,state:a.state,summary:a.summary})),workspace:temp}));
 assert.equal(state?.state,'done');assert.match(await readFile(ws.memo('talk'),'utf8'),/実AI接続確認済み。/);
 await page.getByRole('button',{name:'この送信の前に戻す',exact:true}).click();await page.getByRole('dialog').locator('[data-a="yes"]').click();await page.getByText('この送信の前に戻しました',{exact:true}).waitFor();assert.equal(await readFile(ws.memo('talk'),'utf8'),before);
 await page.reload();await page.locator('[data-tab="memo"]').click();assert.equal(await readFile(ws.memo('talk'),'utf8'),before);assert.deepEqual(errors,[]);
});
