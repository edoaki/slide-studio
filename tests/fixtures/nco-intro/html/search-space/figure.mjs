import {svg,text,rect,C,keyed,mapFrame} from '../_lib/draw.mjs';
import {tspCases as cases} from '../_lib/tsp-cities.mjs';
// 先頭を出発都市とし、残りN−1都市の並べ方を(N−1)!通りと数える。
function panel({n,count,cities},j){const x0=185+j*480,w=250,h=250,y0=60,cx=x0+w/2,at=([u,v])=>[x0+25+u*(w-50),y0+25+v*(h-50)];
 let s=text(cx,40,`都市 ${n}個`,26,C.ink,'middle')+mapFrame(x0,y0,w,h);
 cities.forEach((p,i)=>{const [x,y]=at(p);s+=keyed(`city-${n}-${i}`,i?`<circle cx="${x}" cy="${y}" r="10" fill="${C.B}"/>`:rect(x-12,y-12,24,24,C.accent)+text(x,y+38,'出発',18,C.accent,'middle'));});
 return s+`<text x="${cx}" y="375" text-anchor="middle"><tspan font-size="32" fill="${C.muted}">(${n}−1)! = </tspan><tspan font-size="40" fill="${C.ink}">${count}</tspan><tspan dx="10" font-size="24" fill="${C.muted}">通り</tspan></text>`;}
// 候補数の桁数による自動切り詰めを避け、左右の列と外側の余白を対称に保つ。
export default {id:'F01',title:'都市数と経路の候補数',fit:false,steps:['都市数と経路の候補数'],renderStep(){return svg(cases.map(panel).join(''),'都市数と経路の候補数',1100,395);}};
