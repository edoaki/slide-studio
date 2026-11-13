import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
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
 t.after(async()=>{try{await app.evaluate(async()=>{await (globalThis as any).__restoreParityClipboard?.();});}finally{await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();}).catch(()=>{});await app.close();await rm(temp,{recursive:true,force:true});}});
 const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>!!sessionStorage.getItem('slide-studio:admin-token'));
 if(prepare)await prepare(ws,page);
 const url=new URL('/deck/talk',page.url()).href;await page.goto(url);await page.locator('#stage[data-blocks=ready]').waitFor();
 return {ws,page,url,errors,app};
}
async function saved(ws:Workspace,text:string){for(let i=0;i<100;i++){if((await readFile(ws.qmd('talk'),'utf8')).includes(text))return;await new Promise(r=>setTimeout(r,50));}assert.match(await readFile(ws.qmd('talk'),'utf8'),new RegExp(text));}

const DOC='## 編集の確認 {#cover .cover}\n\n::: {.cover-title}\n編集の確認\n:::\n\n# 本編 {#main}\n\n## 一枚目 {#one}\n\n最初の段落。\n\n## 二枚目 {#two}\n\n二番目の段落。\n\n# APPENDIX {#appendix}\n';
const frame=(page:Page)=>page.frameLocator('#slideBox > iframe:not(.loading)');
async function ready(page:Page){await page.locator('#stage[data-blocks=ready]').waitFor();await page.waitForFunction(()=>!document.querySelector('#slideBox > iframe.loading'));}
async function go(page:Page,index:number){await page.locator(`#pagestrip button[data-index="${index}"]`).click();}
async function exact(ws:Workspace,text:string){for(let i=0;i<100;i++){if(await readFile(ws.qmd('talk'),'utf8')===text)return;await new Promise(r=>setTimeout(r,50));}assert.equal(await readFile(ws.qmd('talk'),'utf8'),text);}

test('composition cover title subtitle authors and affiliations save and reopen',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);
 await page.locator('.cf-title').fill('新しい発表');await page.locator('.cf-sub').fill('副題');await page.locator('.cf-sub').blur();
 await saved(ws,'副題');await page.locator('.cf-add').click();await page.locator('.cf-name').first().fill('山田');await page.locator('.cf-aff-input').first().fill('研究室');await page.locator('.cf-aff-input').first().press('Enter');
 await saved(ws,'研究室');await frame(page).locator('.cover-name').filter({hasText:'山田'}).waitFor();await frame(page).locator('.cover-affiliation').filter({hasText:'研究室'}).waitFor();
 await page.reload();await ready(page);assert.equal(await page.locator('.cf-title').inputValue(),'新しい発表');assert.equal(await page.locator('.cf-sub').inputValue(),'副題');assert.equal(await page.locator('.cf-name').first().inputValue(),'山田');assert.match(await readFile(ws.qmd('talk'),'utf8'),/## 新しい発表 \{#cover .cover\}/);assert.deepEqual(errors,[]);
});

test('composition table of contents toggles columns persists and preserves cover',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC),before=await readFile(ws.qmd('talk'),'utf8');const toggle=page.getByRole('switch',{name:'目次を表示'});
 await toggle.check();await go(page,1);await frame(page).locator('section.toc-slide.active').waitFor();await page.getByRole('button',{name:'2列',exact:true}).click();await frame(page).locator('section.toc-slide.toc-columns').waitFor();await saved(ws,'.toc-columns');
 await page.reload();await ready(page);assert.equal(await toggle.isChecked(),true);assert.equal(await page.getByRole('button',{name:'2列',exact:true}).getAttribute('aria-pressed'),'true');
 await toggle.uncheck();await saved(ws,'.toc-off');await frame(page).locator('.toc-list').waitFor({state:'detached'});await toggle.check();await page.getByRole('button',{name:'縦並び',exact:true}).click();await frame(page).locator('section.toc-slide:not(.toc-columns)').waitFor({state:'attached'});assert.ok((await readFile(ws.qmd('talk'),'utf8')).startsWith(before.split('# 本編')[0]!));assert.deepEqual(errors,[]);
});

for(const surface of ['strip','overview','qmd'])test(`composition page reorder on ${surface} saves exact source and undoes`,{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC),before=await readFile(ws.qmd('talk'),'utf8');if(surface==='overview')await page.getByRole('button',{name:'一覧を表示',exact:true}).click();
 const source=surface==='qmd'?page.locator('#qblocks .page[data-page="3"] .page-num'):page.locator(`${surface==='strip'?'#pagestrip':'.overview-screen'} button[data-index]`).filter({hasText:'二枚目'});
 const target=surface==='qmd'?page.locator('#qblocks .page[data-page="2"]'):page.locator(`${surface==='strip'?'#pagestrip':'.overview-screen'} button[data-index]`).filter({hasText:'一枚目'});
 await source.dragTo(target,{targetPosition:surface==='qmd'?{x:30,y:4}:{x:4,y:25}});
 const one=before.indexOf('## 一枚目'),two=before.indexOf('## 二枚目'),end=before.indexOf('# APPENDIX');await exact(ws,before.slice(0,one)+before.slice(two,end)+before.slice(one,two)+before.slice(end));
 if(surface==='overview')await page.keyboard.press('Escape');await page.locator('#undo').click();await exact(ws,before);assert.deepEqual(errors,[]);
});

