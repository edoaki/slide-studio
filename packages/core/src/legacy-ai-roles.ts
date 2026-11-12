/** Shared role definitions for chat settings, instruction UI and native runs. */
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { Workspace } from './legacy-workspace.js';
export const SUPPORTED_PROVIDERS=['codex','claude','agy'] as const;
export const MODES={slides:'chat',memo:'draft',theme:'theme'} as const;
export type Mode=keyof typeof MODES;
export const EXTRA_LIMIT=4000;
export const ROLES=[
 {id:'chat',skill:'slide-studio-slides',web:true,readonly:false,configurable:false,default_on:true},
 {id:'theme',skill:'slide-studio-theme',web:false,readonly:false,configurable:false,default_on:true},
 {id:'draft',skill:'slide-studio-memo',web:true,readonly:false,configurable:false,default_on:true},
 {id:'review',skill:'slide-studio-review',web:false,readonly:true,configurable:true,default_on:true},
 {id:'consult',skill:null,web:false,readonly:true,configurable:true,default_on:false},
] as const;
export type RoleId=typeof ROLES[number]['id'];
export interface RoleSetting {model?:string;effort?:string|null;enabled?:boolean}
export type RoleSettings=Partial<Record<RoleId,RoleSetting>>;
export interface ModelInfo {key:string;effort:string|null;efforts:string[]}
export type ProviderOf=(key:string)=>{ok:boolean;model:ModelInfo|null};
export function get(role:string){const found=ROLES.find(r=>r.id===role);if(!found)throw Error('担当の種類が正しくありません');return found;}
export function supported(key:unknown):key is string{return typeof key==='string'&&SUPPORTED_PROVIDERS.some(p=>key.startsWith(p+':'));}
export function migrate(settings:RoleSettings & Record<string,unknown>,mode:Mode):RoleSettings{
 const out:RoleSettings={};for(const key of ['review','consult'] as const)if(settings[key])out[key]=structuredClone(settings[key]);
 const legacy={slides:['slide_review','html_review'],memo:['draft_review'],theme:['html_review']};
 if(!out.review)for(const key of legacy[mode])if(settings[key]){out.review=structuredClone(settings[key]) as RoleSetting;break;}return out;
}
function safeRead(ws:Workspace,rel:string){const path=join(ws.root,rel);for(let p=path;;p=dirname(p)){try{if(lstatSync(p).isSymbolicLink())throw Error('シンボリックリンクを経由できません');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(p===resolve(ws.root))break;}try{return readFileSync(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return '';throw e;}}
export function extra(ws:Workspace,role:string):string{get(role);const saved=ws.prefs().ai_instructions;const value=saved&&typeof saved==='object'?(saved as Record<string,unknown>)[role]:'';return typeof value==='string'?value:'';}
export function set_extra(ws:Workspace,role:string,text:unknown){get(role);if(typeof text!=='string')throw Error('追加指示の形式が正しくありません');text=text.trim();if(Array.from(text as string).length>EXTRA_LIMIT)throw Error(`追加指示は ${EXTRA_LIMIT} 文字までです`);const saved=ws.prefs().ai_instructions;const values=saved&&typeof saved==='object'&&!Array.isArray(saved)?{...saved as Record<string,unknown>} : {};if(text)values[role]=text;else delete values[role];ws.set_prefs({ai_instructions:values});return text as string;}
export function catalog(ws:Workspace){return {roles:ROLES.map(role=>({...role,revision:createHash('sha256').update(JSON.stringify(['electron-native-1',role])).digest('hex'),base:['AGENTS.md',...(role.skill?[`.agents/skills/${role.skill}/SKILL.md`]:[])].map(path=>({path,text:safeRead(ws,path)})),extra:extra(ws,role.id)})),supported_providers:[...SUPPORTED_PROVIDERS],extra_limit:EXTRA_LIMIT};}
export function with_extra(ws:Workspace,role:string,prompt:string){const text=extra(ws,role);return text?'[利用者の追加指示] この担当にいつも求めること。AGENTS.md・skill の決まりと食い違うときは、そちらを優先する。\n'+text+'\n\n'+prompt:prompt;}
export function resolveRole(role:RoleId,parent:RoleSetting,settings:RoleSettings,providerOf:ProviderOf):RoleSetting{
 const definition=get(role),configured=settings[role];if(configured?.enabled===false||configured?.enabled===undefined&&!definition.default_on)return {...configured,enabled:false};
 const selected=definition.configurable?configured?.model?configured:{model:parent.model}:parent;
 if(!supported(selected.model))throw Error(`[${role}] 使える AI がありません。ログインとモデルの選択を確認してください`);
 const provider=providerOf(selected.model);if(!provider.ok||!provider.model)throw Error(`[${role}] 担当に設定された AI が使えません: ${selected.model}`);
 const effort=selected.effort??provider.model.effort;if(effort!==null&&!provider.model.efforts.includes(effort))throw Error(`[${role}] このモデルで使えない思考量です: ${effort}`);
 return {model:selected.model,effort,...(!definition.default_on?{enabled:true}:{})};
}
export function tab_settings(mode:Mode,current:RoleSettings,changes:unknown,providerOf:ProviderOf):RoleSettings{
 if(!(mode in MODES)||!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).some(k=>!['review','consult'].includes(k)))throw Error('このチャットでは設定できない担当です');
 const result=structuredClone(current);
 for(const [key,value] of Object.entries(changes)){const role=key as RoleId,kept=current[role]?.enabled;
  if(value===null){delete result[role];if(kept!==undefined)result[role]={enabled:kept};continue;}
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length||Object.keys(value).some(k=>!['model','effort','enabled'].includes(k))||('enabled' in value&&typeof value.enabled!=='boolean')||('model' in value&&typeof value.model!=='string')||!('model' in value)&&Object.keys(value).join()!=='enabled')throw Error('AI 設定の形式が正しくありません');
  if(Object.keys(value).join()==='enabled'){result[role]={...result[role],enabled:(value as RoleSetting).enabled};continue;}
  const setting=value as RoleSetting;result[role]=resolveRole(role,{}, {[role]:{...setting,enabled:true}},providerOf);delete result[role]!.enabled;const on=setting.enabled??kept;if(on!==undefined)result[role]!.enabled=on;
 }return result;
}
export function clean_questions(value:unknown,items:number){if(!Array.isArray(value))return [];const out=[];for(const q of value){if(!q||typeof q.text!=='string'||!q.text.trim())continue;const seen=new Set<string>(),options=[];for(const o of Array.isArray(q.options)?q.options:[]){if(!o||typeof o.label!=='string'||!o.label.trim()||seen.has(o.label.trim()))continue;seen.add(o.label.trim());options.push({label:o.label.trim(),description:String(o.description??'').trim()});}if(options.length)out.push({item:Number.isInteger(q.item)&&q.item>=1&&q.item<=items?q.item:1,text:q.text.trim(),options:options.slice(0,4),multiple:q.multiple===true});}return out.slice(0,3);}
