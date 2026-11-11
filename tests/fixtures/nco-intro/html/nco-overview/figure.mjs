import {svg,text,line,rect,C,keyed,mapFrame,math,note} from '../_lib/draw.mjs';
import {cities,label,start,decodedRoute as route} from '../_lib/am-data.mjs';
import {probabilities} from '../nco-decoder/figure.mjs';
// 構成型NCOの全体像。各手でデコーダーが p(y_t|x,y_{1:t-1}) を計算し、その項を並べて掛けると p(y|x) [Kool et al. 2019, 式(1)]。
// 経路と確率はA02（nco-decoder）と同じ説明用の固定値で、学習済みモデルの出力ではない。都市1を出発点に固定し、y_1〜y_5を選ぶ。
const N=cities.length,T=route.length-2,dark='#2f6aa3';
const at=i=>[30+cities[i][0]*166,52+cities[i][1]*166];
const ey=i=>50+i*36,TX=248,EX=412,ENC=[278,380],DEC=[470,650,60,220],MID=140,DX=560;
const bx=i=>722+i*62,base=225,cy=247,cx=t=>90+(t-1)*150,ry=318,ty=360,vy=392,hy=290;
const circle=(x,y,r,fill,stroke='none',extra='')=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" ${extra}/>`;
const arrowR=(x,X,y,c=C.accent)=>line(x,y,X-10,y,c)+`<path d="M ${X} ${y} l -12 -7 v 14 Z" fill="${c}"/>`;
const term=t=>t===1?'p(y_{1} | x)':t===2?'p(y_{2} | x, y_{1})':`p(y_{${t}} | x, y_{1:${t-1}})`;
const pick=t=>probabilities[t-1][route[t]];

// 最後の2段階はモデル内部を消し、各手の確率の積と、条件x・経路y・p(y|x)の対応だけを示す。
function summaryScene(mean){
 // 等式は常に横一列。意味の説明へ進むと、等式全体を下へ移す。
 const fy=mean?330:220,ay=fy-49,vy=fy+43;
 let s='';
 if(!mean)s+=keyed('product-title',text(550,38,'各手の選択確率を掛け合わせる',28,C.ink,'middle'));
 // 入力問題は同じ都市を保持する。経路yの地図は別の対象として作る。
 let problem=mapFrame(20,40,190,190);
 cities.forEach((_,i)=>{const [x,y]=at(i);problem+=keyed(`city-${i}`,(i===start?`<rect x="${x-14}" y="${y-14}" width="28" height="28" rx="4" fill="${C.paper}" stroke="${C.ink}" stroke-width="2.5"/>`:circle(x,y,14,C.paper,C.ink,'stroke-width="2.5"'))+text(x,y+6,label(i),15,C.ink,'middle'));});
 s+=keyed('problem',problem,`transform="translate(${mean?65:0} 0) scale(${mean?.82:1})" opacity="${mean?1:0}"`);
 if(mean){
  s+=keyed('condition-label',math(162,20,'条件となる問題 x',23,C.ink,'middle'));
  let solution=mapFrame(20,40,190,190);
  for(let j=1;j<route.length;j++)solution+=keyed(`solution-edge-${j}`,line(...at(route[j-1]),...at(route[j]),C.accent,false,4));
  cities.forEach((_,i)=>{const [x,y]=at(i);solution+=keyed(`solution-city-${i}`,(i===start?`<rect x="${x-14}" y="${y-14}" width="28" height="28" rx="4" fill="${C.paper}" stroke="${C.ink}" stroke-width="2.5"/>`:circle(x,y,14,C.paper,C.ink,'stroke-width="2.5"'))+text(x,y+6,label(i),15,C.ink,'middle'));});
  s+=keyed('solution',solution,'transform="translate(845 0) scale(.82)"');
  s+=keyed('solution-label',math(942,20,'生成する経路 y',23,C.ink,'middle'));
  s+=keyed('condition-input',arrowR(274,410,106,C.B));
  s+=keyed('solution-output',arrowR(690,827,106));
  s+=keyed('model-probability',math(550,116,'p(y | x)',44,C.accent,'middle'));
  s+=keyed('conditional-model',text(550,53,'モデルが表す条件付き確率',25,C.ink,'middle')+math(550,166,'問題 x に対して経路 y を生成する確率',21,C.ink,'middle'));
 }
 for(let j=1;j<=T;j++){
  const x=270+(j-1)*180;
  s+=keyed(`ylab-${j}`,math(x-4,ay+7,`y_{${j}} =`,20,C.ink,'end'));
  s+=keyed(`chip-${j}`,circle(0,0,13,C.accent)+text(0,6,label(route[j]),15,'#fff','middle'),`transform="translate(${x+14} ${ay})"`);
  s+=keyed(`term-${j}`,math(0,0,term(j),23,C.ink,'middle'),`transform="translate(${x} ${fy})"`);
  s+=keyed(`val-${j}`,text(x,vy,pick(j).toFixed(2),21,C.muted,'middle'));
  if(j<T)s+=keyed(`times-${j}`,text(x+90,fy,'×',28,C.accent,'middle'));
 }
 s+=keyed('conditional-result',math(0,0,'p(y | x)',mean?30:44,C.accent,'middle'),`transform="translate(75 ${fy})"`);
 s+=keyed('product-equals',math(0,0,'=',32,C.accent,'middle'),`transform="translate(167 ${fy})"`);
 return svg(s,'各手の条件付き確率を掛け合わせると、モデルが問題xに対して経路yを生成する条件付き確率p(y|x)になる');
}

