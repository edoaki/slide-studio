/** Insertion candidates derived from existing manuscripts; nothing is persisted. */
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace, figure_steps } from './legacy-workspace.js';
import * as bibliography from './legacy-bibliography.js';
import { parse, math_breaks } from './legacy-source.js';
import { run_pandoc } from './legacy-pandoc.js';
import { pyStrip } from './legacy-cover.js';
import { isInsideRoot } from './paths.js';
import * as assets from './legacy-assets.js';
import * as figures from './legacy-figures.js';
const MATH_ARGS=['--from','markdown+tex_math_dollars','--to','html5','--mathml','--wrap=none'];
/** Reject links, including dangling ones, before reading or moving topic files. */
export function topic_path(ws:Workspace,shelf:string,suffix='') {
 const path=resolve(ws.topic_dir(shelf),suffix);
 if(!isInsideRoot(ws.topic_dir(shelf),path))throw Error('トピックの場所が正しくありません');
 for(let p=path;;p=dirname(p)) {
  try { if(lstatSync(p).isSymbolicLink())throw Error('シンボリックリンクを経由できません'); }
  catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(p===resolve(ws.root))break;
 }
 return path;
}
const escapePattern=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
export function topic_listing(ws:Workspace,shelf:string) {
 const base=topic_path(ws,shelf,'html');
 if(!existsSync(base)||!statSync(base).isDirectory())throw Error(`トピックがありません: ${shelf}`);
 const recent=ws.recent(),decks=recent.filter(d=>d.shelf===shelf).map(d=>({...d,deck:String(d.deck),shots:[] as string[],thumb:null}));
 const texts=new Map(recent.map(d=>[String(d.deck),readFileSync(ws.qmd(String(d.deck)),'utf8')]));
 const html:Array<{name:string;path:string;kind:string;status:string;reasons:string[];steps:number;url:string;decks:string[]}>=[];
 let shared=0;
 const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
  const path=join(dir,entry.name),rel=relative(base,path).split('\\').join('/');
  if(entry.isDirectory()){walk(path);continue;} if(!entry.isFile())continue;
  if(rel.split('/')[0]==='_lib'){shared++;continue;}
  if(!['.html','.htm'].includes(extname(path).toLowerCase()))continue;
  const index=entry.name==='index.html',ref=index?relative(base,dirname(path)).split('\\').join('/')||'.':rel;
  const [status,reasons]=index?assets.figure_status(ws,dirname(path)):assets.html_status(path);
  const fig=new RegExp('\\{\\{<\\s*fig\\s+"?'+escapePattern(shelf+'/'+ref)+'["\\s>]','u');
  const link=new RegExp('(?:\\.\\./)+topics/'+escapePattern(shelf+'/html/'+rel)+'(?=["\\s)>?#]|$)','u');
  html.push({name:ref,path:rel,kind:index&&status!=='ng'?'figure':'html',status,reasons,steps:index&&status!=='ng'?figure_steps(dirname(path)).length:0,url:'/files/topics/'+[shelf,'html',...rel.split('/')].map(encodeURIComponent).join('/'),decks:[...texts].filter(([,text])=>(index&&fig.test(text))||link.test(text)).map(([d])=>d)});
 }};walk(base);
 let bib:ReturnType<typeof bibliography.listing>=[],bib_error=false;
 try{bib=bibliography.listing(topic_path(ws,shelf,'reference.bib'));}catch{bib_error=true;}
 return {name:shelf,recent:decks,html,shared_count:shared,bib:bib.map(e=>({...e,decks:decks.filter(d=>bibliography.cites(texts.get(String(d.deck))??'',e.key)).map(d=>d.deck)})),bib_error};
}
export function delete_topic_html(ws:Workspace,shelf:string,paths:unknown) {
 if(!Array.isArray(paths)||!paths.length||paths.some(p=>typeof p!=='string'))throw Error('htmlMissing');
 const items=new Map(topic_listing(ws,shelf).html.map(i=>[i.path,i]));
 const trash=join(ws.state,'trash','_assets',shelf,randomUUID(),'html');
 const targets=[...new Set(paths as string[])].map(path=>{
  const item=items.get(path);if(!item)throw Error('htmlMissing');if(item.decks.length)throw Error('htmlInUse');
  const src=topic_path(ws,shelf,'html/'+path),dst=join(trash,path);
  for(let p=dirname(dst);p!==resolve(ws.root);p=dirname(p)){try{if(lstatSync(p).isSymbolicLink())throw Error('シンボリックリンクを経由できません');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  return {path,src,dst};
 });
 const done:typeof targets=[];
 try{for(const t of targets){mkdirSync(dirname(t.dst),{recursive:true});renameSync(t.src,t.dst);done.push(t);}}
 catch(e){for(const t of done.reverse())renameSync(t.dst,t.src);throw e;}
 return targets.map(t=>({path:t.path,trash:relative(ws.root,t.dst).split('\\').join('/')}));
}
export async function math_html(tex:string,pandocPath:string,cwd:string){tex=pyStrip(tex);if(!tex)return '';const {stdout}=await run_pandoc(`$$\n${math_breaks(tex)}\n$$\n`,MATH_ARGS,{pandocPath,cwd,timeoutMs:15000});if(!stdout.includes('<math'))throw Error('数式として読めません');return stdout.trim();}
export function decks_of(ws:Workspace,deck:string):[string|null,string[]]{let shelf:string;try{shelf=ws.deck_shelf(deck);}catch{return [null,[deck]];}const others=ws.list_decks().filter(d=>{try{return d!==deck&&ws.deck_meta(d).topic===shelf;}catch{return false;}});others.sort((a,b)=>statSync(ws.qmd(b)).mtimeMs-statSync(ws.qmd(a)).mtimeMs);return [shelf,[deck,...others]];}
function maths(raw:string):Array<[string,boolean]>{if(/^\s*(```|~~~)/u.test(raw))return [];raw=raw.replace(/(`+).+?\1/gs,' ');const display=/\$\$(.+?)\$\$/gs,out:Array<[string,boolean]>=[];for(const m of raw.matchAll(display))out.push([pyStrip(m[1]!),true]);raw=raw.replace(display,' ');for(const m of raw.matchAll(/(?<![\\$])\$(?=[^\s$])([^$\n]*?[^\s\\$])\$(?!\d)/gu))out.push([pyStrip(m[1]!),false]);return out;}
export function collect(ws:Workspace,deck:string){ws.require_deck(deck);const [shelf,decks]=decks_of(ws,deck);const found=new Map<string,{tex:string;display:boolean;count:number;decks:string[];order:number}>();for(const [order,d] of decks.entries()){let text:string;try{text=readFileSync(ws.qmd(d),'utf8');}catch{continue;}const chars=Array.from(text);for(const page of parse(text).pages)for(const c of page.walk())if(c.kind==='text')for(const [tex,display] of maths(chars.slice(c.start,c.end).join(''))){if(!tex)continue;const key=tex.replace(/\s+/gu,'');let item=found.get(key);if(!item){item={tex,display,count:0,decks:[],order};found.set(key,item);}item.count++;item.display ||= display;if(!item.decks.includes(d))item.decks.push(d);}}
 return {shelf,decks,math:[...found.values()].sort((a,b)=>a.order-b.order||b.count-a.count).slice(0,300).map(({order,...item})=>item),images:[],figures:[]};}
const mathCache=new Map<string,string|null>();
export async function math_many(texs:string[],pandocPath:string,cwd:string){const todo=[...new Set(texs)].filter(t=>!mathCache.has(t)&&!t.includes('$$'));if(todo.length){const src=todo.map((t,i)=>`::: {#m${i}}\n$$\n${math_breaks(t)}\n$$\n:::`).join('\n\n');let stdout='';try{({stdout}=await run_pandoc(src,MATH_ARGS,{pandocPath,cwd,timeoutMs:30000}));}catch{/* Invalid equations remain visible as TeX. */}const got=new Map([...stdout.matchAll(/<div id="m(\d+)">\s*(.*?)\s*<\/div>/gs)].map(m=>[Number(m[1]),m[2]!]));if(mathCache.size>5000)mathCache.clear();todo.forEach((t,i)=>{const html=got.get(i);mathCache.set(t,html?.includes('<math')?html:null);});}return texs.map(t=>mathCache.get(t)??null);}
export async function listing(ws:Workspace,deck:string,pandocPath:string){const out=collect(ws,deck),html=await math_many(out.math.map(m=>m.tex),pandocPath,ws.root);return {...out,math:out.math.map((m,i)=>({...m,html:html[i]}))};}
function files(base:string):Map<string,Buffer>{const out=new Map<string,Buffer>();function walk(d:string){for(const name of readdirSync(d).sort()){if(figures.SKIP.has(name))continue;const p=join(d,name),st=lstatSync(p);if(st.isSymbolicLink())throw Error('シンボリックリンクを含む図はコピーできません');if(st.isDirectory())walk(p);else if(st.isFile())out.set(relative(base,p),readFileSync(p));}}walk(base);return out;}
export async function take(ws:Workspace,deck:string,kind:string,srcDeck:string,path:string){ws.require_deck(deck);ws.require_deck(srcDeck);const shelf=ws.deck_shelf(deck),other=ws.deck_shelf(srcDeck),src=realpathSync(ws.asset_root(srcDeck));if(kind==='image'){let f:string;try{f=realpathSync(resolve(src,path));}catch{throw Error(`画像がありません: ${path}`);}if(!isInsideRoot(join(src,'images'),f)||!statSync(f).isFile()||!['.png','.jpg','.jpeg','.gif','.webp','.svg','.avif'].includes(extname(f).toLowerCase()))throw Error(`画像がありません: ${path}`);if(shelf===other)return {kind:'images',path:relative(src,f).split('\\').join('/'),name:basename(f),reused:true};return assets.add(ws,deck,basename(f),readFileSync(f));}
 if(kind==='figure'){if(!path||/[\\/\0]/u.test(path)||path.startsWith('.'))throw Error(`図がありません: ${path}`);const d=join(ws.shelf_dir(other),path);if(!existsSync(join(d,'figure.mjs'))||!isInsideRoot(realpathSync(ws.shelf_dir(other)),realpathSync(d)))throw Error(`図がありません: ${path}`);const mine=join(ws.shelf_dir(shelf),path);if(shelf===other)return {ref:`${shelf}/${path}`,reused:true};if(existsSync(mine)){const a=files(mine),b=files(d);if(a.size===b.size&&[...a].every(([k,v])=>b.get(k)?.equals(v)))return {ref:`${shelf}/${path}`,reused:true};}const copied=await figures.copy_figure(ws,d,ws.shelf_dir(shelf));return {ref:`${shelf}/${basename(copied)}`,reused:false};}throw Error(`入れられない種類です: ${kind}`);}
