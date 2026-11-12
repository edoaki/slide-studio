import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test,{type TestContext} from 'node:test';
import { AppServerClient,inspectAppServer } from '../../packages/ai/src/app-server.js';
import { runCodex } from '../../packages/ai/src/codex-run.js';
import { AppServerPool } from '../../packages/ai/src/pool.js';
function fixture(t:TestContext,mode='normal'){
 const root=mkdtempSync(join(tmpdir(),'fake-rpc-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const file=join(root,'server.cjs');
 writeFileSync(file,`const rl=require('node:readline').createInterface({input:process.stdin});const mode=process.argv[2];const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let initialized=false;rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized'){initialized=true;return;}if(!m.method){if(m.id==='approval')send({method:'approval/result',params:m});return;}if(m.method==='initialize'){send({id:m.id,result:{}});return;}if(!initialized){send({id:m.id,error:{message:'not initialized'}});return;}const reply=result=>send({id:m.id,result});switch(m.method){case 'account/read':reply({account:{type:'chatgpt',email:'fixture@example.invalid'}});break;case 'model/list':reply({data:[{id:m.params.cursor?'second':'first',isDefault:!m.params.cursor,displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:m.params.cursor?null:'next'});break;case 'account/rateLimits/read':reply({rateLimits:{}});break;case 'thread/start':case 'thread/resume':reply({thread:{id:m.params.threadId||'thread'}});break;case 'turn/start':reply({turn:{id:'turn'}});if(mode!=='wait'){send({method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',text:'完了'}}});send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:mode==='failed'?'failed':'completed'}}});}break;case 'turn/interrupt':reply({});send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'interrupted'}}});break;case 'approval':send({id:'approval',method:'item/commandExecution/requestApproval',params:{}});reply({});break;case 'malformed':process.stdout.write('not-json\\n');break;case 'timeout':break;case 'echo':setTimeout(()=>reply(m.params),m.params.delay);break;default:reply({});}});`);
 return {executable:process.execPath,args:[file,mode],cwd:root,timeoutMs:2000};
}
test('RPC initializes, correlates out-of-order replies, rejects unhandled approvals, and closes',async t=>{const client=await new AppServerClient(fixture(t)).start();try{const [a,b]=await Promise.all([client.call('echo',{value:1,delay:20}),client.call('echo',{value:2,delay:0})]);assert.equal(a.value,1);assert.equal(b.value,2);await client.call('approval');const event=await client.events.next();assert.equal(event.method,'approval/result');assert.equal((event.params.error as {code:number}).code,-32601);}finally{await client.close();}assert.equal(client.alive,false);});
test('RPC rejects pending operations on malformed output and enforces request timeouts',async t=>{const client=await new AppServerClient({...fixture(t),timeoutMs:100}).start();await assert.rejects(client.call('timeout'),/時間切れ/);await assert.rejects(client.call('malformed'));await client.close();});
test('inspection reads paginated models without sending an inference turn',async t=>{const result=await inspectAppServer(fixture(t));assert.equal(result.ok,true);assert.deepEqual(result.models.map(m=>m.id),['first','second']);assert.equal(result.default,'first');});
test('run receives early completion events and checks failed turn status',async t=>{const result=await runCodex({...fixture(t),prompt:'test',model:'fixture',readonly:true});assert.deepEqual(result,{session:'thread',final:'完了'});await assert.rejects(runCodex({...fixture(t,'failed'),prompt:'test',model:'fixture'}),/失敗/);});
test('run cancellation interrupts the turn and releases its process',async t=>{const controller=new AbortController();let timer:NodeJS.Timeout;await assert.rejects(runCodex({...fixture(t,'wait'),prompt:'test',model:'fixture',signal:controller.signal,onSession:()=>{timer=setTimeout(()=>controller.abort(),20);}}),/取り消し/);clearTimeout(timer!);});

test('pooled connections reuse idle workers, isolate concurrent owners and discard failures',async t=>{
 const options=fixture(t),pool=new AppServerPool();t.after(()=>pool.close());
 const first=await pool.acquire(options);await first.release(true);
 const reused=await pool.acquire(options);assert.equal(reused.client,first.client);
 const concurrent=await pool.acquire(options);assert.notEqual(concurrent.client,reused.client);
 await reused.release(false);assert.equal(reused.client.alive,false);await concurrent.release(true);
 const one=await runCodex({...options,pool,prompt:'first',model:'fixture'});
 const two=await runCodex({...options,pool,prompt:'second',model:'fixture',session:one.session});
 assert.equal(two.final,'完了');await pool.close();assert.equal(concurrent.client.alive,false);
 await assert.rejects(pool.acquire(options),/終了/);
});
