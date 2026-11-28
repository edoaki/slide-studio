import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  await t.test('manual update notifications persist across settings tabs', async () => {
    let state = { version: '0.1.0', availableVersion: '0.2.0', phase: 'available' };
    const actions: string[] = [];
    await page.route('**/api/updates', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON(); actions.push(body.action);
      }
      await route.fulfill({ json: state });
    });
    await page.locator('[data-open-settings] .update-dot').waitFor({state: 'visible'});
    await page.getByRole('button', {name: '設定', exact: true}).click();
    const dialog = page.locator('.settings-dialog'), panel = dialog.locator('.home-updates');
    await panel.getByText('バージョン 0.2.0 に更新できます。').waitFor();
    assert.equal(await panel.locator('input').count(), 0);
    assert.equal(await panel.getByRole('link', {name: 'ダウンロードページを開く'}).getAttribute('href'), 'https://github.com/edoaki/slide-studio/releases');
    await dialog.locator('[data-tab=appearance]').click();
    assert.equal(await dialog.locator('[data-tab=general] .update-badge').isVisible(), true);
    await dialog.locator('[data-tab=general]').click();
    state.phase = 'error';
    await panel.getByText('更新を確認できませんでした。時間をおいて「更新を確認」を押してください。').waitFor();
    assert.equal(await dialog.locator('.update-badge').isVisible(), true);
    await panel.getByRole('button', {name: '更新を確認', exact: true}).click();
    assert.deepEqual(actions, ['check']);
    state = { ...state, phase: 'current', availableVersion: '' };
    await panel.getByText('最新のバージョンです。').waitFor();
    assert.equal(await dialog.locator('.update-badge').isVisible(), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-open-settings] .update-dot').isVisible(), false);
    await page.unroute('**/api/updates');
  });
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
  await t.test('panel splitters resize from the keyboard and never squeeze the slide', async () => {
    const splitter = page.locator('#splitter'), chatSplitter = page.locator('#chatSplitter');
    const width = (selector: string) => page.locator(selector).evaluate(e => Math.round(e.getBoundingClientRect().width));
    const before = await width('#editor'), chatBefore = await width('#chat');
    assert.equal(await splitter.getAttribute('aria-valuenow'), String(before));
    await splitter.focus();
    await page.keyboard.press('ArrowRight'); assert.equal(await width('#editor'), before + 16);
    await page.keyboard.press('Shift+ArrowLeft'); assert.equal(await width('#editor'), before - 48);
    await page.keyboard.press('Home'); assert.equal(await width('#editor'), Number(await splitter.getAttribute('aria-valuemin')));
    await page.keyboard.press('End'); assert.equal(await width('#editor'), Number(await splitter.getAttribute('aria-valuemax')));
    assert.equal(await splitter.getAttribute('aria-valuenow'), String(await width('#editor')));
    await page.keyboard.press('Home');
    for (let i = 0; i < (before - 260) / 16; i++) await page.keyboard.press('ArrowRight');
    assert.equal(await width('#editor'), before);
    // The chat splitter grows the chat toward the left.
    await chatSplitter.focus();
    await page.keyboard.press('ArrowLeft'); assert.equal(await width('#chat'), chatBefore + 16);
    await page.keyboard.press('ArrowRight'); assert.equal(await width('#chat'), chatBefore);
    // Narrow windows shrink the side panels instead of the slide, and the preferred widths come back.
    try {
      for (const viewport of [900, 1600, 1280]) {
        await page.setViewportSize({width: viewport, height: 860});
        await page.waitForFunction(w => innerWidth === w, viewport);
        // The resize event is handled on a later frame, so wait for the panels to be refitted.
        await page.waitForFunction(() => document.querySelector('#stage')!.getBoundingClientRect().width >= 330, undefined, {timeout: 3000}).catch(() => {});
        assert.ok(await width('#stage') >= 330, `slide column at ${viewport}px`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    } finally {
      await page.setViewportSize({width: 1280, height: 860});
    }
    assert.equal(await width('#editor'), before); assert.equal(await width('#chat'), chatBefore);
  });
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
    const position = page.getByRole('combobox', {name: 'ページ番号の位置', exact: true});
    const size = page.getByLabel('ページ番号の文字サイズ（px）', {exact: true});
    const format = page.getByRole('combobox', {name: 'ページ番号の表記', exact: true});
    const choose = async (combo: typeof position, value: string) => { await combo.click(); await page.locator(`.ss-list:popover-open [role=option][data-value="${value}"]`).click(); assert.equal(await combo.getAttribute('aria-expanded'), 'false'); };
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
      await choose(position, value);
      await check({left: value === 'bottom-left' ? '30px' : 'auto', right: value === 'bottom-left' ? 'auto' : '30px', top: value === 'top-right' ? '24px' : 'auto', bottom: value === 'top-right' ? 'auto' : '24px'});
    }
    await size.fill('28'); await size.press('Tab');
    await choose(format, 'number');
    await waitStyle(number, {'font-size': '28px'});
    await waitStyle(number.locator('.page-number-total'), {display: 'none'});
    await choose(format, 'hidden');
    await frame.locator('.slide.active .page-number').waitFor({state: 'hidden'});
    await choose(format, 'total');
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
        await padding.fill(value); await padding.press(value === '4' ? 'Tab' : 'Enter');
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
  await t.test('page toolbar offers deletion and overview', async () => {
    assert.deepEqual(await page.locator('#stripTools > button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label'))), ['ページを削除', '一覧を表示']);
    await page.getByRole('button',{name:'一覧を表示',exact:true}).click();
    await page.locator('.overview-screen .pagestrip button[data-index]').first().waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.overview-screen').waitFor({state:'detached'});
  });
  await t.test('switching to the global speaker note puts the caret in the textarea', async () => {
    const panel = page.locator('.speaker-notes');
    await panel.locator('summary').click();
    await panel.getByRole('button', {name: '全体', exact: true}).click();
    await page.waitForFunction(() => {
      const field = document.querySelector<HTMLTextAreaElement>('.speaker-notes textarea[aria-label="全体"]');
      return field && document.activeElement === field && field.selectionStart === field.value.length && field.selectionEnd === field.value.length;
    }, undefined, {timeout: 5000});
    await page.keyboard.press('Escape');
    await panel.locator('textarea').waitFor({state: 'hidden'});
  });
  await t.test('presenter button uses an accessible icon and has no menu', async () => {
    const presenter = page.getByRole('button', {name:'発表者ビュー', exact:true});
    assert.equal(await presenter.innerText(), '');
    assert.ok((await presenter.boundingBox())!.width <= 48);
    assert.equal(await page.locator('#chat [data-act=hist]').first().innerText(), '');
    assert.equal(await presenter.getAttribute('aria-haspopup'), null);
    assert.equal(await presenter.getAttribute('aria-keyshortcuts'), null);
    assert.equal(await page.getByRole('button', {name:'発表用メニュー', exact:true}).count(), 0);
    await page.getByRole('button', {name:'今のページから', exact:true}).click();
    await page.frameLocator('.present-screen iframe').locator('.slide.active').first().waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.present-screen').waitFor({state:'detached'});
  });
  await t.test('presenter fits previews and shares player overview navigation', async presenterTest => {
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
      // While open, the button brings the window to front instead of opening another one.
      const focusProjection = speaker.getByRole('button',{name:'投影用ウィンドウを前面に表示',exact:true});
      await focusProjection.waitFor();
      assert.equal(await focusProjection.evaluate(e => e.classList.contains('active')),true);
      let extraPopups = 0; const countPopup = () => { extraPopups++; };
      page.on('popup',countPopup); await focusProjection.click(); await page.waitForTimeout(300); page.off('popup',countPopup);
      assert.equal(extraPopups,0); assert.equal(popup.isClosed(),false);
      // The cursor over the current slide appears as a pointer on the projection.
      const currentBox = (await page.locator('.speaker-current iframe').boundingBox())!;
      await page.mouse.move(currentBox.x + currentBox.width / 2,currentBox.y + currentBox.height / 2);
      await popup.locator('.projection-pointer[data-style=dot]').waitFor({state:'visible'});
      // The presenter sees the same pointer over the current slide, and the header button shows it is on.
      await page.locator('.speaker-pointer[data-style=dot]').waitFor({state:'visible'});
      const pointerSwitch = speaker.getByRole('switch',{name:'ポインター',exact:true});
      assert.equal(await pointerSwitch.getAttribute('aria-checked'),'true');
      await page.mouse.move(currentBox.x + currentBox.width / 2,currentBox.y - 40);
      await popup.locator('.projection-pointer').waitFor({state:'hidden'});
      await page.locator('.speaker-pointer').waitFor({state:'hidden'});
      // Switched off, the cursor is no longer projected.
      await pointerSwitch.click(); assert.equal(await pointerSwitch.getAttribute('aria-checked'),'false');
      await page.mouse.move(currentBox.x + currentBox.width / 2,currentBox.y + currentBox.height / 2);
      await page.waitForTimeout(200); assert.equal(await popup.locator('.projection-pointer').isHidden(),true);
      await pointerSwitch.click(); assert.equal(await pointerSwitch.getAttribute('aria-checked'),'true');
      await page.mouse.move(currentBox.x + currentBox.width / 2,currentBox.y - 40);
      const projected = popup.frameLocator('iframe');
      // 投影用ウィンドウで押した数字は、投影に出さず発表者ビューのページ番号の欄へ入る
      const pageJumpField = speaker.locator('.speaker-footer').getByRole('textbox',{name:'移動するページ番号',exact:true});
      await popup.locator('#projectionFullscreen').focus();
      await popup.keyboard.type('3');
      await page.waitForFunction(() => document.activeElement?.matches('.speaker-footer .speaker-number') && (document.activeElement as HTMLInputElement).value === '3');
      assert.equal(await projected.locator('#studio-page-entry').isVisible(),false);
      await popup.keyboard.press('Enter');
      await current.locator('.slide.active').filter({hasText:'最後の本文。'}).waitFor();
      await projected.locator('.slide.active').filter({hasText:'最後の本文。'}).waitFor();
      assert.equal(await pageJumpField.inputValue(),'3');
      await popup.frameLocator('iframe').locator('body').evaluate(() => window.focus());
      await popup.keyboard.type('1'); await popup.keyboard.press('Enter');
      await current.locator('.slide.active').filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
      await projected.locator('.slide.active').filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
      assert.equal(await projected.locator('#studio-page-entry').isVisible(),false);
      await popup.keyboard.press('ArrowRight');
      await projected.locator('.slide.active').filter({hasText:'次の本文。'}).waitFor();
      await current.locator('.slide.active').filter({hasText:'次の本文。'}).waitFor({timeout:8000});
      await popup.keyboard.press('ArrowLeft');
      await projected.locator('.slide.active').filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
      // 投影用ウィンドウで O を押しても、一覧は発表者ビューに出す（投影には出さない）
      await popup.keyboard.press('o');
      await current.locator('#overview').waitFor({state:'visible'});
      assert.equal(await projected.locator('#overview').isVisible(),false);
      await popup.keyboard.press('o');
      await current.locator('#overview').waitFor({state:'hidden'});
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
    // 設定やキー一覧のポップオーバーは置かず、時間と進捗を押してその場で変える
    assert.equal(await speaker.locator('details,.speaker-keylist').count(),0);
    // 大きい時間表示を押すと持ち時間（分・秒）を打ち込める。Enter で決め、Esc で取り消す
    const timer = speaker.locator('.speaker-timer'), durationInput = speaker.getByRole('textbox',{name:'持ち時間（分）',exact:true});
    const secondsInput = speaker.getByRole('textbox',{name:'持ち時間（秒）',exact:true});
    assert.equal(await timer.getAttribute('data-tip'),'押して持ち時間（分・秒）を入力');
    await timer.click(); await durationInput.waitFor();
    assert.equal(await durationInput.inputValue(),'20'); assert.equal(await secondsInput.inputValue(),'00');
    // 分の欄から秒の欄へ移っても閉じず、秒まで決められる
    await durationInput.fill('５'); await secondsInput.click(); assert.equal(await durationInput.isVisible(),true);
    await secondsInput.fill('30'); await secondsInput.press('Enter');
    await timer.filter({hasText:/^残り 5:30$/}).waitFor();
    await timer.click(); await durationInput.waitFor(); assert.equal(await secondsInput.inputValue(),'30');
    await secondsInput.fill('0'); await secondsInput.press('Enter');
    await timer.filter({hasText:/^残り 5:00$/}).waitFor();
    await timer.click(); await durationInput.fill('9'); await durationInput.press('Escape');
    await timer.filter({hasText:/^残り 5:00$/}).waitFor();
    assert.equal(await speaker.count(),1,'Escape in the duration field does not end the presentation');
    await timer.click(); await durationInput.fill('20'); await durationInput.press('Enter');
    await timer.filter({hasText:/^残り 20:00$/}).waitFor();
    // 進捗を押すと、数えるページ数の入力欄とページの一覧が出る。一覧で押したページまでを数える
    const progressButton = speaker.locator('.speaker-progress'), countPanel = speaker.getByRole('dialog',{name:'進捗に数えるページ',exact:true});
    assert.equal(await progressButton.innerText(),'進捗 1 / 3');
    await progressButton.click(); await countPanel.waitFor();
    const countInput = countPanel.getByRole('textbox',{name:'数えるページ数',exact:true});
    assert.equal(await countInput.inputValue(),'3');
    assert.deepEqual(await countPanel.locator('button.speaker-count-page .speaker-count-title').allTextContents(),['本文','次のページ','最後のページ']);
    await countPanel.getByRole('button',{name:/次のページ/}).click();
    await countPanel.waitFor({state:'hidden'});
    assert.equal(await progressButton.innerText(),'進捗 1 / 2');
    await progressButton.click(); await countInput.fill('1');
    assert.equal(await progressButton.innerText(),'進捗 1 / 1');
    await countInput.press('Escape'); await countPanel.waitFor({state:'hidden'});
    assert.equal(await speaker.count(),1);
    await progressButton.click(); await countInput.fill('3'); await countInput.press('Enter');
    assert.equal(await progressButton.innerText(),'進捗 1 / 3');
    // 右上の < > は段階ごとに進む・戻る。段階のないページでは << >> を出さない
    for (const [name,tip] of [['戻る','1つ戻る'],['進む','1つ進む']]) assert.equal(await speaker.getByRole('button',{name,exact:true}).getAttribute('data-tip'),tip);
    assert.equal(await speaker.getByRole('button',{name:'次のページ',exact:true}).isVisible(),false);
    // Hovering the pointer button shows them below it; they stay usable while the pointer is off.
    const pointerSwitch = speaker.getByRole('switch',{name:'ポインター',exact:true});
    const pointerPanel = speaker.locator('.speaker-pointer-panel');
    assert.equal(await pointerPanel.isVisible(),false);
    await pointerSwitch.click(); assert.equal(await pointerSwitch.getAttribute('aria-checked'),'false');
    await pointerSwitch.hover(); await pointerPanel.waitFor({state:'visible'});
    assert.ok((await pointerPanel.boundingBox())!.y >= (await pointerSwitch.boundingBox())!.y + 32,'pointer choices appear below the button');
    for (const name of ['ポインターの形','ポインターの色','ポインターの大きさ']) await pointerPanel.getByRole('radiogroup',{name,exact:true}).waitFor();
    assert.deepEqual(await pointerPanel.getByRole('radiogroup',{name:'ポインターの形',exact:true}).getByRole('radio').allTextContents(),['点','光','マーカー']);
    await pointerPanel.getByRole('radio',{name:'マーカー',exact:true}).click();
    assert.equal(await pointerPanel.getByRole('radio',{name:'マーカー',exact:true}).getAttribute('aria-checked'),'true');
    assert.equal(await pointerSwitch.locator('.speaker-pointer-swatch').getAttribute('data-style'),'highlight');
    await pointerPanel.getByRole('radio',{name:'点',exact:true}).click();
    const panelBox = (await pointerPanel.boundingBox())!;
    for (const group of await pointerPanel.locator('.ss-seg').all()) {
      const box = (await group.boundingBox())!;
      assert.ok(box.x >= panelBox.x && box.x + box.width <= panelBox.x + panelBox.width + 0.5,'pointer choices fit the panel');
    }
    await pointerSwitch.click(); assert.equal(await pointerSwitch.getAttribute('aria-checked'),'true');
    await speaker.locator('.speaker-header > strong').hover();
    await pointerPanel.waitFor({state:'hidden'});
    // 現在のスライドの操作バーはスライドに重ねず、スライドの外の下に常に出す
    assert.equal(await current.locator('#toolbar').isVisible(),false);
    const footerBar = speaker.locator('.speaker-footer');
    const [slideBox, barBox] = await Promise.all([page.locator('.speaker-current iframe').boundingBox(),footerBar.boundingBox()]);
    assert.ok(slideBox && barBox && barBox.y >= slideBox.y + slideBox.height,'the presenter footer sits below the slide');
    const overviewButton = footerBar.getByRole('button',{name:'スライド一覧',exact:true});
    assert.equal(await overviewButton.getAttribute('data-keys'),'O');
    assert.equal(await footerBar.getByRole('button',{name:'全画面',exact:true}).getAttribute('data-keys'),'F');
    // 一覧の横のページ番号の入力欄から、番号を入れて Enter でそのページへ移る
    const pageJump = footerBar.getByRole('textbox',{name:'移動するページ番号',exact:true});
    assert.equal(await footerBar.locator('.speaker-footer-total').innerText(),'/ 3');
    // 全角の数字は半角に直す
    await pageJump.fill('２'); assert.equal(await pageJump.inputValue(),'2');
    await pageJump.press('Escape');
    // スライドの上で数字を押すと、スライドに番号を重ねず、この欄に入る
    await page.locator('.speaker-current iframe').focus();
    await page.keyboard.type('3');
    await page.waitForFunction(() => document.activeElement?.matches('.speaker-footer .speaker-number') && (document.activeElement as HTMLInputElement).value === '3');
    assert.equal(await current.locator('#studio-page-entry').isVisible(),false);
    await page.keyboard.press('Enter');
    await current.locator('main#stage > .slide.active').filter({hasText:'最後の本文。'}).waitFor();
    await pageJump.fill('1'); await pageJump.press('Enter');
    await current.locator('main#stage > .slide.active').filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
    await pageJump.fill('3'); await pageJump.press('Enter');
    await current.locator('main#stage > .slide.active').filter({hasText:'最後の本文。'}).waitFor();
    assert.equal(await pageJump.inputValue(),'3');
    await pageJump.fill('9'); await pageJump.press('Enter');
    assert.equal(await pageJump.inputValue(),'3');
    await pageJump.press('Escape');
    assert.equal(await speaker.count(),1);
    await pageJump.fill('1'); await pageJump.press('Enter');
    await current.locator('main#stage > .slide.active').filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
    await overviewButton.click();
    await current.locator('#overview').waitFor({state:'visible'});
    // 一覧はスライドを発表者ビュー全体に広げるため、その間は操作バーを隠す
    await footerBar.waitFor({state:'hidden'});
    await page.keyboard.press('Escape');
    await current.locator('#overview').waitFor({state:'hidden'});
    await footerBar.waitFor({state:'visible'});
    assert.equal(await speaker.count(),1);
    // メモは上にページ、下に全体。文字サイズはメモの見出しで変え、次に開いたときも保つ
    const pageNote = speaker.locator('.speaker-note-page textarea'), globalNote = speaker.locator('.speaker-note-global textarea');
    const [pageBox, globalBox] = await Promise.all([pageNote.boundingBox(),globalNote.boundingBox()]);
    assert.ok(pageBox && globalBox && pageBox.y + pageBox.height <= globalBox.y);
    const fontValue = speaker.locator('.speaker-font-value');
    assert.equal(await fontValue.innerText(),'20');
    await speaker.getByRole('button',{name:'文字を大きく',exact:true}).click();
    await speaker.getByRole('button',{name:'文字を大きく',exact:true}).click();
    assert.equal(await fontValue.innerText(),'24');
    assert.equal(await pageNote.evaluate(el => getComputedStyle(el).fontSize),'24px');
    assert.equal(await globalNote.evaluate(el => getComputedStyle(el).fontSize),'24px');
    const noteDivider = speaker.getByRole('separator', {name:'ページのメモと全体のメモの比率'});
    assert.equal(await noteDivider.getAttribute('aria-orientation'),'horizontal');
    await noteDivider.focus();
    await page.keyboard.press('Home'); assert.equal(await noteDivider.getAttribute('aria-valuenow'),'15');
    await page.keyboard.press('Shift+ArrowDown'); assert.equal(await noteDivider.getAttribute('aria-valuenow'),'20');
    // 小さい方の時間を押すと、経過時間を大きく表示する
    assert.match(await speaker.locator('.speaker-timer').innerText(),/^残り /);
    await speaker.locator('.speaker-elapsed').click();
    assert.match(await speaker.locator('.speaker-timer').innerText(),/^経過 /);
    assert.match(await speaker.locator('.speaker-elapsed').innerText(),/残り /);
    assert.ok(parseFloat(await speaker.locator('.speaker-elapsed').evaluate(el => getComputedStyle(el).fontSize)) >= 15);
    await speaker.locator('.speaker-elapsed').click();
    assert.match(await speaker.locator('.speaker-timer').innerText(),/^残り /);
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
    await page.keyboard.press('End'); assert.equal(await slideDivider.getAttribute('aria-valuenow'),'85');
    await page.keyboard.press('Shift+ArrowUp'); assert.equal(await slideDivider.getAttribute('aria-valuenow'),'80');
    // 次のスライドは見出しで折りたたみ、現在のスライドが高さを使う
    const nextToggle = speaker.locator('.speaker-next-toggle');
    const currentOpen = (await speaker.locator('.speaker-current').boundingBox())!.height;
    await nextToggle.click();
    assert.equal(await nextToggle.getAttribute('aria-expanded'),'false');
    assert.equal(await speaker.locator('.speaker-next iframe').isVisible(),false);
    assert.equal(await slideDivider.isVisible(),false);
    assert.ok((await speaker.locator('.speaker-current').boundingBox())!.height > currentOpen + 50);
    await nextToggle.click();
    assert.equal(await nextToggle.getAttribute('aria-expanded'),'true');
    assert.equal(await speaker.locator('.speaker-next iframe').isVisible(),true);
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
    // 発表者ビュー全体に広げた一覧では、ページの中身が読める大きさで並べる（幅 1280 で 4 列ほど）
    assert.ok(cards.every(card => card.width >= 240 && card.width <= 400), `overview thumbnails are large enough to read: ${cards.map(card => Math.round(card.width)).join(',')}`);
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
    // Reopened, the presenter view keeps the pane sizes and the note font size; the timer runs and nothing is recorded.
    const reopened = page.waitForEvent('popup');
    await page.getByRole('button', {name:'発表者ビュー', exact:true}).click();
    await reopened;
    await speaker.locator('.speaker-next iframe').waitFor();
    assert.equal(await speaker.getByRole('separator', {name:'スライドとメモの幅'}).getAttribute('aria-valuenow'),'35');
    assert.equal(await speaker.getByRole('separator', {name:'ページのメモと全体のメモの比率'}).getAttribute('aria-valuenow'),'20');
    assert.equal(await speaker.locator('.speaker-font-value').innerText(),'24');
    await speaker.getByRole('button',{name:'計測開始',exact:true}).click();
    await speaker.locator('.speaker-elapsed').filter({hasText:'0:01'}).waitFor();
    await speaker.getByRole('button',{name:'発表を終了',exact:true}).click();
    await speaker.waitFor({state:'detached'});
    assert.equal(await page.locator('.rehearsal-result').count(),0);
    await assert.rejects(readFile(join(ws.deck_dir('talk'),'rehearsals.json'),'utf8'),{code:'ENOENT'});
    assert.deepEqual(errors, []);
  });
  await t.test('presenter step bar previews on hover without moving the projection and commits on click', async () => {
    const before = await readFile(ws.qmd('talk'), 'utf8');
    try {
      await writeFile(ws.qmd('talk'), before.replace('最後の本文。\n', '最後の本文。\n\n::: {data-step="1"}\n段階の一つ目。\n:::\n\n::: {data-step="2"}\n段階の二つ目。\n:::\n'));
      await page.reload(); await page.locator('#stage[data-blocks=ready]').waitFor();
      await frame.locator('[data-step="2"]').filter({hasText:'段階の二つ目。'}).waitFor({state:'attached'});
      const opened = page.waitForEvent('popup');
      await page.getByRole('button', {name:'発表者ビュー', exact:true}).click();
      const popup = await opened; popup.setDefaultTimeout(8000);
      const speaker = page.locator('.speaker-screen'), current = page.frameLocator('.speaker-current iframe'), projected = popup.frameLocator('iframe');
      const at = (f: typeof current) => f.locator('body').evaluate(() => [(window as any).deck.index, (window as any).deck.step]);
      await page.locator('.speaker-connection.connected').waitFor({state:'attached', timeout:8000});
      const bar = speaker.getByRole('group', {name:'段階', exact:true}), count = speaker.locator('.speaker-step-count');
      // A page without steps keeps the row's height but shows no bar.
      assert.equal(await bar.isVisible(), false);
      await speaker.locator('.speaker-header > strong').click();
      await page.keyboard.type('3'); await page.keyboard.press('Enter');
      await projected.locator('.slide.active').filter({hasText:'最後の本文。'}).waitFor();
      await bar.waitFor();
      const segments = bar.getByRole('button');
      assert.equal(await segments.count(), 3);
      // 段階のあるページでは < > の両脇に、段階を飛ばしてページを移る << >> が出る
      const prevPage = speaker.getByRole('button',{name:'前のページ',exact:true}), nextPage = speaker.getByRole('button',{name:'次のページ',exact:true});
      await prevPage.waitFor(); assert.equal(await prevPage.getAttribute('data-tip'),'前のページへ');
      assert.equal(await nextPage.isDisabled(),true,'the last page has no next page');
      assert.equal(await count.innerText(), '段階 1 / 3');
      assert.equal(await segments.nth(0).getAttribute('aria-current'), 'step');
      // Hover previews a step on the presenter only.
      await bar.getByRole('button', {name:'段階 3 / 3', exact:true}).hover();
      await current.locator('.slide.active [data-step="2"]:not(.pending)').waitFor({state:'attached'});
      await speaker.locator('.speaker-step-preview').filter({hasText:'段階 3 をプレビュー中'}).waitFor();
      await bar.getByRole('button', {name:'段階 2 / 3', exact:true}).hover();
      await current.locator('.slide.active [data-step="2"].pending').waitFor({state:'attached'});
      await current.locator('.slide.active [data-step="1"]:not(.pending)').waitFor({state:'attached'});
      await page.waitForTimeout(300);
      assert.deepEqual(await at(projected), [2,0], 'hover previews never reach the projection');
      assert.equal(await count.innerText(), '段階 1 / 3');
      await page.screenshot({path:'/tmp/slide-studio-desktop/presenter-step-preview.png'});
      // Leaving the bar restores the committed step.
      await speaker.locator('.speaker-header > strong').hover();
      await current.locator('.slide.active [data-step="1"].pending').waitFor({state:'attached'});
      await speaker.locator('.speaker-step-preview').waitFor({state:'hidden'});
      assert.deepEqual(await at(projected), [2,0]);
      // A click commits the step to the presenter and the projection.
      await bar.getByRole('button', {name:'段階 3 / 3', exact:true}).click();
      await projected.locator('.slide.active [data-step="2"]:not(.pending)').waitFor({state:'attached'});
      await count.filter({hasText:'段階 3 / 3'}).waitFor();
      assert.deepEqual(await at(current), [2,2]);
      assert.equal(await segments.nth(2).getAttribute('aria-current'), 'step');
      // On the presenter's slide a centre click (e.g. while pointing) does not move; the edges do, with a hint.
      const slide = (await current.locator('#stage').boundingBox())!, middle = slide.y + slide.height / 2;
      await page.mouse.click(slide.x + slide.width / 2, middle);
      await page.waitForTimeout(300);
      assert.deepEqual(await at(current), [2,2]); assert.deepEqual(await at(projected), [2,2]);
      await page.mouse.move(slide.x + slide.width * .05, middle);
      await current.locator('#studio-nav-prev[style*="opacity: 1"]').waitFor({state:'attached'});
      await page.mouse.click(slide.x + slide.width * .05, middle);
      await projected.locator('.slide.active [data-step="2"].pending').waitFor({state:'attached'});
      assert.deepEqual(await at(current), [2,1]);
      await page.screenshot({path:'/tmp/slide-studio-desktop/presenter-step-bar.png'});
      // << は段階を飛ばして前のページの先頭へ移る
      await prevPage.click();
      await projected.locator('.slide.active').filter({hasText:'次の本文。'}).waitFor();
      assert.deepEqual(await at(current), [1,0]);
      // End on the first page, where the following tests expect the editor to be.
      await speaker.locator('.speaker-header > strong').click();
      await page.keyboard.type('1'); await page.keyboard.press('Enter');
      await current.locator('.slide.active').first().filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
      const closed = popup.waitForEvent('close');
      await page.keyboard.press('Escape');
      await speaker.waitFor({state:'detached'}); await closed;
      assert.deepEqual(errors, []);
    } finally {
      await writeFile(ws.qmd('talk'), before);
      await page.reload(); await page.locator('#stage[data-blocks=ready]').waitFor();
    }
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
  await t.test('F returns from presentation even when browser fullscreen is denied', async () => {
    const frame = page.locator('.present-screen iframe');
    const normal = page.frameLocator('.present-screen iframe');
    const trigger = page.getByRole('button', {name:'今のページから',exact:true});
    await page.evaluate(() => {
      Object.defineProperty(document.documentElement, 'requestFullscreen', {
        configurable: true,
        value: () => Promise.reject(new Error('fullscreen denied')),
      });
    });
    try {
      await page.locator('#pagestrip button[data-index="0"]').click();
      const preview = page.frameLocator('#slideBox > iframe:not(.loading)');
      await preview.locator('.slide.active').filter({hasText:'Chromeで編集して保存した本文。'}).waitFor();
      await trigger.focus();
      await page.keyboard.down('f');
      await normal.locator('.slide.active').waitFor();
      await page.waitForFunction(() => document.activeElement?.matches('.present-screen iframe'));
      await page.keyboard.down('f'); // A repeated keydown must not end the presentation.
      await page.keyboard.up('f');
      await normal.locator('body').press('ArrowDown');
      await normal.locator('.slide.active').filter({hasText:'次の本文。'}).waitFor();
      assert.equal(await page.evaluate(() => document.fullscreenElement), null);
      await normal.locator('body').press('f');
      await frame.waitFor({state:'detached'});
      await preview.locator('.slide.active').filter({hasText:'次の本文。'}).waitFor();
    } finally {
      await page.evaluate(() => { Reflect.deleteProperty(document.documentElement, 'requestFullscreen'); });
    }
  });
  await t.test('page menus duplicate from overview and toggle skip without deleting source', async () => {
    const before = await readFile(ws.qmd('talk'), 'utf8');
    const waitText = async (check: (text: string) => boolean) => {
      for (let i = 0; i < 100; i++) { if (check(await readFile(ws.qmd('talk'), 'utf8'))) return; await page.waitForTimeout(50); }
      assert.ok(check(await readFile(ws.qmd('talk'), 'utf8')));
    };
    try {
      assert.equal(await page.locator('#pagestrip .page-actions-trigger, .page-actions-trigger').count(), 0);
      await page.locator('#pagestrip button[data-index="0"]').click();
      await page.locator('#pageCount').filter({hasText:'1ページ'}).waitFor();
      await page.screenshot({path:'/tmp/slide-studio-page-actions.png'});
      await page.locator('.stepper').getByRole('button', {name: '発表・PDFから外す', exact:true}).click();
      await waitText(text => text.includes('.studio-skip'));
      await frame.locator('.slide.studio-skip').waitFor({state:'attached'});
      await page.locator('#pagestrip button.page-skipped').waitFor();
      assert.equal(await page.locator('#pagestrip button.page-skipped').getByText('スキップ').count(), 0);
      await page.locator('#pagestrip button[data-index="0"]').click();
      await page.getByRole('button',{name:'今のページから',exact:true}).click();
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
      await page.locator('#pagestrip button.page-skipped').waitFor({state:'detached'});
      await page.locator('#pagestrip button[data-index="0"]').focus();
      await page.keyboard.press('o');
      await page.locator('.overview-screen button[data-index="0"]').click({button:'right'});
      assert.equal(await page.getByRole('button', {name: /前へ移動|後ろへ移動/}).count(), 0);
      await page.getByRole('button', {name: 'ページを複製', exact:true}).click();
      await waitText(text => text.includes('#intro-copy-1'));
      await page.locator('#pagestrip button[data-index="3"]').waitFor();
      assert.equal((await readFile(ws.qmd('talk'), 'utf8')).split('Chromeで編集して保存した本文').length - 1, 2);
      await page.keyboard.press('Escape');
      // 複製先へ移った後、一覧のボタンの横の削除で今のページを消す
      await page.locator('.overview-screen').waitFor({state:'detached'});
      await page.locator('#pageCount').filter({hasText:'2ページ'}).waitFor();
      await page.locator('#stripTools').getByRole('button', {name: 'ページを削除', exact:true}).click();
      await waitText(text => !text.includes('#intro-copy-1'));
      assert.equal((await readFile(ws.qmd('talk'), 'utf8')).split('Chromeで編集して保存した本文').length - 1, 1);
    } finally {
      await page.keyboard.press('Escape');
      await writeFile(ws.qmd('talk'), before);
      await page.reload(); await page.locator('#stage[data-blocks=ready]').waitFor();
    }
  });
  await t.test('preview block context menu shares editor undo', async () => {
    const before = await readFile(ws.qmd('talk'), 'utf8');
    const waitText = async (check: (text: string) => boolean) => {
      for (let i=0; i<100; i++) { if (check(await readFile(ws.qmd('talk'),'utf8'))) return; await page.waitForTimeout(50); }
      assert.ok(check(await readFile(ws.qmd('talk'),'utf8')));
    };
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
  await t.test('fixed-width table fits the content area and saves inner spacing', async () => {
    ws.new_deck('spacing', 'test');
    await writeFile(ws.qmd('spacing'), '---\ntitle: 表\ntopic: test\n---\n\n## 素材\n\n::: {style="--table-cols:263 501 422"}\n| 置き場所 | 入れるもの | 使い方 |\n|---|---|---|\n| 素材 | 画像 | 配置する |\n:::\n');
    await page.goto(new URL('/deck/spacing', page.url()).href);
    await page.locator('#stage[data-blocks=ready]').waitFor();
    const table = frame.locator('.slide.active table');
    const fits = () => table.evaluate(el => {
      const slide = el.closest('.slide') as HTMLElement, rect = slide.getBoundingClientRect();
      return el.getBoundingClientRect().right <= rect.right - parseFloat(getComputedStyle(slide).paddingRight) * rect.width / slide.offsetWidth + 1;
    });
    assert.ok(await fits());
    await table.click();
    await page.getByRole('button', {name: '内側の余白', exact: true}).click();
    const handle = frame.locator('.bh[data-side=left]');
    await handle.waitFor();
    const stayedAttached = await handle.evaluate(async el => {
      const layer = el.parentElement!;
      // A preview layout update redraws the bands around the selected table.
      const redraw = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { observer.disconnect(); reject(Error('Table handles did not redraw')); }, 5000);
        const observer = new MutationObserver(() => { clearTimeout(timeout); observer.disconnect(); resolve(); });
        observer.observe(layer, {childList: true});
      });
      const deck = (window as any).deck;
      deck.go(deck.index, deck.step);
      await redraw;
      return el.isConnected && el === layer.querySelector('.bh[data-side=left]');
    });
    assert.equal(stayedAttached, true);
    const b = await handle.boundingBox(); assert.ok(b);
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    const saved = page.waitForResponse(r => r.url().endsWith('/source') && r.request().method() === 'PUT');
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 20, y, {steps: 4}); await page.mouse.up();
    assert.ok((await saved).ok());
    assert.match(await readFile(ws.qmd('spacing'), 'utf8'), /padding:[^";]+px/);
    await page.reload();
    await page.locator('#stage[data-blocks=ready]').waitFor();
    assert.ok(await fits());
    assert.ok(await table.evaluate(el => parseFloat(getComputedStyle(el.parentElement!).paddingLeft) > 0));
  });
  await t.test('sent image attachments load their thumbnails from the content origin', async () => {
    const images = join(ws.topic_dir('test'), 'images');
    await mkdir(images, {recursive: true});
    await writeFile(join(images, 'thumb.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
    const tabId = await page.locator('#chat [role=tab][aria-selected=true]').first().getAttribute('data-tab');
    assert.ok(tabId);
    // 名前も変えるとサーバーが会話の状態を配り直し、入力欄の添付が描き直される
    await page.evaluate(async id => {
      const {api} = await import('/web/api.js' as string);
      await api(`/api/deck/spacing/chat/tabs/${id}`, {method: 'PATCH', body: {attach: [{path: 'images/thumb.png'}], name: '添付の確認'}});
    }, tabId);
    const thumb = page.locator('.chat-field > .chat-attach img');
    await thumb.waitFor();
    const src = await thumb.getAttribute('src');
    assert.ok(src && new URL(src).origin !== new URL(page.url()).origin, String(src));
    assert.match(src, /\/files\/topics\/test\/images\/thumb\.png$/u);
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>('.chat-field > .chat-attach img'); return !!img?.complete && img.naturalWidth > 0; });
    await page.evaluate(async id => {
      const {api} = await import('/web/api.js' as string);
      await api(`/api/deck/spacing/chat/tabs/${id}`, {method: 'PATCH', body: {attach: [], name: '新しいタブ'}});
    }, tabId);
    await thumb.waitFor({state: 'detached'});
  });
  await t.test('chat model picker shows Codex and Claude Code side by side and picks in one click', async () => {
    const models = Array.from({length: 14}, (_, i) => ({id: `gpt-${i}`, name: `GPT ${i}`, effort: 'medium', efforts: ['low', 'medium', 'high']}));
    const status = {
      providers: [
        {id: 'claude', name: 'Claude Code', ok: false, reason: 'missing', default: null, models: []},
        {id: 'codex', name: 'Codex', ok: true, reason: null, default: 'gpt-0', models},
      ],
      default: 'codex:gpt-0', favorites: ['codex:gpt-0'], favorites_limit: 12, limits: {},
    };
    const patches: Record<string, unknown>[] = [];
    await page.route('**/api/ai/status*', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(status)}));
    await page.route('**/chat/tabs/*', route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patches.push(route.request().postDataJSON());
      return route.fulfill({status: 200, contentType: 'application/json', body: '{}'});
    });
    try {
      await page.reload(); await page.locator('#stage[data-blocks=ready]').waitFor();
      const button = page.locator('.ai-mbtn');
      await page.waitForFunction(() => document.querySelector('.ai-mbtn .nm')?.textContent === 'GPT 0');
      await button.click();
      const pop = page.getByRole('dialog', {name: 'モデルと思考量', exact: true});
      await pop.waitFor();
      // 追加・検索の手順はなく、開いたらすぐ2列の一覧
      assert.equal(await pop.locator('input, .ai-add, [data-mact=favorite]').count(), 0);
      assert.deepEqual(await pop.locator('.ai-col').evaluateAll(cols => cols.map(c => (c as HTMLElement).dataset.ai)), ['codex', 'claude']);
      const codex = await pop.locator('.ai-col[data-ai=codex]').boundingBox(), claude = await pop.locator('.ai-col[data-ai=claude]').boundingBox(), box = await pop.boundingBox();
      assert.ok(codex && claude && box);
      assert.ok(codex.x + codex.width <= claude.x && Math.abs(codex.y - claude.y) < 2);
      assert.ok(box.x >= 0 && box.x + box.width <= 1280 && box.y >= 0);
      assert.equal(await pop.locator('.ai-col[data-ai=codex] .pick').count(), 14);
      assert.ok(await pop.locator('.ai-grid').evaluate(el => el.scrollHeight > el.clientHeight));
      await pop.locator('.ai-col[data-ai=claude]').getByRole('button', {name: 'ダウンロード', exact: true}).waitFor();
      const row = pop.getByRole('button', {name: 'GPT 9', exact: true});
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await page.waitForFunction(() => document.querySelector('.ai-mbtn .nm')?.textContent === 'GPT 9');
      assert.ok(patches.some(body => body.model === 'codex:gpt-9'), JSON.stringify(patches));
      assert.equal(await pop.locator('.pick[aria-pressed=true]').innerText(), 'GPT 9');
      // 担当のモデル名を押すと一覧は担当のモデル選びになり、サブエージェントを畳むとチャットに戻る
      const subs = pop.locator('.ai-sub-head'), main = pop.locator('.ai-main-model .ai-mname');
      if (await subs.getAttribute('aria-expanded') !== 'true') await subs.click();
      await pop.locator('.ai-mname[data-role=review]').click();
      await pop.locator('.ai-pick.role').waitFor();
      assert.equal(await main.getAttribute('aria-pressed'), 'false');
      await subs.click();
      await pop.locator('.ai-pick.role').waitFor({state: 'detached'});
      assert.equal(await main.getAttribute('aria-pressed'), 'true');
      // 担当を選んだ後でも、チャットのモデル名を押せばチャットのモデル選びに戻る
      await subs.click();
      await pop.locator('.ai-mname[data-role=review]').click();
      await pop.locator('.ai-pick.role').waitFor();
      await main.click();
      await pop.locator('.ai-pick.role').waitFor({state: 'detached'});
      assert.equal(await main.getAttribute('aria-pressed'), 'true');
      // 開いても入力欄の上に出て、入力欄は隠れない
      const field = await page.locator('.chat-field').boundingBox(), popBox = await pop.boundingBox();
      assert.ok(field && popBox);
      assert.ok(popBox.y + popBox.height <= field.y, JSON.stringify({field, popBox}));
      // 思考量を選んでも閉じない（担当もチャットも）
      const clickEnd = async (role: string) => {
        const slider = pop.locator(`.ai-slider[data-role="${role}"]`), box = await slider.boundingBox();
        assert.ok(box);
        await slider.click({position: {x: box.width - 4, y: box.height / 2}});
        await page.waitForFunction(r => document.querySelector(`.ai-slider[data-role="${r}"]`)?.getAttribute('aria-valuetext') === '高', role);
      };
      await clickEnd('review');
      await clickEnd('');
      await page.waitForFunction(() => document.querySelector('.ai-mbtn .ef')?.textContent === '高');
      assert.ok(patches.some(body => body.effort === 'high'), JSON.stringify(patches));
      assert.equal(await pop.isVisible(), true);
      // 入力欄を押すと閉じて、そのまま入力できる
      await page.locator('.chat-input').click();
      await pop.waitFor({state: 'hidden'});
      assert.ok(await page.locator('.chat-input').evaluate(el => el === document.activeElement));
    } finally {
      await page.unroute('**/api/ai/status*'); await page.unroute('**/chat/tabs/*');
      await page.reload(); await page.locator('#stage[data-blocks=ready]').waitFor();
    }
  });
  await t.test('empty chat offers starters that fill the input without sending', async () => {
    const input = page.locator('.chat-input'), starters = page.locator('.chat-starter');
    const fresh = async () => { await page.locator('#chat [data-act=add]').click(); await starters.first().waitFor(); };
    await page.locator('#editor .ptabs [data-tab=qmd]').click();
    await fresh();
    // 検査に問題があるときだけ、後ろに「検査の問題を直す」が付く
    assert.deepEqual((await starters.locator('span').allTextContents()).slice(0, 4), ['下書きからスライドを作る', 'PowerPoint の雛形を使う', 'テーマを直す', '話す台本を作る']);
    await page.getByRole('button', {name: '話す台本を作る', exact: true}).click();
    await page.waitForFunction(() => (document.querySelector('.chat-input') as HTMLTextAreaElement).value === '/発表原稿 ');
    assert.equal(await starters.first().isVisible(), false);
    assert.equal(await page.locator('.chat-tlabel').textContent(), '発表全体');
    // 雛形を選ぶと、書きかけのあるタブには足さず、空のタブに添付と依頼文を入れる
    await page.locator('.chat-template-file').setInputFiles({name: '研究室.potx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.template', buffer: Buffer.from('PK')});
    const choice = page.getByRole('dialog', {name: '雛形をどのテーマに反映しますか', exact: true});
    assert.equal(await choice.locator('.chat-choice').count(), 2);
    assert.equal(await input.inputValue(), '/発表原稿 ');
    await choice.getByRole('button', {name: /^新しいテーマを作る/u}).click();
    await page.waitForFunction(() => (document.querySelector('.chat-input') as HTMLTextAreaElement).value.includes('「研究室.potx」'));
    assert.match(await input.inputValue(), /新しいテーマを作り/u);
    await page.locator('.chat-field .chat-att-note').waitFor();
    assert.equal(await page.locator('.chat-field .chat-att').count(), 1);
    await page.locator('.chat-template-file').setInputFiles({name: '共有.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK')});
    await choice.getByRole('button', {name: /^今のテーマを直す/u}).click();
    await page.locator('#editor.theme-on').waitFor();
    await page.waitForFunction(() => (document.querySelector('.chat-input') as HTMLTextAreaElement).value.includes('「共有.pptx」'));
    assert.equal(await page.locator('.chat-field .chat-att').count(), 1);
    await page.locator('#editor .ptabs [data-tab=qmd]').click();
    // 下書きが空なら、下書きタブへ案内する。文章を入力したら、下書きのチャットで推敲を頼める
    await fresh();
    await page.getByRole('button', {name: '下書きからスライドを作る', exact: true}).click();
    await page.locator('#editor.memo-on').waitFor();
    await page.locator('.memo-input').fill('発表の下書きです。');
    await page.getByRole('button', {name: '下書きを推敲する', exact: true}).click();
    await page.waitForFunction(() => (document.querySelector('.chat-input') as HTMLTextAreaElement).value === '下書きの意味を変えずに、文章を読みやすく整えてください。');
    await page.locator('#chat [data-act=add]').click();
    await page.getByRole('button', {name: 'テーマを直す', exact: true}).click();
    await page.locator('#editor.theme-on').waitFor();
    await page.locator('#editor .ptabs [data-tab=qmd]').click();
  });
  assert.deepEqual(errors, []);
});

