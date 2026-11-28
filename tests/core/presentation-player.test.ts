import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('runtime presentation supports typed page jumps and skipped navigation', {skip:!existsSync(chrome)}, async t => {
 const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent(`<style>.slide{display:none}.slide.active{display:block}#stage{width:1280px;height:720px}#overview[hidden]{display:none}</style>
 <div id="stage"><section class="slide" id="one"><h2>One</h2><p data-step="1">Fragment</p></section><section class="slide studio-skip" id="skip"><h2>Skip</h2></section><section class="slide" id="three"><h2>Three</h2></section></div>
 <input id="typing"><button id="menu">Menu</button><div id="overview" hidden><button id="close">Close</button></div>`);
 await page.addScriptTag({content:await readFile('packages/core/assets/runtime/player.js','utf8')});
 await page.waitForFunction(()=>!!(window as any).deckReady);
 const index=()=>page.evaluate(()=>(window as any).deck.index);
 await page.keyboard.press('b');assert.equal(await page.locator('#studio-blackout').count(),0,'B no longer blacks out the screen');assert.equal(await index(),0);
 await page.keyboard.type('3');assert.equal(await index(),0);assert.equal(await page.locator('#studio-page-entry').textContent(),'3');
 await page.keyboard.press('Enter');assert.equal(await index(),2);assert.equal(await page.locator('#studio-page-entry').isVisible(),false);
 await page.keyboard.type('9');await page.keyboard.press('Escape');assert.equal(await page.locator('#studio-page-entry').isVisible(),false);assert.equal(await page.locator('#overview').isVisible(),false);
 await page.keyboard.type('99');await page.keyboard.press('Enter');assert.equal(await index(),2);
 await page.keyboard.type('2');await page.keyboard.press('Enter');assert.equal(await index(),2,'explicit jump to skipped page is ignored');
 await page.keyboard.press('ArrowUp');assert.equal(await index(),0);
 await page.keyboard.press('ArrowRight');assert.equal(await index(),0,'right advances fragments first');
 await page.keyboard.press('ArrowRight');assert.equal(await index(),2,'next page bypasses skipped slide');
 await page.keyboard.type('13');await page.keyboard.press('Backspace');await page.keyboard.press('Enter');assert.equal(await index(),0);
 await page.keyboard.press('o');assert.equal(await page.locator('#overview .thumb').count(),2);assert.equal(await page.locator('#overview .thumb[aria-current=true]').getAttribute('data-index'),'0');
 await page.keyboard.press('Escape');await page.locator('#typing').focus();await page.keyboard.type('b3');await page.keyboard.press('Enter');assert.equal(await index(),0);
  assert.deepEqual(errors,[]);
});

const remoteDeck = (prelude = '') => `<!doctype html><html><head><meta charset="utf-8"><style>.slide{display:none}.slide.active{display:block}#stage{width:1280px;height:720px}#overview[hidden]{display:none}</style></head><body>
 <div id="stage"><section class="slide" id="one"><h2>One</h2></section><section class="slide" id="two"><h2>Two</h2><p data-step="1">A</p><p data-step="2">B</p></section><section class="slide" id="three"><h2>Three</h2></section><section class="slide studio-skip" id="skip"><h2>Skip</h2></section></div>
 <textarea id="notes"></textarea><button id="menu">Menu</button><div id="overview" hidden><button id="close">Close</button></div>
 <script>${prelude}</script><script src="/player.js"></script></body></html>`;

async function openDeck(browser: Browser, hash: string, prelude = '') {
 const page = await browser.newPage(), errors: string[] = [];
 page.on('pageerror', e => errors.push(e.message));
 const player = await readFile('packages/core/assets/runtime/player.js', 'utf8');
 await page.route('http://player.test/**', route => route.fulfill(new URL(route.request().url()).pathname === '/player.js'
  ? {body: player, contentType: 'text/javascript'} : {body: remoteDeck(prelude), contentType: 'text/html'}));
 await page.goto(`http://player.test/deck.html${hash}`);
 await page.waitForFunction(() => !!(window as any).deckReady);
 const at = () => page.evaluate(() => [(window as any).deck.index, (window as any).deck.step]);
 return {page, errors, at};
}

