import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request, RequestBridge } from '../../packages/ai/src/bridge.js';

test('sandbox bridge correlates concurrent requests and removes accepted request files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-bridge-files-'));
  const bridge = await new RequestBridge(root, async body => { await new Promise(r => setTimeout(r, Number(body.delay))); return {answer: body.id}; }).start();
  t.after(async () => { await bridge.close(); await rm(root, {recursive: true, force: true}); });
  const replies = await Promise.all([request(root, {id: 1, delay: 30}), request(root, {id: 2, delay: 0})]);
  assert.deepEqual(replies, [{answer: 1}, {answer: 2}]);
  assert.deepEqual(await readdir(join(root, '.slide-studio/requests')), []);
});

test('bridge times out without a host and refuses a symlink request directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-bridge-missing-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  assert.equal(await request(root, {deck: 'none'}, {acceptMs: 10}), null);
  assert.deepEqual(await readdir(join(root, '.slide-studio/requests')), []);
  await rm(join(root, '.slide-studio/requests'), {recursive: true});
  await mkdir(join(root, 'elsewhere'));
  await symlink(join(root, 'elsewhere'), join(root, '.slide-studio/requests'));
  await assert.rejects(request(root, {}), /シンボリックリンク/);
});

test('client cancellation reaches an accepted operation and removes its response files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'studio-bridge-cancel-'));let began=false,aborted=false;
 const bridge=await new RequestBridge(root,async(_body,signal)=>{began=true;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return {answer:'cancelled'};}).start();
 t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true});});
 const controller=new AbortController(),pending=request(root,{operation:'consult'},{signal:controller.signal});
 while(!began)await new Promise(r=>setTimeout(r,10));controller.abort();await assert.rejects(pending,/取り消し/);
 for(let i=0;i<100&&(!aborted||bridge.busy);i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(aborted,true);assert.equal(bridge.busy,false);assert.deepEqual(await readdir(join(root,'.slide-studio/requests')),[]);
});
