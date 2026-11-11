import {svg,text,line,C,keyed} from '../_lib/draw.mjs';
import {P,W,H,edge,cities,at} from '../_lib/tsp-method-map.mjs';
import {nearestNeighbor,optimalTour,tourLength,edgesOf,edgeKey,anneal} from '../_lib/tsp-methods.mjs';
// 固定した5都市・乱数で、小幅な悪化の受け入れと、その先の1回の改善を示す。
export const initial=nearestNeighbor(P,0).route;
export const initialLength=tourLength(P,initial);
const T0=.1,alpha=.9;
export const trials=anneal(P,initial,{seed:25562,T0,alpha,trials:2});
export const optimal=optimalTour(P,0);
export const worsen={...trials[0],i:1},improve={...trials[1],i:2};
export const probability=t=>Math.exp(-Math.max(0,t.delta)/(T0*alpha**(t.i-1)));
const f2=v=>v.toFixed(2);
const routeAt=t=>t?trials[t-1].route:initial,lengthAt=t=>t?trials[t-1].length:initialLength;
const steps=['最近傍法の経路を初期解にする','悪化する候補を確率的に受け入れる','短くなる候補を採用する'];
export const states=steps.map((_,trial)=>({trial}));
const candidateKey=(t,a,b)=>`proposal-${t}-${edgeKey(a,b)}`;
// 同じ辺の端点順を揃える。巡回順が逆向きになっても線の端点を入れ替えて補間しない。
const stableEdge=(a,b,opts)=>edge(Math.min(a,b),Math.max(a,b),opts);
function adoptedKey(t,a,b){
 const key=edgeKey(a,b);let origin=0;
 for(let i=1;i<=t;i++)if(trials[i-1].accepted&&trials[i-1].added.some(e=>edgeKey(...e)===key))origin=i;
 return origin?candidateKey(origin,a,b):`route-${key}`;
}
const gx0=530,gx1=870,gy0=70,gy1=300,ymin=2,ymax=3.15;
const gx=t=>+(gx0+t/trials.length*(gx1-gx0)).toFixed(1),gy=L=>+(gy1-(L-ymin)/(ymax-ymin)*(gy1-gy0)).toFixed(1);
// upto：確定した試行数。proposal：候補の点だけを出す試行。
function chart(upto,proposal=null){
 let s=keyed('axes',line(gx0,gy0-10,gx0,gy1,C.muted,false,1.5)+line(gx0,gy1,gx1+10,gy1,C.muted,false,1.5)+text(gx0-14,gy0-18,'経路長',22,C.muted)+text(gx1+10,gy1+60,'試行回数',22,C.muted,'end')
  +[2,2.5,3].map(v=>text(gx0-10,gy(v)+7,v.toFixed(1),22,C.muted,'end')).join('')+trials.map((_,t)=>t+1).concat(0).map(t=>text(gx(t),gy1+28,t,22,C.muted,'middle')).join(''));
 s+=keyed('dot-0',`<circle cx="${gx(0)}" cy="${gy(initialLength)}" r="7" fill="${C.accent}"/>`);
 trials.forEach((tr,j)=>{const t=j+1;if(t>Math.max(upto,proposal??0))return;
  const decided=t<=upto,color=tr.delta>0?C.A:C.accent,[x0,y0,x,y]=[gx(t-1),gy(lengthAt(t-1)),gx(t),gy(lengthAt(t))];
  // 推移の線は前の点から伸ばし、候補の点は確定時に塗る。
  s+=keyed(`seg-${t}`,line(x0,y0,decided?x:x0,decided?y:y0,C.ink,false,2.5),`opacity="${decided?1:0}"`);
  s+=keyed(`candidate-dot-${t}`,`<circle cx="${x}" cy="${y}" r="7" fill="${decided?color:C.paper}" stroke="${color}" stroke-width="2"/>`);
 });
 return s;
}
function note(key,head,body,color,detail=''){
 return keyed(key,text(470,410,head,26,C.muted)+text(470,458,body,32,color)+(detail?text(470,504,detail,24,C.muted):''));
}
// phase：cut（切る2辺を薄くする）→ candidate（新しい2辺を点線で引く）→ decide（採用を反映する）。cut・candidateは遷移中のコマだけに使う。
function scene(t,phase='decide'){
 if(!t)return svg(edgesOf(initial).map(([a,b])=>stableEdge(a,b,{key:adoptedKey(0,a,b)})).join('')+cities()+chart(0)+note('initial','初期解（最近傍法）',`経路長 ${f2(initialLength)}`,C.B),'最近傍法の経路を初期解にする',W,H);
 const tr={...trials[t-1],i:t},decided=phase==='decide',before=t-1;
 const removed=new Set(tr.removed.map(e=>edgeKey(...e)));
 let s='';
 edgesOf(routeAt(before)).forEach(([a,b])=>s+=stableEdge(a,b,{key:adoptedKey(before,a,b),opacity:removed.has(edgeKey(a,b))?(decided?0:.18):1}));
 tr.added.forEach(([a,b])=>{
  const [lo,hi]=a<b?[a,b]:[b,a],[x,y]=at(P[lo]),[X,Y]=at(P[hi]),drawn=phase!=='cut';
  // 追加辺は候補から採用後まで同じ要素・同じ端点。採用時には線種と色だけを変える。
  s+=keyed(candidateKey(t,a,b),line(x,y,drawn?X:x,drawn?Y:y,decided?C.accent:tr.delta>0?C.A:C.accent,!decided,6),`opacity="${drawn?1:0}"`);
 });
 s+=cities()+chart(decided?t:before,phase==='candidate'?t:null);
 if(decided){
  const rate=100*tr.delta/lengthAt(before),change=`${rate>0?'+':'−'}${Math.abs(rate).toFixed(1)}%`,body=`${f2(lengthAt(before))} → ${f2(lengthAt(t))}（${change}）`;
  s+=tr.delta>0?note(`decision-${t}`,'悪化する候補を確率的に受け入れ',body,C.A,`受け入れ確率 ${(probability(tr)*100).toFixed(1)}%`)
   :note(`decision-${t}`,'短くなる候補を採用',body,C.accent);
 }
 return svg(s,'2辺をつなぎ替えた候補を作り、経路長に応じて採用する',W,H);
}
export default {id:'F23',title:'2-optによる焼きなまし法',steps,renderStep:k=>scene(k),
 // 1回の試行を、切る辺を薄くする→新しい辺を引く→採用を反映する、の連続した動きで見せる。
 transition(from,to){return to===from+1&&to>0?[{markup:scene(to,'cut'),duration:300},{markup:scene(to,'candidate'),duration:500},{markup:scene(to),duration:450,hold:400}]:null;}};
