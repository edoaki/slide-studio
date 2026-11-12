import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Providers} from '../../packages/ai/src/providers.js';
import {Logins} from '../../packages/ai/src/login.js';
import type {Runtime} from '../../packages/ai/src/runtime.js';

function fixture(t:TestContext,mode='success'){
 const root=mkdtempSync(join(tmpdir(),'studio-login-')),binary=join(root,'fake-cli');
 writeFileSync(binary,`#!${process.execPath}\nconst mode=${JSON.stringify(mode)};
 if(process.argv[2]==='auth'){
  if(process.argv[3]==='status')console.log(JSON.stringify({loggedIn:true,authMethod:'fixture'}));
  else process.stderr.write('https://claude.ai/oauth/authorize?code=fixture\\n');
 }else{
 const rl=require('node:readline').createInterface({input:process.stdin}),send=v=>console.log(JSON.stringify(v));
 rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;
 if(m.method==='account/login/start'){send({id:m.id,result:{authUrl:(mode==='invalid'?'http':'https')+'://auth.openai.com/fixture'}});if(mode!=='wait')send({method:'account/login/completed',params:{success:true}});}
 else send({id:m.id,result:{}});});}
 `,{mode:0o700});
 const providers=new Providers(join(root,'ai'),{...process.env,SLIDE_STUDIO_CODEX:binary,SLIDE_STUDIO_CLAUDE:binary});
 const urls:string[]=[];let changes=0;
 const runtime={progress:null,ensure:async()=>binary} as unknown as Runtime;
 const logins=new Logins(providers,()=>runtime,{openExternal:async url=>{urls.push(url);return true;},changed:()=>{changes++;}});
 t.after(async()=>{await logins.close();rmSync(root,{recursive:true,force:true});});
 return {logins,urls,changes:()=>changes};
}
async function settled(logins:Logins,id:'codex'|'claude'){
 const deadline=Date.now()+3000;
 while(['preparing','pending'].includes(logins.state(id).status)){if(Date.now()>deadline)throw Error('login did not settle');await new Promise(r=>setTimeout(r,10));}
 return logins.state(id);
}
test('Codex login consumes early completion and Claude accepts OAuth URLs on stderr',async t=>{
 const f=fixture(t);f.logins.start('codex');assert.equal((await settled(f.logins,'codex')).status,'completed');
 f.logins.start('claude');assert.equal((await settled(f.logins,'claude')).status,'completed');
 assert.deepEqual(f.urls,['https://auth.openai.com/fixture','https://claude.ai/oauth/authorize?code=fixture']);assert.equal(f.changes(),2);
});
test('login refuses insecure URLs and download-only does not open a browser',async t=>{
 const f=fixture(t,'invalid');f.logins.start('codex');assert.equal((await settled(f.logins,'codex')).status,'failed');assert.deepEqual(f.urls,[]);
 f.logins.start('codex',true);assert.equal((await settled(f.logins,'codex')).status,'ready');assert.deepEqual(f.urls,[]);
});
test('closing a pending login terminates its owned process and rejects new login attempts',async t=>{
 const f=fixture(t,'wait');f.logins.start('codex');while(!f.urls.length)await new Promise(r=>setTimeout(r,10));
 await f.logins.close();assert.equal(f.logins.state('codex').status,'failed');assert.throws(()=>f.logins.start('codex'),/終了/);
});
