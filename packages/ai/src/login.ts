import { AppServerClient } from './app-server.js';
import { execute } from './process.js';
import { type ProviderId, type Providers } from './providers.js';
import type { Runtime } from './runtime.js';

type State = {status: 'preparing' | 'pending' | 'ready' | 'completed' | 'failed'; error?: string};
type Job = {state: State; since: number | null; controller: AbortController; task: Promise<void>; done: boolean};
export class Logins {
  private jobs = new Map<ProviderId, Job>();
  private closed = false;
  constructor(private providers: Providers, private runtime: (id: ProviderId) => Runtime, private options: {openExternal: (url: string) => Promise<boolean>; changed: () => void}) {}
  state(id: ProviderId) {
    const job = this.jobs.get(id);
    return job ? {...job.state, progress: this.runtime(id).progress, retry: !job.done && job.since !== null && Date.now() - job.since >= 5000} : {status: 'idle', retry: false};
  }
  start(id: ProviderId, download = false) {
    if (this.closed) throw Error('アプリを終了しています');
    const old = this.jobs.get(id);
    if (old && !old.done && !this.state(id).retry) return this.state(id);
    old?.controller.abort();
    const job: Job = {state: {status: 'preparing'}, since: null, controller: new AbortController(), task: Promise.resolve(), done: false};
    this.jobs.set(id, job);
    job.task = (async () => {
      await old?.task;
      try {
        const executable = await this.runtime(id).ensure(job.controller.signal);
        if (download) { job.state = {status: 'ready'}; this.options.changed(); return; }
        job.state = {status: 'pending'}; job.since = Date.now();
        const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(180000)]);
        await this.login(id, executable, signal);
        job.state = {status: 'completed'}; this.options.changed();
      } catch (error) { job.state = {status: 'failed', error: job.controller.signal.aborted ? 'ログインを中断しました' : error instanceof Error ? error.message : String(error)}; }
      finally { job.done = true; }
    })();
    return this.state(id);
  }
  private async login(id: ProviderId, executable: string, signal: AbortSignal) {
    const env = this.providers.environment(id);
    if (id === 'codex') {
      const client = await new AppServerClient({executable, args: ['app-server', '--listen', 'stdio://'], env, signal}).start();
      try {
        const {authUrl} = await client.call('account/login/start', {type: 'chatgpt'});
        if (typeof authUrl !== 'string' || new URL(authUrl).protocol !== 'https:') throw Error('ログイン先の URL が正しくありません');
        if (!await this.options.openExternal(authUrl)) throw Error('既定のブラウザーを開けません');
        for (;;) {
          const event = await client.events.next();
          if (event.method !== 'account/login/completed') continue;
          if (event.params.success === true) return;
          throw Error(typeof event.params.error === 'string' ? event.params.error : 'ログインを完了できませんでした');
        }
      } finally { await client.close(); }
    }
    if (id === 'agy') {
      const client = await new AppServerClient({executable, args: ['acp'], protocol: 'acp', env, signal, timeoutMs: 180000}).start();
      try {
        await client.call('authenticate', {methodId: 'oauth-personal'});
        if (!(await this.providers.detect(id, signal)).ok) throw Error('ログインを確認できませんでした');
      } finally { await client.close(); }
      return;
    }
    let opened = false, opening: Promise<boolean> | null = null;
    const read = (text: string) => {
      if (opened) return;
      for (const match of text.matchAll(/https:\/\/[^\s\x1b<>]+/gu)) {
        const url = new URL(match[0]);
        if (['claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(url.hostname) && url.pathname === '/oauth/authorize') {
          opened = true; opening = this.options.openExternal(url.href); void opening.catch(() => {}); break;
        }
      }
    };
    const result = await execute(executable, ['auth', 'login'], {env, signal, timeoutMs: 180000, capture: false, onLine: read, onStderr: read});
    if (opening && !await opening) throw Error('既定のブラウザーを開けません');
    if (result.code !== 0 || !(await this.providers.detect(id, signal)).ok) throw Error('ログインを完了できませんでした。もう一度お試しください');
  }
  async close() { this.closed = true; for (const job of this.jobs.values()) job.controller.abort(); await Promise.all([...this.jobs.values()].map(j => j.task)); }
}
