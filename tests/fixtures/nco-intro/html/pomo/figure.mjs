import {svg,text,line,C,keyed,note} from '../_lib/draw.mjs';
import {label,decodedRoute} from '../_lib/am-data.mjs';
// POMO [Kwon et al. 2020]。学習は全都市を出発点にした経路の平均経路長をbaselineにし、推論は座標を回転・反転した8通りの問題から最短を採る。
// 経路は説明用の固定列で、学習済みモデルの出力ではない。各座標配置では全出発点の候補のうち代表1本を示す。
export const cities=[[.12,.50],[.68,.10],[.65,.88],[.30,.15],[.28,.82],[.52,.48]];
const tourLength=r=>r.slice(1).reduce((sum,b,i)=>sum+dist(cities,r[i],b),0);
const N=cities.length,dist=(P,a,b)=>Math.hypot(P[a][0]-P[b][0],P[a][1]-P[b][1]);
const rotate=(r,start)=>{const c=r.slice(0,-1),i=c.indexOf(start);return [...c.slice(i),...c.slice(0,i),start];};
// 8通りの座標変換（POMOの論文の順）。いずれも単位正方形の回転・反転で、距離を変えない。
export const augments=[['(x, y)',([x,y])=>[x,y]],['(y, x)',([x,y])=>[y,x]],['(x, 1−y)',([x,y])=>[x,1-y]],['(y, 1−x)',([x,y])=>[y,1-x]],['(1−x, y)',([x,y])=>[1-x,y]],['(1−y, x)',([x,y])=>[1-y,x]],['(1−x, 1−y)',([x,y])=>[1-x,1-y]],['(1−y, 1−x)',([x,y])=>[1-y,1-x]]].map(([name,f])=>({name,coords:cities.map(f)}));
// 固定候補：3・4番目は同じ巡回路を別の都市から書いたもの。距離は座標から計算する。
const candidateTours=[[0,3,1,5,2,4,0],[0,1,3,5,2,4,0],[0,4,2,1,3,5,0],[2,1,3,5,0,4,2],[0,3,5,1,2,4,0],[0,4,2,3,1,5,0],[0,3,1,2,4,5,0],[0,3,1,4,2,5,0]];
// 全都市を含む出発点列を固定seedでシャッフル。再入場・印刷でも同じ候補を再現する。
let randomState=20261014;
const random=()=>{randomState^=randomState<<13;randomState^=randomState>>>17;randomState^=randomState<<5;return (randomState>>>0)/4294967296;};
export const augStarts=[0,1,2,3,4,5,2,4];
for(let i=augStarts.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[augStarts[i],augStarts[j]]=[augStarts[j],augStarts[i]];}
export const augRoutes=candidateTours.map((r,j)=>rotate(r,augStarts[j]));

export const augLengths=augRoutes.map(tourLength);
export const best=augLengths.indexOf(Math.min(...augLengths));
// 同じ巡回路：都市1から、都市3から、都市1から逆方向に書いた列。
export const sameTour=[rotate(decodedRoute,0),rotate(decodedRoute,2),[...decodedRoute].reverse()];
// 平均基準の説明では8候補すべてを、その座標配置のまま比較する。
// POMOの実際の学習baselineは同じ配置の全出発点に対する平均であり、ここでの8座標候補の平均とは区別する。
export const trainIndices=augments.map((_,j)=>j);
export const trainRoutes=trainIndices.map(j=>augRoutes[j]);
export const trainLengths=trainIndices.map(j=>augLengths[j]);
export const mean=trainLengths.reduce((a,b)=>a+b,0)/trainLengths.length;
export const advantages=trainLengths.map(L=>mean-L);

