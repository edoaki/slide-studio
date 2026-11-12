export type Limits = Partial<Record<'five_hour' | 'weekly', {used: number; resets: number | null}>>;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function codexLimits(value: unknown): Limits {
  const snapshot=record(value), result:Limits={};
  for(const [index,name] of ['primary','secondary'].entries()) {
    const window=record(snapshot[name]);if(typeof window.usedPercent!=='number'||!Number.isFinite(window.usedPercent))continue;
    const minutes=typeof window.windowDurationMins==='number'?window.windowDurationMins:index?10080:300;
    result[minutes<=1440?'five_hour':'weekly']={used:window.usedPercent,resets:typeof window.resetsAt==='number'?window.resetsAt:null};
  }
  return result;
}
export function claudeLimits(value: unknown): Limits {
  const info=record(value), windows=record(info.unifiedWindows || (typeof info.rateLimitType==='string'?{[info.rateLimitType]:info}:{})),result:Limits={};
  for(const [name,key] of [['five_hour','five_hour'],['seven_day','weekly']] as const) {
    const window=record(windows[name]);if(typeof window.utilization!=='number'||!Number.isFinite(window.utilization))continue;
    result[key]={used:Math.round(window.utilization*100),resets:typeof window.resetsAt==='number'?window.resetsAt:null};
  }
  return result;
}
