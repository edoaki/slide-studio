// 選んだブロックの端のつまみ（設計書 §10.4 の大きさ・余白）。つまみは親画面に置き、スライドの iframe の上に重ねる。
// 動かしている間は表示だけを変え、離した時点で原稿（またはページ・横並びの値）を書く。ダブルクリックで書いた値を消す。
import * as op from './block-ops.js';
import { S } from './strings.js';

const MIN = { image: 16, fig: 40, box: 0, tableCol: 32 };
const px = v => `${Math.round(v)}px`;
export const padCss = ([t, r, b, l]) => t === b && r === l ? (t === r ? px(t) : `${px(t)} ${px(r)}`) : `${px(t)} ${px(r)} ${px(b)} ${px(l)}`;

// host：つまみを置く要素（#viewport）。env：{ win, frame, st, key, kind, color, padMode, live, write(r, opts), padded(kind, pad) }
export function makeHandles(host) {
  const layer = document.createElement('div');
  layer.className = 'bh-layer'; host.append(layer);
  let env = null, drag = null, placed = [];

  const scale = () => { const s = env.win.document.querySelector('#stage'); return s ? s.getBoundingClientRect().width / 1280 : 1; };
  // iframe の中の位置を host の中の位置にする
  const toHost = r => {
    if (!r) return null;
    const fr = env.frame.getBoundingClientRect(), hr = host.getBoundingClientRect();
    return { left: fr.left - hr.left + r.left, top: fr.top - hr.top + r.top, width: r.width, height: r.height };
  };
  const els = key => env.win.slideStudioEdit?.elements(key) || [];
  // 選択の枠の線（outline）の中心を囲む矩形。余白の包みの中の段落は、枠を出している包みの線
  const union = list => {
    const rs = list.map(e => {
      const o = e.classList.contains('slide-studio-quiet') ? e.closest('.slide-studio-frame') || e : e, cs = env.win.getComputedStyle(o);
      const d = cs.outlineStyle === 'none' ? 0 : ((parseFloat(cs.outlineOffset) || 0) + (parseFloat(cs.outlineWidth) || 0) / 2) * scale(), r = o.getBoundingClientRect();
      return { left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d, width: r.width, height: r.height };
    }).filter(r => r.width || r.height);
    if (!rs.length) return null;
    const left = Math.min(...rs.map(r => r.left)), top = Math.min(...rs.map(r => r.top));
    return { left, top, width: Math.max(...rs.map(r => r.right)) - left, height: Math.max(...rs.map(r => r.bottom)) - top };
  };
  // つまみの位置は動かすたびに測り直す（動かしている間も枠の線に付いていく）
  const relayout = () => placed.forEach(([h, at]) => {
    const r = at(); if (r) Object.assign(h.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  });
  // 動かし終える。離したのがスライドの iframe の上だと、つまみに pointerup が届かないことがある（Safari など）ので、
  // 親画面・iframe の pointerup、捕捉が外れたとき、ボタンを離して動かしたときのどれでも終える
  function end(ok) {
    const d = drag; if (!d) return;
    drag = null; d.off(); d.h.classList.remove('on'); delete host.dataset.operating;
    if (ok) d.move.done(); else d.move.cancel?.();
    if (ok) env?.ended?.(env.padMode);
  }
  function handle(cls, label, at, onDrag, onReset) {
    const h = document.createElement('div');
    h.className = `bh ${cls}`; h.setAttribute('role', 'slider'); h.setAttribute('aria-label', label); h.title = label;
    h.addEventListener('pointerdown', e => {
      if (e.button) return;
      e.preventDefault(); e.stopPropagation();
      h.setPointerCapture(e.pointerId); h.classList.add('on'); host.dataset.operating = '';
      const up = () => end(true), wins = [window, env.win].filter(Boolean);
      wins.forEach(w => w.addEventListener('pointerup', up, true));
      h.addEventListener('lostpointercapture', up);
      drag = { x: e.clientX, y: e.clientY, s: scale(), move: onDrag(), h, off: () => { wins.forEach(w => w.removeEventListener('pointerup', up, true)); h.removeEventListener('lostpointercapture', up); } };
    });
    h.addEventListener('pointermove', e => {
      if (drag?.h !== h) return;
      if (!(e.buttons & 1)) { end(true); return; }
      drag.move.move((e.clientX - drag.x) / drag.s, (e.clientY - drag.y) / drag.s, e.shiftKey);
      relayout();
    });
    h.addEventListener('pointercancel', () => end(false));
    h.addEventListener('dblclick', e => { e.preventDefault(); onReset(); });
    layer.append(h);
    placed.push([h, at]);
    relayout();
    return h;
  }
  const band = (rect, text, side) => {
    const b = document.createElement('div'); b.className = 'bh-band';
    if (side) b.dataset.side = side;
    Object.assign(b.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${Math.max(0, rect.width)}px`, height: `${Math.max(0, rect.height)}px` });
    if (text != null) b.dataset.value = text;
    layer.append(b);
  };

  // ---------------------------------------------------------------- 大きさ
  function sizeHandles(c) {
    const { key } = env, el = els(key)[0]; if (!el) return;
    const cover = op.coverPart(c);
    if (cover) {
      const target = els(cover.key)[0]; if (!target) return;
      // 位置はブロックのドラッグで変える。つまみは右下の大きさだけ
      const rect = () => toHost(target.getBoundingClientRect());
      handle('corner', S.coverLayout.size, () => {
        const r = rect(); return { left:r.left + r.width - 6, top:r.top + r.height - 6, width:12, height:12 };
      }, () => {
        const original = target.getAttribute('style'), r = target.getBoundingClientRect(), s = scale();
        let values = null;
        return {
          move(dx, dy) {
            values = { width:px(Math.max(40, r.width / s + dx)), 'min-height':px(Math.max(0, r.height / s + dy)) };
            for (const [k, v] of Object.entries(values)) target.style.setProperty(k, v);
          },
          done() { if (values) env.write(op.setCoverLayout(env.st.text, env.st, key, values)); },
          cancel() { if (original == null) target.removeAttribute('style'); else target.setAttribute('style', original); },
        };
      }, () => env.write(op.setCoverLayout(env.st.text, env.st, key, { width:null, 'min-height':null })));
      return;
    }
    if (c.kind === 'image' || c.kind === 'fig') {
      const target = c.kind === 'image' ? (el.tagName === 'IMG' ? el : el.querySelector('img')) : el;
      if (!target) return;
      const rect = () => toHost(union([target]));
      if (!rect()) return;
      for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        handle('corner', S.sizeHandle.corner, () => { const r = rect(); return r && { left: r.left + cx * r.width - 5, top: r.top + cy * r.height - 5, width: 10, height: 10 }; }, () => {
          const s = scale(), w0 = target.getBoundingClientRect().width / s, h0 = target.getBoundingClientRect().height / s, ratio = w0 / h0 || 1;
          const originalStyle = target.getAttribute('style');
          let v = null;
          return {
            move(dx, dy) {
              const sx = cx ? 1 : -1, sy = cy ? 1 : -1;
              // 縦横比はそのまま：大きく動かした向きで決める
              const w = Math.abs(dx) >= Math.abs(dy) * ratio ? w0 + sx * dx : (h0 + sy * dy) * ratio;
              if (c.kind === 'image') { v = Math.max(MIN.image, Math.round(w)); target.style.width = `${v}px`; target.style.height = 'auto'; }
              else {
                v = Math.max(MIN.fig, Math.round(w / ratio));
                target.style.removeProperty('width');
                target.style.height = `${v}px`;
                target.style.setProperty('--fig-height', `${v}px`);
              }
            },
            done() { if (v != null) env.write(op.setSize(env.st.text, env.st, key, v)); },
            cancel() { if (originalStyle == null) target.removeAttribute('style'); else target.setAttribute('style', originalStyle); },
          };
        }, () => env.write(op.setSize(env.st.text, env.st, key, null)));
      }
      // 図・画像でも列幅を変えられるよう、角に加えて左右の境目を出す。
    }
    if (c.kind === 'box') {
      handle('edge-y', S.sizeHandle.bottom, () => { const r = toHost(union([el])); return r && { left: r.left + r.width / 2 - 14, top: r.top + r.height - 4, width: 28, height: 8 }; }, () => {
        const h0 = el.getBoundingClientRect().height / scale(); let v = null;
        return {
          move(dx, dy) { v = Math.max(MIN.box, Math.round(h0 + dy)); el.style.minHeight = `${v}px`; },
          done() { if (v != null) env.write(op.setSize(env.st.text, env.st, key, v)); },
          cancel() { el.style.minHeight = ''; },
        };
      }, () => env.write(op.setSize(env.st.text, env.st, key, null)));
      return;
    }
    if (op.isTable(env.st.text, c)) { tableHandles(env.win.slideStudioEdit.table(env.key)); return; }
    // 列、列の中のブロック：左右の辺で隣の列との幅の比
    if (c.kind === 'columns') return;
    const cols = op.columnsOf(env.st, key); if (!cols || cols.children.length < 2) return;
    const colKey = c.kind === 'column' ? c : cols.children.find(k => c.start >= k.start && c.end <= k.end);
    const i = cols.children.indexOf(colKey);
    if (!union(els(key))) return;
    const rowEl = els(cols.key)[0]; if (!rowEl) return;
    for (const side of [0, 1]) {
      const j = i + side; // 動かす境目（j 列目の左）
      if (j < 1 || j >= cols.children.length) continue;
      handle('edge-x', S.sizeHandle.edge, () => { const r = toHost(union(els(key))); return r && { left: r.left + side * r.width - 4, top: r.top + r.height / 2 - 14, width: 8, height: 28 }; }, () => {
        const row = rowEl.getBoundingClientRect(), colEls = cols.children.map(k => els(k.key)[0]);
        const widths = colEls.map(e => e?.getBoundingClientRect().width || 0), sum = widths.reduce((a, b) => a + b, 0) || 1;
        const start = op.intRatios(widths.map(w => w / sum * 100)), x0 = start.slice(0, j).reduce((a, b) => a + b, 0), s = scale();
        let ws = null;
        return {
          move(dx) {
            ws = op.pushRatios(start, j, x0 + dx * s / row.width * 100, Math.min(10, Math.floor(100 / start.length)));
            colEls.forEach((e, k) => { if (e) { e.style.width = `${ws[k]}%`; e.style.flex = '0 1 auto'; } });
          },
          done() { if (ws) env.write(op.setColumnWidths(env.st.text, env.st, key, ws)); },
          cancel() { colEls.forEach(e => { if (e) e.style.width = e.style.flex = ''; }); },
        };
      }, () => env.write(op.setColumnWidths(env.st.text, env.st, key, null)));
    }
  }

  // ---------------------------------------------------------------- 表の列の幅
  // 列の境目で隣の列と幅を分け合い、右の端で表の幅を変える（行の高さは文字の折り返しに任せる）。値は列ごとの px
  function tableHandles(table) {
    const cells = table ? [...table.rows[0]?.cells ?? []] : [];
    if (!cells.length) return;
    const { key } = env, n = cells.length;
    // 表が入っている枠の中身の幅（これより広くしない）
    const room = () => {
      let box = table.parentElement;
      while (box && env.win.getComputedStyle(box).display === 'contents') box = box.parentElement;
      const cs = env.win.getComputedStyle(box);
      return box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    };
    const save = () => { env.write(op.setTextOptions(env.st.text, env.st, key, { '--table-cols': null })); };
    for (let j = 1; j <= n; j++) {
      const last = j === n;
      handle('table-col', last ? S.sizeHandle.tableEdge : S.sizeHandle.edge, () => {
        const a = toHost(cells[j - 1].getBoundingClientRect()), t = toHost(table.getBoundingClientRect());
        return { left: a.left + a.width - 4, top: t.top, width: 8, height: t.height };
      }, () => {
        const s = scale(), start = cells.map(td => td.getBoundingClientRect().width / s), limit = room();
        const styled = [table, ...table.querySelectorAll('th,td')], before = styled.map(e => e.getAttribute('style')), group = table.querySelector('colgroup'), others = start.reduce((a, b) => a + b, 0) - start[n - 1];
        let ws = null;
        return {
          move(dx) {
            group?.remove();
            const v = [...start], i = j - 1;
            if (last) v[i] = Math.min(limit - others, Math.max(MIN.tableCol, start[i] + dx));
            else { const d = Math.min(start[j] - MIN.tableCol, Math.max(MIN.tableCol - start[i], dx)); v[i] += d; v[j] -= d; }
            ws = v.map(Math.round);
            Object.assign(table.style, { width: `${ws.reduce((a, b) => a + b, 0)}px`, tableLayout: 'fixed', overflowWrap: 'anywhere' });
            cells.forEach((td, k) => { td.style.width = `${ws[k]}px`; });
            styled.slice(1).forEach(td => { td.style.whiteSpace = 'normal'; });
          },
          done() { if (ws) env.write(op.setTextOptions(env.st.text, env.st, key, { '--table-cols': ws.join(' ') })); },
          cancel() {
            styled.forEach((e, k) => { if (before[k] == null) e.removeAttribute('style'); else e.setAttribute('style', before[k]); });
            if (group && !group.isConnected) { if (table.caption) table.caption.after(group); else table.prepend(group); }
          },
        };
      }, save);
    }
  }

  // ---------------------------------------------------------------- 余白
  // 余白を持つ要素：段落はその包み、画像は img、図は枠
  function padTarget(c) {
    const { key } = env;
    const o = op.outer(c);
    if (o !== c) return els(o.key)[0];
    const el = els(key)[0];
    return c.kind === 'image' ? (el?.tagName === 'IMG' ? el : el?.querySelector('img')) : el;
  }
  function spaceHandles(c) {
    const { key } = env, el = padTarget(c); if (!el) return;
    const original = el.style.getPropertyValue('--block-space') || null;
    const values = (original || '0').split(/\s+/).map(v => parseFloat(v) || 0);
    // 原稿に値がない枠付きブロックは、テーマ共通の既定の余白から調整を始める
    const framed = !original && (op.isFramed(c) || c.kind === 'text') && el.style.getPropertyValue('--block-design') && !el.matches('.column');
    const cs = framed ? env.win.getComputedStyle(el) : null;
    const pad = cs ? ['Top', 'Right', 'Bottom', 'Left'].map(k => parseFloat(cs[`margin${k}`]) || 0)
      : [values[0], values[1] ?? values[0], values[2] ?? values[0], values[3] ?? values[1] ?? values[0]];
    const apply = value => env.win.slideStudioSpacing(el, value);
    const names = ['top', 'right', 'bottom', 'left'], out = [-1, 1, 1, -1], s = scale();
    let current = [...pad];
    const box = () => toHost(el.getBoundingClientRect());
    const edges = (i, p) => {
      const r = box(), inner = [r.top, r.left + r.width, r.top + r.height, r.left][i];
      return [inner, inner + out[i] * p[i] * s];
    };
    // 枠の縁と外側余白の縁のうち、実際に動く方を選ぶ。
    apply(padCss(pad));
    const grab = names.map((_, i) => {
      const a = edges(i, pad), p = pad.map((x, k) => k === i ? x + 20 : x);
      apply(padCss(p)); const b = edges(i, p); apply(padCss(pad));
      const ks = b.map((x, n) => (x - a[n]) / s / 20);
      const n = Math.abs(ks[0]) >= Math.abs(ks[1]) ? 0 : 1;
      return { n, k: Math.abs(ks[n]) > .1 ? ks[n] : out[i] };
    });
    // 表示するだけではレイアウトを変えない。
    apply(original);
    const show = () => {
      layer.querySelectorAll('.bh-band').forEach(b => b.remove());
      const r = box(), [t, rr, b, l] = current.map(v => v * s);
      band({ left:r.left, top:r.top-t, width:r.width, height:t }, current[0], 'top');
      band({ left:r.left+r.width, top:r.top, width:rr, height:r.height }, current[1], 'right');
      band({ left:r.left, top:r.top+r.height, width:r.width, height:b }, current[2], 'bottom');
      band({ left:r.left-l, top:r.top, width:l, height:r.height }, current[3], 'left');
    };
    show();
    names.forEach((name, i) => {
      const at = () => {
        const r = box(), pos = edges(i, current)[grab[i].n];
        return i % 2 ? { left:pos-4, top:r.top+r.height/2-14, width:8, height:28 }
          : { left:r.left+r.width/2-14, top:pos-4, width:28, height:8 };
      };
      handle(`pad-${i % 2 ? 'x' : 'y'}`, S.spaceSide[name], at, () => {
        let changed = false;
        return {
          move(dx, dy, all) {
            const v = Math.max(0, Math.round(pad[i] + (i % 2 ? dx : dy) / grab[i].k));
            current = all ? [v,v,v,v] : pad.map((x,k) => k === i ? v : x);
            apply(padCss(current)); show(); changed = true;
          },
          done() {
            if (!changed) return;
            // 0で止まった操作や元へ戻した操作では、不要な余白の囲みを作らない。
            if (current.some((v, i) => v !== pad[i])) env.write(op.setSpace(env.st.text, env.st, key, padCss(current)));
            else apply(original);
          },
          cancel() { apply(original); current = [...pad]; show(); },
        };
      }, () => env.write(op.setSpace(env.st.text, env.st, key, null)));
    });
  }
  function padHandles(c) {
    const { key, kind } = env, el = padTarget(c); if (!el) return;
    const cs = env.win.getComputedStyle(el), s = scale(), box = () => toHost(el.getBoundingClientRect()), r = box();
    if (kind === 'columns' && env.padMode === 'gap') {
      // 列の間：列と列のあいだごとに1つ
      const gap = parseFloat(cs.columnGap) || 0, kids = c.children.map(k => els(k.key)[0]).filter(Boolean);
      kids.slice(0, -1).forEach((k, n) => {
        const a = toHost(k.getBoundingClientRect());
        band({ left: a.left + a.width, top: r.top, width: gap * s, height: r.height }, Math.round(gap));
        handle('pad-x', S.padSide.gap, () => ({ left: a.left + a.width + gap * s / 2 - 4, top: r.top + r.height / 2 - 14, width: 8, height: 28 }), () => {
          let v = null;
          return {
            move(dx) { v = Math.max(0, Math.round(gap + 2 * dx)); el.style.setProperty('--gutter', `${v}px`); },
            done() { if (v != null) { env.write(op.setPad(env.st.text, env.st, key, `${v}px`)); env.padded('columns', `${v}px`); } },
            cancel() { el.style.removeProperty('--gutter'); },
          };
        }, () => env.write(op.setPad(env.st.text, env.st, key, null)));
        void n;
      });
      return;
    }
    const originalStyle = el.getAttribute('style');
    const restore = () => { if (originalStyle == null) el.removeAttribute('style'); else el.setAttribute('style', originalStyle); };
    // 文字は行ボックスの上下と、包みの中の段落 margin もバッファに含める。
    // 調整時はその分を trim して padding に移す。表示しただけでは原稿も見た目も変えない。
    const tp = parseFloat(cs.getPropertyValue('--text-pad')) || 0;
    const pad = c.kind === 'text' && op.outer(c) === c ? [tp, tp, tp, tp] : ['Top', 'Right', 'Bottom', 'Left'].map(k => parseFloat(cs[`padding${k}`]) || 0);
    const text = c.kind === 'text';
    const apply = p => {
      el.style.padding = padCss(p);
      if (text || op.isFramed(c)) el.style.setProperty('text-box', 'trim-both text');
    };
    if (text) {
      const walker = env.win.document.createTreeWalker(el, env.win.NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && !node.textContent.trim()) {}
      if (node) {
        const range = env.win.document.createRange(); range.selectNodeContents(node);
        const before = el.getBoundingClientRect(), top = range.getBoundingClientRect().top - before.top;
        apply([0, pad[1], 0, pad[3]]);
        const after = el.getBoundingClientRect();
        const t = (top - (range.getBoundingClientRect().top - after.top)) / s;
        pad[0] = Math.max(0, t);
        pad[2] = Math.max(0, (before.height - after.height) / s - t);
        restore();
      }
    }
    let current = [...pad];
    const sides = [0, 1, 2, 3];
    const show = p => {
      layer.querySelectorAll('.bh-band').forEach(b => b.remove());
      const r = box(), [t, rr, b, l] = p.map(v => v * s);
      // 数値は枠の外側に出す（内側の辺のつまみと重ねない）
      if (sides.includes(0)) band({ left: r.left, top: r.top, width: r.width, height: t }, Math.round(p[0]), 'top');
      if (sides.includes(2)) band({ left: r.left, top: r.top + r.height - b, width: r.width, height: b }, Math.round(p[2]), 'bottom');
      band({ left: r.left, top: r.top + t, width: l, height: r.height - t - b }, Math.round(p[3]), 'left');
      band({ left: r.left + r.width - rr, top: r.top + t, width: rr, height: r.height - t - b }, Math.round(p[1]), 'right');
    };
    // 余白を増やしたときに動く縁を掴む（§10.4）。枠の縁（文字の下・幅のない画像は外へ伸びる）と中身の縁（文字の左右・上、
    // 幅の決まった画像・図は内へ縮む）のどちらが動くかは CSS の組み合わせで変わるので、少し足して測る。
    // k は余白1pxあたりにその縁が外へ動く量（内へは負、中央揃えでは ±0.5）。掴んだ縁が指に付いてくるように余白を決める
    const names = ['top', 'right', 'bottom', 'left'], keys = ['Top', 'Right', 'Bottom', 'Left'], out = [-1, 1, 1, -1], PROBE = 20;
    const edgesOf = i => {
      const r = el.getBoundingClientRect(), o = [r.top, r.right, r.bottom, r.left][i];
      return [o, o - out[i] * (parseFloat(cs[`padding${keys[i]}`]) || 0) * s];
    };
    const grab = sides.map(i => {
      apply(pad);
      const a = edgesOf(i);
      apply(pad.map((x, k) => k === i ? x + PROBE : x));
      const b = edgesOf(i), [ko, ki] = [0, 1].map(n => (b[n] - a[n]) * out[i] / s / PROBE);
      return Math.abs(ko) >= Math.abs(ki) && Math.abs(ko) >= 0.1 ? { inner: false, k: ko } : { inner: true, k: Math.abs(ki) >= 0.1 ? ki : -1 };
    });
    restore();
    show(pad);
    for (const i of sides) {
      // つまみは掴む縁の中央。枠の縁なら選択の枠の線の上、中身の縁なら帯の内側の端。余白の量は帯と数値で示す
      const at = () => {
        let r, pos;
        if (grab[i].inner) {
          r = box(); if (!r) return null;
          const v = current[i] * s;
          pos = [r.top + v, r.left + r.width - v, r.top + r.height - v, r.left + v][i];
        } else {
          r = toHost(union([el])); if (!r) return null;
          pos = [r.top, r.left + r.width, r.top + r.height, r.left][i];
        }
        return i % 2 ? { left: pos - 4, top: r.top + r.height / 2 - 14, width: 8, height: 28 } : { left: r.left + r.width / 2 - 14, top: pos - 4, width: 28, height: 8 };
      };
      handle(`pad-${i % 2 ? 'x' : 'y'}`, S.padSide[names[i]], at, () => {
        let p = null;
        return {
          // 帯を太らせる向きに動かすと増える。⇧で4辺をそろえる
          move(dx, dy, all) {
            const d = [-dy, dx, dy, -dx][i] / grab[i].k, v = Math.max(0, Math.round(pad[i] + d));
            p = all ? [v, v, v, v] : pad.map((x, k) => k === i ? v : x);
            current = p;
            apply(p);
            show(p);
          },
          done() {
            if (!p) return;
            const value = padCss(p);
            env.write(op.setPad(env.st.text, env.st, key, value)); env.padded(kind, value, p);
          },
          cancel() { restore(); current = [...pad]; show(pad); },
        };
      }, () => env.write(op.setPad(env.st.text, env.st, key, null)));
    }
  }

  return {
    get dragging() { return !!drag; },
    draw(next) {
      // 動かしている間は描き直さない。別のブロックを選んだら、動かしていた分は取り消す
      if (drag && next?.key === env?.key && next?.live) return;
      end(false);
      env = next; layer.replaceChildren(); placed = [];
      if (!env?.win || !env.live || !env.key) return;
      const c = op.find(env.st, env.key)?.chunk;
      if (!c || c.kind === 'opaque' || c.kind === 'def') return;
      // つまみの色は、選んだブロックの枠と同じ層の色
      layer.style.setProperty('--hc', env.color);
      layer.dataset.spacing = env.padMode || '';
      if (env.padMode === 'outer') spaceHandles(c);
      else if (env.padMode) padHandles(c); else sizeHandles(c);
    },
    clear() { end(false); layer.replaceChildren(); placed = []; },
    destroy() { delete host.dataset.operating; layer.remove(); },
  };
}
