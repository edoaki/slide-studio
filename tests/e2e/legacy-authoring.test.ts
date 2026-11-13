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
 const cell=frame.locator('td').filter({hasText:'内容'}).first();await cell.click();const point=await cell.evaluate(el=>{const range=el.ownerDocument.createRange();range.selectNodeContents(el);const text=range.getClientRects()[0]!,box=el.getBoundingClientRect();return {x:text.left-box.left+3,y:text.top-box.top+text.height/2};});await cell.click({position:point});
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


test('original theme controls preview, save, undo and keep text editable',{timeout:90000},async t=>{
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

async function waitCss(path:string,predicate:(css:string)=>boolean){
 for(let i=0;i<150;i++){const css=await readFile(path,'utf8');if(predicate(css))return css;await new Promise(r=>setTimeout(r,50));}
 assert.ok(predicate(await readFile(path,'utf8')),'theme file did not reach expected state');return await readFile(path,'utf8');
}
test('theme reset preserves a named copy, rejects duplicate names, cancels and undoes',{timeout:90000},async t=>{
 const {ws,page,errors}=await setup(t,'## テーマ保存 {#one}\n\n本文。\n');const path=join(ws.themes,'default.css'),original=await readFile(path,'utf8');
 await page.getByRole('tab',{name:'テーマ',exact:true}).click();const reset=page.locator('.tv-default');
 await page.locator('.theme-fields input[name="--ink"]').evaluate((el:HTMLInputElement)=>{el.value='#112233';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
 const edited=await waitCss(path,s=>s.includes('#112233'));
 await reset.click();await page.getByRole('button',{name:'やめる',exact:true}).click();assert.equal(await readFile(path,'utf8'),edited);
 await reset.click();const dialog=page.getByRole('dialog');await dialog.getByLabel('テーマ名（英小文字・数字・ハイフン）',{exact:true}).fill('default');await dialog.getByRole('button',{name:'保存して戻す',exact:true}).click();
 await dialog.getByRole('alert').filter({hasText:'同じ名前のテーマがあります'}).waitFor();assert.equal(await readFile(path,'utf8'),edited);
 await dialog.getByLabel('テーマ名（英小文字・数字・ハイフン）',{exact:true}).fill('mine');await dialog.getByRole('button',{name:'保存して戻す',exact:true}).click();await dialog.waitFor({state:'detached'});
 await waitCss(path,s=>s===original);assert.equal(await readFile(join(ws.themes,'mine.css'),'utf8'),edited);await page.locator('.tv-themes [data-theme="mine"]').waitFor();assert.match(await readFile(ws.qmd('talk'),'utf8'),/theme: default/);
 await page.locator('#undo').click();await waitCss(path,s=>s===edited);assert.equal(await readFile(join(ws.themes,'mine.css'),'utf8'),edited);
 await reset.click();await page.getByRole('button',{name:'保存せずに戻す',exact:true}).click();await waitCss(path,s=>s===original);assert.equal(await page.locator('.tv-themes .theme-remove').count(),0);assert.deepEqual(errors,[]);
});

test('theme switch keeps the preview frame, commits after stylesheet loading and undoes',{timeout:90000},async t=>{
 const {ws,page,errors}=await setup(t,'## テーマ切替 {#one}\n\n本文。\n');const frame=page.frameLocator('#slideBox > iframe:not(.loading)');
 await frame.locator('html').evaluate(el=>el.setAttribute('data-parity-marker','retained'));
 const color=()=>frame.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--ink').trim());const before=await color();
 await page.getByRole('tab',{name:'テーマ',exact:true}).click();
 let release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve);
 await page.route('**/theme/night.css?*',async route=>{await hold;await route.continue();});t.after(()=>release());
 await page.getByRole('button',{name:'「night」を選ぶ',exact:true}).click();await frame.locator('link[media="not all"]').waitFor({state:'attached'});assert.equal(await color(),before);release();
 await page.locator('.tv-themes [data-theme="night"][aria-pressed=true]').waitFor();
 for(let i=0;i<100&&await color()===before;i++)await page.waitForTimeout(50);assert.notEqual(await color(),before);
 assert.equal(await frame.locator('html').getAttribute('data-parity-marker'),'retained');assert.match(await readFile(ws.qmd('talk'),'utf8'),/theme: night/);
 await page.locator('#undo').click();await page.locator('.tv-themes [data-theme="default"][aria-pressed=true]').waitFor();
 for(let i=0;i<100&&await color()!==before;i++)await page.waitForTimeout(50);assert.equal(await color(),before);assert.match(await readFile(ws.qmd('talk'),'utf8'),/theme: default/);assert.deepEqual(errors,[]);
});

test('theme fonts retain the content page, show three samples and restore unfiltered navigation',{timeout:90000},async t=>{
 const {page,errors}=await setup(t,'## 本文 {#one}\n\n最初の段落。\n\n## 次 {#two}\n\n**次の段落。**\n');
 await page.getByRole('tab',{name:'テーマ',exact:true}).click();const choices=page.getByRole('group',{name:'本文のフォント',exact:true});await choices.waitFor();
 assert.equal(await choices.locator('.tv-font-sample').count(),3);assert.deepEqual([...new Set(await choices.locator('.tv-font-sample').allTextContents())],['ひらがな 漢字 100 English']);
 const fonts=await choices.locator('.tv-font-sample').evaluateAll(els=>els.map(el=>(el as HTMLElement).style.fontFamily));assert.equal(new Set(fonts).size,3);
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');const index=await frame.locator('body').evaluate(()=>(window as any).deck.index);
 await choices.locator('button').nth(1).click();await page.waitForFunction(()=>document.querySelector('[role=group][aria-label="本文のフォント"] button:nth-child(2)')?.getAttribute('aria-pressed')==='true');
 assert.equal(await frame.locator('body').evaluate(()=>(window as any).deck.index),index);
 await page.locator('label[data-key="--ink"]').dispatchEvent('pointerdown');
 await page.waitForFunction(()=>!!document.querySelector('#slide-studio-theme-marks')||!!document.querySelector('.theme-fields label[data-key="--ink"].on'));
 const indices=await page.locator('#pagestrip button[data-index]:visible').evaluateAll(els=>els.map(el=>Number((el as HTMLElement).dataset.index)));assert.ok(indices.length>0);
 for(let i=0;i<indices.length+1;i++){await page.locator('#stage').click({position:{x:10,y:10}});await page.keyboard.press('ArrowDown');assert.ok(indices.includes(await frame.locator('body').evaluate(()=>(window as any).deck.index)));}
 await page.getByRole('tab',{name:'スライド',exact:true}).click();assert.equal(await page.locator('#pagestrip button[data-index]:visible').count(),await page.locator('#pagestrip button[data-index]').count());
 await page.getByRole('tab',{name:'テーマ',exact:true}).click();assert.equal(await page.locator('#slideBox').isVisible(),true);assert.deepEqual(errors,[]);
});

test('layout warnings navigate to the affected page, mark its toolbar and react to live content',{timeout:90000},async t=>{
 const {ws,page,errors}=await setup(t,'## はみ出し {#low}\n\n::: {.low}\n下の段落。\n:::\n\n## 次 {#next}\n\n本文。\n');
 const styles=join(ws.deck_dir('talk'),'styles');await mkdir(styles,{recursive:true});await writeFile(join(styles,'slides.css'),'#stage .low p {position:absolute;left:64px;top:700px;margin:0}');
 const badge=page.locator('.lint-badge');await badge.waitFor();await page.locator('#pagestrip button[data-index="1"]').click();await badge.click();
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');await frame.locator('.slide.active#low').waitFor();assert.match(await badge.getAttribute('data-tip')??'',/レイアウトの問題 1件/);
 assert.equal(await page.locator('#pagestrip button[data-index="1"] .mark').count(),0);await frame.locator('.slide-studio-lint-box').waitFor();assert.match(await frame.locator('.slide-studio-lint-tab').innerText(),/^↓ \d+px$/);
 await frame.locator('.low p').click({position:{x:10,y:6}});await page.locator('#blockTools .lint-flag').waitFor();assert.match(await page.locator('#blockTools .lint-flag').getAttribute('data-tip')??'',/スライドの下に \d+px はみ出す/);
 await page.locator('#pagestrip button[data-index="1"]').click();await frame.locator('.slide.active#next').waitFor();assert.equal(await frame.locator('#slide-studio-lint > *').count(),0);
 await frame.locator('#next p').evaluate(el=>{el.textContent='長い文。'.repeat(180);});await page.locator('#pagestrip button[data-index="1"] .mark.warning').waitFor();
 await frame.locator('#next p').evaluate(el=>{el.textContent='本文。';});await page.locator('#pagestrip button[data-index="1"] .mark').waitFor({state:'detached'});assert.deepEqual(errors,[]);
});

test('native image paste inserts after the selected paragraph, preserves pixels and survives undo and reload',{timeout:90000},async t=>{
 const {ws,page,errors,app}=await setup(t,'## 貼り付け {#one}\n\n最初の段落。\n\n次の段落。\n');const original=await readFile(ws.qmd('talk'),'utf8');
 const png='iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==';
 await app.evaluate(async({clipboard,ClipboardItem},png)=>{
   const backup=await Promise.all((await clipboard.read()).map(async item=>new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)]))))));
   await clipboard.write([new ClipboardItem({'image/png':new Blob([Buffer.from(png,'base64')],{type:'image/png'})})]);
   const signature=async()=>Promise.all((await clipboard.read()).map(async item=>Promise.all(item.types.map(async type=>{const data=await item.getType(type);return [type,data instanceof Blob?Buffer.from(await data.arrayBuffer()).toString('base64'):JSON.stringify(data)];}))));
   const written=JSON.stringify(await signature());
   (globalThis as any).__restoreParityClipboard=async()=>{if(JSON.stringify(await signature())===written){if(backup.length)await clipboard.write(backup);else clipboard.clear();}delete (globalThis as any).__restoreParityClipboard;};
 },png);
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');const paragraph=frame.locator('[data-slide-studio="p0/0"]');await paragraph.click();await frame.locator('.slide-studio-selected').waitFor();await page.keyboard.press('Meta+v');await saved(ws,'![](images/');
 const text=await readFile(ws.qmd('talk'),'utf8'),match=text.match(/!\[\]\((images\/[^)]+\.png)\)\{width=4 fig-align="center"\}/);assert.ok(match,text);assert.equal(text,original.replace('最初の段落。','最初の段落。\n\n'+match[0]));
 const image=await readFile(join(ws.asset_root('talk'),match[1]!));assert.equal(await app.evaluate(({nativeImage},data)=>nativeImage.createFromBuffer(Buffer.from(data.actual,'base64')).toBitmap().equals(nativeImage.createFromBuffer(Buffer.from(data.expected,'base64')).toBitmap()),{actual:image.toString('base64'),expected:png}),true);
 await page.locator('#undo').click();await waitCss(ws.qmd('talk'),s=>s===original);assert.deepEqual(await readFile(join(ws.asset_root('talk'),match[1]!)),image);
 await page.locator('#redo').click();await waitCss(ws.qmd('talk'),s=>s===text);await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();await frame.locator('.slide.active img').waitFor();assert.equal(await readFile(ws.qmd('talk'),'utf8'),text);assert.deepEqual(errors,[]);
});