test('runtime presentation restores the step from #page/step', {skip:!existsSync(chrome)}, async t => {
 const browser = await chromium.launch({executablePath:chrome, headless:true}); t.after(() => browser.close());
 for (const [hash, expected] of [['#2/2', [1,2]], ['#2/1', [1,1]], ['#2/9', [1,2]], ['#3', [2,0]], ['#2/0', [1,0]], ['', [0,0]]] as const) {
  const {page, errors, at} = await openDeck(browser, hash);
  assert.deepEqual(await at(), expected, `hash ${hash || '(none)'}`);
  if (expected[0] === 1) assert.equal(await page.locator('#two [data-step="2"]').evaluate(el => el.classList.contains('pending')), expected[1] < 2);
  assert.deepEqual(errors, []);
  await page.close();
 }
});

test('runtime presentation accepts presentation-remote keys without hijacking text input', {skip:!existsSync(chrome)}, async t => {
 const browser = await chromium.launch({executablePath:chrome, headless:true}); t.after(() => browser.close());
 const {page, errors, at} = await openDeck(browser, '#1/0');
 await page.keyboard.press('PageDown'); assert.deepEqual(await at(), [1,0], 'PageDown moves to the next page');
 await page.keyboard.press('PageDown'); assert.deepEqual(await at(), [2,0], 'PageDown skips the remaining steps');
 await page.keyboard.press('PageUp'); assert.deepEqual(await at(), [1,0], 'PageUp goes back to the previous page');
 await page.keyboard.press('ArrowRight'); assert.deepEqual(await at(), [1,1]);
 for (const key of ['End','Home']) await page.keyboard.press(key);
 assert.deepEqual(await at(), [1,1], 'Home and End do not move the deck');
 await page.keyboard.press('PageUp'); assert.deepEqual(await at(), [0,0], 'PageUp moves by page, not by step');
 await page.keyboard.press('PageUp'); assert.deepEqual(await at(), [0,0], 'PageUp stays on the first step of the first page');
 await page.locator('#notes').focus();
 for (const key of ['PageDown','PageUp']) await page.keyboard.press(key);
 assert.deepEqual(await at(), [0,0], 'remote keys typed into a textarea do not move the deck');
 await page.locator('#notes').blur();
 await page.keyboard.press('o'); assert.equal(await page.locator('#overview').isVisible(), true);
 await page.keyboard.press('PageDown'); assert.deepEqual(await at(), [0,0], 'remote keys do not navigate behind the open overview');
 await page.keyboard.press('Escape'); assert.equal(await page.locator('#overview').isVisible(), false);
 assert.deepEqual(errors, []);
 // The editor's preview frame is not presenting: PageDown/PageUp stay with the editor.
 const edit = await openDeck(browser, '#2/0', 'window.__slideStudioFrameAgentStarted = true;');
 for (const key of ['PageDown','PageUp']) await edit.page.keyboard.press(key);
 assert.deepEqual(await edit.at(), [1,0]);
 assert.deepEqual(edit.errors, []);
});