test('composition page templates cancel insert placeholders and unique appendix',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC),before=await readFile(ws.qmd('talk'),'utf8');const add=page.locator('#qblocks .page-add .end-btn').last();await add.click();assert.equal(await page.locator('.page-templates button').count(),8);assert.equal(await page.getByRole('button',{name:'Appendix',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await readFile(ws.qmd('talk'),'utf8'),before);
 await add.click();await page.getByRole('button',{name:'文と図',exact:true}).click();const heading=page.getByRole('textbox',{name:'見出し',exact:true});await heading.fill('追加ページ');await heading.press('Enter');await saved(ws,'追加ページ');
 await page.locator('#qblocks .page.cur .card').filter({hasText:'図・画像'}).click();const field=page.getByRole('textbox',{name:'ブロックの原稿'});assert.equal(await field.evaluate((e:HTMLTextAreaElement)=>e.value.slice(e.selectionStart,e.selectionEnd)),'図・画像');await field.pressSequentially('図の説明。');await field.press('Escape');await saved(ws,'図の説明。');await page.reload();await ready(page);assert.match(await readFile(ws.qmd('talk'),'utf8'),/## 追加ページ/);assert.deepEqual(errors,[]);
});

test('composition overview groups chapters and keyboard works from inside frame',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,DOC);await frame(page).locator('.slide.active').click({position:{x:5,y:5}});await page.keyboard.press('o');await page.locator('.overview-screen').waitFor();assert.deepEqual(await page.locator('.overview-screen h2').allTextContents(),['表紙','本編','APPENDIX']);await page.keyboard.press('Escape');await page.locator('.overview-screen').waitFor({state:'detached'});
 await page.getByRole('button',{name:'一覧を表示',exact:true}).click();await page.locator('.overview-screen button[data-index]').filter({hasText:'二枚目'}).click();await frame(page).locator('.slide.active').filter({hasText:'二番目の段落'}).waitFor();assert.deepEqual(errors,[]);
});

test('composition math insertion previews MathML saves and reopens for editing',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await go(page,2);await frame(page).locator('.slide.active p').filter({hasText:'最初の段落'}).click();await page.keyboard.press('/');await page.getByRole('menuitem',{name:'数式',exact:true}).click();const math=page.getByLabel('数式',{exact:true});await math.fill('\\frac{a}{b}');await page.locator('.ins-math .pv math mfrac').waitFor();await math.press('Meta+Enter');await saved(ws,'\\frac{a}{b}');await frame(page).locator('.slide.active math mfrac').waitFor();await page.reload();await ready(page);await go(page,2);await frame(page).locator('.slide.active math mfrac').waitFor();assert.deepEqual(errors,[]);
});

for(const [key,tab] of [['1','memo'],['2','qmd'],['3','assets'],['4','materials'],['5','theme'],['6','bib']])test(`composition frame digit ${key} selects ${tab} tab`,{timeout:60000},async t=>{
 const {page,errors}=await setup(t,DOC);await frame(page).locator('.slide.active').click({position:{x:5,y:5}});await page.keyboard.press(key!);await page.locator(`[role=tab][data-tab=${tab}][aria-selected=true]`).waitFor();assert.deepEqual(errors,[]);
});

test('composition chat shortcuts focus and toggle the panel from inside a frame',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await go(page,2);await frame(page).locator('.slide.active').click({position:{x:5,y:5}});await page.keyboard.press('c');await page.waitForFunction(()=>document.activeElement?.matches('.chat-input'));
 await frame(page).locator('.slide.active').click({position:{x:5,y:5}});await page.keyboard.press('Alt+KeyC');await page.waitForFunction(()=>document.body.classList.contains('chat-off'));assert.deepEqual(errors,[]);
});

test('composition direct text links insert and undo without losing source',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await go(page,2);const p=frame(page).locator('.slide.active p').filter({hasText:'最初の段落。'});await p.click();await p.click();const input=frame(page).locator('.slide-studio-editing');await input.press('Meta+a');await page.locator('#blockTools').getByRole('button',{name:'リンク',exact:true}).click();await page.getByLabel('URL',{exact:true}).fill('https://example.com/');await page.getByLabel('URL',{exact:true}).press('Enter');await saved(ws,'[最初の段落。](https://example.com/)');await input.press('Escape');await page.locator('#undo').click();await exact(ws,`---\ntitle: 編集の確認\ntopic: test\ntheme: default\n---\n\n${DOC}`);assert.deepEqual(errors,[]);
});

