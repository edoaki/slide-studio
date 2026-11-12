import { makeHandles } from '../block-handles.js';
import { makeDrag } from '../block-drag.js';
import * as op from '../block-ops.js';
export function createFrameBlocks(win,doc,{getSourceVersion,sendEvent}){
 const host=doc.createElement('div');host.className='slide-studio-controls';Object.assign(host.style,{position:'fixed',inset:'0',pointerEvents:'none',zIndex:'99990'});doc.body.append(host);
 let config=null,st=null,sequence=0,sourceVersion=null;
 const elements=key=>[...doc.querySelectorAll('[data-slide-studio]')].filter(e=>e.dataset.slideStudio===key);
 const edit={elements,table:key=>elements(key).map(e=>e.matches('table')?e:e.querySelector('table')).find(Boolean),leafAt:el=>el,swallowClick:()=>{swallow=true;setTimeout(()=>{swallow=false;},0);}};
 let swallow=false;doc.addEventListener('click',e=>{if(swallow){e.preventDefault();e.stopImmediatePropagation();swallow=false;}},true);
 const emit=(kind,values)=>{if(config?.live&&sourceVersion===getSourceVersion())sendEvent('block.intent',{sourceVersion,sequence:++sequence,trusted:true,kind,...values});};
 new win.MutationObserver(()=>emit('gesture',{active:host.hasAttribute('data-operating')})).observe(host,{attributes:true,attributeFilter:['data-operating']});
 const apply=(name,key,value)=>emit('operation',{name,key,value});
 const frame={getBoundingClientRect:()=>({left:0,top:0,right:win.innerWidth,bottom:win.innerHeight,width:win.innerWidth,height:win.innerHeight})};
 const env=()=>({win,edit,frame,st,selected:config?.key,live:!!config?.live,preview:{index:win.deck.index,pageOfSlide:i=>{const page=win.deck.slides[i]?.dataset?.page;return page==null?i:Number(page);}}});
 const handles=makeHandles(host),drag=makeDrag(host,{env,select:key=>emit('select',{key}),commit:()=>{},apply,outside:(phase,key,point)=>emit('outside',{phase,key,point})});drag.attach(win);
 return {
  configure(p){if(p.sourceVersion!==getSourceVersion())throw Error('stale-source');if(p.structure){st={...op.units(p.text,p.structure),text:p.text};sourceVersion=p.sourceVersion;}if(!st||sourceVersion!==p.sourceVersion)throw Error('missing-structure');config=p;if(!p.live)drag.cancel();handles.draw({...env(),key:p.key,color:p.color,padMode:p.padMode,apply,write:()=>{},padded:(kind,value)=>emit('padded',{padKind:kind,value}),ended:()=>emit('layout',{})});return null;},
  dropAt(p){if(!config?.live)return null;const target=drag.newAt(p.x,p.y);return target?{spec:target.spec,mark:target.mark}:null;},
  clear(){drag.clearNew();},cancel(){drag.cancel();handles.clear();emit('gesture',{active:false});},
 };
}
