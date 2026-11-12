/** Home card operations preserve manuscript bytes and move associated history together. */
import { lstatSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMap, isScalar, parseDocument } from 'yaml';
import { atomicWriteFile } from './atomic.js';
import { Workspace, check_name, set_front } from './legacy-workspace.js';
import { isInsideRoot } from './paths.js';

function safe(ws:Workspace,path:string){
 if(!isInsideRoot(ws.root,path))throw Error('保存先が正しくありません');
 for(let p=resolve(path);;p=dirname(p)){
  try{if(lstatSync(p).isSymbolicLink())throw Error(`シンボリックリンクを経由できません: ${p}`);}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(p===resolve(ws.root))break;
 }
}
class Change {
 private moves:Array<[string,string]>=[];
 private writes:Array<[string,Buffer|null,number]>=[];
 constructor(private ws:Workspace){}
 move(src:string,dst:string){safe(this.ws,src);safe(this.ws,dst);if(!existsSync(src))return;if(existsSync(dst))throw Error(`既にあります: ${dst}`);mkdirSync(dirname(dst),{recursive:true});renameSync(src,dst);this.moves.push([src,dst]);}
 async write(path:string,data:string|Buffer){safe(this.ws,path);const before=existsSync(path)?readFileSync(path):null,mode=before?lstatSync(path).mode&0o777:0o600;await atomicWriteFile(path,data,mode);this.writes.push([path,before,mode]);}
 async rollback(){for(const [path,before,mode] of this.writes.reverse()){if(before===null)rmSync(path,{force:true});else await atomicWriteFile(path,before,mode);}for(const [src,dst] of this.moves.reverse()){mkdirSync(dirname(src),{recursive:true});renameSync(dst,src);}}
}
function recent(ws:Workspace):Array<Record<string,unknown>>{safe(ws,ws.recent_file);if(!existsSync(ws.recent_file))return [];const data:unknown=JSON.parse(readFileSync(ws.recent_file,'utf8'));if(!Array.isArray(data)||data.some(d=>!d||typeof d!=='object'))throw Error('最近開いた発表の記録を読めません');return data;}
export function rewrite_paths(value:unknown,old:string,name:string):unknown {
 const path=(s:string)=>{const prefix=`decks/${old}`;if(s!==prefix&&!s.startsWith(prefix+'/'))return s;let tail=s.slice(prefix.length);if(tail===`/${old}.html`||tail===`/${old}.pdf`)tail=`/${name}${tail.slice(tail.lastIndexOf('.'))}`;return `decks/${name}${tail}`;};
 if(Array.isArray(value))return value.map(v=>rewrite_paths(v,old,name));
 if(value&&typeof value==='object'){const prose=new Set(['text','summary','label','title','name','error','steps','drafts','session']);return Object.fromEntries(Object.entries(value).map(([k,v])=>[path(k),prose.has(k)?v:rewrite_paths(v,old,name)]));}
 return typeof value==='string'?path(value):value;
}
/** Splice only the YAML title value, preserving comments, aliases and original line endings. */
export function title_text(text:string,title:string){
 const match=/^(\uFEFF?---[^\S\r\n]*(?:\r\n|\n|\r))([\s\S]*?)(^(?:---|\.\.\.)[^\S\r\n]*(?:\r\n|\n|\r|$))/mu.exec(text);
 if(!match||match.index!==0)return set_front(text,{title:JSON.stringify(title)});
 const front=match[2]!,doc=parseDocument(front,{keepSourceTokens:true});
 if(doc.errors.length)throw Error(doc.errors[0]!.message);
 if(!isMap(doc.contents))throw Error('front matter はキーと値で指定してください');
 const pair=doc.contents.items.find(p=>isScalar(p.key)&&p.key.value==='title'),encoded=JSON.stringify(title);
 let updated:string;
 if(pair&&pair.value&&typeof pair.value==='object'&&'range' in pair.value&&pair.value.range){
  const [start,end]=pair.value.range as [number,number,number];
  // Anchors precede the scalar's range and therefore stay attached to its replacement.
  const original=front.slice(start,end),ending=original.match(/(?:\r\n|\n|\r)$/u)?.[0]??'';
  updated=front.slice(0,start)+encoded+ending+front.slice(end);
 }else if(pair){throw Error('タイトルの値を読めません');}
 else if(doc.contents.flow){const pos=front.indexOf('{')+1;updated=front.slice(0,pos)+`title: ${encoded}${doc.contents.items.length?', ':''}`+front.slice(pos);}
 else updated=`title: ${encoded}${match[1]!.endsWith('\r\n')?'\r\n':'\n'}`+front;
 return match[1]+updated+text.slice(match[1]!.length+front.length);
}
interface RenameRecord {kind:'rename';deck:string;name:string;before:string;after:string}
interface DeleteRecord {kind:'delete';deck:string;trash:string;recent:Array<Record<string,unknown>>}
export type ManageRecord=RenameRecord|DeleteRecord;
async function renameDeck(ws:Workspace,deck:string,name:string,title?:string):Promise<{record:RenameRecord;change:Change}>{
 ws.require_deck(deck);if(name!==deck)check_name(name,'フォルダ名');safe(ws,ws.qmd(deck));
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readFileSync(ws.qmd(deck))),updated=title===undefined?text:title_text(text,title),change=new Change(ws);
 try{
  if(name!==deck){
   const pairs:Array<[string,string]>=[[ws.deck_dir(deck),ws.deck_dir(name)],...['build','snapshots','chat'].map(k=>[join(ws.state,k,k==='chat'?`${deck}.json`:deck),join(ws.state,k,k==='chat'?`${name}.json`:name)] as [string,string])];
   for(const [src,dst] of pairs){safe(ws,src);safe(ws,dst);if(existsSync(dst))throw Error(`既にあります: ${dst}`);}
   for(const ext of ['html','pdf']){const dst=join(ws.deck_dir(deck),`${name}.${ext}`);safe(ws,dst);if(existsSync(dst))throw Error(`既にあります: ${name}.${ext}`);}
   for(const [src,dst] of pairs)change.move(src,dst);
   for(const ext of ['html','pdf'])change.move(join(ws.deck_dir(name),`${deck}.${ext}`),join(ws.deck_dir(name),`${name}.${ext}`));
   const snapshots=join(ws.state,'snapshots',name);
   for(const child of existsSync(snapshots)?readdirSync(snapshots).sort():[]){
    const snap=join(snapshots,child);safe(ws,snap);if(!lstatSync(snap).isDirectory())continue;
    const saved=join(snap,'files','decks',name);change.move(join(snap,'files','decks',deck),saved);
    for(const ext of ['html','pdf'])change.move(join(saved,`${deck}.${ext}`),join(saved,`${name}.${ext}`));
    for(const filename of ['snapshot.json','manifest.json','after.json']){const p=join(snap,filename);safe(ws,p);if(existsSync(p)){const data=rewrite_paths(JSON.parse(readFileSync(p,'utf8')),deck,name) as Record<string,unknown>;if(filename==='snapshot.json')data.deck=name;await change.write(p,JSON.stringify(data));}}
   }
   const chat=join(ws.state,'chat',`${name}.json`);safe(ws,chat);if(existsSync(chat))await change.write(chat,JSON.stringify(rewrite_paths(JSON.parse(readFileSync(chat,'utf8')),deck,name)));
   await change.write(ws.recent_file,JSON.stringify(recent(ws).map(i=>i.deck===deck?{...i,deck:name}:i)));
  }
  await change.write(ws.qmd(name),updated);
 }catch(e){await change.rollback();throw e;}
 return {record:{kind:'rename',deck,name,before:text,after:updated},change};
}
export async function rename(ws:Workspace,deck:string,name:string,title?:string){return (await renameDeck(ws,deck,name,title)).record;}
export async function remove(ws:Workspace,deck:string):Promise<DeleteRecord>{
 ws.require_deck(deck);safe(ws,ws.qmd(deck));const change=new Change(ws),trash=join(ws.state,'trash',deck,randomUUID()),items=recent(ws);
 try{change.move(ws.deck_dir(deck),join(trash,'deck'));for(const k of ['chat','snapshots','build'])change.move(join(ws.state,k,k==='chat'?`${deck}.json`:deck),join(trash,k));await change.write(ws.recent_file,JSON.stringify(items.filter(i=>i.deck!==deck)));}
 catch(e){await change.rollback();throw e;}
 return {kind:'delete',deck,trash,recent:items};
}
export async function undo(ws:Workspace,record:ManageRecord){
 if(record.kind==='rename'){
  safe(ws,ws.qmd(record.name));if(readFileSync(ws.qmd(record.name),'utf8')!==record.after)throw Error('原稿が変わったため元に戻せません');
  const {change}=await renameDeck(ws,record.name,record.deck);
  try{await change.write(ws.qmd(record.deck),record.before);}catch(e){await change.rollback();throw e;}return;
 }
 const change=new Change(ws),deck=record.deck;
 safe(ws,join(record.trash,'deck','slides.qmd'));if(!existsSync(join(record.trash,'deck','slides.qmd')))throw Error('ゴミ箱に発表が見つかりません');
 const pairs:Array<[string,string]>=[[join(record.trash,'deck'),ws.deck_dir(deck)],...['chat','snapshots','build'].map(k=>[join(record.trash,k),join(ws.state,k,k==='chat'?`${deck}.json`:deck)] as [string,string])];
 for(const [,dst] of pairs){safe(ws,dst);if(existsSync(dst))throw Error(`既にあります: ${dst}`);}
 try{for(const [src,dst] of pairs)change.move(src,dst);await change.write(ws.recent_file,JSON.stringify([...recent(ws).filter(i=>i.deck!==deck),...record.recent.filter(i=>i.deck===deck)]));}
 catch(e){await change.rollback();throw e;}
}
