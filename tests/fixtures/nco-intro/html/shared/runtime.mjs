import {createMotion} from './motion.mjs';
const protocol={channel:'slide-animation',version:1};
export function mount(fig){
 const embedded=window.parent!==window,origin=new URL(document.baseURI).protocol==='file:'?'null':new URL(document.baseURI).origin,targetOrigin=origin==='null'?'*':origin,stage=document.querySelector('#stage');
 let holdTimer,lastStepInput=-Infinity;
 const cancelHold=()=>{clearTimeout(holdTimer);holdTimer=null;};
 let step=0,visible=!embedded,pointer=null,generation=0,transitioning=false;
 const motion=createMotion(stage);document.title=fig.title;const h=document.querySelector('h1');if(h)h.textContent=fig.title;
 const post=(type,data={})=>parent.postMessage({...protocol,type,figureId:fig.id,...data},targetOrigin);
 const stop=()=>{generation++;transitioning=false;motion.cancel();fig.stop?.();};
 async function render(k,animate=true){
  if(!Number.isInteger(k)||k<0||k>=fig.steps.length)return;
  const from=step,interrupted=transitioning;stop();const ticket=generation;step=k;stage.dataset.step=k;
  const duration=animate&&!interrupted&&visible&&!document.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches?650:0;
  const frames=duration&&fig.transition?fig.transition(from,k):null;
  transitioning=duration>0;
  if(frames?.length){for(const f of frames){if(ticket!==generation)return;if(f.hold){await new Promise(r=>setTimeout(r,f.hold));if(ticket!==generation)return;}await motion.update(f.markup,f.duration??duration);}}
  else await motion.update(fig.renderStep(k),duration);
  if(ticket===generation)transitioning=false;
 }
 function action(a){if(document.hidden)return;if(embedded){if(visible)post('navigate',{direction:a});return;}const now=performance.now(),isStep=a==='next'||a==='prev',instant=isStep&&now-lastStepInput<=300;lastStepInput=isStep?now:-Infinity;if(a==='page-next'||a==='page-prev')return;if(a==='last'||a==='first'){render(a==='last'?fig.steps.length-1:0,false);return;}render(Math.max(0,Math.min(fig.steps.length-1,step+(a==='next'?1:-1))),!instant);}
 const interactive=t=>t.closest('a,button,input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="button"]');
 document.addEventListener('keydown',e=>{
  if(!embedded||e.key.toLowerCase()!=='f'||interactive(e.target)||e.altKey||e.ctrlKey||e.metaKey)return;
  e.preventDefault();e.stopPropagation();
  if(!e.repeat&&visible&&!document.hidden)post('toggle-fullscreen');
 });
 document.addEventListener('keydown',e=>{const keys={ArrowLeft:'prev',ArrowRight:'next',ArrowUp:'page-prev',ArrowDown:'page-next'};if(interactive(e.target)||!keys[e.key]||e.altKey||e.ctrlKey||e.metaKey)return;e.preventDefault();e.stopPropagation();if(!e.repeat){cancelHold();action(keys[e.key]);if(e.key==='ArrowRight'||e.key==='ArrowLeft')holdTimer=setTimeout(()=>action(e.key==='ArrowRight'?'last':'first'),500);}});
 document.addEventListener('keyup',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft')cancelHold();});
 window.addEventListener('blur',cancelHold);
 document.addEventListener('pointerdown',e=>{pointer=e.button===0&&!interactive(e.target)?{x:e.clientX,y:e.clientY,dragged:false}:null;});
 document.addEventListener('pointermove',e=>{if(pointer&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>5)pointer.dragged=true;});
 document.addEventListener('pointercancel',()=>{pointer=null;});
 document.addEventListener('click',e=>{const start=pointer;pointer=null;if(e.button!==0||interactive(e.target)||getSelection().toString()||!start||start.dragged||Math.hypot(e.clientX-start.x,e.clientY-start.y)>5)return;action('next');});
 window.addEventListener('message',e=>{const d=e.data;if(!embedded||e.origin!==origin||e.source!==parent||!d||d.channel!==protocol.channel||d.version!==1||d.figureId!==fig.id)return;
  if(d.type==='probe'){post('ready',{stepCount:fig.steps.length,steps:fig.steps});return;}
  if(d.type!=='set-state'||typeof d.visible!=='boolean'||!Number.isInteger(d.step)||d.step<0||d.step>=fig.steps.length)return;
  const was=visible;visible=d.visible;if(!visible){cancelHold();stop();render(d.step,false);}else if(d.step!==step||!was||d.reset)render(d.step,was&&!d.reset);
 });
 document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelHold();stop();motion.update(fig.renderStep(step),0);}});window.addEventListener('pagehide',stop);
 // Adapter: keep the original renderer, transitions and 650ms interpolation.
 window.animation={steps:fig.steps.length-1,step:0,settled:Promise.resolve(),
  setVisible(value){if(visible===value)return;visible=value;if(!value){stop();this.settled=render(step,false);}},
  setStep(k,animate=false){k=Math.max(0,Math.min(this.steps,k));this.step=k;this.settled=render(k,animate);return this.settled;}
 };
 if(embedded)document.body.classList.add('embedded');render(0,false);if(embedded)post('ready',{stepCount:fig.steps.length,steps:fig.steps});
}
