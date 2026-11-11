// F21〜F24共通。TSPの解き方（厳密解・最近傍法・2-optによる焼きなまし法）を座標から計算する。
// 経路は都市番号の列で、先頭と末尾を出発都市にする。座標は0〜1の[x, y]。
export const dist=(P,a,b)=>Math.hypot(P[a][0]-P[b][0],P[a][1]-P[b][1]);
export const tourLength=(P,r)=>r.slice(1).reduce((s,c,i)=>s+dist(P,r[i],c),0);
export const edgesOf=r=>r.slice(1).map((c,i)=>[r[i],c]);
export const edgeKey=(a,b)=>a<b?`${a}-${b}`:`${b}-${a}`;
export function rng(seed){let s=seed;return()=>(s=s*16807%2147483647)/2147483647;}

const perms=a=>a.length<=1?[a]:a.flatMap((x,i)=>perms([...a.slice(0,i),...a.slice(i+1)]).map(p=>[x,...p]));
// 全列挙による最適巡回路。向きは2番目の都市番号が小さいほうに揃える。
export function optimalTour(P,start=0){
 const rest=[...P.keys()].filter(i=>i!==start);let best=null;
 for(const p of perms(rest)){if(p[0]>p.at(-1))continue;const r=[start,...p,start],l=tourLength(P,r);if(!best||l<best.length-1e-12)best={route:r,length:l};}
 return best;}

// 最近傍法。各段階の候補（未訪問の都市までの距離）を残す。
export function nearestNeighbor(P,start=0){
 const route=[start],choices=[];
 while(route.length<P.length){const from=route.at(-1),candidates=[...P.keys()].filter(j=>!route.includes(j)).map(to=>({to,d:dist(P,from,to)})).sort((a,b)=>a.d-b.d);
  choices.push({from,candidates,to:candidates[0].to});route.push(candidates[0].to);}
 return {route:[...route,start],choices};}

export function segmentsCross(p,q,r,s){const o=(a,b,c)=>Math.sign((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]));return o(p,q,r)*o(p,q,s)<0&&o(r,s,p)*o(r,s,q)<0;}
// 2-opt：r[i..j]を逆順にし、辺(r[i-1],r[i])と(r[j],r[j+1])を(r[i-1],r[j])と(r[i],r[j+1])へつなぎ替える。
export const twoOpt=(r,i,j)=>[...r.slice(0,i),...r.slice(i,j+1).reverse(),...r.slice(j+1)];
export function twoOptMoves(n){const m=[];for(let i=1;i<n-1;i++)for(let j=i+1;j<n;j++)if(!(i===1&&j===n-1))m.push([i,j]);return m;}

// 2-opt近傍の焼きなまし法。毎回ランダムに1つのつなぎ替えを試し、短くなれば採用、長くなれば確率exp(−Δ/T)で採用する。
export function anneal(P,initial,{seed,T0,alpha,trials}){
 const r0=rng(seed),moves=twoOptMoves(P.length);let route=initial,T=T0;const log=[];
 for(let t=0;t<trials;t++){const [i,j]=moves[Math.floor(r0()*moves.length)],next=twoOpt(route,i,j),delta=tourLength(P,next)-tourLength(P,route),u=r0(),accepted=delta<=1e-12||u<Math.exp(-delta/T);
  log.push({removed:[[route[i-1],route[i]],[route[j],route[j+1]]],added:[[route[i-1],route[j]],[route[i],route[j+1]]],delta,accepted,route:accepted?next:route,length:tourLength(P,accepted?next:route)});
  if(accepted)route=next;T*=alpha;}
 return log;}

// 分枝限定法の下限（F21）。fixは{'a-b':1（使う）|0（使わない）}。各都市で、使うと決めた辺と、残りの辺のうち短いものから
// 2本を選び、その長さの合計を2で割る。巡回路では各都市にちょうど2本の辺がつながるので、どの巡回路の長さもこの値以上になる。
export function degreeBound(P,fix={}){
 const n=P.length,picked=[];let sum=0;
 for(let i=0;i<n;i++){const inc=[...P.keys()].filter(j=>j!==i).map(j=>({k:edgeKey(i,j),d:dist(P,i,j)})),forced=inc.filter(e=>fix[e.k]===1),free=inc.filter(e=>fix[e.k]===undefined).sort((a,b)=>a.d-b.d),two=[...forced,...free].slice(0,2);
  if(forced.length>2||two.length<2)return {bound:Infinity,tour:null};
  two.forEach(e=>{sum+=e.d;picked.push(e.k);});}
 // 選んだ辺が両端の都市で一致し、n本で1つの閉路になれば、下限を与えた辺の組そのものが巡回路（下限＝経路長）。
 const count={};picked.forEach(k=>count[k]=(count[k]??0)+1);const keys=Object.keys(count);let tour=null;
 if(keys.length===n&&keys.every(k=>count[k]===2)){const adj=Array.from({length:n},()=>[]);keys.forEach(k=>{const [a,b]=k.split('-').map(Number);adj[a].push(b);adj[b].push(a);});
  const r=[0];let prev=-1,c=0;for(;;){const next=adj[c].find(x=>x!==prev);if(next===0||r.length>n)break;r.push(next);prev=c;c=next;}
  if(r.length===n)tour=[...r,0];}
 return {bound:sum/2,tour};}
