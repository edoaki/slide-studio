#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),compiler=join(root,'.slide-studio/compiler');
const run=(command,args)=>new Promise((done,reject)=>{const p=spawn(command,args,{cwd:compiler,stdio:'inherit',shell:process.platform==='win32'&&command.endsWith('.cmd')});p.once('error',reject);p.once('exit',code=>code===0?done():reject(Error(`セットアップに失敗しました (${code})`)));});
try{
 if(process.argv.slice(2).includes('--setup')){
  await run(process.platform==='win32'?'npm.cmd':'npm',['install','--no-audit','--no-fund']);
  await run(process.execPath,['-e','require("electron")']);
  await run(process.execPath,['scripts/setup-pandoc.mjs']);
 }else{
  const {main}=await import(pathToFileURL(join(compiler,'apps/portable/main.js')).href);
  process.exitCode=await main(root,process.argv.slice(2));
 }
}catch(error){console.error(error.code==='ERR_MODULE_NOT_FOUND'?'準備が必要です。このフォルダで node build.mjs --setup を実行してください。':error.message);process.exitCode=1;}
