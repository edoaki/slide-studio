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
 t.after(async()=>{try{await app.evaluate(async()=>{await (globalThis as any).__restoreParityClipboard?.();});}finally{await app.close();await rm(temp,{recursive:true,force:true});}});
 const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>!!sessionStorage.getItem('slide-studio:admin-token'));
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
