import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatService } from '../../apps/server/chat.js';
import { AIStatus } from '../../packages/ai/src/status.js';
import { Providers, type ProviderStatus } from '../../packages/ai/src/providers.js';
import type { Runtime } from '../../packages/ai/src/runtime.js';
import type { Workspace } from '../../packages/core/src/workspace.js';

const ws = {prefs: () => ({}), set_prefs() {}} as unknown as Workspace;
const codex = (models: string[]): ProviderStatus => ({id: 'codex', name: 'Codex', ok: true, reason: '', message: '', models: models.map(id => ({id, name: id, efforts: [], effort: null, context: null})), default: models[0] ?? null});

/** Detection never executes a CLI; each probe returns the next model list. */
class FakeProviders extends Providers {
  probes = 0;
  constructor(root: string, private lists: string[][]) { super(root, {PATH: ''}); }
  override async detectAll() { await delay(5); return [codex(this.lists[Math.min(this.probes++, this.lists.length - 1)]!)]; }
}

async function until(t: TestContext, condition: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() > end) assert.fail('timed out'); await delay(5); }
}

async function setup(t: TestContext, options: {idleUpdate?: {delayMs: number; intervalMs: number} | null; automatic?: () => Promise<boolean>; update?: () => Promise<string>}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-idle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const events: Record<string, unknown>[] = [];
  let calls = 0;
  const runtime = {overridden: false, busy: false,
    automatic: async () => { calls++; return await (options.automatic?.() ?? Promise.resolve(false)); },
    update: options.update ?? (async () => '/managed/codex'), info: async () => ({}), close: async () => {}} as unknown as Runtime;
  const providers = new FakeProviders(root, [['gpt-old'], ['gpt-old', 'gpt-6.2-astra']]);
  const chat = new ChatService({storage: root, broadcast: event => events.push(event), saveScript: async () => {}, providers, check: async () => { throw Error('unused'); }, changed() {}, runtime: () => runtime, idleUpdate: options.idleUpdate});
  t.after(() => chat.close());
  return {chat, events, providers, calls: () => calls};
}

test('idle runtime update runs shortly after launch and announces the refreshed model list', async t => {
  let first = true;
  const f = await setup(t, {idleUpdate: {delayMs: 20, intervalMs: 60000}, automatic: async () => { const changed = first; first = false; return changed; }});
  assert.equal(f.calls(), 0);
  await until(t, () => f.calls() === 2 && f.events.some(e => e.type === 'ai-status'));
  await delay(20);
  const events = f.events.filter(e => e.type === 'ai-status');
  assert.equal(events.length, 1, 'only the runtime that changed triggers a refresh');
  // No request has named a workspace yet: screens fetch /api/ai/status themselves.
  assert.deepEqual(events[0], {type: 'ai-status'});
});

test('injected providers do not start the idle update unless asked', async t => {
  const f = await setup(t, {});
  await delay(40);
  assert.equal(f.calls(), 0);
});

test('a finished manual update re-detects models and pushes them with ai-status', async t => {
  let finish!: (path: string) => void;
  const f = await setup(t, {idleUpdate: null, update: () => new Promise(resolve => { finish = resolve; })});
  const before = await f.chat.handle(ws, {method: 'GET', pathname: '/api/ai/status', query: new URLSearchParams(), body: null} as never);
  assert.deepEqual((before!.body as {providers: ProviderStatus[]}).providers[0]!.models.map(m => m.id), ['gpt-old']);
  await f.chat.handle(ws, {method: 'POST', pathname: '/api/ai/codex/runtime', query: new URLSearchParams(), body: {action: 'update'}} as never);
  assert.equal(f.events.length, 0);
  finish('/managed/codex');
  await until(t, () => f.events.some(e => e.type === 'ai-status'));
  const event = f.events.find(e => e.type === 'ai-status') as {ai: {providers: ProviderStatus[]; default: string}};
  assert.deepEqual(event.ai.providers[0]!.models.map(m => m.id), ['gpt-old', 'gpt-6.2-astra']);
  assert.equal(event.ai.default, 'codex:gpt-old');
});

test('status refresh does not reuse a probe that started before the executable changed', async () => {
  const providers = new FakeProviders('/unused', [['gpt-old'], ['gpt-6.2-astra']]), events: Record<string, unknown>[] = [];
  const status = new AIStatus(providers, event => events.push(event));
  const stale = status.read(ws);
  await status.refresh(ws);
  assert.deepEqual((await stale).providers[0]!.models.map(m => m.id), ['gpt-old']);
  assert.equal(providers.probes, 2);
  assert.deepEqual((events[0] as {ai: {providers: ProviderStatus[]}}).ai.providers[0]!.models.map(m => m.id), ['gpt-6.2-astra']);
  assert.deepEqual(status.cached(ws).providers[0]!.models.map(m => m.id), ['gpt-6.2-astra']);
  await status.close();
});

test('status is unknown before the first detection so screens keep waiting instead of showing no AI', async () => {
  const status = new AIStatus(new FakeProviders('/unused', [['gpt-old']]));
  assert.equal(status.known(ws), null);
  await status.read(ws);
  assert.deepEqual(status.known(ws)?.providers[0]!.models.map(m => m.id), ['gpt-old']);
  await status.close();
});
