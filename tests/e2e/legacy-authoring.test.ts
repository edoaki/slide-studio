import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {_electron} from 'playwright-core';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';
const require=createRequire(import.meta.url);
async function setup(t:TestContext,source:string,bib=''){
 const temp=await mkdtemp(join(tmpdir(),'studio-authoring-')),ws=Workspace.open(join(temp,'workspace'));ws.new_deck('talk','test');
 await writeFile(ws.qmd('talk'),`---\ntitle: 編集の確認\ntopic: test\ntheme: default\n---\n\n${source}`);
 if(bib)await writeFile(ws.bib('talk'),bib);
 const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;env.SLIDE_STUDIO_ELECTRON_HOME=join(temp,'profile');
 const installed=process.env.SLIDE_STUDIO_TEST_APP,executablePath=installed?.endsWith('.app')?join(installed,'Contents/MacOS/Slide Studio'):installed||require('electron');
 const app=await _electron.launch({executablePath,args:[...(installed?[]:[join(process.cwd(),'dist/apps/desktop/main.js')]),'--root',ws.root],env});
 t.after(async()=>{await app.close();await rm(temp,{recursive:true,force:true});});
 const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>!!sessionStorage.getItem('slide-studio:admin-token'));
 const url=new URL('/deck/talk',page.url()).href;await page.goto(url);await page.locator('#stage[data-blocks=ready]').waitFor();
 return {ws,page,url,errors};
}
async function saved(ws:Workspace,text:string){for(let i=0;i<100;i++){if((await readFile(ws.qmd('talk'),'utf8')).includes(text))return;await new Promise(r=>setTimeout(r,50));}assert.match(await readFile(ws.qmd('talk'),'utf8'),new RegExp(text));}

for(const field of ['year','date'])test(`original bibliography edits ${field} in editor and topic, cancels and survives reload`,{timeout:60000},async t=>{
 const {ws,page,url,errors}=await setup(t,'## 引用 {#intro}\n\n[@paper]\n',`@article{paper, title={{DNA} paper}, author={Doe, Jane}, ${field}={${field==='year'?'2020':'2020-05-01'}}}`);
 for(const [location,year] of [['editor','2024'],['topic','2025']]){
  if(location==='editor')await page.getByRole('tab',{name:'文献',exact:true}).click();else await page.goto(new URL('/topic/test',url).href);
  const detail=page.locator('.bib-detail');if(location==='editor')await detail.locator('button[data-page="0"]').waitFor();await detail.getByRole('button',{name:'文献情報を編集',exact:true}).click({timeout:5000});
  const value=field==='year'?year:year+'-05-01';await detail.getByLabel(field==='year'?'年':'日付',{exact:true}).fill(value!);await detail.getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForFunction(y=>document.querySelector('tbody .c-year')?.textContent===y,year);
  const text=await readFile(ws.bib('talk'),'utf8');assert.ok(text.includes(value!));assert.ok(text.includes('title={{DNA} paper}'));
  await detail.getByRole('button',{name:'文献情報を編集',exact:true}).click({timeout:5000});await detail.getByLabel(field==='year'?'年':'日付',{exact:true}).fill('1900');await detail.getByRole('button',{name:'キャンセル',exact:true}).click();
  assert.equal(await page.locator('tbody .c-year').innerText(),year);assert.equal(await readFile(ws.bib('talk'),'utf8'),text);
 }
 await page.reload();await page.waitForFunction(()=>document.querySelector('tbody .c-year')?.textContent==='2025');assert.deepEqual(errors,[]);
});

test('original table edits populated and empty cells, saves and reloads',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 表 {#table}\n\n| 項目 | 説明 |\n|:---|:---|\n| 内容 | 長い説明 |\n|  | 二行目 |\n');
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');
 const cell=frame.locator('td').filter({hasText:'内容'}).first();await cell.click();await cell.click();
 const editing=frame.locator('.slide-studio-editing');await editing.waitFor();await editing.fill('変更後');await editing.press('Escape');await saved(ws,'| 変更後 | 長い説明 |');
 await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();await frame.locator('td').filter({hasText:'変更後'}).waitFor();
 const empty=frame.locator('tbody tr').nth(1).locator('td').first();await empty.click();await empty.click();await editing.waitFor();await editing.fill('埋めた');await editing.press('Escape');await saved(ws,'| 埋めた | 二行目 |');
 assert.deepEqual(errors,[]);
});

test('original presentation starts at current page, advances and restores editor state',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,'## 一枚目 {#first}\n\n本文。\n\n## 二枚目 {#second}\n\n::: {.incremental}\n- A\n- B\n:::\n');
 await page.evaluate(()=>{Element.prototype.requestFullscreen=()=>Promise.reject(Error('test fullscreen denial'));});
 await page.locator('#pagestrip button[data-index="1"]').click();
 await page.locator('#stepNext').click();
 const editor=page.frameLocator('#slideBox > iframe:not(.loading)');
 for(let i=0;i<50;i++){if(await editor.locator('body').evaluate(()=>(window as any).deck.step)===1)break;await page.waitForTimeout(50);}
 assert.equal(await editor.locator('body').evaluate(()=>(window as any).deck.step),1);
 await page.getByRole('button',{name:'今のページから',exact:true}).click();
 const player=page.frameLocator('.present-screen iframe');await player.locator('.slide.active#second').waitFor();
 assert.equal(await page.locator('#root').evaluate(el=>(el as HTMLElement).inert),true);
 assert.equal(await player.locator('body').evaluate(()=>(window as any).deck.step),0);
 await player.locator('body').press('ArrowRight');
 for(let i=0;i<50;i++){if(await player.locator('body').evaluate(()=>(window as any).deck.step)===1)break;await page.waitForTimeout(50);}
 assert.equal(await player.locator('body').evaluate(()=>(window as any).deck.step),1);
 await page.keyboard.press('Escape');await page.locator('.present-screen').waitFor({state:'detached'});
 assert.equal(await page.locator('#root').evaluate(el=>(el as HTMLElement).inert),false);
 await page.frameLocator('#slideBox > iframe:not(.loading)').locator('.slide.active#second').waitFor();
 assert.equal(await page.frameLocator('#slideBox > iframe:not(.loading)').locator('body').evaluate(()=>(window as any).deck.step),1);
 assert.deepEqual(errors,[]);
});