const M=200,pad=26,at=p=>[pad+p[0]*(M-2*pad),pad+p[1]*(M-2*pad)],f=v=>v.toFixed(1);
function map(key,{x,y,s,coords=cities,start=null,route=null,count=N,edgeKey='e',edgeOpacity=1,opacity=1,frame='#98a5b1',frameWidth=1.5,pose=null}){
 let b=keyed('frame',`<rect x="0" y="0" width="${M}" height="${M}" fill="none" stroke="${frame}" stroke-width="${frameWidth}"/>`);
 if(route)for(let j=1;j<=Math.min(count,N);j++){const [a,c]=[at(coords[route[j-1]]),at(coords[route[j]])];b+=keyed(`${edgeKey}-${j}`,line(f(a[0]),f(a[1]),f(c[0]),f(c[1]),C.accent,false,5),`opacity="${edgeOpacity}"`);}
 coords.forEach((p,i)=>{const [cx,cy]=at(p).map(f);b+=keyed(`c-${i}`,(i===start?`<rect x="${f(cx-17)}" y="${f(cy-17)}" width="34" height="34" rx="4" fill="${C.paper}" stroke="${C.ink}" stroke-width="3"/>`:`<circle cx="${cx}" cy="${cy}" r="17" fill="${C.paper}" stroke="${C.ink}" stroke-width="3"/>`)+keyed(`number-${i}`,text(cx,f(+cy+7),label(i),19,C.ink,'middle'),pose?`style="transform:rotate3d(${pose.axis[0]},${pose.axis[1]},0,${-pose.flip}deg) rotateZ(${-pose.rotation}deg);transform-origin:${cx}px ${cy}px;transform-box:view-box"`:''));});
 return `<g data-key="${key}" transform="translate(${x} ${y}) scale(${s})" opacity="${opacity}">${keyed("plane",b,`style="transform:perspective(650px) rotateZ(${pose?.rotation??0}deg) rotate3d(${pose?.axis[0]??0},${pose?.axis[1]??1},0,${pose?.flip??0}deg);transform-origin:100px 100px;transform-box:view-box"`)}</g>`;}

// 元の地図は最初の位置から直接8配置へ展開する。元配置だけの停止点は設けない。
const reference={x:40,y:74,s:1.05};
const cell=k=>({x:68+(k%4)*270,y:64+Math.floor(k/4)*185,s:.66}),cx=k=>cell(k).x+66;
const symmetry=[
 {key:'aug-0',x:40,coords:cities,route:sameTour[0],name:'元の配置',sequenceKey:'reference-sequence'},
 {key:'symmetry-rotated',x:305,coords:augments[5].coords,route:sameTour[0],name:'90°回転',sequenceKey:'rotated-sequence'},
 {key:'symmetry-reflected',x:570,coords:augments[4].coords,route:sameTour[2],name:'反転・逆方向',sequenceKey:'reflected-sequence'},
 {key:'symmetry-start',x:835,coords:cities,route:sameTour[1],name:'出発点3',sequenceKey:'shifted-sequence'}
];
const P=[0,1,2,4,5,6];
const steps=['座標や書き順を変えても同じ巡回路','経路を消し、8配置へ展開して座標を変換','各配置で経路を生成して経路長を表示','8経路をそのまま並べて比較','平均経路長を基準にする','平均との差で生成確率を更新'];
const trainingSlot=i=>({x:17+i*137,y:40,s:.55}),trainingX=i=>72+i*137;
// 平均付近の差を見せるため、経路長2.0以上を拡大する。軸下端にも値を明示する。
const chartMin=2,chartScale=220,chartBase=392;
const sequence=(key,x,y,r,opacity=1)=>keyed(key,text(x,y,r.map(label).join('→'),22,C.ink,'middle'),`opacity="${opacity}"`);

