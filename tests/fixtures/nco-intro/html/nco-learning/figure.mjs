import {svg,text,line,C,keyed} from '../_lib/draw.mjs';
import {tspCases} from '../_lib/tsp-cities.mjs';
import {rng,dist,tourLength,optimalTour,edgesOf} from '../_lib/tsp-methods.mjs';
// NCOの学習と推論。問題・経路は固定した乱数で作る説明用の例で、学習済みモデルの出力ではない。
// 学習の経路は距離の近い都市ほど選ばれやすい確率で作り、推論の経路は全列挙した最適経路を描く。
const n=5,city=r=>[...Array(n)].map(()=>[+(.1+.8*r()).toFixed(2),+(.1+.8*r()).toFixed(2)]);
function sample(P,r,tau=.15){const route=[0];while(route.length<n){const c=route.at(-1),cand=[...Array(n).keys()].filter(j=>!route.includes(j)),w=cand.map(j=>Math.exp(-dist(P,c,j)/tau));let u=r()*w.reduce((a,b)=>a+b),k=0;while(k<cand.length-1&&u>w[k])u-=w[k++];route.push(cand[k]);}return [...route,0];}
// 学習の問題は、小さな地図で都市が重ならないよう、都市どうしが0.2以上離れるまで引き直す。
const spread=r=>{for(;;){const P=city(r);if(P.every((p,i)=>P.every((q,j)=>j<=i||dist(P,i,j)>=.2)))return P;}};
const r0=rng(7);
export const train=[...Array(4)].map(()=>{const P=spread(r0);return {P,route:sample(P,r0)};}).map(t=>({...t,length:tourLength(t.P,t.route)}));
export const query=tspCases[0].cities;
export const answer=optimalTour(query,0);
const steps=['問題の配置を用意する','配置をモデルへ渡して経路と経路長を出力し、経路長を使ってモデルを更新する','学習済みモデルを移し、新しい配置から経路を出力する'];

// 小さな地図。route を count 本まで描く。
function thumb(key,P,{x,y,s=100,route=null,count=n,opacity=1,start=true}){
 const at=([u,v])=>[+(x+u*s).toFixed(1),+(y+v*s).toFixed(1)];let b=`<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${C.paper}" stroke="#98a5b1" stroke-width="1.5"/>`;
 if(route)edgesOf(route).slice(0,count).forEach(([a,c],j)=>{const [x1,y1]=at(P[a]),[x2,y2]=at(P[c]);b+=keyed(`${key}-e${j}`,line(x1,y1,x2,y2,C.accent,false,3));});
 P.forEach((p,i)=>{const [cx,cy]=at(p);b+=i===0&&start?`<rect x="${cx-6}" y="${cy-6}" width="12" height="12" fill="${C.ink}"/>`:`<circle cx="${cx}" cy="${cy}" r="5.5" fill="${C.ink}"/>`;});
 return keyed(key,b,`opacity="${opacity}"`);}
// grow は線の伸び、head は矢尻の大きさ（どちらも0〜1）。矢尻は伸びた先端に付け、向きは最後まで伸ばしたときの向きにする。
const arrowAt=(key,x1,y1,x2,y2,color=C.ink,opacity=1,grow=1,head=grow)=>{const a=Math.atan2(y2-y1,x2-x1),h=12*head,ex=+(x1+(x2-x1)*grow).toFixed(1),ey=+(y1+(y2-y1)*grow).toFixed(1),p=(t)=>`${(ex-h*Math.cos(a+t)).toFixed(1)},${(ey-h*Math.sin(a+t)).toFixed(1)}`;
 const shaft=12*grow*Math.cos(.45),sx=+(ex-shaft*Math.cos(a)).toFixed(1),sy=+(ey-shaft*Math.sin(a)).toFixed(1);
 return keyed(key,line(x1,y1,sx,sy,color,false,2.5)+`<polygon points="${ex},${ey} ${p(.45)} ${p(-.45)}" fill="${color}"/>`,`opacity="${opacity}"`);};
const model=(key,x,y,{pulse=0,trained=false}={})=>{
 let b=`<rect width="130" height="74" rx="12" fill="${trained?'#287c79':C.B}" stroke="${pulse?'#84d9e1':'#ffffff'}" stroke-width="${pulse?4:1}"/>`;
 b+=text(65,23,'NNモデル',20,C.paper,'middle');
 const layers=[[[29,42],[29,60]],[[65,36],[65,51],[65,66]],[[101,42],[101,60]]];
 layers.slice(0,-1).forEach((layer,j)=>layer.forEach(([x1,y1],i)=>layers[j+1].forEach(([x2,y2],q)=>{
  b+=`<line data-key="link-${j}-${i}-${q}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="white" stroke-width="1.2" opacity="${pulse===j+1?.9:.4}"/>`;
 })));
 layers.forEach((layer,j)=>layer.forEach(([cx,cy],i)=>{
  b+=`<circle data-key="unit-${j}-${i}" cx="${cx}" cy="${cy}" r="${pulse===j+1?5:4}" fill="white" opacity="${pulse===j+1?1:.8}"/>`;
 }));
 return keyed(key,b,`transform="translate(${x} ${y})"`);
};
const frame=(key,x,w,title)=>keyed(key,`<rect x="${x}" y="22" width="${w}" height="404" rx="8" fill="none" stroke="#b5c0ca" stroke-width="2"/>`+text(x+20,60,title,26,C.ink));
const tx=j=>40+j*118,ty=88,M={x:205,y:330},Mi={x:780,y:190};

