import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('runtime presentation supports blackout, typed page jumps and skipped navigation', {skip:!existsSync(chrome)}, async t => {
 const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent(`<style>.slide{display:none}.slide.active{display:block}#stage{width:1280px;height:720px}#overview[hidden]{display:none}</style>
 <div id="stage"><section class="slide" id="one"><h2>One</h2><p data-step="1">Fragment</p></section><section class="slide studio-skip" id="skip"><h2>Skip</h2></section><section class="slide" id="three"><h2>Three</h2></section></div>
 <input id="typing"><button id="menu">Menu</button><div id="overview" hidden><button id="close">Close</button></div>`);
 await page.addScriptTag({content:await readFile('packages/core/assets/runtime/player.js','utf8')});
 await page.waitForFunction(()=>!!(window as any).deckReady);
 const index=()=>page.evaluate(()=>(window as any).deck.index);
 await page.keyboard.press('b');assert.equal(await page.locator('#studio-blackout').isVisible(),true);assert.equal(await index(),0);
 await page.keyboard.press('B');assert.equal(await page.locator('#studio-blackout').isVisible(),false);
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
 await page.keyboard.press('Escape');await page.locator('#typing').focus();await page.keyboard.type('b3');await page.keyboard.press('Enter');assert.equal(await index(),0);assert.equal(await page.locator('#studio-blackout').isVisible(),false);
 await page.locator('#typing').blur();await page.keyboard.press('Control+b');assert.equal(await page.locator('#studio-blackout').isVisible(),false);
 assert.deepEqual(errors,[]);
});
