import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PAGE = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/packages/web/shared.css">
<style>body{margin:0;height:100vh;overflow:hidden}.clip{position:fixed;left:20px;bottom:8px;width:200px;height:40px;overflow:hidden}</style>
<dialog id="d"><form id="f">
  <label id="lab">果物 <studio-select name="fruit" aria-label="果物"><option value="apple">Apple</option><option value="banana" disabled>Banana</option><option value="cherry" selected>Cherry</option><option value="date">Date</option><option value="blueberry">Blueberry</option></studio-select></label>
  <studio-select variant="segmented" name="mode" aria-label="表示"><option value="a">A</option><option value="b">B</option><option value="c">C</option></studio-select>
  <studio-select name="off" aria-label="無効" disabled><option value="x">X</option></studio-select>
</form></dialog>
<div class="clip"><studio-select id="low" aria-label="下端" placeholder="選択"></studio-select></div>
<script type="module">
  import { studioSelect } from '/packages/web/custom-select.js';
  window.events = [];
  const d = document.querySelector('#d'); d.addEventListener('close', () => events.push('dialog-close'));
  document.addEventListener('change', e => events.push((e.target.getAttribute('name') || e.target.id) + '=' + e.target.value));
  document.querySelector('#low').options = Array.from({length: 30}, (_, i) => ({value: String(i), label: 'Item ' + i}));
  window.made = studioSelect({label: '作成', options: [{value: '1', label: '一'}, {value: '2', label: '二'}], value: '2'});
  d.showModal(); window.ready = true;