test('heading design is AI-only while direct heading text color preserves the design and supports undo',{timeout:90000},async t=>{
 const {ws,page,errors}=await setup(t,'## 見出しの文字色 {#one}\n\n本文。\n');const path=join(ws.themes,'default.css');
 // This is the same CSS file updated by the theme AI; no direct design controls are needed.
 const designed=(await readFile(path,'utf8'))+'\n#stage .slide > h2 {background:linear-gradient(90deg,#ccddee,#eeeeff);border-bottom:3px dashed #123456;border-radius:12px}\n';await writeFile(path,designed);
 await page.getByRole('tab',{name:'テーマ',exact:true}).click();const color=page.getByLabel('見出しの文字',{exact:true});await color.waitFor();
 assert.equal(await page.locator('.tv-fill-open,.gradient-editor,.tv-heading-modes,.tv-heading-rule,input[name="--header"],label[data-key="--font-head"],input[name="--rule"]').count(),0);await page.getByText('デザインの変更はAIチャットへ',{exact:true}).waitFor();
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');const h=frame.locator('.slide.active h2');
 for(let i=0;i<100;i++){if(await h.evaluate(el=>getComputedStyle(el).borderBottomStyle==='dashed'))break;await page.waitForTimeout(50);}
 const design=()=>h.evaluate(el=>{const s=getComputedStyle(el);return [s.backgroundImage,s.borderBottom,s.borderRadius,s.fontFamily,s.fontSize];});const beforeDesign=await design();
 await color.click();const code=page.getByLabel('カラーコード',{exact:true});await code.fill('#123abc');await code.press('Enter');await waitCss(path,s=>s.includes('#123abc'));
 for(let i=0;i<100;i++){if(await h.evaluate(el=>getComputedStyle(el).color==='rgb(18, 58, 188)'))break;await page.waitForTimeout(50);}assert.equal(await h.evaluate(el=>getComputedStyle(el).color),'rgb(18, 58, 188)');assert.deepEqual(await design(),beforeDesign);
 await code.press('Escape');await page.locator('#undo').click();await waitCss(path,s=>s===designed);await page.locator('#redo').click();await waitCss(path,s=>s.includes('#123abc'));await page.reload();await page.getByRole('tab',{name:'テーマ',exact:true}).click();await color.waitFor();assert.equal(await color.inputValue(),'#123abc');assert.deepEqual(await design(),beforeDesign);assert.deepEqual(errors,[]);
 if(process.env.SLIDE_STUDIO_TEST_SCREENSHOT){await color.scrollIntoViewIfNeeded();await page.screenshot({path:process.env.SLIDE_STUDIO_TEST_SCREENSHOT});}
});

