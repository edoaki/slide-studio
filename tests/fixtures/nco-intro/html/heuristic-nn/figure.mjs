import {svg,text,C,keyed} from '../_lib/draw.mjs';
import {P,W,H,label,edge,cities} from '../_lib/tsp-method-map.mjs';
import {nearestNeighbor,optimalTour,tourLength,edgesOf,edgeKey} from '../_lib/tsp-methods.mjs';
// 最近傍法（3枚目と同じ5都市）。経路・距離・最適との差はすべて座標から計算する。
export const nn=nearestNeighbor(P,0);
export const nnLength=tourLength(P,nn.route);
export const optimal=optimalTour(P,0);
const optKeys=new Set(edgesOf(optimal.route).map(e=>edgeKey(...e)));
// 比較段階で強調する、最適経路に含まれない最近傍法の辺。
export const offEdges=edgesOf(nn.route).filter(e=>!optKeys.has(edgeKey(...e)));
const steps=['出発都市','最も近い都市へ進む','残りの都市へ順に進み出発都市へ戻る','最適経路と比べる'];
const R=nn.route,n=P.length,f2=v=>v.toFixed(2),bx=560,bs=340,muted='#c3ccd4';

// moves：引いた経路の辺の数。decision：距離を表示する判断（choices の番号）。picked：最も近い都市を強調するか。
function scene({moves=0,decision=null,picked=true,candOpacity=1,compare=false}={}){
 let s='';
 if(compare)edgesOf(optimal.route).forEach(([a,b])=>s+=edge(a,b,{key:`opt-${edgeKey(a,b)}`,color:C.muted,width:4,dash:true}));
 const ch=decision===null?null:nn.choices[decision];
 if(ch)ch.candidates.forEach(({to},j)=>s+=edge(ch.from,to,{key:`cand-${ch.from}-${to}`,color:picked&&j===0?C.accent:C.muted,width:picked&&j===0?4:3,dash:true,opacity:candOpacity,shorten:28}));
 const off=new Set(offEdges.map(e=>edgeKey(...e)));
 edgesOf(R).slice(0,moves).forEach(([a,b])=>s+=edge(a,b,{key:`route-${edgeKey(a,b)}`,color:compare&&off.has(edgeKey(a,b))?C.A:C.accent}));
 const visited=new Set(R.slice(0,moves+1)),current=moves<n?R[moves]:null;
 s+=cities({stroke:i=>visited.has(i)?C.accent:C.ink,fill:i=>i===current?C.accent:C.paper});
 // 訪問順
 s+=keyed('order-head',text(470,62,'訪問順',22,C.muted));
 R.slice(0,moves+1).forEach((c,j)=>{const x=490+j*76;
  if(j)s+=keyed(`order-arrow-${j}`,text(x-38,117,'→',26,C.muted,'middle'));
  s+=keyed(`order-${j}`,`<circle cx="${x}" cy="108" r="21" fill="${C.paper}" stroke="${C.accent}" stroke-width="3"/>`+text(x,116,label(c),23,C.ink,'middle'));});
 // 今いる都市から未訪問の都市までの距離
 if(ch){s+=keyed(`dist-head-${ch.from}`,text(470,200,`都市${label(ch.from)}から`,23,C.muted),`opacity="${candOpacity}"`);
  ch.candidates.forEach(({to,d},j)=>{const y=232+j*54,hi=picked&&j===0;
   s+=keyed(`dist-${ch.from}-${to}`,text(500,y+27,`→ ${label(to)}`,24,hi?C.accent:C.ink,'end')+`<rect x="${bx}" y="${y+5}" width="${(d*bs).toFixed(1)}" height="30" rx="3" fill="${hi?C.accent:muted}"/>`+text(bx+d*bs+10,y+29,f2(d),23,hi?C.accent:C.ink),`opacity="${candOpacity}"`);});}
 if(moves===n&&!compare)s+=keyed('length',text(470,250,`経路長 ${f2(nnLength)}`,32,C.ink));
 if(compare){const row=(y,body,label)=>body+text(560,y+9,label,25,C.ink);
  s+=keyed('legend-nn',row(220,`<line x1="470" y1="220" x2="540" y2="220" stroke="${C.accent}" stroke-width="6" stroke-linecap="round"/>`,`最近傍法 ${f2(nnLength)}`));
  s+=keyed('legend-opt',row(280,`<line x1="470" y1="280" x2="540" y2="280" stroke="${C.muted}" stroke-width="4" stroke-dasharray="10 9"/>`,`最適 ${f2(optimal.length)}`));
  s+=keyed('legend-off',row(340,`<line x1="470" y1="340" x2="540" y2="340" stroke="${C.A}" stroke-width="6" stroke-linecap="round"/>`,'最適経路と異なる辺'));}
 return svg(s,'最近傍法で今いる都市から最も近い未訪問の都市へ順に進み、最適経路と比べる',W,H);}

const state=k=>[{},{moves:1,decision:0},{moves:n},{moves:n,compare:true}][k];
// 1つの判断：候補までの距離を出す → 選択の強調と経路の描画を同じフレームで開始。
const decide=(i,fast=1)=>[{markup:scene({moves:i,decision:i,picked:false}),duration:600*fast},{markup:scene({moves:i+1,decision:i}),duration:600*fast,hold:250*fast}];
export default {id:'F22',title:'最近傍法',steps,
 renderStep(k){return scene(state(k));},
 transition(from,to){if(to!==from+1)return null;
  if(to===1)return decide(0);
  if(to===2){const fr=[{markup:scene({moves:1,decision:0,candOpacity:0}),duration:300}];for(let i=1;i<n-1;i++)fr.push(...decide(i,.75),{markup:scene({moves:i+1,decision:i,candOpacity:0}),duration:250});return [...fr,{markup:scene(state(2)),duration:650}];}
  return null;}};
