import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import test,{type TestContext} from 'node:test';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import * as snapshots from '../../packages/core/src/legacy-snapshot.js';
function fixture(t:TestContext){const root=mkdtempSync(join(tmpdir(),'snapshots-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const ws=Workspace.open(join(root,'ws'));ws.new_deck('talk','test');return ws;}
test('snapshots preserve source and detect outside/material changes without copying materials',async t=>{
 const ws=fixture(t),before=readFileSync(ws.qmd('talk')),materials=join(ws.deck_dir('talk'),'materials');mkdirSync(materials);writeFileSync(join(materials,'large.pdf'),'before');
 const snap=await snapshots.take(ws,'talk');assert.equal(existsSync(join(snap.path,'files/decks/talk/materials')),false);
 writeFileSync(ws.qmd('talk'),'edited');writeFileSync(join(materials,'large.pdf'),'new material');writeFileSync(join(ws.root,'outside.txt'),'outside');writeFileSync(join(ws.deck_dir('talk'),'new.txt'),'new');
 const changes=await snapshots.finish(ws,snap);assert.ok(changes.modified.includes('decks/talk/slides.qmd'));assert.ok(changes.outside.includes('decks/talk/materials/large.pdf'));assert.ok(changes.outside.includes('outside.txt'));
 writeFileSync(ws.qmd('talk'),'later edit');assert.ok(snapshots.restore_plan(ws,snap).later.includes('decks/talk/slides.qmd'));
 snapshots.restore_run(ws,snap);assert.deepEqual(readFileSync(ws.qmd('talk')),before);assert.equal(existsSync(join(ws.deck_dir('talk'),'new.txt')),false);assert.equal(readFileSync(join(materials,'large.pdf'),'utf8'),'new material');assert.equal(readFileSync(join(ws.root,'outside.txt'),'utf8'),'outside');
 assert.equal(snapshots.find(ws,'talk',basename(snap.path)).path,snap.path);
});
test('partial restore keeps user edits and changes made after the run in unrelated files',async t=>{
 const ws=fixture(t),memo=join(ws.deck_dir('talk'),'memo.md');writeFileSync(memo,'before');const snap=await snapshots.take(ws,'talk');writeFileSync(memo,'AI draft');writeFileSync(ws.qmd('talk'),'AI slides');await snapshots.finish(ws,snap);writeFileSync(join(ws.deck_dir('talk'),'later.txt'),'user later');
 const plan=snapshots.restore_run(ws,snap,null,new Set(['decks/talk/slides.qmd']));assert.deepEqual(plan.kept,['decks/talk/slides.qmd']);assert.equal(readFileSync(memo,'utf8'),'before');assert.equal(readFileSync(ws.qmd('talk'),'utf8'),'AI slides');assert.equal(readFileSync(join(ws.deck_dir('talk'),'later.txt'),'utf8'),'user later');
});
test('restore preflights source links and malformed manifests before changing files',async t=>{
 const ws=fixture(t),snap=await snapshots.take(ws,'talk');writeFileSync(ws.qmd('talk'),'changed');const saved=join(snap.path,'files/decks/talk/slides.qmd');rmSync(saved);symlinkSync(ws.qmd('talk'),saved);assert.throws(()=>snapshots.restore(ws,snap),/シンボリックリンク/);assert.equal(readFileSync(ws.qmd('talk'),'utf8'),'changed');
 writeFileSync(join(snap.path,'manifest.json'),JSON.stringify({'decks/talk/../../outside':'hash'}));assert.throws(()=>snapshots.changes(ws,snap),/パス/);assert.equal(readFileSync(ws.qmd('talk'),'utf8'),'changed');
});
test('snapshot manifest hashes links themselves and rejects a linked state directory',async t=>{
 const ws=fixture(t),link=join(ws.deck_dir('talk'),'external');symlinkSync('/unavailable',link);const one=snapshots.manifest(ws);rmSync(link);symlinkSync('/different',link);assert.notEqual(one['decks/talk/external'],snapshots.manifest(ws)['decks/talk/external']);symlinkSync(ws.deck_dir('talk'),join(ws.state,'snapshots'));await assert.rejects(snapshots.take(ws,'talk'),/シンボリックリンク/);
});
