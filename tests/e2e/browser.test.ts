import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { _electron, chromium, type ElectronApplication, type Browser } from 'playwright-core';
import { Workspace } from '../../packages/core/src/workspace.js';
const require = createRequire(import.meta.url);
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('browser mode serves the same editor to Chrome and exports through the bundled renderer', {timeout: 90000, skip: !existsSync(chrome)}, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'studio-browser-')), profile = join(temp, 'profile');
  const ws = Workspace.open(join(temp, 'workspace')); ws.new_deck('talk', 'test');
  await writeFile(ws.qmd('talk'), '---\ntitle: ブラウザー版\ntopic: test\ntheme: default\n---\n\n## 本文 {#intro}\n\nブラウザーから編集する本文。\n\n## 次のページ {#next}\n\n次の本文。\n\n## 最後のページ {#last}\n\n最後の本文。\n');
  ws.new_deck('past', 'old');
  await writeFile(ws.qmd('past'), '---\ntitle: 過去のスライド\ntopic: old\n---\n\n## 再利用するページ 😀\n\n最初の結果 [@known]\n\n## 二つ目の再利用ページ\n\n次の結果\n');
  await writeFile(ws.bib('past'), '@article{known,title={Known result},author={Doe, Jane},year={2025}}');
  let app: ElectronApplication | undefined, browser: Browser | undefined;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(temp, {recursive: true, force: true}); });
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {SLIDE_STUDIO_ELECTRON_HOME: profile, SLIDE_STUDIO_CODEX: 'none', SLIDE_STUDIO_CLAUDE: 'none', SLIDE_STUDIO_AGY: 'none'});
  app = await _electron.launch({executablePath: require('electron'), args: [join(process.cwd(), 'dist/apps/desktop/main.js'), '--studio-browser', '--root', ws.root, '--port', '0', '--no-browser'], env});
  let bootstrap = '';
  for (let attempt = 0; attempt < 100; attempt++) { try { bootstrap = await readFile(join(profile, 'browser-connection.html'), 'utf8'); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
  const url = /href="([^"]+)"/u.exec(bootstrap)?.[1]; assert.ok(url);
  browser = await chromium.launch({executablePath: chrome, headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 860}, acceptDownloads: true}), errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto(url);
  assert.equal(await page.getByRole('button', {name: '保存先を変更', exact: true}).count(), 0);
  await page.getByRole('button', {name: '設定', exact: true}).click();
  const settings = page.getByRole('dialog', {name: '設定', exact: true});
  await settings.getByRole('button', {name: '保存先を変更', exact: true}).click();
  await page.locator('dialog.location-dialog').waitFor();
  await page.keyboard.press('Escape');
  assert.ok(await settings.isVisible());
  await page.keyboard.press('Escape');
  await page.locator('.deck-card-wrap[data-deck=talk] .card').click();
  await page.locator('#stage[data-blocks=ready]').waitFor();
  const settingsButton = page.getByRole('button', {name: '設定', exact: true});
  for (const editorHidden of [false, true]) {
    await page.evaluate(hidden => document.body.classList.toggle('editor-off', hidden), editorHidden);
    const box = await settingsButton.boundingBox();
    assert.ok(box && box.x < 30 && box.y > 810 && box.y + box.height <= 860);
  }
  await page.evaluate(() => document.body.classList.remove('editor-off'));
  await settingsButton.click();
  await settings.locator('[data-tab=appearance]').click();
  await settings.getByLabel('画面下にキー操作の案内を表示', {exact: true}).uncheck();
  await page.waitForFunction(() => document.documentElement.dataset.keyHints === 'false');
  await page.keyboard.press('Escape');
  assert.ok(await settingsButton.isVisible());
  assert.equal(await page.locator('#hintKeys').isVisible(), false);
  const frame = page.frameLocator('#slideBox > iframe:not(.loading)');
  await t.test('theme page numbers save and render positions, sizes, and formats', async () => {
    await page.getByRole('tab', {name: 'テーマ', exact: true}).click();
    try {
    const position = page.getByLabel('ページ番号の位置', {exact: true});
    const size = page.getByLabel('ページ番号の文字サイズ（px）', {exact: true});
    const format = page.getByLabel('ページ番号の表記', {exact: true});
    const number = frame.locator('.slide.active .page-number');
    const waitStyle = async (locator: typeof number, expected: Record<string, string>) => {
      for (let i = 0; i < 100; i++) {
        const matches = await locator.evaluate((el, values) => Object.entries(values).every(([key, value]) => value === 'auto' || getComputedStyle(el).getPropertyValue(key) === value), expected);
        if (matches) return;
        await page.waitForTimeout(50);
      }
      assert.deepEqual(await locator.evaluate((el, keys) => Object.fromEntries(keys.map(k => [k, getComputedStyle(el).getPropertyValue(k)])), Object.keys(expected)), expected);
    };
    const check = (expected: Record<string, string>) => waitStyle(number, expected);
    for (const value of ['top-right', 'bottom-right', 'bottom-left']) {
      await position.selectOption(value);
      await check({left: value === 'bottom-left' ? '30px' : 'auto', right: value === 'bottom-left' ? 'auto' : '30px', top: value === 'top-right' ? '24px' : 'auto', bottom: value === 'top-right' ? 'auto' : '24px'});
    }
    await size.fill('28'); await size.press('Tab');
    await format.selectOption('number');
    await waitStyle(number, {'font-size': '28px'});
    await waitStyle(number.locator('.page-number-total'), {display: 'none'});
    await format.selectOption('hidden');
    await frame.locator('.slide.active .page-number').waitFor({state: 'hidden'});
    await format.selectOption('total');
    await frame.locator('.slide.active .page-number-total').waitFor({state: 'visible'});
    for (let i = 0; i < 100; i++) {
      const css = await readFile(join(ws.root, 'themes/default.css'), 'utf8');
      if (css.includes('--page-number-format: total;') && css.includes('--page-number-size: 28px;') && css.includes('--page-number-position: bottom-left;')) break;
      await page.waitForTimeout(50);
    }
    const css = await readFile(join(ws.root, 'themes/default.css'), 'utf8');
    assert.match(css, /--page-number-size: 28px;/);
    assert.match(css, /--page-number-position: bottom-left;/);
    assert.match(css, /--page-number-format: total;/);
    await page.screenshot({path: '/tmp/slide-studio-page-number.png'});
    } finally { await page.getByRole('tab', {name: 'スライド', exact: true}).click(); }
  });
  const paragraph = frame.locator('.slide.active [data-slide-studio]').filter({hasText: 'ブラウザーから編集する本文。'});
  await paragraph.click(); await paragraph.click();
  const editing = frame.locator('.slide-studio-editing'); await editing.fill('Chromeで編集して保存した本文。'); await editing.press('Escape');
  for (let attempt = 0; attempt < 100; attempt++) { if ((await readFile(ws.qmd('talk'), 'utf8')).includes('Chromeで編集')) break; await new Promise(r => setTimeout(r, 50)); }
  assert.match(await readFile(ws.qmd('talk'), 'utf8'), /Chromeで編集して保存した本文/);
  await t.test('table of contents opens shared text tools and saves size, color, and item padding', async () => {
    const before = await readFile(ws.qmd('talk'), 'utf8');
    await page.getByRole('switch', {name: '目次を表示'}).check();
    try {
      assert.equal(await page.locator('.toc-settings input[type=number]').count(), 0);
      const listing = frame.locator('.toc-list li').first();
      await listing.waitFor({state: 'attached'});
      const showToc = async () => {
        await frame.locator('.slide.toc-slide').evaluate(el => {
          const deck = (window as any).deck;
          deck.go(deck.slides.indexOf(el));
        });
        await listing.locator('.toc-label').click();
      };
      await showToc();
      const tools = page.locator('.toc-text-tools');
      const size = tools.getByRole('spinbutton', {name: '文字の大きさ（px）'});
      await size.fill('42'); await size.press('Enter');
      for (let i = 0; i < 100; i++) {
        if (await listing.evaluate(el => getComputedStyle(el).fontSize) === '42px') break;
        await page.waitForTimeout(50);
      }
      assert.equal(await listing.evaluate(el => getComputedStyle(el).fontSize), '42px');
      assert.equal(await listing.locator('.toc-number').evaluate(el => getComputedStyle(el).fontSize), '33.6px');
      for (let i = 0; i < 100 && !(await readFile(ws.qmd('talk'), 'utf8')).includes('toc-size="42"'); i++) await page.waitForTimeout(50);
      assert.match(await readFile(ws.qmd('talk'), 'utf8'), /toc-size="42"/);
      await page.locator('#stage[data-blocks=ready]').waitFor();
      await showToc();
      await tools.getByRole('button', {name: '文字の色', exact: true}).click();
      await tools.getByRole('button', {name: 'プラス', exact: true}).click();
      for (let i = 0; i < 100 && !(await readFile(ws.qmd('talk'), 'utf8')).includes('toc-color="good"'); i++) await page.waitForTimeout(50);
      assert.match(await readFile(ws.qmd('talk'), 'utf8'), /toc-color="good"/);
      await page.locator('#stage[data-blocks=ready]').waitFor();
      await showToc();
      const padding = tools.getByRole('spinbutton', {name: '各項目の上下余白（px・片側）'});
      assert.equal(await padding.inputValue(), '16');
      for (const value of ['4', '0']) {
        await padding.fill(value); await padding.press('Enter');
        for (let i = 0; i < 100 && !(await readFile(ws.qmd('talk'), 'utf8')).includes(`toc-padding="${value}"`); i++) await page.waitForTimeout(50);
        assert.match(await readFile(ws.qmd('talk'), 'utf8'), new RegExp(`toc-padding="${value}"`));
        for (let i = 0; i < 100 && await listing.evaluate(el => getComputedStyle(el).paddingTop) !== `${value}px`; i++) await page.waitForTimeout(50);
        await page.locator('#stage[data-blocks=ready]').waitFor();
        await showToc();
        assert.equal(await listing.evaluate(el => getComputedStyle(el).paddingTop), `${value}px`);
        assert.equal(await listing.evaluate(el => getComputedStyle(el).paddingBottom), `${value}px`);
      }
      await page.reload(); await page.locator('#stage[data-blocks=ready]').waitFor();
      await showToc();
      assert.equal(await padding.inputValue(), '0');
      assert.equal(await listing.evaluate(el => getComputedStyle(el).paddingTop), '0px');
      assert.equal(await size.inputValue(), '42');
      assert.equal(await listing.evaluate(el => getComputedStyle(el).fontSize), '42px');
      assert.equal(await listing.evaluate(el => getComputedStyle(el).color), await listing.evaluate(el => {
        const probe = document.createElement('span'); probe.style.color = 'var(--good)'; el.append(probe);
        const color = getComputedStyle(probe).color; probe.remove(); return color;
      }));
      await page.keyboard.press('Escape');
      await tools.waitFor({state: 'hidden'});
    } finally {
      await writeFile(ws.qmd('talk'), before);
      await page.reload(); await page.locator('#stage[data-blocks=ready]').waitFor();
    }
  });
  await t.test('slide library selects a deck first and inserts at overview gaps with undo', async () => {
    const before = await readFile(ws.qmd('talk'), 'utf8');
    const saved = async (expected: string) => {
      for (let i=0; i<100; i++) {if (await readFile(ws.qmd('talk'),'utf8') === expected) return; await page.waitForTimeout(50);}
      assert.equal(await readFile(ws.qmd('talk'),'utf8'), expected);
    };
    const overviewButton = page.getByRole('button',{name:'一覧を表示',exact:true});
    assert.equal(await page.locator('#stripTools > button').count(), 2);
    const searchButton = page.getByRole('button',{name:'スライドを探す',exact:true});
    const searchBox = (await searchButton.boundingBox())!, stepperBox = (await page.locator('.stepper').boundingBox())!;
    assert.ok(searchBox.x > stepperBox.x + stepperBox.width, 'search control does not overlap page navigation');
    assert.ok(searchBox.x > (await overviewButton.boundingBox())!.x);
    await overviewButton.click();
    assert.equal(await page.locator('.overview-insert').count(), 0);
    await page.keyboard.press('Escape');
    await searchButton.click();
    const picker = page.getByRole('dialog',{name:'スライドを探す',exact:true});
    await picker.locator('.sl-deck-card').waitFor();
    assert.equal(await picker.locator('.sl-deck-card').count(),1);
    assert.equal(await picker.getByRole('checkbox').count(),0);
    assert.equal(await picker.locator('[data-deck=talk]').count(),0);
    await page.screenshot({animations:'disabled',path:'/tmp/slide-studio-desktop/library-decks.png'});
    await picker.locator('.sl-deck-card').click();
    await picker.getByRole('checkbox').first().waitFor();
    assert.equal(await picker.getByRole('checkbox').count(),2);
    await picker.locator('.slide-library-thumb img').first().waitFor({timeout:45000});
    await picker.getByRole('button',{name:'スライドの選択に戻る'}).click();
    await picker.locator('.sl-deck-card').click();
    // Selection order must not reverse the source page order.
    await picker.getByRole('checkbox').nth(1).check();
    await picker.getByRole('checkbox').nth(0).check();
    await page.screenshot({animations:'disabled',path:'/tmp/slide-studio-desktop/library-pages.png'});
    await picker.getByRole('button',{name:'指定位置に挿入',exact:true}).click();
    await page.locator('.overview-screen').waitFor();
    await page.keyboard.press('Escape');
    await picker.waitFor();
    assert.equal(await picker.locator('input:checked').count(),2);
    assert.equal(await readFile(ws.qmd('talk'),'utf8'),before);
    await picker.getByRole('button',{name:'指定位置に挿入',exact:true}).click();
    const overview = page.locator('.overview-screen');
    await overview.waitFor();
    await page.screenshot({animations:'disabled',path:'/tmp/slide-studio-desktop/library-insertion.png'});
    // The gap before the second manuscript page is a middle insertion.
    await overview.locator('.overview-insert').nth(1).click();
    await picker.waitFor({state:'detached'});
    const inserted = await readFile(ws.qmd('talk'),'utf8');
    assert.ok(inserted.indexOf('本文 {#intro}') < inserted.indexOf('再利用するページ'));
    assert.ok(inserted.indexOf('再利用するページ') < inserted.indexOf('二つ目の再利用ページ'));
    assert.ok(inserted.indexOf('二つ目の再利用ページ') < inserted.indexOf('次のページ {#next}'));
    assert.match(await readFile(ws.bib('talk'),'utf8'),/@article\{known/);
    await page.locator('#undo').click(); await saved(before);
    // Both the first boundary and direct append remain undoable.
    for (const boundary of ['first','last'] as const) {
      await page.locator('#stage[data-blocks=ready]').waitFor();
      await searchButton.click();
      await picker.locator('.sl-deck-card').click();
      await picker.getByRole('searchbox').fill('known');
      await picker.getByRole('button',{name:'検索',exact:true}).click();
      await page.waitForFunction(() => document.querySelectorAll('.slide-library input[type=checkbox]').length === 1);
      await picker.getByRole('checkbox').check();
      if (boundary === 'first') {
        await picker.getByRole('button',{name:'指定位置に挿入',exact:true}).click();
        await overview.locator('.overview-insert').first().click();
      } else await picker.getByRole('button',{name:'末尾に挿入',exact:true}).click();
      await picker.waitFor({state:'detached'});
      const text = await readFile(ws.qmd('talk'),'utf8');
      assert.ok(boundary === 'first' ? text.indexOf('再利用するページ') < text.indexOf('本文 {#intro}') : text.indexOf('再利用するページ') > text.indexOf('最後の本文。'));
      await page.locator('#undo').click(); await saved(before);
    }
  });
  await t.test('presentation menu uses an accessible icon and opens choices without starting', async () => {
    const menu = page.getByRole('button', {name:'発表用メニュー', exact:true});
    assert.equal(await menu.innerText(), '');
    assert.ok((await menu.boundingBox())!.width <= 48);
    assert.equal(await page.locator('#chat [data-act=hist]').first().innerText(), '');
    assert.equal(await menu.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(await menu.getAttribute('aria-keyshortcuts'), null);
    await menu.click();
    const dialog = page.getByRole('dialog', {name:'発表用メニュー', exact:true});
    await dialog.waitFor();
    for (const name of ['通常の発表','発表者ビュー','リハーサル']) await dialog.getByRole('button', {name, exact:true}).waitFor();
    assert.equal(await page.locator('.present-screen,.speaker-screen').count(), 0);
    await page.screenshot({path:'/tmp/slide-studio-presentation-menu.png'});
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'detached'});
    await menu.click();
    await page.getByRole('button', {name:'通常の発表', exact:true}).click();
    await page.frameLocator('.present-screen iframe').locator('.slide.active').first().waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.present-screen').waitFor({state:'detached'});
  });
  await t.test('presenter fits previews and shares player overview navigation', async presenterTest => {
    await page.getByRole('button', {name:'発表用メニュー', exact:true}).click();
    const initialProjection = page.waitForEvent('popup');
    await page.getByRole('button', {name:'発表者ビュー', exact:true}).click();
    const speaker = page.locator('.speaker-screen');
    const current = page.frameLocator('.speaker-current iframe');
    const next = page.frameLocator('.speaker-next iframe');
    await next.locator('.slide.active').waitFor();
    await presenterTest.test('projection handles keys in the window and slide, preserving overview Escape', async () => {
      const openProjection = async () => {
        const opened = page.waitForEvent('popup');
        await speaker.getByRole('button',{name:'投影用ウィンドウを開く',exact:true}).click();
        const popup = await opened;
        popup.setDefaultTimeout(8000);
        await popup.frameLocator('iframe').locator('.slide.active').waitFor();
        await page.locator('.speaker-connection.connected').waitFor({state:'attached',timeout:8000});
        return popup;
      };
      const popup = await initialProjection;
      popup.setDefaultTimeout(8000);
      await popup.frameLocator('iframe').locator('.slide.active').waitFor();
      await page.locator('.speaker-connection.connected').waitFor({state:'attached',timeout:8000});
      const projected = popup.frameLocator('iframe');
      await popup.locator('#projectionFullscreen').focus();
      await popup.keyboard.press('b');
      await projected.locator('#studio-blackout').waitFor({state:'visible'});
      await current.locator('#studio-blackout').waitFor({state:'visible'});
      await speaker.locator('.speaker-header > strong').click();
      await page.keyboard.press('B');
      await current.locator('#studio-blackout').waitFor({state:'hidden'});
      await projected.locator('#studio-blackout').waitFor({state:'hidden'});
      await popup.locator('#projectionFullscreen').focus();
      await popup.keyboard.type('3'); await popup.keyboard.press('Enter');
      await current.locator('.slide.active').filter({hasText:'最後の本文。'}).waitFor();
      await projected.locator('.slide.active').filter({hasText:'最後の本文。'}).waitFor();
      await popup.keyboard.type('1'); await popup.keyboard.press('Enter');
      await current.locator('.slide.active').filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
      await projected.locator('.slide.active').filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
      await popup.keyboard.press('ArrowRight');
      await projected.locator('.slide.active').filter({hasText:'次の本文。'}).waitFor();
      await current.locator('.slide.active').filter({hasText:'次の本文。'}).waitFor({timeout:8000});
      await popup.keyboard.press('ArrowLeft');
      await projected.locator('.slide.active').filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
      await popup.keyboard.press('o');
      await projected.locator('#overview').waitFor({state:'visible'});
      await popup.keyboard.press('Escape');
      await projected.locator('#overview').waitFor({state:'hidden'});
      assert.equal(popup.isClosed(),false);
      await popup.locator('#projectionFullscreen').focus();
      const closed = popup.waitForEvent('close');
      await popup.keyboard.press('Escape'); await closed;
      assert.equal(await speaker.count(),1);
      const reopened = await openProjection();
      // Initial focus goes to the slide; its bridge must handle Escape too.
      await reopened.waitForFunction(() => document.activeElement?.tagName === 'IFRAME');
      const closedAgain = reopened.waitForEvent('close');
      await reopened.keyboard.press('Escape'); await closedAgain;
      assert.equal(await speaker.count(),1);
    });
    const divider = speaker.getByRole('separator', {name:'スライドとメモの幅'});
    assert.equal(await speaker.locator('.speaker-options input[type=range]').count(),1);
    const beforeWidth = (await speaker.locator('.speaker-notepad').boundingBox())!.width;
    const handle = (await divider.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 120, handle.y + handle.height / 2, {steps:8});
    await page.mouse.up();
    assert.ok((await speaker.locator('.speaker-notepad').boundingBox())!.width > beforeWidth + 100);
    assert.equal(await speaker.evaluate(el => el.classList.contains('resizing')),false);
    await divider.focus();
    await page.keyboard.press('End'); assert.equal(await divider.getAttribute('aria-valuenow'),'70');
    await page.keyboard.press('ArrowRight'); assert.equal(await divider.getAttribute('aria-valuenow'),'70');
    await page.keyboard.press('Home'); assert.equal(await divider.getAttribute('aria-valuenow'),'30');
    await page.keyboard.press('ArrowLeft'); assert.equal(await divider.getAttribute('aria-valuenow'),'30');
    await page.keyboard.press('Shift+ArrowRight'); assert.equal(await divider.getAttribute('aria-valuenow'),'35');
    const slideDivider = speaker.getByRole('separator', {name:'現在と次のスライドの比率'});
    const currentBefore = (await speaker.locator('.speaker-current').boundingBox())!.height;
    const nextBefore = (await speaker.locator('.speaker-next').boundingBox())!.height;
    const slideHandle = (await slideDivider.boundingBox())!;
    await page.mouse.move(slideHandle.x + slideHandle.width / 2, slideHandle.y + slideHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(slideHandle.x + slideHandle.width / 2, slideHandle.y + slideHandle.height / 2 - 70, {steps:8});
    await page.mouse.up();
    assert.ok((await speaker.locator('.speaker-current').boundingBox())!.height < currentBefore - 50);
    assert.ok((await speaker.locator('.speaker-next').boundingBox())!.height > nextBefore + 50);
    assert.equal(await speaker.evaluate(el => el.classList.contains('resizing-slides')),false);
    await slideDivider.focus();
    await page.keyboard.press('Home'); assert.equal(await slideDivider.getAttribute('aria-valuenow'),'30');
    await page.keyboard.press('ArrowUp'); assert.equal(await slideDivider.getAttribute('aria-valuenow'),'30');
    await page.keyboard.press('End'); assert.equal(await slideDivider.getAttribute('aria-valuenow'),'70');
    await page.keyboard.press('Shift+ArrowUp'); assert.equal(await slideDivider.getAttribute('aria-valuenow'),'65');
    for (const preview of [current,next]) {
      const fits = await preview.locator('#stage').first().evaluate(stage => {
        const r = stage.getBoundingClientRect();
        return r.width > 100 && r.height > 50 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      });
      assert.ok(fits, 'presenter previews fit their frames');
    }
    // Shortcuts also work while the outer presenter, rather than the iframe, has focus.
    await speaker.locator('.speaker-header > strong').click();
    await page.keyboard.press('o');
    await current.locator('#overview').waitFor({state:'visible'});
    await page.waitForFunction(() => document.querySelector('.speaker-screen')?.classList.contains('overview-open'));
    const overviewFrame = (await speaker.locator('.speaker-current iframe').boundingBox())!;
    assert.ok(overviewFrame.x <= 1 && overviewFrame.y <= 1 && overviewFrame.width >= 1279 && overviewFrame.height >= 859, 'O opens the overview across the presenter window');
    const layout = await current.locator('#overview').evaluate(overview => {
      const cards = [...overview.querySelectorAll('.thumb')].map(el => el.getBoundingClientRect());
      return overview.scrollWidth <= overview.clientWidth + 1 && cards.every((r,i) => cards.slice(i+1).every(q => r.right <= q.left + 1 || q.right <= r.left + 1 || r.bottom <= q.top + 1 || q.bottom <= r.top + 1));
  });
    assert.ok(layout, 'overview cards neither overlap nor overflow horizontally');
    const cards = await current.locator('.thumb').evaluateAll(elements => elements.map(el => {
      const {x,y,width} = el.getBoundingClientRect(); return {x,y,width};
    }));
    assert.ok(cards.every(card => card.width <= 220), 'overview keeps thumbnails small');
    assert.ok(cards[0] && cards[1]);
    assert.ok(cards[1].x > cards[0].x && Math.abs(cards[1].y - cards[0].y) < 1, 'narrow presenter overview still has multiple columns');
    assert.equal(await current.locator('#help, .thumb-caption, #overview > h2').count(),0);
    assert.equal(await current.locator('#close').innerText(),'');
    assert.equal(await current.locator('#close svg').count(),1);
    await current.getByText('Esc',{exact:true}).waitFor();
    assert.ok(await current.locator('.thumb').first().evaluate(button => {
      const r = button.getBoundingClientRect(), view = button.querySelector('.thumb-view')!.getBoundingClientRect();
      return Math.abs(r.width / r.height - 16/9) < .01 && Math.abs(r.height - view.height) < 1 && getComputedStyle(button).borderTopWidth === '0px';
    }));
    await page.screenshot({path:'/tmp/slide-studio-desktop/presenter-overview-clean.png'});

    await current.locator('.thumb[data-index="1"]').click();
    await page.waitForFunction(() => !document.querySelector('.speaker-screen')?.classList.contains('overview-open'));
    await current.locator('.slide.active').first().filter({hasText:'次の本文。'}).waitFor();
    await next.locator('.slide.active').filter({hasText:'最後の本文。'}).waitFor();
    await page.keyboard.press('o');
    await current.locator('#overview').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await current.locator('#overview').waitFor({state:'hidden'});
    assert.equal(await speaker.count(),1);
    await page.keyboard.press('ArrowUp');
    await current.locator('.slide.active').first().filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
    await page.keyboard.press('Escape');
    await speaker.waitFor({state:'detached'});
    await page.getByRole('button', {name:'発表用メニュー', exact:true}).click();
    const recordRequests: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/rehearsals')) recordRequests.push(request.method()); });
    await page.getByRole('button', {name:'リハーサル', exact:true}).click();
    await speaker.locator('.speaker-next iframe').waitFor();
    assert.equal(await speaker.getByRole('separator', {name:'スライドとメモの幅'}).getAttribute('aria-valuenow'),'35');
    await speaker.locator('.speaker-controls > summary').click();
    assert.equal(await speaker.getByRole('button',{name:'練習記録',exact:true}).count(),0);
    await speaker.getByRole('button',{name:'計測開始',exact:true}).click();
    await speaker.locator('.speaker-elapsed').filter({hasText:'0:01'}).waitFor();
    await speaker.getByRole('button',{name:'終了',exact:true}).click();
    await speaker.waitFor({state:'detached'});
    const result = page.getByRole('dialog',{name:'リハーサルの結果',exact:true});
    await result.waitFor();
    await result.getByText('前回の記録はありません',{exact:true}).waitFor();
    assert.equal(await result.locator('tbody tr').count(),4);
    await page.screenshot({path:'/tmp/slide-studio-rehearsal-result.png'});
    assert.equal(await result.getByText('未訪問',{exact:true}).count(),2);
    const saved = JSON.parse(await readFile(join(ws.deck_dir('talk'),'rehearsals.json'),'utf8'));
    assert.ok(saved.elapsed >= 1000);
    await result.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.reload();
    await page.getByRole('button',{name:'発表用メニュー',exact:true}).click();
    await page.getByRole('button',{name:'リハーサル',exact:true}).click();
    await speaker.locator('.speaker-next iframe').waitFor();
    await speaker.getByRole('button',{name:'計測開始',exact:true}).click();
    await speaker.locator('.speaker-elapsed').filter({hasText:'0:01'}).waitFor();
    await speaker.getByRole('button',{name:'終了',exact:true}).focus();
    await page.keyboard.press('Enter');
    await result.waitFor();
    assert.equal(await result.getByText('前回の記録はありません',{exact:true}).count(),0);
    assert.ok((await result.locator('tbody tr').first().innerText()).includes('0:01'));
    await result.getByRole('button',{name:'閉じる',exact:true}).click();
    assert.deepEqual(recordRequests,['PUT','PUT']);
    assert.deepEqual(errors, []);
  });
  await t.test('normal presentation uses slide-only overview and icon close', async () => {
    await page.getByRole('button',{name:'今のページから',exact:true}).click();
    const normal = page.frameLocator('.present-screen iframe');
    await normal.locator('.slide.active').waitFor();
    const footer = normal.locator('#toolbar');
    assert.equal(await footer.evaluate(el => getComputedStyle(el).opacity), '0');
    const viewport = page.viewportSize()!;
    await page.mouse.move(viewport.width / 2, viewport.height - 12);
    await page.waitForTimeout(180);
    assert.equal(await footer.evaluate(el => getComputedStyle(el).opacity), '1');
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.waitForTimeout(180);
    assert.equal(await footer.evaluate(el => getComputedStyle(el).opacity), '0');
    await page.mouse.move(viewport.width / 2, viewport.height - 12);
    await page.waitForTimeout(180);
    await footer.getByText('Escで戻る', {exact:true}).waitFor();
    await footer.getByRole('progressbar').waitFor();
    assert.equal(await footer.locator('button').count(), 2);
    assert.equal(await footer.locator('.presentation-pages').innerText(), '1 / 3');
    await normal.locator('body').press('ArrowDown');
    await footer.getByText('2 / 3', {exact:true}).waitFor();
    assert.equal(await footer.getByRole('progressbar').getAttribute('aria-valuenow'), '67');
    await page.screenshot({path:'/tmp/slide-studio-desktop/presentation-footer.png'});
    await footer.getByRole('button', {name:'スライド一覧',exact:true}).click();
    await normal.locator('#overview').waitFor({state:'visible'});
    await normal.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.locator('.present-screen iframe').focus();
    await page.keyboard.press('o');
    await normal.locator('#overview').waitFor({state:'visible'});
    assert.equal(await normal.locator('#help, .thumb-caption, #overview > h2').count(),0);
    assert.equal(await normal.locator('#close').innerText(),'');
    await normal.getByText('Esc',{exact:true}).waitFor();
    await page.screenshot({path:'/tmp/slide-studio-desktop/normal-overview-clean.png'});
    await normal.getByRole('button',{name:'閉じる',exact:true}).click();
    await normal.locator('#overview').waitFor({state:'hidden'});
    await page.keyboard.press('o');
    await normal.locator('#overview').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await normal.locator('#overview').waitFor({state:'hidden'});
    assert.equal(await page.locator('.present-screen').count(),1);
    await page.keyboard.press('Escape');
    await page.locator('.present-screen').waitFor({state:'detached'});
  });
  await t.test('page menus duplicate from overview and toggle skip without deleting source', async () => {
    const before = await readFile(ws.qmd('talk'), 'utf8');
    const waitText = async (check: (text: string) => boolean) => {
      for (let i = 0; i < 100; i++) { if (check(await readFile(ws.qmd('talk'), 'utf8'))) return; await page.waitForTimeout(50); }
      assert.ok(check(await readFile(ws.qmd('talk'), 'utf8')));
    };
    try {
      await page.locator('#pagestrip button[data-index="0"] .page-actions-trigger').click();
      await page.screenshot({path:'/tmp/slide-studio-page-actions.png'});
      await page.getByRole('button', {name: '発表・PDFから外す', exact:true}).click();
      await waitText(text => text.includes('.studio-skip'));
      await frame.locator('.slide.studio-skip').waitFor({state:'attached'});
      await page.locator('#pagestrip .page-skip-label').waitFor();
      await page.getByRole('button',{name:'発表用メニュー',exact:true}).click();
      await page.getByRole('button',{name:'通常の発表',exact:true}).click();
      const skippedPresentation = page.frameLocator('.present-screen iframe');
      await skippedPresentation.locator('.slide.active[data-page="1"]').waitFor();
      assert.equal(await skippedPresentation.locator('#toolbar .presentation-pages').innerText(), '1 / 2');
      await skippedPresentation.locator('body').press('ArrowUp');
      await skippedPresentation.locator('.slide.active[data-page="1"]').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.present-screen').waitFor({state:'detached'});
      await page.getByRole('button', {name:'書き出し',exact:true}).click();
      const pdfDownload = page.waitForEvent('download');
      await page.locator('.output-popover [data-format=pdf]').click();
      const pdfPath = join(temp, 'skip.pdf'); await (await pdfDownload).saveAs(pdfPath);
      assert.equal((await PDFDocument.load(await readFile(pdfPath))).getPageCount(), 2);
      await page.keyboard.press('Escape');
      await page.locator('#pagestrip button[data-index="0"]').click({button:'right'});
      await page.getByRole('button', {name: '発表・PDFに戻す', exact:true}).click();
      await waitText(text => !text.includes('.studio-skip'));
      await page.locator('#pagestrip .page-skip-label').waitFor({state:'detached'});
      await page.locator('#pagestrip button[data-index="0"]').focus();
      await page.keyboard.press('o');
      await page.locator('.overview-screen button[data-index="0"] .page-actions-trigger').click();
      await page.getByRole('button', {name: 'ページを複製', exact:true}).click();
      await waitText(text => text.includes('#intro-copy-1'));
      await page.locator('#pagestrip button[data-index="3"]').waitFor();
      assert.equal((await readFile(ws.qmd('talk'), 'utf8')).split('Chromeで編集して保存した本文').length - 1, 2);
      await page.keyboard.press('Escape');
    } finally {
      await page.keyboard.press('Escape');
      await writeFile(ws.qmd('talk'), before);
      await page.reload(); await page.locator('#stage[data-blocks=ready]').waitFor();
    }
  });
  await t.test('manuscript replacement and preview block context menu share editor undo', async () => {
    const before = await readFile(ws.qmd('talk'), 'utf8');
    const waitText = async (check: (text: string) => boolean) => {
      for (let i=0; i<100; i++) { if (check(await readFile(ws.qmd('talk'),'utf8'))) return; await page.waitForTimeout(50); }
      assert.ok(check(await readFile(ws.qmd('talk'),'utf8')));
    };
    const searchTrigger = page.getByRole('button',{name:'原稿全体を検索・置換',exact:true});
    await page.evaluate(() => document.body.classList.remove('editor-off'));
    assert.equal(await searchTrigger.evaluate(el => el.nextElementSibling?.id), 'foldToggle');
    await searchTrigger.click();
    const anchor = (await searchTrigger.boundingBox())!, popup = (await page.locator('.manuscript-search').boundingBox())!;
    assert.ok(Math.abs(popup.y - anchor.y - anchor.height - 8) <= 1);
    assert.ok(anchor.x >= popup.x && anchor.x + anchor.width <= popup.x + popup.width + 1);
    assert.ok(popup.width <= 360);
    await page.screenshot({path:'/tmp/slide-studio-search-anchored.png'});
    await page.keyboard.press('Escape');
    await page.locator('.manuscript-search').waitFor({state:'hidden'});
    await searchTrigger.click();
    await page.getByRole('searchbox',{name:'検索する文字列',exact:true}).fill('本文');
    assert.ok(await page.locator('.search-result').count() >= 3);
    await page.locator('.search-result').last().click();
    await page.getByRole('textbox',{name:'置換後の文字列',exact:true}).fill('テスト用語');
    await page.getByRole('button',{name:'すべて置換',exact:true}).click();
    await waitText(text=>text.includes('テスト用語')&&!text.includes('本文'));
    await page.getByRole('button',{name:'検索を閉じる',exact:true}).click();
    await page.locator('#undo').click(); await waitText(text=>text===before);
    await page.locator('#pagestrip button[data-index="0"]').click();
    const block = frame.locator('.slide.active [data-slide-studio]').filter({hasText:'Chromeで編集して保存した本文。'});
    await block.click({button:'right'});
    await page.getByRole('menuitem',{name:'複製',exact:true}).click();
    await waitText(text=>text.split('Chromeで編集して保存した本文。').length===3);
    await page.locator('#undo').click(); await waitText(text=>text===before);
  });
  await page.getByRole('button', {name: '書き出し', exact: true}).click();
  const download = page.waitForEvent('download');
  await page.locator('.output-popover [data-format=html]').click();
  const saved = join(temp, 'export.html'); await (await download).saveAs(saved);
  assert.match(await readFile(saved, 'utf8'), /Chromeで編集して保存した本文/);
  await page.screenshot({path: '/tmp/slide-studio-desktop/browser-original-ui.png'});
  assert.deepEqual(errors, []);
});