test('composition agent prompts retain mandatory text and save each role independently',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,DOC);await page.getByRole('link',{name:'ホーム',exact:true}).click();await page.getByRole('link',{name:'担当ごとのプロンプトを見る・追加指示を書く'}).click();await page.locator('.agent-extra').waitFor();assert.equal(await page.locator('.agents-nav button').count(),5);
 for(const role of ['chat','theme','draft','review','consult']){await page.locator(`[data-role="${role}"]`).click();await page.locator(`[data-role="${role}"][aria-current=page]`).waitFor();assert.equal(await page.locator('.agent-base textarea,.agent-base input,.agent-base [contenteditable]').count(),0);assert.match(await page.locator('.agent-base code').first().innerText(),/AGENTS.md/);}
 await page.locator('[data-role=theme]').click();await page.locator('.agent-extra').fill('テーマへの追加指示');await page.locator('[data-role=chat]').click();await page.locator('[data-role=chat][aria-current=page]').waitFor();assert.equal(await page.locator('.agent-extra').inputValue(),'');await page.reload();await page.locator('[data-role=theme]').click();await page.locator('[data-role=theme][aria-current=page]').waitFor();assert.equal(await page.locator('.agent-extra').inputValue(),'テーマへの追加指示');assert.deepEqual(errors,[]);
});

test('composition role labels and keyboard reveal each mandatory system prompt',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,DOC);await page.goto(new URL('/agents',page.url()).href);await page.locator('.agent-extra').waitFor();
 for(const [id,label,skill] of [['theme','テーマ編集','theme'],['review','確認','review'],['draft','下書き','memo'],['consult','相談役',''],['chat','チャット','slides']]){
  await page.locator(`.agent-role:is([data-role="${id}"], :has([data-role="${id}"]))`).getByText(label!).first().click();await page.locator(`[data-role="${id}"][aria-current=page]`).waitFor({timeout:3000});
  assert.equal(await page.locator('.agent-heading h2').innerText(),label);
  const paths=['AGENTS.md',...(skill?[`.agents/skills/slide-studio-${skill}/SKILL.md`]:[])];
  assert.equal(await page.locator('.agent-prompt').count(),paths.length);
  for(let i=0;i<paths.length;i++){const text=await readFile(join(ws.root,paths[i]!),'utf8');assert.ok(text.trim().length>0);assert.equal(await page.locator('.agent-prompt').nth(i).textContent(),text);}
 }
 await page.locator('[data-role=theme]').focus();await page.keyboard.press('Enter');await page.locator('[data-role=theme][aria-current=page]').waitFor();
 await page.locator('[data-role=review]').focus();await page.keyboard.press('Space');await page.locator('[data-role=review][aria-current=page]').waitFor();assert.deepEqual(errors,[]);
});

for(const failFirst of [false,true])test(`composition agent extra waits for native autosave and retries failure ${failFirst}`,{timeout:60000},async t=>{
 const {ws,page,app}=await setup(t,DOC);await page.getByRole('link',{name:'ホーム',exact:true}).click();await page.getByRole('link',{name:'担当ごとのプロンプトを見る・追加指示を書く'}).click();await page.locator('.agent-extra').waitFor();let fail=failFirst;
 await page.route('**/api/ai/roles/chat/extra',async route=>{await new Promise(r=>setTimeout(r,500));if(fail)await route.fulfill({status:503,json:{error:'save unavailable'}});else await route.continue();});await page.locator('.agent-extra').fill('終了直前の追加指示');const window=await app.browserWindow(page);
 if(failFirst){await window.evaluate(w=>{setTimeout(()=>w.close(),0);});await page.locator('.agent-extra-status').filter({hasText:'save unavailable'}).waitFor();assert.equal(page.isClosed(),false);assert.equal(await page.locator('.agent-extra').inputValue(),'終了直前の追加指示');fail=false;}
 const closed=page.waitForEvent('close');await window.evaluate(w=>{setTimeout(()=>w.close(),0);});await closed;
 const {extra}=await import('../../packages/core/src/legacy-ai-roles.js');assert.equal(extra(ws,'chat'),'終了直前の追加指示');
});

test('composition block designs keep padding and content and support undo',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## デザイン {#design}\n\n::: {#card style="padding:24px;--block-design:plain"}\n本文。\n:::\n');const card=frame(page).locator('#card');await card.click({position:{x:8,y:12}});await page.locator('#blockTools [data-decoration=design] > button').click();const menu=page.locator('#blockTools [data-decoration=design] .fmt-menu');
 for(const [label,design] of [['上ライン','top'],['左ライン','left'],['引用','quote'],['括弧','bracket'],['折り返し','fold'],['枠線','plain']]){await menu.getByRole('button',{name:label,exact:true}).click();await saved(ws,`--block-design:${design}`);assert.match(await readFile(ws.qmd('talk'),'utf8'),/padding:24px/);}
 await page.keyboard.press('Escape');await page.locator('#undo').click();await saved(ws,'--block-design:fold');await frame(page).locator('#card').filter({hasText:'本文。'}).waitFor();assert.deepEqual(errors,[]);
});
