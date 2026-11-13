import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { new_figure } from '../../packages/core/src/legacy-figures.js';
import { import_deck } from '../../packages/core/src/legacy-importer.js';
import { sha256 } from '../../packages/core/src/source.js';
import { LegacyOutput } from '../server/legacy-output.js';
import type { LegacyInspect } from '../../packages/contracts/src/legacy-output.js';
import type { LegacyFeatureRequest } from '../../packages/contracts/src/legacy.js';
import { request } from '../../packages/ai/src/bridge.js';
import * as audit from '../server/legacy-audit.js';

export const HELP = `Slide Studio

  slide-studio [open <発表>] [--root <保管フォルダー>]
  slide-studio new <発表> --topic <トピック> [--theme <テーマ>] [--from <発表>]
  slide-studio import <フォルダー> --topic <トピック> [--name <発表>]
  slide-studio fig new <図> --shelf <トピック> [--title <タイトル>]
  slide-studio check <発表> [--page <ID>]
  slide-studio check --figure <トピック/図>
  slide-studio build <発表> [--html-only] [--force]
  slide-studio consult --tab <タブID> <質問>
  slide-studio audit tools|run|status [発表] [監査ID]
  slide-studio audit review <発表> <監査ID> --file <確認JSON|->
  slide-studio doctor

--root の代わりに SLIDE_STUDIO_HOME も使用できます。
`;
export function argumentsOf(args: string[]) {
  return parseArgs({args, allowPositionals: true, options: {
    root: {type: 'string'}, topic: {type: 'string'}, figures: {type: 'string'}, theme: {type: 'string'}, from: {type: 'string'}, name: {type: 'string'},
    shelf: {type: 'string'}, deck: {type: 'string'}, title: {type: 'string'}, page: {type: 'string'}, figure: {type: 'string'}, tab: {type: 'string'},
    force: {type: 'boolean'}, 'html-only': {type: 'boolean'}, json: {type: 'boolean'}, help: {type: 'boolean', short: 'h'},
    port: {type: 'string'}, 'no-browser': {type: 'boolean'}, browser: {type: 'boolean'},
    file: {type: 'string'},
  }});
}
export type Arguments = ReturnType<typeof argumentsOf>;
export function earlyCommand(args: Arguments): boolean {
  if (args.values.help) { process.stdout.write(HELP); return true; }
  if (args.positionals[0] === 'audit' && args.positionals[1] === 'tools') { process.stdout.write(JSON.stringify(audit.TOOLS, null, 2) + '\n'); return true; }
  return false;
}
const reviewInputs = new WeakMap<Arguments, unknown>();
function reviewInput(args: Arguments) { if (!reviewInputs.has(args)) reviewInputs.set(args, readReview(args.values.file ?? args.positionals[4])); return reviewInputs.get(args); }
const required = (value: string | undefined, label: string) => { if (!value) throw Error(`${label}を指定してください`); return value; };
const print = (value: unknown) => process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');

/** A running GUI owns the lock and renderer; its narrow file bridge handles checks. */
export async function throughBridge(root: string, args: Arguments): Promise<number | null> {
  const [command, name] = args.positionals;
  if (!['check', 'consult', 'audit'].includes(command ?? '') || command === 'audit' && name === 'tools') return null;
  const body = command === 'consult' ? {operation: 'consult', tab: required(args.values.tab, 'タブ'), question: name === '-' ? readFileSync(0, 'utf8') : required(name, '質問')}
    : command === 'audit' ? {operation: 'audit_' + name, deck: args.positionals[2], audit_id: args.positionals[3], ...(name === 'review' ? {review: reviewInput(args)} : {})}
    : {operation: 'check', deck: name, page: args.values.page, figure: args.values.figure};
  const response = await request(root, body);
  if (!response) { if (command === 'consult') throw Error('相談できるのはアプリで AI が作業している間だけです'); return null; }
  if (command === 'audit') { const result = response.result as {complete: boolean} | undefined; if (!result) throw Error(String(response.summary)); print(result); return result.complete ? 0 : 1; }
  print(args.values.json ? response.result ?? response : response.answer ?? response.summary);
  return response.errors ? 1 : 0;
}
function readReview(path: string | undefined) { return JSON.parse(readFileSync(path === '-' ? 0 : required(path, '確認結果のJSON'), 'utf8')); }

