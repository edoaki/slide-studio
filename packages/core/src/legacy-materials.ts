/** Reference materials: preserve the original folder layout and never overwrite. */
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Workspace } from './legacy-workspace.js';
import { pyStrip } from './legacy-cover.js';
import { isInsideRoot } from './paths.js';
export const MAX_BYTES = 500 * 1024 * 1024;
export const DIR = 'materials';
export function is_material(path: string): boolean { const p=path.split('/'); return p.length>2 && p[0]==='decks' && p[2]===DIR; }
const rel = (base:string,path:string) => relative(base,path).split(sep).join('/');
const present = (path:string) => {try {lstatSync(path);return true;} catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}};
function noLinks(root:string,path:string): void {
  if(!isInsideRoot(root,path)) throw new Error('置き場の外は操作できません');
  for(let p=path;;p=dirname(p)) {
    if(present(p)&&lstatSync(p).isSymbolicLink())throw new Error(`シンボリックリンクを経由できません: ${p}`);
    if(p===root)break;
  }
}
export function folder(ws:Workspace,deck:string):string {
  const base=join(ws.require_deck(deck),DIR);
  noLinks(resolve(ws.root),base);
  return base;
}
function parts(path:string):string[] {
  const items=path.split(/[\\/]+/u).map(p=>pyStrip(p.normalize('NFC'))).filter(Boolean);
  if(!items.length || items.some(p=>p==='.'||p==='..'||p.startsWith('.')||p.includes('\0')))throw new Error(`このファイルは置けません: ${path||'名前のないファイル'}`);
  return items;
}
function target(ws:Workspace,deck:string,path:string):[string,string] {
  const base=folder(ws,deck), dest=join(base,...parts(path));
  noLinks(resolve(ws.root),dirname(dest));
  return [base,dest];
}
export interface MaterialEntry {path:string;name:string;dir:boolean;modified:number;size?:number}
function entries(base:string):MaterialEntry[] {
  const out:MaterialEntry[]=[];
  function walk(path:string):void {
    let kids:string[];try{kids=readdirSync(path).filter(n=>!n.startsWith('.'));}catch{return;}
    const order=(name:string)=>{try{return lstatSync(join(path,name)).isDirectory()?0:1;}catch{return 1;}};
    kids.sort((a,b)=>order(a)-order(b)||(a.toLowerCase()<b.toLowerCase()?-1:a.toLowerCase()>b.toLowerCase()?1:0));
    for(const name of kids){const file=join(path,name);try {
      const st=statSync(file),dir=lstatSync(file).isDirectory();
      out.push({path:rel(base,file),name,dir,modified:st.mtimeMs/1000,...(dir?{}:{size:st.size})});
      if(dir)walk(file);
    }catch{ /* Disappeared or broken link. */ }}
  }
  walk(base);return out;
}
export function listing(ws:Workspace,deck:string){return {path:`decks/${deck}/${DIR}`,entries:entries(folder(ws,deck)),more:0};}
function writeNew(path:string,data:Uint8Array):void {
  mkdirSync(dirname(path),{recursive:true});
  const temp=join(dirname(path),`.${basename(path)}.${randomUUID()}.tmp`);
  try {writeFileSync(temp,data,{flag:'wx'});if(present(path))throw new Error(`同じ名前があります: ${basename(path)}`);renameSync(temp,path);}finally{rmSync(temp,{force:true});}
}
function sameBytes(path:string,data:Uint8Array):boolean {
  return !lstatSync(path).isSymbolicLink() && statSync(path).isFile() && statSync(path).size===data.byteLength && readFileSync(path).equals(Buffer.from(data));
}
export function add(ws:Workspace,deck:string,path:string,data:Uint8Array){
  if(data.byteLength>MAX_BYTES)throw new Error('ファイルが大きすぎます（500MB まで）。大きいものはフォルダを開いて直接置いてください');
  const [base,initial]=target(ws,deck,path),ext=extname(initial),stem=basename(initial,ext);
  let dest=initial,n=2;
  while(present(dest)){if(sameBytes(dest,data))return {path:rel(base,dest),reused:true};dest=join(dirname(initial),`${stem}-${n++}${ext}`);}
  writeNew(dest,data);return {path:rel(base,dest),reused:false};
}
export function create(ws:Workspace,deck:string,path:string,isDir:boolean){
  const [base,dest]=target(ws,deck,path);
  if(present(dest))throw new Error(`同じ名前があります: ${basename(dest)}`);
  if(dirname(dest)!==base&&!existsSync(dirname(dest)))throw new Error(`フォルダがありません: ${rel(base,dirname(dest))}`);
  if(isDir)mkdirSync(dest,{recursive:true});else writeNew(dest,new Uint8Array());
  return {path:rel(base,dest)};
}
export function move(ws:Workspace,deck:string,path:string,to:string){
  const [base,src]=target(ws,deck,path),[,dest]=target(ws,deck,to);
  if(!present(src))throw new Error(`見つかりません: ${path}`);
  if(src===dest)return {path:rel(base,dest)};
  if(isInsideRoot(src,dest))throw new Error('フォルダを自分の中には移せません');
  const same=present(dest)&&dirname(src)===dirname(dest)&&basename(src).toLowerCase()===basename(dest).toLowerCase()&&lstatSync(src).ino===lstatSync(dest).ino&&lstatSync(src).dev===lstatSync(dest).dev;
  if(present(dest)&&!same)throw new Error(`同じ名前があります: ${rel(base,dest)}`);
  if(!existsSync(dirname(dest)))throw new Error(`フォルダがありません: ${rel(base,dirname(dest))}`);
  renameSync(src,dest);return {path:rel(base,dest)};
}
export function remove(ws:Workspace,deck:string,path:string){
  const [base,src]=target(ws,deck,path);
  if(!present(src))throw new Error(`見つかりません: ${path}`);
  const d=new Date(),pad=(n:number)=>String(n).padStart(2,'0');
  const stamp=`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const original=join(ws.state,'trash',deck,stamp,rel(base,src));let dest=original,n=2;
  noLinks(resolve(ws.root),dirname(dest));
  while(present(dest))dest=`${original}-${n++}`;
  mkdirSync(dirname(dest),{recursive:true});renameSync(src,dest);
  return {path:rel(base,src),trash:rel(ws.root,dest)};
}
export function restore(ws:Workspace,deck:string,path:string,trash:string){
  const [base,dest]=target(ws,deck,path),p=trash.split('/');
  if(p.length<5||p[0]!=='.slide-studio'||p[1]!=='trash'||p[2]!==deck||p.some(v=>!v||v==='.'||v==='..'||v.includes('\\')||v.includes('\0')))throw new Error('ごみ箱の場所が正しくありません');
  const src=join(ws.root,...p);noLinks(resolve(ws.root),dirname(src));
  if(!present(src))throw new Error('ごみ箱に見つかりません');
  if(present(dest))throw new Error(`同じ名前があります: ${path}`);
  if(dirname(dest)!==base&&!existsSync(dirname(dest)))throw new Error(`フォルダがありません: ${path}`);
  mkdirSync(dirname(dest),{recursive:true});renameSync(src,dest);return {path:rel(base,dest)};
}
export async function open_in_os(ws:Workspace,deck:string,path:string,openPath:(path:string)=>Promise<void>):Promise<string>{
  const base=folder(ws,deck),dest=path?target(ws,deck,path)[1]:base;
  if(!path)mkdirSync(base,{recursive:true});
  if(!existsSync(dest)||!isInsideRoot(realpathSync(base),realpathSync(dest)))throw new Error(`見つかりません: ${path}`);
  await openPath(dest);return rel(ws.root,dest);
}
export function copy_in(ws:Workspace,deck:string,path:string,sources:string[]){
  const base=folder(ws,deck),dest=path?target(ws,deck,path)[1]:base;
  noLinks(resolve(ws.root),dest);
  if(path&&(!existsSync(dest)||!statSync(dest).isDirectory()))throw new Error(`フォルダがありません: ${path}`);
  mkdirSync(dest,{recursive:true});const added:string[]=[];let reused=0;
  for(const src of sources){const name=basename(src).normalize('NFC');if(!existsSync(src)||name.startsWith('.'))continue;
    if(isInsideRoot(realpathSync(base),realpathSync(src)) || (statSync(src).isDirectory()&&isInsideRoot(realpathSync(src),realpathSync(dest))))throw new Error(`参考資料の中のものは追加できません: ${name}（移すときは持って動かしてください）`);
    const dir=statSync(src).isDirectory(),ext=extname(name),stem=basename(name,ext);let output=join(dest,name),n=2,found=false;
    while(present(output)){if(!dir&&sameBytes(output,readFileSync(src))){found=true;break;}output=join(dest,dir?`${name}-${n++}`:`${stem}-${n++}${ext}`);}
    if(found){reused++;continue;}
    const temp=join(dest,`.${name}.${randomUUID()}.tmp`);
    try{cpSync(src,temp,{recursive:dir,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,filter:p=>p===src||!basename(p).startsWith('.')});renameSync(temp,output);}finally{rmSync(temp,{recursive:true,force:true});}
    added.push(rel(base,output));
  }
  return {added,reused};
}
export function prompt_lines(ws:Workspace,deck:string):string[]{
  const list=listing(ws,deck);if(!list.entries.length)return [];
  const top=list.entries.filter(e=>!e.path.includes('/')),shown=top.slice(0,30).map(e=>e.path+(e.dir?'/':'')),rest=top.length-shown.length;
  return [`[参考資料] ${list.path}/ に ${list.entries.length} 件（読むだけ。変えない）：${shown.join('、')}${rest>0?` ほか${rest}件`:''}`];
}
/** Small previews are returned as inert bytes through the authenticated API. */
export function read_preview(ws:Workspace,deck:string,path:string):Buffer {
  const [base,file]=target(ws,deck,path);
  if(!existsSync(file)||!isInsideRoot(realpathSync(base),realpathSync(file))||!statSync(file).isFile())throw new Error(`見つかりません: ${path}`);
  if(statSync(file).size>1024*1024)throw new Error('ファイルが大きすぎます');
  return readFileSync(file);
}