test('page counter stays centered while step count appears, advances and disappears',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,'## 一枚目 {#one}\n\n本文。\n\n## 段階 {#steps}\n\n::: {data-step="1"}\n段落A。\n:::\n\n::: {data-step="2"}\n段落B。\n:::\n\n## 最後 {#last}\n\n本文。\n');
 const counter=page.locator('#pageCount'),steps=page.locator('#stepCount'),original=await counter.boundingBox();assert.ok(original);
 const centered=async()=>{const c=await counter.boundingBox(),p=await page.locator('#stepPrev').boundingBox(),n=await page.locator('#stepNext').boundingBox();assert.ok(c&&p&&n);assert.ok(Math.abs(c.x+c.width/2-(p.x+p.width/2+n.x+n.width/2)/2)<1);assert.ok(Math.abs(c.x-original.x)<1);assert.ok(Math.abs(c.width-original.width)<1);};
 assert.equal(await counter.innerText(),'1ページ');assert.equal(await steps.isVisible(),false);await centered();
 await page.locator('#pagestrip button[data-index="1"]').click();
 for(const value of ['1 / 3','2 / 3','3 / 3']){await page.waitForFunction(value=>document.querySelector('#stepCount')?.textContent===value,value);await centered();await page.locator('#stepNext').click();}
 await page.waitForFunction(()=>document.querySelector('#pageCount')?.textContent==='3ページ');assert.equal(await steps.isVisible(),false);assert.equal(await steps.textContent(),'');await centered();assert.deepEqual(errors,[]);
});

