/** Shared topic assets, matching the original assets.py API. */
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Workspace, figure_steps, figure_title } from './legacy-workspace.js';
import * as figures from './legacy-figures.js';
import { isInsideRoot } from './paths.js';
export const MAX_BYTES=50*1024*1024;
const IMAGE_EXT=new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.avif']);
const HTML_EXT=new Set(['.html','.htm']);
const EXTERNAL=/(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|@import\s+(?:url\()?["']?(?:https?:)?\/\/|\bimport\s[^;]*?from\s*["'](?:https?:)?\/\//i;
const rel=(base:string,path:string)=>relative(base,path).split(sep).join('/');
const present=(p:string)=>{try{lstatSync(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
function noLinks(root:string,path:string){if(!isInsideRoot(root,path))throw Error('素材の場所が正しくありません');for(let p=path;;p=dirname(p)){if(present(p)&&lstatSync(p).isSymbolicLink())throw Error('シンボリックリンクを経由できません');if(p===root)break;}}
function folder(ws:Workspace,deck:string){ws.require_deck(deck);const base=ws.asset_root(deck);noLinks(resolve(ws.root),base);return base;}
export function safe_name(name:string,fallback:string){name=basename(name||'').normalize('NFC');const ext=extname(name);const stem=basename(name,ext).replace(/[\s()\[\]{}<>"'`#?%&;|\\/:*!$^=+,@]+/gu,'-').replace(/^[-.]+|[-.]+$/gu,'')||fallback;return Array.from(stem).slice(0,80).join('')+ext.toLowerCase();}
function stamp(){const d=new Date();const n=(v:number)=>String(v).padStart(2,'0');return `${d.getFullYear()}${n(d.getMonth()+1)}${n(d.getDate())}-${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;}
export function add(ws:Workspace,deck:string,filename:string,data:Uint8Array,contentType=''){
 const root=folder(ws,deck);if(data.byteLength>MAX_BYTES)throw Error('ファイルが大きすぎます（50MB まで）');let ext=extname(filename).toLowerCase();
 if(!ext&&contentType.startsWith('image/')){const mime=contentType.slice(6).split(';')[0]!;ext='.'+({ 'svg+xml':'svg',jpeg:'jpg' }[mime]??mime);filename+=ext;}
 const kind=IMAGE_EXT.has(ext)?'images':HTML_EXT.has(ext)?'html':null;if(!kind)throw Error(`画像か HTML を選んでください: ${filename||'名前のないファイル'}`);
 const base=join(root,kind);noLinks(ws.root,base);const fallback='paste-'+stamp();let name=safe_name(filename,fallback);if(/^(image|blob|clipboard)\.\w+$/i.test(name))name=fallback+ext;
 if(existsSync(base))for(const f of readdirSync(base).sort()){const path=join(base,f),st=lstatSync(path);if(st.isFile()&&st.size===data.byteLength&&readFileSync(path).equals(Buffer.from(data)))return {kind,path:rel(root,path),name:f,reused:true};}
 let target=join(base,name),n=2;while(present(target))target=join(base,`${basename(name,ext)}-${n++}${ext}`);
 mkdirSync(base,{recursive:true});const temp=join(base,`.${randomUUID()}.tmp`);try{writeFileSync(temp,data,{flag:'wx'});renameSync(temp,target);}finally{rmSync(temp,{force:true});}
 return {kind,path:rel(root,target),name:basename(target),reused:false};
}
function walk(base:string):string[]{if(!existsSync(base)||lstatSync(base).isSymbolicLink())return [];const out:string[]=[];for(const name of readdirSync(base).sort()){if(name.startsWith('.'))continue;const p=join(base,name),st=lstatSync(p);if(st.isSymbolicLink())continue;if(st.isDirectory())out.push(...walk(p));else if(st.isFile())out.push(p);}return out;}
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const usage=(text:string,needle:RegExp)=>text.split(/^#{1,2}[ \t]+\S.*$/m).filter(p=>needle.test(p)).length;
export function figure_status(ws:Workspace,d:string):[string,string[]]{
 if(!existsSync(join(d,'figure.mjs')))return ['ng',['figure.mjs がありません（Slide Studio の図の形式ではありません）']];
 noLinks(ws.root,join(d,'figure.mjs'));
 let code:string;try{code=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(join(d,'figure.mjs')));}catch{return ['ng',['figure.mjs を読めません']];}
 const errors:string[]=[],warns:string[]=[];
 if(!code.includes('export default'))errors.push('figure.mjs に export default がありません');else if(!/\brenderStep\s*[(:]/u.test(code))errors.push('figure.mjs に renderStep がありません');
 const pending=walk(d).filter(p=>p.endsWith('.mjs')&&basename(p)!=='main.mjs'),seen=new Set<string>();
 while(pending.length){const mod=resolve(pending.pop()!);if(seen.has(mod))continue;seen.add(mod);try{noLinks(ws.root,mod);}catch{errors.push(`部品が置き場の外にあります: ${basename(mod)}`);continue;}let src:string;try{src=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(mod));}catch{continue;}const name=rel(ws.root,mod);
 for(const m of src.matchAll(new RegExp(figures.DYNAMIC.source,'gu')))errors.push(`${m[0].includes('fetch')?'fetch':'動的 import'} は使えません（${name}）`);
 for(const spec of figures.imports(src)){const part=resolve(dirname(mod),spec);if(!existsSync(part))errors.push(`部品がありません: ${spec}（${name}）`);else pending.push(part);}
 if(EXTERNAL.test(src))errors.push(`外部のファイルを読み込んでいます（${name}）`);}
 const css=join(d,'style.css');noLinks(ws.root,css);if(existsSync(css)&&EXTERNAL.test(readFileSync(css,'utf8')))errors.push('style.css で外部のファイルを読み込んでいます');
 const index=join(d,'index.html');noLinks(ws.root,index);if(!existsSync(index))warns.push('index.html がありません（表示するときに雛形から作ります）');else if(readFileSync(index,'utf8')!==figures.index_html(d,ws))warns.push('index.html が雛形と違います（表示するときに雛形に戻します）');
 return errors.length?['ng',[...new Set(errors)]]:[warns.length?'warn':'ok',warns];
}
export function html_status(path:string):[string,string[]]{const reasons=['Slide Studio の図の形式ではありません（figure.mjs の renderStep で step ごとの SVG を返す形が必要）'];let html:string;try{html=readFileSync(path,'utf8');}catch{return ['ng',['読めません']];}if(EXTERNAL.test(html))reasons.push('外部（CDN など）のファイルを読み込んでいます。書き出した HTML はオフラインで動かないことがあります');if(/\b(fetch|XMLHttpRequest)\s*\(|\bimport\s*\(/u.test(html))reasons.push('fetch・動的 import を使っています');return ['ng',reasons];}
export function listing(ws:Workspace,deck:string){
 const root=folder(ws,deck),text=readFileSync(ws.qmd(deck),'utf8'),shelf=ws.deck_shelf(deck),every:Record<string,string>={},same:Record<string,string>={};
 for(const other of ws.list_decks())if(other!==deck)try{every[other]=readFileSync(ws.qmd(other),'utf8');if(ws.deck_meta(other).topic===shelf)same[other]=every[other]!;}catch{/* A concurrently removed deck is omitted. */}
 const usedBy=(texts:Record<string,string>,re:RegExp)=>Object.entries(texts).filter(([,t])=>re.test(t)).map(([k])=>k);
 const url=(p:string)=>'/files/'+rel(ws.root,p).split('/').map(encodeURIComponent).join('/');
 const images=walk(join(root,'images')).filter(p=>IMAGE_EXT.has(extname(p).toLowerCase())).map(p=>{const path=rel(root,p),needle=new RegExp('\\]\\(<?'+escape(path)+'[\\s)>]','u'),st=statSync(p);return {kind:'image',name:basename(p),path,size:st.size,url:url(p)+'?v='+Math.floor(st.mtimeMs/1000),used:usage(text,needle),others:usedBy(same,needle),modified:st.mtimeMs/1000};});
 const html:Record<string,unknown>[]=[],hdir=ws.shelf_dir(shelf);noLinks(ws.root,hdir);
 if(existsSync(hdir))for(const name of readdirSync(hdir).sort()){const d=join(hdir,name);if(name.startsWith('.')||name.startsWith('_')||!lstatSync(d).isDirectory())continue;
 const [status,reasons]=figure_status(ws,d),ref=`${shelf}/${name}`,needle=new RegExp('\\{\\{<\\s*fig\\s+"?'+escape(ref)+'["\\s>]','u');
 html.push({kind:'figure',name,path:`html/${name}`,ref,place:'shelf',title:figure_title(d),steps:figure_steps(d).length,url:existsSync(join(d,'index.html'))?url(join(d,'index.html')):null,status,reasons,used:usage(text,needle),others:usedBy(every,needle),modified:Math.max(statSync(d).mtimeMs,...readdirSync(d).map(f=>lstatSync(join(d,f)).mtimeMs))/1000});}
 for(const p of walk(join(root,'html')))if(HTML_EXT.has(extname(p).toLowerCase())&&!(basename(p)==='index.html'&&existsSync(join(dirname(p),'figure.mjs')))){const [status,reasons]=html_status(p);html.push({kind:'html',name:basename(p),path:rel(root,p),place:'file',title:basename(p,extname(p)),url:url(p),status,reasons,used:0,others:[],modified:statSync(p).mtimeMs/1000});}
 return {shelf,images,html};
}
function asset(ws:Workspace,deck:string,path:string){const root=folder(ws,deck),parts=path.split('/');if(parts.length<2||!['images','html'].includes(parts[0]!)||parts.some(p=>!p||p.startsWith('.')||/[\\\0]/u.test(p)))throw Error(`素材の場所が正しくありません: ${path}`);const target=join(root,...parts);noLinks(ws.root,dirname(target));return target;}
export interface TrashItem {path:string;trash:string}
function trashBase(ws:Workspace,deck:string){const base=join(ws.state,'trash','_assets',ws.deck_shelf(deck));noLinks(ws.root,base);return base;}
function moveAll(moves:{src:string;dst:string}[]){const done:typeof moves=[];try{for(const m of moves){mkdirSync(dirname(m.dst),{recursive:true});renameSync(m.src,m.dst);done.push(m);}}catch(e){for(const m of done.reverse())renameSync(m.dst,m.src);throw e;}}
export function remove(ws:Workspace,deck:string,paths:string[]):TrashItem[]{
 const selected=[...new Set(paths)],targets=selected.map(path=>{const src=asset(ws,deck,path);if(!present(src))throw Error(`見つかりません: ${path}`);return {path,src};}).filter(t=>!selected.some(p=>t.path.startsWith(p+'/')));
 const base=join(trashBase(ws,deck),stamp()+'-'+randomUUID());const moves=targets.map(t=>({...t,dst:join(base,t.path)}));moveAll(moves);return moves.map(t=>({path:t.path,trash:rel(ws.root,t.dst)}));
}
export function restore(ws:Workspace,deck:string,items:TrashItem[]){const base=trashBase(ws,deck),destinations=new Set<string>(),sources=new Set<string>();
 const moves=items.map(it=>{const dst=asset(ws,deck,it.path),parts=it.trash.split('/'),src=join(ws.root,...parts);if(parts.some(p=>!p||p==='.'||p==='..'||/[\\\0]/u.test(p))||!isInsideRoot(base,src)||rel(base,src).split('/').length<2)throw Error('ごみ箱の場所が正しくありません');noLinks(ws.root,dirname(src));if(!present(src))throw Error(`ごみ箱に見つかりません: ${it.path}`);if(present(dst)||destinations.has(dst)||sources.has(src))throw Error(`同じ名前があります: ${it.path}`);destinations.add(dst);sources.add(src);return {src,dst};});
 for(const a of moves)for(const b of moves)if(a!==b&&(isInsideRoot(a.src,b.src)||isInsideRoot(a.dst,b.dst)))throw Error('復元する場所が重なっています');moveAll(moves);return items.map(it=>({path:it.path}));}
