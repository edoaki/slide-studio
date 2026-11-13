import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {_electron, type FrameLocator, type Page} from 'playwright-core';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';
const require=createRequire(import.meta.url);
async function setup(t:TestContext){
 const temp=await mkdtemp(join(tmpdir(),'studio-present-')),ws=Workspace.open(join(temp,'workspace'));ws.new_deck('talk','test');
 await writeFile(ws.qmd('talk'),'---\ntitle: 発表の確認\ntopic: test\ntheme: default\n---\n\n## 一枚目 {#first}\n\n最初の段落。\n\n## 二枚目 {#second}\n\n::: {.incremental}\n- A\n- B\n:::\n\n## 三枚目 {#third}\n\n本文。\n\n## 四枚目 {#fourth}\n\n終わり。\n');
 const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;env.SLIDE_STUDIO_ELECTRON_HOME=join(temp,'profile');
 const installed=process.env.SLIDE_STUDIO_TEST_APP;
 const app=await _electron.launch({executablePath:installed?.endsWith('.app')?join(installed,'Contents/MacOS/Slide Studio'):installed||require('electron'),args:[...(installed?[]:[join(process.cwd(),'dist/apps/desktop/main.js')]),'--root',ws.root],env});
 t.after(async()=>{await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();}).catch(()=>{});await app.close();await rm(temp,{recursive:true,force:true});});
 const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>!!sessionStorage.getItem('slide-studio:admin-token'));
 await page.goto(new URL('/deck/talk',page.url()).href);await page.locator('#stage[data-blocks=ready]').waitFor();
 await page.evaluate(()=>{Element.prototype.requestFullscreen=()=>Promise.reject(Error('test denial'));});
 const editor=page.frameLocator('#slideBox > iframe:not(.loading)'),player=page.frameLocator('.present-screen iframe');
 return {ws,page,editor,player,errors};
}
async function state(frame:FrameLocator,index:number,step=0){
 for(let i=0;i<100;i++){const actual=await frame.locator('body').evaluate(() => [(window as any).deck?.index,(window as any).deck?.step]);if(actual[0]===index&&actual[1]===step)return;await new Promise(r=>setTimeout(r,30));}
 assert.deepEqual(await frame.locator('body').evaluate(()=>[(window as any).deck?.index,(window as any).deck?.step]),[index,step]);
}
async function start(page:Page,name='最初から'){
 await page.getByRole('button',{name,exact:true}).click();await page.frameLocator('.present-screen iframe').locator('.slide.active').waitFor();await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('.present-tools > button')?.disabled);
}
async function finish(page:Page){await page.keyboard.press('Escape');await page.locator('.present-screen').waitFor({state:'detached'});}

test('presentation flushes pending source, freezes its document and returns to the final page',{timeout:60000},async t=>{
 const {ws,page,editor,player,errors}=await setup(t);
 await page.getByRole('button',{name:'すべての記法を表示',exact:true}).click();
 await page.evaluate(()=>{const ta=document.querySelector<HTMLTextAreaElement>('.raw textarea')!;ta.value=ta.value.replace('最初の段落。','発表前に保存。');ta.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector<HTMLButtonElement>('.present-tools > button')!.click();});
 await player.locator('p').filter({hasText:'発表前に保存。'}).waitFor();assert.match(await readFile(ws.qmd('talk'),'utf8'),/発表前に保存。/);await state(player,0);
 await writeFile(ws.qmd('talk'),(await readFile(ws.qmd('talk'),'utf8')).replace('発表前に保存。','外部の変更。'));
 await editor.locator('p').filter({hasText:'外部の変更。'}).waitFor({state:'attached'});assert.equal(await player.locator('p').filter({hasText:'外部の変更。'}).count(),0);
 assert.equal(await player.locator('.slide-studio-selected, .slide-studio-editing').count(),0);
 await player.locator('body').press('ArrowDown');await state(player,1);await finish(page);await state(editor,1);await page.locator('#pagestrip button[data-index="3"]').click();await state(editor,3);await start(page);await state(player,0);await finish(page);await state(editor,0);assert.deepEqual(errors,[]);
});

