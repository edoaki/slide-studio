import assert from 'node:assert/strict';
import test from 'node:test';
import { Providers, IDS, AGY_DISABLED } from '../../packages/ai/src/providers.js';
import { nativeArgs, runNative, type NativeOptions } from '../../packages/ai/src/native.js';
import { Logins } from '../../packages/ai/src/login.js';
import { resolveRole, supported, ROLES } from '../../packages/core/src/ai-roles.js';
import type { Workspace } from '../../packages/core/src/workspace.js';

class NoAccessProviders extends Providers {
  override binary(): never { throw Error('must not discover or execute a CLI'); }
}

test('Antigravity is unavailable without probing its CLI or starting login/download', async () => {
  const providers = new NoAccessProviders('/unused');
  assert.deepEqual(IDS, ['codex', 'claude']);
  const status = await providers.detect('agy');
  assert.equal(status.ok, false);
  assert.equal(status.reason, 'policy');
  assert.equal(status.message, AGY_DISABLED);
  assert.deepEqual(status.models, []);
  const logins = new Logins(providers, () => { throw Error('must not prepare runtime'); }, {openExternal: async () => { throw Error('must not open login'); }, changed() {}});
  for (const download of [true, false]) assert.throws(() => logins.start('agy', download), {message: AGY_DISABLED});
  await logins.close();
});

test('every native role rejects Antigravity before touching workspace or CLI', async () => {
  const providers = new NoAccessProviders('/unused');
  for (const role of ROLES) {
    const options: NativeOptions = {role: role.id, prompt: 'question', model: 'old-model', readonly: role.readonly, web: role.web, onEvent() { throw Error('must not emit events'); }};
    // Deliberately absent: policy checks must happen before accessing workspace state.
    const ws = undefined as unknown as Workspace;
    assert.throws(() => nativeArgs('agy', ws, options), {message: AGY_DISABLED});
    await assert.rejects(runNative(providers, 'agy', ws, options), {message: AGY_DISABLED});
  }
});

test('saved Antigravity review/consult models cannot resolve even with stale metadata', () => {
  assert.equal(supported('agy:old-model'), false);
  for (const role of ['review', 'consult'] as const) {
    assert.throws(() => resolveRole(role, {model: 'codex:fixture'}, {[role]: {model: 'agy:old-model', enabled: true}}, () => { throw Error('must reject before metadata lookup'); }), /使える AI がありません/);
  }
});
