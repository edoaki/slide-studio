/** Codex stdio JSON-RPC transport. The official CLI owns credentials and tools.
 * Protocol: https://learn.chatgpt.com/docs/app-server
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { killOwnedProcess } from './process.js';
import { codexLimits } from './limits.js';
export type JsonObject=Record<string,unknown>;
export interface RpcEvent {method:string;params:JsonObject}
interface Pending {resolve:(value:JsonObject)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
export class RpcEvents {
 private queue:RpcEvent[]=[];private waits:Array<{resolve:(value:RpcEvent)=>void;reject:(error:Error)=>void}>=[];private error:Error|null=null;
 push(event:RpcEvent){if(this.error)return;const waiter=this.waits.shift();if(waiter)waiter.resolve(event);else{if(this.queue.length>=512)throw Error('AI の通知が多すぎます');this.queue.push(event);}}
 next():Promise<RpcEvent>{const event=this.queue.shift();if(event)return Promise.resolve(event);if(this.error)return Promise.reject(this.error);return new Promise((resolve,reject)=>this.waits.push({resolve,reject}));}
 clear(){this.queue=[];}
 end(error:Error){this.error=error;for(const waiter of this.waits.splice(0))waiter.reject(error);}
}
export interface AppServerOptions {
 executable:string;args:string[];cwd?:string;env?:NodeJS.ProcessEnv;timeoutMs?:number;signal?:AbortSignal;
 protocol?:'codex'|'acp';
 toolCall?:(name:string,args:unknown,signal:AbortSignal)=>Promise<unknown>;
}
export class AppServerClient {
 readonly events=new RpcEvents();private child?:ChildProcessWithoutNullStreams;private pending=new Map<number,Pending>();private serial=0;private stopped=false;private buffer='';private decoder=new StringDecoder('utf8');private exit?:Promise<void>;private controller=new AbortController();private tasks=new Set<Promise<void>>();
 private abort=()=>{void this.close();};
 constructor(private options:AppServerOptions){}
 get alive(){return !!this.child&&!this.stopped&&this.child.exitCode===null&&this.child.signalCode===null;}
 async start(){
  if(this.child)throw Error('AI の接続は既に開始しています');
  if(this.options.signal?.aborted)throw Error('AI の実行を取り消しました');
  this.options.signal?.addEventListener('abort',this.abort,{once:true});
  const child=this.child=spawn(this.options.executable,this.options.args,{cwd:this.options.cwd,env:this.options.env??process.env,shell:false,detached:process.platform!=='win32',windowsHide:true,stdio:'pipe'});
  this.exit=new Promise(resolve=>child.once('close',()=>{this.fail(Error('Codex App Server との接続が切れました'));resolve();}));
  child.on('error',error=>this.fail(error));child.stdin.on('error',error=>this.fail(error));child.stderr.resume();
  child.stdout.on('data',(bytes:Buffer)=>{try{this.buffer+=this.decoder.write(bytes);if(Buffer.byteLength(this.buffer)>32*1024*1024)throw Error('AI の応答が大きすぎます');for(;;){const index=this.buffer.indexOf('\n');if(index<0)break;const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);if(line.trim())this.receive(JSON.parse(line));}}catch(error){this.fail(error instanceof Error?error:Error(String(error)));this.kill();}});
  try{await this.call('initialize',this.options.protocol==='acp'?{protocolVersion:1,clientCapabilities:{}}:{clientInfo:{name:'slide_studio',title:'Slide Studio',version:'0.1.0'},capabilities:{experimentalApi:true}});if(this.options.protocol!=='acp')await this.send({method:'initialized',params:{}});}catch(error){await this.close();throw error;}return this;
 }
 private async send(message:JsonObject){if(!this.alive||!this.child)throw Error('AI との接続がありません');const data=JSON.stringify(this.options.protocol==='acp'?{jsonrpc:'2.0',...message}:message)+'\n';await new Promise<void>((resolve,reject)=>this.child!.stdin.write(data,error=>error?reject(error):resolve()));}
 call(method:string,params:JsonObject={}):Promise<JsonObject>{
  if(this.pending.size>=256)return Promise.reject(Error('AI への要求が多すぎます'));const id=++this.serial;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`AI との通信が時間切れになりました: ${method}`));},this.options.timeoutMs??30000);this.pending.set(id,{resolve,reject,timer});void this.send({id,method,params}).catch(error=>{clearTimeout(timer);this.pending.delete(id);reject(error);});});
 }
 private receive(value:unknown){
  if(!object(value))throw Error('AI の応答形式が正しくありません');
  if(typeof value.method==='string'){
   if('id' in value){if(typeof value.id!=='number'&&typeof value.id!=='string')throw Error('AI の要求 ID が正しくありません');
    if(value.method==='item/tool/call'&&this.options.toolCall){if(this.tasks.size>=32)throw Error('AI の道具の要求が多すぎます');const task=this.toolRequest(value);this.tasks.add(task);void task.finally(()=>this.tasks.delete(task)).catch(()=>{});}
    else void this.send({id:value.id,error:{code:-32601,message:'Unsupported client request'}}).catch(()=>{});
   }else this.events.push({method:value.method,params:object(value.params)?value.params:{}});
   return;
  }
  if(typeof value.id!=='number')return;const pending=this.pending.get(value.id);if(!pending)return;this.pending.delete(value.id);clearTimeout(pending.timer);
  if(object(value.error))pending.reject(Error(typeof value.error.message==='string'?value.error.message:'Codex App Server error'));
  else if(object(value.result))pending.resolve(value.result);else pending.reject(Error('AI の応答形式が正しくありません'));
 }
 private async toolRequest(event:JsonObject){
  let result:unknown;
  try{const p=event.params;if(!object(p)||typeof p.tool!=='string')throw Error('道具の要求が正しくありません');const output=await this.options.toolCall!(p.tool,p.arguments,this.controller.signal);result={success:true,contentItems:[{type:'inputText',text:JSON.stringify(output)}]};}
  catch(error){result={success:false,contentItems:[{type:'inputText',text:error instanceof Error?error.message:String(error)}]};}
  await this.send({id:event.id,result}).catch(()=>{});
 }
 private fail(error:Error){if(this.stopped)return;this.stopped=true;this.controller.abort();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.events.end(error);}
 private kill(){if(this.child)killOwnedProcess(this.child);}
 async close(){this.options.signal?.removeEventListener('abort',this.abort);this.fail(Error('AI の接続を終了しました'));this.kill();await this.exit;}
}
export async function inspectAppServer(options:AppServerOptions){
 const client=await new AppServerClient(options).start();try{
  const account=(await client.call('account/read')).account;
  if(!object(account)||account.type!=='chatgpt')return {ok:false,reason:'login',message:'',models:[],default:null};
  const models:Array<{id:string;name:string;efforts:string[];effort:string|null;context:number|null}>=[];let cursor:unknown=null,defaultModel:string|null=null;const seen=new Set<unknown>();
  do{const result=await client.call('model/list',{cursor});for(const raw of Array.isArray(result.data)?result.data:[]){if(!object(raw)||raw.hidden||typeof raw.id!=='string')continue;const efforts=(Array.isArray(raw.supportedReasoningEfforts)?raw.supportedReasoningEfforts:[]).filter(object).map(e=>e.reasoningEffort).filter((e):e is string=>typeof e==='string');models.push({id:raw.id,name:typeof raw.displayName==='string'?raw.displayName:raw.id,efforts,effort:typeof raw.defaultReasoningEffort==='string'?raw.defaultReasoningEffort:null,context:typeof raw.contextWindow==='number'?raw.contextWindow:null});if(raw.isDefault)defaultModel=raw.id;}cursor=result.nextCursor??null;if(cursor&&seen.has(cursor))throw Error('モデル一覧のページが循環しています');seen.add(cursor);if(models.length>10000)throw Error('モデル一覧が大きすぎます');}while(cursor);
  let limits:unknown={};try{limits=codexLimits((await client.call('account/rateLimits/read')).rateLimits);}catch{}
  return {ok:true,models,default:defaultModel,message:'',limits,account:{email:account.email,plan:account.planType}};
 }finally{await client.close();}
}
