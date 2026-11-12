export function createFrameCover(win, doc, {getSourceVersion,sendEvent}) {
 let enabled=false,chosen=false,press=null,sequence=0;
 const target=()=>doc.querySelector('.cover-authors');
 function state(){const el=target();if(!el)return null;const r=el.getBoundingClientRect(),cs=win.getComputedStyle(el),values={position:el.dataset.affiliationPosition||'bottom'};
 for(const [key,attr] of [['font','nameFont'],['affFont','affFont'],['bold','nameBold'],['affBold','affBold']])if(el.dataset[attr]!==undefined)values[key]=key==='bold'||key==='affBold'?el.dataset[attr]==='true':el.dataset[attr];
 for(const [key,prop] of [['x','left'],['y','top'],['size','--cover-name-size'],['affSize','--cover-aff-size']])if(el.style.getPropertyValue(prop))values[key]=parseFloat(el.style.getPropertyValue(prop));
 const formats={};for(const [key,selector] of [['size','.cover-name,.cover-names'],['affSize','.cover-affiliation']]){const s=win.getComputedStyle(el.querySelector(selector)||el);formats[key]={size:parseFloat(s.fontSize),bold:parseInt(s.fontWeight,10)>=600};}
 return {values,formats,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},left:parseFloat(cs.left)||0,top:parseFloat(cs.top)||0};}
 const emit=kind=>sendEvent('cover.intent',{kind,trusted:true,sourceVersion:getSourceVersion(),sequence:++sequence,state:state()});
 function select(value){chosen=value;target()?.classList.toggle('cover-authors-selected',chosen);}
 const end=ok=>{if(!press)return;const old=press;press=null;if(ok&&old.moved)emit('commit');else if(!ok){if(old.style==null)target()?.removeAttribute('style');else target()?.setAttribute('style',old.style);}};
 doc.addEventListener('pointerdown',e=>{if(!e.isTrusted||!enabled||e.button||!e.target.closest('.cover-authors'))return;e.preventDefault();e.stopImmediatePropagation();select(true);emit('select');const s=state(),el=target(),stage=doc.querySelector('#stage');press={x:e.clientX,y:e.clientY,left:s.left,top:s.top,scale:stage.getBoundingClientRect().width/1280,style:el.getAttribute('style'),moved:false};el.setPointerCapture(e.pointerId);},true);
 doc.addEventListener('pointermove',e=>{if(!press||!e.isTrusted)return;if(!press.moved&&Math.hypot(e.clientX-press.x,e.clientY-press.y)<4)return;press.moved=true;e.preventDefault();target().style.left=`${Math.round(press.left+(e.clientX-press.x)/press.scale)}px`;target().style.top=`${Math.round(press.top+(e.clientY-press.y)/press.scale)}px`;emit('layout');},true);
 doc.addEventListener('pointerup',e=>{if(e.isTrusted)end(true);},true);doc.addEventListener('pointercancel',()=>end(false),true);win.addEventListener('blur',()=>end(false));
 return {state,select,configure(value){enabled=value;if(!value){end(false);select(false);}}};
}
