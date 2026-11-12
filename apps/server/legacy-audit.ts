import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { atomicWriteFile } from '../../packages/core/src/atomic.js';
import { isInsideRoot } from '../../packages/core/src/paths.js';
import { LegacyOutput, version } from './legacy-output.js';

type ImageState = {id: string; page: string; slide: number; step: number; image: string; image_sha256: string};
type Issue = {id: string; level: string; [key: string]: unknown};
type Review = {reviewer: string; states: Array<{id: string; note: string}>; decisions: Array<{id: string; decision: string; reason: string}>; visual_issues: string[]};
interface Report {schema_version: number; audit_id: string; deck: string; version: unknown; checked_at: number; stable: boolean; states: ImageState[]; issues: Issue[]; review: Review | null; instructions: string}
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const engine = hash(Buffer.concat([readFileSync(new URL(import.meta.url)), readFileSync(new URL('./legacy-output.js', import.meta.url))]));
const current = (ws: Workspace, deck: string) => ({...version(ws, deck), engine});
const string = {type: 'string', minLength: 1};
const object = (properties: Record<string, unknown>) => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});
export const TOOLS = [
  {name: 'audit_run', description: '全ページ・全stepを監査し、問題と確認用画像を返す。修正後は再実行する。', input_schema: object({deck: string})},
  {name: 'audit_review', description: '全画像の所見と全問題の判断を記録する。エラーは承認できない。', input_schema: object({deck: string, audit_id: string, reviewer: string, states: {type: 'array', items: object({id: string, note: string})}, decisions: {type: 'array', items: object({id: string, decision: {type: 'string', enum: ['accepted', 'needs_fix']}, reason: string})}, visual_issues: {type: 'array', items: string}})},
  {name: 'audit_status', description: '監査と確認記録が最新版に対応するか調べる。', input_schema: object({deck: string, audit_id: string})},
];
function safe(ws: Workspace, path: string) {
  if (!isInsideRoot(ws.root, path)) throw Error('監査の保存先が正しくありません');
  for (let p = resolve(path);; p = dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) throw Error('監査の保存先にシンボリックリンクがあります'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (p === ws.root) break;
  }
}
function folder(ws: Workspace, deck: string, id: string) {
  ws.require_deck(deck); if (!/^[a-f\d]{32}$/u.test(id)) throw Error('監査 ID が正しくありません');
  const path = join(ws.state, 'audits', deck, id); safe(ws, path); return path;
}
export async function run(ws: Workspace, deck: string, output: LegacyOutput) {
  const id = randomUUID().replaceAll('-', ''), dir = folder(ws, deck, id), before = current(ws, deck);
  const built = await output.audit(ws, deck), states: ImageState[] = [];
  mkdirSync(join(dir, 'shots'), {recursive: true});
  for (const shot of built.inspection.screenshots) {
    const name = `p${String(shot.slide + 1).padStart(2, '0')}-s${shot.step}`, image = join(dir, 'shots', name + '.png');
    await atomicWriteFile(image, shot.bytes, 0o600);
    states.push({id: name, page: String(built.pages.find(p => p.index === shot.slide)?.id ?? ''), slide: shot.slide + 1, step: shot.step + 1, image, image_sha256: hash(Buffer.from(shot.bytes))});
  }
  const issues: Issue[] = [...built.result.errors, ...built.result.warnings].map((issue, index) => {
    const value: Issue = {...issue, id: 'issue-' + (index + 1)};
    if (typeof issue.slide === 'number' && typeof issue.step === 'number') value.state_id = `p${String(issue.slide + 1).padStart(2, '0')}-s${issue.step}`;
    for (const key of ['slide', 'step', 'page']) if (typeof value[key] === 'number') value[key]++;
    if (Array.isArray(value.steps)) value.steps = value.steps.map(s => Number(s) + 1);
    return value;
  });
  const report: Report = {schema_version: 1, audit_id: id, deck, version: before, checked_at: built.result.checked_at, stable: JSON.stringify(before) === JSON.stringify(current(ws, deck)), states, issues, review: null, instructions: '全状態の画像と問題を確認して audit_review に記録する。修正したら audit_run を再実行する。'};
  await atomicWriteFile(join(dir, 'report.json'), JSON.stringify(report, null, 2), 0o600);
  return status(ws, deck, id);
}
export function status(ws: Workspace, deck: string, id: string) {
  const dir = folder(ws, deck, id), path = join(dir, 'report.json'); safe(ws, path);
  const report = JSON.parse(readFileSync(path, 'utf8')) as Report;
  if (report.audit_id !== id || report.deck !== deck || !Array.isArray(report.states) || !Array.isArray(report.issues)) throw Error('監査結果の形式が正しくありません');
  let imagesOk = true;
  for (const state of report.states) {
    try {
      if (!isInsideRoot(join(dir, 'shots'), state.image)) throw Error('監査画像のパスが正しくありません');
      safe(ws, state.image); imagesOk &&= hash(readFileSync(state.image)) === state.image_sha256;
    } catch { imagesOk = false; }
  }
  const fresh = report.stable && JSON.stringify(report.version) === JSON.stringify(current(ws, deck));
  const unresolved = report.issues.some(i => i.level === 'error') || !!report.review?.visual_issues.length || !!report.review?.decisions.some(d => d.decision === 'needs_fix');
  const state = !fresh || !imagesOk ? 'stale' : unresolved ? 'needs_fix' : !report.review || !report.states.length ? 'needs_review' : 'complete';
  return {...report, status: state, complete: state === 'complete', report: path};
}
export async function review(ws: Workspace, deck: string, id: string, body: unknown) {
  const result = status(ws, deck, id);
  if (result.status === 'stale') throw Error('監査が古くなっています。修正後に audit run を再実行してください');
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'decisions,reviewer,states,visual_issues') throw Error('確認結果の形式が正しくありません');
  const value = body as Review;
  if (typeof value.reviewer !== 'string' || !value.reviewer.trim()) throw Error('確認したエージェント名を指定してください');
  for (const [values, expected, field] of [[value.states, result.states, 'note'], [value.decisions, result.issues, 'reason']] as const) {
    if (!Array.isArray(values) || values.length !== expected.length || new Set(values.map(v => v?.id)).size !== expected.length || values.some(v => !v || !expected.some(e => e.id === v.id) || typeof (v as unknown as Record<string, unknown>)[field] !== 'string' || !String((v as unknown as Record<string, unknown>)[field]).trim())) throw Error('全画像と全問題について、重複なく確認結果と理由を指定してください');
  }
  for (const decision of value.decisions) {
    if (!['accepted', 'needs_fix'].includes(decision.decision)) throw Error('判断は accepted または needs_fix を指定してください');
    if (decision.decision === 'accepted' && result.issues.find(i => i.id === decision.id)?.level === 'error') throw Error('検査エラーは承認できません');
  }
  if (!Array.isArray(value.visual_issues) || value.visual_issues.some(v => typeof v !== 'string' || !v.trim())) throw Error('目視で見つけた問題は文字列の配列で指定してください');
  const {status: _status, complete: _complete, report: path, ...report} = result;
  await atomicWriteFile(path, JSON.stringify({...report, review: value}, null, 2), 0o600);
  return status(ws, deck, id);
}