</script>`;

test('studio-select works like a select with keyboard, mouse, forms, dialogs and window edges', {skip: !existsSync(chrome), timeout: 30000}, async t => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE); return; }
    const path = resolve('.' + (req.url ?? ''));
    if (!path.startsWith(resolve('packages/web') + '/')) { res.writeHead(404).end(); return; }
    try { res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(path)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({executablePath: chrome, headless: true});
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const page = await browser.newPage({viewport: {width: 800, height: 600}}); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}/`); await page.waitForFunction(() => (window as any).ready);

  const fruit = page.getByRole('combobox', {name: '果物', exact: true});
  const list = page.locator('.ss-list:popover-open');
  const active = () => fruit.evaluate(e => document.getElementById(e.getAttribute('aria-activedescendant') ?? '')?.dataset.value ?? null);
  const value = (selector: string) => page.locator(selector).evaluate(e => (e as HTMLElement & {value: string}).value);
  const events = () => page.evaluate(() => (window as any).events as string[]);
  assert.equal(await page.locator('select').count(), 0);
  assert.equal(await fruit.textContent(), 'Cherry');
  assert.equal(await value('studio-select[name=fruit]'), 'cherry');

  // ラベルを押すと欄にフォーカスが移る。↓で開き、選んでいる行から始まる。無効な行は飛ばす
  await page.locator('#lab').click({position: {x: 4, y: 6}});
  assert.ok(await fruit.evaluate(e => e === document.activeElement));
  await page.keyboard.press('ArrowDown');
  assert.equal(await fruit.getAttribute('aria-expanded'), 'true');
  assert.equal(await list.getAttribute('role'), 'listbox');
  assert.equal(await list.locator('[aria-selected=true]').getAttribute('data-value'), 'cherry');
  assert.equal(await active(), 'cherry');
  await page.keyboard.press('ArrowUp'); assert.equal(await active(), 'apple');
  await page.keyboard.press('ArrowUp'); assert.equal(await active(), 'apple');
  await page.keyboard.press('End'); assert.equal(await active(), 'blueberry');
  await page.keyboard.press('Home'); assert.equal(await active(), 'apple');
  await page.keyboard.press('d'); assert.equal(await active(), 'date');
  await page.keyboard.press('Enter');
  assert.equal(await fruit.getAttribute('aria-expanded'), 'false');
  assert.equal(await list.count(), 0);
  assert.equal(await value('studio-select[name=fruit]'), 'date');
  assert.deepEqual(await events(), ['fruit=date']);
  assert.ok(await fruit.evaluate(e => e === document.activeElement));

  // Esc は一覧だけ閉じ、値もダイアログもそのまま
  await page.keyboard.press(' '); assert.equal(await fruit.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
  assert.equal(await fruit.getAttribute('aria-expanded'), 'false');
  assert.equal(await value('studio-select[name=fruit]'), 'date');
  assert.equal(await page.evaluate(() => (document.querySelector('#d') as HTMLDialogElement).open), true);
  assert.deepEqual(await events(), ['fruit=date']);

  // 閉じたまま文字を打つと、その文字で始まる行を出す（無効な Banana は飛ばす）
  await page.keyboard.press('b'); assert.equal(await fruit.getAttribute('aria-expanded'), 'true');
  assert.equal(await active(), 'blueberry');
  await page.keyboard.press('Escape');

  // マウス：押して開き、行を押して決める。外を押すと閉じる
  await fruit.click(); await list.locator('[data-value=apple]').click();
  assert.equal(await value('studio-select[name=fruit]'), 'apple');
  assert.equal(await list.count(), 0);
  await fruit.click(); assert.equal(await list.count(), 1);
  assert.equal(await list.locator('[data-value=banana]').getAttribute('aria-disabled'), 'true');
  await list.locator('[data-value=banana]').click({force: true});
  assert.equal(await value('studio-select[name=fruit]'), 'apple');
  await page.mouse.click(4, 4);
  assert.equal(await list.count(), 0);
  assert.equal(await page.evaluate(() => (document.querySelector('#d') as HTMLDialogElement).open), true);

  // 横並び：押して選び、矢印で隣へ（端から端へ回る）
  const mode = page.getByRole('radiogroup', {name: '表示', exact: true});
  assert.equal(await mode.getByRole('radio', {name: 'A', exact: true}).getAttribute('aria-checked'), 'true');
  await mode.getByRole('radio', {name: 'B', exact: true}).click();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  assert.equal(await value('studio-select[name=mode]'), 'a');
  assert.equal(await mode.getByRole('radio', {name: 'A', exact: true}).evaluate(e => e === document.activeElement && e.tabIndex === 0), true);

  // 無効な欄は開かず、form には無効な欄以外の値が入る
  assert.equal(await page.getByRole('combobox', {name: '無効', exact: true}).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => [...new FormData(document.querySelector('#f') as HTMLFormElement)].map(([k, v]) => `${k}=${v}`)), ['fruit=apple', 'mode=a']);
  assert.deepEqual(await events(), ['fruit=date', 'fruit=apple', 'mode=b', 'mode=c', 'mode=a']);

  // 画面の下端・overflow:hidden の中でも、一覧は切れずに上へ出る
  await page.evaluate(() => (document.querySelector('#d') as HTMLDialogElement).close());
  const low = page.getByRole('combobox', {name: '下端', exact: true});
  assert.equal(await low.textContent(), '選択');
  assert.equal(await value('#low'), '');
  await low.click();
  const box = await list.boundingBox(), anchor = await low.boundingBox();
  assert.ok(box && anchor);
  assert.ok(box.y >= 0 && box.y + box.height <= anchor.y + 1, `${JSON.stringify(box)} above ${JSON.stringify(anchor)}`);
  assert.ok(box.height > 100);
  await page.keyboard.press('End');
  assert.equal(await low.evaluate(e => document.getElementById(e.getAttribute('aria-activedescendant') ?? '')?.dataset.value), '29');
  assert.ok(await list.locator('[data-value="29"]').isVisible());
  await page.keyboard.press('Enter');
  assert.equal(await low.textContent(), 'Item 29');
  await page.locator('#low').evaluate(e => { (e as HTMLElement & {value: string}).value = '3'; });
  assert.equal(await low.textContent(), 'Item 3');
  assert.equal((await events()).at(-1), 'low=29');

  // コードから作った欄
  assert.deepEqual(await page.evaluate(() => { const m = (window as any).made; document.body.append(m); return [m.value, m.querySelector('[role=combobox]').getAttribute('aria-label'), m.options.length]; }), ['2', '作成', 2]);
  assert.deepEqual(errors, []);
});
