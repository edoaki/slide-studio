import type { Workspace } from '../../packages/core/src/legacy-workspace.js';
import * as materials from '../../packages/core/src/legacy-materials.js';
import type { LegacyFeatureRequest, LegacyFeatureResponse } from '../../packages/contracts/src/legacy.js';

export async function handleMaterials(ws:Workspace,req:LegacyFeatureRequest,options:{openPath?:(path:string)=>Promise<void>;changed?:(path:string)=>void}):Promise<LegacyFeatureResponse|null>{
  const match=/^\/api\/deck\/([^/]+)\/materials(?:\/([^/]+))?$/u.exec(req.pathname);
  if(!match)return null;
  const deck=decodeURIComponent(match[1]!);
  if(!ws.has_deck(deck))return {status:404,body:{error:'発表がありません'}};
  const body=req.body&&typeof req.body==='object'?req.body as Record<string,unknown>:{};
  const path=typeof body.path==='string'?body.path:'',to=typeof body.to==='string'?body.to:'';
  try{
    let result:unknown;
    if(!match[2]){
      if(req.method==='GET'||req.method==='HEAD'){const listed=materials.listing(ws,deck);return {body:{...listed,entries:listed.entries.map(e=>({...e,url:`/files/decks/${encodeURIComponent(deck)}/materials/${e.path.split('/').map(encodeURIComponent).join('/')}?v=${e.modified}`}))}};}
      if(req.method!=='POST')return {status:405,body:{error:'method not allowed'}};
      result=materials.add(ws,deck,req.query.get('path')??'',req.bytes);
    }else{
      if(match[2]==='read'&&(req.method==='GET'||req.method==='HEAD'))return {bytes:materials.read_preview(ws,deck,req.query.get('path')??''),headers:{'content-type':'application/octet-stream'}};
      if(req.method!=='POST')return {status:405,body:{error:'method not allowed'}};
      switch(match[2]){
        case 'open':
          if(!options.openPath)return {status:501,body:{error:'ファイルを開く機能が接続されていません'}};
          return {body:{opened:await materials.open_in_os(ws,deck,path,options.openPath)}};
        case 'mkdir':result=materials.create(ws,deck,path,true);break;
        case 'move':result=materials.move(ws,deck,path,to);break;
        case 'delete':result=materials.remove(ws,deck,path);break;
        case 'restore':result=materials.restore(ws,deck,path,typeof body.trash==='string'?body.trash:'');break;
        default:return {status:404,body:{error:'その操作はありません'}};
      }
    }
    options.changed?.(`decks/${deck}/materials/`);
    return {body:result};
  }catch(error){return {status:400,body:{error:error instanceof Error?error.message:String(error)}};}
}