test('block alignment cycles left center right and removes its wrapper on return to left',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 揃え {#align}\n\n揃えを変える本文。\n');const original=await readFile(ws.qmd('talk'),'utf8');
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)');await frame.locator('.slide.active p').click();const bar=page.locator('#blockTools'),align=bar.getByRole('button',{name:'揃え',exact:true});assert.equal(await align.getAttribute('data-align'),'left');
 for(const value of ['center','right','left']){
  await align.click();await page.waitForFunction(value=>document.querySelector('#blockTools [data-align]')?.getAttribute('data-align')===value,value);
  for(let i=0;i<100;i++){const text=await readFile(ws.qmd('talk'),'utf8');if(value==='left'?text===original:text.includes(`text-align:${value}`))break;await page.waitForTimeout(50);}
  const text=await readFile(ws.qmd('talk'),'utf8');if(value==='left')assert.equal(text,original);else assert.ok(text.includes(`text-align:${value}`));assert.equal(await bar.getByRole('group',{name:'揃え',exact:true}).count(),0);
  await page.locator('#stage[data-blocks=ready]').waitFor();
 }
 assert.deepEqual(errors,[]);
});

test('step menu groups paragraphs, shows peer count, aligns and undoes without losing steps',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 段階 {#steps}\n\n最初の段落。\n\n二番目の段落。\n');
 const frame=page.frameLocator('#slideBox > iframe:not(.loading)'),bar=page.locator('#blockTools');await frame.locator('p').filter({hasText:'最初の段落。'}).click();
 await bar.getByRole('button',{name:'段階表示',exact:true}).click();assert.deepEqual(await bar.locator('.step-chip').allTextContents(),['0 → ①','1 → ②']);await bar.getByRole('button',{name:'段 1（新しい段）',exact:true}).click();await saved(ws,'data-step="1"');
 await page.locator('#stage[data-blocks=ready]').waitFor();await page.locator('#qblocks .page.cur .step-badge').filter({hasText:'2'}).waitFor();assert.equal(await frame.locator('.slide-studio-step-badge').count(),0);
 await frame.locator('p').filter({hasText:'二番目の段落。'}).click();await bar.getByRole('button',{name:'段階表示',exact:true}).click();assert.deepEqual(await bar.locator('.step-chip').allTextContents(),['0 → ①','1 → ②','2 → ③']);const peer=bar.getByRole('button',{name:'段 1・ほかに 1 個',exact:true});await peer.hover();await frame.locator('.slide-studio-step-mark').waitFor({state:'attached'});await peer.click();
 for(let i=0;i<100;i++){if((await readFile(ws.qmd('talk'),'utf8')).split('data-step="1"').length===3)break;await page.waitForTimeout(50);}assert.equal((await readFile(ws.qmd('talk'),'utf8')).split('data-step="1"').length,3);
 await bar.getByRole('button',{name:'揃え',exact:true}).click();await saved(ws,'text-align:center');await page.locator('#undo').click();
 for(let i=0;i<100;i++){if(!(await readFile(ws.qmd('talk'),'utf8')).includes('text-align:center'))break;await page.waitForTimeout(50);}const text=await readFile(ws.qmd('talk'),'utf8');assert.ok(!text.includes('text-align:center'));assert.equal(text.split('data-step="1"').length,3);assert.deepEqual(errors,[]);
});

