/** Local CLI discovery and account/model metadata. No inference during detection. */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execute } from './process.js';
import { inspectAppServer } from './app-server.js';
import { AppServerPool } from './pool.js';
export type ProviderId='codex'|'claude'|'agy';
export interface Model {id:string;name:string;efforts:string[];effort:string|null;context:number|null}
export interface ProviderStatus {id:ProviderId;name:string;ok:boolean;reason:string;message:string;models:Model[];default:string|null;account?:unknown;limits?:unknown}
const EFFORTS=['minimal','low','medium','high','xhigh','max','ultra'];
// Consumer plans prohibit wrapping agy in third-party agents or applications.
// Verified 2026-11-18: https://antigravity.google/docs/faq and /terms section 6.
export const IDS:ProviderId[]=['codex','claude'];
export const AGY_DISABLED='Antigravity は利用規約により Slide Studio から呼び出せません。別の AI を選択してください。';
export function assertCallable(id:ProviderId){if(id==='agy')throw Error(AGY_DISABLED);}
export const NAMES={codex:'Codex',claude:'Claude Code',agy:'Antigravity'};
function executable(path:string){try{accessSync(path,constants.X_OK);return true;}catch{return false;}}
function json(path:string):Record<string,unknown>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return {};}}
export function model(id:string,name:string,efforts:string[]=[],context:number|null=null):Model{const ordered=EFFORTS.filter(e=>efforts.includes(e));return {id,name,efforts:ordered,effort:ordered.includes('medium')?'medium':ordered[0]??null,context};}
export class Providers {
 readonly pool=new AppServerPool();
 constructor(readonly storage:string,readonly env:NodeJS.ProcessEnv=process.env){}
 home(id:ProviderId){const configured=this.env[`SLIDE_STUDIO_${id.toUpperCase()}_HOME`];return resolve(configured?.startsWith('~/')?join(homedir(),configured.slice(2)):configured||join(this.storage,id));}
 binary(id:ProviderId):string|null{
  const fixed=this.env[`SLIDE_STUDIO_${id.toUpperCase()}`];if(fixed!==undefined)return !fixed||fixed==='none'?null:fixed;
  const runtime=join(this.home(id),'runtime'),managed=json(join(runtime,'state.json')).current;
  const versions=existsSync(runtime)?readdirSync(runtime).filter(v=>/^\d+\.\d+\.\d+[0-9A-Za-z.+_-]*$/u.test(v)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})):[];
  for(const version of [managed,...versions])if(typeof version==='string'&&/^[0-9A-Za-z.+_-]+$/u.test(version)){const path=join(runtime,version,...(id==='codex'?['bin']:[]),id+(process.platform==='win32'?'.exe':''));if(executable(path))return path;}

  for(const dir of (this.env.PATH??'').split(delimiter).filter(Boolean)){const path=join(dir,id+(process.platform==='win32'?'.exe':''));if(executable(path))return path;}
  const paths=[join(homedir(),'.local/bin',id),...(id==='claude'?[join(homedir(),'.claude/local/claude')]:id==='agy'?[join(homedir(),'.antigravity-main/agy')]:[])];
  for(const dir of ['/opt/homebrew/bin','/usr/local/bin'])paths.push(join(dir,id));
  // Finder does not inherit nvm's shell PATH. Only inspect its version/bin entries.
  const nvm=join(homedir(),'.nvm/versions/node');if(existsSync(nvm))for(const version of readdirSync(nvm).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})))paths.push(join(nvm,version,'bin',id));
  return paths.find(executable)??null;
 }
 environment(id:ProviderId){const env={...this.env};delete env.ELECTRON_RUN_AS_NODE;delete env.CLAUDECODE;
  const binary=this.binary(id);env.PATH=[env.SLIDE_STUDIO_CLI_BIN,binary?dirname(binary):null,env.PATH].filter(Boolean).join(delimiter);
  if(id==='codex')env.CODEX_HOME=this.home(id);if(id==='claude'){env.CLAUDE_CONFIG_DIR=this.home(id);env.DISABLE_AUTOUPDATER='1';}if(id==='agy')env.AGY_CLI_DISABLE_AUTO_UPDATE='true';return env;
 }
 async detect(id:ProviderId,signal?:AbortSignal):Promise<ProviderStatus>{
  const out:ProviderStatus={id,name:NAMES[id],ok:false,reason:'',message:'',models:[],default:null};
  if(id==='agy')return {...out,reason:'policy',message:AGY_DISABLED};
  const exe=this.binary(id);if(!exe)return {...out,reason:'missing'};
  mkdirSync(this.home(id),{recursive:true,mode:0o700});const env=this.environment(id);
  try{
   if(id==='codex'){const found=await inspectAppServer({executable:exe,args:['app-server','--listen','stdio://'],env,signal,timeoutMs:15000});Object.assign(out,found);out.models=found.models.map(m=>({...model(m.id,m.name,m.efforts,m.context),effort:m.effort}));}
   else if(id==='claude'){
    const result=await execute(exe,['auth','status'],{env,signal});let auth:Record<string,unknown>;try{auth=JSON.parse(result.stdout);}catch{throw Error(result.stderr||result.stdout||'ログイン状態を読めません');}
    if(!auth.loggedIn)return {...out,reason:'login'};const settings=json(join(this.home(id),'settings.json')),defaultId=typeof settings.model==='string'?settings.model:'opus';
    // CLI aliases follow the original selector; full configured model IDs are retained.
    out.models=[['opus','Claude Opus'],['sonnet','Claude Sonnet'],['haiku','Claude Haiku'],['fable','Claude Fable']].map(([id,name])=>model(id!,name!,['low','medium','high','xhigh','max']));
    if(!out.models.some(m=>m.id===defaultId))out.models.unshift(model(defaultId,defaultId,['low','medium','high','xhigh','max']));out.default=defaultId;out.ok=true;out.message=typeof auth.authMethod==='string'?auth.authMethod:'';
   }
   if(out.ok&&!out.default)out.default=out.models[0]?.id??null;return out;
  }catch(error){return {...out,ok:false,reason:'error',message:(error instanceof Error?error.message:String(error)).slice(0,300)};}
 }
 async detectAll(signal?:AbortSignal){return Promise.all(IDS.map(id=>this.detect(id,signal)));}
}