test('runtime presentation clicks move only when stationary, with edge zones and hover hints', {skip:!existsSync(chrome)}, async t => {
 const browser = await chromium.launch({executablePath:chrome, headless:true}); t.after(() => browser.close());
 const {page, errors, at} = await openDeck(browser, '#2/0');
 const box = (await page.locator('#stage').boundingBox())!;
 const point = (fx: number) => [box.x + box.width * fx, box.y + box.height / 2] as const;
 const click = (fx: number) => page.mouse.click(...point(fx));
 const hint = (id: string) => page.locator(`#studio-nav-${id}`).evaluate(el => (el as HTMLElement).style.opacity);
 const hintText = async (id: string) => (await page.locator(`#studio-nav-${id}`).innerText()).split('\n').join(' ');
 await click(.5); assert.deepEqual(await at(), [1,1], 'a centre click advances in a normal presentation');
 await click(.05); assert.deepEqual(await at(), [1,0], 'the left edge goes back');
 await click(.25); assert.deepEqual(await at(), [1,1], 'only the outer 15% goes back');
 const [x, y] = point(.5);
 await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 20, y, {steps:4}); await page.mouse.up();
 assert.deepEqual(await at(), [1,1], 'a drag is not a navigation click');
 await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 3, y); await page.mouse.up();
 assert.deepEqual(await at(), [1,2], 'a small jitter still counts as a click');
 // Hovering an edge shows what a click there does; the centre shows nothing.
 await page.mouse.move(...point(.05)); assert.equal(await hint('prev'), '1'); assert.equal(await hint('next'), '0');
 assert.equal(await hintText('prev'), '前へ ← 長押しで最初へ');
 assert.equal(await page.locator('#stage').evaluate(el => (el as HTMLElement).style.cursor), 'pointer');
 await page.mouse.move(...point(.95)); assert.equal(await hint('next'), '1'); assert.equal(await hint('prev'), '0');
 await page.mouse.move(...point(.5)); assert.equal(await hint('next'), '0'); assert.equal(await hint('prev'), '0');
 assert.equal(await page.locator('#stage').evaluate(el => (el as HTMLElement).style.cursor), '');
 // The presenter's current slide navigates only from the edges.
 await page.evaluate(() => (window as any).deck.edgeClicks(true));
 await click(.5); assert.deepEqual(await at(), [1,2], 'centre clicks do not navigate in edge-only mode');
 await click(.05); assert.deepEqual(await at(), [1,1]);
 await click(.95); assert.deepEqual(await at(), [1,2]);
 await click(.05); await click(.75); assert.deepEqual(await at(), [1,2], 'edge-only mode widens the next zone');
 await click(.6); assert.deepEqual(await at(), [1,2]);
 // Slide elements cannot be selected or touched in edge-only mode.
 assert.equal(await page.locator('#two h2').evaluate(el => getComputedStyle(el).userSelect), 'none');
 assert.equal(await page.locator('#two h2').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
 // Holding an edge jumps to the first or last step of the page; the release is not a click.
 const hold = async (fx: number) => { await page.mouse.move(...point(fx)); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up(); };
 await hold(.05); assert.deepEqual(await at(), [1,0], 'holding the left edge goes to the first step');
 await page.mouse.move(...point(.5)); await page.mouse.move(...point(.9));
 assert.equal(await hintText('next'), '次へ → 長押しで最後へ');
 await hold(.9); assert.deepEqual(await at(), [1,2], 'holding the right edge goes to the last step');
 await page.mouse.move(...point(.5)); await page.mouse.move(...point(.9));
 assert.equal(await hintText('next'), '次へ → 長押しで最後へ', 'the hold hint stays on a page with steps');
 assert.equal(await page.locator('#studio-nav-next kbd').innerText(), '→', 'the arrow is drawn as a key');
 await page.evaluate(() => (window as any).deck.go(0, 0)); await page.mouse.move(...point(.5)); await page.mouse.move(...point(.9));
 assert.equal(await hintText('next'), '次へ →', 'no hold hint on a page without steps');
 // Nothing to go back to on the first step of the first page, so no hint there.
 await page.evaluate(() => (window as any).deck.go(0, 0));
 await page.mouse.move(...point(.5)); await page.mouse.move(...point(.05)); assert.equal(await hint('prev'), '0');
 await page.mouse.move(...point(.95)); assert.equal(await hint('next'), '1');
 assert.deepEqual(errors, []);
});