// seed には次に現れる矢印の段階を渡す。見えない長さ0・矢尻0の矢印を先に置いて線を伸ばす。
// bare に渡した矢印は矢尻を0にして線だけ描き、次の frame で矢尻を付ける（三角が線より先に出ない）。
function scene(k,{pulse=0,length=true,transfer=null,inputLeg=false,seed=null,bare=null,trained=k>=3}={}){
 const arrow=(key,x1,y1,x2,y2,color=C.ink)=>arrowAt(key,x1,y1,x2,y2,color,1,1,bare===key?0:1);
 let s=frame('frame-train',16,540,'学習')+frame('frame-infer',578,506,'推論');
 train.forEach((t,j)=>{
  s+=thumb(`train-${j}`,t.P,{x:tx(j),y:ty,route:k>=2?t.route:null});
  if(k>=2&&length)s+=keyed(`train-len-${j}`,text(tx(j)+50,220,`長さ ${t.length.toFixed(2)}`,18,C.ink,'middle'));
 });
 s+=model('model',M.x,M.y,{pulse:k<4?pulse:0,trained});
 // 推論は最初から配置だけを置き、出力地図は最後に現れる。
 s+=thumb('query',query,{x:604,y:170,s:110});
 if(k>=1){
  s+=keyed('input-down',line(130,236,130,367,C.ink,false,2.5));
  s+=inputLeg?arrowAt('input-to-model',130,367,197,367,C.ink,0,0):arrow('input-to-model',130,367,197,367);
  s+=keyed('input-label',text(116,285,'配置',20,C.ink,'end'));
 }
 if(k>=2){
  s+=arrow('arrow-make',235,322,235,236);
  s+=keyed('label-make',text(220,284,'経路',20,C.ink,'end'));
 }
 if(k>=3){
  s+=arrow('arrow-update',305,236,305,322,C.accent);
  s+=keyed('label-update',text(330,263,'経路長を返す',20,C.accent)+text(330,292,'モデルを更新',20,C.accent));
 }
 if(seed===2)s+=arrowAt('arrow-make',235,322,235,236,C.ink,0,0);
 if(seed===3)s+=arrowAt('arrow-update',305,236,305,322,C.accent,0,0);
 if(k>=4){
  const pos=transfer==='start'?M:transfer==='right'?{x:Mi.x,y:M.y}:Mi;
  s+=model('model-inf',pos.x,pos.y,{pulse:k>=5?pulse:0,trained:true});
  if(!transfer)s+=keyed('trained-label',text(845,163,'学習済み',20,'#287c79','middle'));
 }
 if(k>=4){
  s+=k>=5?arrow('arrow-in',722,227,772,227):arrowAt('arrow-in',722,227,772,227,C.ink,0,0);
  s+=k>=6?arrow('arrow-out',918,227,958,227):arrowAt('arrow-out',918,227,958,227,C.ink,0,0);
 }
 if(k>=6){
  s+=thumb('answer',query,{x:966,y:170,s:110,route:answer.route,count:answer.route.length-1});
 }
 return svg(s,'配置から経路を作り、経路長を使ってモデルを更新する。学習済みモデルを移して、新しい配置から経路を作る');
}
const f=(k,options={},duration=450,hold=0)=>({markup:scene(k,options),duration,hold});
// 経路生成は左→右、学習の更新は逆向きの右→左に点を動かす。
// 更新の矢印と逆伝播を見せ終えてから、学習済みの色へ変える。
const work=k=>(k===3?[3,2,1,0]:[1,2,3,0]).map(pulse=>f(k,{pulse,...(k===3?{trained:pulse===0}:{})},170));
export default {id:'F24',title:'NCOの学習と推論',steps,
 renderStep(k){return scene([0,3,6][k]);},
 transition(from,to){if(to!==from+1)return null;
  // 入力・計算から経路と経路長の出力、モデルの更新まで、1回のstepで続ける。経路長を出したところで少し間を取る。
  if(to===1)return [f(1,{inputLeg:true},120),f(1,{bare:'input-to-model'},120),f(1,{},50),...work(1),f(1,{seed:2},0),f(2,{length:false,bare:'arrow-make'},280),f(2,{length:false},50),f(2,{},450,500),
   f(2,{seed:3},0),f(3,{bare:'arrow-update',trained:false},220),f(3,{trained:false},50),...work(3)];
  // 同じモデルの位置を補間し、必ず右へ進んでから上へ移す。
  if(to===2)return [f(4,{transfer:'start'},0),f(4,{transfer:'right'},280),f(4,{},230),f(5,{bare:'arrow-in'},170),f(5,{},50),...work(5),f(6,{bare:'arrow-out'},280),f(6,{},50)];
  return null;}};
