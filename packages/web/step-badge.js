// 単独の番号は CSS の丸で囲む。範囲は読みやすい通常の数字で表す。
export const circledStep = n => n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : n >= 21 && n <= 35 ? String.fromCodePoint(0x3251 + n - 21) : n >= 36 && n <= 50 ? String.fromCodePoint(0x32b1 + n - 36) : `(${n})`;
export const stepLabel = (first, last = first) => last > first ? `${first}–${last}` : String(first);

// 同じ段にある図の送る回数。未読み込み・別オリジンは 0 として扱う。
export function figureSteps(elements) {
  let n = 0;
  for (const el of elements) for (const f of el.matches('iframe') ? [el] : el.querySelectorAll('iframe')) {
    try { const steps = f.contentWindow?.animation?.steps; if (Number.isInteger(steps) && steps > n) n = steps; } catch { /* 未読み込み・別オリジン */ }
  }
  return n;
}
