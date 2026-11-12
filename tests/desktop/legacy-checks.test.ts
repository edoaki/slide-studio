import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { parse } from '../../packages/core/src/legacy-source.js';
import { readAsset } from '../../packages/core/src/assets.js';
import { static_issues } from '../../apps/server/legacy-output.js';
import type { LegacyRendered } from '../../packages/contracts/src/legacy.js';

test('static checks retain placeholder, missing-image, external-image and required-theme diagnostics', t => {
  const root=mkdtempSync(join(tmpdir(),'studio-static-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const ws=Workspace.open(root);ws.new_deck('talk','topic');
  const placeholders=JSON.parse(/export const PAGE_PLACEHOLDERS = (\{[\s\S]*?\});/u.exec(readAsset('strings.js'))![1]!);
  const source=`---\ntitle: Test\ntopic: topic\ntheme: broken\n---\n\n## Test {#test}\n\n${Object.values(placeholders)[0]}\n\n![](images/missing.png)\n\n![](https://example.invalid/image.png)\n`;
  writeFileSync(join(ws.themes,'broken.css'),':root { --unrelated: red; }');
  const rendered={doc:parse(source),slides:[{index:0,page:0}],missing_cites:[],cited:[],unsupported:[],warnings:[]} as unknown as LegacyRendered;
  const issues=static_issues(ws,'talk',rendered);
  for(const kind of ['placeholder','missing','external','theme'])assert.ok(issues.some(i=>i.kind===kind),kind);
  assert.equal(issues.find(i=>i.kind==='placeholder')?.level,'warning');
  assert.equal(issues.find(i=>i.kind==='missing')?.resource,'/topics/topic/images/missing.png');
});
