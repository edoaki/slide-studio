import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {_electron, type FrameLocator, type Page} from 'playwright-core';
import {Workspace} from '../../packages/core/src/workspace.js';
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
// 最初のページからの発表（Shift+F）。ボタンの名前を渡すと、そのボタンで始める
async function start(page:Page,name?:string){
 if(name)await page.getByRole('button',{name,exact:true}).click();else await page.evaluate(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',shiftKey:true,bubbles:true}));});await page.frameLocator('.present-screen iframe').locator('.slide.active').waitFor();await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('.present-tools > button')?.disabled);
}
async function finish(page:Page){await page.keyboard.press('Escape');await page.locator('.present-screen').waitFor({state:'detached'});}

test('presentation flushes pending source, freezes its document and returns to the final page',{timeout:60000},async t=>{
 const {ws,page,editor,player,errors}=await setup(t);
 await page.getByRole('button',{name:'すべての記法を表示',exact:true}).click();
 await page.evaluate(()=>{const ta=document.querySelector<HTMLTextAreaElement>('.raw textarea')!;ta.value=ta.value.replace('最初の段落。','発表前に保存。');ta.dispatchEvent(new Event('input',{bubbles:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',shiftKey:true,bubbles:true}));});
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
  await page.evaluate(()=>{const ta=document.querySelector<HTMLTextAreaElement>('.raw textarea')!;ta.value+='\n未保存の入力。';ta.dispatchEvent(new Event('input',{bubbles:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',shiftKey:true,bubbles:true}));});
 }else await page.evaluate(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',shiftKey:true,bubbles:true}));});
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

test('presentation can restart after exiting while fullscreen entry is pending',{timeout:60000},async t=>{
 const {page,player,errors}=await setup(t);
 await page.evaluate(()=>{Element.prototype.requestFullscreen=()=>new Promise<void>(()=>{});});
 await page.getByRole('button',{name:'今のページから',exact:true}).click();
 await player.locator('.slide.active').waitFor();
 await finish(page);
 await page.waitForFunction(()=>[...document.querySelectorAll<HTMLButtonElement>('.present-tools > button')].every(b=>!b.disabled),{},{timeout:2000});
 await page.evaluate(()=>{Element.prototype.requestFullscreen=()=>Promise.reject(Error('test denial'));});
 await start(page,'今のページから');await finish(page);assert.deepEqual(errors,[]);
});

test('speaker notes stay out of GUI and projection; the presenter view syncs a separate window',{timeout:120000},async t=>{
 const {ws,page,editor,errors}=await setup(t);
 await page.locator('.speaker-notes > summary').click();
 const note=page.locator('.speaker-notes textarea');await note.fill('ページ専用の秘密メモ');
 await page.locator('.speaker-notes [role=status]').filter({hasText:'保存済み'}).waitFor();
 await page.locator('.speaker-notes button').filter({hasText:'全体'}).click();await note.fill('発表全体の秘密メモ');
 await page.locator('.speaker-notes [role=status]').filter({hasText:'保存済み'}).waitFor();
 const qmd=await readFile(ws.qmd('talk'),'utf8');assert.match(qmd,/\.note/);assert.match(qmd,/発表全体の秘密メモ/);assert.match(qmd,/ページ専用の秘密メモ/);
 assert.equal(await page.locator('#qblocks').getByText('ページ専用の秘密メモ',{exact:false}).count(),0);
 assert.equal(await editor.locator('body').getByText('ページ専用の秘密メモ',{exact:false}).count(),0);
 await page.locator('.bar').screenshot({path:'/tmp/slide-studio-speaker-toolbar.png'});
 const popupEvent=page.waitForEvent('popup');await page.getByRole('button',{name:'発表者ビュー',exact:true}).click();
 const screen=page.locator('.speaker-screen');await screen.locator('.speaker-current iframe').waitFor();
 await screen.getByRole('button',{name:'計測開始',exact:true}).click();
 await screen.locator('.speaker-note-page textarea').fill('発表中に追記した秘密メモ');
 await screen.locator('.speaker-note-page [role=status]').filter({hasText:'保存済み'}).waitFor();
 const popup=await popupEvent;
 const projected=popup.frameLocator('iframe');await projected.locator('.slide.active').waitFor();
 assert.equal(await projected.locator('body').getByText('秘密メモ',{exact:false}).count(),0);
 await page.screenshot({path:'/tmp/slide-studio-presenter.png'});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await page.screenshot({path:'/tmp/slide-studio-presenter-dark.png'});
 await screen.locator('.speaker-controls > summary').click();await screen.getByRole('radio',{name:'ページ数で指定',exact:true}).click();await screen.getByRole('spinbutton',{name:'数えるページ数',exact:true}).waitFor();
 await page.screenshot({path:'/tmp/slide-studio-presenter-options.png'});
 await page.keyboard.press('Escape');assert.equal(await screen.count(),1);assert.equal(await screen.locator('.speaker-controls').getAttribute('open'),null);
 await page.evaluate(()=>{document.documentElement.dataset.theme='light';});

 await screen.getByRole('button',{name:'進む',exact:true}).click();
 await state(page.frameLocator('.speaker-current iframe'),1);await state(projected,1);
 await projected.locator('body').evaluate(()=>{window.focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));});await state(projected,0);await state(page.frameLocator('.speaker-current iframe'),0);
 await screen.getByRole('button',{name:'進む',exact:true}).click();await state(projected,1);
 await screen.getByRole('button',{name:'一時停止',exact:true}).click();
 assert.match(await screen.locator('.speaker-progress').innerText(),/2 \/ 4/);
 await screen.getByRole('button',{name:'発表を終了',exact:true}).click();await screen.waitFor({state:'detached'});
 await assert.rejects(readFile(join(ws.deck_dir('talk'),'rehearsals.json'),'utf8'),{code:'ENOENT'});
 assert.equal(await page.locator('.speaker-results').count(),0);
 assert.match(await readFile(ws.qmd('talk'),'utf8'),/発表中に追記した秘密メモ/);
 assert.deepEqual(errors,[]);
});

test('speaker note follows the page and persists after the presenter view',{timeout:90000},async t=>{
 const {ws,page}=await setup(t);
 await page.getByRole('button',{name:'発表者ビュー',exact:true}).click();const screen=page.locator('.speaker-screen');
 const field=screen.locator('.speaker-note-page textarea'),globalField=screen.locator('.speaker-note-global textarea');
 // 発表者ビューでは、ページのメモと全体のメモを上下に並べて同時に表示する
 await screen.getByText('p1 のメモ',{exact:true}).waitFor();await screen.getByText('全体のメモ',{exact:true}).waitFor();
 assert.equal(await screen.getByRole('button',{name:'全体',exact:true}).count(),0);
 const [top,bottom]=await Promise.all([field.boundingBox(),globalField.boundingBox()]);assert.ok(top&&bottom&&top.y+top.height<=bottom.y,'page note sits above the global note');
 await field.fill('一枚目のメモ\n```\n:::');
 await screen.getByRole('button',{name:'進む',exact:true}).click();await state(page.frameLocator('.speaker-current iframe'),1);
 await screen.getByText('p2 のメモ',{exact:true}).waitFor();
 await field.fill('二枚目のメモ');await screen.locator('.speaker-note-page [role=status]').filter({hasText:'保存済み'}).waitFor();
 await screen.getByRole('button',{name:'戻る',exact:true}).click();await state(page.frameLocator('.speaker-current iframe'),0);
 await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.speaker-screen .speaker-note-page textarea')?.value==='一枚目のメモ\n```\n:::');
 await globalField.fill('全体共通');await screen.locator('.speaker-note-global [role=status]').filter({hasText:'保存済み'}).waitFor();
 assert.equal(await field.inputValue(),'一枚目のメモ\n```\n:::');
 await screen.getByRole('button',{name:'計測開始',exact:true}).click();
 await screen.getByRole('button',{name:'発表を終了',exact:true}).click();await screen.waitFor({state:'detached'});
 await assert.rejects(readFile(join(ws.deck_dir('talk'),'rehearsals.json'),'utf8'),{code:'ENOENT'});
 await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();
 await page.locator('.speaker-notes > summary').click();await page.locator('.speaker-notes button').filter({hasText:'全体'}).click();
 await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.speaker-notes textarea')?.value==='全体共通');
});


test('presenter button opens the presenter view directly without a menu',{timeout:60000},async t=>{
 const {page,editor,player,errors}=await setup(t);
 assert.equal(await page.locator('.speaker-tools').count(),0);
 const presenter=page.getByRole('button',{name:'発表者ビュー',exact:true});
 assert.equal(await presenter.getAttribute('aria-haspopup'),null);
 await page.locator('#pagestrip button[data-index="1"]').click();await state(editor,1);
 await presenter.click();const screen=page.locator('.speaker-screen');await screen.locator('.speaker-current iframe').waitFor();
 assert.equal(await page.getByRole('dialog',{name:'発表用メニュー',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'発表原稿を作成',exact:true}).count(),0);
 await screen.getByRole('button',{name:'計測開始',exact:true}).click();
 await screen.getByRole('button',{name:'発表を終了',exact:true}).click();await screen.waitFor({state:'detached'});
 await page.locator('#pagestrip button[data-index="1"]').click();await state(editor,1);
 await page.locator('.present-tools > button').first().focus();await page.keyboard.press('f');await state(player,1);await finish(page);
 await page.locator('.present-tools > button').first().focus();await page.keyboard.press('Shift+F');await state(player,0);await finish(page);assert.deepEqual(errors,[]);
});

test('speaker note uses visible page numbers and grows only to six lines',{timeout:60000},async t=>{
 const {page,errors}=await setup(t);const panel=page.locator('.speaker-notes');
 // 発表メモは #viewport 上端の余白に重ねる。開閉・行の増減でスライドの位置が 1px も動かない
 const top=()=>page.locator('#slideBox').evaluate(el=>new Promise<number>(r=>requestAnimationFrame(()=>r(el.getBoundingClientRect().top))));
 const before=await top();const chip=(await panel.locator('summary').boundingBox())!;assert.ok(chip.y+chip.height<=before,'collapsed notes must not cover the slide');
 await panel.locator('summary').click();
 await panel.getByRole('button',{name:'p1',exact:true}).waitFor();const field=panel.locator('textarea');
 // 開くとページのメモ欄に入力カーソルが入り、すぐ書き始められる
 await page.waitForFunction(()=>document.activeElement===document.querySelector('.speaker-notes textarea'));
 assert.equal(await top(),before);assert.equal(await field.getAttribute('placeholder'),null);
 const size=()=>field.evaluate(el=>{const s=getComputedStyle(el);return {height:el.getBoundingClientRect().height,line:parseFloat(s.lineHeight),padding:parseFloat(s.paddingTop)+parseFloat(s.paddingBottom),overflow:s.overflowY,scroll:el.scrollHeight,client:el.clientHeight};});
 await field.fill('短いメモ');const short=await size();assert.ok(short.height <= short.line+short.padding+2);
 await field.fill('1\n2\n3\n4\n5\n6');const six=await size();assert.ok(six.height > short.height*3);assert.ok(six.height <= six.line*6+six.padding+2);
 await field.fill('1\n2\n3\n4\n5\n6\n7\n8\n9');const long=await size();assert.ok(Math.abs(long.height-six.height)<2);assert.equal(long.overflow,'auto');assert.ok(long.scroll>long.client);
 assert.equal(await top(),before);
 await page.screenshot({path:'/tmp/slide-studio-notes-six-lines.png'});
 await field.fill('短いメモ');assert.ok((await size()).height <= short.height+2);
 await page.locator('#pagestrip button[data-index="1"]').click();await panel.getByRole('button',{name:'p2',exact:true}).waitFor();
 await panel.getByRole('button',{name:'全体',exact:true}).click();assert.equal(await field.getAttribute('placeholder'),null);await field.fill('全体のメモ');await panel.locator('[role=status]').filter({hasText:'保存済み'}).waitFor();
 await panel.locator('summary').click();assert.equal(await top(),before);await panel.locator('summary').click();
 await page.waitForFunction(()=>{const f=document.querySelector<HTMLTextAreaElement>('.speaker-notes textarea');return document.activeElement===f&&f!.selectionStart===f!.value.length;});
 assert.ok((await size()).height <= short.height+2);
 await field.press('Escape');assert.equal(await panel.evaluate(el=>(el as HTMLDetailsElement).open),false);assert.equal(await top(),before);
 await page.getByRole('button',{name:'発表者ビュー',exact:true}).click();
 const screen=page.locator('.speaker-screen');await screen.getByText('p1 のメモ',{exact:true}).waitFor();await screen.getByRole('button',{name:'進む',exact:true}).click();await screen.getByText('p2 のメモ',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
});
