import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { _electron } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { add } from '../../packages/core/src/legacy-assets.js';
import { new_figure } from '../../packages/core/src/legacy-figures.js';
import { execute } from '../../packages/ai/src/process.js';
const require=createRequire(import.meta.url);
test('original Electron editor renders shared figures, checks all steps and exports offline HTML and selected-step PDF', {timeout:Number(process.env.SLIDE_STUDIO_WORKFLOW_TIMEOUT||120000)}, async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-workflow-'));const ws=Workspace.open(join(temp,'workspace'));ws.new_deck('talk','test');await new_figure(ws,'chart',ws.shelf_dir('test'));add(ws,'talk','plot.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=','base64'));
 await writeFile(ws.qmd('talk'),'---\ntitle: 日本語の発表\nauthor:\n  - name: 発表者\n    affiliation: 研究室\ntopic: test\ntheme: default\n---\n\n## 発表タイトル {#cover .cover}\n\n::: {.cover-title}\n日本語の発表\n:::\n\n## 原稿と数式 {#intro}\n\n日本語の本文と $a+b$。\n\n![](images/plot.png){width=80}\n\n## 図の説明 {#chart pdf="1,2"}\n\n{{< fig test/chart >}}\n');
 const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));env.SLIDE_STUDIO_ELECTRON_HOME=join(temp,'profile');delete env.ELECTRON_RUN_AS_NODE;
 const installed=process.env.SLIDE_STUDIO_TEST_APP;
 const executablePath=installed?.endsWith('.app')?join(installed,'Contents/MacOS/Slide Studio'):installed||require('electron');
 const app=await _electron.launch({executablePath,args:[...(installed?[]:[join(process.cwd(),'dist/apps/desktop/main.js')]),'--root',ws.root],env});t.after(async()=>{await app.close();await rm(temp,{recursive:true,force:true});});
 const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.stack || e.message));await page.waitForFunction(()=>!!sessionStorage.getItem('slide-studio:admin-token'));
 await page.locator('.theme-card img').first().waitFor({timeout:60000});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLImageElement>('.theme-card img')).some(image=>image.complete&&image.naturalWidth>0));
 await page.getByRole('button',{name:'新しい発表',exact:true}).click();
 const create=page.getByRole('dialog',{name:'新しい発表',exact:true});
 await create.locator('input[name=title]').fill('アプリから作った発表');await create.locator('input[name=name]').fill('created-in-app');
 await create.getByRole('button',{name:'作る',exact:true}).click();
 await page.waitForURL('**/deck/created-in-app');
 await page.locator('[data-tab="memo"]').click();
 await page.locator('.memo-audience').fill('研究室の学生');await page.locator('.memo-duration').fill('15分');
 await page.locator('.memo-conclusion').fill('実装と検証の結果を説明する');await page.locator('.memo-input').fill('発表の下書きを保存し、開き直して確認する。');
 for(let i=0;i<100;i++){try{if((await readFile(ws.memo('created-in-app'),'utf8')).includes('開き直して確認'))break;}catch{}await page.waitForTimeout(50);}
 assert.match(await readFile(ws.memo('created-in-app'),'utf8'),/研究室の学生/);
 await page.goto(new URL('/',page.url()).href);
 await page.locator('.deck-card-wrap[data-deck="created-in-app"] .name').filter({hasText:'アプリから作った発表'}).waitFor();
 await page.goto(new URL('/deck/created-in-app',page.url()).href);await page.locator('[data-tab="memo"]').click();
 await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('.memo-audience')?.value==='研究室の学生');
 assert.match(await page.locator('.memo-input').inputValue(),/開き直して確認/);
 await page.goto(new URL('/',page.url()).href);
 await page.locator('.deck-card-wrap[data-deck="talk"] .deck-more').click();
 await page.getByRole('menuitem',{name:'名前を変更',exact:true}).click();
 const renameDialog=page.getByRole('dialog',{name:'名前を変更',exact:true});await renameDialog.locator('input').fill('変更した発表');
 const renameResponse=page.waitForResponse(r=>r.url().endsWith('/api/home/manage')&&r.request().method()==='POST');
 await renameDialog.getByRole('button',{name:'変更を保存',exact:true}).click();const renamed=await renameResponse;assert.equal(renamed.status(),200,await renamed.text());
 await page.locator('.deck-card-wrap[data-deck="talk"] .name').filter({hasText:'変更した発表'}).waitFor();
 await page.getByRole('button',{name:'元に戻す',exact:true}).click();
 await page.locator('.deck-card-wrap[data-deck="talk"] .name').filter({hasText:'日本語の発表'}).waitFor();
 await page.goto(new URL('/topic/test',page.url()).href);
 await page.locator('.topic-html .card').filter({hasText:'chart'}).waitFor();
 await page.frameLocator('.topic-step iframe').nth(1).locator('#stage[data-step="1"] svg').waitFor();
 await page.goto(new URL('/deck/talk',page.url()).href);
 await app.evaluate(({BrowserWindow},dir)=>{const win=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().startsWith('studio-render:'))!;win.webContents.session.on('will-download',(_e,item)=>item.setSavePath(`${dir}/${item.getFilename()}`));},temp);
 await page.locator('#pagestrip img.shot').first().waitFor({timeout:60000});

 await page.locator('#stage[data-blocks=ready]').waitFor();
 const cover=page.frameLocator('#slideBox > iframe:not(.loading)');
 await cover.locator('.slide.active .cover-authors').click();
 const authorSize=page.getByRole('spinbutton',{name:'名前の文字サイズ（px）',exact:true});await authorSize.fill('42');await authorSize.press('Tab');
 for(let i=0;i<100;i++){if((await readFile(ws.qmd('talk'),'utf8')).includes('"size":42'))break;await new Promise(r=>setTimeout(r,50));}
 assert.match(await readFile(ws.qmd('talk'),'utf8'),/"size":42/);
 await page.locator('#pagestrip button[data-index]').filter({hasText:'原稿と数式'}).click();
 const preview=page.frameLocator('#slideBox > iframe:not(.loading)');
 const paragraph=preview.locator('.slide.active [data-slide-studio]').filter({hasText:'日本語の本文'});
 await page.locator('#stage[data-blocks=ready]').waitFor();

 await page.getByRole('toolbar',{name:'名前と所属',exact:true}).waitFor({state:'hidden'});
 const plot=preview.locator('.slide.active img[src*="plot.png"]');await plot.click();
 const corner=preview.locator('.bh.corner').last();await corner.waitFor();let bounds=await corner.boundingBox();
 for(let attempt=0;!bounds&&attempt<20;attempt++){await page.waitForTimeout(50);bounds=await corner.boundingBox();}assert.ok(bounds);
 await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2+20,bounds.y+bounds.height/2+20,{steps:5});await page.mouse.up();
 for(let i=0;i<100;i++){if(!(/width[= ]80/.test(await readFile(ws.qmd('talk'),'utf8'))))break;await new Promise(r=>setTimeout(r,50));}
 assert.doesNotMatch(await readFile(ws.qmd('talk'),'utf8'),/width[= ]80/);
 const resizedVersion=createHash('sha256').update(await readFile(ws.qmd('talk'))).digest('hex');
 await preview.locator(`script[data-studio-version="${resizedVersion}"]`).waitFor({state:'attached'});
 await page.keyboard.press('Escape');
 await paragraph.click();await preview.locator('.slide-studio-selected').filter({hasText:'日本語の本文'}).waitFor();await paragraph.click();
 const editing=preview.locator('.slide-studio-editing');await editing.waitFor({timeout:5000});
 await editing.fill('編集した日本語の本文。');await editing.press('Escape');
 await page.waitForFunction(()=>document.querySelector('#status')?.textContent?.includes('保存') || !document.querySelector('.dirty'));
 for(let i=0;i<100;i++){if((await readFile(ws.qmd('talk'),'utf8')).includes('編集した日本語の本文。'))break;await new Promise(r=>setTimeout(r,50));}
 assert.match(await readFile(ws.qmd('talk'),'utf8'),/編集した日本語の本文。/);
 const editedVersion=createHash('sha256').update(await readFile(ws.qmd('talk'))).digest('hex');
 await preview.locator(`script[data-studio-version="${editedVersion}"]`).waitFor({state:'attached'});
 await page.locator('#stage[data-blocks=ready]').waitFor();
 const movedText=preview.locator('.slide.active [data-slide-studio]').filter({hasText:'編集した日本語の本文。'}).first();
 const sourceBox=await movedText.boundingBox(),destinationBox=await page.locator('#pagestrip button[data-index]').last().boundingBox();assert.ok(sourceBox&&destinationBox);
 await page.mouse.move(sourceBox.x+sourceBox.width/2,sourceBox.y+2);await page.mouse.down();
 await page.mouse.move(sourceBox.x+sourceBox.width/2+10,sourceBox.y+2,{steps:3});
 await page.mouse.move(destinationBox.x+destinationBox.width/2,destinationBox.y+destinationBox.height/2,{steps:12});await page.mouse.up();
 for(let i=0;i<100;i++){const text=await readFile(ws.qmd('talk'),'utf8');if(text.indexOf('編集した日本語の本文。')>text.indexOf('## 図の説明'))break;await page.waitForTimeout(50);}
 const movedSource=await readFile(ws.qmd('talk'),'utf8');assert.ok(movedSource.indexOf('編集した日本語の本文。')>movedSource.indexOf('## 図の説明'),'dragging from the preview to a thumbnail moves the block to that page');
 await page.getByRole('button',{name:'書き出し',exact:true}).click();
 const htmlResponse=page.waitForResponse(r=>r.url().endsWith('/api/deck/talk/build')&&r.request().method()==='POST');
 await page.locator('.output-popover [data-format="html"]').click();const html=await (await htmlResponse).json();assert.ok(html.files,JSON.stringify(html));
 const bundled=await readFile(join(ws.deck_dir('talk'),'日本語の発表.html'),'utf8');assert.match(bundled,/srcdoc=/);assert.match(bundled,/data:text\/javascript;base64/);assert.match(bundled,/日本語の本文/);assert.doesNotMatch(bundled,/127\.0\.0\.1/);
 const pdfResponse=page.waitForResponse(r=>r.url().endsWith('/api/deck/talk/build')&&r.request().method()==='POST',{timeout:Number(process.env.SLIDE_STUDIO_WORKFLOW_EXPORT_TIMEOUT||30000)});await page.locator('.output-popover [data-format="pdf"]').click();const result=await (await pdfResponse).json();assert.ok(result.files,JSON.stringify(result));const pdf=await PDFDocument.load(await readFile(join(ws.deck_dir('talk'),'日本語の発表.pdf')));assert.ok(pdf.getPageCount()>=4);assert.deepEqual(pdf.getPage(0).getSize(),{width:960,height:540});
 await page.waitForFunction(()=>document.querySelector('.output-body .done')!==null);for(const ext of ['html','pdf']) {
  const exported=await readFile(join(ws.deck_dir('talk'),`日本語の発表.${ext}`));
  let downloaded:Buffer|undefined;
  for(let attempt=0;attempt<100;attempt++){try{downloaded=await readFile(join(temp,`日本語の発表.${ext}`));if(downloaded.equals(exported))break;}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.deepEqual(downloaded,exported,`${ext} must also be saved by Electron's download handler`);
 }
 assert.deepEqual(errors,[]);
 if(process.platform==='darwin'){
  const launcher=join(temp,'profile/bin/slide-studio'),codex=process.env.SLIDE_STUDIO_SANDBOX_TEST_CODEX;
  const cli=(args:string[])=>execute(codex||launcher,codex?['sandbox','-c','default_permissions="slide-studio"','-c','permissions.slide-studio.extends=":workspace"','--',launcher,...args]:args,{cwd:ws.root,env:{...env,SLIDE_STUDIO_HOME:ws.root,SLIDE_STUDIO_SANDBOX:'1'},timeoutMs:60000});
  const checked=await cli(['check','talk','--json']);assert.equal(checked.code,0,checked.stderr);assert.equal(JSON.parse(checked.stdout).slides,3);
  const audit=await cli(['audit','run','talk']);assert.equal(audit.code,1,audit.stderr);const report=JSON.parse(audit.stdout);assert.equal(report.status,'needs_review');assert.ok(report.states.length>=4);
  const savedAudit=await cli(['audit','status','talk',report.audit_id]);assert.equal(JSON.parse(savedAudit.stdout).audit_id,report.audit_id);
 }
 await page.waitForFunction(()=>document.querySelector('#status')?.getAttribute('data-tone')==='ok');
 assert.doesNotMatch(await page.locator('#status').innerText(),/検査が古い/);
 if(process.env.SLIDE_STUDIO_TEST_ARTIFACTS) await page.screenshot({path:join(process.env.SLIDE_STUDIO_TEST_ARTIFACTS,'original-editor-installed.png')});
});