test('incremental list menu persists steps and remains editable after reload',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 項目 {#list}\n\n- 最初\n- 次\n');const frame=page.frameLocator('#slideBox > iframe:not(.loading)'),bar=page.locator('#blockTools');
 await frame.locator('.slide.active li').first().click();
 await bar.getByRole('button',{name:'段階表示',exact:true}).click();await bar.getByRole('checkbox',{name:'1項目ずつ',exact:true}).check();await saved(ws,'.incremental data-step="0"');
 await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();const items=frame.locator('.incremental > ul > li');assert.equal(await items.nth(0).getAttribute('data-step'),'0');assert.equal(await items.nth(1).getAttribute('data-step'),'1');assert.equal(await items.nth(1).isVisible(),true);
 await items.first().click();await bar.getByRole('button',{name:'段階表示',exact:true}).click();assert.equal(await bar.getByRole('checkbox',{name:'1項目ずつ',exact:true}).isChecked(),true);
 assert.equal(await items.nth(1).evaluate(el=>getComputedStyle(el).opacity),'0.28');
 if(process.env.SLIDE_STUDIO_STEP_SCREENSHOT)await page.screenshot({path:process.env.SLIDE_STUDIO_STEP_SCREENSHOT});
 await page.keyboard.press('Escape');await page.evaluate(()=>{Element.prototype.requestFullscreen=()=>Promise.reject(Error('test denial'));});await page.getByRole('button',{name:'最初から',exact:true}).click();
 const player=page.frameLocator('.present-screen iframe');await player.locator('.slide.active').waitFor();assert.equal(await player.locator('.incremental > ul > li').nth(1).isVisible(),false);await page.keyboard.press('Escape');await page.locator('.present-screen').waitFor({state:'detached'});assert.deepEqual(errors,[]);
});

test('alignment during direct text editing saves and undoes after leaving the text session',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 文字編集 {#align}\n\n本文。\n'),frame=page.frameLocator('#slideBox > iframe:not(.loading)');const paragraph=frame.locator('.slide.active p');await paragraph.click();await paragraph.click();await frame.locator('.slide-studio-editing').waitFor();
 const bar=page.locator('#blockTools'),align=bar.getByRole('button',{name:'揃え',exact:true});await align.click();await page.waitForFunction(()=>document.querySelector('#blockTools [data-align]')?.getAttribute('data-align')==='center');await align.click();await saved(ws,'text-align:right');await bar.getByRole('button',{name:'外側を選択',exact:true}).click();await page.locator('#stage[data-blocks=ready]').waitFor();await page.locator('#undo').click();
 for(let i=0;i<100;i++){if(!(await readFile(ws.qmd('talk'),'utf8')).includes('text-align:right'))break;await page.waitForTimeout(50);}assert.ok(!(await readFile(ws.qmd('talk'),'utf8')).includes('text-align:right'));assert.deepEqual(errors,[]);
});

for(const prefix of ['', '😀'])test(`PDF step checkbox preserves heading and final-step inclusion with prefix ${prefix||'none'}`,{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,`## ${prefix}段階 {#steps}\n\n::: {data-step="1"}\n最初。\n:::\n\n::: {data-step="2"}\n次。\n:::\n`);const box=page.locator('#pdfStep');if(prefix){await writeFile(ws.qmd('talk'),(await readFile(ws.qmd('talk'),'utf8')).replace('title: 編集の確認',`title: ${prefix}編集の確認`));await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();}await page.waitForFunction(()=>document.querySelector('#stepCount')?.textContent==='1 / 3');assert.equal(await box.isChecked(),false);
 await box.check();await saved(ws,`## ${prefix}段階 {#steps pdf="1"}`);await page.locator('#stepNext').click();await page.locator('#stepNext').click();await page.waitForFunction(()=>document.querySelector('#stepCount')?.textContent==='3 / 3');assert.equal(await box.isChecked(),true);assert.equal(await box.isDisabled(),true);
 await page.locator('#stepPrev').click();await page.waitForFunction(()=>document.querySelector('#stepCount')?.textContent==='2 / 3');await box.check();await saved(ws,`## ${prefix}段階 {#steps pdf="1 2"}`);await page.locator('#stepPrev').click();await page.waitForFunction(()=>document.querySelector('#stepCount')?.textContent==='1 / 3');await box.uncheck();await saved(ws,`## ${prefix}段階 {#steps pdf="2"}`);
 await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();const frame=page.frameLocator('#slideBox > iframe:not(.loading)');assert.deepEqual(await frame.locator('body').evaluate(()=>(window as any).deck.pdfSteps(0)),[1,2]);assert.deepEqual(errors,[]);
});