test('original theme controls preview, save, undo, edit gradients and keep text editable',{timeout:90000},async t=>{
 const {ws,page,errors}=await setup(t,'## テーマの確認 {#theme}\n\n編集できる本文。\n');
 const path=join(ws.themes,'default.css'),original=await readFile(path,'utf8');
 await page.getByRole('tab',{name:'テーマ',exact:true}).click();
 const ink=page.locator('.theme-fields input[name="--ink"]');await ink.waitFor();
 await ink.evaluate((el:HTMLInputElement)=>{el.value='#112233';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
 for(let i=0;i<100;i++){if((await readFile(path,'utf8')).includes('#112233'))break;await page.waitForTimeout(50);}assert.match(await readFile(path,'utf8'),/#112233/);
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');
 for(let i=0;i<100;i++){if(await frame.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--ink').trim())==='#112233')break;await page.waitForTimeout(50);}
 assert.equal(await frame.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--ink').trim()),'#112233');
 await page.locator('#undo').click();
 for(let i=0;i<100;i++){if(await readFile(path,'utf8')===original)break;await page.waitForTimeout(50);}assert.equal(await readFile(path,'utf8'),original);
 await page.locator('.tv-section-toggle > summary').click();await page.locator('.tv-fill-open').click();
 await page.locator('.gradient-editor').waitFor();await page.locator('.gradient-presets [data-preset=diagonal]').click();
 for(let i=0;i<100;i++){if((await readFile(path,'utf8')).includes('radial-gradient'))break;await page.waitForTimeout(50);}assert.match(await readFile(path,'utf8'),/radial-gradient/);
 await page.locator('.gradient-done').click();await page.locator('.gradient-editor').waitFor({state:'hidden'});
 await page.locator('.theme-stagebar .tv-reset').click();
 const paragraph=frame.locator('.slide.active [data-slide-studio]').filter({hasText:'編集できる本文。'}).first();await paragraph.click();await paragraph.click();
 await frame.locator('.slide-studio-editing').fill('テーマ編集中も編集できる本文。');await page.keyboard.press('Escape');await saved(ws,'テーマ編集中も編集できる本文。');
 assert.equal(await page.getByRole('tab',{name:'テーマ',exact:true}).getAttribute('aria-selected'),'true');assert.deepEqual(errors,[]);
});

test('original live layout warnings mark overflow and clear after fixing the source style',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## はみ出し {#low}\n\n::: {.low}\n下の段落。\n:::\n\n## 次 {#next}\n\n本文。\n');
 const styles=join(ws.deck_dir('talk'),'styles');await mkdir(styles,{recursive:true});const path=join(styles,'slides.css');
 await writeFile(path,'#stage .low p {position:absolute;left:64px;top:700px;margin:0}');
 await page.locator('.lint-badge').waitFor();await page.locator('#pagestrip button[data-index="0"] .mark.warning').waitFor();
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');await frame.locator('#slide-studio-lint .slide-studio-lint-box').first().waitFor();
 await writeFile(path,'#stage .low p {position:static;margin:0}');
 await page.locator('.lint-badge').waitFor({state:'hidden'});assert.deepEqual(errors,[]);
});

test('theme sample fallback selects missing table styles and returns to the editable deck',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 本文だけ {#plain}\n\n見本から戻って編集する本文。\n');
 await page.getByRole('tab',{name:'テーマ',exact:true}).click();
 const field=page.locator('.theme-fields label[data-key="--table-header-bg"]');await field.waitFor();await field.click();
 const sample=page.locator('.theme-sample');await sample.waitFor();
 const preview=page.frameLocator('.theme-sample iframe:not(.loading)');await preview.locator('.slide.active table').waitFor();
 await preview.locator('.slide.active th').first().click();
 await page.locator('.theme-fields label[data-key="--table-header-bg"].on').waitFor();
 const path=join(ws.themes,'default.css');
 await field.locator('input').evaluate((el:HTMLInputElement)=>{el.value='#334455';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
 for(let i=0;i<100;i++){if((await readFile(path,'utf8')).includes('#334455'))break;await page.waitForTimeout(50);}assert.match(await readFile(path,'utf8'),/#334455/);
 await page.locator('.theme-stagebar .tv-reset').click();await sample.waitFor({state:'hidden'});
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');
 const paragraph=frame.locator('.slide.active [data-slide-studio]').filter({hasText:'見本から戻って編集する本文。'}).first();await paragraph.click();await frame.locator('.slide-studio-selected').first().waitFor();await paragraph.click();
 await frame.locator('.slide-studio-editing').fill('見本から戻った後の本文。');await page.keyboard.press('Escape');await saved(ws,'見本から戻った後の本文。');
 assert.deepEqual(errors,[]);
});