test('headless home sorts slides beside its heading and restores every trash kind after reload', {timeout:30000,skip:!existsSync(chrome)}, async t=>{
  const {startLegacyHost}=await import('../../apps/server/index.js');
  const {remove}=await import('../../packages/core/src/deck-manage.js');
  const temp=await mkdtemp(join(tmpdir(),'studio-home-browser-')),ws=Workspace.open(join(temp,'ws'));
  ws.new_deck('alpha','research','default',null,'Alpha');ws.new_deck('beta','work','default',null,'Beta');ws.new_deck('deleted','research','default',null,'復元する発表');
  await remove(ws,'deleted');ws.register_theme('custom','body { color:red }');ws.remove_theme('custom');ws.new_topic('unused');ws.remove_topic('unused');
  const host=await startLegacyHost({workspace:ws,uiDirectory:join(process.cwd(),'dist/packages/web'),watch:false,pandocPath:'/unused',renderText:async()=>{throw Error('Home must not render a presentation');}});
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  t.after(async()=>{await browser.close();await host.close();await rm(temp,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${host.adminOrigin}/#token=${host.token}`);
  await page.locator('.cards .card').first().waitFor();
  // The fixture contains untouched slides; they must not hide the creation button.
  const create=page.getByRole('button',{name:'新しい発表',exact:true});
  assert.ok(await create.isVisible());
  await create.click();
  const createDialog=page.getByRole('dialog',{name:'新しい発表',exact:true});
  await createDialog.waitFor();
  await createDialog.getByRole('button',{name:'閉じる',exact:true}).click();
  assert.equal(await page.locator('[data-home-search]').count(),0);
  const heading=page.getByRole('heading',{name:'スライド',exact:true});
  const sort=page.getByRole('button',{name:'スライドの並び順',exact:true});
  for (const width of [390,1440]) {
    await page.setViewportSize({width,height:900});
    const h=await heading.boundingBox(),b=await sort.boundingBox();assert.ok(h&&b);
    assert.ok(b.x>=h.x+h.width && b.x-h.x-h.width<12);
    assert.ok(Math.abs(b.y+b.height/2-h.y-h.height/2)<2);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await page.emulateMedia({colorScheme:'dark'});
  await sort.click();await page.getByRole('menuitemradio',{name:'タイトル順',exact:true}).click();
  assert.match(await page.locator('.cards .card').first().innerText(),/Alpha/);
  await page.screenshot({path:'/tmp/slide-studio-home-heading-sort.png'});
  await page.reload();await page.getByRole('button',{name:'ごみ箱',exact:true}).click();
  const trash=page.getByRole('dialog',{name:'ごみ箱',exact:true});await trash.locator('li').first().waitFor();assert.equal(await trash.locator('li').count(),3);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const restore=async(name:string)=>{const row=trash.locator('li').filter({hasText:name});await row.getByRole('button',{name:'復元',exact:true}).click();await row.waitFor({state:'detached'});};
  await restore('復元する発表');await restore('custom');await restore('unused');await trash.getByText('ごみ箱は空です',{exact:true}).waitFor();
  await trash.getByRole('button',{name:'閉じる',exact:true}).click();await page.locator('.deck-card-wrap[data-deck=deleted]').waitFor();
  assert.ok(ws.has_deck('deleted')&&ws.themes_list().includes('custom')&&ws.shelves().includes('unused'));assert.deepEqual(errors,[]);
});
