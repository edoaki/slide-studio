import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {_electron, type Page} from 'playwright-core';
import {new_figure} from '../../packages/core/src/legacy-figures.js';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';
const require=createRequire(import.meta.url);
async function setup(t:TestContext,source:string,bib='',prepare?:(ws:Workspace,page:Page)=>Promise<void>){
 const temp=await mkdtemp(join(tmpdir(),'studio-authoring-')),ws=Workspace.open(join(temp,'workspace'));ws.new_deck('talk','test');
 await writeFile(ws.qmd('talk'),`---\ntitle: 編集の確認\ntopic: test\ntheme: default\n---\n\n${source}`);
 if(bib)await writeFile(ws.bib('talk'),bib);
 const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;env.SLIDE_STUDIO_ELECTRON_HOME=join(temp,'profile');
 const installed=process.env.SLIDE_STUDIO_TEST_APP,executablePath=installed?.endsWith('.app')?join(installed,'Contents/MacOS/Slide Studio'):installed||require('electron');
 const app=await _electron.launch({executablePath,args:[...(installed?[]:[join(process.cwd(),'dist/apps/desktop/main.js')]),'--root',ws.root],env});
 t.after(async()=>{try{await app.evaluate(async()=>{await (globalThis as any).__restoreParityClipboard?.();}).catch(()=>{});}finally{await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();}).catch(()=>{});await app.close().catch(()=>{});await rm(temp,{recursive:true,force:true});}});
 const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>!!sessionStorage.getItem('slide-studio:admin-token'));
 if(prepare)await prepare(ws,page);
 const url=new URL('/deck/talk',page.url()).href;await page.goto(url);await page.locator('#stage[data-blocks=ready]').waitFor();
 return {ws,page,url,errors,app};
}
async function saved(ws:Workspace,text:string){for(let i=0;i<100;i++){if((await readFile(ws.qmd('talk'),'utf8')).includes(text))return;await new Promise(r=>setTimeout(r,50));}assert.match(await readFile(ws.qmd('talk'),'utf8'),new RegExp(text));}

const DOC='## 最初 {#one}\n\n最初の段落。\n\n二番目の段落。\n\n## まとめ {#summary}\n\nまとめの段落。\n';
async function rawMode(page:Page){await page.getByRole('button',{name:'すべての記法を表示',exact:true}).click();}
async function typeAt(page:Page,needle:string,text:string){await page.locator('.raw textarea').evaluate((e,needle)=>{const ta=e as HTMLTextAreaElement,i=ta.value.indexOf(needle)+needle.length;ta.focus();ta.setSelectionRange(i,i);},needle);await page.keyboard.insertText(text);}
async function clean(page:Page){await page.waitForFunction(()=>['保存済み','検査：問題なし'].includes(document.querySelector('#status')?.textContent||''));}

test('legacy source typing saves and updates the slide within the original latency budget',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await rawMode(page);await typeAt(page,'最初の段落','X');const start=performance.now();await page.frameLocator('#slideBox > iframe:not(.loading)').locator('.slide.active').filter({hasText:'最初の段落X'}).waitFor({timeout:5000});assert.ok(performance.now()-start<1500);await saved(ws,'最初の段落X');await clean(page);assert.deepEqual(errors,[]);
});

test('legacy external source and title changes refresh the editor and preview',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await rawMode(page);let text=await readFile(ws.qmd('talk'),'utf8');await writeFile(ws.qmd('talk'),text.replace('最初の段落。','外で直した段落。'));await page.frameLocator('#slideBox > iframe:not(.loading)').locator('.slide.active').filter({hasText:'外で直した段落'}).waitFor({timeout:5000});await page.waitForFunction(()=>(document.querySelector('.raw textarea') as HTMLTextAreaElement).value.includes('外で直した段落'));text=await readFile(ws.qmd('talk'),'utf8');await writeFile(ws.qmd('talk'),text.replace('title: 編集の確認','title: 新しい題名'));await page.waitForFunction(()=>document.querySelector('#deckTitle')?.textContent==='新しい題名');assert.deepEqual(errors,[]);
});

