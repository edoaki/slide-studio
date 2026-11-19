import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { parse } from '../../packages/core/src/source.js';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('manuscript search and block menu work with keyboard, source navigation, history, and trusted frame events', {skip: !existsSync(chrome), timeout: 20000}, async t => {
  const source = '---\ntitle: 原稿\n---\n\n## First\n\nAlpha [.*]\n\n## Second\n\nalpha [.*]\n';
  const structure = parse(source).to_json();
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><link rel="stylesheet" href="/packages/web/app.css"><style>body{overflow:auto}.app{width:600px}.block-context-menu{background:white}</style><div class="app"><div id="barExtra"></div><button id="foldToggle"></button><button id="editorToggle"></button><div id="edBanner"></div><div id="qscroll"><div id="qhost"></div></div><p id="painted">Painted block</p></div><script type="module">
        import { makeManuscriptSearch } from '/packages/web/manuscript-search.js';
        import { QmdEditor } from '/packages/web/qmd-editor.js';
        import { makeBlockContextMenu } from '/packages/web/block-context-menu.js';
        import { blockContextActions } from '/packages/web/block-context-model.js';
        import { createFrameBlocks } from '/packages/web/bridge/frame-blocks.js';
        import * as op from '/packages/web/block-ops.js';
        const text = ${JSON.stringify(source)}, structure = ${JSON.stringify(structure)};
        const ctx = window.ctx = {root:document.querySelector('.app'), text, lock:{}, history:[], visits:[], flush:async()=>true};
        ctx.preview={slideOfPage:page=>page+1,go:slide=>ctx.slide=slide};
        ctx.editor = new QmdEditor(document.querySelector('#qhost'), {onInput(){}, onCaret(){}, onFold(){}, onLocked(){}});
        ctx.editor.setText(text);
        ctx.showSourceIssue = ({source_offset})=>{ctx.visits.push(source_offset);ctx.editor.setCaretOffset(source_offset);ctx.editor.caret();};
        ctx.setText = next=>{ctx.history.push(ctx.text);ctx.text=next;ctx.editor.setText(next);plugin.textChanged();};
        const plugin = makeManuscriptSearch(ctx);window.plugin=plugin;
        window.actions=[];
        const menu = makeBlockContextMenu({root:ctx.root,apply:name=>window.actions.push(name),movePage:page=>window.actions.push(page)});
        const st={...op.units(text,structure),text}; const key=st.pages[0].chunks[0].key;
        window.openMenu=()=>menu.open({x:10,y:10,actions:blockContextActions(text,st,key),anchor:document.querySelector('#painted')});
        window.frameEvents=[];let version='v1';window.setFrameVersion=v=>version=v;
        window.deck={index:0,slides:[document.createElement('section')]};
        const frameBlocks=createFrameBlocks(window,document,{getSourceVersion:()=>version,sendEvent:(event,data)=>window.frameEvents.push({event,data})});
        document.querySelector('#painted').dataset.slideStudio=key;
        frameBlocks.configure({sourceVersion:'v1',text,structure,key:null,live:true,color:'#2167a8',padMode:null});
        window.ready=true;
      </script>`);
      return;
    }
    if (!req.url?.startsWith('/packages/web/')) { res.writeHead(404).end(); return; }
    try {
      const path = resolve('.' + req.url);
      if (!path.startsWith(resolve('packages/web') + '/')) { res.writeHead(403).end(); return; }
      res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({executablePath: chrome, headless: true});
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const page = await browser.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}/`); await page.waitForFunction(() => (window as any).ready);
  await page.keyboard.press('Control+f');
  const query = page.getByRole('searchbox', {name:'検索する文字列'});
  await query.fill('alpha');
  assert.equal(await page.locator('.search-result').count(), 2);
  await page.locator('.search-result').nth(1).click();
  assert.equal(await page.locator('#qhost textarea').evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd)), 'alpha');
  assert.equal(await page.evaluate(() => (window as any).ctx.visits.at(-1)), source.lastIndexOf('alpha'));
  assert.equal(await page.evaluate(() => (window as any).ctx.slide), 2);
  await query.focus(); await page.keyboard.press('Enter');
  assert.equal(await query.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => (window as any).ctx.visits.at(-1)), source.indexOf('Alpha'));
  await page.keyboard.press('Shift+Enter');
  assert.equal(await page.evaluate(() => (window as any).ctx.visits.at(-1)), source.lastIndexOf('alpha'));
  await query.fill('[.*]');
  await page.getByRole('textbox', {name:'置換後の文字列'}).fill('$&😀');
  await page.getByRole('button', {name:'すべて置換', exact:true}).click();
  await page.waitForFunction(() => (window as any).ctx.history.length === 1);
  assert.equal(await page.evaluate(() => (window as any).ctx.text), source.replaceAll('[.*]', '$$&😀'));
  await page.evaluate(() => { const ctx=(window as any).ctx;ctx.text=ctx.history.pop();ctx.editor.setText(ctx.text);(window as any).plugin.textChanged(); });
  await query.fill('alpha'); await page.getByRole('checkbox', {name:'大文字と小文字を区別'}).check();
  assert.equal(await page.locator('.search-result').count(), 1);
  await page.evaluate(() => { (window as any).ctx.allLocked=true;(window as any).plugin.statusChanged(); });
  assert.equal(await page.getByRole('button', {name:'置換', exact:true}).isDisabled(), true);
  await query.focus(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.manuscript-search').isVisible(), false);
  await page.evaluate(() => (window as any).openMenu());
  assert.equal(await page.getByRole('menuitem', {name:'上へ移動', exact:true}).isDisabled(), true);
  await page.getByRole('menuitem', {name:'複製', exact:true}).click();
  assert.deepEqual(await page.evaluate(() => (window as any).actions), ['duplicate']);
  await page.evaluate(() => (window as any).openMenu());
  await page.getByLabel('別のページへ移動', {exact:true}).selectOption('1');
  assert.deepEqual(await page.evaluate(() => (window as any).actions), ['duplicate',1]);
  await page.evaluate(() => (window as any).openMenu()); await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  await page.locator('#painted').click({button:'right'});
  assert.equal(await page.evaluate(() => (window as any).frameEvents.filter((e:any)=>e.data.kind==='context').length), 1);
  await page.evaluate(() => { document.querySelector('#painted')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}));(window as any).setFrameVersion('v2'); });
  await page.locator('#painted').click({button:'right'});
  assert.equal(await page.evaluate(() => (window as any).frameEvents.filter((e:any)=>e.data.kind==='context').length), 1);
  assert.deepEqual(errors, []);
});
