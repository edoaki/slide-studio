/** Recoverable home items. IDs are relative trash paths, never arbitrary filesystem paths. */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { Workspace, check_name } from './workspace.js';
import { Change, safe, undo } from './deck-manage.js';

export interface TrashItem { id:string; kind:'deck'|'theme'|'topic'; name:string; title:string; deleted:number }
export function listing(ws:Workspace):TrashItem[]{
 const base=join(ws.state,'trash'),items:TrashItem[]=[];
 const entries=(dir:string)=>{safe(ws,dir);return existsSync(dir)?readdirSync(dir,{withFileTypes:true}).filter(e=>!e.isSymbolicLink()):[];};
 const add=(path:string,kind:TrashItem['kind'],name:string,title=name)=>{
  safe(ws,path);check_name(name);
  const id=relative(base,path).split('\\').join('/');
  const stamp=kind==='topic'?id.match(/-(\d+)$/u)?.[1]:id.split('/')[1];
  const deleted=kind==='deck'?lstatSync(path).mtimeMs/1000:Number(stamp)/1e9;
  items.push({id,kind,name,title,deleted});
 };
 for(const group of entries(base)){
  if(!group.isDirectory())continue;
  const dir=join(base,group.name);
  if(group.name==='topics'){
   for(const e of entries(dir)){const match=/^(.+)-\d{19}$/u.exec(e.name);if(e.isDirectory()&&match)add(join(dir,e.name),'topic',match[1]!);}
  }else if(group.name==='themes'){
   for(const stamp of entries(dir).filter(e=>e.isDirectory()&&/^\d+$/u.test(e.name)))for(const css of entries(join(dir,stamp.name))){
    if(css.isFile()&&css.name.endsWith('.css'))add(join(dir,stamp.name,css.name),'theme',css.name.slice(0,-4));
   }
  }
  {
   for(const stamp of entries(dir).filter(e=>e.isDirectory()&&/^[a-f\d-]{36}$/u.test(e.name))){
    const path=join(dir,stamp.name),qmd=join(path,'deck','slides.qmd');safe(ws,qmd);
    if(!existsSync(qmd)||!lstatSync(qmd).isFile())continue;
    let title=group.name;
    try{const front=/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---/u.exec(readFileSync(qmd,'utf8'));const meta=front?parse(front[1]!):null;if(typeof meta?.title==='string')title=meta.title;}catch{/* A damaged title must not hide recoverable files. */}
    add(path,'deck',group.name,title);
   }
  }
 }
 return items.sort((a,b)=>b.deleted-a.deleted||a.id.localeCompare(b.id));
}
export async function restore(ws:Workspace,id:string){
 const item=listing(ws).find(i=>i.id===id);if(!item)throw Error('ごみ箱に見つかりません');
 const source=join(ws.state,'trash',item.id);
 if(item.kind==='deck'){
  const metadata=join(source,'restore.json');safe(ws,metadata);
  const data=existsSync(metadata)?JSON.parse(readFileSync(metadata,'utf8')):null;
  const recent=Array.isArray(data?.recent)?data.recent.filter((r:unknown)=>r&&typeof r==='object'&&'deck' in r&&r.deck===item.name):[];
  await undo(ws,{kind:'delete',deck:item.name,trash:source,recent});
 }else{
  const change=new Change(ws);
  try{
   const destination=item.kind==='topic'?ws.topic_dir(item.name):join(ws.themes,`${item.name}.css`);
   change.move(source,destination);
   if(item.kind==='theme'){
    const defaults=join(dirname(source),'defaults',`${item.name}.css`),target=join(ws.state,'theme-defaults',`${item.name}.css`);
    safe(ws,defaults);
    if(existsSync(defaults)){
     // A recreated theme may have left a baseline behind; preserve it on failure.
     await change.write(target,readFileSync(defaults));
    }else await change.write(target,readFileSync(destination));
    change.move(join(dirname(source),'previews',item.name),join(ws.state,'themes',item.name));
   }
  }catch(error){await change.rollback();throw error;}
 }
 return item;
}