test('legacy external conflict retains unsaved input until explicit discard',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await rawMode(page);await page.evaluate(()=>{const original=window.fetch;window.fetch=(u,o)=>o?.method==='PUT'?new Promise(()=>{}):original(u,o);});await typeAt(page,'二番目の段落','（入力）');await writeFile(ws.qmd('talk'),(await readFile(ws.qmd('talk'),'utf8')).replace('まとめの段落。','外の変更。'));await page.locator('#edBanner .banner').waitFor();assert.match(await page.locator('#status').innerText(),/外で変更されました/);assert.match(await page.locator('.raw textarea').inputValue(),/二番目の段落（入力）/);assert.doesNotMatch(await readFile(ws.qmd('talk'),'utf8'),/（入力）/);await page.getByText('読み込み直す（自分の変更を捨てる）',{exact:true}).click();await page.waitForFunction(()=>(document.querySelector('.raw textarea') as HTMLTextAreaElement).value.includes('外の変更。'));assert.doesNotMatch(await page.locator('.raw textarea').inputValue(),/（入力）/);assert.deepEqual(errors,[]);
});

test('legacy stale save returns a conflict before overwriting external changes',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await rawMode(page);await page.route('**/api/deck/talk/source',async route=>{if(route.request().method()==='PUT')await writeFile(ws.qmd('talk'),(await readFile(ws.qmd('talk'),'utf8')).replace('まとめの段落。','先に変わった。'));await route.continue();});const response=page.waitForResponse(r=>r.url().endsWith('/source')&&r.request().method()==='PUT');await typeAt(page,'最初の段落。','Y');assert.equal((await response).status(),409);await page.locator('#edBanner .banner').waitFor();const savedText=await readFile(ws.qmd('talk'),'utf8');assert.match(savedText,/先に変わった/);assert.doesNotMatch(savedText,/段落。Y/);assert.deepEqual(errors,[]);
});

for(const clipboard of ['denied','missing','success'])test(`legacy conflict copy handles clipboard ${clipboard} without losing either version`,{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await rawMode(page);const original=await readFile(ws.qmd('talk'),'utf8'),external=original.replace('まとめの段落。','先に変わった。');await writeFile(ws.qmd('talk'),external);const raw=page.locator('.raw textarea'),visible=await raw.inputValue(),pending=original.replace('最初の段落。','自分の入力。'),pendingVisible=visible.replace('最初の段落。','自分の入力。');await raw.fill(pendingVisible);await page.locator('#edBanner .banner').waitFor();
 await page.evaluate(mode=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:mode==='missing'?undefined:{writeText:async(text:string)=>{if(mode==='denied')throw Error('denied');(window as any).copiedText=text;}}}),clipboard);await page.locator('#edBanner [data-act=copy]').click();
 if(clipboard!=='success'){const fallback=page.locator('#edBanner .copy-fallback textarea');await fallback.waitFor();assert.equal(await fallback.inputValue(),pending);assert.ok(await fallback.evaluate(e=>{const t=e as HTMLTextAreaElement;return t.readOnly&&document.activeElement===t&&t.selectionStart===0&&t.selectionEnd===t.value.length;}));assert.match(await page.locator('#edBanner').innerText(),/クリップボードに写せませんでした/);assert.equal(await raw.inputValue(),pendingVisible);assert.equal(await readFile(ws.qmd('talk'),'utf8'),external);await page.locator('#edBanner [data-act=discard]').click();}else{await page.waitForFunction(()=>!!(window as any).copiedText);assert.equal(await page.evaluate(()=>(window as any).copiedText),pending);}
 await page.waitForFunction(()=>(document.querySelector('.raw textarea') as HTMLTextAreaElement).value.includes('先に変わった。'));assert.equal(await raw.inputValue(),visible.replace('まとめの段落。','先に変わった。'));assert.equal(await page.locator('#edBanner .banner').count(),0);assert.deepEqual(errors,[]);
});

