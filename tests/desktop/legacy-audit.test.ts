import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { LegacyOutput } from '../../apps/server/legacy-output.js';
import * as audit from '../../apps/server/legacy-audit.js';
import {argumentsOf, runCommand} from '../../apps/cli/commands.js';

async function fixture(t: TestContext, error = false) {
  const root = await mkdtemp(join(tmpdir(), 'studio-audit-')); t.after(() => rm(root, {recursive: true, force: true}));
  const ws = Workspace.open(root); ws.new_deck('talk', 'test');
  const output = {audit: async () => ({pages: [{index: 0, id: 'intro'}], result: {checked_at: 1, errors: error ? [{level: 'error', kind: 'layout', message: 'overflow', slide: 0, step: 0}] : [], warnings: [{level: 'warning', kind: 'layout', message: 'small', slide: 0, step: 0}]}, inspection: {screenshots: [{slide: 0, step: 0, bytes: Buffer.from('image-0')}, {slide: 0, step: 1, bytes: Buffer.from('image-1')}]}})} as unknown as LegacyOutput;
  const report = await audit.run(ws, 'talk', output);
  const review = {reviewer: 'fixture', states: report.states.map(s => ({id: s.id, note: '文字と図を確認'})), decisions: report.issues.map(i => ({id: i.id, decision: 'accepted', reason: '確認済み'})), visual_issues: []};
  return {ws, report, review};
}
test('audit needs every image and issue reviewed before completion, and detects stale source', async t => {
  const {ws, report, review} = await fixture(t);
  assert.equal(report.status, 'needs_review'); assert.equal(report.states.length, 2);
  await assert.rejects(audit.review(ws, 'talk', report.audit_id, {...review, states: review.states.slice(0, 1)}), /全画像/);
  const done = await audit.review(ws, 'talk', report.audit_id, review);
  assert.equal(done.complete, true);
  await writeFile(ws.qmd('talk'), (await readFile(ws.qmd('talk'), 'utf8')) + '\n追記\n');
  assert.equal(audit.status(ws, 'talk', report.audit_id).status, 'stale');
});
test('audit cannot approve machine errors or accept changed image bytes', async t => {
  const {ws, report, review} = await fixture(t, true);
  assert.equal(report.status, 'needs_fix');
  await assert.rejects(audit.review(ws, 'talk', report.audit_id, review), /承認できません/);
  await writeFile(report.states[0]!.image, 'changed');
  assert.equal(audit.status(ws, 'talk', report.audit_id).status, 'stale');
  assert.throws(() => audit.status(ws, 'talk', '../escape'), /ID/);
});

test('legacy audit review --file reads review JSON and completes the stored audit', async t => {
  const {ws, report, review} = await fixture(t);
  const file=join(ws.root,'review.json');await writeFile(file,JSON.stringify(review));
  const args=argumentsOf(['audit','review','talk',report.audit_id,'--file',file]);
  assert.equal(await runCommand(ws,args,{pandocPath:'unused',inspect:async()=>{throw Error('Unexpected render');},diagnostics:async()=>[]}),0);
  assert.equal(audit.status(ws,'talk',report.audit_id).complete,true);
});