test('preview replacement waits for an in-flight step move and preserves its destination',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 更新前 {#steps}\n\n::: {data-step="1"}\n最初。\n:::\n\n::: {data-step="2"}\n次。\n:::\n');
 await page.locator('#stepNext').click();await page.locator('#stepNext').click();await page.waitForFunction(()=>document.querySelector('#stepCount')?.textContent==='3 / 3');
 const old=await (await page.locator('#slideBox > iframe:not(.loading)').elementHandle())!.contentFrame();assert.ok(old);
 await old.evaluate(()=>{const w=window as any,move=w.deck.move.bind(w.deck);w.deck.move=async(delta:number)=>{w.__moveStarted=true;await new Promise<void>(resolve=>w.__releaseMove=resolve);return move(delta);};});
 await page.locator('#stepPrev').click();await old.waitForFunction(()=>(window as any).__moveStarted);
 await writeFile(ws.qmd('talk'),(await readFile(ws.qmd('talk'),'utf8')).replace('更新前','更新後'));
 await page.locator('#slideBox > iframe.loading').waitFor({state:'attached'});const pending=page.frameLocator('#slideBox > iframe.loading');await pending.locator('body').evaluate(async()=>{await (window as any).deckReady;});
 assert.equal(old.isDetached(),false);await old.evaluate(()=>(window as any).__releaseMove());
 await page.frameLocator('#slideBox > iframe:not(.loading)').locator('h2').filter({hasText:'更新後'}).waitFor();await page.waitForFunction(()=>document.querySelector('#stepCount')?.textContent==='2 / 3');assert.deepEqual(errors,[]);
});

async function figure(ws:Workspace,name:string,long=false){
 await new_figure(ws,name,ws.shelf_dir('test'));
 if(long){const path=join(ws.shelf_dir('test'),name,'figure.mjs');await writeFile(path,(await readFile(path,'utf8')).replace("steps: ['入力を表示', '処理を表示', '結果を表示']","steps: ['0', '1', '2', '3', '4', '5']"));}
}
async function badges(page:Page,labels:string[]){await page.waitForFunction(labels=>JSON.stringify([...document.querySelectorAll('#qblocks .page.cur .step-badge')].map(e=>e.textContent))===JSON.stringify(labels),labels);}
async function stage(page:Page,step:number){const frame=await page.locator('#slideBox > iframe:not(.loading)').elementHandle().then(e=>e!.contentFrame());assert.ok(frame);await frame.evaluate(step=>(window as any).deck.go(0,step),step);return frame;}

test('figure step menu updates the shortcode and preview without text decoration controls',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 図 {#fig}\n\n{{< fig test/demo >}}\n','',async ws=>{await figure(ws,'demo');});
 await page.locator('#qblocks .page.cur .card').filter({hasText:'test/demo'}).click();const bar=page.locator('#blockTools');assert.equal(await bar.locator('.decoration-tool').count(),0);
 await bar.getByRole('button',{name:'段階表示',exact:true}).click();await bar.getByRole('button',{name:'段 1（新しい段）',exact:true}).click();await saved(ws,'{{< fig test/demo step="1" >}}');
 await page.frameLocator('#slideBox > iframe:not(.loading)').locator('.animation[data-step="1"]').waitFor();assert.deepEqual(errors,[]);
});

test('step badge preserves text input focus and selection while its shape and state update',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,'## 段階 {#step}\n\n::: {data-step="2"}\n最初。\n:::\n\n二番目の段落。\n\n## 最後 {#last}\n\n::: {data-step="3"}\n最後。\n:::\n');
 await badges(page,['2']);const qb=page.locator('#qblocks .page.cur .step-badge');assert.equal(await qb.getAttribute('class'),'step-badge pending');
 assert.deepEqual(await qb.evaluate(e=>{const s=getComputedStyle(e);return [s.backgroundColor,s.color,s.borderStyle,s.borderRadius];}),['rgb(255, 255, 255)','rgb(31, 99, 214)','dashed','999px']);
 for(const theme of ['dark','light']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert.equal(await qb.evaluate(e=>getComputedStyle(e).color),'rgb(31, 99, 214)');assert.ok(await qb.evaluate(e=>Math.abs((e as HTMLElement).offsetWidth-(e as HTMLElement).offsetHeight)<=1));}
 await qb.click();await page.locator('#blockTools .step-chips').waitFor();assert.equal(await page.locator('#qblocks .card.editing').count(),0);assert.equal(await page.frameLocator('#slideBox > iframe:not(.loading)').locator('.slide-studio-editing,.slide-studio-step-badge').count(),0);await page.keyboard.press('Escape');
 await page.locator('#qblocks .page.cur .card').filter({hasText:'二番目の段落。'}).click();const input=page.locator('#qblocks .card.editing textarea');await input.evaluate(e=>{(window as any).__badgeInput=e;(e as HTMLTextAreaElement).setSelectionRange(2,2);});
 await stage(page,1);await page.waitForFunction(()=>document.querySelector('#qblocks .page.cur .step-badge')?.className==='step-badge');
 assert.ok(await input.evaluate(e=>e===(window as any).__badgeInput&&(e as HTMLTextAreaElement).selectionStart===2&&document.activeElement===e));
 assert.deepEqual(await qb.evaluate(e=>[getComputedStyle(e).backgroundColor,getComputedStyle(e).color]),['rgb(31, 99, 214)','rgb(255, 255, 255)']);
 await stage(page,0);await page.waitForFunction(()=>document.querySelector('#qblocks .page.cur .step-badge')?.className==='step-badge pending');assert.equal(await qb.getAttribute('data-tip'),'段階表示：段 2（まだ出ていない）・押すと段階表示を変える');assert.equal(await page.locator('#qblocks .page.dormant .step-badge.pending').count(),0);await page.keyboard.press('Escape');assert.deepEqual(errors,[]);
});

