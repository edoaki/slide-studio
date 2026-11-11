// F21〜F23共通。5都市の地図を同じ位置・縮尺で描く（viewBox 900×560の左側）。
import {text,C,keyed} from './draw.mjs';
import {tspCases} from './tsp-cities.mjs';
export const P=tspCases[0].cities;
export const W=900,H=560;
export const label=i=>String(i+1);
const S=560,X0=-15,Y0=-12,f=v=>+v.toFixed(1);
export const at=([x,y])=>[f(X0+x*S),f(Y0+y*S)];

// 辺はキーを都市の組で決める（同じ辺は段階をまたいで同じ要素として残る）。線は a から b へ伸びる。
export function edge(a,b,{key,color=C.accent,width=6,dash=false,opacity=1,shorten=0}={}){
 let [x1,y1]=at(P[a]),[x2,y2]=at(P[b]);
 if(shorten){const L=Math.hypot(x2-x1,y2-y1),t=shorten/L;[x1,y1,x2,y2]=[x1+(x2-x1)*t,y1+(y2-y1)*t,x2-(x2-x1)*t,y2-(y2-y1)*t].map(f);}
 return keyed(key??`e-${a<b?a:b}-${a<b?b:a}`,`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${dash?'stroke-dasharray="10 9"':''}/>`,`opacity="${opacity}"`);}
export const mid=(a,b)=>{const [x1,y1]=at(P[a]),[x2,y2]=at(P[b]);return [f((x1+x2)/2),f((y1+y2)/2)];};

// 都市。出発都市（0番）は角丸の四角、他は円。番号は1から。
export function cities({stroke=()=>C.ink,fill=()=>C.paper}={}){
 return P.map((p,i)=>{const [x,y]=at(p),s=stroke(i),bg=fill(i);
  return keyed(`city-${i}`,(i===0?`<rect x="${f(x-24)}" y="${f(y-24)}" width="48" height="48" rx="6" fill="${bg}" stroke="${s}" stroke-width="3.5"/>`:`<circle cx="${x}" cy="${y}" r="24" fill="${bg}" stroke="${s}" stroke-width="3.5"/>`)+text(x,f(y+9),label(i),26,bg===C.paper?C.ink:C.paper,'middle'));}).join('');}