for(const failure of ['save','render'])test(`presentation refuses ${failure} failure and can retry`,{timeout:60000},async t=>{
 const {ws,page,player,errors}=await setup(t),before=await readFile(ws.qmd('talk'),'utf8');
 const pattern=failure==='save'?'**/api/deck/talk/source':'**/api/deck/talk/preview';let presentRequests=0;
 page.on('request',r=>{if(r.url().endsWith('/preview')&&r.postDataJSON()?.mode==='present')presentRequests++;});
 await page.route(pattern,async route=>{if(failure==='render'&&route.request().postDataJSON()?.mode!=='present')return route.continue();await route.fulfill({status:500,json:{error:'fixture failure'}});});
 if(failure==='save'){
  await page.getByRole('button',{name:'すべての記法を表示',exact:true}).click();
  await page.evaluate(()=>{const ta=document.querySelector<HTMLTextAreaElement>('.raw textarea')!;ta.value+='\n未保存の入力。';ta.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector<HTMLButtonElement>('.present-tools > button')!.click();});
 }else await page.getByRole('button',{name:'最初から',exact:true}).click();
 await page.locator('.toast').filter({hasText:failure==='save'?'保存できませんでした':'発表を始められませんでした'}).waitFor();assert.equal(await page.locator('.present-screen').count(),0);assert.equal(await readFile(ws.qmd('talk'),'utf8'),before);
 if(failure==='save')assert.equal(presentRequests,0);
 await page.unroute(pattern);await start(page);await state(player,0);await finish(page);assert.deepEqual(errors,[]);
});

for(const focus of ['toolbar','preview'])test(`presentation and export shortcuts from ${focus} preserve typing and starting position`,{timeout:90000},async t=>{
 const {page,editor,player,errors}=await setup(t);
 for(const [shortcut,index] of [['f',1],['Shift+F',0]] as const){
  await page.locator('#pagestrip button[data-index="1"]').click();await state(editor,1);
  if(focus==='toolbar')await page.locator('.present-tools > button').first().focus();else await editor.locator('body').evaluate(()=>window.focus());
  await page.keyboard.press(shortcut);await player.locator('.slide.active').waitFor();await state(player,index);await finish(page);await state(editor,index);
 }
 for(const format of ['html','pdf']){
  let request:any;await page.route('**/api/deck/talk/build',async route=>{request=route.request().postDataJSON();await route.fulfill({json:{blocked:true,result:{errors:[],warnings:[]}}});});
  if(focus==='toolbar')await page.locator('.present-tools > button').first().focus();else await editor.locator('body').evaluate(()=>window.focus());
  await page.keyboard.press('p');await page.locator('[data-format="html"]').waitFor();await page.locator('[data-format="pdf"]').waitFor();await page.keyboard.press('p');assert.equal(request,undefined);
  await page.locator(`[data-format="${format}"]`).click();await page.locator('[data-force]').waitFor();assert.equal((request as any).format,format);assert.equal((request as any).force,false);await page.keyboard.press('Escape');await page.unroute('**/api/deck/talk/build');
 }
 await page.getByRole('button',{name:'すべての記法を表示',exact:true}).click();const field=page.locator('.raw textarea');await field.focus();await field.press('End');const before=await field.inputValue();await page.keyboard.type('pfF');assert.equal((await field.inputValue()).length,before.length+3);assert.equal(await page.locator('.present-screen,.output-popover').count(),0);assert.deepEqual(errors,[]);
});

