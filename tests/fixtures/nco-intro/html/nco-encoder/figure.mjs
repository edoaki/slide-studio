import {svg,text,line,rect,C,keyed,mapFrame,note} from '../_lib/draw.mjs';
import {cities,label} from '../_lib/am-data.mjs';
// Attention Model [Kool et al. 2019, §3.1] のエンコーダー。座標→128次元→Transformer block×3。
// 注意の重みは説明用：都市間距離から作るsoftmax（ブロックごとに温度を変える）。実ネットワークの値ではない。
const N=cities.length,ty=i=>100+i*58,col=[350,565,775,985],blocks=[[395,525],[605,735],[815,945]],split=80;
const fills=['#dce7f1','#a8c2dc','#6d9bc6','#2f6aa3'],inks=[C.ink,C.ink,'#fff','#fff'];
const at=([x,y])=>[50+x*210,115+y*210];
export const weights=[3.5,2.5,1.8].map(T=>cities.map(a=>{const e=cities.map(b=>Math.exp(-T*Math.hypot(a[0]-b[0],a[1]-b[1])));const z=e.reduce((p,q)=>p+q);return e.map(v=>v/z);}));
const circle=(x,y,r,fill,stroke='none',extra='')=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" ${extra}/>`;
const token=(x,y,i,layer)=>circle(x,y,18,fills[layer],'#5f87ad','stroke-width="1.5"')+text(x,y+6,label(i),17,inks[layer],'middle');
const ghost=(x,y)=>circle(x,y,18,'none','#c3ccd4','stroke-width="1.5" stroke-dasharray="4 4"');
// 内部の進行p：0 地図、1 座標を取り出す、2 列に並べる、3 128次元。ブロックbはfrom=4+5bから、入口の線、相互作用、FFN、出口の線、出力の順に1つずつ描く。
const P=[0,2,3,8,13,18],dur=[250,750,550,250,350];
function scene(p,{step=P.indexOf(p)}={}){
 let s=text(20,70,'入力問題',22)+mapFrame(20,85,270,270);
 cities.forEach((c,i)=>{const [x,y]=at(c);s+=keyed(`city-${i}`,circle(x,y,18,C.paper,C.ink,'stroke-width="2.5"')+text(x,y+6,label(i),17,C.ink,'middle'));});
 s+=keyed('head-xy',text(col[0],56,'座標 (x, y)',17,C.muted,'middle'),`opacity="${p>=1&&p<3?1:0}"`);
 s+=keyed('head-128',text(col[0],56,'128次元',17,C.muted,'middle'),`opacity="${p>=3?1:0}"`);
 s+=keyed('head-emb',text(col[3],56,'埋め込み',19,C.ink,'middle'),`opacity="${p>=18?1:0}"`);
 blocks.forEach(([x0,x1],b)=>{const mid=x0+split,from=4+5*b,active=p>=from&&p<=from+4;
  s+=keyed(`block-${b}`,rect(x0,72,x1-x0,352,'#f4eee6','#dccbb5')+text((x0+x1)/2,30,'Transformer',16,C.ink,'middle')+text((x0+x1)/2,50,`block ${b+1}`,16,C.ink,'middle')+text(x0+split/2,417,'Attention',14,C.muted,'middle')+text(mid+(x1-mid)/2,417,'FFN',14,C.muted,'middle'));
  if(p>=from)for(let i=0;i<N;i++)s+=keyed(`in-${b}-${i}`,line(col[b]+18,ty(i),x0,ty(i),'#8a9aa8',false,2));
  if(p>=from+1){for(let i=0;i<N;i++){for(let j=0;j<N;j++)s+=keyed(`att-${b}-${i}-${j}`,line(x0,ty(i),mid,ty(j),'#b8742f',false,(.4+weights[b][j][i]*7).toFixed(2)),`opacity="${active?.75:.14}"`);}}
  if(p>=from+2)for(let j=0;j<N;j++)s+=keyed(`ffn-${b}-${j}`,line(mid,ty(j),x1,ty(j),'#2f6aa3',false,3),`opacity="${active?1:.45}"`);
  if(p>=from+3)for(let j=0;j<N;j++)s+=keyed(`out-${b}-${j}`,line(x1,ty(j),col[b+1]-18,ty(j),'#8a9aa8',false,2));
 });
 for(let c=0;c<4;c++)for(let i=0;i<N;i++){const shown=p>=3+5*c;s+=shown?keyed(`tok-${c}-${i}`,token(col[c],ty(i),i,c)):keyed(`ghost-${c}-${i}`,ghost(col[c],ty(i)));}
 s+=keyed('emb-frame',`<rect x="${col[3]-28}" y="${ty(0)-28}" width="56" height="${ty(N-1)-ty(0)+56}" rx="12" fill="none" stroke="${C.ink}" stroke-width="2"/>`,`opacity="${p>=18?1:0}"`);
 cities.forEach((c,i)=>{const [x,y]=p<=1?at(c):[col[0],ty(i)];s+=keyed(`chip-${i}`,rect(-46,-15,92,30,C.paper,'#9aa7b3')+text(0,6,`(${c[0].toFixed(2)}, ${c[1].toFixed(2)})`,14,C.ink,'middle'),`transform="translate(${x} ${y})" opacity="${p===1||p===2?1:0}"`);});
 // 注記（地図の下）：block 1の相互作用が出てから、Attentionで何をしているかを示す。block 2・3は同じ処理。
 if(step===2)s+=note('note-coordinate',14,362,318,[{t:'2次元座標 (x, y) を',size:26,weight:700},{t:'128次元にする',size:26}],'#2f6aa3');
 if(step===3)s+=note('note-block',14,362,318,[{t:'都市同士のself Attention',size:24,weight:500},{t:'他の都市との関係を',size:24},{t:'埋め込みに反映',size:24}],'#b8742f');
 return svg(s,'各都市をトークンとしてTransformer blockに3回通し、埋め込みを作る',1100,490);
}
export default {id:'A01',title:'Attention Modelのエンコーダー',steps:['入力問題の6都市','都市を座標のトークンとして取り出す','128次元のベクトルへ変換','Transformer block 1','Transformer block 2','Transformer block 3を通って埋め込みが完成'],
 renderStep(k){return scene(P[k]);},
 transition(from,to){if(to!==from+1)return null;const frames=[];for(let p=P[from]+1;p<=P[to];p++)frames.push({markup:scene(p,{step:to}),duration:p===1?350:p>=4?dur[(p-4)%5]:650});return frames;}};
