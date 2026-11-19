import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, {type TestContext} from 'node:test';
import { Workspace } from '../../packages/core/src/workspace.js';
import { searchSlides, searchSlideDecks, takeSlide } from '../../packages/core/src/slide-library.js';
import { add } from '../../packages/core/src/deck-assets.js';
import { new_figure } from '../../packages/core/src/figures.js';
function setup(t: TestContext) {
 const dir=mkdtempSync(join(tmpdir(),'slide-library-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const ws=Workspace.open(join(dir,'ws')); ws.new_deck('past','old'); ws.new_deck('now','new');
 writeFileSync(ws.qmd('past'),'---\ntopic: old\n---\n\n## 😀実験結果\n\n再利用する図 [@paper]\n\n![図](images/plot.png)\n\n## 別ページ\n\n対象外\n');
 writeFileSync(ws.bib('past'),'@article{paper,title={Result},crossref={parent}}\n@book{parent,title={Proceedings}}\n@article{unused,title={Unused}}');
 add(ws,'past','plot.png',Buffer.from('source')); add(ws,'now','plot.png',Buffer.from('keep'));
 return ws;
}
test('search spans topics, title/body/citekey and Unicode; imports only the page dependencies',async t=>{
 const ws=setup(t),before=readFileSync(ws.qmd('now'),'utf8');
 const hit=searchSlides(ws,'実験 paper').results[0]!; assert.equal(hit.deck,'past'); assert.equal(searchSlides(ws,'対象外').results.length,1);
 const result=await takeSlide(ws,'now',hit.deck,hit.page,hit.version);
 assert.match(result.text,/😀実験結果/); assert.doesNotMatch(result.text,/別ページ/);
 assert.match(result.text,/images\/plot-2.png/); assert.equal(readFileSync(join(ws.asset_root('now'),'images/plot.png'),'utf8'),'keep');
 assert.equal(readFileSync(join(ws.asset_root('now'),'images/plot-2.png'),'utf8'),'source');
 const bibliography=readFileSync(ws.bib('now'),'utf8'); assert.match(bibliography,/@article\{paper/); assert.match(bibliography,/@book\{parent/); assert.doesNotMatch(bibliography,/unused/);
 assert.equal(readFileSync(ws.qmd('now'),'utf8'),before);
 await takeSlide(ws,'now',hit.deck,hit.page,hit.version); assert.equal(readFileSync(ws.bib('now'),'utf8'),bibliography);
});
test('rejects stale pages and conflicting bibliography before copying assets',async t=>{
 const ws=setup(t),hit=searchSlides(ws,'paper').results[0]!;
 writeFileSync(ws.bib('now'),'@article{paper,title={Different}}');
 await assert.rejects(takeSlide(ws,'now','past',hit.page,hit.version),/内容が/);
 assert.deepEqual(readdirSync(join(ws.asset_root('now'),'images')),['plot.png']);
 writeFileSync(ws.qmd('past'),readFileSync(ws.qmd('past'),'utf8')+'Changed');
 await assert.rejects(takeSlide(ws,'now','past',hit.page,hit.version),/変更されました/);
});
test('figure modules are copied across topics and refs rewritten',async t=>{
 const ws=setup(t); await new_figure(ws,'chart',ws.shelf_dir('old'));
 writeFileSync(ws.qmd('past'),'---\ntopic: old\n---\n\n## Figure\n\n{{< fig old/chart >}}\n');
 const hit=searchSlides(ws,'Figure').results[0]!;
 const result=await takeSlide(ws,'now','past',hit.page,hit.version);
 assert.match(result.text,/fig new\/chart/); assert.ok(readFileSync(join(ws.shelf_dir('new'),'chart/figure.mjs')).length);
});

test('deck selection groups pages, excludes the open deck and scopes page searches', async t => {
 const ws=setup(t);
 const decks=searchSlideDecks(ws,'','now');
 assert.deepEqual(decks.results.map(d=>[d.deck,d.count]),[['past',2]]);
 assert.equal(searchSlides(ws,'',{exclude:'now',deck:'past'}).results.length,2);
 assert.equal(searchSlides(ws,'',{exclude:'past',deck:'past'}).results.length,0);
 assert.equal(searchSlideDecks(ws,'対象外','now').results[0]?.count,1);
 const hit=decks.results[0]!;
 await assert.rejects(takeSlide(ws,'past','past',hit.page,hit.version),/開いている/);
});


test('HTML and its local dependencies travel together and repeated imports reuse them', async t => {
 const ws=setup(t);
 const html='<link href="style.css" rel="stylesheet"><img src="../images/plot.png"><script src="chart.js"></script>';
 writeFileSync(join(ws.shelf_dir('old'),'chart.html'),html);
 writeFileSync(join(ws.shelf_dir('old'),'style.css'),'body { background: url(../images/plot.png); }');
 writeFileSync(join(ws.shelf_dir('old'),'chart.js'),'console.log("chart");');
 writeFileSync(ws.qmd('past'),'---\ntopic: old\n---\n\n## HTML\n\n<iframe src="../../topics/old/html/chart.html"></iframe>\n');
 const hit=searchSlides(ws,'HTML').results[0]!;
 const result=await takeSlide(ws,'now','past',hit.page,hit.version);
 const path=/src="([^"]+)"/u.exec(result.text)![1]!;
 assert.match(path,/^html\/import-/);
 assert.equal(readFileSync(join(ws.asset_root('now'),path),'utf8'),html);
 const base=join(ws.asset_root('now'),path,'..','..');
 assert.equal(readFileSync(join(base,'images/plot.png'),'utf8'),'source');
 assert.equal(readFileSync(join(base,'html/chart.js'),'utf8'),'console.log("chart");');
 assert.equal((await takeSlide(ws,'now','past',hit.page,hit.version)).text,result.text);
 assert.equal(readdirSync(ws.shelf_dir('new')).filter(n=>n.startsWith('import-')).length,1);
 assert.equal(readFileSync(join(ws.shelf_dir('old'),'chart.html'),'utf8'),html);
});

test('existing HTML and image content in the destination topic are reused', async t => {
 const ws=setup(t);
 for (const shelf of ['old','new']) writeFileSync(join(ws.shelf_dir(shelf),'same.html'),'<p>Same</p>');
 writeFileSync(ws.qmd('past'),'---\ntopic: old\n---\n\n## HTML\n\n<iframe src="html/same.html"></iframe>\n');
 const hit=searchSlides(ws,'HTML').results[0]!;
 assert.match((await takeSlide(ws,'now','past',hit.page,hit.version)).text,/src="html\/same.html"/);
 assert.equal(readdirSync(ws.shelf_dir('new')).filter(n=>n.startsWith('import-')).length,0);
});
