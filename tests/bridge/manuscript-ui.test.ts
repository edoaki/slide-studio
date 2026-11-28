import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { parse } from '../../packages/core/src/source.js';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('block menu works with keyboard and trusted frame events', {skip: !existsSync(chrome), timeout: 20000}, async t => {
  const source = '---\ntitle: 原稿\n---\n\n## First\n\nAlpha [.*]\n\n## Second\n\nalpha [.*]\n';
  const structure = parse(source).to_json();
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><link rel="stylesheet" href="/packages/web/shared.css"><link rel="stylesheet" href="/packages/web/app.css"><style>body{overflow:auto}.app{width:600px}.block-context-menu{background:white}</style><div class="app"><p id="painted">Painted block</p></div><script type="module">
        import { makeBlockContextMenu } from '/packages/web/block-context-menu.js';
        import { blockContextActions } from '/packages/web/block-context-model.js';
        import { createFrameBlocks } from '/packages/web/bridge/frame-blocks.js';
        import * as op from '/packages/web/block-ops.js';
        const text = ${JSON.stringify(source)}, structure = ${JSON.stringify(structure)};
        window.actions=[];
        const menu = makeBlockContextMenu({root:document.querySelector('.app'),apply:name=>window.actions.push(name),movePage:page=>window.actions.push(page)});
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
  await page.evaluate(() => (window as any).openMenu());
  assert.equal(await page.getByRole('menuitem', {name:'上へ移動', exact:true}).isDisabled(), true);
  await page.getByRole('menuitem', {name:'複製', exact:true}).click();
  assert.deepEqual(await page.evaluate(() => (window as any).actions), ['duplicate']);
  await page.evaluate(() => (window as any).openMenu());
  await page.getByRole('combobox', {name:'別のページへ移動', exact:true}).click();
  await page.locator('.ss-list:popover-open [role=option][data-value="1"]').click();
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
