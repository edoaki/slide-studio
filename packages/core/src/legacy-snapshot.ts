/** Persistent run snapshots compatible with the original workspace history. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace, check_name, checkLookupName } from './legacy-workspace.js';
import { is_material } from './legacy-materials.js';
import { atomicWriteFile } from './atomic.js';
import { isInsideRoot } from './paths.js';
const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
function present(path:string){try{lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
function safe(ws:Workspace,path:string){if(!isInsideRoot(ws.root,path))throw Error('この置き場の控えではありません');for(let p=resolve(path);;p=dirname(p)){if(present(p)&&lstatSync(p).isSymbolicLink())throw Error(`シンボリックリンクを経由できません: ${p}`);if(p===ws.root)break;}}
function base(ws:Workspace,deck:string){const path=join(ws.state,'snapshots',checkLookupName(deck,'発表の名前'));safe(ws,path);return path;}
export class Snapshot {
 constructor(readonly path:string,readonly deck:string,readonly shelf:string){}
 get scopes(){return [`decks/${this.deck}`,`topics/${this.shelf}`,'themes'];}
 covers(name:string){return !is_material(name)&&this.scopes.some(s=>name===s||name.startsWith(s+'/'));}
}
type Manifest=Record<string,string>;
export interface Changes {added:string[];modified:string[];deleted:string[];outside:string[]}
export interface RestorePlan extends Changes {kept:string[];later:string[]}
export function manifest(ws:Workspace):Manifest {
 const out:Manifest=Object.create(null);
 function walk(dir:string){for(const name of readdirSync(dir).sort()){
  if(dir===ws.root&&name==='.slide-studio')continue;
  const path=join(dir,name),rel=relative(ws.root,path).split('\\').join('/'),st=lstatSync(path,{bigint:true});
  if(st.isSymbolicLink())out[rel]=hash(Buffer.concat([Buffer.from('symlink\0'),readlinkSync(path,{encoding:'buffer'})]));
  else if(st.isDirectory())walk(path);
  else if(st.isFile())out[rel]=is_material(rel)?`stat:${st.size}:${st.mtimeNs}`:hash(readFileSync(path));
 }}walk(ws.root);return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)));
}
function copy(src:string,dst:string){if(!present(src))return;mkdirSync(dirname(dst),{recursive:true});cpSync(src,dst,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,filter:p=>!(dirname(p)===src&&dirname(src).endsWith('/decks')&&p===join(src,'materials'))});}
function verify(ws:Workspace,snap:Snapshot){if(dirname(snap.path)!==base(ws,snap.deck)||!/^\d{20}$/u.test(snap.path.split('/').at(-1)!))throw Error('この置き場の控えではありません');check_name(snap.shelf);safe(ws,snap.path);}
function readManifest(ws:Workspace,snap:Snapshot,name:string):Manifest{
 verify(ws,snap);const path=join(snap.path,name);safe(ws,path);const value:unknown=JSON.parse(readFileSync(path,'utf8'));
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('控えの一覧を読めません');
 for(const [key,v] of Object.entries(value)){if(typeof v!=='string'||!key||key.split('/').some(p=>!p||p==='.'||p==='..')||/[\\\0]/u.test(key)||!isInsideRoot(ws.root,resolve(ws.root,key)))throw Error('控えのパスが正しくありません');}
 return value as Manifest;
}
export async function take(ws:Workspace,deck:string):Promise<Snapshot>{
 ws.require_deck(deck);safe(ws,ws.qmd(deck));const shelf=check_name(ws.deck_shelf(deck)),root=base(ws,deck);mkdirSync(root,{recursive:true});let stamp=BigInt(Date.now())*1000000n,path:string;
 for(;;){path=join(root,String(stamp).padStart(20,'0'));try{mkdirSync(path);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;stamp++;}}
 const snap=new Snapshot(path,deck,shelf);
 try{for(const scope of snap.scopes){safe(ws,join(ws.root,scope));copy(join(ws.root,scope),join(path,'files',scope));}await atomicWriteFile(join(path,'manifest.json'),JSON.stringify(manifest(ws)),0o600);await atomicWriteFile(join(path,'snapshot.json'),JSON.stringify({deck,shelf}),0o600);}
 catch(e){rmSync(path,{recursive:true,force:true});throw e;}
 for(const old of list_snapshots(ws,deck).slice(20))rmSync(old.path,{recursive:true,force:true});return snap;
}
export function list_snapshots(ws:Workspace,deck:string):Snapshot[]{
 const root=base(ws,deck);if(!existsSync(root))return [];const out:Snapshot[]=[];
 for(const name of readdirSync(root).sort().reverse()){
  const path=join(root,name);if(!/^\d{20}$/u.test(name)||!lstatSync(path).isDirectory())continue;
  const meta=join(path,'snapshot.json');if(!present(meta)||!lstatSync(meta).isFile())continue;
  const data=JSON.parse(readFileSync(meta,'utf8'));if(data.deck!==deck)throw Error(`控えの発表が一致しません: ${path}`);out.push(new Snapshot(path,deck,check_name(data.shelf)));
 }return out;
}
export function latest(ws:Workspace,deck:string){return list_snapshots(ws,deck)[0]??null;}
export function find(ws:Workspace,deck:string,name:string){const snap=list_snapshots(ws,deck).find(s=>s.path.split('/').at(-1)===name);if(!snap)throw Error('控えが残っていません（発表ごとに最新20件を残します）');return snap;}
function diff(snap:Snapshot,before:Manifest,after:Manifest):Changes{
 const out:Changes={added:[],modified:[],deleted:[],outside:[]};for(const name of [...new Set([...Object.keys(before),...Object.keys(after)])].sort()){if(before[name]===after[name])continue;const key=!snap.covers(name)?'outside':!(name in before)?'added':!(name in after)?'deleted':'modified';out[key].push(name);}return out;
}
export function changes(ws:Workspace,snap:Snapshot){return diff(snap,readManifest(ws,snap,'manifest.json'),manifest(ws));}
export function run_changes(ws:Workspace,snap:Snapshot){verify(ws,snap);safe(ws,join(snap.path,'after.json'));return existsSync(join(snap.path,'after.json'))?diff(snap,readManifest(ws,snap,'manifest.json'),readManifest(ws,snap,'after.json')):changes(ws,snap);}
export async function finish(ws:Workspace,snap:Snapshot){verify(ws,snap);safe(ws,join(snap.path,'after.json'));await atomicWriteFile(join(snap.path,'after.json'),JSON.stringify(manifest(ws)),0o600);return run_changes(ws,snap);}
export function changes_since_finish(ws:Workspace,snap:Snapshot){verify(ws,snap);safe(ws,join(snap.path,'after.json'));if(!existsSync(join(snap.path,'after.json')))return [];const after=readManifest(ws,snap,'after.json'),current=manifest(ws);return [...new Set([...Object.keys(after),...Object.keys(current)])].sort().filter(n=>after[n]!==current[n]);}
export function restore_plan(ws:Workspace,snap:Snapshot,only:Set<string>|null=null,keep=new Set<string>()):RestorePlan{
 const result:RestorePlan={...run_changes(ws,snap),kept:[],later:[]};for(const key of ['added','modified','deleted'] as const){const names=result[key].filter(n=>only===null||only.has(n));result.kept.push(...names.filter(n=>keep.has(n)));result[key]=names.filter(n=>!keep.has(n));}
 if(existsSync(join(snap.path,'after.json'))){const after=readManifest(ws,snap,'after.json'),now=manifest(ws);result.later=[...result.added,...result.modified,...result.deleted].filter(n=>now[n]!==after[n]);}return result;
}
/** Prepare all paths before changing any file; retain originals until every replacement succeeds. */
function replaceFiles(ws:Workspace,snap:Snapshot,names:string[],remove:Set<string>){
 const paths=names.map(name=>{const dest=join(ws.root,name),src=join(snap.path,'files',name);safe(ws,dirname(dest));if(!remove.has(name)){safe(ws,src);if(!present(src))throw Error(`控えにファイルがありません: ${name}`);}return {dest,src,name};});
 const transaction=join(ws.state,'restore',randomUUID());safe(ws,transaction);mkdirSync(transaction,{recursive:true});const moved:Array<{dest:string;backup:string;existed:boolean}>=[];
 try{for(const [i,p] of paths.entries()){const backup=join(transaction,String(i)),existed=present(p.dest);if(existed)renameSync(p.dest,backup);moved.push({dest:p.dest,backup,existed});if(!remove.has(p.name))copy(p.src,p.dest);}}
 catch(error){
  try{for(const p of moved.reverse()){rmSync(p.dest,{recursive:true,force:true});if(p.existed){mkdirSync(dirname(p.dest),{recursive:true});renameSync(p.backup,p.dest);}}}
  catch(rollback){throw new AggregateError([error,rollback],`復元に失敗しました。退避したファイルを残しています: ${transaction}`);}
  rmSync(transaction,{recursive:true,force:true});throw error;
 }
 rmSync(transaction,{recursive:true,force:true});
}
export function restore_run(ws:Workspace,snap:Snapshot,only:Set<string>|null=null,keep=new Set<string>()){
 const result=restore_plan(ws,snap,only,keep);replaceFiles(ws,snap,[...result.added,...result.modified,...result.deleted],new Set(result.added));return result;
}
export function restore(ws:Workspace,snap:Snapshot){const result=changes(ws,snap);replaceFiles(ws,snap,[...result.added,...result.modified,...result.deleted],new Set(result.added));return result;}
