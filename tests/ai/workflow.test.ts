import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { ChatStore } from '../../packages/core/src/legacy-chat-store.js';
import { AIStatus } from '../../packages/ai/src/status.js';
import { Providers, type ProviderStatus } from '../../packages/ai/src/providers.js';
import { Workflow, type Check, type Runner, type Round } from '../../packages/ai/src/workflow.js';
class FakeProviders extends Providers {
  override async detectAll(): Promise<ProviderStatus[]> {
    return [{id: 'codex', name: 'Fixture', ok: true, reason: '', message: '', default: 'fixture', models: [{id: 'fixture', name: 'Fixture', efforts: ['medium'], effort: 'medium', context: 100000}]}];
  }
}
function fixture(t: TestContext, runner: Runner, check: () => Promise<Check> = async () => ({errors: [], warnings: []})) {
  const root = mkdtempSync(join(tmpdir(), 'studio-workflow-'));
  const ws = Workspace.open(join(root, 'workspace')); ws.new_deck('demo', 'topic');
  const status = new AIStatus(new FakeProviders(join(root, 'ai')));
  const store = new ChatStore(ws, {providerOf: key => status.providerOf(key), defaultModel: () => status.cached(ws).default, status: () => status.cached(ws), broadcast() {}});
  const workflow = new Workflow(ws, store, status, {runner, check, changed() {}});
  t.after(async () => { try { await workflow.close(); } finally { rmSync(root, {recursive: true, force: true}); } });
  const base = () => createHash('sha256').update(readFileSync(ws.qmd('demo'))).digest('hex');
  const send = () => workflow.send('demo', store.state('demo').tabs[0]!.id, {base: base(), items: [{key: 'deck', text: '直してください'}]});
  return {ws, status, store, workflow, base, send};
}
async function settled(round: Round) {
  const deadline = Date.now() + 4000;
  while (['run', 'check', 'review'].includes(round.state)) {
    if (Date.now() > deadline) throw Error('workflow did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const final = {summary: '完了', results: [{item: 1, ok: true, text: '直しました'}], questions: []};

test('continuing an interrupted review checks prior edits without repeating the editor', async t => {
  let edits = 0, reviews = 0;
  const f = fixture(t, async (_id, ws, options) => {
    if (options.role === 'review') {
      if (++reviews === 1) throw Error('review disconnected');
      assert.match(options.prompt, /decks\/demo\/slides.qmd/);
      return {final: {summary: '確認済み', issues: []}};
    }
    edits++;
    writeFileSync(ws.qmd('demo'), readFileSync(ws.qmd('demo'), 'utf8') + '\n<!-- once -->\n');
    return {final};
  });
  const round = await f.send(); await settled(round); assert.equal(round.state, 'error');
  const continued = await f.workflow.continue('demo', round.id, f.base()); await settled(continued);
  assert.equal(continued.state, 'done'); assert.equal(continued.review_only, true);
  assert.equal(edits, 1); assert.equal(reviews, 2); assert.equal(continued.review_ok, true);
});

test('one accepted run retains editor, check repair, review repair and final snapshot together', async t => {
  let edits = 0, reviews = 0;
  const f = fixture(t, async (_id, ws, options) => {
    options.onEvent({session: options.role === 'review' ? 'review-session' : 'editor-session'});
    if (options.role === 'review') {
      assert.equal(options.readonly, true);
      return {final: {summary: '確認', issues: ++reviews === 1 ? [{target: 'deck', message: '直す箇所', suggestion: '直す'}] : []}};
    }
    edits++;
    writeFileSync(ws.qmd('demo'), readFileSync(ws.qmd('demo'), 'utf8') + `\n<!-- edit ${edits} -->\n`);
    options.onEvent({step: {id: 'edit', kind: 'file', text: 'slides.qmd'}});
    return {final};
  }, async () => ({errors: edits === 1 ? [{kind: 'layout', message: 'new overflow'}] : [], warnings: []}));
  const round = await f.send(); await settled(round);
  assert.equal(round.state, 'done'); assert.equal(edits, 3); assert.equal(reviews, 2);
  assert.equal((round.fixes as unknown[]).length, 1); assert.equal((round.review_fixes as unknown[]).length, 1);
  assert.ok(round.snapshot); assert.ok(round.files?.modified.includes('decks/demo/slides.qmd'));
  assert.equal(round.agents.length, 5); assert.equal(round.review_ok, true);
  await f.store.flush();
  const saved = JSON.parse(readFileSync(join(f.ws.state, 'chat/demo.json'), 'utf8'));
  assert.equal(saved.rounds[0].state, 'done');
});

test('cancel retains partial edits, persists cancellation, and continuation resumes the same session', async t => {
  let calls = 0;
  const f = fixture(t, async (_id, ws, options) => {
    calls++;
    if (calls === 1) {
      options.onEvent({session: 'kept-session'});
      writeFileSync(ws.qmd('demo'), readFileSync(ws.qmd('demo'), 'utf8') + '\n<!-- partial -->\n');
      await new Promise<void>((_, reject) => options.signal!.addEventListener('abort', () => reject(Error('cancelled')), {once: true}));
    }
    assert.equal(options.session, 'kept-session');
    return {final};
  });
  const tab = f.store.state('demo').tabs[0]!; tab.ai_roles.review = {enabled: false};
  const round = await f.send();
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
  await f.workflow.cancel('demo', round.id);
  assert.equal(round.state, 'cancelled'); assert.ok(round.files?.modified.length);
  const next = await f.workflow.continue('demo', round.id, f.base()); await settled(next);
  assert.equal(next.state, 'done'); assert.equal(next.continued_from, round.id);
});

test('stale send leaves drafts intact and talk runs do not acquire an edit lock or snapshot', async t => {
  let release!: () => void;
  const f = fixture(t, async (_id, _ws, options) => {
    assert.equal(options.readonly, true);
    await new Promise<void>(resolve => { release = resolve; });
    return {final: {summary: '回答', questions: []}};
  });
  const tab = f.store.state('demo').tabs[0]!; tab.drafts = {deck: '保存する'};
  await assert.rejects(f.workflow.send('demo', tab.id, {base: 'stale', items: [{key: 'deck', text: '依頼'}]}), /原稿が変わって/);
  assert.deepEqual(tab.drafts, {deck: '保存する'});
  const round = await f.workflow.send('demo', tab.id, {base: f.base(), items: [{key: 'deck', text: '質問'}], talk: true});
  assert.equal(f.store.public('demo').locked, false);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  release(); await settled(round);
  assert.equal(round.snapshot, null); assert.equal(round.summary, '回答');
});

test('a new instruction after cancellation carries prior targets forward in the same tab', async t => {
  let calls=0;
  const f=fixture(t,async(_id,_ws,options)=>{
    if(++calls===1) await new Promise<void>((_,reject)=>options.signal!.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
    assert.match(options.prompt,/直してください/);assert.match(options.prompt,/追加の修正/);
    return {final};
  });
  const tab=f.store.state('demo').tabs[0]!;tab.ai_roles.review={enabled:false};
  const first=await f.send();while(!calls)await new Promise(resolve=>setTimeout(resolve,5));await f.workflow.cancel('demo',first.id);
  const next=await f.workflow.send('demo',tab.id,{base:f.base(),items:[{key:'deck',text:'追加の修正'}]});await settled(next);
  assert.equal(next.state,'done');assert.equal(next.resumed_from,first.id);assert.equal(next.items.length,2);
});
