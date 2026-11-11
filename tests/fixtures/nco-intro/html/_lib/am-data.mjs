// F02・A01〜A03共通。Attention Modelの説明に使う6都市の固定データ（模式例、実測ではない）。
// 座標は0〜1、yは画面下向き。添字iの都市を「都市i+1」と表示し、出発都市は都市1（添字0）に固定する。
export const cities=[[.12,.50],[.68,.10],[.65,.88],[.30,.15],[.28,.82],[.90,.45]];
export const label=i=>String(i+1);
export const start=0;
export const distance=(a,b)=>Math.hypot(cities[a][0]-cities[b][0],cities[a][1]-cities[b][1]);
export const tourLength=r=>r.slice(1).reduce((s,n,i)=>s+distance(r[i],n),0);
// A02でデコーダーが作る経路（添字）：1→4→2→6→3→5→1。
export const decodedRoute=[0,3,1,5,2,4,0];
// A03の学習例。baselineは固定したモデルが確率最大の都市を選び続けた経路。1回目は長いサンプル、2回目は短いサンプル。
export const baselineRoute=[0,3,5,1,2,4,0];
export const sampledRoutes=[[0,1,3,4,2,5,0],[0,3,1,5,2,4,0]];
