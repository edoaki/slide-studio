import { readFileSync, readdirSync, lstatSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { Workspace } from '../../packages/core/src/legacy-workspace.js';
import { bundleHtml } from '../../packages/core/src/bundle.js';
import { atomicWriteFile } from '../../packages/core/src/atomic.js';
import { render_text, warning_issues } from '../../packages/core/src/legacy-render.js';
import { fig_args } from '../../packages/core/src/legacy-source.js';
import { figure_status } from '../../packages/core/src/legacy-assets.js';
import { fig_refs } from '../../packages/core/src/legacy-figures.js';
import { listing as bibListing } from '../../packages/core/src/legacy-bibliography.js';
import type { LegacyRendered,LegacyFeatureRequest,LegacyFeatureResponse } from '../../packages/contracts/src/legacy.js';
import type { LegacyInspect, LegacyInspection } from '../../packages/contracts/src/legacy-output.js';
import { isInsideRoot } from '../../packages/core/src/paths.js';
import { readAsset } from '../../packages/core/src/assets.js';
import { THEME_VARIABLES, theme_variables, TEMPLATES, set_front, check_name } from '../../packages/core/src/legacy-workspace.js';
type Issue={level:string;kind:string;message:string;[key:string]:unknown};
type CheckResult={version:{qmd:string;deps:string};checked_at:number;errors:Issue[];warnings:Issue[];slides:number};
type Built={pages:LegacyRendered["slides"];html:string;result:CheckResult;inspection:LegacyInspection;shots:string[][]};
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
function safePath(ws:Workspace,path:string){if(!isInsideRoot(ws.root,path))throw Error('置き場の外は操作できません');for(let p=path;;p=dirname(p)){try{if(lstatSync(p).isSymbolicLink())throw Error('シンボリックリンクを経由できません');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(p===ws.root)break;}}
export function version(ws:Workspace,deck:string){const parts:string[]=[];function walk(p:string){if(!existsSync(p))return;safePath(ws,p);const st=lstatSync(p);if(st.isDirectory())for(const n of readdirSync(p).sort())walk(join(p,n));else if(st.isFile())parts.push(relative(ws.root,p)+':'+hash(readFileSync(p)));}for(const p of [ws.asset_root(deck),ws.themes,join(ws.deck_dir(deck),'styles'),join(ws.state,'runtime')])walk(p);return {qmd:hash(readFileSync(ws.qmd(deck))),deps:hash(parts.join('\n'))};}
export function output_path(ws:Workspace,deck:string,kind:string){const meta=ws.deck_meta(deck);let title=String(meta.title||meta.pagetitle||deck).replace(/\s+/gu,' ').trim().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu,'_').replace(/^[ .]+|[ .]+$/gu,'');while(Buffer.byteLength(title)>240)title=Array.from(title).slice(0,-1).join('');return join(ws.deck_dir(deck),`${title.replace(/[ .]+$/gu,'')||deck}.${kind}`);}
export function static_issues(ws:Workspace,deck:string,r:LegacyRendered):Issue[]{const doc=r.doc,out:Issue[]=[],chars=Array.from(doc.text),ids=new Map<string,number>();const issue=(level:string,kind:string,message:string,extra={})=>out.push({level,kind,message,...extra});if(!doc.front[1])issue('error','structure','front matter がありません（title・topic・theme）');if(doc.meta_error)issue('error','structure',doc.meta_error);for(const key of ['topic','theme'])if(doc.front[1]&&!doc.meta[key])issue('error','structure',`front matter に ${key}: がありません`);
 const theme=doc.meta.theme;
 if(typeof theme==='string'){
  const path=join(ws.themes,theme+'.css');
  try{safePath(ws,path);if(!existsSync(path))issue('error','missing',`テーマがありません: themes/${theme}.css`);
   else{const defined=theme_variables(readFileSync(path,'utf8')),lacking=THEME_VARIABLES.filter(v=>!defined.includes(v));if(lacking.length)issue('error','theme',`テーマ themes/${theme}.css に必須の変数がありません: ${lacking.join(', ')}`);}
  }catch(error){issue('error','theme',String(error));}
 }
 const placeholderSource=/export const PAGE_PLACEHOLDERS = (\{[\s\S]*?\});/u.exec(readAsset('strings.js'));
 const placeholders=new Set(Object.values(placeholderSource?JSON.parse(placeholderSource[1]!):{}));
 for(const p of doc.pages){const slide=r.slides.find(s=>s.page===p.index)?.index??p.index,at={page:p.index,slide,page_id:p.id};if(!p.id)issue('error','structure',`p${p.index+1}「${p.title}」にページ ID {#id} がありません`,at);else if(!/^[a-z][a-z0-9-]*$/u.test(p.id))issue('error','structure',`ページ ID は英小文字・数字・ハイフンにしてください: ${p.id}`,at);else if(ids.has(p.id))issue('error','structure',`ページ ID が重複しています: ${p.id}`,at);ids.set(p.id,p.index);
 for(const c of p.walk())if(c.kind==='text'){
  const raw=chars.slice(c.start,c.end).join('').trim();if(/^(?:```|~~~|\$\$| {4}|\t)/u.test(raw))continue;
  if(raw.split(/[\n|]/u).some(cell=>placeholders.has(cell.trim().replace(/^(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)/u,'').replace(/^\*\*(.*?)\*\*$/u,'$1'))))issue('warning','placeholder',`p${p.index+1} にひな形の仮の文字が残っています`,{...at,block:`p${p.index}/${c.path}`});
 }
 for(const image of chars.slice(p.head_end,p.end).join('').matchAll(/!\[[^\]]*\]\(([^)\s]+)/gu)){
  const target=image[1]!;
  if(/^(?:https?:|\/\/)/u.test(target)){issue('error','external',`外部の画像は使えません: ${target}`,at);continue;}
  const base=target.startsWith('images/')&&doc.meta.topic?ws.topic_dir(String(doc.meta.topic)):ws.deck_dir(deck);
  const path=join(base,target);
  try{safePath(ws,path);if(!existsSync(path))issue('error','missing',`画像がありません: ${target}`,{...at,resource:'/'+relative(ws.root,path).replaceAll('\\','/'),detection:'source'});}
  catch(error){issue('error','missing',String(error),at);}
 }
 for(const c of p.walk())if(c.kind==='fig'){const ref=fig_args(chars.slice(c.start,c.end).join(''))?.ref??'';try{const [status,reasons]=figure_status(ws,ws.figure_dir(ref,deck));if(status==='ng')for(const message of reasons)issue('error','figure-code',message,{...at,figure:ref});}catch(e){issue('error','missing',String(e),at);}}
 }
 if(doc.unclosed_at!==null)issue('error','structure','閉じていない囲み（::: か ```）があります');if(doc.preamble.trim())issue('warning','structure','最初のページの見出しより前の本文は表示されません');
 for(const key of r.missing_cites)issue('error','citation',`引用キーが reference.bib にありません: ${key}`,{citation_key:key});for(const e of bibListing(ws.bib(deck)))if(e.unverified&&r.cited.includes(e.key))issue('warning','unverified',`未確認の文献: ${e.key}`,{citation_key:e.key});for(const u of r.unsupported)issue('warning','unsupported',String(u.message),{page:u.page});out.push(...warning_issues(r) as Issue[]);return out;}
export class LegacyOutput{
 private scheduled=new Map<string,NodeJS.Timeout>();
 private background=new Map<string,Promise<unknown>>();
 private themeJobs=new Map<string,Promise<void>>();
 private stopped=false;
 private active=0;
 get busy(){return this.active>0||this.scheduled.size>0;}
 private tail:Promise<unknown>=Promise.resolve();private cache=new Map<string,Built>();
 constructor(private options:{pandocPath:string;inspect?:LegacyInspect;broadcast:(event:Record<string,unknown>)=>void}){}
 async settleThemes(){await Promise.all(this.themeJobs.values());}
 async settle(){for(const timer of this.scheduled.values())clearTimeout(timer);this.scheduled.clear();for(;;){const pending=this.tail;await pending;if(pending===this.tail)break;}}
 scheduleTheme(ws:Workspace,name:string){
  if(this.stopped||!this.options.inspect)return;check_name(name,'テーマ');const key=ws.root+'\0theme:'+name;if(this.themeJobs.has(key))return;
  const task=this.tail.then(async()=>{
   const cssPath=join(ws.themes,name+'.css');safePath(ws,cssPath);if(!existsSync(cssPath))return;
   const css=readFileSync(cssPath,'utf8'),sample=readFileSync(join(TEMPLATES,'theme-sample.qmd'),'utf8'),stamp=hash(css+sample);
   const dir=join(ws.state,'themes',name);safePath(ws,dir);
   try{if(JSON.parse(readFileSync(join(dir,'index.json'),'utf8')).hash===stamp&&[0,1,2,3].every(i=>existsSync(join(dir,`${i}.png`))))return;}catch{}
   const rendered=await render_text(ws,'__theme-sample__',set_front(sample,{theme:name}),{pandocPath:this.options.pandocPath,wrap:false});
   const bundled=bundleHtml(rendered.html,ws.deck_dir('__theme-sample__'),ws.root);
   if(bundled.warnings.length)throw Error(bundled.warnings.map(w=>w.message).join('\n'));
   const result=await this.options.inspect!(bundled.html,{pdf:false,screenshots:true,allSteps:false});
   if(!existsSync(cssPath)||readFileSync(cssPath,'utf8')!==css)return;
   mkdirSync(dir,{recursive:true});
   for(let i=0;i<4;i++){const shot=result.screenshots.find(s=>s.slide===i);if(!shot)throw Error('テーマの見本画像がありません');const path=join(dir,`${i}.png`);safePath(ws,path);await atomicWriteFile(path,shot.bytes,0o600);}
   const index=join(dir,'index.json');safePath(ws,index);await atomicWriteFile(index,JSON.stringify({hash:stamp}),0o600);
   this.options.broadcast({type:'theme-shots',name});
  }).catch(error=>this.options.broadcast({type:'theme-shots-error',name,error:error instanceof Error?error.message:String(error)})).finally(()=>this.themeJobs.delete(key));
  this.themeJobs.set(key,task);this.tail=task;
 }
 saved(ws:Workspace,deck:string):{result:CheckResult|null;slides:string[][];stale:boolean}{
  const path=join(ws.state,'build',deck,'checks.json');
  try{safePath(ws,path);const data=JSON.parse(readFileSync(path,'utf8'));if(!data.result||!Array.isArray(data.result.errors)||!Array.isArray(data.result.warnings)||!Array.isArray(data.slides))throw Error('invalid cache');
   const prefix=`/files/.slide-studio/build/${encodeURIComponent(deck)}/shots/`;
   const slides=data.slides.map((row:unknown)=>Array.isArray(row)?row.map(url=>typeof url==='string'&&url.startsWith(prefix)&&/^[a-f\d]{64}\/p\d+-s\d+\.png$/u.test(url.slice(prefix.length))?url:''):[]);
   return {result:data.result,slides,stale:JSON.stringify(data.result.version)!==JSON.stringify(version(ws,deck))};
  }catch{return {result:null,slides:[],stale:true};}
 }
 schedule(ws:Workspace,deck:string,delay=400){
  if(this.stopped||!this.options.inspect)return;const key=ws.root+'\0'+deck;
  const old=this.scheduled.get(key);if(old)clearTimeout(old);
  this.scheduled.set(key,setTimeout(()=>{this.scheduled.delete(key);if(this.stopped)return;
   if(this.background.has(key)){this.schedule(ws,deck,400);return;}
   const saved=this.saved(ws,deck);if(!saved.stale){this.options.broadcast({type:'checks',deck,result:saved.result,busy:false,stale:false});return;}
   this.options.broadcast({type:'checks',deck,result:saved.result,busy:true,stale:true});
   const task=this.check(ws,deck).catch(error=>{this.options.broadcast({type:'checks',deck,result:saved.result,busy:false,stale:true,error:error instanceof Error?error.message:String(error)});}).finally(()=>this.background.delete(key));this.background.set(key,task);
  },delay));
 }
 async close(){this.stopped=true;for(const timer of this.scheduled.values())clearTimeout(timer);this.scheduled.clear();await this.tail;await Promise.allSettled([...this.background.values()]);}
 audit(ws:Workspace,deck:string):Promise<Built>{this.active++;const run=this.tail.then(()=>this.inspect(ws,deck,false,()=>{},false)).finally(()=>{this.active--;});this.tail=run.catch(()=>{});return run;}
 check(ws:Workspace,deck:string):Promise<CheckResult>{this.active++;const run=this.tail.then(async()=>(await this.inspect(ws,deck,false,()=>{})).result).finally(()=>{this.active--;});this.tail=run.catch(()=>{});return run;}
 checkFigure(ws:Workspace,ref:string):Promise<CheckResult & {figure:string;decks:string[]}>{
  this.active++;const run=this.tail.then(async()=>{
   const figure=ws.figure_dir(ref);safePath(ws,figure);if(!existsSync(join(figure,'figure.mjs')))throw Error(`図がありません: ${ref}`);
   const decks=ws.list_decks().filter(deck=>fig_refs(readFileSync(ws.qmd(deck),'utf8')).includes(ref));
   const theme=decks.length?ws.deck_theme(decks[0]!):'default';
   const parent=join(ws.root,'decks');safePath(ws,parent);const dir=mkdtempSync(join(parent,'_check-')),deck=relative(parent,dir);
   try{
    await atomicWriteFile(join(dir,'slides.qmd'),`---\ntitle: ${JSON.stringify(ref)}\ntopic: ${JSON.stringify(ref.split('/')[0])}\ntheme: ${JSON.stringify(theme)}\n---\n\n## 図 {#figure}\n\n{{< fig ${ref} height=560 >}}\n`,0o600);
    const built=await this.inspect(ws,deck,false,()=>{},false);return {...built.result,figure:ref,decks};
   }finally{rmSync(dir,{recursive:true,force:true});}
  }).finally(()=>{this.active--;});this.tail=run.catch(()=>{});return run;
 }
 handle(ws:Workspace,req:LegacyFeatureRequest):Promise<LegacyFeatureResponse|null>{if(!/^\/api\/deck\/[^/]+\/(?:build|check|checks|shots(?:\/priority)?|download\/(?:html|pdf))$/u.test(req.pathname))return Promise.resolve(null);this.active++;const run=this.tail.then(()=>this.run(ws,req)).finally(()=>{this.active--;});this.tail=run.catch(()=>{});return run;}
 private async inspect(ws:Workspace,deck:string,pdf:boolean,progress:(n:number)=>void,persist=true):Promise<Built>{const v=version(ws,deck),key=ws.root+'\0'+deck;const old=this.cache.get(key);if(persist&&old&&JSON.stringify(old.result.version)===JSON.stringify(v)&&(!pdf||old.inspection.pdf)){this.options.broadcast({type:'checks',deck,result:old.result,busy:false,stale:false});return old;}
 if(!this.options.inspect)throw Error('描画サービスが接続されていません');progress(5);const source=readFileSync(ws.qmd(deck),'utf8'),r=await render_text(ws,deck,source,{pandocPath:this.options.pandocPath,wrap:false});const issues=static_issues(ws,deck,r);progress(15);const bundled=bundleHtml(r.html,ws.deck_dir(deck),ws.root);for(const w of bundled.warnings)issues.push({level:'error',kind:'resource',message:w.message});progress(25);
 const inspection=await this.options.inspect(bundled.html,{pdf,screenshots:true,allSteps:true});for(const step of inspection.steps)if(Array.isArray(step.layout))for(const found of step.layout)if(found&&typeof found==='object')issues.push({...found as Issue,slide:step.slide,step:step.step});progress(85);
 if(JSON.stringify(v)!==JSON.stringify(version(ws,deck)))throw Error('原稿や依存ファイルが変わっています。再試行してください');
 const result:CheckResult={version:v,checked_at:Date.now()/1000,errors:issues.filter(i=>i.level==='error'),warnings:issues.filter(i=>i.level!=='error'),slides:inspection.slides};const shots:string[][]=Array.from({length:inspection.slides},()=>[]);const dir=join(ws.state,'build',deck,'shots',hash(JSON.stringify(v)));if(persist){safePath(ws,dir);mkdirSync(dir,{recursive:true});}for(const shot of inspection.screenshots){const name=`p${shot.slide}-s${shot.step}.png`;if(persist)await atomicWriteFile(join(dir,name),shot.bytes,0o600);shots[shot.slide]![shot.step]=`/files/.slide-studio/build/${encodeURIComponent(deck)}/shots/${hash(JSON.stringify(v))}/${name}`;}
 const built={pages:r.slides,html:bundled.html,result,inspection,shots};if(!persist)return built;if(this.cache.size>=4)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,built);const saved=join(ws.state,'build',deck,'checks.json');safePath(ws,saved);await atomicWriteFile(saved,JSON.stringify({result,slides:shots}),0o600);this.options.broadcast({type:'checks',deck,result,busy:false,stale:false});this.options.broadcast({type:'shots',deck,slides:shots});return built;}
 private async run(ws:Workspace,req:LegacyFeatureRequest):Promise<LegacyFeatureResponse>{const m=/^\/api\/deck\/([^/]+)\/(.*)$/u.exec(req.pathname)!,deck=decodeURIComponent(m[1]!),op=m[2]!,body=(req.body??{}) as Record<string,unknown>;if(!ws.has_deck(deck))return {status:404,body:{error:'発表がありません'}};
 try{if(op.startsWith('download/')){const kind=op.split('/')[1]!,path=output_path(ws,deck,kind);safePath(ws,path);return {bytes:readFileSync(path),headers:{'content-type':kind==='pdf'?'application/pdf':'text/html; charset=utf-8','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(path.split('/').at(-1)!)}};}
 if(op==='shots/priority'){if(!Array.isArray(body.indices)||body.indices.some(i=>!Number.isInteger(i)||i<0||i>10000))throw Error('ページの指定が正しくありません');this.schedule(ws,deck,0);return {body:{ok:true}};}
 if(op==='shots'||op==='checks'){const saved=this.saved(ws,deck);if(saved.stale)this.schedule(ws,deck,0);return {body:op==='shots'?{slides:saved.slides}:{result:saved.result,busy:saved.stale,stale:saved.stale}};}
 if((op==='build'||op==='check')&&body.base!==hash(readFileSync(ws.qmd(deck))))return {status:409,body:{error:'原稿が変わっています。読み込み直して再試行してください'}};
 if(body.format!==undefined&&body.format!==null&&!['html','pdf'].includes(String(body.format)))return {status:400,body:{error:'書き出し形式が正しくありません'}};
 const progress=(value:number)=>this.options.broadcast({type:'export-progress',deck,id:body.id,value,phase:'check'});
 const built=await this.inspect(ws,deck,op==='build'&&body.format!=='html',progress);
 if(op==='shots')return {body:{slides:built.shots}};if(op==='checks')return {body:{result:built.result,busy:false,stale:false}};if(op==='check')return {body:{result:built.result,summary:`エラー ${built.result.errors.length}・警告 ${built.result.warnings.length}`}};
 if(built.result.errors.length&&!body.force)return {body:{blocked:true,result:built.result}};
 // Missing/external resources cannot be made into a complete offline bundle by force.
 if(built.result.errors.some(i=>i.kind==='resource'))throw Error(built.result.errors.filter(i=>i.kind==='resource').map(i=>i.message).join('\n'));
 const formats=body.format?[String(body.format)]:['html','pdf'],files=[];for(const kind of formats){const path=output_path(ws,deck,kind);safePath(ws,path);const data=kind==='html'?built.html:built.inspection.pdf;if(!data)throw Error('PDF を生成できません');await atomicWriteFile(path,data,0o600);files.push({name:path.split('/').at(-1),url:`/api/deck/${encodeURIComponent(deck)}/download/${kind}`});}this.options.broadcast({type:'export-progress',deck,id:body.id,value:100,phase:'export'});return {body:{result:built.result,files}};
 }catch(e){return {status:400,body:{error:e instanceof Error?e.message:String(e)}};}
 }
}
