import {svg,text,line,C,keyed,mapFrame} from '../_lib/draw.mjs';
import {cities,label,start,decodedRoute as route} from '../_lib/am-data.mjs';
// Attention Model [Kool et al. 2019, §3.2] のデコーダー。値はすべて説明用の固定値で、学習済みモデルの出力ではない。
// 埋め込みの空間は2次元への模式的な射影。点は地図の配置を回転・反転して縮めたもので、近い都市は近くに置く。
// スコア＝文脈ベクトルと埋め込みの内積、確率＝未訪問だけのsoftmax(6×スコア)。
const N=cities.length,rad=Math.PI/180;
export const embedding=[[.76,.31],[.67,.89],[.21,.41],[.87,.63],[.47,.22],[.33,.82]];
export const contexts=[12,58,78,70,55].map(a=>[Math.cos(a*rad),Math.sin(a*rad)]);
export const scores=contexts.map(c=>embedding.map(e=>e[0]*c[0]+e[1]*c[1]));
export const visitedAt=t=>route.slice(0,t);
const softmax=(s,v,scale)=>{const e=s.map((x,i)=>v.includes(i)?0:Math.exp(scale*x)),z=e.reduce((a,b)=>a+b);return e.map(x=>x/z);};
export const probabilities=scores.map((s,k)=>softmax(s,visitedAt(k+1),6));
// cross attentionの重み（説明用）。未訪問の都市だけから情報を取り込む。
export const attention=scores.map((s,k)=>softmax(s,visitedAt(k+1),4));

const at=i=>[50+cities[i][0]*210,165+cities[i][1]*210];
const ex=i=>360+i*56,ey=385,slot=[375,435,495],qy=95,Q=[590,95],J=[590,250],X=[705,250],O=[812,392],sp=([x,y])=>[O[0]+x*215,O[1]-y*215];
const dark='#2f6aa3',circle=(x,y,r,fill,stroke='none',extra='')=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" ${extra}/>`;
const dot=(x,y,id,fill=dark,r=17)=>circle(x,y,r,fill)+text(x,y+6,id,16,'#fff','middle');
const hollow=(x,y,r,color)=>circle(x,y,r,C.paper,color,'stroke-width="2" stroke-dasharray="5 4"');
const R={init:0,avg:1,copy:2,attn:3,proj:4,score:5,mask:6,prob:7,select:8,update:9,ret:10};
const S=[{t:0,ph:'init'}];
// 1手目は処理ごとに止める。2・3手目はqueryの更新から確率まで止めずに動かし、選択で止める。
for(let t=1;t<=3;t++)S.push(...(t===1?['avg','copy','attn','proj','score','mask','prob','select','update']:['prob','select']).map(ph=>({t,ph})));
S.push({t:4,ph:'prob'},{t:4,ph:'select'},{t:5,ph:'select'},{t:6,ph:'ret'});
const names={avg:'全都市の埋め込みの平均',copy:'平均・現在地・出発地をまとめてquery',attn:'cross attentionで文脈ベクトル',proj:'文脈ベクトルと埋め込みの内積',score:'内積を各都市のスコアへ',mask:'訪問済みをマスク',prob:'softmaxで確率',update:'現在地を更新'};
const stepName=({t,ph})=>t===0?'出発点と埋め込み':ph==='ret'?'出発点へ戻って経路が完成':ph==='select'?`${t}手目：都市${label(route[t])}を選択`:t===1?`1手目：${names[ph]}`:t>=4?`${t}手目：現在地の変化と確率`:`${t}手目：queryの更新から確率まで`;

function arrow(c,strong,t){const u=c,n=[-c[1],c[0]],[tx,ty]=sp([c[0]*1.15,c[1]*1.15]),[bx,by]=[tx-u[0]*16,ty+u[1]*16],[lx,ly]=[tx-u[0]*10,ty+u[1]*10];
 return keyed(`arrow-${t}`, line(O[0],O[1],lx.toFixed(1),ly.toFixed(1),C.AB,false,4)+`<path d="M ${tx.toFixed(1)} ${ty.toFixed(1)} L ${(bx+n[0]*8).toFixed(1)} ${(by-n[1]*8).toFixed(1)} L ${(bx-n[0]*8).toFixed(1)} ${(by+n[1]*8).toFixed(1)} Z" fill="${C.AB}"/>`,`opacity="${strong?1:.3}"`);}
