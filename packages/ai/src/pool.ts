import {createHash} from 'node:crypto';
import {AppServerClient, type AppServerOptions} from './app-server.js';
type Entry={key:string;client:AppServerClient;busy:boolean;timer?:NodeJS.Timeout};
/** Each leased connection has one turn owner. Idle connections expire and are
 * never reused after cancellation, a protocol failure or a runtime change. */
export class AppServerPool {
 private entries=new Set<Entry>();private closed=false;
 constructor(private idleMs=300000,private maxIdle=4){}
 async acquire(options:AppServerOptions){
  if(this.closed)throw Error('AI の接続を終了しています');
  const key=createHash('sha256').update(JSON.stringify([options.executable,options.args,options.cwd,options.env,options.protocol])).digest('hex');
  let entry=[...this.entries].find(e=>e.key===key&&!e.busy&&e.client.alive);
  if(entry){clearTimeout(entry.timer);entry.busy=true;entry.client.events.clear();}
  else {
   entry={key,client:new AppServerClient({...options,signal:undefined}),busy:true};this.entries.add(entry);
   try{await entry.client.start();}catch(error){this.entries.delete(entry);await entry.client.close();throw error;}
   if(this.closed){this.entries.delete(entry);await entry.client.close();throw Error('AI の接続を終了しています');}
  }
  const leased=entry;let released=false;
  return {client:leased.client,release:async(healthy:boolean)=>{
   if(released)return;released=true;leased.busy=false;
   if(!healthy||this.closed||!leased.client.alive||[...this.entries].filter(e=>!e.busy).length>this.maxIdle){this.entries.delete(leased);await leased.client.close();return;}
   leased.timer=setTimeout(()=>{this.entries.delete(leased);void leased.client.close();},this.idleMs);leased.timer.unref();
  }};
 }
 async close(){this.closed=true;const entries=[...this.entries];this.entries.clear();await Promise.all(entries.map(async e=>{clearTimeout(e.timer);await e.client.close();}));}
}
