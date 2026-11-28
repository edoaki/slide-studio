// 編集画面の左右の欄（原稿・チャット）の幅。中央のスライドに最低限の幅を残し、窓が狭いときは欄の方を縮める。
export const PANEL_LIMITS = Object.freeze({ editorMin: 260, chatMin: 300, center: 340, share: 0.6 });

// 好みの幅（editor・chat）を窓の幅 total に収めた、実際に当てる幅を返す。閉じている欄は 0。
// まず両方の欄を最小幅まで縮め、それでも入らなければ（拡大表示など）両方を同じ割合で縮める。
export function fitPanelWidths({ total, editor, chat, editorOn = true, chatOn = true }, limits = PANEL_LIMITS) {
  let e = editorOn ? Math.max(limits.editorMin, Number(editor) || limits.editorMin) : 0;
  let c = chatOn ? Math.max(limits.chatMin, Number(chat) || limits.chatMin) : 0;
  const room = Math.max(0, total - limits.center);
  let over = e + c - room;
  if (over > 0) {
    const eSlack = editorOn ? e - limits.editorMin : 0, cSlack = chatOn ? c - limits.chatMin : 0, slack = eSlack + cSlack;
    if (slack > 0) {
      const k = Math.min(1, over / slack);
      e -= eSlack * k; c -= cSlack * k; over -= slack * k;
    }
    if (over > 0.5 && e + c > 0) { const k = room / (e + c); e *= k; c *= k; }
  }
  return { editor: Math.floor(e), chat: Math.floor(c) };
}

// 片方の欄をドラッグ・キーで広げられる範囲。other はもう片方の欄に今当てている幅（閉じていれば 0）
export function panelRange(which, { total, other }, limits = PANEL_LIMITS) {
  const min = which === 'editor' ? limits.editorMin : limits.chatMin;
  const max = Math.floor(Math.min(total * limits.share, total - limits.center - other));
  return { min, max: Math.max(min, max) };
}
