import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Workspace, check_name, check_creation_name, set_front } from './legacy-workspace.js';
import { parse, ATTR_TAIL } from './legacy-source.js';
import { Copier } from './legacy-figures.js';
import { copy_group, rewrite } from './legacy-topic-migrate.js';
import { migrate } from './legacy-bibliography.js';
import { atomicWriteFile } from './atomic.js';
import { isInsideRoot } from './paths.js';

export function add_page_ids(text: string): string {
  const doc = parse(text), used = new Set(doc.pages.map(p => p.id).filter(Boolean));
  const counters: Record<number, number> = {1: 0, 2: 0}, points = Array.from(text);
  const edits: Array<[number, number, string]> = [];
  for (const page of doc.pages) {
    counters[page.level] = (counters[page.level] ?? 0) + 1;
    if (page.id) continue;
    const slug = page.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40).replace(/-+$/u, '');
    const base = slug || (page.level === 1 ? 'chapter' : 'page');
    let id = !used.has(base) && !['chapter', 'page'].includes(base) ? base : '', n = counters[page.level]!;
    while (!id || used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    const line = points.slice(page.start, page.head_end).join(''), match = ATTR_TAIL.exec(line);
    const inner = match ? line.indexOf('{', match.index) + 1 : -1;
    edits.push([page.start, page.head_end, match ? line.slice(0, inner) + `#${id}${match[1]!.trim() ? ' ' + match[1]!.trim() : ''}` + line.slice(inner + match[1]!.length) : line.trimEnd() + ` {#${id}}`]);
  }
  for (const [start, end, replacement] of edits.reverse()) points.splice(start, end - start, ...Array.from(replacement));
  return points.join('');
}

export function ensure_tail(text: string): string {
  const doc = parse(text), ids = new Set(doc.pages.map(p => p.id));
  let tail = '';
  if (!ids.has('references')) {
    const appendix = doc.pages.find(p => p.id === 'appendix');
    if (appendix) { const points = Array.from(text); points.splice(appendix.start, 0, ...Array.from('## 参考文献 {#references}\n\n')); text = points.join(''); }
    else tail += '## 参考文献 {#references}\n\n';
  }
  if (!ids.has('appendix')) tail += '# Appendix {#appendix}\n';
  return tail ? text.replace(/\n+$/u, '') + '\n\n' + tail : text;
}

function rejectLinks(path: string) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw Error(`シンボリックリンクは取り込めません: ${path}`);
  if (entry.isDirectory()) for (const name of readdirSync(path)) rejectLinks(join(path, name));
}
function findFigure(source: string, url: string) {
  if (!url || /^[a-z][a-z\d+.-]*:/iu.test(url)) throw Error(`図の場所が正しくありません: ${url}`);
  const direct = dirname(resolve(source, url)), name = basename(direct), candidates = [direct];
  for (let parent = source;; parent = dirname(parent)) { candidates.push(join(parent, 'html', name)); if (dirname(parent) === parent) break; }
  for (const candidate of candidates) if (existsSync(join(candidate, 'figure.mjs'))) { rejectLinks(candidate); return realpathSync(candidate); }
  throw Error(`figure.mjs 方式の図が見つかりません: ${url}`);
}

/** Import the original Quarto directory without copying its generated HTML/PDF. */
export async function import_deck(ws: Workspace, input: string, shelf: string, options: {name?: string; theme?: string} = {}) {
  const source = realpathSync(input), name = check_creation_name(options.name || basename(source), '発表の名前');
  check_name(shelf, 'トピックの名前'); const theme = check_name(options.theme || 'default', 'テーマ');
  const dest = ws.deck_dir(name);
  for (const path of [dest, ws.topic_dir(shelf)]) for (let p = path;; p = dirname(p)) {
    if (!isInsideRoot(ws.root, p)) throw Error('取り込み先が保管フォルダーの外です');
    try { if (lstatSync(p).isSymbolicLink()) throw Error('取り込み先にシンボリックリンクがあります'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (p === ws.root) break;
  }
  if (existsSync(dest)) throw Error(`既にあります: ${dest}`);
  if (isInsideRoot(source, dest)) throw Error('取り込み先は元のフォルダーの外にしてください');
  if (!existsSync(join(source, 'slides.qmd'))) throw Error(`slides.qmd がありません: ${source}`);
  if (!existsSync(join(ws.themes, theme + '.css'))) throw Error(`テーマがありません: ${theme}`);
  rejectLinks(source);
  let text = readFileSync(join(source, 'slides.qmd'), 'utf8');
  const figures = new Map<string, string>();
  const replace = (_whole: string, tag: string) => {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)].map(m => [m[1]!, m[2] ?? m[3]!]));
    const directory = findFigure(source, attrs.src ?? ''), name = check_name(basename(directory), '図の名前');
    if (figures.has(name) && figures.get(name) !== directory) throw Error(`同じ名前の図があります: ${name}`);
    figures.set(name, directory);
    return `{{< fig ${shelf}/${name}${attrs.title ? ' title=' + JSON.stringify(attrs.title) : ''} >}}`;
  };
  text = text.replace(/^```+\s*\{=html\}[ \t]*\n\s*(<iframe\b[^>]*>\s*<\/iframe>)\s*\n```+[ \t]*$/gmu, replace)
    .replace(/^[ \t]*(<iframe\b[^>]*>\s*<\/iframe>)[ \t]*$/gmu, replace);
  const meta = parse(text).meta, values: Record<string, unknown> = {topic: shelf, theme};
  if (!('title' in meta) && meta.pagetitle) values.title = JSON.stringify(meta.pagetitle);
  if (!('lang' in meta)) values.lang = 'ja';
  text = ensure_tail(add_page_ids(set_front(text, values)));
  const base = ws.shelf_dir(shelf), targets = new Map<string, string>();
  for (const [name, source] of figures) {
    const target = join(base, name); if (existsSync(target)) throw Error(`トピックに同じ名前の図があります: ${name}`);
    targets.set(source, target);
  }
  const created: string[] = [];
  try {
    mkdirSync(dest, {recursive: true}); created.push(dest);
    for (const entry of readdirSync(source, {withFileTypes: true})) {
      if (['slides.qmd', 'html', 'images', 'figures', '.DS_Store'].includes(entry.name) || ['.html', '.pdf'].includes(extname(entry.name))) continue;
      cpSync(join(source, entry.name), join(dest, entry.name), {recursive: true, preserveTimestamps: true, filter: p => basename(p) !== '.DS_Store'});
    }
    mkdirSync(join(dest, 'styles'), {recursive: true});
    const mapping = new Map<string, string>();
    copy_group(ws, join(source, 'images'), join(ws.topic_dir(shelf), 'images'), mapping, undefined, created);
    text = rewrite(text, join(source, 'slides.qmd'), join(dest, 'slides.qmd'), mapping, ws.root).replaceAll(`../../topics/${shelf}/images/`, 'images/');
    if (!existsSync(join(dest, 'reference.bib'))) await atomicWriteFile(join(dest, 'reference.bib'), '', 0o600);
    await atomicWriteFile(join(dest, 'slides.qmd'), text, 0o600);
    mkdirSync(base, {recursive: true});
    for (const [source, target] of targets) {
      created.push(target);
      await new Copier(ws, source, base, ['_lib', 'shared'], targets, dirname(source)).copy(basename(target));
    }
    await migrate(ws); ws.touch_recent(name); return dest;
  } catch (error) { for (const path of created.reverse()) rmSync(path, {recursive: true, force: true}); throw error; }
}
