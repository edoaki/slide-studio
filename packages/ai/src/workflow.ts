import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Workspace } from '../../core/src/legacy-workspace.js';
import { atomicWriteFile } from '../../core/src/atomic.js';
import { merge3, touched } from '../../core/src/legacy-edit-scope.js';
import { ACTIVE, attachments, type ChatRound, type ChatStore, type ChatTab } from '../../core/src/legacy-chat-store.js';
import * as roles from '../../core/src/legacy-ai-roles.js';
import * as snapshots from '../../core/src/legacy-snapshot.js';
import { cleanItems, prompt, type Item } from './context.js';
import type { AIStatus } from './status.js';
import { runNative, schema, type NativeOptions, type RunEvent } from './native.js';
import type { ProviderId } from './providers.js';

export interface Issue extends Record<string, unknown> {message: string; old?: boolean}
export interface Check {errors: Issue[]; warnings: Issue[]; [key: string]: unknown}
type Agent = {id: string; role: roles.RoleId; state: string; summary: string; issues: unknown[]; [key: string]: unknown};
export interface Round extends ChatRound {
  mode: roles.Mode; items: Item[]; model: string; effort: string | null;
  ai_roles: roles.RoleSettings; steps: Array<Record<string, unknown>>; agents: Agent[];
  attach: ReturnType<typeof attachments>; talk: boolean; cancel: boolean;
  summary: string; error: string | null; snapshot: string | null;
  files: snapshots.Changes | null; check: Check | null; user_edits: string[];
}
export type Runner = (id: ProviderId, ws: Workspace, options: NativeOptions) => Promise<{session?: string | null; final: unknown}>;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const issueKey = (issue: Issue) => JSON.stringify([issue.kind, issue.message, issue.page_id, issue.figure, issue.step]);
function json(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value === 'string') value = JSON.parse(value.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
export class RunConflict extends Error {}

/** Owns accepted runs until files, snapshots and conversation history are settled. */
export class Workflow {
  private running = new Map<string, {deck: string; controller: AbortController; task: Promise<void>}>();
  private closed = false;
  constructor(readonly ws: Workspace, readonly store: ChatStore, readonly status: AIStatus,
    private options: {check: (deck: string, mode: roles.Mode) => Promise<Check>; reviewContext?: (deck: string, mode: roles.Mode) => Promise<unknown>; changed: (paths: string[]) => void; runner?: Runner}) {}
  get busy() { return [...this.running].some(([id, run]) => ACTIVE.has(this.store.round(run.deck, id).state)); }
  themeLocked(name: string) {
    return [...this.running].some(([id, active]) => {
      const round = this.store.round(active.deck, id) as Round;
      return ACTIVE.has(round.state) && round.mode === 'theme' && round.theme === name;
    });
  }
  locked(deck: string, kind: roles.Mode, before?: string, after?: string) {
    const state = this.store.public(deck);
    if (kind === 'memo') return state.memo_locked;
    if (kind === 'theme') return this.themeLocked(this.ws.deck_theme(deck));
    return state.lock.all || !!(before !== undefined && after !== undefined && touched(before, after, state.lock));
  }
  private version(deck: string, mode: roles.Mode) {
    const path = mode === 'memo' ? this.ws.memo(deck) : mode === 'theme' ? join(this.ws.themes, this.ws.deck_theme(deck) + '.css') : this.ws.qmd(deck);
    return hash(existsSync(path) ? readFileSync(path) : '');
  }
  private async publish(deck: string) { await this.store.save(deck); this.store.broadcast(deck); }

  async send(deck: string, tabId: string, body: Record<string, unknown>, continuation?: Round) {
    if (this.closed) throw Error('アプリを終了しています');
    const status = await this.status.read(this.ws), tab = this.store.tab(deck, tabId);
    const model = tab.model ?? status.default;
    if (!model) throw Error('使える AI がありません。ログインを確認してください');
    const provider = this.status.providerOf(model);
    if (!provider.ok || !provider.model) throw Error('選択したモデルが使えません');
    const data = this.store.state(deck);
    if (data.rounds.some(r => r.tab === tabId && ACTIVE.has(r.state))) throw Error('このタブは作業中です');
    let items = cleanItems(this.ws, deck, tab.mode, body.items);
    if (body.base !== this.version(deck, tab.mode)) throw new RunConflict('原稿が変わっています。保存が終わってから送信してください');
    const previous = data.rounds.findLast(r => r.tab === tabId) as Round | undefined;
    const talk = body.talk === true && tab.mode === 'slides';
    const pending = !continuation && previous?.state === 'cancelled' && !previous.restored && !!previous.talk === talk ? previous : null;
    let attach = attachments(this.ws, deck, body.attach ?? tab.attach);
    if (pending) {
      const prior = structuredClone(pending.items);
      if (tab.mode === 'slides') items = [...prior, ...items];
      else items[0]!.text = prior[0]!.text + '\n\n' + items[0]!.text;
      attach = [...new Map([...pending.attach, ...attach].map(a => [a.path, a])).values()];
    }
    const effort = tab.effort ?? provider.model.effort;
    const settings: roles.RoleSettings = {};
    for (const role of ['review', 'consult'] as const) settings[role] = roles.resolveRole(role, {model, effort}, tab.ai_roles, key => this.status.providerOf(key));
    const round: Round = {
      id: 'r' + randomUUID().replaceAll('-', '').slice(0, 10), tab: tabId, mode: tab.mode,
      time: Date.now() / 1000, items, model, effort, model_name: provider.model.name,
      ai_roles: settings, attach,
      talk, state: 'run', steps: [], agents: [],
      summary: '', results: [], files: null, check: null, snapshot: null, restored: null,
      error: null, cancel: false, user_edits: [], overlap: [],
    };
    if (tab.mode === 'theme') round.theme = this.ws.deck_theme(deck);
    if (continuation) {
      round.continued_from = continuation.id; round.handover = this.handover(deck, tabId, continuation);
      const last = continuation.agents.at(-1);
      round.review_only = last?.role === 'review' && ['error', 'cancelled'].includes(last.state);
      if (round.review_only) { delete tab.review_session; delete tab.review_binding; }
    }
    if (pending) { round.resumed_from = pending.id; round.handover = this.handover(deck, tabId, pending) + '\n追加の指示が以前の指示を訂正している場合は、追加の指示を優先する。'; }
    for (const [id, active] of this.running) {
      const other = this.store.round(active.deck, id) as Round;
      if (!ACTIVE.has(other.state) || other.talk || round.talk) continue;
      (other.overlap as unknown[]).push({deck, round: round.id});
      (round.overlap as unknown[]).push({deck: active.deck, round: id});
    }
    data.rounds.push(round);
    if (!continuation) { tab.drafts = {}; tab.attach = []; }
    tab.model = model;
    if (tab.auto_name) { tab.name = Array.from(items[0]!.text.split('\n')[0]!).slice(0, 40).join(''); tab.auto_name = false; }
    await this.publish(deck);
    const controller = new AbortController();
    // Register ownership before the first asynchronous operation in run().
    const task = Promise.resolve().then(() => this.run(deck, tab, round, controller.signal)).finally(() => this.running.delete(round.id));
    this.running.set(round.id, {deck, controller, task});
    // The task's error is retained for close()/cancel(); prevent an unhandled rejection meanwhile.
    void task.catch(() => {});
    return round;
  }

  private handover(deck: string, tabId: string, stopped?: Round) {
    const history = this.store.state(deck).rounds.filter(r => r.tab === tabId).slice(-12).map(r => ({items: r.items, summary: r.summary, error: r.error}));
    return '[会話の引き継ぎ] 現在のファイルを正本とし、過去の依頼を再実行しない。完了済みの変更を保ち、残りを進める。\n'
      + JSON.stringify({history, stopped: stopped ? {items: stopped.items, results: stopped.results, check: stopped.check, error: stopped.error} : null});
  }

  private async execute(deck: string, tab: ChatTab, round: Round, role: roles.RoleId, text: string, parent: boolean, signal: AbortSignal) {
    if (signal.aborted) throw Error('実行を取り消しました');
    const chosen = roles.resolveRole(role, {model: round.model, effort: round.effort}, parent ? {} : round.ai_roles, key => this.status.providerOf(key));
    const model = chosen.model!, at = model.indexOf(':'), id = model.slice(0, at) as ProviderId;
    const definition = roles.get(role), revision = roles.catalog(this.ws).roles.find(r => r.id === role)!.revision;
    const sessionKey = parent ? 'session' : role + '_session', bindingKey = parent ? 'role_binding' : role + '_binding';
    const binding = `${role}:${model}:${revision}`, home = this.status.providers.home(id);
    const context = tab[sessionKey + '_context'] as {used?: number; window?: number; reset?: boolean} | undefined;
    const reset = context?.reset || (context?.used ?? 0) >= Math.min(64000, (context?.window ?? 64000 / .7) * .7);
    let session = tab[bindingKey] === binding && tab[sessionKey + '_home'] === home && !reset ? tab[sessionKey] as string | null : null;
    if (!session && tab[sessionKey] && parent) { text = this.handover(deck, tab.id) + '\n\n' + text; round.session_reset = true; }
    const agent: Agent = {id: randomUUID(), role, state: 'run', summary: '', issues: [], parent, ...chosen, prompt_revision: revision};
    round.agents.push(agent);
    await this.publish(deck);
    let saveError: unknown;
    const onEvent = (event: RunEvent) => {
      if (event.limits) this.status.saveLimits(this.ws, id, event.limits);
      if (event.session) {
        session = event.session; agent.session = session;
        Object.assign(tab, {[sessionKey]: session, [bindingKey]: binding, [sessionKey + '_home']: home});
      }
      if (event.usage) { const previous = tab[sessionKey + '_context'] as {window?: number} | undefined; const usage = {...event.usage, window:event.usage.window ?? previous?.window ?? this.status.providerOf(model).model?.context ?? null, session}; tab[sessionKey + '_context'] = usage; agent.context = usage; if (parent) round.context = usage; }
      if (event.step) {
        const step = {...event.step, role, id: event.step.id ? agent.id + ':' + event.step.id : null};
        const index = step.id ? round.steps.findLastIndex(s => s.id === step.id) : -1;
        if (index < 0) round.steps.push(step); else round.steps[index] = step;
        if (round.steps.length > 500) round.steps.splice(0, round.steps.length - 500);
      }
      void this.publish(deck).catch(error => { saveError = error; });
    };
    try {
      const run = this.options.runner ?? ((id, ws, opts) => runNative(this.status.providers, id, ws, opts));
      const result = await run(id, this.ws, {
        role, model: model.slice(at + 1), effort: chosen.effort, session,
        prompt: roles.with_extra(this.ws, role, text), readonly: round.talk || definition.readonly,
        web: definition.web, outputSchema: round.talk ? schema('theme') : undefined,
        images: round.attach.filter(a => a.kind === 'image' && /\.(png|jpe?g|webp|gif)$/iu.test(a.path)).map(a => join(this.ws.asset_root(deck), a.path)),
        signal, onEvent,
      });
      await this.store.flush(); if (saveError) throw saveError;
      const value = json(result.final);
      if (role === 'review') {
        if (!value || typeof value.summary !== 'string' || !Array.isArray(value.issues) || value.issues.some(i => !i || ['target', 'message', 'suggestion'].some(k => typeof i[k] !== 'string'))) throw Error('確認役の返事の形が正しくありません');
        agent.summary = value.summary; agent.issues = value.issues; agent.state = value.issues.length ? 'needs_fix' : 'complete';
      } else { agent.state = 'complete'; agent.summary = String(value?.summary ?? value?.reply ?? result.final ?? ''); }
      if (parent) this.reply(round, result.final);
      return agent;
    } catch (error) {
      agent.state = signal.aborted ? 'cancelled' : 'error'; agent.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { await this.publish(deck); }
  }

  private reply(round: Round, raw: unknown) {
    const value = json(raw);
    round.summary = String(value?.summary ?? value?.reply ?? (typeof raw === 'string' ? raw : JSON.stringify(raw)) ?? '');
    round.questions = roles.clean_questions(value?.questions, round.items.length);
    if (round.mode === 'slides' && !round.talk) {
      const results = Array.isArray(value?.results) ? value.results : [];
      round.results = round.items.map((item, index) => {
        const found = results.find(r => r?.item === index + 1);
        return {key: item.key, label: item.label, ok: found?.ok === true, text: typeof found?.text === 'string' ? found.text : '最終結果が返されていないため、達成を確認できません。'};
      });
    }
    if (round.mode === 'memo' && typeof value?.slides === 'string' && value.slides.trim()) round.handoff = {text: value.slides.trim(), rebuild: value.rebuild === true};
    round.steps = round.steps.filter(s => !(s.kind === 'message' && s.text === raw));
  }

  private async files(deck: string, round: Round, snapshot: snapshots.Snapshot) {
    const files = await snapshots.finish(this.ws, snapshot);
    if (round.mode !== 'slides') {
      const mine = round.mode === 'memo' ? `decks/${deck}/memo.md` : `themes/${round.theme}.css`;
      round.stray = Object.values(files).flat().filter(n => n !== mine);
      for (const key of ['added', 'modified', 'deleted', 'outside'] as const) files[key] = files[key].filter(n => n === mine);
    }
    round.files = files;
    this.options.changed(Object.values(files).flat());
  }

  private async run(deck: string, tab: ChatTab, round: Round, signal: AbortSignal) {
    let snapshot: snapshots.Snapshot | null = null;
    let before = new Set<string>();
    const check = async () => {
      round.state = 'check'; await this.publish(deck);
      const result = await this.options.check(deck, round.mode);
      round.check = {...result, errors: result.errors.map(e => ({...e, old: before.has(issueKey(e))}))};
      return round.check.errors.filter(e => !e.old);
    };
    const fix = async (text: string) => {
      round.state = 'run';
      await this.execute(deck, tab, round, roles.MODES[round.mode], text, true, signal);
      if (snapshot) await this.files(deck, round, snapshot);
    };
    try {
      if (!round.talk) { snapshot = await snapshots.take(this.ws, deck); round.snapshot = basename(snapshot.path); }
      if (!round.talk && round.mode !== 'memo') before = new Set((await this.options.check(deck, round.mode)).errors.map(issueKey));
      let text = prompt(this.ws, deck, round.mode, round.items, round.attach, round.talk);
      if (!round.talk && round.ai_roles.consult?.enabled) text += `\n[相談役] 迷ったときは slide-studio consult --tab ${tab.id} "質問" で相談できる。要点と読むべきファイルのパスを質問に含める。相談役はファイルを変えない。`;
      if (round.handover) text = round.handover + '\n\n' + text;
      if (!round.review_only) await this.execute(deck, tab, round, roles.MODES[round.mode], text, true, signal);
      if (snapshot) await this.files(deck, round, snapshot);
      if (!round.talk) {
        const fixes: unknown[] = [], reviewFixes: unknown[] = []; round.fixes = fixes; round.review_fixes = reviewFixes;
        const seen = new Set<string>();
        for (;;) {
          let errors = round.mode === 'memo' ? [] : await check();
          while (errors.length && fixes.length < 3 && !signal.aborted) {
            fixes.push({errors: errors.length, limit: 3});
            await fix('[機械検査の修正] 今回生じた次のエラーだけを直す。元の全指示について最新の結果を返す。\n' + JSON.stringify(errors));
            errors = await check();
          }
          if (errors.length) { round.review_ok = false; break; }
          if (round.ai_roles.review?.enabled === false || !round.files || !round.review_only && ![...round.files.added, ...round.files.modified, ...round.files.deleted].length) break;
          const reviewFiles = structuredClone(round.files);
          if (round.review_only) {
            let origin = round;
            while (origin.review_only && typeof origin.continued_from === 'string') {
              origin = this.store.round(deck, origin.continued_from) as Round;
              for (const kind of ['added', 'modified', 'deleted', 'outside'] as const) reviewFiles[kind] = [...new Set([...reviewFiles[kind], ...(origin.files?.[kind] ?? [])])];
            }
          }
          const version = hash(JSON.stringify(snapshots.manifest(this.ws)));
          if (seen.has(version)) { round.review_ok = false; round.fix_stop = '確認済みの同じ状態に戻るため、自動修正を停止しました。'; break; }
          seen.add(version); round.state = 'review'; await this.publish(deck);
          const visual = await this.options.reviewContext?.(deck, round.mode);
          const review = await this.execute(deck, tab, round, 'review', '[確認] ファイルを変えず、今回の指示が満たされているか、変更箇所に問題がないか確認する。表示の画像がある場合は実際に開いて、文字の重なり・はみ出し・図の全stepを確認する。利用者の判断が必要な指摘は message を【要判断】で始める。\n' + JSON.stringify({mode: round.mode, deck, items: round.items, files: reviewFiles, check: round.check, visual}), false, signal);
          review.version = version; round.final_review = review.id; round.review_ok = review.state === 'complete';
          const fixable = (review.issues as Array<{message: string}>).filter(i => !i.message.startsWith('【要判断】'));
          if (!fixable.length || reviewFixes.length >= 3) break;
          reviewFixes.push({issues: fixable.length, limit: 3});
          await fix('[確認役の指摘を修正] 元の指示の範囲内で次の指摘を直す。元の全指示について最新の結果を返す。\n' + JSON.stringify(fixable));
        }
      }
    } catch (error) { round.error = error instanceof Error ? error.message : String(error); }
    finally {
      if (snapshot) {
        try { await this.files(deck, round, snapshot); } catch (error) { round.error ||= String(error); }
      }
      round.state = signal.aborted ? 'cancelled' : round.error ? 'error' : round.review_ok === false || round.check?.errors.some(e => !e.old) ? 'fail' : 'done';
      if (signal.aborted) round.error = null;
      if (round.handoff && !['cancelled', 'error'].includes(round.state)) Object.assign(round.handoff, {[round.review_ok === false ? 'blocked' : 'pending']: true});
      await this.publish(deck);
    }
  }

  async cancel(deck: string, id: string) {
    const round = this.store.round(deck, id), active = this.running.get(id);
    if (!active || active.deck !== deck || !ACTIVE.has(round.state)) throw Error('この送信は作業中ではありません');
    round.cancel = true; active.controller.abort(); await active.task;
  }
  async consult(tabId: string, question: string, signal?: AbortSignal) {
    if (!question.trim()) throw Error('相談の内容が空です');
    const active = [...this.running].find(([id, run]) => this.store.round(run.deck, id).tab === tabId);
    if (!active) throw Error('相談できるのは AI が作業している間だけです');
    const [id, run] = active, round = this.store.round(run.deck, id) as Round;
    if (round.talk || round.ai_roles.consult?.enabled !== true) throw Error('相談役はオフです');
    const agent = await this.execute(run.deck, this.store.tab(run.deck, tabId), round, 'consult', question, false,
      signal ? AbortSignal.any([signal, run.controller.signal]) : run.controller.signal);
    return agent.summary;
  }
  async continue(deck: string, id: string, base: unknown) {
    const round = this.store.round(deck, id) as Round;
    if (round.restored || !['error', 'cancelled'].includes(round.state) || this.store.state(deck).rounds.findLast(r => r.tab === round.tab)?.id !== id) throw Error('最後の中断した送信から続けてください');
    const items = round.items.map(i => ({...i, ...(i.step ? {step: i.step.index} : {})}));
    return this.send(deck, round.tab, {base, items, attach: round.attach, talk: round.talk}, round);
  }
  private restorable(deck: string, id: string) {
    const round = this.store.round(deck, id) as Round;
    if (this.busy) throw Error('AI の作業が終わってから戻してください');
    if (round.restored) throw Error('すでに戻しました');
    if (!round.snapshot) throw Error('この送信の控えがありません');
    const snapshot = snapshots.find(this.ws, deck, round.snapshot);
    const only = round.mode === 'memo' ? new Set([`decks/${deck}/memo.md`]) : round.mode === 'theme' ? new Set([`themes/${round.theme}.css`]) : null;
    return {round, snapshot, only, keep: new Set(round.user_edits ?? [])};
  }
  restorePreview(deck: string, id: string) {
    const {round, snapshot, only, keep} = this.restorable(deck, id);
    const plan = snapshots.restore_plan(this.ws, snapshot, only, keep);
    const files = [...plan.added, ...plan.modified, ...plan.deleted];
    const shared = new Set<string>(), tabs: string[] = [];
    for (const overlap of (round.overlap ?? []) as Array<{deck: string; round: string}>) {
      const other = this.store.round(overlap.deck, overlap.round) as Round;
      const touched = new Set([...Object.values(other.files ?? {}).flat(), ...((other.stray ?? []) as string[])]);
      const common = files.filter(n => touched.has(n));
      if (common.length) { for (const name of common) shared.add(name); tabs.push(this.store.tab(overlap.deck, other.tab).name); }
    }
    return {files, later: plan.later, kept: plan.kept, shared: {files: [...shared], tabs}};
  }
  async restore(deck: string, id: string) {
    const {round, snapshot, only, keep} = this.restorable(deck, id);
    const result = snapshots.restore_run(this.ws, snapshot, only, keep);
    const shadow = join(snapshot.path, 'user-slides.qmd');
    if (!only && existsSync(shadow) && result.modified.includes(`decks/${deck}/slides.qmd`)) await atomicWriteFile(this.ws.qmd(deck), readFileSync(shadow), 0o600);
    const files = [...result.added, ...result.modified, ...result.deleted];
    round.restored = {at: Date.now() / 1000, files, later: result.later, kept: result.kept, outside: result.outside};
    await this.publish(deck); this.options.changed(files);
    return round;
  }
  async handoff(deck: string, id: string, body: Record<string, unknown>) {
    const round = this.store.round(deck, id) as Round;
    const handoff = round.handoff as {text: string; rebuild: boolean; round?: string; tab?: string; pending?: boolean; deferred?: boolean; blocked?: boolean} | undefined;
    if (!handoff) throw Error('スライドに引き渡す方針がありません');
    if (handoff.round) return round;
    if (ACTIVE.has(round.state)) throw Error('下書きの作業が終わってから操作してください');
    if (body.defer === true) { handoff.deferred = true; delete handoff.pending; await this.publish(deck); return round; }
    if (handoff.deferred) throw Error('下書きのチャットから改めて依頼してください');
    if (handoff.blocked && body.force !== true) throw Error('下書きの確認で直す所が見つかっています');
    const data = this.store.state(deck);
    let tab = data.tabs.find(t => t.handoff && t.mode === 'slides');
    if (!tab) {
      const from = this.store.tab(deck, round.tab);
      tab = await this.store.add_tab(deck, 'slides');
      Object.assign(tab, {name: '下書きから', auto_name: false, model: from.model, effort: from.effort, ai_roles: structuredClone(from.ai_roles), handoff: true});
    }
    tab.open = true; handoff.tab = tab.id;
    const sent = await this.send(deck, tab.id, {base: body.base, items: [{key: 'deck', text: `[下書きからの引き渡し] decks/${deck}/memo.md を読み、次の方針で${handoff.rebuild ? 'スライドを作り直す' : 'スライドに反映する'}。\n${handoff.text}`}]});
    handoff.round = sent.id; delete handoff.pending;
    await this.publish(deck); return round;
  }
  userWrote(deck: string, path: string) {
    for (const [id, active] of this.running) if (active.deck === deck) {
      const round = this.store.round(deck, id) as Round;
      if (!round.user_edits.includes(path)) round.user_edits.push(path);
    }
  }
  async userSaved(deck: string, before: string, after: string) {
    for (const [id, active] of this.running) if (active.deck === deck) {
      const round = this.store.round(deck, id) as Round;
      if (round.mode !== 'slides' || round.talk || !round.snapshot) continue;
      const snapshot = snapshots.find(this.ws, deck, round.snapshot), shadow = join(snapshot.path, 'user-slides.qmd');
      const original = existsSync(shadow) ? shadow : join(snapshot.path, 'files', 'decks', deck, 'slides.qmd');
      const merged = merge3(before, after, readFileSync(original, 'utf8'));
      if (merged === null) this.userWrote(deck, `decks/${deck}/slides.qmd`);
      else await atomicWriteFile(shadow, merged, 0o600);
    }
  }
  async close() {
    this.closed = true;
    for (const active of this.running.values()) active.controller.abort();
    const result = await Promise.allSettled([...this.running.values()].map(r => r.task));
    await this.store.flush();
    const failed = result.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
