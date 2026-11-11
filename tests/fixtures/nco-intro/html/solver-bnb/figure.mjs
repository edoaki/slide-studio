import {svg,text,line,C,keyed} from '../_lib/draw.mjs';
import {tourLength,edgesOf,edgeKey} from '../_lib/tsp-methods.mjs';
// 4都市の無向完全グラフ。座標と表示を同じ縮尺にし、全経路長を座標から計算する。
// この例は分枝と実行不可能性による打切りを示す。下界による枝刈りは発生しない。
// 一般のTSPには部分巡回路除去も必要: https://www.scipopt.org/doc/html/TSP_MAIN.php
export const P=[[0,0],[0,3],[4,0],[3,2.5]];
export const routes=[[0,3,1,2,0],[0,3,2,1,0],[0,1,3,2,0]];
export const lengths=routes.map(r=>tourLength(P,r));
const at=i=>[55+P[i][0]*78,365-P[i][1]*78];
const f=v=>v.toFixed(2),sub=s=>String(s).replace(/\d/g,d=>'₀₁₂₃₄₅₆₇₈₉'[d]);
const xn=(a,b)=>`x${sub(a+1)}${sub(b+1)}`;
const E=[];for(let a=0;a<4;a++)for(let b=a+1;b<4;b++)E.push([a,b]);
// 二分木。x14=x24=1の後もx12の両側を示し、不可または巡回路完成まで探索する。
// 次数制約から補う辺も、距離の表示より先に地図へ描く。
export const nodes=[
 {id:'r',p:null,xy:[665,50],show:1},
 {id:'a',p:'r',xy:[555,155],show:2,edge:[0,3],value:1},
 {id:'b',p:'r',xy:[835,155],show:11,edge:[0,3],value:0},
 {id:'aa',p:'a',xy:[490,265],show:3,edge:[1,3],value:1},
 {id:'aaa',p:'aa',xy:[440,380],show:4,edge:[0,1],value:1,bad:true,labelOffset:-25},
 {id:'aab',p:'aa',xy:[540,380],show:5,edge:[0,1],value:0,route:0,solved:6,labelOffset:25},
 {id:'ab',p:'a',xy:[690,265],show:7,edge:[1,3],value:0},
 {id:'aba',p:'ab',xy:[640,380],show:8,edge:[2,3],value:1,route:1,solved:9,labelOffset:-25},
 {id:'abb',p:'ab',xy:[740,380],show:10,edge:[2,3],value:0,bad:true,labelOffset:25},
 {id:'ba',p:'b',xy:[795,265],show:12,edge:[1,3],value:1,route:2,solved:14,labelOffset:-25},
 {id:'bb',p:'b',xy:[885,265],show:15,edge:[1,3],value:0,bad:true,labelOffset:25}
];
// 各イベントの地図。使う辺、使わない辺、確定した経路を別々に管理する。
const events=[
 {},{},
 {yes:[[0,3]]},
 {yes:[[0,3],[1,3]]},
 {yes:[[0,3],[1,3],[0,1]],no:[[0,2],[1,2],[2,3]],isolated:2},
 {yes:[[0,3],[1,3]],no:[[0,1],[2,3]]},
 {route:0,no:[[0,1],[2,3]]},
 {yes:[[0,3]],no:[[1,3]]},
 {yes:[[0,3],[2,3]],no:[[1,3]]},
 {route:1,no:[[1,3],[0,2]]},
 {yes:[[0,3]],no:[[1,3],[2,3]]},
 {no:[[0,3]]},
 {yes:[[1,3]],no:[[0,3]]},
 {yes:[[1,3],[2,3]],no:[[0,3]]},
 {route:2,no:[[0,3],[1,2]]},
 {no:[[0,3],[1,3]]},
 {route:2}
];
const finalEvent=events.length-1;
const selected=t=>events[t]?.route===undefined?(events[t]?.yes??[]):edgesOf(routes[events[t].route]);
const setOf=es=>new Set(es.map(e=>edgeKey(...e)));
function formula(){
 let s=text(435,60,'変数',22,C.muted)+text(520,60,'xᵢⱼ ∈ {0, 1}   (i < j)',27)+text(520,96,'辺 i–j を使えば 1',22,C.muted);
 s+=text(435,160,'制約',22,C.muted);
 for(let i=0;i<4;i++)s+=text(520,160+43*i,E.filter(e=>e.includes(i)).map(e=>xn(...e)).join(' + ')+' = 2',26,C.B);
 s+=text(520,338,'各都市につながる辺は2本',22,C.muted);
 s+=text(435,417,'目的',22,C.muted)+text(520,417,'min',30);
 s+='<text x="590" y="422" font-size="48" fill="'+C.ink+'">∑</text>'+text(606,451,'1 ≤ i < j ≤ 4',17,C.ink,'middle');
 s+='<text x="649" y="417" font-size="32" fill="'+C.ink+'" font-style="italic">d<tspan baseline-shift="sub" font-size="21">ij</tspan><tspan baseline-shift="baseline"> x</tspan><tspan baseline-shift="sub" font-size="21">ij</tspan></text>';
 s+=text(520,495,'dᵢⱼ：都市 i–j 間の距離',22,C.muted);return s;
}
// prepare → grow → done。木と地図の伸長には同一の進捗を渡す。
// 木の四角はgrowが終わるまで出さず、経路長は補完辺まで描き終えてから出す。
export function scene(t,{phase='done'}={}){
 const g=phase==='prepare'?0:1,done=phase==='done',ev=events[t],ri=done?ev.route:undefined;
 const keys=setOf(selected(t)),prior=setOf(selected(t-1));
 let s='';
 E.forEach(([a,b])=>{const [x,y]=at(a),[X,Y]=at(b),key=edgeKey(a,b);
 s+=keyed(`candidate-${a}-${b}`,line(x,y,X,Y,'#b5c0ca',true,2));
 if(keys.has(key)){const progress=prior.has(key)?1:g;
 s+=keyed(`selected-edge-${a}-${b}`,line(x,y,x+(X-x)*progress,y+(Y-y)*progress,t===finalEvent?C.accent:C.B,false,6));}
 });
 // ×は非選択の辺の中点に置く。赤い辺そのものは地図に描かない。
 const priorNo=setOf(events[t-1]?.no??[]);
 for(const [a,b] of ev.no??[]){const [x,y]=at(a),[X,Y]=at(b),mx=(x+X)/2,my=(y+Y)/2;
 const opacity=priorNo.has(edgeKey(a,b))?1:g;
 s+=keyed(`excluded-edge-${a}-${b}`,`<circle cx="${mx}" cy="${my}" r="17" fill="white"/>`+text(mx,my+11,'×',36,C.A,'middle'),`opacity="${opacity}"`);}
 P.forEach((_,i)=>{const [x,y]=at(i);s+=keyed(`city-${i}`,`<circle cx="${x}" cy="${y}" r="24" fill="white" stroke="${ev.isolated===i?C.A:C.ink}" stroke-width="3"/>`+text(x,y+9,i+1,27,C.ink,'middle'));});
 if(t===0)s+=formula();
 else{
 nodes.filter(n=>n.show<=t).forEach(n=>{const [x,y]=n.xy,isNew=n.show===t;
 if(n.p){const p=nodes.find(p=>p.id===n.p),[X,Y]=p.xy,progress=isNew?g:1,color=n.value?C.B:C.A;
 s+=keyed(`tree-edge-${n.id}`,line(X,Y+20,X+(x-X)*progress,Y+20+(y-20-Y-20)*progress,color,false,3));
 const lx=(X+x)/2+(n.labelOffset??0),ly=(Y+y)/2;
 s+=keyed(`tree-label-${n.id}`,`<rect x="${lx-47}" y="${ly-13}" width="94" height="25" fill="white"/>`+text(lx,ly+6,`${xn(...n.edge)} = ${n.value}`,19,color,'middle'),`opacity="${isNew?g:1}"`);}
 const resolved=n.route!==undefined&&(t>n.solved||(t===n.solved&&done)),best=t===finalEvent&&n.route===2;
 const explored=(t===finalEvent||(t>=6&&n.id==='aa')||(t>=10&&(n.id==='a'||n.id==='ab')));
 const content=n.bad?'不可':resolved?f(lengths[n.route]):explored?'探索済':'未確定';
 const opacity=isNew&&!done?0:1;
 s+=keyed(`tree-node-${n.id}`,`<rect x="${x-40}" y="${y-20}" width="80" height="40" rx="6" fill="${best?C.accent:n.bad?C.light:C.paper}" stroke="${best?C.accent:C.ink}" stroke-width="2"/>`,`opacity="${opacity}"`);
 s+=keyed(`tree-value-${n.id}-${content}`,text(x,y+7,content,22,best?C.paper:n.bad?C.muted:C.ink,'middle'),`opacity="${opacity}"`);
 });
 if(done&&ev.isolated!==undefined)s+=keyed('isolated-city-note',text(45,430,'都市3に接続できない',25,C.A));
 if(ri!==undefined){s+=keyed(`route-label-${ri}`,text(45,430,routes[ri].map(i=>i+1).join(' → '),24,C.B));
 s+=keyed(`length-${ri}-${t===finalEvent}`,text(45,476,`${t===finalEvent?'最短経路長':'経路長'} ${f(lengths[ri])}`,29,t===finalEvent?C.accent:C.ink));}
 const solved=nodes.filter(n=>n.route!==undefined&&(t>n.solved||(t===n.solved&&done)));
 if(solved.length){const best=Math.min(...solved.map(n=>lengths[n.route]));s+=keyed(`best-${best}`,text(435,515,`現在の最良値  ${f(best)}`,26,C.accent));}
 }
 return svg(s,'4都市の辺を選択し、確定した3本の巡回路の実距離を比較する',930,560);
}
const states=[0,1,2,3,4,6,9,16];
export default {id:'F21',title:'分枝によるTSPの探索',steps:['変数・制約・目的関数','未確定の根','辺1–4を選択','辺2–4を選択','辺1–2を選択すると都市3に接続できない','辺1–2を除外し、巡回路を完成','辺2–4を除外し、辺3–4を選択','辺1–4を使わない枝を探索して最短を確定'],
 renderStep(k){return scene(states[k]);},
 transition(from,to){if(to!==from+1)return null;
 const frames=[];
 for(let t=states[from]+1;t<=states[to];t++){
  if(t===1){frames.push({markup:scene(t),duration:450});continue;}
  frames.push({markup:scene(t,{phase:'prepare'}),duration:250,hold:250},
   {markup:scene(t,{phase:'grow'}),duration:850},
   {markup:scene(t),duration:250});
 }
 return frames;}};