function scene(k,{leave=false,count=N,phase='transformed',progress=1,lengthOpacity=1,nameOpacity=1,barsZero=false,meanOpacity=1,updateOpacity=1,chartOpacity=1,messageStep=k}={}){
 let s='';
 if(k===0){
  symmetry.forEach(a=>{
   const kept=a.key==='aug-0',o=leave&&!kept?0:1;
   s+=map(a.key,{x:a.x,y:74,s:1.05,coords:a.coords,start:a.route[0],route:a.route,edgeKey:'route',edgeOpacity:leave?0:1,opacity:o});
   s+=keyed(`${a.key}-name`,text(a.x+105,44,a.name,25,C.ink,'middle'),`opacity="${leave?0:1}"`);
   s+=sequence(a.sequenceKey,a.x+105,344,a.route,leave?0:1);
  });
 }else if(k>=4){
  augments.forEach((a,j)=>{
   s+=map(`aug-${j}`,{...trainingSlot(j),coords:cities,pose:planePose(j,1),start:augStarts[j],route:augRoutes[j],edgeKey:'candidate'});
   s+=keyed(`aug-name-${j}`,text(trainingX(j),175,a.name,18,C.muted,'middle'));
  });
  s+=keyed('length-axis-label',text(20,207,'経路長',22,C.ink),`opacity="${chartOpacity}"`);
  s+=keyed('length-axis',line(35,392,1080,392,C.muted,false,1.5),`opacity="${chartOpacity}"`);
  s+=keyed('length-axis-min',text(30,399,chartMin.toFixed(1),16,C.muted,'end'),`opacity="${chartOpacity}"`);
  trainLengths.forEach((L,i)=>{
   const x=trainingX(i),height=barsZero?0:(L-chartMin)*chartScale,color=k===6?(L<mean?C.C:C.A):'#4d5f71';
   s+=keyed(`training-bar-${i}`,`<rect x="${x-27}" y="${f(392-height)}" width="54" height="${f(height)}" rx="3" fill="${color}"/>`,`opacity="${chartOpacity}"`);
   s+=keyed(`training-length-${i}`,text(x,380,L.toFixed(2),20,C.paper,'middle'),`opacity="${barsZero?0:chartOpacity}"`);
   if(k===6)s+=keyed(`training-update-${i}`,text(x,425,L<mean?'生成確率 ↑':'生成確率 ↓',18,L<mean?C.C:C.A,'middle'),`opacity="${updateOpacity*chartOpacity}"`);
  });
  if(k>=5){
   const y=chartBase-(mean-chartMin)*chartScale;
   s+=keyed('training-mean',line(35,f(y),1080,f(y),C.paper,false,5)+line(35,f(y),1080,f(y),C.accent,false,3),`opacity="${meanOpacity*chartOpacity}"`);
   s+=keyed('training-mean-label',`<text x="35" y="${f(y-13)}" font-size="25" font-weight="700" fill="${C.accent}" text-anchor="start" stroke="${C.paper}" stroke-width="7" paint-order="stroke">平均 ${mean.toFixed(2)}</text>`,`opacity="${meanOpacity*chartOpacity}"`);
  }
 }else{
  const placed=phase!=='copies';
  augments.forEach((a,j)=>{
   // Copies are new maps; the original input retains its identity. No original tour is reused as a generated candidate.
   const pose=planePose(j,phase==='copies'||phase==='spread'?0:progress);
   s+=map(`aug-${j}`,{...(placed?cell(j):reference),coords:cities,pose,start:phase==='copies'?null:augStarts[j],
    route:k>=2?augRoutes[j]:null,count,edgeKey:'candidate'});
   if(placed){
    s+=keyed(`aug-name-${j}`,text(cx(j),cell(j).y+153,a.name,20,C.muted,'middle'),`opacity="${nameOpacity}"`);
    if(k>=2)s+=keyed(`aug-length-${j}`,text(cx(j),cell(j).y+178,augLengths[j].toFixed(2),23,C.ink,'middle'),`opacity="${count===N?lengthOpacity:0}"`);
   }
  });
 }
 if(messageStep===1)s+=note('note-augmentation',14,0,1072,[{t:'回転、反転、初期位置の変化などの変換を行って、問題を複製',size:30,weight:700}],C.B);
 if(messageStep===2)s+=note('note-generation',14,0,1072,[{t:'それぞれでモデルが経路を作る。',size:30,weight:700}],C.accent);
 return svg(s,'巡回路の対称性を確認し、経路を消して8通りの座標配置を作る。各配置の経路を向きを保って並べ、経路長と平均を比較して生成確率を更新する');
}

// 枠・都市・経路をひとつの面に載せ、面全体を回転・反転する。
// 反転は指定の軸を中心に奥行き方向へ180°回す。都市番号は逆回転して読みやすさを保つ。
export function planePose(j,t){
 const diagonal=Math.SQRT1_2;
 const axes={1:[diagonal,diagonal],2:[1,0],4:[0,1],7:[diagonal,-diagonal]};
 return {rotation:({3:-90,5:90,6:180}[j]??0)*t,flip:axes[j]?180*t:0,axis:axes[j]??[0,1]};
}
const grow=()=>Array.from({length:N},(_,i)=>({markup:scene(2,{count:i+1}),duration:260}));
export default {id:'F25',title:'POMO',steps,
 renderStep(k){return scene(P[k]);},
 transition(from,to){if(to!==from+1)return null;const p=P[to];
  if(p===1)return [{markup:scene(0,{leave:true,messageStep:1}),duration:450},{markup:scene(1,{phase:'copies',nameOpacity:0}),duration:250},
   {markup:scene(1,{phase:'spread',nameOpacity:0}),duration:900},{markup:scene(1,{phase:'spread'}),duration:300},{markup:scene(1),duration:1400}];
  if(p===2)return [{markup:scene(2,{count:0}),duration:200},...grow()];
  if(p===4)return [{markup:scene(4,{barsZero:true,chartOpacity:0}),duration:1100},{markup:scene(4,{barsZero:true}),duration:300},{markup:scene(4),duration:800}];
  if(p===5)return [{markup:scene(5,{meanOpacity:0}),duration:1},{markup:scene(5),duration:600}];
  if(p===6)return [{markup:scene(6,{updateOpacity:0}),duration:600},{markup:scene(6),duration:350}];
  return null;}};
