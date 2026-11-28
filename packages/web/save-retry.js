// 自動保存の再試行（指数バックオフ）。失敗が続いたら止めて、利用者の再試行を待つ。
export const SAVE_RETRY_DELAYS = Object.freeze([1000, 2000, 4000, 8000]);

// failures：続けて失敗した回数（今回を含む）。次の再試行までの待ち時間（ms）、止めるなら null。
// 503 はアプリの終了中なので再試行しない。
export function saveRetryDelay(failures, status) {
  if (status === 503 || !(failures >= 1)) return null;
  return SAVE_RETRY_DELAYS[failures - 1] ?? null;
}
