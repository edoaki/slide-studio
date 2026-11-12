/** Durable original chat tabs/drafts. Provider execution is supplied by the host. */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Workspace, checkLookupName } from './legacy-workspace.js';
import { atomicWriteFile } from './atomic.js';
import { isInsideRoot } from './paths.js';
import { fig_refs } from './legacy-figures.js';
import * as roles from './legacy-ai-roles.js';
export const ACTIVE=new Set(['run','check','review']);
export const COLORS=['#3D86F5','#DD8A45','#8A63D2','#5E9E2E','#D2558A','#2A9D8F','#B5852A'];
export const TARGET_KEY=/^(deck|fig:([a-z0-9][a-z0-9-]*)\/[a-z0-9][a-z0-9-]*|@\d+|[^\s/\\@][^\s/\\]{0,199})$/u;
export interface Attachment {path:string;name:string;kind:'image'|'file'}
export interface ChatTab extends Record<string,unknown>{id:string;name:string;color:string;created:number;open:boolean;session:string|null;drafts:Record<string,string|{text:string;page_title:string}>;auto_name:boolean;model:string|null;effort:string|null;attach:Attachment[];mode:roles.Mode;ai_roles:roles.RoleSettings}
export interface ChatRound extends Record<string,unknown>{id:string;tab:string;state:string;mode?:roles.Mode;items?:Array<{key:string;page_title?:string}>;agents?:Array<{state:string;error?:string}>}
export interface ChatData {tabs:ChatTab[];rounds:ChatRound[]}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function safe(ws:Workspace,path:string){if(!isInsideRoot(ws.root,path))throw Error('会話の保存先が正しくありません');for(let p=resolve(path);;p=dirname(p)){try{if(lstatSync(p).isSymbolicLink())throw Error('シンボリックリンクを経由できません');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(p===ws.root)break;}}
export function attachments(ws:Workspace,deck:string,items:unknown):Attachment[]{
 if(!Array.isArray(items))return [];
 return items.map(it=>{const path=record(it)&&typeof it.path==='string'?it.path:'';if(!/^(images|materials)\/[^\0]{1,400}$/u.test(path)||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error(`添付の場所が正しくありません: ${path}`);const folder=path.startsWith('images/')?ws.asset_root(deck):ws.deck_dir(deck),file=join(folder,path);safe(ws,file);if(!existsSync(file)||!statSync(file).isFile()||!isInsideRoot(realpathSync(folder),realpathSync(file)))throw Error(`添付が見つかりません: ${path}`);return {path,name:basename(file),kind:path.startsWith('images/')?'image' as const:'file' as const};}).slice(0,20);
}
export class ChatStore {
 private data=new Map<string,ChatData>();
 private writes=new Map<string,Promise<void>>();
 constructor(readonly ws:Workspace,private options:{providerOf:roles.ProviderOf;defaultModel:()=>string|null;status:()=>unknown;broadcast:(event:Record<string,unknown>)=>void}){}
 private path(deck:string){const path=join(this.ws.state,'chat',checkLookupName(deck,'発表の名前')+'.json');safe(this.ws,path);return path;}
 private newTab(data:ChatData,mode:roles.Mode):ChatTab{const last=this.ws.prefs().ai_last;return {id:'t'+randomUUID().replaceAll('-','').slice(0,8),name:'新しいタブ',color:COLORS[data.tabs.length%COLORS.length]!,created:Date.now()/1000,open:true,session:null,drafts:{},auto_name:true,model:roles.supported(last)?last:null,effort:null,attach:[],mode,ai_roles:{}};}
 state(deck:string):ChatData{
  this.ws.require_deck(deck);const loaded=this.data.get(deck);if(loaded)return loaded;
  const path=this.path(deck);let data:ChatData={tabs:[],rounds:[]};
  if(existsSync(path)){const value:unknown=JSON.parse(readFileSync(path,'utf8'));if(!record(value)||!Array.isArray(value.tabs)||!Array.isArray(value.rounds)||value.tabs.some(t=>!record(t)||typeof t.id!=='string')||value.rounds.some(r=>!record(r)||typeof r.id!=='string'||typeof r.tab!=='string'||typeof r.state!=='string'))throw Error('会話の記録を読めません');data=value as unknown as ChatData;}
  for(const round of data.rounds)if(ACTIVE.has(round.state)){round.state='error';round.error='アプリが終了したため中断しました';for(const agent of round.agents??[])if(agent.state==='run'){agent.state='error';agent.error=String(round.error);}}
  for(const tab of data.tabs){tab.mode??='slides';if(!(tab.mode in roles.MODES))throw Error('会話の種類が正しくありません');tab.ai_roles=roles.migrate((tab.ai_roles??this.ws.prefs().ai_roles??{}) as roles.RoleSettings,tab.mode);tab.drafts??={};tab.attach??=[];tab.open??=true;
   if(tab.model&&!roles.supported(tab.model)&&!tab.session&&!data.rounds.some(r=>r.tab===tab.id))tab.model=null;
  }
  for(const mode of Object.keys(roles.MODES) as roles.Mode[])if(!data.tabs.some(t=>t.mode===mode&&t.open))data.tabs.push(this.newTab(data,mode));this.data.set(deck,data);return data;
 }
 async save(deck:string){const path=this.path(deck),text=JSON.stringify(this.state(deck),null,1);const write=(this.writes.get(deck)??Promise.resolve()).catch(()=>{}).then(async()=>{mkdirSync(dirname(path),{recursive:true});await atomicWriteFile(path,text,0o600);});this.writes.set(deck,write);try{await write;}finally{if(this.writes.get(deck)===write)this.writes.delete(deck);}}
 async flush(){await Promise.all([...this.writes.values()]);}
 forget(deck:string){if(this.writes.has(deck))throw Error('会話を保存しています');this.data.delete(deck);}
 tab(deck:string,id:string){const tab=this.state(deck).tabs.find(t=>t.id===id);if(!tab)throw Error('タブがありません');return tab;}
 round(deck:string,id:string){const round=this.state(deck).rounds.find(r=>r.id===id);if(!round)throw Error('送信が見つかりません');return round;}
 busy(deck:string){return this.state(deck).rounds.some(r=>ACTIVE.has(r.state));}
 public(deck:string){const data=this.state(deck),running=data.rounds.filter(r=>ACTIVE.has(r.state)),slides=running.filter(r=>(r.mode??'slides')==='slides'&&!r.talk),pages=new Map<string,string|undefined>(),figures=new Set<string>();let all=false;
  for(const round of slides){if(!round.items?.length)all=true;for(const item of round.items??[]){if(item.key==='deck')all=true;else if(item.key.startsWith('fig:'))figures.add(item.key.slice(4));else pages.set(item.key,item.page_title);}}
  return {role_modes:Object.fromEntries(Object.keys(roles.MODES).map(mode=>[mode,['review','consult']])),role_defaults:{review:true,consult:false},role_providers:roles.SUPPORTED_PROVIDERS,figure_users:Object.fromEntries(fig_refs(readFileSync(this.ws.qmd(deck),'utf8')).map(ref=>[ref,this.ws.decks_using(ref)])),deck,tabs:data.tabs,rounds:data.rounds,locked:slides.length>0,lock:{all,pages:[...pages].map(([key,title])=>({key,title})),figures:[...figures].sort()},memo_locked:running.some(r=>r.mode==='memo'),topic:this.ws.deck_shelf(deck),ai:this.options.status()};
 }
 broadcast(deck:string){this.options.broadcast({type:'theme-lock'});this.options.broadcast({type:'chat',deck,state:this.public(deck)});}
 async open_view(deck:string){const data=this.state(deck),active=new Set(data.rounds.filter(r=>ACTIVE.has(r.state)).map(r=>r.tab)),used=new Set(data.rounds.map(r=>r.tab)),empty=new Set<roles.Mode>();for(const tab of data.tabs){const reusable=tab.open&&!used.has(tab.id)&&!tab.session&&!Object.keys(tab.drafts).length&&!tab.attach.length&&!empty.has(tab.mode);if(reusable)empty.add(tab.mode);tab.open=reusable||active.has(tab.id);}for(const mode of Object.keys(roles.MODES) as roles.Mode[])if(!empty.has(mode))data.tabs.push(this.newTab(data,mode));await this.save(deck);this.broadcast(deck);return this.public(deck);}
 async add_tab(deck:string,mode:string){if(!(mode in roles.MODES))throw Error('チャットの種類が正しくありません');const data=this.state(deck),tab=this.newTab(data,mode as roles.Mode);data.tabs.push(tab);await this.save(deck);this.broadcast(deck);return tab;}
 async update_tab(deck:string,id:string,body:Record<string,unknown>){
  const saved=this.tab(deck,id),tab=structuredClone(saved),data=this.state(deck),busy=data.rounds.some(r=>r.tab===id&&ACTIVE.has(r.state));
  if(busy&&(body.open===false||['ai_roles','model','effort'].some(k=>k in body)))throw Error('このタブは作業中です。止めてから変更してください');
  if('drafts' in body){if(!record(body.drafts))throw Error('未送信の指示の形が正しくありません');const drafts:ChatTab['drafts']={};for(const [key,value] of Object.entries(body.drafts)){if(!TARGET_KEY.test(key))throw Error('未送信の指示の形が正しくありません');const text=typeof value==='string'?value:key.startsWith('@')&&record(value)&&typeof value.text==='string'&&typeof value.page_title==='string'?value.text:null;if(text===null)throw Error('未送信の指示の形が正しくありません');if(text.trim())drafts[key]=typeof value==='string'?value:{text,page_title:(value as {page_title:string}).page_title};}tab.drafts=drafts;if(tab.auto_name){const first=Object.values(drafts)[0],text=typeof first==='string'?first:first?.text??'';tab.name=Array.from(text.trim().split(/\r?\n/u)[0]||'新しいタブ').slice(0,40).join('');}}
  if(typeof body.open==='boolean'){if(!body.open&&tab.open&&!data.tabs.some(t=>t.id!==id&&t.open&&t.mode===tab.mode))throw Error('最後のタブは閉じられません');tab.open=body.open;}
  if(typeof body.name==='string'&&body.name.trim()){tab.name=Array.from(body.name.trim()).slice(0,40).join('');tab.auto_name=false;}
  let modelChanged=false;
  if('model' in body&&body.model!==tab.model){if(typeof body.model!=='string'||!this.options.providerOf(body.model).model)throw Error('そのモデルは使えません');if(tab.session||data.rounds.some(r=>r.tab===id)){tab.model_change={from:tab.model,to:body.model};tab.session=null;delete tab.role_binding;for(const role of ['review','consult'] as const)if(!tab.ai_roles[role]?.model){delete tab[role+'_session'];delete tab[role+'_binding'];}}tab.model=body.model;tab.effort=null;modelChanged=true;}
  if('effort' in body){const key=tab.model??this.options.defaultModel(),model=key?this.options.providerOf(key).model:null;if(body.effort!==null&&(typeof body.effort!=='string'||!model?.efforts.includes(body.effort)))throw Error('その思考量は選べません');tab.effort=body.effort as string|null;}
  if('ai_roles' in body){const settings=roles.tab_settings(tab.mode,tab.ai_roles,body.ai_roles,this.options.providerOf);for(const role of ['review','consult'] as const)if(JSON.stringify(settings[role])!==JSON.stringify(tab.ai_roles[role])){delete tab[role+'_session'];delete tab[role+'_binding'];}tab.ai_roles=settings;}
  if('attach' in body)tab.attach=attachments(this.ws,deck,body.attach);
  Object.assign(saved,tab);for(const key of Object.keys(saved))if(!(key in tab))delete saved[key];await this.save(deck);if(modelChanged)this.ws.set_prefs({ai_last:tab.model});if(Object.keys(body).some(k=>!['drafts','attach'].includes(k)))this.broadcast(deck);return saved;
 }
}