test('figure badge ranges follow internal steps and keep later incremental items pending',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,'## 図 {#fig}\n\n{{< fig test/box step="3" >}}\n\n::: {.incremental data-step="4"}\n- 次\n- 最後\n:::\n','',async ws=>{await figure(ws,'box',true);});
 await badges(page,['2–7','8–9']);const qb=page.locator('#qblocks .page.cur .step-badge');assert.equal(await qb.nth(0).getAttribute('data-tip'),'段階表示：段 3（図の中で 5 回送る）（まだ出ていない）・押すと段階表示を変える');
 const frame=await stage(page,5);await page.waitForFunction(()=>document.querySelector('#qblocks .page.cur .step-badge')?.className==='step-badge');assert.equal(await qb.nth(1).getAttribute('class'),'step-badge pending');
 await qb.nth(0).click();await page.locator('#blockTools .step-chips').waitFor();assert.equal(await frame.locator('.animation.slide-studio-selected').count(),1);await qb.nth(1).click();assert.equal(await page.locator('#blockTools .step-tools input[type=checkbox]').isChecked(),true);
 for(const [n,label] of [[null,'2'],[0,'2'],[5,'2–7']] as const){await frame.evaluate(n=>{const w=window as any;const f=document.querySelector('.slide.active iframe') as HTMLIFrameElement;(f.contentWindow as any).animation.steps=n;w.dispatchEvent(new CustomEvent('deckchange',{detail:{index:w.deck.index,step:w.deck.step,maxStep:w.deck.maxStep()}}));},n);await page.waitForFunction(label=>document.querySelector('#qblocks .page.cur .step-badge')?.textContent===label,label);}
 assert.equal(await frame.locator('.slide-studio-step-badge').count(),0);assert.deepEqual(errors,[]);
});

test('late figure loading refreshes badge ranges through real player events',{timeout:60000},async t=>{
 const held:import('playwright-core').Route[]=[];const {page,errors}=await setup(t,'## 最初 {#intro}\n\n本文。\n\n## 図 {#fig}\n\n{{< fig test/late step="3" >}}\n','',async(ws,page)=>{await figure(ws,'late');await page.route('**/late/figure.mjs*',route=>{held.push(route);});});
 await page.frameLocator('#slideBox > iframe:not(.loading)').locator('body').evaluate(()=>{void (window as any).deck.go(1);});
 await badges(page,['2']);for(let i=0;i<100&&!held.length;i++)await page.waitForTimeout(20);assert.ok(held.length);for(const route of held)await route.continue();await page.unroute('**/late/figure.mjs*');await badges(page,['2–4']);assert.deepEqual(errors,[]);
});

test('initial figures and reversed source order retain display sequence and step choices',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,'## 図 {#fig}\n\n::: {data-step="2"}\n上の文字。\n:::\n\n{{< fig test/first >}}\n\n::: {data-step="1"}\n下の文字。\n:::\n','',async ws=>{await figure(ws,'first');});
 await badges(page,['5','1–3','4']);assert.equal(await page.locator('#stepCount').textContent(),'1 / 5');const qb=page.locator('#qblocks .page.cur .step-badge');await stage(page,3);await page.waitForFunction(()=>document.querySelectorAll('#qblocks .page.cur .step-badge')[2]?.className==='step-badge');assert.equal(await qb.nth(0).getAttribute('class'),'step-badge pending');await stage(page,4);await page.waitForFunction(()=>document.querySelector('#qblocks .page.cur .step-badge')?.className==='step-badge');await qb.nth(0).click();assert.deepEqual(await page.locator('#blockTools .step-chip').allTextContents(),['0 → ①','1 → ④','2 → ⑤']);assert.deepEqual(errors,[]);
});