for(const present of [false,true])for(const outside of [false,true])test(`horizontal swipe groups momentum and respects bounds (present=${present}, outside=${outside})`,{timeout:60000},async t=>{
 const {page,editor,player,errors}=await setup(t);if(present)await start(page);const frame=present?player:editor;
 await frame.locator('body').evaluate(()=>{(window as any).deck.go(1,1);});await state(frame,1,1);
 const wheel=async(events:Record<string,number|boolean>[])=>{
  const send=(events:Record<string,number|boolean>[])=>events.map(options=>{const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,...options});document.body.dispatchEvent(e);return e.defaultPrevented;});
  return outside?page.evaluate(send,events):frame.locator('body').evaluate((_el,events)=>events.map(options=>{const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,...options});document.body.dispatchEvent(e);return e.defaultPrevented;}),events);
 };
 assert.deepEqual(await wheel([{deltaX:10,deltaY:80},{deltaX:100,ctrlKey:true}]),[false,false]);await state(frame,1,1);
 assert.deepEqual(await wheel([15,15,20,100,60,20,2].map(deltaX=>({deltaX}))),[true,true,true,true,true,true,true]);await state(frame,2);
 await page.waitForTimeout(250);await wheel([{deltaX:-80},{deltaX:-40}]);await state(frame,1);
 await page.waitForTimeout(250);await frame.locator('body').evaluate(()=>(window as any).deck.go(0));await wheel([{deltaX:-80}]);await state(frame,0);
 await page.waitForTimeout(250);await frame.locator('body').evaluate(()=>(window as any).deck.go(3));await wheel([{deltaX:80}]);await state(frame,3);
 if(present)await finish(page);assert.deepEqual(errors,[]);
});

test('fullscreen exit ends presentation and key release does not toggle fullscreen',{timeout:60000},async t=>{
 const {page,editor,player,errors}=await setup(t);
 await page.evaluate(()=>{let current:Element|null=null;Object.defineProperty(document,'fullscreenElement',{get:()=>current});Element.prototype.requestFullscreen=async function(){current=this;document.dispatchEvent(new Event('fullscreenchange'));};document.exitFullscreen=async()=>{current=null;document.dispatchEvent(new Event('fullscreenchange'));};});
 await page.locator('.present-tools > button').first().focus();await page.keyboard.down('f');await player.locator('.slide.active').waitFor();await page.waitForFunction(()=>document.fullscreenElement!==null);await page.keyboard.up('f');assert.equal(await page.evaluate(()=>document.fullscreenElement!==null),true);
 await player.locator('body').evaluate(()=>(window as any).deck.go(3));await state(player,3);await page.waitForTimeout(100);await page.evaluate(()=>document.exitFullscreen());await page.locator('.present-screen').waitFor({state:'detached'});await state(editor,3);assert.deepEqual(errors,[]);
});

test('preview typing and selected-block padding keep priority over presentation shortcuts',{timeout:60000},async t=>{
 const {ws,page,editor,errors}=await setup(t),paragraph=editor.locator('.slide.active p').filter({hasText:'最初の段落。'});
 await paragraph.click();await editor.locator('.slide-studio-selected').waitFor();await page.keyboard.down('f');assert.equal(await page.locator('.present-screen').count(),0);await page.keyboard.up('f');
 await paragraph.click();const editing=editor.locator('.slide-studio-editing');await editing.waitFor();await editing.fill('入力中');await page.keyboard.type('pfF');assert.match(await editing.innerText(),/pfF/);assert.equal(await page.locator('.present-screen,.output-popover').count(),0);await editing.press('Escape');
 for(let i=0;i<100;i++){if((await readFile(ws.qmd('talk'),'utf8')).includes('pfF'))break;await page.waitForTimeout(30);}assert.match(await readFile(ws.qmd('talk'),'utf8'),/pfF/);assert.deepEqual(errors,[]);
});

