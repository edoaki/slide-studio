import type { Workspace } from '../../packages/core/src/workspace.js';
import type { LegacyFeatureRequest, LegacyFeatureResponse } from '../../packages/contracts/src/server.js';
import * as library from '../../packages/core/src/library.js';
import { searchSlides, searchSlideDecks, takeSlide } from '../../packages/core/src/slide-library.js';
import * as bib from '../../packages/core/src/bibliography.js';
/** Serialize read/modify/write bibliography operations across decks sharing a topic. */
export class LegacyInsertion {
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private options:{pandocPath:string;changed:(path:string)=>void}){}
 handle(ws:Workspace,req:LegacyFeatureRequest):Promise<LegacyFeatureResponse|null>{if(req.pathname!=='/api/slides/search'&&!/^\/api\/deck\/[^/]+\/slides\/take$/u.test(req.pathname)&&!/^\/api\/topic\/[^/]+(?:\/html\/delete)?$/u.test(req.pathname)&&req.pathname!=='/api/math'&&!/^\/api\/deck\/[^/]+\/(library|bib)$/u.test(req.pathname)&&!/^\/api\/topic\/[^/]+\/bib(?:\/verify)?$/u.test(req.pathname))return Promise.resolve(null);const run=this.tail.then(()=>this.run(ws,req));this.tail=run.catch(()=>{});return run;}
 private async run(ws:Workspace,req:LegacyFeatureRequest):Promise<LegacyFeatureResponse>{
 const body=(req.body??{}) as Record<string,unknown>,value=(k:string)=>typeof body[k]==='string'?body[k] as string:'';
 try{
 if(req.pathname==='/api/slides/search'){const q=req.query.get('q')??'',exclude=req.query.get('exclude')??'';return {body:req.query.get('view')==='decks'?searchSlideDecks(ws,q,exclude):searchSlides(ws,q,{exclude,deck:req.query.get('deck')??undefined})};}
 const takeRoute=/^\/api\/deck\/([^/]+)\/slides\/take$/u.exec(req.pathname);
 if(takeRoute){const result=await takeSlide(ws,decodeURIComponent(takeRoute[1]!),value('deck'),body.page,value('version'));this.options.changed('topics/');return {body:result};}
 const topicRoute=/^\/api\/topic\/([^/]+)(\/html\/delete)?$/u.exec(req.pathname);
 if(topicRoute){const shelf=decodeURIComponent(topicRoute[1]!);
  if(req.method==='GET'||req.method==='HEAD')return {body:library.topic_listing(ws,shelf)};
  if(req.method==='DELETE'){const trash=ws.remove_topic(shelf);this.options.changed(`topics/${shelf}/`);return {body:{ok:true,trash}};}
  if(req.method==='POST'&&topicRoute[2]){const moved=library.delete_topic_html(ws,shelf,body.paths);this.options.changed(`topics/${shelf}/html/`);return {body:{ok:true,moved}};}
  return {status:405,body:{error:'許可されていない操作です'}};
 }
 if(req.pathname==='/api/math')return {body:{html:await library.math_html(value('tex'),this.options.pandocPath,ws.root)}};
 const match=/^\/api\/(deck|topic)\/([^/]+)\/(library|bib)(?:\/verify)?$/u.exec(req.pathname)!;const name=decodeURIComponent(match[2]!),topic=match[1]==='topic';
 if(!topic&&!ws.has_deck(name))return {status:404,body:{error:'発表がありません'}};
 if(match[3]==='library'){if(req.method==='GET'||req.method==='HEAD')return {body:await library.listing(ws,name,this.options.pandocPath)};const result=await library.take(ws,name,value('kind'),value('deck'),value('path'));this.options.changed(`topics/${ws.deck_shelf(name)}/`);return {body:result};}
 const path=library.topic_path(ws,topic?name:ws.deck_shelf(name),'reference.bib');
 if(req.method==='POST'||req.method==='PATCH'){if(!topic)await bib.require_ready(ws,name);if(req.method==='PATCH')await bib.update_path(path,value('key'),body.fields as Record<string,string>,value('original'));else await bib.verify_path(path,value('key'));this.options.changed(`topics/${topic?name:ws.deck_shelf(name)}/reference.bib`);}
 if(req.query.get('view')==='full'||topic)return {body:{entries:bib.listing(path)}};
 await bib.require_ready(ws,name);return {body:{entries:bib.listing(path).map(e=>({key:e.key,title:e.fields.title??'',author:(e.authors[0]?.name.split(',')[0]?.trim()??'')+(e.authors.length>1?' ほか':''),year:e.fields.year??'',unverified:e.unverified}))}};
 }catch(e){return {status:req.method==='GET'||req.method==='HEAD'?409:400,body:{error:e instanceof Error?e.message:String(e)}};}
 }
}
