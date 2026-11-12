import type { Workspace } from '../../packages/core/src/legacy-workspace.js';
import * as assets from '../../packages/core/src/legacy-assets.js';
import type { LegacyFeatureRequest, LegacyFeatureResponse } from '../../packages/contracts/src/legacy.js';
export async function handleAssets(ws:Workspace,req:LegacyFeatureRequest,changed:(path:string)=>void):Promise<LegacyFeatureResponse|null>{
 const match=/^\/api\/deck\/([^/]+)\/assets(?:\/([^/]+))?$/u.exec(req.pathname);if(!match)return null;
 const deck=decodeURIComponent(match[1]!);if(!ws.has_deck(deck))return {status:404,body:{error:'発表がありません'}};
 try{if(!match[2]&&(req.method==='GET'||req.method==='HEAD'))return {body:assets.listing(ws,deck)};
 if(req.method!=='POST')return {status:405,body:{error:'method not allowed'}};
 let result:unknown;const body=(req.body??{}) as Record<string,unknown>;
 if(!match[2])result=assets.add(ws,deck,req.query.get('name')??'',req.bytes,String(req.headers['content-type']??''));
 else if(match[2]==='delete'){if(!Array.isArray(body.paths)||!body.paths.every(p=>typeof p==='string'))throw Error('素材の場所が正しくありません');result={items:assets.remove(ws,deck,body.paths)};}
 else if(match[2]==='restore'){if(!Array.isArray(body.items)||!body.items.every(i=>i&&typeof i.path==='string'&&typeof i.trash==='string'))throw Error('ごみ箱の場所が正しくありません');result={items:assets.restore(ws,deck,body.items)};}
 else return {status:404,body:{error:'その操作はありません'}};
 changed(`topics/${ws.deck_shelf(deck)}/`);return {body:result};
 }catch(e){return {status:400,body:{error:e instanceof Error?e.message:String(e)}};}
}
