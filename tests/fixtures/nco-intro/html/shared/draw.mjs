export const C={ink:'#233244',muted:'#667483',accent:'#ae641a',light:'#e8edf1',paper:'#ffffff',A:'#bb4545',B:'#326fa9',C:'#348064',AB:'#8353a4'};
export const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export const text=(x,y,s,size=23,color=C.ink,anchor='start')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${esc(s)}</text>`;
export const line=(x,y,X,Y,color=C.ink,dash=false,width=3)=>`<line x1="${x}" y1="${y}" x2="${X}" y2="${Y}" stroke="${color}" stroke-width="${width}" ${dash?'stroke-dasharray="9 7"':''}/>`;
export const rect=(x,y,w,h,fill=C.light,stroke='none')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${fill}" stroke="${stroke}"/>`;
export const node=(x,y,id,color=C.ink)=>`<circle cx="${x}" cy="${y}" r="22" fill="${C.paper}" stroke="${color}" stroke-width="3"/>${text(x,y+8,id,21,color,'middle')}`;
// x0・y0は表示範囲の左上。内容の範囲に切り詰めて、埋め込み先の枠いっぱいに表示するときに使う。
export const svg=(body,label='模式例',w=1100,h=440,x0=0,y0=0)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" role="img" aria-label="${esc(label)}"><style>text{font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif}*{box-sizing:border-box}</style><rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${C.paper}"/>${body}</svg>`;
export const cities=[[95,275,'O'],[205,130,'1'],[390,105,'2'],[420,310,'3'],[250,355,'4']];
export const map=(path=[],points=cities)=>path.slice(1).map((p,i)=>line(...points[path[i]].slice(0,2),...points[p].slice(0,2),C.accent,false,5)).join('')+points.map(p=>node(...p)).join('');
export const d1=[[95,325,'O'],[355,325,'X'],[95,100,'Y']];
export function axis(y,max=12,x=600,w=440){return line(x,y,x+w,y,C.muted,false,1)+Array.from({length:7},(_,i)=>text(x+i*w/6,y+30,(i*max/6).toFixed(Number.isInteger(max/6)?0:1),17,C.muted,'middle')).join('');}
export function timeline(y,{label='',window=[0,4],arrival=null,start=null,service=0,max=12,x=600,w=440}){const at=t=>x+t/max*w;return text(x-20,y-14,label,21,C.ink,'end')+axis(y,max,x,w)+rect(at(window[0]),y-35,(window[1]-window[0])*w/max,14,'#cbd5df')+text((at(window[0])+at(window[1]))/2,y-46,`窓 [${window}]`,18,C.muted,'middle')+(arrival===null?'':`<path d="M ${at(arrival)} ${y-3} l -7 -12 h 14 Z" fill="${arrival>window[1]?C.A:C.accent}"/>`)+(start===null?'':line(at(start),y-27,at(start),y+7,C.ink,false,3))+(start>arrival?line(at(arrival),y-9,at(start),y-9,C.accent,true,3):'')+(service?rect(at(start),y+4,service*w/max,12,C.accent):'');}
export const keyed=(key,body,attrs='')=>`<g data-key="${key}" ${attrs}>${body}</g>`;
export const coordinate=(x,y,label)=>keyed(`coordinate-${x}-${y}`,rect(x-49,y-20,98,27,C.paper,'#b5c0ca')+text(x,y,label,16,C.muted,'middle'));
export const mapFrame=(x,y,w,h)=>`<rect data-key="map-frame-${x}" x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#98a5b1" stroke-width="1.5"/>`;
export function routeObjects(points,route,count,color=C.accent,key='route'){
 let s='';for(let j=1;j<route.length;j++){const a=points[route[j-1]],b=points[route[j]],t=Math.max(0,Math.min(1,count-j+1));s+=keyed(`${key}-edge-${j}`,line(a[0],a[1],a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,color,false,4),`opacity="${count>=j-1?1:0}"`);}
 const i=Math.min(route.length-1,Math.floor(count)),a=points[route[i]],b=points[route[Math.min(i+1,route.length-1)]],t=count-i;
 s+=keyed(`${key}-traveler`,`<circle r="8" fill="${color}" stroke="white" stroke-width="2"/>`,`transform="translate(${a[0]+(b[0]-a[0])*t} ${a[1]+(b[1]-a[1])*t})"`);return s;
}
// 数式の文字列：英字は斜体（演算名は立体）、_{…}は添字、^{…}は上付き。添字と上付きが続くときは縦に重ねる。
// 補間で子要素を照合するため、文字はすべて末端のtspanに入れる。日本語は本文の書体にする。
const upright=/^(MHA|LN|IN|FFN|concat|softmax|AA|TT|AT|TA)$/,ja=/[\u3000-\u9fff\uff00-\uffef]/;
// 添字を重ねるときの幅の見積もり（Times、1em比）。英字は斜体の幅。
const W1={a:.5,b:.5,c:.444,d:.5,e:.444,f:.278,g:.5,h:.5,i:.278,j:.278,k:.444,l:.278,m:.722,n:.5,o:.5,p:.5,q:.5,r:.389,s:.389,t:.278,u:.5,v:.444,w:.667,x:.444,y:.444,z:.389,A:.611,D:.722,E:.611,K:.667,O:.722,P:.611,T:.556,W:.833,'(':.333,')':.333,',':.25,'.':.25,'+':.564,'=':.564,'ℓ':.417,'′':.219,'…':1,' ':.25};
const glyphW=ch=>W1[ch]??(/[\u0300-\u036f]/.test(ch)?0:.5);
export function math(x,y,src,size=22,color=C.ink,anchor='start',weight=400){
 let s='',cur=0,last=null,lastW=0,extra=0;
 src.split(/([_^](?:\{[^}]*\}|[^\s{]))/).filter(Boolean).forEach(p=>{
  const script=/^[_^]/.test(p)?p[0]:null,body=script?(p[1]==='{'?p.slice(2,-1):p.slice(1)):p,fs=script?Math.round(size*.7):size;
  const target=script==='_'?size*.3:script==='^'?-size*.38:0,width=script?[...body].reduce((a,ch)=>a+glyphW(ch),0)*fs+1.5:0,stack=script&&last&&last!==script;
  // 重ねた添字の後は、長い方の幅まで送る。
  let dx=stack?-lastW:extra;extra=stack?Math.max(0,lastW-width):0;
  body.split(/([A-Za-z]+|[\u3000-\u9fff\uff00-\uffef]+)/).filter(Boolean).forEach(run=>{const dy=target-cur;cur=target;
   const style=ja.test(run)?` style="font-family:'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif"`:'',it=/^[A-Za-z]+$/.test(run)&&!upright.test(run);
   s+=`<tspan${dx?` dx="${dx.toFixed(1)}"`:''} dy="${dy.toFixed(1)}" font-size="${fs}" font-style="${it?'italic':'normal'}"${style}>${esc(run)}</tspan>`;dx=0;});
  last=stack?null:script;lastW=width;
 });
 return `<text x="${x}" y="${y}" fill="${color}" text-anchor="${anchor}" font-weight="${weight}" style="font-family:'Times New Roman',Times,serif">${s}</text>`;
}
// 段階の解釈を示す注記。対象の色の淡い帯と左端の線で、常設のラベルと区別する。
// linesは1行目に操作、2行目以降に解釈や式を置く。'$'で始まる行は数式として組む。行は文字列か{t,size,weight}。
// rightは表示範囲の右端。切り詰めた・広げたviewBoxでも枠が右端からはみ出さないよう左へ寄せる。
export function note(key,x,y,w,lines,color=C.accent,o=1,right=1100){
 // 中立色の説明も、文字・左線・背景を同じ青で示す。
 if(['#233244','#000','#000000','black',C.muted].includes(color))color=C.B;
 // 枠は内容の長さも考慮する。式は添字の大きさと演算名の立体字を含めて見積もる。
 const widths=lines.map((l,j)=>{const {t,size=j?26:24}=typeof l==='string'?{t:l}:l;
  if(!t.startsWith('$'))return [...t].reduce((a,ch)=>a+(ja.test(ch)?1:/[MW]/.test(ch)?.85:/[il., ]/.test(ch)?.3:.6)*size,0);
  return t.slice(1).split(/([_^](?:\{[^}]*\}|[^\s{]))/).filter(Boolean).reduce((a,p)=>{
   const script=/^[_^]/.test(p),body=script?(p[1]==='{'?p.slice(2,-1):p.slice(1)):p;
   return a+[...body].reduce((b,ch)=>b+(ja.test(ch)?1:glyphW(ch)),0)*size*(script?.7:1);
  },0);
 });
 w=Math.ceil(Math.max(...widths)*1.06+36);x=Math.min(x,right-w-10);
 let body='',by=y,last=0,lastMath=false;
 lines.forEach((l,j)=>{const {t,size=j?26:24,weight=j?700:500}=typeof l==='string'?{t:l}:l,m=t.startsWith('$'),c=t.slice(m?1:0);
  // 数式の添字が下の行に掛からないよう、数式の次の行は広めに送る。
  by+=j?Math.max(size,last)*(lastMath?1.55:1.4):size+10;last=size;lastMath=m;
  body+=m?math(x+16,by.toFixed(1),c,size,color,'start',weight):`<text x="${x+16}" y="${by.toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(c)}</text>`;});
 const h=by+last*(lastMath?.65:.55)-y;
 return keyed(key,`<rect x="${x}" y="${y}" width="${w}" height="${h.toFixed(1)}" fill="${color}" fill-opacity=".08"/><rect x="${x}" y="${y}" width="4" height="${h.toFixed(1)}" fill="${color}"/>`+body,`opacity="${o}"`);
}