for(const present of [false,true])for(const outside of [false,true])test(`repeated swipes during momentum allow a fresh gesture and ignore jitter (present=${present}, outside=${outside})`,{timeout:60000},async t=>{
 const {page,editor,player,errors}=await setup(t);if(present)await start(page);const frame=present?player:editor;
 await frame.locator('body').evaluate(()=>{const w=window as any;w.__wheelClock=1000;w.__wheelCount=0;w.__wheelNow=performance.now;performance.now=()=>w.__wheelClock;const original=w.deck.pageWheel;w.__wheelOriginal=original;w.deck.pageWheel=(e:WheelEvent)=>{original(e);w.__wheelCount++;};w.deck.go(1);});
 let sent=0;
 const send=async(dx:number,dt=30)=>{
  await frame.locator('body').evaluate((_el,dt)=>{(window as any).__wheelClock+=dt;},dt);
  if(outside){await page.evaluate(dx=>document.body.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:dx})),dx);sent++;for(let i=0;i<100;i++){if(await frame.locator('body').evaluate(()=>(window as any).__wheelCount)===sent)break;await page.waitForTimeout(10);}assert.equal(await frame.locator('body').evaluate(()=>(window as any).__wheelCount),sent);}
  else await frame.locator('body').evaluate((_el,dx)=>document.body.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:dx})),dx);
  return await frame.locator('body').evaluate(()=>(window as any).deck.index);
 };
 try{
  for(const [deltas,expected] of [
   [[15,15,20,100,60,30,12,5,2],[1,1,2,2,2,2,2,2,2]],
   [[12,20,25,80,35,10,3],[2,2,3,3,3,3,3]],
   [[-2,2,-3,1],[3,3,3,3]],
   [[-15,-15,-20,-80,-20,-2],[3,3,2,2,2,2]],
  ]){const actual=[];for(const dx of deltas!)actual.push(await send(dx));assert.deepEqual(actual,expected);}
  assert.equal(await send(-50,250),1);
 }finally{await frame.locator('body').evaluate(()=>{const w=window as any;performance.now=w.__wheelNow;w.deck.pageWheel=w.__wheelOriginal;});}
 if(present)await finish(page);assert.deepEqual(errors,[]);
});

test('export progress follows only the active request and clears after a blocked check',{timeout:60000},async t=>{
 const {page,errors}=await setup(t);
 await page.addInitScript(()=>{const original=window.fetch;window.fetch=async(input,init)=>{if(new URL(input instanceof Request?input.url:String(input),location.href).pathname!=='/api/events')return original(input,init);return new Response(new ReadableStream({start(controller){(window as any).__testEvents=controller;}}),{headers:{'content-type':'text/event-stream'}});};});
 await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();
 let request:any,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/deck/talk/build',async route=>{request=route.request().postDataJSON();await gate;await route.fulfill({json:{blocked:true,result:{errors:[],warnings:[]}}});});
 try{
  await page.getByRole('button',{name:'書き出し',exact:true}).click();await page.locator('[data-format="html"]').click();const bar=page.locator('.output-progress');await bar.waitFor();
  for(let i=0;i<100&&!request;i++)await page.waitForTimeout(20);assert.ok(request);
  const emit=async(value:number|null,phase:string,id=request.id)=>page.evaluate(async data=>{(window as any).__testEvents.enqueue(new TextEncoder().encode('data: '+JSON.stringify(data)+'\n\n'));await new Promise(resolve=>setTimeout(resolve,0));},{type:'export-progress',deck:'talk',id,value,phase});
  await emit(null,'check');await page.getByText('ページを検査しています…',{exact:true}).waitFor();assert.equal(await bar.getAttribute('value'),null);
  await emit(20,'check');assert.equal(await bar.getAttribute('value'),'20');await emit(60,'check','another-request');assert.equal(await bar.getAttribute('value'),'20');await emit(80,'check');assert.equal(await bar.getAttribute('value'),'80');await emit(85,'export');await page.getByText('書き出しています…',{exact:true}).waitFor();assert.equal(await bar.getAttribute('value'),'85');
 }finally{release();}
 await page.locator('[data-force]').waitFor();assert.equal(await page.locator('.output-progress').count(),0);assert.deepEqual(errors,[]);
});
