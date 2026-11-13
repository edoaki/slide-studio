import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test, {type TestContext} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {_electron, type Page, type Locator} from 'playwright-core';
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
 t.after(async()=>{try{await app.evaluate(async()=>{await (globalThis as any).__restoreParityClipboard?.();});}finally{await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();}).catch(()=>{});await app.close();await rm(temp,{recursive:true,force:true});}});
 const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>!!sessionStorage.getItem('slide-studio:admin-token'));
 if(prepare)await prepare(ws,page);
 const url=new URL('/deck/talk',page.url()).href;await page.goto(url);await page.locator('#stage[data-blocks=ready]').waitFor();
 return {ws,page,url,errors,app};
}
async function saved(ws:Workspace,text:string){for(let i=0;i<100;i++){if((await readFile(ws.qmd('talk'),'utf8')).includes(text))return;await new Promise(r=>setTimeout(r,50));}assert.match(await readFile(ws.qmd('talk'),'utf8'),new RegExp(text));}

const TABLE='## 表 {#t}\n\n| 項目 | 説明 [@none] |\n|:---|:---|\n| 内容 | 長い説明の文章がここに入ります。折り返して下に伸びることを確かめます。 |\n|  | 二行目 |\n';
async function clickText(loc:Locator){await loc.click({position:await loc.evaluate(el=>{const r=el.ownerDocument.createRange();r.selectNodeContents(el);const a=r.getClientRects()[0],b=el.getBoundingClientRect();return a?{x:a.left-b.left+3,y:a.top-b.top+a.height/2}:{x:12,y:12};})});}
async function ready(page:Page){await page.locator('#stage[data-blocks=ready]').waitFor();}
async function rendered(ws:Workspace,page:Page){const version=createHash('sha256').update(await readFile(ws.qmd('talk'))).digest('hex');await eventually(page,()=>page.frameLocator('#slideBox > iframe:not(.loading)').locator('body').evaluate((e,v)=>(window as any).__slideStudioVersion===v,version));await ready(page);}
async function eventually(page:Page,predicate:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await predicate().catch(()=>false))return;await page.waitForTimeout(50);}assert.ok(await predicate());}

test('legacy table cells support Tab multiline headings per-cell undo and preserve citation source',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,TABLE);const frame=page.frameLocator('#slideBox > iframe:not(.loading)'),first=frame.locator('td').filter({hasText:'内容'}).first();await first.click();await clickText(first);await frame.locator('.slide-studio-editing').waitFor();assert.equal(await page.locator('#blockTools').getAttribute('data-mode'),'format');await first.fill('変更後');await saved(ws,'| 変更後 | 長い説明');await page.keyboard.press('Tab');const second=frame.locator('.slide-studio-editing');assert.match(await second.innerText(),/長い説明/);await page.keyboard.insertText('次のセル');await saved(ws,'| 変更後 | 次のセル |');const head=frame.locator('th').filter({hasText:'項目'});await clickText(head);await page.keyboard.press('Meta+a');await page.keyboard.insertText('見出し');await page.keyboard.press('Enter');await page.keyboard.insertText('二段');await saved(ws,'| 見出し<br>二段 | 説明 [@none] |');await page.keyboard.press('Escape');assert.equal(await frame.locator('.slide-studio-editing').count(),0);const text=await readFile(ws.qmd('talk'),'utf8');assert.ok(text.includes('|:---|:---|'));assert.ok(text.includes('|  | 二行目 |'));await clickText(frame.locator('td').filter({hasText:'変更後'}));assert.equal(await frame.locator('.slide-studio-editing').count(),0);await page.locator('#undo').click();await saved(ws,'| 項目 | 説明 [@none] |');assert.deepEqual(errors,[]);
});

test('legacy table font size bold reset and nested cell editing preserve the table source',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,TABLE);const frame=page.frameLocator('#slideBox > iframe:not(.loading)'),bar=page.locator('#blockTools');await frame.locator('table').click();const size=bar.getByRole('spinbutton',{name:'文字の大きさ（px）',exact:true});await size.fill('20');await size.press('Enter');await saved(ws,'--table-size:20px');await ready(page);await eventually(page,()=>frame.locator('table').evaluate(e=>getComputedStyle(e).fontSize==='20px'));await bar.getByRole('button',{name:'文字を大きく',exact:true}).click();await saved(ws,'--table-size:22px');await bar.getByRole('button',{name:'表を太字',exact:true}).click();await saved(ws,'--table-weight:700');await eventually(page,()=>frame.locator('tbody td').first().evaluate(e=>getComputedStyle(e).fontWeight==='700'));assert.match(await readFile(ws.qmd('talk'),'utf8'),/\| 内容 \| 長い説明/);await ready(page);const target=frame.locator('td').filter({hasText:'内容'}).first();await clickText(target);assert.equal(await frame.locator('.slide-studio-editing').count(),0);await clickText(target);await frame.locator('.slide-studio-editing').fill('包みの中');await saved(ws,'| 包みの中 | 長い説明');await page.keyboard.press('Escape');await ready(page);await bar.getByRole('button',{name:'表の文字サイズ・太字・幅を戻す',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('.raw textarea') as HTMLTextAreaElement).value.includes('--table-'));assert.deepEqual(errors,[]);
});

