import { AppServerClient, type AppServerOptions, type JsonObject, type RpcEvent } from './app-server.js';
import type {AppServerPool} from './pool.js';
export interface CodexRunOptions extends AppServerOptions {
 prompt:string;model:string;effort?:string|null;session?:string|null;images?:string[];schema?:JsonObject;readonly?:boolean;signal?:AbortSignal;
 onSession?:(id:string)=>void;onEvent?:(event:RpcEvent)=>void;
 pool?:AppServerPool;
}
/** A completed status is required; disconnects and cancellation are never success. */
export async function runCodex(options:CodexRunOptions){
 if(options.signal?.aborted)throw Error('AI の実行を取り消しました');
 const lease=await options.pool?.acquire({...options,signal:undefined});
 const client=lease?.client??new AppServerClient({...options,signal:undefined});let session=options.session??null,turnId:string|null=null,cancelled=false,healthy=false,killTimer:NodeJS.Timeout|undefined;
 const cancel=()=>{cancelled=true;if(client.alive&&session&&turnId)void client.call('turn/interrupt',{threadId:session,turnId}).catch(()=>{});killTimer=setTimeout(()=>void client.close(),2000);};
 options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
 try{
  if(!lease)await client.start();if(cancelled)throw Error('AI の実行を取り消しました');
  const account=(await client.call('account/read')).account as JsonObject|undefined;if(account?.type!=='chatgpt')throw Error('ChatGPT アカウントでログインしてください');
  const params:JsonObject={cwd:options.cwd,model:options.model,approvalPolicy:'never'};if(options.readonly)params.sandbox='read-only';if(session)params.threadId=session;
  const started=await client.call(session?'thread/resume':'thread/start',params),thread=started.thread as JsonObject|undefined;
  if(typeof thread?.id!=='string')throw Error('AI の会話 ID がありません');session=thread.id;options.onSession?.(session);
  if(cancelled)throw Error('AI の実行を取り消しました');
  const turn=await client.call('turn/start',{threadId:session,input:[{type:'text',text:options.prompt},...(options.images??[]).map(path=>({type:'localImage',path}))],...(options.effort?{effort:options.effort}:{}),...(options.schema?{outputSchema:options.schema}:{})});
  const initial=turn.turn as JsonObject|undefined;if(typeof initial?.id!=='string')throw Error('AI の実行 ID がありません');turnId=initial.id;if(cancelled)void client.call('turn/interrupt',{threadId:session,turnId}).catch(()=>{});
  let final='';
  for(;;){const event=await client.events.next();if(event.params.threadId&&event.params.threadId!==session)continue;options.onEvent?.(event);
   if(event.method==='item/completed'){const item=event.params.item as JsonObject|undefined;if(item?.type==='agentMessage'&&typeof item.text==='string')final=item.text;}
   if(event.method==='turn/completed'){const completed=event.params.turn as JsonObject|undefined;if(completed?.id!==turnId)continue;
    if(completed.status!=='completed'){const error=completed.error as JsonObject|undefined;throw Error(typeof error?.message==='string'?error.message:completed.status==='interrupted'?'AI の実行を取り消しました':'AI の実行に失敗しました');}
    if(cancelled)throw Error('AI の実行を取り消しました');healthy=true;return {session,final};
   }
  }
 }finally{if(killTimer)clearTimeout(killTimer);options.signal?.removeEventListener('abort',cancel);if(lease)await lease.release(healthy);else await client.close();}
}