export async function runCommand(ws: Workspace, args: Arguments, options: {pandocPath: string; inspect: LegacyInspect; diagnostics: () => Promise<unknown[]>}) {
  if (args.values.help) { process.stdout.write(HELP); return 0; }
  const [command, name, third] = args.positionals, values = args.values;
  if (command === 'new') {
    const dest = ws.new_deck(required(name, '発表の名前'), required(values.topic ?? values.figures, 'トピック'), values.theme ?? 'default', values.from ?? null);
    print(join(dest, 'slides.qmd')); return 0;
  }
  if (command === 'import') {
    const dest = await import_deck(ws, resolve(required(name, '取り込み元')), required(values.topic ?? values.figures, 'トピック'), {name: values.name, theme: values.theme});
    print(join(dest, 'slides.qmd')); return 0;
  }
  if (command === 'fig' && name === 'new') {
    const shelf = values.deck ? ws.deck_shelf(values.deck) : required(values.shelf, 'トピック');
    await new_figure(ws, required(third, '図の名前'), ws.shelf_dir(shelf), values.title);
    print(`{{< fig ${shelf}/${third} >}}`); return 0;
  }
  if (command === 'doctor') {
    const items = await options.diagnostics() as Array<{ok: boolean; name: string; detail?: string}>;
    if (values.json) print({root: ws.root, items});
    else { print(`置き場: ${ws.root}`); for (const item of items) print(`${item.ok ? '✓' : '✗'} ${item.name}: ${item.detail ?? ''}`); }
    return items.every(i => i.ok) ? 0 : 1;
  }
  const output = new LegacyOutput({...options, broadcast() {}});
  if (command === 'audit') {
    if (name === 'tools') { print(audit.TOOLS); return 0; }
    const deck = required(third, '発表の名前'), id = args.positionals[3];
    const result = name === 'run' ? await audit.run(ws, deck, output) : name === 'status' ? audit.status(ws, deck, required(id, '監査ID')) : name === 'review' ? await audit.review(ws, deck, required(id, '監査ID'), reviewInput(args)) : null;
    if (!result) throw Error('監査の操作が正しくありません'); print(result); return result.complete ? 0 : 1;
  }
  if (command === 'check') {
    const result = values.figure ? await output.checkFigure(ws, values.figure) : await output.check(ws, required(name, '発表の名前'));
    const errors = values.page ? result.errors.filter(i => !i.page_id || i.page_id === values.page) : result.errors;
    const warnings = values.page ? result.warnings.filter(i => !i.page_id || i.page_id === values.page) : result.warnings;
    print(values.json ? {...result, errors, warnings} : `検査：エラー ${errors.length}・警告 ${warnings.length}\n` + [...errors, ...warnings].map(i => i.message).join('\n'));
    return errors.length ? 1 : 0;
  }
  if (command === 'build') {
    const deck = required(name, '発表の名前');
    const result = await output.handle(ws, {method: 'POST', pathname: `/api/deck/${encodeURIComponent(deck)}/build`, query: new URLSearchParams(), body: {base: sha256(readFileSync(ws.qmd(deck))), force: values.force === true, ...(values['html-only'] ? {format: 'html'} : {})}} as LegacyFeatureRequest);
    const body = result?.body as {error?: string; blocked?: boolean; result?: unknown; files?: Array<{name: string}>};
    if (body.error) throw Error(body.error);
    if (body.blocked) { print(body.result); return 1; }
    print(values.json ? body : body.files?.map(f => join(ws.deck_dir(deck), f.name)).join('\n'));
    return 0;
  }
  throw Error(`コマンドが正しくありません: ${command ?? ''}`);
}