for(const nested of [false,true])test(`legacy table column and total width dragging survives reload nested=${nested}`,{timeout:60000},async t=>{
 let source=TABLE;if(nested)source=source.replace('| 項目',':::: {style="--table-cols:200 700"}\n::: {style="--table-size:27px"}\n| 項目')+'\n:::\n\nAnother paragraph.\n::::\n';
 const {ws,page,errors}=await setup(t,source);const frame=page.frameLocator('#slideBox > iframe:not(.loading)');await frame.locator('table').click();const handles=frame.locator('.bh.table-col');await handles.nth(1).waitFor();assert.equal(await handles.count(),2);const row=frame.locator('tbody tr').first(),head=frame.locator('th');const before=(await row.boundingBox())!.height,w0=(await head.nth(0).boundingBox())!.width;
 const drag=async(index:number,dx:number)=>{const committed=page.waitForResponse(r=>r.url().endsWith('/source')&&r.request().method()==='PUT');const b=await handles.nth(index).boundingBox();assert.ok(b);const x=b.x+b.width/2,y=b.y+b.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx/2,y);await page.mouse.move(x+dx,y);await page.mouse.up();assert.equal((await committed).status(),200);};await drag(0,60);await saved(ws,'--table-cols:');await rendered(ws,page);assert.equal(await frame.locator('table').evaluate(e=>getComputedStyle(e).tableLayout),'fixed');assert.ok((await head.nth(0).boundingBox())!.width>w0+20);await drag(1,-400);await page.waitForFunction(()=>[...(document.querySelector('.raw textarea') as HTMLTextAreaElement).value.matchAll(/--table-cols:(\d+) (\d+)/g)].some(m=>+m[2]!<500),null,{timeout:5000});await rendered(ws,page);assert.ok((await row.boundingBox())!.height>before);const width=(await head.nth(0).boundingBox())!.width;await page.reload();await ready(page);assert.ok(Math.abs((await head.nth(0).boundingBox())!.width-width)<1);assert.deepEqual(errors,[]);
});

test('legacy table without a visible header edits the correct source row',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 表 {#t}\n\n|  |  |\n|---|---|\n| 一 | 二 |\n| 三 | 四 |\n');const frame=page.frameLocator('#slideBox > iframe:not(.loading)');await frame.locator('table').click();const target=frame.locator('td').filter({hasText:'三'});await clickText(target);await clickText(target);await frame.locator('.slide-studio-editing').fill('直した');await saved(ws,'| 直した | 四 |');assert.match(await readFile(ws.qmd('talk'),'utf8'),/\| 一 \| 二 \|/);await page.keyboard.press('Escape');assert.deepEqual(errors,[]);
});

test('legacy table selection allows dragging from its text without entering text editing',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,TABLE.replace('## 表 {#t}\n\n','## 表 {#t}\n\n前の段落。\n\n'));const frame=page.frameLocator('#slideBox > iframe:not(.loading)'),target=frame.locator('td').filter({hasText:'内容'}).first();await clickText(target);await frame.locator('table.slide-studio-selected').waitFor();assert.equal(await frame.locator('.slide-studio-editing').count(),0);const b=await target.boundingBox(),p=await frame.locator('p').filter({hasText:'前の段落'}).boundingBox();assert.ok(b&&p);await page.mouse.move(b.x+12,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+12,b.y-20);await page.mouse.move(p.x+20,p.y+2);await page.mouse.up();await page.waitForFunction(()=>{const text=(document.querySelector('.raw textarea') as HTMLTextAreaElement).value;return text.indexOf('| 項目')<text.indexOf('前の段落');});await saved(ws,'| 項目');assert.equal(await frame.locator('.slide-studio-editing').count(),0);assert.deepEqual(errors,[]);
});

test('legacy fixed-width table wraps even when deck CSS requests nowrap',{timeout:60000},async t=>{
 const source=TABLE.replace('## 表 {#t}\n\n','## 表 {#t}\n\n::: {style="--table-cols:120 500"}\n').replace('二行目 |\n','二行目 |\n:::\n').replace('| 内容 |','| 問題クラスとの違いを書く長い見出し |');const {page,errors}=await setup(t,source,'',async ws=>{await writeFile(join(ws.deck_dir('talk'),'styles/slides.css'),'#stage table :is(th,td):first-child{white-space:nowrap}');});const frame=page.frameLocator('#slideBox > iframe:not(.loading)'),first=frame.locator('td').filter({hasText:'問題クラス'}),last=frame.locator('td').filter({hasText:'二行目'});assert.ok(await first.evaluate(e=>e.scrollWidth<=e.clientWidth));assert.ok((await first.boundingBox())!.height>(await last.boundingBox())!.height*1.5);assert.deepEqual(errors,[]);
});