// t：確率を出している手、run：デコーダーが計算中、hi：選ぶ都市を強調、sel：選択済みの手数（項は下の列へ移る）、
// tok：都市を地図から取り出して縦に並べる途中（'city'→'col'）、enc：エンコーダーが変換中、prod：項を掛け合わせる、mean：p(y|x)の意味を示す。
function scene({emb=0,tok,enc=false,t=0,run=false,hi=false,sel=0,prod=false,mean=false,phase='ready',diagramOpacity=1,note:noteId=null}={}){
 if(prod||mean)return summaryScene(mean);
 const probT=['input','calc','output'].includes(phase)?Math.max(0,t-1):t;
 const visited=probT?route.slice(0,probT):[],done=prod||mean;
 const tk=tok??(emb?'col':null);
 let s=text(20,28,'問題インスタンス',18)+math(170,28,'x',22)+mapFrame(20,40,190,190);
 for(let j=1;j<=T+1;j++){const a=at(route[j-1]),b=at(route[j]),on=j<=sel||(j===T+1&&done);s+=keyed(`edge-${j}`,line(...a,...(on?b:a),C.accent,false,4),`opacity="${on?1:0}"`);}
 cities.forEach((_,i)=>{const [x,y]=at(i);s+=keyed(`city-${i}`,(i===start?`<rect x="${x-14}" y="${y-14}" width="28" height="28" rx="4" fill="${C.paper}" stroke="${C.ink}" stroke-width="2.5"/>`:circle(x,y,14,C.paper,C.ink,'stroke-width="2.5"'))+text(x,y+6,label(i),15,C.ink,'middle'));});
 s=keyed('problem',s,`opacity="${diagramOpacity}"`);const problem=s;s='';
 // エンコーダー：縦に並べた都市を行ごとに変換し、右に埋め込みを出す。
 s+=keyed('enc',rect(ENC[0],32,ENC[1]-ENC[0],216,'#f4eee6','#dccbb5')+text((ENC[0]+ENC[1])/2,MID+6,'エンコーダー',15,C.ink,'middle'));
 s+=keyed('enc-on',`<rect x="${ENC[0]}" y="32" width="${ENC[1]-ENC[0]}" height="216" rx="5" fill="none" stroke="${C.accent}" stroke-width="4"/>`,`opacity="${enc?1:0}"`);
 s+=keyed('emb-label',text(EX,22,'埋め込み',18,C.ink,'middle'),`opacity="${emb?1:0}"`);
 cities.forEach((_,i)=>s+=keyed(`io-${i}`,line(TX+14,ey(i),ENC[0],ey(i),'#98a5b1',false,1.5)+line(ENC[1],ey(i),EX-15,ey(i),'#98a5b1',false,1.5),`opacity="${tk==='col'?1:0}"`));
 const used=i=>sel>=1&&route.slice(0,sel+1).includes(i)&&!done;
 if(t>sel)cities.forEach((_,i)=>{const live=!route.slice(0,t).includes(i);s+=keyed(`att-${t}-${i}`,line(EX+15,ey(i),DEC[0],MID,live?C.accent:'#b5c0ca',false,live?2.5:1.5),`opacity="${live?.9:.15}"`);});
 cities.forEach((_,i)=>s+=keyed(`emb-${i}`,circle(EX,ey(i),15,dark)+text(EX,ey(i)+6,label(i),15,'#fff','middle'),`opacity="${emb?(used(i)?.35:1):0}"`));
 cities.forEach((_,i)=>{const [x,y]=tk==='col'?[TX,ey(i)]:at(i);s+=keyed(`tok-${i}`,circle(0,0,14,C.paper,C.ink,'stroke-width="2.5"')+text(0,6,label(i),15,C.ink,'middle'),`transform="translate(${x} ${y})" opacity="${tk?1:0}"`);});
 // デコーダー：計算中は枠を強調し、その手の項を中に表示する。
 const [x0,x1,y0,y1]=DEC;
 s+=keyed('dec',rect(x0,y0,x1-x0,y1-y0,'#f4eee6','#dccbb5')+text(DX,y0+28,'デコーダー',18,C.ink,'middle'));
 s+=keyed('dec-on',`<rect x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}" rx="5" fill="none" stroke="${C.accent}" stroke-width="4"/>`,`opacity="${run?1:0}"`);
 if(t&&phase!=='input'&&phase!=='calc')s+=keyed(`dec-out-${t}`,arrowR(x1+4,700,MID),`opacity="${mean?0:1}"`);
 s+=keyed('probability-label',text(880,28,'選択確率',20,C.ink,'middle'),`opacity="${mean?0:1}"`);
 // 2手目以降の計算中だけ、直前に選んだ y_{t-1} の項から線を伸ばし、デコーダーへ入力する。
 // 確率の条件は y_{1:t-1} だが、モデルへ新たに入るのは直前の行動だけ（過去の選択は訪問済みのマスクとして効く）。
 for(let j=2;j<=T;j++){
  const fb=t===j&&t>sel,px=cx(j-1)+14,py=ry-13,len=(py-hy)+(DX-px)+(hy-y1-12);
  s+=keyed(`feed-${j}`,`<path d="M ${px} ${py} V ${hy} H ${DX} V ${y1+12}" fill="none" stroke="${C.accent}" stroke-width="2.5" stroke-dasharray="${len} ${len}" stroke-dashoffset="${fb?0:len}"/>`,`opacity="${fb?1:0}"`);
  s+=keyed(`feed-head-${j}`,`<path d="M ${DX} ${y1+2} l -7 12 h 14 Z" fill="${C.accent}"/>`+math(DX+12,hy-12,`y_{${j-1}}`,19,C.accent),`opacity="${fb&&phase!=='input'?1:0}"`);
 }
 // デコーダーの出力：各都市を次に選ぶ確率。
 s+=keyed('axis',line(bx(0)-30,base,bx(N-1)+30,base,'#98a5b1',false,1.5),`opacity="${mean?0:1}"`);
 cities.forEach((_,i)=>{const p=probT?probabilities[probT-1][i]:0,masked=probT&&visited.includes(i),h=masked?0:p*150,chosen=hi&&route[t]===i,fade=mean?0:prod?.3:1;
  s+=keyed(`bar-${i}`,`<rect x="${bx(i)-17}" y="${(base-h).toFixed(1)}" width="34" height="${h.toFixed(1)}" fill="${chosen?C.accent:C.B}"/>`,`opacity="${fade}"`);
  s+=keyed(`pct-${i}`,text(bx(i),(base-h-7).toFixed(1),p.toFixed(2),15,chosen?C.accent:C.ink,'middle'),`opacity="${probT&&!masked&&p>=.005?fade:0}"`);
  s+=keyed(`mask-${i}`,text(bx(i),base-4,'×',22,C.A,'middle'),`opacity="${masked?fade:0}"`);
  s+=keyed(`cand-${i}`,circle(bx(i),cy,13,C.paper,C.ink,'stroke-width="2"')+text(bx(i),cy+5,label(i),15,C.ink,'middle'),`opacity="${fade}"`);
 });
 s=problem+keyed('architecture',s,`opacity="${diagramOpacity}"`);
 // 各手の項がデコーダーから下の列へ移って蓄積する。
 for(let j=1;j<=T;j++){
  const placed=j<=sel,inDec=!placed&&j===t&&(run||hi);
  s+=keyed(`ylab-${j}`,math(cx(j)-4,ry+7,`y_{${j}} =`,20,C.ink,'end'),`opacity="${placed?1:0}"`);
  const [chx,chy]=placed?[cx(j)+14,ry]:[bx(route[j]),cy];
  s+=keyed(`chip-${j}`,circle(0,0,13,C.accent)+text(0,6,label(route[j]),15,'#fff','middle'),`transform="translate(${chx} ${chy})" opacity="${placed||(hi&&j===t)?1:0}"`);
  const [tx,tyy]=placed?[cx(j),ty]:[DX,y0+105];
  s+=keyed(`term-${j}`,math(0,0,term(j),20,C.ink,'middle'),`transform="translate(${tx} ${tyy})" opacity="${placed||inDec?1:0}"`);
  s+=keyed(`val-${j}`,text(cx(j),vy,pick(j).toFixed(2),16,C.muted,'middle'),`opacity="${placed?1:0}"`);
  if(j<T)s+=keyed(`times-${j}`,text((cx(j)+cx(j+1))/2,ty,'×',20,C.ink,'middle'),`opacity="${done?1:0}"`);
 }
 // 注記（右下の余白）。エンコーダーと、1・2手目のデコーダーの入出力だけを示す。3手目以降は同じ処理の繰り返し。
 const NX=650,NY=290,NW=440;
 if(noteId==='enc')s+=note('note-enc',NX,NY,NW,['$問題 x の都市を入力として',{t:'都市ごとの埋め込みを1回だけ生成',size:26}],C.B);
 if(noteId==='dec1')s+=note('note-dec1',NX,NY,NW,['埋め込みを入力として',{t:'次の都市の選択確率を出力',size:26}],C.accent);
 if(noteId==='dec2')s+=note('note-dec2',NX,NY,NW,['$直前に選んだ y_{1} もデコーダーへ入力',{t:'訪問済みの都市は選ばない（×）',size:26}],C.accent);
 return svg(s,'各手でデコーダーが次の行動の確率を計算し、その項を掛け合わせると問題xから経路yを生成する確率になる');
}
// 説明する状態と、画面を切り替える前の結果だけを停止点にする。
const S=[
 {},
 {emb:1,note:'enc'},
 {emb:1,t:1,run:true,sel:0,note:'dec1'},
 {emb:1,t:2,run:true,sel:1,note:'dec2'},
 {emb:1,t:T,hi:true,sel:T},
 {emb:1,t:T,hi:true,sel:T,prod:true},
 {emb:1,t:T,hi:true,sel:T,mean:true},
];
export default {id:'F02',title:'構成型NCOの処理',steps:[
 '問題インスタンス x','エンコーダーで埋め込みを作る',
 '埋め込みから次の都市の選択確率を出力',
 '直前の選択を入力し、訪問済みの都市を除いて次の確率を出力',
 '選択を繰り返して経路と各手の項が揃う',
 '項を掛け合わせると p(y | x)',
 'p(y | x)：問題xを与えたときモデルpが経路yを生成する確率'],
 renderStep(k){return scene(S[k]);},
 transition(from,to){
  if(to!==from+1)return null;
  const f=(st,duration,hold=0)=>({markup:scene(st),duration:duration/1.5,hold:hold/1.5});
  const calcFrames=(t,note=null)=>[
   f({emb:1,t,sel:t-1,phase:'input',note},750),
   f({emb:1,t,run:true,sel:t-1,phase:'calc',note},550),
   f({emb:1,t,run:true,sel:t-1,phase:'output',note},500),
   f({emb:1,t,run:true,sel:t-1,note},700)];
  const pickFrames=t=>[f({emb:1,t,hi:true,sel:t-1},450),f({emb:1,t,hi:true,sel:t},750)];
  if(to===1)return [f({tok:'city',note:'enc'},250),f({tok:'col',note:'enc'},750),f({tok:'col',enc:true,note:'enc'},400),f({emb:1,enc:true,note:'enc'},700),f(S[1],300)];
  if(to===2)return calcFrames(1,'dec1');
  // 最初の都市の選択から、直前の選択を次の計算に使う説明までつなぐ。
  if(to===3)return [...pickFrames(1),...calcFrames(2,'dec2')];
  // 4→5は同じ処理の繰り返しなので、全ての項が揃うまで2倍速で見せる。
  if(to===4)return [...pickFrames(2),...Array.from({length:T-2},(_,i)=>i+3).flatMap(t=>[...calcFrames(t),...pickFrames(t)])].map(frame=>({...frame,duration:frame.duration/2,hold:(frame.hold??0)/2}));
  const st=S[to];
  if(st.prod)return [f({...S[from],diagramOpacity:0},450),f(st,900)];
  if(st.mean)return [f(st,900)];
  return null;
 }};