test('legacy opening navigating and closing a deck does not rewrite its source',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC),before=await readFile(ws.qmd('talk'),'utf8'),mtime=(await stat(ws.qmd('talk'))).mtimeMs;await rawMode(page);await page.locator('#pagestrip button[data-index="1"]').click();await page.goto(new URL('/',page.url()).href);await page.locator('.deck-card-wrap[data-deck="talk"]').waitFor();assert.equal(await readFile(ws.qmd('talk'),'utf8'),before);assert.equal((await stat(ws.qmd('talk'))).mtimeMs,mtime);assert.deepEqual(errors,[]);
});

test('legacy conversion error retains the last successful slide and reports stale output',{timeout:60000},async t=>{
 const {ws,page}=await setup(t,DOC);await rawMode(page);await page.locator('#pagestrip button[data-index="1"]').click();const frame=page.frameLocator('#slideBox > iframe:not(.loading)');await frame.locator('.slide.active').filter({hasText:'まとめの段落'}).waitFor();const before=await frame.locator('.slide.active').innerText();await writeFile(ws.qmd('talk'),(await readFile(ws.qmd('talk'),'utf8')).replace('theme: default','theme: [default'));await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='表示が古い（変換に失敗）');await page.locator('.stale-badge').waitFor();assert.match(await page.locator('#qstatus').innerText(),/line/);assert.equal(await frame.locator('.slide.active').innerText(),before);
});

test('legacy global undo and redo work after moving focus outside the source',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await rawMode(page);await typeAt(page,'まとめの段落','Z');await saved(ws,'まとめの段落Z');await clean(page);await page.locator('#chatToggle').click();await page.keyboard.press('Meta+z');await page.waitForFunction(()=>!(document.querySelector('.raw textarea') as HTMLTextAreaElement).value.includes('まとめの段落Z'));await clean(page);assert.doesNotMatch(await readFile(ws.qmd('talk'),'utf8'),/まとめの段落Z/);await page.keyboard.press('Meta+Shift+z');await saved(ws,'まとめの段落Z');assert.deepEqual(errors,[]);
});

test('legacy slow saves remain serialized and persist the latest input',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await rawMode(page);await page.evaluate(()=>{const original=window.fetch,w=window as any;w.saveRequests=0;w.activeSaves=0;w.maxSaves=0;window.fetch=async(u,o)=>{if(o?.method!=='PUT'||!String(u).endsWith('/source'))return original(u,o);w.saveRequests++;w.activeSaves++;w.maxSaves=Math.max(w.maxSaves,w.activeSaves);const r=await original(u,o);await new Promise(r=>setTimeout(r,1200));w.activeSaves--;return r;};});await typeAt(page,'最初の段落','A');await page.waitForFunction(()=>(window as any).saveRequests===1);await typeAt(page,'最初の段落A','B');await clean(page);await page.frameLocator('#slideBox > iframe:not(.loading)').locator('.slide.active').filter({hasText:'最初の段落AB'}).waitFor({timeout:5000});assert.deepEqual(await page.evaluate(()=>[(window as any).maxSaves,(window as any).saveRequests]),[1,2]);await saved(ws,'最初の段落AB');assert.equal(await page.locator('.banner').count(),0);assert.deepEqual(errors,[]);
});

test('legacy fractional preview widths have no exposed edge gap',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,DOC);for(const width of [714,714.25,714.5,713.75]){await page.locator('#slideBox').evaluate((e,w)=>(e as HTMLElement).style.width=`${w}px`,width);await page.waitForTimeout(100);const box=await page.locator('#slideBox iframe:not(.loading)').boundingBox();assert.ok(box);const bounds=await page.frameLocator('#slideBox > iframe:not(.loading)').locator('#stage').evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};});assert.ok(Math.abs(bounds.x)<.02&&Math.abs(bounds.y)<.02&&Math.abs(bounds.right-box.width)<.02&&Math.abs(bounds.bottom-box.height)<.02,JSON.stringify({bounds,box}));}assert.deepEqual(errors,[]);
});

