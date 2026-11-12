import { join } from 'node:path';
import type { Workspace } from '../../core/src/legacy-workspace.js';
import { readAsset } from '../../core/src/assets.js';
import type { RoleId } from '../../core/src/legacy-ai-roles.js';
import { Providers,type ProviderId } from './providers.js';
import { execute } from './process.js';
import { runCodex } from './codex-run.js';
import type { JsonObject } from './app-server.js';
import { codexLimits, claudeLimits, type Limits } from './limits.js';
export interface RunEvent {session?:string;step?:{id:string|null;kind:string;text:string;exit?:number};usage?:{used:number|null;window:number|null};limits?:Limits;final?:unknown}
export interface NativeOptions {role:RoleId;outputSchema?:JsonObject|null;prompt:string;model:string;effort?:string|null;session?:string|null;images?:string[];readonly:boolean;web:boolean;signal?:AbortSignal;onEvent:(event:RunEvent)=>void}
const object=(value:unknown):value is JsonObject=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function schema(role:RoleId):JsonObject|null{
 const chat=JSON.parse(readAsset('ai','schema.json'));const questions=chat.properties.questions;
 if(role==='chat')return chat;
 if(role==='review')return {type:'object',additionalProperties:false,properties:{summary:{type:'string'},issues:{type:'array',items:{type:'object',additionalProperties:false,properties:{target:{type:'string'},message:{type:'string'},suggestion:{type:'string'}},required:['target','message','suggestion']}}},required:['summary','issues']};
 if(role==='theme')return {type:'object',additionalProperties:false,properties:{summary:{type:'string'},questions},required:['summary','questions']};
 if(role==='draft')return {type:'object',additionalProperties:false,properties:{reply:{type:'string'},slides:{type:'string'},rebuild:{type:'boolean'},questions},required:['reply','slides','rebuild','questions']};return null;
}
function toml(value:unknown):string{if(object(value))return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+' = '+toml(v)).join(', ')+'}';return JSON.stringify(value);}
export function nativeArgs(id:ProviderId,ws:Workspace,o:NativeOptions){
 const protectedPaths=['snapshots','chat'].map(name=>join(ws.state,name)),output=o.outputSchema===undefined?schema(o.role):o.outputSchema;
 if(id==='codex'){const config:JsonObject={web_search:o.web?'live':'disabled'};if(!o.readonly)Object.assign(config,{default_permissions:'slide-studio','permissions.slide-studio.extends':':workspace','permissions.slide-studio.filesystem':Object.fromEntries(protectedPaths.map(p=>[p,'read']))});return ['app-server','--listen','stdio://',...Object.entries(config).flatMap(([key,value])=>['-c',`${key}=${toml(value)}`])];}
 if(id==='claude'){
  const settings={sandbox:{enabled:true,autoAllowBashIfSandboxed:true,allowUnsandboxedCommands:false,filesystem:{denyWrite:o.readonly?[ws.root]:protectedPaths}},permissions:{deny:(o.readonly?[ws.root]:protectedPaths).map(p=>`Edit(/${p}/**)`)}};
  const args=['-p','--output-format','stream-json','--verbose','--permission-mode',o.readonly?'default':'acceptEdits','--setting-sources','project','--settings',JSON.stringify(settings),'--model',o.model];
  if(o.web)args.push('--allowedTools','WebSearch,WebFetch');const denied=[...(o.readonly?['Edit','Write','NotebookEdit']:[]),...(!o.web?['WebSearch','WebFetch']:[])];if(denied.length)args.push('--disallowedTools',denied.join(','));if(o.effort)args.push('--effort',o.effort);if(o.session)args.push('--resume',o.session);if(output)args.push('--json-schema',JSON.stringify(output));return [...args,'--',o.prompt];
 }
 const deny=['mcp(*)',...(o.readonly?['write_file(*)','command(*)']:protectedPaths.map(p=>`write_file(${p}/**)`)),...(!o.web?['read_url(*)']:[])];
 const args=['--output-format','stream-json','--mode',o.readonly?'plan':'accept-edits','--sandbox','--settings',JSON.stringify({toolPermission:'proceed-in-sandbox',permissions:{allow:o.web?['read_url(*)']:[],deny}}),'--model',o.model+(o.effort?'-'+o.effort:'')];if(output)args.push('--json-schema',JSON.stringify(output));if(o.session)args.push('--conversation',o.session);return [...args,'-p',o.prompt];
}
export async function runNative(providers:Providers,id:ProviderId,ws:Workspace,o:NativeOptions){
 const executable=providers.binary(id);if(!executable)throw Error('AI の実行ファイルがありません');const env={...providers.environment(id),SLIDE_STUDIO_HOME:ws.root,SLIDE_STUDIO_SANDBOX:'1'},args=nativeArgs(id,ws,o);
 if(id==='codex'){
  const result=await runCodex({executable,args,cwd:ws.root,env,pool:providers.pool,prompt:o.prompt,model:o.model,effort:o.effort,session:o.session,images:o.images,schema:(o.outputSchema===undefined?schema(o.role):o.outputSchema)??undefined,readonly:o.readonly,signal:o.signal,onSession:session=>o.onEvent({session}),onEvent:event=>{
   const p=event.params,item=p.item;
   if(event.method==='account/rateLimits/updated')o.onEvent({limits:codexLimits(p.rateLimits)});
   if(event.method==='item/completed'&&object(item)){
    if(item.type==='agentMessage'&&typeof item.text==='string')o.onEvent({step:{id:String(item.id??''),kind:'message',text:item.text}});
    if(item.type==='commandExecution')o.onEvent({step:{id:String(item.id??''),kind:'command',text:String(item.command??''),...(typeof item.exitCode==='number'?{exit:item.exitCode}:{})}});
    if(item.type==='fileChange')o.onEvent({step:{id:String(item.id??''),kind:'file',text:JSON.stringify(item.changes??[])}});
   }
   if(event.method==='thread/tokenUsage/updated'&&object(p.tokenUsage)){const last=p.tokenUsage.last;o.onEvent({usage:{used:object(last)&&typeof last.totalTokens==='number'?last.totalTokens:0,window:typeof p.tokenUsage.modelContextWindow==='number'?p.tokenUsage.modelContextWindow:null}});}
  }});o.onEvent({final:result.final});return result;
 }
 let final:unknown=null,session=o.session??null,resultSeen=false,failure:string|null=null;
 const result=await execute(executable,args,{cwd:ws.root,env,signal:o.signal,timeoutMs:2*60*60*1000,capture:false,onLine:line=>{
  const ev:unknown=JSON.parse(line);if(!object(ev))throw Error('AI の通知形式が正しくありません');
  const sid=id==='claude'?ev.session_id:ev.conversation_id;if(typeof sid==='string'){session=sid;o.onEvent({session});}
  if(id==='claude'){
   if(ev.type==='rate_limit_event')o.onEvent({limits:claudeLimits(ev.rate_limit_info)});
   if(ev.type==='assistant'&&object(ev.message)&&object(ev.message.usage)){
    const u=ev.message.usage;o.onEvent({usage:{used:['input_tokens','cache_creation_input_tokens','cache_read_input_tokens'].reduce((sum,k)=>sum+(typeof u[k]==='number'?u[k] as number:0),0),window:null}});
   }
   if(ev.type==='result'&&object(ev.modelUsage)){
    const used=Object.values(ev.modelUsage).filter(object).find(u=>typeof u.contextWindow==='number');
    if(used)o.onEvent({usage:{used:typeof used.inputTokens==='number'?used.inputTokens:0,window:used.contextWindow as number}});
   }
   if(ev.type==='assistant'&&!ev.parent_tool_use_id&&object(ev.message)&&Array.isArray(ev.message.content))for(const c of ev.message.content)if(object(c)){if(c.type==='text'&&typeof c.text==='string')o.onEvent({step:{id:String(ev.message.id??''),kind:'message',text:c.text}});if(c.type==='thinking'&&typeof c.thinking==='string')o.onEvent({step:{id:null,kind:'think',text:c.thinking}});if(c.type==='tool_use'&&c.name!=='StructuredOutput')o.onEvent({step:{id:String(c.id??''),kind:c.name==='Bash'?'command':['Edit','Write','NotebookEdit'].includes(String(c.name))?'file':'tool',text:String(c.name)+' '+JSON.stringify(c.input??{})}});}
   if(ev.type==='result'){resultSeen=true;final=ev.structured_output??ev.result??'';if(ev.is_error||ev.subtype&&ev.subtype!=='success')failure=String(ev.result??ev.subtype);}
  }else{
   if(ev.event==='result'&&object(ev.result)){resultSeen=true;final=ev.result.structured_output??ev.result.response??'';if(ev.result.status&&ev.result.status!=='SUCCESS')failure=String(ev.result.error??ev.result.status);}
   if(ev.event==='step_update'&&object(ev.step_update)){const step=ev.step_update;if(step.step_type==='agent_response'&&typeof step.text_delta==='string')o.onEvent({step:{id:'a'+String(step.step_index),kind:'message',text:step.text_delta}});if(step.step_type==='tool')o.onEvent({step:{id:'t'+String(step.step_index),kind:'tool',text:JSON.stringify(step.tool_info??{})}});}
  }
 }});
 if(result.code!==0||failure||!resultSeen)throw Error(failure||result.stderr.trim()||'AI が結果を返さずに終了しました');o.onEvent({final});return {session,final};
}
