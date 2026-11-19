/** Cross-deck page discovery and preparation. The editor owns the manuscript save/undo. */
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative, extname } from 'node:path';
import { Workspace } from './workspace.js';
import { parse } from './source.js';
import { sha256 } from './encoding.js';
import * as bib from './bibliography.js';
import { take, topic_path } from './library.js';
import { replaceFigureRefs } from './topic-migrate.js';
import { atomicWriteFile } from '../../renderer/src/output.js';

/** Keep HTML's relative dependency graph together, named by content for repeat imports. */
async function takeHtml(ws: Workspace, target: string, source: string, path: string) {
 const shelf = ws.deck_shelf(source), root = ws.asset_root(source);
 const entry = topic_path(ws, shelf, path);
 if (!statSync(entry).isFile()) throw Error(`HTML がありません: ${path}`);
 if (shelf === ws.deck_shelf(target)) return path;
 const files = new Map<string, Buffer>();
 const visit = (file: string) => {
  const rel = relative(root, file).replaceAll('\\', '/');
  topic_path(ws, shelf, rel); // Reject traversal and symlinks before reading dependencies.
  if (files.has(rel)) return;
  const data = readFileSync(file); files.set(rel, data);
  if (!['.html', '.htm', '.css', '.js', '.mjs', '.svg'].includes(extname(file).toLowerCase())) return;
  for (const match of data.toString('utf8').matchAll(/["'(]([^\s"'()<>]+)["')]/gu)) {
   const value = match[1]!.split(/[?#]/u)[0]!;
   if (!value || /^(?:[a-z][a-z\d+.-]*:|\/|#)/iu.test(value)) continue;
   const dependency = resolve(dirname(file), value);
   // Plain quoted text is not necessarily a file reference.
   if (!existsSync(dependency)) continue;
   topic_path(ws, shelf, relative(root, dependency));
   if (statSync(dependency).isFile()) visit(dependency);
  }
 };
 visit(entry);
 if ([...files].every(([name, data]) => {
  const existing = topic_path(ws, ws.deck_shelf(target), name);
  return existsSync(existing) && statSync(existing).isFile() && readFileSync(existing).equals(data);
 })) return path;
 const fingerprint = sha256(Buffer.from(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => [name, sha256(data)]))));
 const bundle = `html/import-${fingerprint}`;
 for (const [name, data] of files) {
  const destination = topic_path(ws, ws.deck_shelf(target), `${bundle}/${name}`);
  if (existsSync(destination)) {
   if (!readFileSync(destination).equals(data)) throw Error('取り込み済みのHTML素材が変更されています。');
  } else {mkdirSync(dirname(destination), {recursive: true}); await atomicWriteFile(destination, data);}
 }
 return `${bundle}/${path}`;
}

export function searchSlides(ws: Workspace, query: string, options: {exclude?: string; deck?: string} = {}) {
 const terms = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
 const results = [], skipped: string[] = [];
 for (const deck of ws.list_decks()) {
  if (deck === options.exclude || (options.deck && deck !== options.deck)) continue;
  try {
   const text = readFileSync(ws.qmd(deck), 'utf8'), chars = Array.from(text), doc = parse(text);
   for (const page of doc.pages) {
    if (page.generated || page.raw_only) continue;
    const raw = chars.slice(page.start, page.end).join('');
    const haystack = `${deck}\n${page.title}\n${raw}`.normalize('NFKC').toLocaleLowerCase();
    if (!terms.every(term => haystack.includes(term))) continue;
    results.push({deck, page: page.index, title: page.title, excerpt: raw.slice(0, 240), version: sha256(Buffer.from(text))});
   }
  } catch { skipped.push(deck); }
 }
 return {results, skipped};
}

export function searchSlideDecks(ws: Workspace, query: string, exclude: string) {
 const {results, skipped} = searchSlides(ws, query, {exclude});
 const decks = new Map<string, typeof results[number] & {count: number}>();
 for (const result of results) {
  const deck = decks.get(result.deck);
  if (deck) deck.count++;
  else decks.set(result.deck, {...result, count: 1});
 }
 return {results: [...decks.values()], skipped};
}

export async function takeSlide(ws: Workspace, target: string, source: string, index: unknown, version: string) {
 ws.require_deck(target); ws.require_deck(source);
 if (target === source) throw Error('開いているスライドからは取り込めません。');
 const text = readFileSync(ws.qmd(source), 'utf8');
 if (sha256(Buffer.from(text)) !== version) throw Error('取り込み元が変更されました。検索し直してください。');
 const page = parse(text).pages.find(p => p.index === index);
 if (!page || page.generated || page.raw_only) throw Error('このページは取り込めません。');
 let raw = Array.from(text).slice(page.start, page.end).join('');
 const sourceBib = topic_path(ws, ws.deck_shelf(source), 'reference.bib');
 const targetBib = topic_path(ws, ws.deck_shelf(target), 'reference.bib');
 const before = existsSync(targetBib) ? readFileSync(targetBib, 'utf8') : '';
 const existing = new Map(bib.entries(before).filter(([key]) => key !== null));
 const available = bib.entries(existsSync(sourceBib) ? readFileSync(sourceBib, 'utf8') : '');
 const needed = available.filter(([key]) => key && !key.startsWith('@string:') && bib.cites(raw, key));
 // BibTeX macros and crossref parents must travel with cited entries.
 for (let i = 0; i < needed.length; i++) {
  for (const [name, value] of bib.fields(needed[i]![1])) if (name === 'crossref') {
   const key = value.replace(/^[{"\s]+|[}"\s]+$/gu, '');
   const parent = available.find(([k]) => k === key);
   if (parent && !needed.includes(parent)) needed.push(parent);
  }
 }
 if (needed.length) needed.push(...available.filter(([key]) => key?.startsWith('@string:')));
 const additions: string[] = [];
 for (const [key, entry] of needed) {
  const old = existing.get(key!);
  if (old && bib.identity(key, old) !== bib.identity(key, entry)) throw Error(`文献キー「${key}」の内容が取り込み先と異なります。キーを変更してから取り込んでください。`);
  if (!old) additions.push(entry);
 }
 const refs = new Set<string>();
 replaceFigureRefs(raw, ref => { refs.add(ref); return null; });
 const replacements = new Map<string, string>();
 for (const ref of refs) {
  const slash = ref.indexOf('/'), shelf = ref.slice(0, slash), name = ref.slice(slash + 1);
  const owner = ws.list_decks().find(d => ws.deck_shelf(d) === shelf);
  if (!owner || slash < 0) throw Error(`図がありません: ${ref}`);
  const result = await take(ws, target, 'figure', owner, name);
  if (!('ref' in result)) throw Error('図を取り込めません');
  replacements.set(ref, result.ref);
 }
 raw = replaceFigureRefs(raw, ref => replacements.get(ref) ?? null);
 // Both Markdown and HTML image references are supported, including angle destinations.
 const paths = [...raw.matchAll(/(?:\]\(<?|\b(?:src|poster)=["'])([^\s"'<>)]*)/gu)].map(m => m[1]!).filter(Boolean);
 for (const path of new Set(paths)) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(path)) continue;
  const clean = path.split(/[?#]/u)[0]!;
  const absolute = /^(?:images|html)\//u.test(clean) ? resolve(ws.asset_root(source), clean) : resolve(dirname(ws.qmd(source)), clean);
  const rel = relative(ws.asset_root(source), absolute).replaceAll('\\', '/');
  const result = /\.html?$/iu.test(clean)
   ? {path: await takeHtml(ws, target, source, rel)}
   : await take(ws, target, 'image', source, rel);
  if (!('path' in result)) throw Error('画像を取り込めません');
  raw = raw.replace(/(\]\(<?|\b(?:src|poster)=["'])([^\s"'<>)]*)/gu, (whole, prefix, value) => value === path ? prefix + result.path + path.slice(clean.length) : whole);
 }
 // Protect edits by other processes made while figure dependencies were copied.
 if ((existsSync(targetBib) ? readFileSync(targetBib, 'utf8') : '') !== before) throw Error('取り込み先の文献が変更されました。もう一度取り込んでください。');
 if (additions.length) await atomicWriteFile(targetBib, before + '\n\n' + additions.join('\n\n') + '\n');
 return {text: raw, title: page.title};
}