test('legacy undo redo tooltips show disabled shortcuts without an insert button',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,DOC);assert.equal(await page.locator('header.bar #insertBtn').count(),0);for(const [selector,name,keys] of [['#undo','元に戻す',['⌘','Z']],['#redo','やり直す',['⇧','⌘','Z']]] as const){await page.locator(selector).hover();await page.locator('.tip.show').waitFor();assert.equal(await page.locator('.tip.show .tip-name').innerText(),name);assert.deepEqual(await page.locator('.tip.show kbd').allInnerTexts(),[...keys]);await page.mouse.move(0,400);await page.locator('.tip.show').waitFor({state:'hidden'});}assert.deepEqual(errors,[]);
});

test('legacy chat width dragging persists across reload and respects its minimum',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,DOC);const width=()=>page.locator('#chat').evaluate(e=>e.getBoundingClientRect().width),before=await width();const drag=async(delta:number)=>{const b=await page.locator('#chatSplitter').boundingBox();assert.ok(b);const x=b.x+b.width/2,y=b.y+b.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+delta,y,{steps:5});await page.mouse.up();};await drag(-150);assert.ok(Math.abs(await width()-before-150)<3);await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();assert.ok(Math.abs(await width()-before-150)<3);await drag(1000);assert.ok(Math.abs(await width()-300)<1);assert.deepEqual(errors,[]);
});

test('legacy zero shortcut closes the editor while typing zero stays in the input',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,DOC);const off=()=>page.evaluate(()=>document.body.classList.contains('editor-off'));await page.evaluate(()=>(document.activeElement as HTMLElement)?.blur());assert.equal(await page.locator('#editorToggle').getAttribute('data-keys'),'0');await page.keyboard.press('0');assert.equal(await off(),true);assert.equal(await page.locator('#editorToggle').getAttribute('data-keys'),null);await page.keyboard.press('0');assert.equal(await off(),true);await page.keyboard.press('2');assert.equal(await off(),false);await page.locator('.chat-input').fill('');await page.locator('.chat-input').press('0');assert.equal(await page.locator('.chat-input').inputValue(),'0');assert.equal(await off(),false);assert.deepEqual(errors,[]);
});

test('legacy chat opens on entry despite stored hidden state and viewport width',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,DOC);const off=()=>page.evaluate(()=>document.body.classList.contains('chat-off'));await page.setViewportSize({width:1200,height:800});await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();assert.equal(await off(),false);await page.locator('#chatToggle').click();assert.equal(await off(),true);await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();assert.equal(await off(),false);await page.evaluate(()=>localStorage.setItem('slide-studio.chatOff','1'));await page.setViewportSize({width:1500,height:900});await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();assert.equal(await off(),false);assert.deepEqual(errors,[]);
});

for (const action of ['close', 'reload', 'quit'] as const) test(`desktop autosave completes a delayed source write before ${action}`, {timeout:60000}, async t => {
 const {ws,page,app}=await setup(t,DOC);await rawMode(page);
 await app.evaluate(({dialog})=>{dialog.showMessageBoxSync=()=>{throw Error('Unexpected unsaved dialog');};});
 await page.route('**/api/deck/talk/source',async route=>{if(route.request().method()==='PUT')await new Promise(r=>setTimeout(r,700));await route.continue();});
 await typeAt(page,'最初の段落','自動保存');
 if(action==='reload'){
   const loaded=page.waitForEvent('domcontentloaded');await (await app.browserWindow(page)).evaluate(w=>w.webContents.sendInputEvent({type:'keyDown',keyCode:'R',modifiers:['meta']}));await loaded;
   await page.locator('#stage[data-blocks=ready]').waitFor();await rawMode(page);
   assert.match(await page.locator('.raw textarea').inputValue(),/最初の段落自動保存/);
 }else{
   const closed=page.waitForEvent('close');
   await app.evaluate(({BrowserWindow,app},action)=>{setTimeout(()=>{if(action==='quit')app.quit();else BrowserWindow.getAllWindows().find(w=>new URL(w.webContents.getURL()).pathname==='/deck/talk')!.close();},0);},action);
   await closed;
 }
 assert.match(await readFile(ws.qmd('talk'),'utf8'),/最初の段落自動保存/);
});

