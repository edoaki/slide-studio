import type { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { ChatStore } from '../../packages/core/src/legacy-chat-store.js';
import { AIStatus } from '../../packages/ai/src/status.js';
import { Providers, IDS, type ProviderId } from '../../packages/ai/src/providers.js';
import { Runtime } from '../../packages/ai/src/runtime.js';
import { Logins } from '../../packages/ai/src/login.js';
import { Workflow, RunConflict, type Check, type Runner } from '../../packages/ai/src/workflow.js';
import type { Mode } from '../../packages/core/src/legacy-ai-roles.js';
import type { LegacyFeatureRequest, LegacyFeatureResponse } from '../../packages/contracts/src/legacy.js';

export class LegacyChat {
  readonly status: AIStatus;
  private stores = new Map<Workspace, ChatStore>();
  private workflows = new Map<Workspace, Workflow>();
  private tail: Promise<unknown> = Promise.resolve();
  private active = 0;
  private closed = false;
  private runtimes = new Map<ProviderId, Runtime>();
  private logins: Logins;
  private controller = new AbortController();
  private updateTimer?: NodeJS.Timeout;
  private automaticUpdate: Promise<void> | null = null;
  constructor(private options: {storage: string; broadcast: (event: Record<string, unknown>) => void; providers?: Providers; runner?: Runner; openExternal?: (url: string) => Promise<boolean>; check: (ws: Workspace, deck: string, mode: Mode) => Promise<Check>; reviewContext?: (ws: Workspace, deck: string, mode: Mode) => Promise<unknown>; changed: (ws: Workspace, paths: string[]) => void}) {
    this.status = new AIStatus(options.providers ?? new Providers(options.storage), options.broadcast);
    for (const id of IDS) this.runtimes.set(id, new Runtime(this.status.providers, id));
    this.logins = new Logins(this.status.providers, id => this.runtimes.get(id)!, {openExternal: options.openExternal ?? (async () => false), changed: () => this.status.invalidate()});
    if (!options.providers) {
      this.updateTimer = setInterval(() => {
        if (this.closed || this.busy || this.automaticUpdate) return;
        this.automaticUpdate = this.updateIdleRuntimes().finally(() => { this.automaticUpdate = null; });
      }, 60000);
      this.updateTimer.unref();
    }
  }
  private async updateIdleRuntimes() {
    for (const runtime of this.runtimes.values()) {
      const state=runtime.state();
      if(this.closed||this.busy) return;
      if(runtime.overridden||runtime.busy||!state.current||!state.auto||Date.now()/1000-state.checked<86400)continue;
      try {await runtime.update(false,this.controller.signal);this.status.invalidate();} catch { /* Runtime retains its previous executable and reports the failure. */ }
    }
  }
  get busy() { return this.active > 0 || [...this.workflows.values()].some(w => w.busy); }
  workflow(ws: Workspace) {
    let workflow = this.workflows.get(ws);
    if (!workflow) {
      workflow = new Workflow(ws, this.store(ws), this.status, {runner: this.options.runner, check: (deck, mode) => this.options.check(ws, deck, mode), reviewContext: (deck, mode) => this.options.reviewContext?.(ws, deck, mode) ?? Promise.resolve(null), changed: paths => this.options.changed(ws, paths)});
      this.workflows.set(ws, workflow);
    }
    return workflow;
  }
  existing(ws: Workspace) { return this.workflows.get(ws); }
  store(ws: Workspace) {
    let store = this.stores.get(ws);
    if (!store) {
      store = new ChatStore(ws, {
        providerOf: key => this.status.providerOf(key),
        defaultModel: () => this.status.cached(ws).default,
        status: () => this.status.cached(ws), broadcast: this.options.broadcast,
      });
      this.stores.set(ws, store);
    }
    return store;
  }
  async forget(ws: Workspace) {
    if (this.workflows.get(ws)?.busy) throw Error('AI の作業が終わってから操作してください');
    await this.workflows.get(ws)?.close();
    this.workflows.delete(ws);
    await this.stores.get(ws)?.flush();
    this.stores.delete(ws);
  }
  handle(ws: Workspace, req: LegacyFeatureRequest): Promise<LegacyFeatureResponse | null> {
    if (!['/api/ai/status', '/api/ai/favorites', '/api/ai/runtimes'].includes(req.pathname) && !/^\/api\/ai\/[^/]+\/(?:login|runtime)$/u.test(req.pathname) && !/^\/api\/deck\/[^/]+\/chat(?:\/open|\/tabs(?:\/[^/]+(?:\/send)?)?|\/rounds\/[^/]+\/(?:continue|cancel|restore|handoff))?$/u.test(req.pathname)) return Promise.resolve(null);
    if (this.closed) return Promise.resolve({status: 503, body: {error: 'アプリを終了しています'}});
    // Provider probes do not own workspace data. They must not hold draft
    // saves or workspace selection behind a slow metadata endpoint.
    if (req.pathname.startsWith('/api/ai/') && ['GET', 'HEAD'].includes(req.method)) return this.run(ws, req);
    const mutation = !['GET', 'HEAD'].includes(req.method);
    if (mutation) this.active++;
    const request = this.tail.then(() => this.run(ws, req)).finally(() => { if (mutation) this.active--; });
    this.tail = request.catch(() => {});
    return request;
  }
  private async run(ws: Workspace, req: LegacyFeatureRequest): Promise<LegacyFeatureResponse> {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    try {
      if (req.pathname === '/api/ai/status') return {body: await this.status.read(ws, req.query.has('refresh'))};
      if (req.pathname === '/api/ai/favorites') return {body: this.status.favorites(ws, body.favorites)};
      if (req.pathname === '/api/ai/runtimes') {
        if (req.query.has('refresh')) await Promise.allSettled([...this.runtimes.values()].filter(r => !r.overridden).map(r => r.check(this.controller.signal)));
        return {body: {ai: [...this.runtimes.values()].map(r => r.info())}};
      }
      const ai = /^\/api\/ai\/([^/]+)\/(login|runtime)$/u.exec(req.pathname);
      if (ai) {
        const id = ai[1] as ProviderId;
        if (!IDS.includes(id)) throw Error('この AI は使えません');
        if (ai[2] === 'login') return {body: req.method === 'POST' ? this.logins.start(id, body.download === true) : this.logins.state(id)};
        if (req.method !== 'POST') return {status: 405, body: {error: '許可されていない操作です'}};
        const runtime = this.runtimes.get(id)!;
        if ('auto' in body) {
          if (typeof body.auto !== 'boolean') throw Error('操作が正しくありません');
          await runtime.setAuto(body.auto);
        } else {
          if ([...this.workflows.values()].some(w => w.busy)) throw Error('AI の作業中は変更できません');
          if (body.action === 'rollback') { await runtime.rollback(); this.status.invalidate(); }
          else if (body.action === 'update') void runtime.update(true, this.controller.signal).then(() => this.status.invalidate()).catch(() => {});
          else throw Error('操作を確かめてください');
        }
        return {body: runtime.info()};
      }
      const route = /^\/api\/deck\/([^/]+)\/chat(?:\/(open|tabs|rounds)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/u.exec(req.pathname)!;
      const deck = decodeURIComponent(route[1]!), store = this.store(ws);
      ws.require_deck(deck);
      if (route[4]) {
        const workflow = this.workflow(ws), id = decodeURIComponent(route[3]!);
        if (route[2] === 'tabs' && route[4] === 'send' && req.method === 'POST') return {body: await workflow.send(deck, id, body)};
        if (route[2] === 'rounds') {
          if (route[4] === 'restore' && ['GET', 'HEAD'].includes(req.method)) return {body: workflow.restorePreview(deck, id)};
          if (req.method === 'POST') {
            if (route[4] === 'cancel') { await workflow.cancel(deck, id); return {body: {ok: true}}; }
            if (route[4] === 'continue') return {body: await workflow.continue(deck, id, body.base)};
            if (route[4] === 'restore') return {body: await workflow.restore(deck, id)};
            if (route[4] === 'handoff') return {body: await workflow.handoff(deck, id, body)};
          }
        }
        return {status: 405, body: {error: '許可されていない操作です'}};
      }
      if (!route[2] && ['GET', 'HEAD'].includes(req.method)) return {body: store.public(deck)};
      if (route[2] === 'open' && req.method === 'POST') return {body: await store.open_view(deck)};
      if (route[2] === 'tabs' && !route[3] && req.method === 'POST') return {body: await store.add_tab(deck, String(body.mode || 'slides'))};
      if (route[2] === 'tabs' && route[3] && req.method === 'PATCH') {
        if (['model', 'effort', 'ai_roles'].some(key => key in body)) await this.status.read(ws);
        return {body: await store.update_tab(deck, decodeURIComponent(route[3]), body)};
      }
      return {status: 405, body: {error: '許可されていない操作です'}};
    } catch (error) { return {status: error instanceof RunConflict ? 409 : 400, body: {error: error instanceof Error ? error.message : String(error)}}; }
  }
  async close() {
    this.closed = true;
    if(this.updateTimer)clearInterval(this.updateTimer);
    this.controller.abort();
    await this.logins.close();
    await this.status.close();
    await this.tail;
    await Promise.all([...this.workflows.values()].map(workflow => workflow.close()));
    await this.status.providers.pool.close();
    await Promise.all([...this.stores.values()].map(store => store.flush()));
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.close()));
    await this.automaticUpdate;
  }
}
