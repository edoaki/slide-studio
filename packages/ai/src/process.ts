import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
export function killOwnedProcess(child:ChildProcess,signal:NodeJS.Signals='SIGKILL'){
 if(!child.pid)return;
 if(process.platform==='win32'&&(child.exitCode!==null||child.signalCode!==null))return;
 if(process.platform==='win32'&&signal==='SIGKILL'){
  const killer=spawn(join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.on('error',()=>{try{child.kill(signal);}catch{}});return;
 }
 if(process.platform!=='win32'){try{process.kill(-child.pid,signal);return;}catch{}}
 try{child.kill(signal);}catch{}
}
export interface ProcessOptions {cwd?:string;env?:NodeJS.ProcessEnv;signal?:AbortSignal;timeoutMs?:number;input?:string;onLine?:(line:string)=>void;onStderr?:(tail:string)=>void;capture?:boolean}
/** Bounded output and owned-process cancellation; commands are never shell strings. */
export function execute(executable:string,args:string[],options:ProcessOptions={}):Promise<{code:number;stdout:string;stderr:string}>{
 return new Promise((resolve,reject)=>{
  if(options.signal?.aborted){reject(Error('AI の実行を取り消しました'));return;}
  const child=spawn(executable,args,{cwd:options.cwd,env:options.env??process.env,shell:false,detached:process.platform!=='win32',windowsHide:true,stdio:'pipe'});
  let stdout='',stderr='',buffer='',error:Error|null=null,killTimer:NodeJS.Timeout|undefined;const decoder=new StringDecoder('utf8');
  const stop=(reason:Error)=>{error??=reason;killOwnedProcess(child,'SIGTERM');killTimer??=setTimeout(()=>killOwnedProcess(child),2000);};
  const abort=()=>stop(Error('AI の実行を取り消しました'));options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>stop(Error('AI の処理が時間切れになりました')),options.timeoutMs??30000);
  child.on('error',e=>{error=e;});child.stdin.on('error',e=>{if((e as NodeJS.ErrnoException).code!=='EPIPE')stop(e);});
  child.stdout.on('data',(chunk:Buffer)=>{try{const text=decoder.write(chunk);if(options.capture!==false){stdout+=text;if(Buffer.byteLength(stdout)>16*1024*1024)throw Error('AI の出力が大きすぎます');}if(options.onLine){buffer+=text;if(Buffer.byteLength(buffer)>32*1024*1024)throw Error('AI の通知が大きすぎます');for(;;){const index=buffer.indexOf('\n');if(index<0)break;const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim())options.onLine(line);}}}catch(e){stop(e instanceof Error?e:Error(String(e)));}});
  child.stderr.on('data',(bytes:Buffer)=>{stderr=(stderr+bytes.toString('utf8')).slice(-65536);try{options.onStderr?.(stderr);}catch(e){stop(e instanceof Error?e:Error(String(e)));}});
  child.once('close',code=>{killOwnedProcess(child);clearTimeout(timer);if(killTimer)clearTimeout(killTimer);options.signal?.removeEventListener('abort',abort);try{if(buffer.trim())options.onLine?.(buffer+decoder.end());}catch(e){error??=e instanceof Error?e:Error(String(e));}if(error)reject(error);else resolve({code:code??1,stdout,stderr});});
  child.stdin.end(options.input);
 });
}