for (const action of ['close', 'reload'] as const) test(`desktop autosave failure keeps the editor and input open on ${action}`, {timeout:60000}, async t => {
 const {ws,page,app}=await setup(t,DOC);await rawMode(page);
 await app.evaluate(({dialog})=>{(globalThis as any).unexpectedSaveDialog=false;dialog.showMessageBoxSync=()=>{(globalThis as any).unexpectedSaveDialog=true;return 1;};});
 let fail=true;await page.route('**/api/deck/talk/source',async route=>{if(fail&&route.request().method()==='PUT')await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'save unavailable'})});else await route.continue();});
 await typeAt(page,'最初の段落','保持する');
 await page.evaluate(()=>(window as any).sameDocument=true);
 if(action==='reload')await (await app.browserWindow(page)).evaluate(w=>w.webContents.sendInputEvent({type:'keyDown',keyCode:'R',modifiers:['meta']}));else await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows().find(w=>new URL(w.webContents.getURL()).pathname==='/deck/talk')!.close();});
 await page.waitForTimeout(800);
 assert.equal(page.isClosed(),false);assert.equal(await page.evaluate(()=>(window as any).sameDocument),true);
 assert.match(await page.locator('.raw textarea').inputValue(),/最初の段落保持する/);
 assert.doesNotMatch(await readFile(ws.qmd('talk'),'utf8'),/保持する/);
 assert.equal(await app.evaluate(()=>(globalThis as any).unexpectedSaveDialog),false);
 fail=false;await clean(page);assert.match(await readFile(ws.qmd('talk'),'utf8'),/保持する/);
});