const copy=(key,i,x,y,opacity)=>keyed(key,dot(0,0,label(i)),`transform="translate(${x} ${y})" opacity="${opacity}"`);
// 段階の要点は対象に対応する色・淡い帯・太字で示し、常設の図ラベルと強弱を付ける。
const message=(key,x,y,w,h,color,body)=>keyed(key,
 `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" fill-opacity=".08"/>`+
 `<rect x="${x}" y="${y}" width="4" height="${h}" fill="${color}"/>`+body);
const messageText=(x,y,content,size,color,weight=700)=>text(x,y,content,size,color).replace('<text ',`<text font-weight="${weight}" `);

// 遷移途中の状態。copyFrame: appear（埋め込みの位置に複製）→ moved（枠へ移動）。attnFrame: line → gather → arrive（合流点）→ merge（文脈ベクトル）。
// scoreFrame: 'space'で内積の値を埋め込みの空間の点の横に出し、次の状態で左図の棒へ移す。1手目のprojはこの状態で止まる。
// arrowOnly: 矢印だけを置き、内積はまだ出さない。maskFrame: softmax前にマスクだけを見せる。
// stには段階の状態のほか、2・3手目の途中経過（copy・attn・score）も渡す。
function scene(st,{copyFrame=null,attnFrame=null,barsOff=false,noSelect=false,arrowOld=false,scoreFrame=null,maskFrame=false,arrowOnly=false,updatePending=false}={}){
 const {t,ph}=st,r=R[ph],space=scoreFrame==='space'||(ph==='proj'&&!arrowOnly),T=Math.max(1,Math.min(t,5)),full=t<=3,before=t===0?[start]:t>=6?route.slice(0,6):visitedAt(T);
 const selecting=(ph==='select'||ph==='update')&&!noSelect,chosen=selecting?route[t]:null;
 const moved=selecting&&(t!==1||ph==='update')&&!updatePending,faded=new Set(moved?[...before,chosen]:before);
 const cur=t===0||ph==='ret'?start:moved?chosen:route[T-1],edges=t===0?0:ph==='ret'?6:moved?t:T-1;
 const markEmbedding=selecting||t>=2;
 const mode=barsOff||t===0?'none':maskFrame?'mask':ph==='score'?'score':ph==='mask'?'mask':ph==='prob'||ph==='select'||ph==='update'?'prob':'none';
 let s=mapFrame(20,135,270,270);
 for(let j=1;j<=edges;j++){const [a,b]=[at(route[j-1]),at(route[j])];s+=keyed(`edge-${j}`,line(...a,...b,C.accent,false,4));}
 cities.forEach((_,i)=>{const [x,y]=at(i);s+=keyed(`city-${i}`,(i===start?`<rect x="${x-17}" y="${y-17}" width="34" height="34" rx="4" fill="${C.paper}" stroke="${C.ink}" stroke-width="2.5"/>`:circle(x,y,17,C.paper,C.ink,'stroke-width="2.5"'))+text(x,y+6,label(i),16,C.ink,'middle'));});
 {const [x,y]=at(cur);s+=keyed('cur',circle(0,0,25,'none',C.accent,'stroke-width="3"'),`transform="translate(${x} ${y})"`);}
 cities.forEach((_,i)=>{const [x,y]=at(i),base=y-28,masked=before.includes(i),p=probabilities[T-1][i];
  const hs=scores[T-1][i]*70,h=mode==='score'||mode==='mask'?hs:mode==='prob'&&!masked?p*90:0,covered=mode==='mask'&&masked;
  const fill=mode==='score'||mode==='mask'?C.muted:chosen===i?C.accent:C.B;
  s+=keyed(`bar-${i}`,`<rect x="${x-8}" y="${(base-h).toFixed(1)}" width="16" height="${h.toFixed(1)}" rx="2" fill="${fill}"/>`);
  // マスク：訪問済みの棒に上から覆いを下ろし、スコアを−∞にする。softmax後は確率0で棒を出さない。
  s+=keyed(`cover-${i}`,`<rect x="${x-13}" y="${(base-hs-5).toFixed(1)}" width="26" height="${covered?(hs+5).toFixed(1):0}" rx="3" fill="${C.A}" fill-opacity=".2" stroke="${C.A}" stroke-width="2" stroke-dasharray="4 3"/>`,`opacity="${covered?1:0}"`);
  // 最後の候補の100%は棒の右へ置き、上にある都市4の番号との重なりを避ける。
  const pctX=p===1?x+40:x;
  s+=keyed(`pct-${i}`,text(pctX,(base-h-6).toFixed(1),`${Math.round(p*100)}%`,16,chosen===i?C.accent:C.ink,'middle'),`opacity="${mode==='prob'&&!masked&&p>=.005?1:0}"`);
  // 内積の値。scoreFrame==='space'では埋め込みの空間の点の横に置き、左図の棒の上へ移す。
  if(mode==='score'||mode==='mask'||space){const [px,py]=sp(embedding[i]),[lx,ly]=space?[px+38,py+6]:[x,base-hs-(covered?11:8)];
   s+=keyed(`sc-${i}`,text(0,0,covered?'−∞':scores[T-1][i].toFixed(2),16,covered?C.A:C.ink,'middle').replace('<text ',`<text stroke="${C.paper}" stroke-width="5" paint-order="stroke" `),`transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)})"`);}
 });
 // 埋め込み（エンコーダーの出力、固定）
 s+=text(668,391,'埋め込み',16,C.muted);
 for(let i=0;i<N;i++)s+=keyed(`emb-${i}`,dot(ex(i),ey,label(i)),`opacity="${faded.has(i)?.3:1}"`);
 if(markEmbedding)s+=keyed('emb-cur',circle(0,0,25,'none',C.accent,'stroke-width="3"'),`transform="translate(${ex(cur)} ${ey})"`);
 // query：平均は1手目に1回だけ計算する。現在地と出発は埋め込みの複製を枠へ移し、以後は現在地だけ入れ替える。
 ['平均','現在地','出発'].forEach((name,j)=>s+=keyed(`slot-${j}`,hollow(slot[j],qy,15.5,'#b5c0ca')+text(slot[j],qy+40,name,17,C.muted,'middle')));
 s+=keyed('q-join',line(slot[2]+22,qy,Q[0]-28,qy,C.muted,false,2)+`<path d="M ${Q[0]-24} ${qy} l -10 -6 v 12 Z" fill="${C.muted}"/>`);
 if(t>=2||r>=1){for(let i=0;i<N;i++)s+=keyed(`avg-line-${i}`,line(ex(i),ey-18,slot[0],qy+17,'#7f97ad',false,1.5),`opacity="${t===1&&r===1?.7:0}"`);s+=keyed('avg',circle(slot[0],qy,17,'#a8c2dc'));}
 const copying=!!copyFrame;
 if(t>=2||r>=2){const i=route[T-1],[x,y]=copyFrame==='appear'?[ex(i),ey]:[slot[1],qy];
  if(copying&&t>=2)s+=copy(`copy-cur-${T-1}`,route[T-2],slot[1],qy,copyFrame==='appear'?.35:0);
  s+=copy(`copy-cur-${T}`,i,x,y,1);
  s+=copy('copy-first',start,...(t===1&&copyFrame==='appear'?[ex(start),ey]:[slot[2],qy]),1);}
 const queryReady=(t>=2||r>=2)&&!copying;
 if(t===1&&(ph==='copy'||copying))s+=message(`query-note-${T}`,645,8,440,90,C.accent,
  messageText(660,39,'平均、現在地、出発地をまとめて、',26,C.accent,500)+
  messageText(660,76,'現在の状態を表すベクトルへ',28,C.accent));
 s+=keyed('query',(queryReady?circle(...Q,20,C.accent):hollow(...Q,20,C.accent))+text(Q[0],qy-30,'query',18,C.accent,'middle'));
 // cross attention：queryから線を伸ばし、未訪問の埋め込みから情報を取り込んで文脈ベクトルを作る。
 const ctxReady=(t>=2||r>=3)&&!(ph==='attn'&&attnFrame)&&!(full&&t>=2&&r<3);
 // cross attentionの段階だけ線を出す。queryの線は合流点Jで止まり、埋め込みからの線がJへ合流した後にJ→文脈ベクトルを伸ばす。
 const attnNow=full&&ph==='attn';
 if(t===1&&attnNow)s+=message('context-note',645,0,440,104,C.AB,
  messageText(660,27,'現在の状態と埋め込みで',24,C.AB,500)+
  messageText(660,60,'cross attention',28,C.AB,500)+
  messageText(660,94,'現在の状態における評価軸をつくる',24,C.AB));
 // 説明メッセージは1手目だけ表示し、マスクからsoftmaxによる確率化まで残す。
 if(t===1&&!copying&&(ph==='mask'||maskFrame||ph==='prob'))s+=message(`softmax-note-${T}`,645,8,440,90,C.B,
  messageText(660,39,'訪問済みのスコアを−∞にする',26,C.B,500)+
  messageText(660,76,'softmaxで確率化',30,C.B));
 if(t===1&&ph==='select')s+=message('selection-note',645,12,440,52,C.accent,
  messageText(660,48,'確率に従って選択',30,C.accent));
 if(t===1&&ph==='update')s+=message('update-note',645,12,440,52,C.accent,
  messageText(660,48,'現在地を更新',30,C.accent));
 if(attnNow)s+=keyed(`q-line-${T}`, line(Q[0],Q[1]+20,J[0],J[1],C.AB,false,3));
 if(attnNow&&(!attnFrame||attnFrame==='merge'))s+=keyed(`j-ctx-${T}`, line(J[0],J[1],X[0]-20,X[1],C.AB,false,3));
 if(attnNow&&attnFrame!=='line')for(const i of route.filter(i=>!before.includes(i))){const w=attention[T-1][i];
  s+=keyed(`att-${T}-${i}`,line(ex(i),ey-18,J[0],J[1],C.AB,false,(.6+w*9).toFixed(2)),'opacity=".75"');
  if(attnFrame==='gather'||attnFrame==='arrive'||attnFrame==='merge'){const [x,y]=attnFrame==='gather'?[ex(i),ey-18]:attnFrame==='arrive'?J:X;s+=keyed(`flow-${T}-${i}`,circle(0,0,(4+w*9).toFixed(1),C.AB),`transform="translate(${x} ${y})"`);}}
 s+=keyed('ctx',(ctxReady?circle(...X,20,C.AB):hollow(...X,20,C.AB))+text(X[0],X[1]-30,'文脈ベクトル',16,C.AB,'middle'));
 // 埋め込みの空間（2次元への模式的な射影）
 s+=text(790,122,'埋め込みの空間',18,C.muted)+`<rect x="790" y="135" width="285" height="270" fill="none" stroke="#98a5b1" stroke-width="1.5"/>`+line(O[0],O[1],1062,O[1],'#c3ccd4',false,1.5)+line(O[0],O[1],O[0],148,'#c3ccd4',false,1.5);
 const arrowT=t===0?0:ph==='ret'?5:t===1?(r>=4?1:0):full?(r>=5?t:t-1):arrowOld?t-1:t,strong=arrowT===T&&ph!=='ret'&&(t===1?r>=4:full?r>=5:!arrowOld),c=contexts[arrowT-1];
 // 内積＝文脈ベクトルの向きへの射影。スコアを出した後は、省略する手も含めて現在の矢印に対して表示する。
 const feetOn=c&&strong&&ph!=='ret'&&!(t===1&&r<R.proj)&&!arrowOnly;
 if(feetOn)embedding.forEach((e,i)=>{const d=e[0]*c[0]+e[1]*c[1],[px,py]=sp(e),[fx,fy]=sp([c[0]*d,c[1]*d]);s+=keyed(`foot-${i}`,line(px.toFixed(1),py.toFixed(1),fx.toFixed(1),fy.toFixed(1),'#8a9aa8',true,1.5),`opacity="${faded.has(i)?.3:1}"`);});
 embedding.forEach((e,i)=>{const [x,y]=sp(e);s+=keyed(`pt-${i}`,dot(x,y,label(i),dark,15),`opacity="${faded.has(i)?.25:1}"`);});
 if(markEmbedding){const [x,y]=sp(embedding[cur]);s+=keyed('pt-cur',circle(0,0,23,'none',C.accent,'stroke-width="3"'),`transform="translate(${x} ${y})"`);}
 // 次の都市へ進んだら、前の手の矢印は消す。
 if(arrowT&&strong){s+=arrow(c,strong,arrowT);if((t===1&&(ph==='proj'||ph==='score'))||(full&&t>=2&&ph==='score')){const [tx,ty]=sp([c[0]*1.15,c[1]*1.15]);s+=keyed(`link-${T}`, line(X[0]+20,X[1],(tx-6).toFixed(1),(ty+4).toFixed(1),C.AB,true,2));}}
 if(t===1&&ph==='proj')s+=message('projection-note',570,410,516,30,C.AB,
  messageText(584,433,'作った評価軸で埋め込みとの内積を取る',26,C.AB));
 return svg(s,'queryから文脈ベクトルを作り、埋め込みとの内積で次の都市を選ぶ');
}
export default {id:'A02',title:'Attention Modelのデコーダー',steps:S.map(stepName),
 renderStep(k){return scene(S[k]);},
 transition(from,to){if(to!==from+1)return null;const {t,ph}=S[to],f=(o,d,st=S[to])=>({markup:scene(st,o),duration:d}),g=p=>(o,d)=>f(o,d,{t,ph:p});
  if(ph==='copy')return [f({copyFrame:'appear'},350),f({copyFrame:'moved'},750),f({},400)];
  if(ph==='attn')return [f({attnFrame:'line'},500),f({attnFrame:'gather'},600),f({attnFrame:'arrive'},800),f({attnFrame:'merge'},550),f({},350)];
  if(ph==='proj')return [f({arrowOnly:true},700),f({},750)];
  if(ph==='score')return [f({},900)];
  if(ph==='select'&&t===1)return [f({noSelect:true},250),f({},650)];
  if(ph==='update')return [f({updatePending:true},250),f({},850)];
  // 2・3手目：queryの更新 → cross attention → 内積 → 地図のスコア → softmax を止めずに続ける。−∞のマスクは2手目まで見せる。
  if(ph==='prob'&&t>=2&&t<=3){const copy=g('copy'),attn=g('attn'),score=g('score');
   return [copy({copyFrame:'appear'},300),copy({copyFrame:'moved'},650),copy({},300),
    attn({attnFrame:'line'},400),attn({attnFrame:'gather'},500),attn({attnFrame:'arrive'},700),attn({attnFrame:'merge'},450),attn({},250),
    score({barsOff:true},650),score({barsOff:true,scoreFrame:'space'},550),score({},850),
    ...(t===2?[f({maskFrame:true},750)]:[]),f({},650)];}
  if(ph==='prob'&&t>=4)return [f({copyFrame:'appear',arrowOld:true,barsOff:true},350),f({copyFrame:'moved',arrowOld:true,barsOff:true},700),f({barsOff:true},750),f({},650)];
  if(ph==='select'&&t===5)return [f({copyFrame:'appear',arrowOld:true,barsOff:true,noSelect:true},350),f({copyFrame:'moved',arrowOld:true,barsOff:true,noSelect:true},700),f({barsOff:true,noSelect:true},750),f({noSelect:true},600),f({},650)];
  return null;}};
