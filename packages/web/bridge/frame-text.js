import { installTextEditing } from './frame-text-engine.js';
export function createFrameText(win, doc, {getSourceVersion,sendEvent}) {
  let lease=null,sequence=0,cells=null,key=null;
  const state=()=>{const el=engine.active();if(!el)return null;const r=el.getBoundingClientRect(),cs=win.getComputedStyle(el),root=win.getComputedStyle(doc.documentElement);return {format:engine.editor.formatState(),align:cs.textAlign,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},colors:Object.fromEntries(['--ink','--accent','--good','--warn','--mark'].map(k=>[k,root.getPropertyValue(k).trim()])),html:el.outerHTML};};
  const emit=(kind,html=null,extra={})=>{if(lease)sendEvent('text.state',{lease,sourceVersion:getSourceVersion(),sequence:++sequence,kind,html,state:state(),...extra});};
  const engine=installTextEditing({
    colorClasses:['accent','good','warn','highlight'],
    input:html=>emit('input',html),selection:()=>emit('selection'),link:()=>emit('link'),
    finished:(html,options={})=>emit('finished',html,{created:!!options.created}),
    keydown:()=>false,select:()=>{},edit:()=>{},
    cell:at=>{const info=cells?.[at.r]?.[at.c];if(!info?.direct)return null;emit('cell',null,{cell:at});return info.html;},
  });
  doc.addEventListener('click', event => {
    if (!event.isTrusted || engine.active() || !event.target.closest('.slide.active > h1,.slide.active > h2') || event.target.closest('[data-slide-studio]')) return;
    event.preventDefault();sendEvent('text.heading',{trusted:true,sourceVersion:getSourceVersion(),point:{x:event.clientX,y:event.clientY}});
  },true);
  return {
    begin(p){if(p.sourceVersion!==getSourceVersion())throw Error('stale-source');if(engine.active())throw Error('already-editing');lease=p.lease;key=p.key;cells=p.cells;sequence=0;if(p.create)engine.editor.create(key,p.create);else if(p.heading)engine.editor.startHeading(p.point);else engine.editor.start(key,p.html,{plain:p.plain,cell:p.cell,point:p.point});emit('selection');return state();},
    cellAt(p){return engine.editor.cellAt(p.key,p.point);},
    async command(p){if(!lease||p.lease!==lease)throw Error('stale-lease');const edit=engine.editor;
      switch(p.action){case 'finish':await edit.finish();break;case 'focus':edit.focus();break;case 'bold':case 'italic':edit.command(p.action);break;case 'color':edit.color(p.value);break;case 'size':edit.size(p.value);break;case 'stepSize':edit.stepSize(p.value);break;case 'clearFormat':edit.clearFormat();break;case 'linkState':return edit.linkState();case 'setLink':edit.setLink(p.value,p.text);break;case 'align':{const el=engine.active();if(el){el.style.textAlign=p.value;emit('input',el.outerHTML);}break;}}
      return state();
    },
  };
}
