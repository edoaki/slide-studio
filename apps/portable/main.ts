/** Standalone workspace compiler. Uses the same compiler and renderer as the app. */
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';
import {render_text} from '../../packages/core/src/legacy-render.js';
import {bundleHtml} from '../../packages/core/src/bundle.js';
import {atomicWriteFile} from '../../packages/core/src/atomic.js';
import {acquireWorkspaceLock,releaseWorkspaceLock} from '../../packages/core/src/lock.js';
import {LegacyOutput,output_path} from '../server/legacy-output.js';
import {sha256} from '../../packages/core/src/source.js';
import type {LegacyInspect} from '../../packages/contracts/src/legacy-output.js';
import type {RenderResult} from '../../packages/renderer/src/contracts.js';

export async function main(root:string,args:string[]):Promise<number>{
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{list:{type:'boolean'},'html-only':{type:'boolean'},force:{type:'boolean'},help:{type:'boolean',short:'h'}}});
 if(values.help){console.log('node build.mjs --setup | --list | <発表名> [--html-only] [--force]');return 0;}
 const ws=Workspace.open(root,false);
 if(values.list){console.log(ws.list_decks().join('\n'));return 0;}
 const deck=positionals[0];if(!deck||positionals.length!==1)throw Error('発表名を1つ指定してください（--list で一覧）');ws.require_deck(deck);
 const compiler=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const pandocPath=process.env.SLIDE_STUDIO_PANDOC||join(compiler,'resources/pandoc/bin',process.platform==='win32'?'pandoc.exe':'pandoc');
 const inspect:LegacyInspect=async(html,options)=>{
  const temporary=await mkdtemp(join(tmpdir(),'studio-portable-'));
  try{
   const inputHtml=join(temporary,'input.html'),outputDir=join(temporary,'output'),job=join(temporary,'job.json');await writeFile(inputHtml,html);await writeFile(job,JSON.stringify({schemaVersion:1,inputHtml,outputDir,timeoutMs:180000,...options}));
   const require=createRequire(import.meta.url),electron=require('electron') as string;
   const env={...process.env,SLIDE_STUDIO_RENDER_PROFILE:join(temporary,'profile')};delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
   await mkdir(env.SLIDE_STUDIO_RENDER_PROFILE,{mode:0o700});
   await new Promise<void>((done,reject)=>{
    const child=spawn(electron,[join(compiler,'packages/renderer/src/cli.js'),'--job',job],{env,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',chunk=>{error=(error+chunk).slice(-16000);});child.stdout.resume();
    const cancel=()=>child.kill('SIGTERM');process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
    const clean=()=>{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);};child.once('error',e=>{clean();reject(e);});child.once('exit',code=>{clean();code===0?done():reject(Error(error||`描画に失敗しました (${code})`));});
   });
   const result=JSON.parse(await readFile(join(outputDir,'manifest.json'),'utf8')) as RenderResult & {output:{pdf:string}};
   const screenshots=await Promise.all(result.steps.filter(s=>s.screenshot).map(async s=>({slide:s.slide,step:s.step,bytes:await readFile(join(outputDir,s.screenshot!))})));
   return {slides:result.slides,steps:result.steps,screenshots,...(options.pdf?{pdf:await readFile(join(outputDir,result.output.pdf))}:{})};
  }finally{await rm(temporary,{recursive:true,force:true,maxRetries:5});}
 };
 const lock=await acquireWorkspaceLock(ws.state);
 try{
  if(values['html-only']){
   const rendered=await render_text(ws,deck,await readFile(ws.qmd(deck),'utf8'),{pandocPath});
   const bundled=bundleHtml(rendered.html,ws.deck_dir(deck),ws.root);
   const path=output_path(ws,deck,'html');await atomicWriteFile(path,bundled.html,0o600);console.log(path);return 0;
  }
  const output=new LegacyOutput({pandocPath,inspect,broadcast(){}});
  try{
   const response=await output.handle(ws,{method:'POST',pathname:`/api/deck/${encodeURIComponent(deck)}/build`,query:new URLSearchParams(),headers:{},bytes:new Uint8Array(),body:{base:sha256(await readFile(ws.qmd(deck))),force:!!values.force}});
   const body=response?.body as {error?:string;blocked?:boolean;files?:{name:string}[];result?:unknown};
   if(body.error)throw Error(body.error);if(body.blocked){console.error(JSON.stringify(body.result,null,2));return 1;}console.log(body.files?.map(f=>join(ws.deck_dir(deck),f.name)).join('\n'));return 0;
  }finally{await output.close();}
 }finally{await releaseWorkspaceLock(lock.path,lock.token);}
}
