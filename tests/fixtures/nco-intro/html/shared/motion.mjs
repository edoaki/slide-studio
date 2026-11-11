// Retained SVG DOM: reconcile objects, interpolate geometry; never replace stage SVG.
const numeric=/^-?\d*\.?\d+(?:e[-+]?\d+)?$/i;
function interpolate(a,b){
 if(numeric.test(a)&&numeric.test(b))return t=>String(+a+(+b-a)*t);
 const re=/-?\d*\.?\d+(?:e[-+]?\d+)?/gi,A=a.match(re),B=b.match(re);
 if(A&&B&&A.length===B.length&&a.replace(re,'#')===b.replace(re,'#'))return t=>{let i=0;return b.replace(re,()=>String(+A[i]+(+B[i]-A[i++])*t));};
 return null;
}
export function createMotion(stage){
 let raf=0,resolve=null;
 const cancel=()=>{cancelAnimationFrame(raf);raf=0;if(resolve){resolve(false);resolve=null;}};
 function update(markup,duration=0){
  cancel();const target=new DOMParser().parseFromString(markup,'image/svg+xml').documentElement, tweens=[];
  function sync(old,next){
   for(const attr of [...old.attributes])if(!next.hasAttribute(attr.name))old.removeAttribute(attr.name);
   for(const attr of [...next.attributes]){const before=old.getAttribute(attr.name),after=attr.value,fn=before!==null?interpolate(before,after):null;
    if(duration&&before!==after&&fn){tweens.push(t=>old.setAttribute(attr.name,fn(t)));}else old.setAttribute(attr.name,after);
   }
   if(!next.children.length){old.textContent=next.textContent;return;}
   const children=[...old.children],used=new Set();
   for(const nc of [...next.children]){
    // 文言の違うtextは別の要素として出し直す。書き換えた文字を別位置へ補間すると、無関係な文字が飛んで見える。
    const key=nc.getAttribute('data-key'),sameText=c=>c.tagName!=='text'||c.textContent===nc.textContent;let oc=children.find(c=>!used.has(c)&&c.tagName===nc.tagName&&(key?c.getAttribute('data-key')===key:!c.hasAttribute('data-key'))&&sameText(c));
    if(oc){used.add(oc);sync(oc,nc);}
    else{oc=nc.cloneNode(true);old.append(oc);if(duration&&nc.getAttribute('data-no-fade')!=='true'){const opacity=nc.getAttribute('opacity')??'1';oc.setAttribute('opacity','0');tweens.push(t=>oc.setAttribute('opacity',String(t*+opacity)));
      for(const ln of [oc,...oc.querySelectorAll('line')].filter(e=>e.tagName==='line')){const x=+ln.getAttribute('x1'),y=+ln.getAttribute('y1'),X=+ln.getAttribute('x2'),Y=+ln.getAttribute('y2');tweens.push(t=>{ln.setAttribute('x2',x+(X-x)*t);ln.setAttribute('y2',y+(Y-y)*t);});}
    }}old.append(oc);
   }
   children.filter(c=>!used.has(c)).forEach(c=>c.remove());
  }
  if(!stage.firstElementChild){stage.append(document.importNode(target,true));return Promise.resolve(true);}
  sync(stage.firstElementChild,target);
  if(!duration||!tweens.length)return Promise.resolve(true);
  tweens.forEach(f=>f(0));stage.dataset.moving='true';const start=performance.now();
  return new Promise(done=>{resolve=done;function tick(now){const t=Math.min(1,(now-start)/duration),e=t*t*(3-2*t);tweens.forEach(f=>f(e));if(t<1)raf=requestAnimationFrame(tick);else{raf=0;resolve=null;stage.dataset.moving='false';done(true);}}raf=requestAnimationFrame(tick);});
 }
 return {update,cancel(){cancel();stage.dataset.moving='false';}};
}
