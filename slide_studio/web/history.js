// 発表を開いている間の共通履歴。失敗した操作は同じ位置に残す。
import { toast } from './api.js';

export function makeHistory(ctx, capture, restore) {
  let pending = Promise.resolve();
  const record = entry => {
    ctx.history.push(entry);
    if (ctx.history.length > 300) ctx.history.shift();
    ctx.future = []; ctx.lastPush = 0; ctx.showStatus();
  };
  async function travel(back) {
    if (ctx.locked || ctx.historyBusy) return;
    ctx.historyBusy = true;
    ctx.showStatus();
    try {
      // スライド上に残った入力も、取り消す前に履歴へ確定する。
      if (!await ctx.flush()) return;
      const from = back ? ctx.history : ctx.future, to = back ? ctx.future : ctx.history;
      const entry = from.at(-1); if (!entry) return;
      let inverse;
      if (entry.undo) await (back ? entry.undo() : entry.redo());
      else { inverse = capture(); restore(entry); }
      from.pop(); to.push(inverse || entry); ctx.lastPush = 0;
    } catch (e) { toast(e.message); }
    finally { ctx.historyBusy = false; ctx.showStatus(); }
  }
  ctx.recordHistory = record;
  const enqueue = back => (pending = pending.then(() => travel(back)));
  return { undo: () => enqueue(true), redo: () => enqueue(false) };
}
