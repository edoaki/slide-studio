import type { Workspace } from '../../core/src/legacy-workspace.js';
import { supported } from '../../core/src/legacy-ai-roles.js';
import { Providers, type ProviderStatus } from './providers.js';
import type { Limits } from './limits.js';

/** Shared detection promise avoids starting several CLI probes as a page opens. */
export class AIStatus {
  private found: ProviderStatus[] = [];
  private checked = 0;
  private pending: Promise<void> | null = null;
  private controller = new AbortController();
  constructor(readonly providers: Providers, private broadcast: (event:Record<string,unknown>)=>void = ()=>{}) {}
  saveLimits(ws: Workspace, id: string, limits: Limits) {
    if (!Object.keys(limits).length) return;
    const saved = ws.prefs().ai_limits as Record<string, Record<string,unknown>> | undefined ?? {};
    const next = {...saved, [id]: {...saved[id], ...limits, at: Math.floor(Date.now()/1000)}};
    ws.set_prefs({ai_limits:next});this.broadcast({type:'ai-limits',limits:next});
  }

  cached(ws: Workspace) {
    const usable = this.found.filter(p => p.ok && p.default);
    const first = usable.find(p => p.id === 'codex') ?? usable[0];
    const preferred = first ? `${first.id}:${first.default}` : null;
    const stored = ws.prefs().ai_favorites;
    const limits = {...(ws.prefs().ai_limits as Record<string,unknown> ?? {})};
    for (const provider of this.found) if (provider.limits && typeof provider.limits === 'object' && Object.keys(provider.limits).length) limits[provider.id] = {...provider.limits, at: Math.floor(this.checked/1000)};
    return {
      providers: this.found, default: preferred,
      favorites: Array.isArray(stored) ? stored.filter(supported) : preferred ? [preferred] : [],
      favorites_limit: 12, limits,
    };
  }

  async read(ws: Workspace, refresh = false) {
    if (this.controller.signal.aborted) throw Error('アプリを終了しています');
    if (!this.pending && (refresh || Date.now() - this.checked > 300000)) {
      this.pending = this.providers.detectAll(this.controller.signal).then(found => {
        this.found = found;
        this.checked = Date.now();
      }).finally(() => { this.pending = null; });
    }
    await this.pending;
    return this.cached(ws);
  }

  providerOf(key: string) {
    const colon = key.indexOf(':');
    const provider = this.found.find(p => p.id === key.slice(0, colon));
    const model = provider?.models.find(m => m.id === key.slice(colon + 1));
    return {ok: provider?.ok === true, model: model ? {...model, key} : null};
  }

  favorites(ws: Workspace, value: unknown) {
    if (!Array.isArray(value) || value.some(k => typeof k !== 'string' || !k.includes(':') || k.length >= 200)) {
      throw Error('よく使うモデルの形式が正しくありません');
    }
    const favorites = [...new Set(value)];
    if (favorites.length > 12) throw Error('よく使うモデルは12個までです');
    ws.set_prefs({ai_favorites: favorites});
    return this.cached(ws);
  }

  invalidate() { this.checked = 0; }
  async close() { this.controller.abort(); await this.pending; }
}
