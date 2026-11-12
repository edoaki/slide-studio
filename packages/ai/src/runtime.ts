import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extract } from 'tar';
import { atomicWriteFile } from '../../core/src/atomic.js';
import { execute } from './process.js';
import { Providers, NAMES, type ProviderId } from './providers.js';

export interface Release {version: string; url: string; algorithm: 'sha256' | 'sha512'; digest: string; size?: number; archive: boolean}
interface State {current: string | null; previous: string | null; latest: string | null; checked: number; auto: boolean; skip: string | null; error: string | null}
const initial: State = {current: null, previous: null, latest: null, checked: 0, auto: true, skip: null, error: null};
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const LIMIT = 1024 * 1024 * 1024;
const CLAUDE = 'https://downloads.claude.ai/claude-code-releases';
const AGY = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';
type Fetch = typeof fetch;
function validVersion(value: unknown): string {
  if (typeof value !== 'string' || !VERSION.test(value)) throw Error('配布版の番号が正しくありません');
  return value;
}
function pathFor(id: ProviderId, platform = process.platform) { return (id === 'codex' ? 'bin/' : '') + id + (platform === 'win32' ? '.exe' : ''); }
async function get(url: string, fetcher: Fetch, signal?: AbortSignal) {
  if (new URL(url).protocol !== 'https:') throw Error('取得先が正しくありません');
  const response = await fetcher(url, {signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]), headers: {'user-agent': 'slide-studio/0.1'}});
  if (!response.ok || response.url && new URL(response.url).protocol !== 'https:') throw Error(`配布元に接続できません (${response.status})`);
  return response;
}
async function metadata(url: string, fetcher: Fetch, signal?: AbortSignal) {
  const response = await get(url, fetcher, signal);
  if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw Error('配布情報が大きすぎます');
  let size = 0; const chunks: Uint8Array[] = [];
  for await (const chunk of response.body!) { size += chunk.length; if (size > 8 * 1024 * 1024) throw Error('配布情報が大きすぎます'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function latestRelease(id: ProviderId, fetcher: Fetch = fetch, signal?: AbortSignal, platform = process.platform, arch = process.arch): Promise<Release> {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw Error('この環境用の AI は配布されていません');
  if (id === 'codex') {
    const data = JSON.parse(await metadata('https://api.github.com/repos/openai/codex/releases/latest', fetcher, signal));
    const target = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`;
    const asset = data.assets?.find((a: {name: string}) => a.name === `codex-package-${target}.tar.gz`);
    if (!asset || typeof asset.digest !== 'string') throw Error('検証できる Codex の配布ファイルがありません');
    const [algorithm, digest] = asset.digest.split(':');
    if (algorithm !== 'sha256') throw Error('配布ファイルの検証方式が正しくありません');
    return {version: validVersion(String(data.tag_name).replace(/^rust-v/u, '')), url: asset.browser_download_url, algorithm, digest, size: asset.size, archive: true};
  }
  if (id === 'claude') {
    const version = validVersion((await metadata(`${CLAUDE}/stable`, fetcher, signal)).trim());
    const musl = platform === 'linux' && !(process.report.getReport() as {header: {glibcVersionRuntime?: string}}).header.glibcVersionRuntime;
    const target = `${platform}-${arch}${musl ? '-musl' : ''}`;
    const data = JSON.parse(await metadata(`${CLAUDE}/${version}/manifest.json`, fetcher, signal)).platforms?.[target];
    if (!data) throw Error('この環境用の Claude Code がありません');
    return {version, url: `${CLAUDE}/${version}/${target}/claude${platform === 'win32' ? '.exe' : ''}`, algorithm: 'sha256', digest: data.checksum, size: data.size, archive: false};
  }
  const target = `${platform === 'win32' ? 'windows' : platform}_${arch === 'x64' ? 'amd64' : arch}`;
  const data = JSON.parse(await metadata(`${AGY}/manifests/${target}.json`, fetcher, signal));
  return {version: validVersion(data.version), url: data.url, algorithm: 'sha512', digest: data.sha512, archive: String(data.url).includes('.tar.gz')};
}

/** Download and verify in a private staging directory; the current version changes last. */
export class Runtime {
  progress: {done: number; total: number | null} | null = null;
  private pending: Promise<string> | null = null;
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly providers: Providers, readonly id: ProviderId, private options: {fetch?: Fetch; release?: (signal?: AbortSignal) => Promise<Release>; accept?: (path: string) => Promise<void>} = {}) {}
  get root() { return join(this.providers.home(this.id), 'runtime'); }
  get busy() { return this.pending !== null; }
  get overridden() { return this.providers.env[`SLIDE_STUDIO_${this.id.toUpperCase()}`] !== undefined; }
  state(): State {
    try {
      const value = JSON.parse(readFileSync(join(this.root, 'state.json'), 'utf8'));
      return {...initial, ...value, current: typeof value.current === 'string' && VERSION.test(value.current) ? value.current : null, previous: typeof value.previous === 'string' && VERSION.test(value.previous) ? value.previous : null};
    } catch { return {...initial}; }
  }
  private save(values: Partial<State>) {
    const next = this.writes.then(async () => { await mkdir(this.root, {recursive: true, mode: 0o700}); await atomicWriteFile(join(this.root, 'state.json'), JSON.stringify({...this.state(), ...values}), 0o600); });
    this.writes = next.catch(() => {}); return next;
  }
  async check(signal?: AbortSignal) {
    try {
      const release = await (this.options.release?.(signal) ?? latestRelease(this.id, this.options.fetch, signal));
      await this.save({latest: release.version, checked: Date.now() / 1000, error: null}); return release;
    } catch (error) { await this.save({error: `${NAMES[this.id]} の最新版を確かめられませんでした。`}); throw error; }
  }
  info() {
    const saved = this.state(), binary = this.providers.binary(this.id), managed = !!binary?.startsWith(this.root + '/');
    return {id: this.id, name: NAMES[this.id], version: managed ? saved.current : null, terminal: !!binary && !managed, fixed: this.overridden, latest: saved.latest, update: !!saved.latest && (!saved.current || saved.latest.localeCompare(saved.current, undefined, {numeric: true}) > 0), previous: saved.previous, auto: saved.auto, busy: this.busy, progress: this.progress, error: saved.error};
  }
  async setAuto(auto: boolean) { if (this.overridden) throw Error('実行ファイルが指定されています'); await this.save({auto}); }
  async rollback() {
    if (this.busy || this.overridden) throw Error('実行環境を変更できません');
    const saved = this.state();
    if (!saved.previous || !existsSync(join(this.root, saved.previous, pathFor(this.id)))) throw Error('戻せる版がありません');
    await this.save({current: saved.previous, previous: saved.current, skip: saved.current, error: null});
  }
  ensure(signal?: AbortSignal) {
    const current = this.providers.binary(this.id);
    if (current) return Promise.resolve(current);
    if (this.overridden) return Promise.reject(Error('AI の実行ファイルが指定されていません'));
    return this.update(true, signal);
  }
  update(force = false, signal?: AbortSignal): Promise<string> {
    if (this.overridden) return Promise.reject(Error('実行ファイルが指定されています'));
    if (this.pending) return this.pending;
    this.pending = this.perform(force, signal).finally(() => { this.pending = null; this.progress = null; });
    return this.pending;
  }
  private async perform(force: boolean, signal?: AbortSignal) {
    const release = await this.check(signal), saved = this.state();
    const old = saved.current ? join(this.root, saved.current, pathFor(this.id)) : null;
    if (old && existsSync(old) && (release.version === saved.current || !force && (release.version === saved.skip || release.version.localeCompare(saved.current!, undefined, {numeric:true}) < 0))) return old;
    const previous = saved.previous === release.version ? join(this.root, release.version, pathFor(this.id)) : null;
    if (previous && existsSync(previous)) {
      if (this.options.accept) await this.options.accept(previous);
      else {
        const result = await execute(previous, ['--version'], {env: this.providers.environment(this.id), signal});
        if (result.code !== 0 || !result.stdout.includes(release.version)) throw Error('取得済みの版を起動できません');
      }
      await this.save({current: release.version, previous: saved.current, skip: null, error: null});
      return previous;
    }
    validVersion(release.version);
    if (!['sha256', 'sha512'].includes(release.algorithm) || typeof release.digest !== 'string' || !(release.algorithm === 'sha256' ? /^[a-f\d]{64}$/iu : /^[a-f\d]{128}$/iu).test(release.digest)) throw Error('配布ファイルのチェックサムが正しくありません');
    await mkdir(this.root, {recursive: true, mode: 0o700});
    const temp = await mkdtemp(join(this.root, '.stage-')), payload = join(temp, 'payload'), staging = join(temp, 'runtime');
    try {
      const response = await get(release.url, this.options.fetch ?? fetch, signal);
      const total = release.size || Number(response.headers.get('content-length')) || null;
      if (total && total > LIMIT) throw Error('取得サイズが上限を超えました');
      this.progress = {done: 0, total};
      const digest = createHash(release.algorithm), file = await open(payload, 'wx', 0o600);
      try { for await (const chunk of response.body!) { this.progress.done += chunk.length; if (this.progress.done > LIMIT) throw Error('取得サイズが上限を超えました'); digest.update(chunk); await file.writeFile(chunk); } }
      finally { await file.close(); }
      if (digest.digest('hex') !== release.digest.toLowerCase()) throw Error('取得したファイルを検証できませんでした');
      await mkdir(staging, {mode: 0o700});
      if (release.archive) {
        let unpacked = 0, invalid = false;
        await extract({file: payload, cwd: staging, strict: true, preservePaths: false, filter: (path, entry) => {
          unpacked += entry.size;
          if (!('type' in entry) || !['File', 'Directory'].includes(entry.type) || /^(?:\/|[A-Za-z]:)/u.test(path) || path.includes('\\') || path.split('/').includes('..') || unpacked > 2 * LIMIT) { invalid = true; return false; }
          return true;
        }});
        if (invalid) throw Error('配布ファイルに不正な内容があります');
        if (this.id === 'agy') await rename(join(staging, 'antigravity'), join(staging, pathFor(this.id)));
      } else await copyFile(payload, join(staging, pathFor(this.id)));
      const executable = join(staging, pathFor(this.id));
      if (!(await stat(executable)).isFile()) throw Error('実行ファイルがありません');
      await chmod(executable, 0o755);
      if (this.id === 'codex') {
        for (const entry of await readdir(join(staging, 'bin'), {withFileTypes: true})) if (entry.isFile()) await chmod(join(staging, 'bin', entry.name), 0o755);
      }
      if (this.options.accept) await this.options.accept(executable);
      else {
        const result = await execute(executable, ['--version'], {env: this.providers.environment(this.id), signal});
        if (result.code !== 0 || !result.stdout.includes(release.version)) throw Error('取得した版を起動できません');
      }
      const dest = join(this.root, release.version);
      // Never delete a potentially active version to make room for a replacement.
      if (existsSync(dest)) throw Error('同じ版のフォルダーが残っています');
      await rename(staging, dest);
      try { await this.save({current: release.version, previous: saved.current, latest: release.version, skip: null, error: null}); }
      catch (error) { await rename(dest, join(temp, 'uncommitted-' + randomUUID())); throw error; }
      return join(dest, pathFor(this.id));
    } catch (error) { await this.save({error: error instanceof Error ? error.message : String(error)}); throw error; }
    finally { await rm(temp, {recursive: true, force: true}); }
  }
  async close() { await this.pending; await this.writes; }
}
