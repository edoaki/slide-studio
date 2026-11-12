import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFile } from '../../core/src/atomic.js';
import { isInsideRoot } from '../../core/src/paths.js';

type Body = Record<string, unknown>;
async function safe(root: string, path: string) {
  if (!isInsideRoot(root, path)) throw Error('検査の依頼先が正しくありません');
  for (let p = resolve(path);; p = dirname(p)) {
    try { if ((await lstat(p)).isSymbolicLink()) throw Error('検査の依頼先にシンボリックリンクがあります'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (p === resolve(root)) break;
  }
}
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Files are the sandbox crossing; no admin token or general filesystem RPC is exposed. */
export async function request(root: string, body: Body, options: {acceptMs?: number; resultMs?: number; signal?: AbortSignal} = {}): Promise<Body | null> {
  const dir = join(root, '.slide-studio', 'requests'); await safe(root, dir); await mkdir(dir, {recursive: true, mode: 0o700});
  const id = randomUUID().replaceAll('-', ''), req = join(dir, id + '.req.json'), run = join(dir, id + '.run'), res = join(dir, id + '.res.json'), cancel = join(dir,id+'.cancel');
  await atomicWriteFile(req, JSON.stringify(body), 0o600);
  const started = Date.now();let consumed=false;
  try {
    while (!await exists(run) && !await exists(res)) {
      if (options.signal?.aborted) throw Error('依頼を取り消しました');
      if (Date.now() - started > (options.acceptMs ?? 5000)) return null;
      await pause(50);
    }
    while (!await exists(res)) {
      if (options.signal?.aborted) throw Error('依頼を取り消しました');
      if (Date.now() - started > (options.resultMs ?? 900000)) throw Error('アプリでの処理が終わりませんでした');
      await pause(100);
    }
    await safe(root, res);
    if ((await lstat(res)).size > 16 * 1024 * 1024) throw Error('検査の結果が大きすぎます');
    const value: unknown = JSON.parse(await readFile(res, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('検査の結果の形式が正しくありません');
    await unlink(res);consumed=true; return value as Body;
  } finally { await unlink(req).catch(() => {});if(!consumed&&(await exists(run)||await exists(res))){await safe(root,cancel);await atomicWriteFile(cancel,'',0o600);} }
}

export class RequestBridge {
  private timer?: NodeJS.Timeout;
  private scanning: Promise<void> | null = null;
  private tasks = new Set<Promise<void>>();
  private cancellations = new Map<string,AbortController>();
  private closed = false;
  private controller = new AbortController();
  constructor(readonly root: string, private handle: (body: Body, signal: AbortSignal) => Promise<Body>) {}
  get busy() { return this.tasks.size > 0; }
  async start() {
    const dir = join(this.root, '.slide-studio', 'requests'); await safe(this.root, dir); await mkdir(dir, {recursive: true, mode: 0o700});
    this.timer = setInterval(() => {
      if (!this.scanning && !this.closed) this.scanning = this.scan().catch(() => {}).finally(() => { this.scanning = null; });
    }, 100);
    this.timer.unref(); return this;
  }
  private async scan() {
    const dir = join(this.root, '.slide-studio', 'requests'); await safe(this.root, dir);
    const names=(await readdir(dir)).sort();
    for(const name of names.filter(n=>/^[a-f\d]{32}\.cancel$/u.test(n))){
      const id=name.slice(0,32),path=join(dir,name);await safe(this.root,path);
      const active=this.cancellations.get(id);if(active)active.abort();
      else if(!await exists(join(dir,id+'.run'))){await safe(this.root,join(dir,id+'.res.json'));await unlink(join(dir,id+'.res.json')).catch(()=>{});await unlink(path).catch(()=>{});}
    }
    for (const name of names) {
      if (this.closed || this.tasks.size >= 8) break;
      if (!/^[a-f\d]{32}\.req\.json$/u.test(name)) continue;
      const req = join(dir, name), id = name.slice(0, 32), run = join(dir, id + '.run'), res = join(dir, id + '.res.json');
      await safe(this.root, req);
      const info = await lstat(req);
      if (!info.isFile() || info.size > 1024 * 1024) { await unlink(req); continue; }
      let body: unknown;
      try { body = JSON.parse(await readFile(req, 'utf8')); } catch { await unlink(req); continue; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { await unlink(req); continue; }
      await safe(this.root, run); await safe(this.root, res);
      await rename(req, run);
      const controller=new AbortController();this.cancellations.set(id,controller);
      const task = this.answer(body as Body, run, res,AbortSignal.any([controller.signal,this.controller.signal,AbortSignal.timeout(900000)]),join(dir,id+'.cancel')).finally(()=>this.cancellations.delete(id));
      this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {});
    }
  }
  private async answer(body: Body, run: string, res: string,signal:AbortSignal,cancel:string) {
    let result: Body;
    try { result = await this.handle(body, signal); }
    catch (error) { result = {summary: error instanceof Error ? error.message : String(error), errors: 1}; }
    if(signal.aborted)result={errors:1,summary:'アプリでの処理を中断しました'};
    try{if(!await exists(cancel)){await safe(this.root, res); await atomicWriteFile(res, JSON.stringify(result), 0o600);}}
    finally{await unlink(run).catch(() => {});await unlink(cancel).catch(()=>{});}
  }
  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.controller.abort();
    await this.scanning; await Promise.allSettled([...this.tasks]);
  }
}