test('simultaneous figures share a start and wait for the longest animation',{timeout:60000},async t=>{
 const {page,errors}=await setup(t,'## 図 {#fig}\n\n{{< fig test/short step="1" >}}\n\n{{< fig test/long step="1" >}}\n\n::: {data-step="1"}\n同時。\n:::\n\n::: {data-step="2"}\n最後。\n:::\n','',async ws=>{await figure(ws,'short');await figure(ws,'long',true);});
 await badges(page,['2–4','2–7','2','8']);const frame=await stage(page,0);await frame.evaluate(()=>{for(const f of document.querySelectorAll<HTMLIFrameElement>('.slide.active iframe')){const a=(f.contentWindow as any).animation,original=a.setStep.bind(a);a.setStep=(n:number,animate:boolean)=>{a.testStep=n;return original(n,animate);};}});
 await stage(page,6);await page.waitForFunction(()=>document.querySelectorAll('#qblocks .page.cur .step-badge')[2]?.className==='step-badge');assert.equal(await page.locator('#qblocks .page.cur .step-badge').nth(3).getAttribute('class'),'step-badge pending');assert.deepEqual(await frame.evaluate(()=>[...document.querySelectorAll<HTMLIFrameElement>('.slide.active iframe')].map(f=>(f.contentWindow as any).animation.testStep)),[2,5]);await stage(page,7);await page.waitForFunction(()=>document.querySelectorAll('#qblocks .page.cur .step-badge')[3]?.className==='step-badge');assert.deepEqual(errors,[]);
});

test('container step selection preserves its children and supports removal and undo',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 囲み {#box}\n\n::: {.row}\n最初。\n\n囲みの本文。\n:::\n');const frame=page.frameLocator('#slideBox > iframe:not(.loading)'),bar=page.locator('#blockTools');
 await frame.locator('p').filter({hasText:'最初。'}).click();await bar.getByRole('button',{name:'外側を選択',exact:true}).click();await bar.getByRole('button',{name:'段階表示',exact:true}).click();await bar.getByRole('button',{name:'段 1（新しい段）',exact:true}).click();await saved(ws,'.row data-step="1"');await frame.locator('.row[data-step="1"]').waitFor();await badges(page,['2']);await page.locator('#qblocks .page.cur .step-badge').click();await bar.getByRole('button',{name:'段 0（最初から）',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('.raw textarea') as HTMLTextAreaElement).value.includes('data-step='));await page.keyboard.press('Meta+z');await saved(ws,'.row data-step="1"');assert.deepEqual(errors,[]);
});

test('PDF marks survive source editing while the previous save and preview are pending',{timeout:60000},async t=>{
 const {ws,page,errors}=await setup(t,'## 段階 {#steps}\n\n::: {data-step="1"}\n最初。\n:::\n\n::: {data-step="2"}\n次。\n:::\n');await page.getByRole('button',{name:'すべての記法を表示',exact:true}).click();
 const pending:import('playwright-core').Route[]=[];let hold=true;await page.route('**/api/deck/talk/source',route=>{if(hold&&route.request().method()==='PUT')pending.push(route);else void route.continue();});
 const box=page.locator('#pdfStep'),raw=page.locator('.raw textarea');const request=page.waitForRequest(r=>r.method()==='PUT'&&r.url().endsWith('/source'));await box.check();await request;assert.ok((await raw.inputValue()).includes('pdf="1"'));await raw.fill((await raw.inputValue()).replace('最初。','編集した段落。'));await raw.blur();await page.locator('#pagestrip button[data-index="0"]').click();await page.locator('#stepNext').click();await page.waitForFunction(()=>document.querySelector('#stepCount')?.textContent==='2 / 3');await box.check();assert.ok((await raw.inputValue()).includes('pdf="1 2"'));hold=false;for(const route of pending)await route.continue();await saved(ws,'## 段階 {#steps pdf="1 2"}');await saved(ws,'編集した段落。');await page.reload();await page.locator('#stage[data-blocks=ready]').waitFor();assert.deepEqual(await page.frameLocator('#slideBox > iframe:not(.loading)').locator('body').evaluate(()=>(window as any).deck.pdfSteps(0)),[0,1,2]);assert.deepEqual(errors,[]);
});

test('bundled default matches the theme used by the old app without heading ornaments',{timeout:60000},async t=>{
 const {page,ws,errors}=await setup(t,'## 旧版の見出し {#theme}\n\n本文。\n');const frame=page.frameLocator('#slideBox > iframe:not(.loading)');
 const heading=frame.locator('.slide.active > h2');assert.deepEqual(await heading.evaluate(e=>['::before','::after'].map(p=>getComputedStyle(e,p).content)),['none','none']);assert.equal(await heading.evaluate(e=>getComputedStyle(e).color),'rgb(34, 77, 145)');
 const css=await readFile(join(ws.themes,'default.css'),'utf8');assert.ok(css.includes('--heading-mode:plain'));assert.ok(css.includes('--teal:#47a9aa'));
 if(process.env.SLIDE_STUDIO_THEME_SCREENSHOT)await page.screenshot({path:process.env.SLIDE_STUDIO_THEME_SCREENSHOT});assert.deepEqual(errors,[]);
});
