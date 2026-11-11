// スライドのブロックを持って動かす（設計書 §10.4）。選んでいるブロックの枠の内側を押して少し動かすと、
// 中の子の上からでも選んでいるブロックを持つ。選んでいないブロックは選んでから持つ。動かさずに離せば通常のクリック。
// 置ける所に線を出し、ページの帯の縮小画像に落とすとそのページの最後へ移す。Esc で取り消す。
import * as op from './block-ops.js';

const START = 4; // 持つまでに動かす距離（px）

// env()：{ win, frame, st, selected, live }。select(key)、commit(result)
export function makeDrag(host, { env, select, commit }) {
  const layer = document.createElement('div');
  layer.className = 'bd-layer'; host.append(layer);
  let press = null, drag = null, doc = null, strip = null;

  const inside = (r, x, y) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const rectOf = (w, key) => {
    const rs = (w.slideStudioEdit?.elements(key) || []).map(e => e.getBoundingClientRect()).filter(r => r.width || r.height);
    if (!rs.length) return null;
    return { left: Math.min(...rs.map(r => r.left)), top: Math.min(...rs.map(r => r.top)), right: Math.max(...rs.map(r => r.right)), bottom: Math.max(...rs.map(r => r.bottom)) };
  };

  // 置き場所。返す spec は block-ops の move に渡す形と、線を出す位置（iframe の中の座標）。
  // key が無いときは、まだ無いブロック（素材から持ってきたもの）を今のページに置く場所
  function dropAt(x, y, key) {
    const { win: w, st, preview } = env(), src = key ? op.outer(op.find(st, key)?.chunk || {}) : null;
    if (src && !src.kind) return null;
    const hit = w.document.elementFromPoint(x, y);
    const page = key ? op.find(st, key).page : st.pages[preview.pageOfSlide(preview.index)];
    if (!page || page.raw_only) return null;
    const contains = (a, b) => !!a && b.start >= a.start && b.end <= a.end;
    const line = (r, side) => ({ left: r.left, width: r.right - r.left, top: side === 'before' ? r.top - 5 : r.bottom + 3, height: 2 });
    // 列は、別の列の上なら列の前後へ。列の外なら下のふつうの置き場所へ（中身だけを移す。block-ops の move）
    const col = src?.kind === 'column' && hit?.closest('.column[data-slide-studio]'), tc = col && op.find(st, col.dataset.slideStudio)?.chunk;
    if (tc === src) return null;
    if (tc) {
      const r = rectOf(w, tc.key), side = x < (r.left + r.right) / 2 ? 'before' : 'after';
      return { spec: { key: tc.key, side }, mark: { left: side === 'before' ? r.left - 5 : r.right + 3, width: 2, top: r.top, height: r.bottom - r.top } };
    }
    // 並び（kids）の中で y の位置。間に線を出す
    const inList = (kids, box) => {
      const rs = kids.map(k => [k, rectOf(w, k.key)]).filter(([, r]) => r);
      if (!rs.length) return box ? { spec: { into: box.key }, mark: { face: rectOf(w, box.key) } } : null;
      const next = rs.find(([, r]) => y < (r.top + r.bottom) / 2);
      return next ? { spec: { key: next[0].key, side: 'before' }, mark: line(next[1], 'before') }
        : { spec: { key: rs.at(-1)[0].key, side: 'after' }, mark: line(rs.at(-1)[1], 'after') };
    };
    const el = hit?.closest('[data-slide-studio]');
    let t = el && op.find(st, el.dataset.slideStudio)?.chunk;
    if (t) t = op.outer(t);
    if (t && contains(src, t)) return null;
    if (!t) return inList(page.chunks.filter(c => c.kind !== 'def' && !contains(src, c)), null);
    if (t.kind === 'columns') {
      const col = t.children.find(k => { const r = rectOf(w, k.key); return r && x >= r.left && x <= r.right; });
      if (!col) { const r = rectOf(w, t.key), side = y < (r.top + r.bottom) / 2 ? 'before' : 'after'; return { spec: { key: t.key, side }, mark: line(r, side) }; }
      t = col;
      if (t === src) return null;
    }
    if (t.kind === 'column' || t.kind === 'box') {
      // 囲みの上下の端なら囲みの前後（横並びの外を含む）、それ以外は中の並び
      const r = rectOf(w, t.key), edge = Math.min(14, (r.bottom - r.top) / 4);
      const outerBox = t.kind === 'column' ? t.parent : t;
      const ro = rectOf(w, outerBox.key);
      if (y < ro.top + edge) return { spec: { key: outerBox.key, side: 'before' }, mark: line(ro, 'before') };
      if (y > ro.bottom - edge) return { spec: { key: outerBox.key, side: 'after' }, mark: line(ro, 'after') };
      return inList(t.children.filter(c => c.kind !== 'def' && !contains(src, c)), t);
    }
    const r = rectOf(w, op.inner(t).key) || rectOf(w, t.key); if (!r) return null;
    const side = y < (r.top + r.bottom) / 2 ? 'before' : 'after';
    return { spec: { key: t.key, side }, mark: line(r, side) };
  }
  function show(target) {
    layer.replaceChildren();
    strip?.classList.remove('drop'); strip = null;
    if (!target) return;
    if (target.strip) { strip = target.strip; strip.classList.add('drop'); return; }
    const { frame } = env(), fr = frame.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const m = target.mark.face ? { ...target.mark.face, width: target.mark.face.right - target.mark.face.left, height: target.mark.face.bottom - target.mark.face.top, face: true } : target.mark;
    const d = document.createElement('div'); d.className = m.face ? 'bd-face' : 'bd-line';
    Object.assign(d.style, { left: `${fr.left - hr.left + m.left}px`, top: `${fr.top - hr.top + m.top}px`, width: `${m.width}px`, height: `${m.height}px` });
    layer.append(d);
  }
  // ページの帯の上（親画面の座標）なら、そのページの最後へ
  function stripAt(e, parent = false) {
    const fr = parent ? { left: 0, top: 0 } : env().frame.getBoundingClientRect();
    const b = document.elementFromPoint(fr.left + e.clientX, fr.top + e.clientY)?.closest?.('#pagestrip button[data-index]');
    return b ? { strip: b, index: +b.dataset.index } : null;
  }
  function down(e) {
    const { win: w, st, selected, live } = env();
    if (e.button || e.metaKey || e.ctrlKey || !live || w.document.querySelector('.slide-studio-editing')) return;
    const el = e.target.closest?.('[data-slide-studio]');
    const sel = selected && inside(rectOf(w, selected), e.clientX, e.clientY) ? selected : null;
    const key = sel || (el && w.slideStudioEdit.leafAt(el, e.clientX, e.clientY).dataset.slideStudio);
    if (!key) return;
    press = { key, x: e.clientX, y: e.clientY, id: e.pointerId, target: e.target };
  }
  function move(e) {
    if (!press) return;
    if (!drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < START) return;
      const { win: w, selected } = env();
      drag = { key: press.key, target: null };
      const cover = op.coverPart(op.find(env().st, press.key)?.chunk);
      if (cover) {
        const el = w.slideStudioEdit.elements(cover.key)[0], cs = w.getComputedStyle(el);
        drag.cover = { el, style: el.getAttribute('style'), left: parseFloat(cs.left) || 0, top: parseFloat(cs.top) || 0,
          scale: w.document.querySelector('#stage').getBoundingClientRect().width / 1280 };
      }
      if (selected !== press.key) select(press.key);
      host.dataset.operating = '';
      try { press.target.setPointerCapture?.(press.id); } catch { /* 取れなくても動かせる */ }
      w.slideStudioEdit.elements(op.outer(op.find(env().st, drag.key)?.chunk || {}).key || drag.key).forEach(x => x.classList.add('slide-studio-drag-src'));
    }
    e.preventDefault();
    if (drag.cover) {
      const c = drag.cover;
      c.values = { left: `${Math.round(c.left + (e.clientX - press.x) / c.scale)}px`, top: `${Math.round(c.top + (e.clientY - press.y) / c.scale)}px` };
      Object.assign(c.el.style, c.values);
      return;
    }
    const fr = env().frame.getBoundingClientRect();
    const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > fr.width || e.clientY > fr.height;
    const s = outside ? stripAt(e) : null;
    drag.target = s ? { strip: s.strip, spec: { pageEnd: env().preview.pageOfSlide(s.index) } } : outside ? null : dropAt(e.clientX, e.clientY, drag.key);
    if (drag.target?.spec?.pageEnd == null && drag.target?.strip) drag.target = null;
    if (drag.target && !op.moves(env().st.text, env().st, drag.key, drag.target.spec)) drag.target = null;
    show(drag.target);
  }
  function end(ok) {
    const d = drag; press = null; drag = null;
    if (!d) return;
    delete host.dataset.operating;
    env().win.document.querySelectorAll('.slide-studio-drag-src').forEach(x => x.classList.remove('slide-studio-drag-src'));
    env().win.slideStudioEdit.swallowClick();
    show(null);
    if (d.cover) {
      const c = d.cover;
      if (ok && c.values) { const { st } = env(); commit(op.setCoverLayout(st.text, st, d.key, c.values)); }
      else if (c.style == null) c.el.removeAttribute('style'); else c.el.setAttribute('style', c.style);
      return;
    }
    if (ok && d.target) {
      const { st } = env(), r = op.move(st.text, st, d.key, d.target.spec);
      if (r && !r.error) commit(r);
    }
  }
  const up = () => end(true), cancel = () => end(false);
  return {
    get dragging() { return !!drag; },
    // 素材を持って動かしている間（親画面の座標）。置ける所に線を出し、置き場所を返す（spec は block-ops の insertBlock 用）
    newAt(x, y) {
      const { win: w, frame, st, live } = env();
      let target = null;
      if (live && w?.slideStudioEdit && st) {
        const fr = frame.getBoundingClientRect();
        if (inside(fr, x, y)) target = dropAt(x - fr.left, y - fr.top, null);
        else { const s = stripAt({ clientX: x, clientY: y }, true); if (s) target = { strip: s.strip, spec: { pageEnd: env().preview.pageOfSlide(s.index) } }; }
      }
      show(target);
      return target;
    },
    clearNew() { show(null); },
    cancel() { if (drag) { end(false); return true; } return false; },
    // 新しい表示を読み込んだら、その文書で受け付ける
    attach(w) {
      doc?.removeEventListener('pointerdown', down, true); doc?.removeEventListener('pointermove', move, true);
      doc?.removeEventListener('pointerup', up, true); doc?.removeEventListener('pointercancel', cancel, true);
      doc = w?.document;
      if (!doc) return;
      doc.addEventListener('pointerdown', down, true); doc.addEventListener('pointermove', move, true);
      doc.addEventListener('pointerup', up, true); doc.addEventListener('pointercancel', cancel, true);
    },
    destroy() { this.attach(null); delete host.dataset.operating; layer.remove(); },
  };
}
