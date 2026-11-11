import {svg,text,line,rect,C,keyed,mapFrame,routeObjects} from '../_lib/draw.mjs';
// 説明用の固定データ。配送先6か所と、軸・歯車・金具を3設備で加工するジョブショップの一例。
const depot=[100,262],stops=[[235,205],[175,105],[305,85],[440,120],[455,250],[330,272]];
const points=[depot,...stops],route=[0,1,2,3,4,5,6,0];
const house=([x,y],i)=>keyed(`house-${i}`,`<path d="M ${x-15} ${y+12} v -15 l 15 -13 l 15 13 v 15 Z" fill="${C.paper}" stroke="${C.ink}" stroke-width="2.5"/>`);
const textY=[362,392,422];
function delivery(count){let s=text(40,32,'配送経路',26);
 s+=mapFrame(40,48,470,252);
 for(const x of [130,240,350,460])s+=line(x,48,x,300,C.light,false,8);
 for(const y of [110,190,260])s+=line(40,y,510,y,C.light,false,8);
 s+=routeObjects(points,route,count,C.accent,'route');
 s+=keyed('depot',rect(depot[0]-26,depot[1]-20,52,40,C.ink)+text(depot[0],depot[1]+8,'倉庫',18,C.paper,'middle'));
 stops.forEach((p,i)=>s+=house(p,i));
 return s+text(40,textY[0],'決めるもの：訪問する順番',22)+text(40,textY[1],'制約：全地点を1回ずつ訪問',21,C.muted)+text(40,textY[2],'目的：総移動距離の最小化',21,C.muted);}
// 問題の入力：jobs[j]=[[機械, 処理時間], ...]。各作業は配列の順に工程を処理し、どの工程をどの機械で処理するかは問題側で決まっている。
// 決めるもの：machineOrder[m]＝機械mで作業を処理する順番。開始時刻はこの順番から、前の工程と機械の前の作業がともに終わった時刻として決まる。
// 216通りの順番を総当たりすると、完了時刻の最小は10でこの順番だけが達成する（tests/data.mjs）。下限9（機械Aの処理時間の合計）より大きく、待ちを避けられない。
export const jobs=[[[1,2],[0,3],[2,2]],[[1,2],[2,2],[0,3]],[[0,3],[2,4],[1,2]]];
export const machineOrder=[[2,0,1],[1,0,2],[1,2,0]];
export function plan(order=machineOrder){
 const start=jobs.map(o=>o.map(()=>null)),next=jobs.map(()=>0),pos=[0,0,0],machineFree=[0,0,0],jobFree=jobs.map(()=>0);let left=jobs.flat().length;
 while(left){let moved=false;
  order.forEach((seq,m)=>{const j=seq[pos[m]];if(j===undefined)return;const k=next[j];if(jobs[j][k]?.[0]!==m)return;
   start[j][k]=Math.max(machineFree[m],jobFree[j]);machineFree[m]=jobFree[j]=start[j][k]+jobs[j][k][1];next[j]++;pos[m]++;left--;moved=true;});
  if(!moved)return null;}
 return {start,makespan:Math.max(...jobFree)};}
const {start,makespan}=plan(),ready=jobs.map((o,j)=>o.map((_,k)=>k?start[j][k-1]+o[k-1][1]:0));
const color=[C.A,C.B,C.C],machine=['旋削','切削','穴あけ'],products=['軸','歯車','金具'],x0=680,unit=36,gap=24,poolY=r=>50+r*38,rowY=r=>176+r*44,axisY=rowY(2)+48;
const poolX=(j,k)=>x0+jobs[j].slice(0,k).reduce((s,[,d])=>s+d,0)*unit+k*gap;
// 開始時刻の早い順（同時刻は機械順）に1つずつ配置する。
const order=jobs.flatMap((ops,j)=>ops.map(([m],k)=>({j,k,m,t:start[j][k]}))).sort((a,b)=>a.t-b.t||a.m-b.m).map(o=>`${o.j}-${o.k}`);
function schedule(placed){let s=text(580,32,'金属部品の加工順',26);
 if(placed)s+=keyed('wait-legend',line(906,26,946,26,C.ink,true,2.5)+text(956,32,'機械の空き待ち',18,C.muted));
 for(let r=0;r<3;r++)s+=text(x0-12,poolY(r)+22,products[r],20,color[r],'end')+text(x0-12,rowY(r)+22,machine[r],20,C.ink,'end')+rect(x0,rowY(r),makespan*unit,30,C.light);
 s+=line(x0,axisY,x0+makespan*unit,axisY,C.muted,false,1.5)+[0,2,4,6,8,10].map(t=>text(x0+t*unit,axisY+22,t,17,C.muted,'middle')).join('')+text(x0+makespan*unit+10,axisY+6,'時間',17,C.muted);
 jobs.forEach((ops,j)=>ops.forEach(([m,d],k)=>{const px=poolX(j,k),y=poolY(j);
  if(k)s+=`<path d="M ${px-gap+5} ${y+15} h ${gap-12} m -6 -5 l 6 5 l -6 5" fill="none" stroke="${C.muted}" stroke-width="2"/>`;
  if(order.indexOf(`${j}-${k}`)<placed)s+=keyed(`slot-${j}-${k}`,`<rect x="${px+1}" y="${y}" width="${d*unit-2}" height="30" rx="5" fill="none" stroke="${color[j]}" stroke-width="1.5" stroke-dasharray="4 3"/>`+text(px+d*unit/2,y+22,machine[m],18,color[j],'middle'));}));
 jobs.forEach((ops,j)=>ops.forEach(([m,d],k)=>{const on=order.indexOf(`${j}-${k}`)<placed,x=on?x0+start[j][k]*unit:poolX(j,k),y=on?rowY(m):poolY(j);
  if(on&&start[j][k]>ready[j][k])s+=keyed(`wait-${j}-${k}`,line(x0+ready[j][k]*unit+2,y+37,x0+start[j][k]*unit-2,y+37,color[j],true,3));
  // 箱と文字は同じ座標系で移動する。工程名と品目名は別の文字要素として切り替える。
  s+=keyed(`op-${j}-${k}`,rect(1,0,d*unit-2,30,color[j])+keyed(on?'product-label':'machine-label',text(d*unit/2,22,on?products[j]:machine[m],18,C.paper,'middle'),'data-no-fade="true"'),`transform="translate(${x} ${y})"`);}));
 return s+text(580,textY[0],'決めるもの：各設備で加工する品目の順番',22)+text(580,textY[1],'制約：加工の順序、設備は同時に1品目',21,C.muted)+text(580,textY[2],'目的：全品目の完了時刻を早める',21,C.muted);}
const scene=(k,count=k>=1?route.length-1:0,placed=k>=2?order.length:0)=>svg(delivery(count)+line(550,48,550,422,C.light,false,2)+schedule(placed),'配送経路とスケジューリング');
export default {id:'F12',title:'配送経路とスケジューリング',steps:['配送先と作業','訪問順を決める','各機械の処理順を決める'],renderStep(k){return scene(k);},
 transition(from,to){if(from===0&&to===1)return route.slice(1).map((_,i)=>({markup:scene(1,i+1),duration:130}));if(from===1&&to===2)return order.map((_,i)=>({markup:scene(2,undefined,i+1),duration:210}));return null;}};