test('headless home sorts slides beside its heading and restores every trash kind after reload', {timeout:30000,skip:!existsSync(chrome)}, async t=>{
  const {startStudioHost}=await import('../../apps/server/index.js');
  const {remove}=await import('../../packages/core/src/deck-manage.js');
  const temp=await mkdtemp(join(tmpdir(),'studio-home-browser-')),ws=Workspace.open(join(temp,'ws'));
  ws.new_deck('alpha','research','default',null,'Alpha');ws.new_deck('beta','work','default',null,'Beta');ws.new_deck('deleted','research','default',null,'復元する発表');
  await remove(ws,'deleted');ws.register_theme('custom','body { color:red }');ws.remove_theme('custom');ws.new_topic('unused');ws.remove_topic('unused');
  const host=await startStudioHost({workspace:ws,uiDirectory:join(process.cwd(),'dist/packages/web'),watch:false,pandocPath:'/unused',renderText:async()=>{throw Error('Home must not render a presentation');}});
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
  // Tab stays inside the custom modal; closing returns focus to the button that opened it.
  const closeCreate=createDialog.getByRole('button',{name:'閉じる',exact:true}),active=()=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent||'');
  await closeCreate.focus();await page.keyboard.press('Shift+Tab');assert.equal(await active(),'作る');
  await page.keyboard.press('Tab');assert.equal(await active(),'閉じる');
  await page.keyboard.press('Escape');await createDialog.waitFor({state:'detached'});
  assert.equal(await active(),'新しい発表');
  assert.equal(await page.getByRole('searchbox').count(),0);
  assert.equal(await page.locator('.cards .deck-card-wrap').count(),2);
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
  assert.ok(ws.has_deck('deleted')&&ws.themes_list().includes('custom')&&ws.shelves().includes('unused'));
  const htmlFile = join(ws.shelf_dir('research'), 'example.html');
  await writeFile(htmlFile, '<p>HTML preview</p>');
  await page.setViewportSize({width:390,height:844});
  await page.locator('.lib').filter({hasText:'research'}).click();
  const html = page.locator('.topic-html');
  const open = html.getByRole('button', {name:'「example.html」をプレビュー', exact:true});
  await open.waitFor();
  assert.equal(await html.locator('iframe').count(), 1);
  assert.equal(await page.getByRole('button', {name:'選択', exact:true}).count(), 0);
  assert.equal(await page.getByText('_lib のファイル 0件', {exact:true}).count(), 0);
  assert.ok(await html.evaluate(el => el.scrollWidth <= el.clientWidth));
  await open.press('Enter');
  const preview = page.getByRole('dialog', {name:'素材のプレビュー'});
  await preview.frameLocator('iframe').getByText('HTML preview').waitFor();
  await page.keyboard.press('Escape'); await preview.waitFor({state:'detached'});
  const removeHtml = html.getByRole('button', {name:'「example.html」を削除'});
  await removeHtml.click();
  const confirmation = page.getByRole('dialog', {name:'「example.html」を削除'});
  await confirmation.getByRole('button', {name:'やめる'}).click();
  assert.ok(existsSync(htmlFile));
  await removeHtml.click();
  await confirmation.getByRole('button', {name:'削除', exact:true}).click();
  await open.waitFor({state:'detached'});
  assert.ok(!existsSync(htmlFile));
  assert.deepEqual(errors,[]);
});
