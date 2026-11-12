import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {_electron} from 'playwright-core';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';
const require=createRequire(import.meta.url);

test('original desktop isolates authored content, preserves CRLF and rejects stale writes', {timeout:90000},async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-desktop-boundary-')),ws=Workspace.open(join(temp,'workspace'));ws.new_deck('talk','topic');
 const source='---\r\ntitle: 境界の検証\r\ntopic: topic\r\ntheme: default\r\n---\r\n\r\n## 日本語 {#intro}\r\n\r\n本文。\r\n';
 await writeFile(ws.qmd('talk'),source);
 const installed=process.env.SLIDE_STUDIO_TEST_APP;
 const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));
 env.SLIDE_STUDIO_ELECTRON_HOME=join(temp,'profile');delete env.ELECTRON_RUN_AS_NODE;
 for(const provider of ['CODEX','CLAUDE','AGY'])env['SLIDE_STUDIO_'+provider]='none';
 if(installed){await mkdir(join(temp,'empty-path'));env.PATH=join(temp,'empty-path');env.SLIDE_STUDIO_PANDOC=join(temp,'not-a-pandoc');}
 const launch={executablePath:installed?.endsWith('.app')?join(installed,'Contents/MacOS/Slide Studio'):installed||require('electron'),args:[...(installed?[]:[join(process.cwd(),'dist/apps/desktop/main.js')]),'--root',ws.root,'--deck','talk'],env};
 const app=await _electron.launch(launch);t.after(async()=>{await app.close();await rm(temp,{recursive:true,force:true});});
 const page=await app.firstWindow();await page.waitForFunction(()=>!!sessionStorage.getItem('slide-studio:admin-token'));
 await page.frameLocator('#slideBox > iframe:not(.loading)').locator('.slide.active h1, .slide.active h2').filter({hasText:'日本語'}).waitFor();
 const runtime=await app.evaluate(({app,Menu})=>{
  const roles:string[]=[];const visit=(items:any[])=>{for(const item of items){if(item.role)roles.push(item.role);if(item.submenu)visit(item.submenu.items);}};visit(Menu.getApplicationMenu()?.items??[]);
  return {packaged:app.isPackaged,roles};
 });
 assert.equal(runtime.packaged,!!installed);
 if(process.platform==='darwin')for(const role of ['copy','paste','undo','quit'])assert.ok(runtime.roles.includes(role));
 const content=page.frames().find(f=>f.url().includes('/files/'));assert.ok(content);
 const boundary=await content.evaluate(async origin=>{
  let status:number|string;try{status=(await fetch(origin+'/api/home',{headers:{'X-Studio-Token':'invalid'}})).status;}catch{status='blocked';}
  return {status,node:typeof (globalThis as any).require,process:typeof (globalThis as any).process};
 },new URL(page.url()).origin);
 assert.notEqual(boundary.status,200);assert.equal(boundary.node,'undefined');assert.equal(boundary.process,'undefined');
 const save=async(text:string,base:string)=>page.evaluate(async({text,base})=>{
  const response=await fetch('/api/deck/talk/source',{method:'PUT',headers:{'Content-Type':'application/json','X-Studio-Token':sessionStorage.getItem('slide-studio:admin-token')!},body:JSON.stringify({text,base})});return {status:response.status,body:await response.json()};
 },{text,base});
 const before=await readFile(ws.qmd('talk')),base=createHash('sha256').update(before).digest('hex');
 const saved=await save(before.toString('utf8').replaceAll('\r\n','\n')+'\n追加。\n',base);assert.equal(saved.status,200,JSON.stringify(saved.body));
 const bytes=await readFile(ws.qmd('talk'),'utf8');assert.match(bytes,/\r\n/);assert.doesNotMatch(bytes,/(?<!\r)\n/);
 const external=bytes+'外部からの変更。\r\n';await writeFile(ws.qmd('talk'),external);
 const stale=await save('上書きしない',base);assert.equal(stale.status,409);assert.equal(await readFile(ws.qmd('talk'),'utf8'),external);
});
