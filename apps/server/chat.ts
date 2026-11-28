import type { Workspace } from '../../packages/core/src/workspace.js';
import { ChatStore } from '../../packages/core/src/chat-store.js';
import { AIStatus } from '../../packages/ai/src/status.js';
import { Providers, IDS, type ProviderId } from '../../packages/ai/src/providers.js';
import { Runtime } from '../../packages/ai/src/runtime.js';
import { Logins } from '../../packages/ai/src/login.js';
import { Workflow, RunConflict, type Check, type Runner } from '../../packages/ai/src/workflow.js';
import type { Mode } from '../../packages/core/src/ai-roles.js';
import type { FeatureRequest, FeatureResponse } from '../../packages/contracts/src/server.js';

export class ChatService {
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
  private startTimer?: NodeJS.Timeout;
  private automaticUpdate: Promise<void> | null = null;
  /** Workspace of the latest request; used to send a complete model list with `ai-status`. */
  private current?: Workspace;
  constructor(private options: {storage: string; broadcast: (event: Record<string, unknown>) => void; saveScript: (ws: Workspace, deck: string, base: string, text: string, signal: AbortSignal) => Promise<void>; providers?: Providers; runner?: Runner; openExternal?: (url: string) => Promise<boolean>; check: (ws: Workspace, deck: string, mode: Mode) => Promise<Check>; reviewContext?: (ws: Workspace, deck: string, mode: Mode) => Promise<unknown>; changed: (ws: Workspace, paths: string[]) => void; runtime?: (providers: Providers, id: ProviderId) => Runtime; idleUpdate?: {delayMs: number; intervalMs: number} | null}) {
    this.status = new AIStatus(options.providers ?? new Providers(options.storage), options.broadcast);
    for (const id of IDS) this.runtimes.set(id, options.runtime?.(this.status.providers, id) ?? new Runtime(this.status.providers, id));
    this.logins = new Logins(this.status.providers, id => this.runtimes.get(id)!, {openExternal: options.openExternal ?? (async () => false), changed: () => this.refreshStatus()});
    // Injected providers mean a test; those opt in to the idle update explicitly.
    const idle = options.idleUpdate !== undefined ? options.idleUpdate : options.providers ? null : {delayMs: 5000, intervalMs: 60000};
    if (idle) {
      const tick = () => {
        if (this.closed || this.busy || this.automaticUpdate) return;
        this.automaticUpdate = this.updateIdleRuntimes().finally(() => { this.automaticUpdate = null; });
      };
      // Shortly after launch as well, so an outdated CLI does not hide new models for the first minute.
      this.startTimer = setTimeout(tick, idle.delayMs);
      this.updateTimer = setInterval(tick, idle.intervalMs);
      this.startTimer.unref(); this.updateTimer.unref();
    }
  }
  private async updateIdleRuntimes() {
    for (const runtime of this.runtimes.values()) {
      if (this.closed || this.busy) return;
      try { if (await runtime.automatic(this.controller.signal)) await this.refreshStatus(); }
      catch { /* Runtime retains its previous executable and reports the failure. */ }
    }
  }
  /** Re-detect models after a runtime or login change and push `ai-status` to open screens. */
  private async refreshStatus() {
    this.status.invalidate();
    if (this.closed) return;
    try { await this.status.refresh(this.current); } catch { /* The next status read detects again. */ }
  }
  get busy() { return this.active > 0 || [...this.workflows.values()].some(w => w.busy); }
  workflow(ws: Workspace) {
    let workflow = this.workflows.get(ws);
    if (!workflow) {
      workflow = new Workflow(ws, this.store(ws), this.status, {runner: this.options.runner, saveScript: (deck, base, text, signal) => this.options.saveScript(ws, deck, base, text, signal), check: (deck, mode) => this.options.check(ws, deck, mode), reviewContext: (deck, mode) => this.options.reviewContext?.(ws, deck, mode) ?? Promise.resolve(null), changed: paths => this.options.changed(ws, paths)});
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
        // 検出前は載せない。画面は /api/ai/status の結果を待って「確かめています…」を出す
        status: () => this.status.known(ws), broadcast: this.options.broadcast,
      });
      this.stores.set(ws, store);
    }
    return store;
  }
  async forget(ws: Workspace) {
    if (this.workflows.get(ws)?.busy) throw Error('AI の作業が終わってから操作してください');
    await this.workflows.get(ws)?.close();
    this.workflows.delete(ws);
    if (this.current === ws) this.current = undefined;
    await this.stores.get(ws)?.flush();
    this.stores.delete(ws);
  }
  handle(ws: Workspace, req: FeatureRequest): Promise<FeatureResponse | null> {
    if (!['/api/ai/status', '/api/ai/favorites', '/api/ai/runtimes'].includes(req.pathname) && !/^\/api\/ai\/[^/]+\/(?:login|runtime)$/u.test(req.pathname) && !/^\/api\/deck\/[^/]+\/chat(?:\/open|\/tabs(?:\/[^/]+(?:\/send)?)?|\/rounds\/[^/]+\/(?:continue|cancel|restore|handoff))?$/u.test(req.pathname)) return Promise.resolve(null);
    if (this.closed) return Promise.resolve({status: 503, body: {error: 'アプリを終了しています'}});
    this.current = ws;
    // Provider probes do not own workspace data. They must not hold draft
    // saves or workspace selection behind a slow metadata endpoint.
    if (req.pathname.startsWith('/api/ai/') && ['GET', 'HEAD'].includes(req.method)) return this.run(ws, req);
    const mutation = !['GET', 'HEAD'].includes(req.method);
    if (mutation) this.active++;
    const request = this.tail.then(() => this.run(ws, req)).finally(() => { if (mutation) this.active--; });
    this.tail = request.catch(() => {});
    return request;
  }
  private async run(ws: Workspace, req: FeatureRequest): Promise<FeatureResponse> {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    try {
      if (req.pathname === '/api/ai/status') return {body: await this.status.read(ws, req.query.has('refresh'))};
      if (req.pathname === '/api/ai/favorites') return {body: this.status.favorites(ws, body.favorites)};
      if (req.pathname === '/api/ai/runtimes') {
        if (req.query.has('refresh')) await Promise.allSettled([...this.runtimes.values()].filter(r => !r.overridden).map(r => r.check(this.controller.signal)));
        return {body: {ai: await Promise.all([...this.runtimes.values()].map(r => r.info(req.query.has('refresh'), this.controller.signal)))}};
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
          if (body.action === 'rollback') { await runtime.rollback(); void this.refreshStatus(); }
          else if (body.action === 'update') void runtime.update(true, this.controller.signal).then(() => this.refreshStatus()).catch(() => {});
          else throw Error('操作を確かめてください');
        }
        return {body: await runtime.info(false, this.controller.signal)};
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
    if(this.startTimer)clearTimeout(this.startTimer);
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
