// レイアウトの検査（設計書 §9.3）。書き出しの検査（check.py）と編集画面（inject/lint.js）が同じ判定を使う。
// 元：quarto-html scripts/slides.py の LAYOUT。check.py は行頭の export を外して関数の中に入れて評価するので、import は書かない。
// 座標はスライドの左上を原点とする 1280×720 の目盛り（図の中を測るときは、図の iframe の位置 dx・dy を足したページの座標）。

export const EDGE = 2;    // スライド・左右の余白をこの px を超えて越えたら
export const OVERLAP = 3; // 文字・要素どうしがこの px を超えて重なったら

// opt：dx・dy（図の iframe の位置）、frame（図の中を測る）、root（測るページ。既定は表示中のページ）、
// allSteps（step で後から出る、いまは隠れている中身も含める。隠れていても場所は取るため）
export function layoutIssues(opt = {}) {
  const frame = !!opt.frame, dx = opt.dx || 0, dy = opt.dy || 0;
  const root = opt.root || document.querySelector('.slide.active') || document.body;
  const rb = root.getBoundingClientRect(), k = frame ? 1 : rb.width / root.offsetWidth || 1;
  const ox = frame ? 0 : rb.left, oy = frame ? 0 : rb.top;
  // 縮小表示の座標を戻す際の誤差で、許容値ちょうどの位置をはみ出しと判定しない。
  const px = n => Math.round(n * 1000) / 1000;
  const norm = r => ({ l: px((r.left - ox) / k), t: px((r.top - oy) / k), r: px((r.right - ox) / k), b: px((r.bottom - oy) / k) });
  const box = e => norm(e.getBoundingClientRect());
  // 文字の要素は、文字が実際にある範囲（段落の箱は行の右端や行間の空いた所も含むため。重なりは見える文字で判定する）
  const ink = e => {
    if (!/^(P|LI|H[1-6])$/.test(e.tagName)) return box(e);
    const r = document.createRange(); r.selectNodeContents(e);
    const b = r.getBoundingClientRect();
    return b.width ? norm(b) : box(e);
  };
  const R = q => ({ x: q.l + dx, y: q.t + dy, w: q.r - q.l, h: q.b - q.t });
  const cut = (a, c) => ({ l: Math.max(a.l, c.l), t: Math.max(a.t, c.t), r: Math.min(a.r, c.r), b: Math.min(a.b, c.b) });
  const over = (a, c, m = 0) => Math.min(a.r, c.r) - Math.max(a.l, c.l) > m && Math.min(a.b, c.b) - Math.max(a.t, c.t) > m;
  const label = e => (e.textContent || e.getAttribute('src') || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 60);
  // short：場所を除いた問題の名前（編集画面のツールバーに出す）。block：原稿のブロック（data-slide-studio）
  const issue = (level, kind, short, e, rects, area, extra = {}) => {
    const x = { level, kind, message: `${short}: ${label(e)}`, short, rects: rects.map(R), ...extra };
    if (area) x.area = R(area);
    const b = e.closest('[data-slide-studio]')?.dataset.slideStudio;
    if (b) x.block = b;
    return x;
  };
  const visible = e => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || (s.visibility === 'hidden' && !(opt.allSteps && e.closest('[data-step].pending')))) return false;
    for (let a = e; a && a !== root.parentElement; a = a.parentElement) {
      const o = a.getAttribute && a.getAttribute('opacity');
      if (Number(getComputedStyle(a).opacity) === 0 || o === '0') return false;
    }
    if (e.tagName === 'text') {
      const r = e.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (top && top !== e && !e.contains(top) && !top.closest('svg')) return false;
    }
    return e.getBoundingClientRect().width > 0;
  };
  const sel = frame ? 'svg text,svg image' : 'h1,h2,h3,h4,p,li,table,iframe,img,svg,.page-number,.citations p';
  // 監査では HTML の任意の文字要素も拾う。装飾用の空の div は重なりの対象にしない。
  const textNodes = new Map();
  if (opt.audit) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) {
      if (!n.textContent.trim() || n.parentElement.closest('script,style,math')) continue;
      if (n.parentElement.closest('svg') && !n.parentElement.closest('text,foreignObject')) continue;
      if (!visible(n.parentElement)) continue;
      let e = n.parentElement.closest('svg text') || n.parentElement;
      while (e.namespaceURI !== 'http://www.w3.org/2000/svg' && e.parentElement && e !== root && getComputedStyle(e).display === 'inline'
        && getComputedStyle(e).position === 'static') e = e.parentElement;
      if (!textNodes.has(e)) textNodes.set(e, []);
      textNodes.get(e).push(n);
    }
  }
  const els = [...new Set([...root.querySelectorAll(sel), ...textNodes.keys(),
    ...(opt.audit && frame ? root.querySelectorAll('img,iframe') : [])])].filter(visible);
  // 文字単位の Range から表示上の行を復元。強調タグをまたいでも1行として数える。
  const lines = new Map();
  if (opt.audit) for (const [e, nodes] of textNodes) {
    const rows = [];
    for (const n of nodes) for (const { segment, index } of new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(n.textContent)) {
      if (!segment.trim()) continue;
      const r = document.createRange(); r.setStart(n, index); r.setEnd(n, index + segment.length);
      const rect = r.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const q = norm(rect), cy = (q.t + q.b) / 2;
      let row = rows.find(x => Math.abs(x.cy - cy) < Math.min(x.q.b - x.q.t, q.b - q.t) * .45);
      if (!row) rows.push(row = { cy, q: { ...q }, text: '', count: 0 });
      row.text += segment; row.count++;
      row.q = { l: Math.min(row.q.l, q.l), t: Math.min(row.q.t, q.t), r: Math.max(row.q.r, q.r), b: Math.max(row.q.b, q.b) };
    }
    if (rows.length) lines.set(e, rows.sort((a, b) => a.q.t - b.q.t));
  }
  const inks = e => lines.get(e)?.map(x => x.q).filter(Boolean) || [ink(e)];
  const hull = qs => ({ l: Math.min(...qs.map(r => r.l)), t: Math.min(...qs.map(r => r.t)),
    r: Math.max(...qs.map(r => r.r)), b: Math.max(...qs.map(r => r.b)) });
  const bounds = box(root);
  const out = [], own = new Map(); // 要素 → その要素1つの問題（外側の要素にも同じ種類の問題があれば外側だけを出す）
  const flag = (e, x) => own.set(e, [...own.get(e) || [], x]);

  if (opt.audit) for (const [e, rows] of lines) {
    // 単独の短い見出し・ラベルは対象外。改行後の短い行は意図した改行も確認する。
    for (let i = 1; i < rows.length; i++) if (rows[i].count <= 5) {
      const row = rows[i];
      out.push(issue('warning', 'short-line', '改行後の行が5文字以下', e, [row.q], null,
        { line: i + 1, text: row.text, characters: row.count,
          message: `改行後の行が5文字以下（${i + 1}行目「${row.text}」）: ${label(e)}`,
          suggestion: '意味のまとまりで改行するか、意味を保って短くして一行に収める' }));
    }
    for (let a = e; a && root.contains(a); a = a.parentElement) {
      const cs = getComputedStyle(a), q = box(a);
      const clipX = /hidden|clip|auto|scroll/.test(cs.overflowX), clipY = /hidden|clip|auto|scroll/.test(cs.overflowY);
      const cutRows = rows.filter(({ q: r }) => (clipX && (r.l < q.l - EDGE || r.r > q.r + EDGE))
        || (clipY && (r.t < q.t - EDGE || r.b > q.b + EDGE)));
      if (cutRows.length) {
        out.push(issue('error', 'text-clipped', '枠内で文字が切れる', e, cutRows.map(x => x.q), q));
        break;
      }
    }
  }

  for (const e of els) {
    const q = hull(inks(e));
    const [side, name, n] = [['bottom', '下', q.b - bounds.b], ['right', '右', q.r - bounds.r], ['left', '左', bounds.l - q.l], ['top', '上', bounds.t - q.t]]
      .sort((a, c) => c[2] - a[2])[0];
    if (n <= EDGE) continue;
    flag(e, frame ? issue('error', 'figure-overflow', '図の枠からはみ出す', e, [q], null)
      : issue('error', 'overflow', `スライドの${name}に ${Math.ceil(n)}px はみ出す`, e, [q], null, { side, amount: Math.ceil(n) }));
  }
  const foot = e => e.closest('.citations') ? ['footer-overlap', '引用フッター'] : e.classList.contains('page-number') ? ['page-number', 'ページ番号'] : null;
  if (!frame) {
    const cs = getComputedStyle(root), inL = bounds.l + parseFloat(cs.paddingLeft), inR = bounds.r - parseFloat(cs.paddingRight);
    for (const e of els) {
      if (foot(e) || e.closest('h1,h2')) continue;
      const q = hull(inks(e)); // 段落の箱が余白に入っても、文字が入っていなければ問題にしない
      if (q.l < inL - EDGE) flag(e, issue('warning', 'margin', '左の余白にはみ出す', e, [q], { ...q, r: Math.min(q.r, inL) }));
      if (q.r > inR + EDGE) flag(e, issue('warning', 'margin', '右の余白にはみ出す', e, [q], { ...q, l: Math.max(q.l, inR) }));
    }
  }
  for (const [e, xs] of own) for (const x of xs) {
    let dup = false;
    for (let a = e.parentElement; a && a !== root && !dup; a = a.parentElement) dup = !!own.get(a)?.some(y => y.kind === x.kind);
    if (!dup) out.push(x);
  }
  // 重なり：文字どうし・要素と文字・要素どうし。引用フッター・ページ番号の中どうしは見ない（テーマが置く場所）
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    let a = els[i], b = els[j];
    if (a.contains(b) || b.contains(a)) continue;
    const svgPair = a.tagName === 'text' && b.tagName === 'text';
    if (!svgPair && (opt.audit
      ? a.namespaceURI === 'http://www.w3.org/2000/svg' || b.namespaceURI === 'http://www.w3.org/2000/svg'
      : a.closest('svg') || b.closest('svg'))) continue;
    if (foot(a) && foot(b)) continue;
    if (foot(a)) [a, b] = [b, a]; // a を本文の側にする
    const pair = inks(a).flatMap(x => inks(b).map(y => [x, y])).find(([x, y]) => over(x, y, OVERLAP));
    if (!pair) continue;
    const [x, y] = pair;
    const f = foot(b);
    const found = svgPair ? issue('warning', 'text-overlap', '図の文字どうしが重なる', a, [x, y], cut(x, y))
      : f ? issue('error', f[0], `${f[1]}と重なる`, a, [x, y], cut(x, y))
        : issue('error', 'overlap', '本文どうしが重なる', a, [x, y], cut(x, y));
    if (!f) found.message = `${found.short}: ${label(a)} / ${label(b)}`;
    out.push(found);
  }
  if (frame) for (const img of document.querySelectorAll('svg image')) {
    out.push(issue('error', 'svg-image', '図の SVG の中で画像を参照している（書き出しで内包できない）', img, [box(img)], null));
    out.at(-1).message = out.at(-1).short;
  }
  return out;
}