for(const area of ['memo','theme','slide'] as const)test(`desktop autosave includes pending ${area} edits before closing`,{timeout:60000},async t=>{
 const {ws,page,app}=await setup(t,DOC);
 await page.route('**/api/**',async route=>{if(['PUT','POST'].includes(route.request().method()))await new Promise(r=>setTimeout(r,500));await route.continue();});
 if(area==='memo'){
   await page.getByRole('tab',{name:'下書き',exact:true}).click();await page.locator('.memo-input').fill('閉じる前の下書き');
 }else if(area==='theme'){
   await page.getByRole('tab',{name:'テーマ',exact:true}).click();await page.locator('.theme-fields input[name="--ink"]').evaluate((el:HTMLInputElement)=>{el.value='#123456';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
 }else{
   const frame=page.frameLocator('#slideBox > iframe:not(.loading)'),p=frame.locator('.slide.active p').filter({hasText:'最初の段落。'});await p.click();await p.click();await frame.locator('.slide-studio-editing').fill('閉じる前の直接編集');
 }
 const closed=page.waitForEvent('close');await (await app.browserWindow(page)).evaluate(w=>{setTimeout(()=>w.close(),0);});await closed;
 const path=area==='memo'?ws.memo('talk'):area==='theme'?join(ws.themes,'default.css'):ws.qmd('talk');
 assert.match(await readFile(path,'utf8'),area==='memo'?/閉じる前の下書き/:area==='theme'?/#123456/:/閉じる前の直接編集/);
});

for(const failFirst of [false,true])test(`desktop autosave retains a newly inserted block until conversion and save succeed failFirst=${failFirst}`,{timeout:60000},async t=>{
 const {ws,page,app}=await setup(t,DOC);let fail=failFirst;
 await page.route('**/api/deck/talk/chunks',async route=>{if(fail&&route.request().method()==='POST'&&route.request().postDataJSON()?.action==='markdown')await route.fulfill({status:503,json:{error:'conversion unavailable'}});else await route.continue();});
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');await frame.locator('.slide.active p').filter({hasText:'最初の段落。'}).click();await page.keyboard.press('Alt+KeyS');await frame.locator('.slide-studio-editing').fill('新しい段落も自動保存');
 const window=await app.browserWindow(page);
 if(failFirst){await window.evaluate(w=>{setTimeout(()=>w.close(),0);});await new Promise(r=>setTimeout(r,1000));assert.equal(page.isClosed(),false,'A failed block conversion must not close the editor');assert.equal(await page.locator('#status').innerText(),'保存待ち');assert.ok(await page.evaluate(()=>!dispatchEvent(new Event('beforeunload',{cancelable:true}))));assert.doesNotMatch(await readFile(ws.qmd('talk'),'utf8'),/新しい段落も自動保存/);fail=false;}
 const closed=page.waitForEvent('close');await window.evaluate(w=>{setTimeout(()=>w.close(),0);});await closed;const source=await readFile(ws.qmd('talk'),'utf8');assert.match(source,/最初の段落。\n\n新しい段落も自動保存\n\n二番目の段落。/);assert.equal(source.split('新しい段落も自動保存').length,2);
});

test('legacy directional block insertion ignores empty input and adds adjacent columns',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC),original=await readFile(ws.qmd('talk'),'utf8'),frame=page.frameLocator('#slideBox > iframe:not(.loading)');await frame.locator('.slide.active p').filter({hasText:'最初の段落。'}).click();await page.keyboard.press('Alt+KeyS');await frame.locator('.slide-studio-new.slide-studio-editing').waitFor();await page.keyboard.press('Escape');await frame.locator('.slide-studio-new').waitFor({state:'detached'});await clean(page);assert.equal(await readFile(ws.qmd('talk'),'utf8'),original);
 await page.keyboard.press('Alt+KeyS');await frame.locator('.slide-studio-editing').fill('追加。');await page.keyboard.press('Escape');await saved(ws,'最初の段落。\n\n追加。\n\n二番目の段落。');await frame.locator('.slide.active p.slide-studio-selected').filter({hasText:'追加。'}).waitFor();await page.keyboard.press('Alt+KeyD');await frame.locator('.columns .slide-studio-new').waitFor();await frame.locator('.slide-studio-editing').fill('右。');await page.keyboard.press('Escape');await saved(ws,':::: {.columns}\n::: {.column}\n追加。\n:::\n::: {.column}\n右。\n:::\n::::');await frame.locator('.slide.active p.slide-studio-selected').filter({hasText:'右。'}).waitFor();await page.keyboard.press('Alt+KeyA');await frame.locator('.slide-studio-editing').fill('中。');await page.keyboard.press('Escape');await saved(ws,'::: {.column}\n追加。\n:::\n::: {.column}\n中。\n:::\n::: {.column}\n右。\n:::');assert.deepEqual(errors,[]);
});

test('desktop autosave retries a failed conversion of an existing paragraph',{timeout:60000},async t=>{
 const {ws,page,app}=await setup(t,DOC);let fail=true;await page.route('**/api/deck/talk/chunks',async route=>{if(fail&&route.request().method()==='POST'&&route.request().postDataJSON()?.action==='html')await route.fulfill({status:503,json:{error:'conversion unavailable'}});else await route.continue();});const frame=page.frameLocator('#slideBox > iframe:not(.loading)'),p=frame.locator('.slide.active p').filter({hasText:'最初の段落。'});await p.click();await p.click();await frame.locator('.slide-studio-editing').fill('変換の再試行');const window=await app.browserWindow(page);await window.evaluate(w=>{setTimeout(()=>w.close(),0);});await new Promise(r=>setTimeout(r,1000));assert.equal(page.isClosed(),false);assert.equal(await page.locator('#status').innerText(),'保存待ち');assert.ok(await page.evaluate(()=>!dispatchEvent(new Event('beforeunload',{cancelable:true}))));assert.doesNotMatch(await readFile(ws.qmd('talk'),'utf8'),/変換の再試行/);fail=false;const closed=page.waitForEvent('close');await window.evaluate(w=>{setTimeout(()=>w.close(),0);});await closed;assert.match(await readFile(ws.qmd('talk'),'utf8'),/変換の再試行/);
});

for(const area of ['source','memo','new-block'] as const)test(`navigation waits for automatic ${area} saving before returning home`,{timeout:60000},async t=>{
 const {ws,page}=await setup(t,DOC);await page.route('**/api/deck/talk/**',async route=>{if(['PUT','POST'].includes(route.request().method()))await new Promise(r=>setTimeout(r,500));await route.continue();});
 if(area==='source'){await rawMode(page);await typeAt(page,'最初の段落','移動前の原稿');}
 else if(area==='memo'){await page.getByRole('tab',{name:'下書き',exact:true}).click();await page.locator('.memo-input').fill('移動前の下書き');}
 else{const frame=page.frameLocator('#slideBox > iframe:not(.loading)');await frame.locator('.slide.active p').filter({hasText:'最初の段落。'}).click();await page.keyboard.press('Alt+KeyS');await frame.locator('.slide-studio-editing').fill('移動前の新規段落');}
 await page.getByRole('link',{name:'ホーム',exact:true}).click();await page.waitForURL(url=>url.pathname==='/');await page.locator('.deck-card-wrap[data-deck=talk]').waitFor();assert.match(await readFile(area==='memo'?ws.memo('talk'):ws.qmd('talk'),'utf8'),area==='memo'?/移動前の下書き/:area==='source'?/移動前の原稿/:/移動前の新規段落/);
});
for(const failFirst of [false,true])test(`browser back and forward preserve automatic saves and history failFirst=${failFirst}`,{timeout:60000},async t=>{
 const {ws,page,url}=await setup(t,DOC);await page.getByRole('link',{name:'ホーム',exact:true}).click();await page.locator('.deck-card-wrap[data-deck=talk] .card').click();await page.locator('#stage[data-blocks=ready]').waitFor();await rawMode(page);let fail=failFirst;
 await page.route('**/api/deck/talk/source',async route=>{if(route.request().method()==='PUT'){await new Promise(r=>setTimeout(r,300));if(fail){await route.fulfill({status:503,json:{error:'save unavailable'}});return;}}await route.continue();});
 await typeAt(page,'最初の段落','戻る前の入力');await page.evaluate(()=>history.back());
 if(failFirst){await page.waitForTimeout(1100);assert.equal(new URL(page.url()).pathname,'/deck/talk');assert.match(await page.locator('.raw textarea').inputValue(),/戻る前の入力/);assert.doesNotMatch(await readFile(ws.qmd('talk'),'utf8'),/戻る前の入力/);fail=false;await page.evaluate(()=>history.back());}
 await page.waitForURL(u=>u.pathname==='/');await page.locator('.deck-card-wrap[data-deck=talk]').waitFor();assert.match(await readFile(ws.qmd('talk'),'utf8'),/戻る前の入力/);await page.evaluate(()=>history.forward());await page.waitForURL(url);await page.locator('#stage[data-blocks=ready]').waitFor();assert.match(await page.locator('.raw textarea').inputValue(),/戻る前の入力/);
});
for(const area of ['paragraph','heading','cell'] as const)test(`direct ${area} editing retains input on failed Escape conversion and retries`,{timeout:60000},async t=>{
 const source=area==='cell'?'## 表\n\n| A | B |\n|---|---|\n| 一 | 二 |\n':DOC;
 const {ws,page}=await setup(t,source);let fail=true;
 await page.route('**/api/deck/talk/chunks',async route=>{if(fail&&route.request().method()==='POST')await route.fulfill({status:503,json:{error:'conversion unavailable'}});else await route.continue();});
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');
 if(area==='heading')await frame.locator('.slide.active h2').dblclick();
 else{const target=area==='cell'?frame.locator('td').filter({hasText:'一'}):frame.locator('.slide.active p').filter({hasText:'最初の段落。'});await target.click();await target.click({position:{x:10,y:10}});}
 const input=frame.locator('.slide-studio-editing');await input.fill('失敗しても残る入力');const failure=page.waitForResponse(r=>r.url().endsWith('/chunks')&&r.status()===503);await page.keyboard.press('Escape');await failure;await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='保存待ち');await input.waitFor();assert.equal(await input.innerText(),'失敗しても残る入力');assert.doesNotMatch(await readFile(ws.qmd('talk'),'utf8'),/失敗しても残る入力/);fail=false;await page.keyboard.press('Escape');await saved(ws,'失敗しても残る入力');await page.waitForFunction(()=>!['保存待ち','保存中','変換中'].includes(document.querySelector('#status')?.textContent||''));assert.deepEqual((await readFile(ws.qmd('talk'),'utf8')).match(/失敗しても残る入力/g)?.length,1);
});
