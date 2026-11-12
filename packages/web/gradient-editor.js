import { S } from './strings.js';
import { colorPicker } from './color-picker.js';

// 計算後の CSS の値を、括弧の外のカンマで分ける
function split(text) {
  const out = []; let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++; else if (text[i] === ')') depth--;
    else if (text[i] === ',' && !depth) { out.push(text.slice(from, i).trim()); from = i+1; }
  }
  return [...out, text.slice(from).trim()];
}
// 色を #rrggbb と不透明度に（color(srgb …) や oklch も描いて読む）
const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
function rgba(text) {
  if (!CSS.supports('color', text)) return null;
  const hex = c => '#' + c.map(n => Math.round(clampByte(n)).toString(16).padStart(2, '0')).join('');
  // 半透明の色は canvas で読むと端数がずれるので、数値で書かれていればそのまま読む
  const srgb = text.match(/^color\(srgb ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)(?: \/ ([\d.]+))?\)$/);
  if (srgb) return { hex: hex(srgb.slice(1, 4).map(v => v*255)), a: +(srgb[4] ?? 1) };
  const rgb = text.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/);
  if (rgb) return { hex: hex(rgb.slice(1, 4).map(Number)), a: +(rgb[4] ?? 1) };
  paint.globalCompositeOperation = 'copy'; paint.fillStyle = text; paint.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
  return { hex: '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join(''), a: Math.round(a/255*100)/100 };
}
const clampByte = n => Math.max(0, Math.min(255, n));

// 設定はテーマ欄、操作面とポイントだけをスライドに重ねる。
export function gradientEditor({ root, host, target, read, color, palette, preview, save, locked, header }) {
  const t = S.themes.fillEditor;
  const editor = document.createElement('section'); editor.className = 'gradient-editor'; editor.hidden = true;
  editor.setAttribute('aria-label', t.title);
  const toolbar = document.createElement('div'); toolbar.className = 'gradient-toolbar';
  const menu = document.createElement('div'); menu.className = 'gradient-color';
  const overlay = document.createElement('div'); overlay.className = 'gradient-overlay'; overlay.hidden = true;
  const surface = document.createElement('div'); surface.className = 'gradient-surface';
  const points = document.createElement('div'); points.className = 'gradient-points';
  overlay.append(surface, points); root.append(overlay); editor.append(toolbar, menu); host.querySelector('.tv-themes').after(editor);
  let base, fill, ground = '', nodes = [], selected = -1, frame = 0, rect, page, editingDoc, oldInert, originalHeadingInk;
  let dragChanged = false, dragging = false, adding = false, showContent = false, lastValue, addButton, hint, contentButtons = [];
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  // ページの外にあるテーマの点は、動かしても端へ寄せない（元の位置までは外へ出せる）
  const keep = (v, from) => clamp(v, Math.min(0, from), Math.max(100, from));
  const button = (text, action, parent = toolbar) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = action; parent.append(b); return b;
  };
  function close() {
    if (dragging && dragChanged) update(true);
    editor.hidden = true; overlay.hidden = true; host.classList.remove('gradient-editing');
    cancelAnimationFrame(frame); frame = 0; dragging = false;
    if (editingDoc) {
      editingDoc.getElementById('gradient-preview-style')?.remove();
      const stage = editingDoc.querySelector('#stage'); if (stage) stage.inert = oldInert;
    }
    editingDoc = null;
  }
  function geometry() {
    const p = target(), w = p?.win, slide = w?.document.querySelector('#stage > .slide.active');
    const el = base === '--header' ? slide?.querySelector('h2') : slide;
    if (!el || w.document !== editingDoc || !w.frameElement || p.index !== page) return null;
    const f = w.frameElement.getBoundingClientRect();
    const screen = node => { const r = node.getBoundingClientRect(); return { left: f.left+r.left, top: f.top+r.top, width: r.width, height: r.height }; };
    return { ...screen(el), slide: screen(slide) };
  }
  function layout() {
    if (editor.hidden) return;
    rect = geometry();
    if (!rect || !rect.width || !rect.height) { close(); return; }
    const area = root.querySelector('#stage').getBoundingClientRect();
    // 見えるスライド領域だけを覆い、テーマ欄や隣のチャットには被せない。
    const left = Math.max(rect.slide.left, area.left), top = Math.max(rect.slide.top, area.top);
    Object.assign(surface.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, Math.min(area.right, rect.slide.left+rect.slide.width)-left)}px`, height: `${Math.max(0, Math.min(area.bottom, rect.slide.top+rect.slide.height)-top)}px` });
    [...points.children].forEach((b, i) => {
      const n = nodes[i]; b.style.background = n.color;
      b.style.left = `${clamp(rect.left+n.x/100*rect.width-12, area.left+2, area.right-26)}px`;
      b.style.top = `${clamp(rect.top+n.y/100*rect.height-12, area.top+2, area.bottom-26)}px`;
    });
    frame = requestAnimationFrame(layout);
  }
  function content() {
    let style = editingDoc.getElementById('gradient-preview-style');
    if (!style) { style = editingDoc.createElement('style'); style.id = 'gradient-preview-style'; editingDoc.head.append(style); }
    style.dataset.headingInk = originalHeadingInk || '';
    style.textContent = '#slide-studio-theme-marks { display:none !important; } #stage, #stage * { pointer-events:none !important; user-select:none !important; }';
    if (!showContent) {
      style.textContent += '#stage > .slide.active *, #stage > .slide.active::before, #stage > .slide.active::after { visibility:hidden !important; }';
      if (base === '--header') style.textContent += '#stage > .slide.active h2 { visibility:visible !important; color:transparent !important; -webkit-text-fill-color:transparent !important; }';
    }
    contentButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(showContent === !!i)));
  }
  function setAdding(value) {
    adding = value; surface.classList.toggle('adding', adding);
    addButton.setAttribute('aria-pressed', String(adding));
    hint.textContent = adding ? t.place : t.hint[fill];
  }
  function value() {
    const spot = n => `radial-gradient(ellipse ${n.w ? `${n.w}% ${n.h}% ` : ''}at ${Math.round(n.x)}% ${Math.round(n.y)}%, color-mix(in srgb, ${n.color} ${n.opacity}%, transparent), transparent ${n.spread}%)`;
    return [...nodes.map(spot), ...(ground ? [ground] : []), `var(${base})`].join(', ');
  }
  function update(persist) {
    if (locked()) return;
    lastValue = value(); (persist ? save : preview)(fill, lastValue);
  }
  function select(i) {
    selected = i; menu.replaceChildren();
    [...points.children].forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)));
    if (!nodes[i]) { const help = document.createElement('p'); help.textContent = t.select; menu.append(help); return; }
    const n = nodes[i];
    const title = document.createElement('span'); title.className = 'gradient-section-title'; title.textContent = t.point(i+1); menu.append(title);
    const label = document.createElement('label'); label.textContent = t.color;
    const input = document.createElement('input'); input.type = 'color'; input.value = n.color; input.setAttribute('aria-label', t.color); label.append(input); menu.append(label);
    // 色はテーマの欄と同じく欄内で選ぶ（OS の色の小窓は閉じるまで保存されないため使わない）
    input.addEventListener('click', e => { e.preventDefault(); openColor(n, i, input); });
    for (const [key, title, max] of [['opacity', t.opacity, 100], ['spread', t.spread, 150]]) {
      const row = document.createElement('label'); row.textContent = title;
      const range = document.createElement('input'); range.type = 'range'; range.min = key === 'spread' ? 1 : 0; range.max = max; range.value = n[key]; range.setAttribute('aria-label', title);
      range.oninput = () => { if (locked()) return; n[key] = +range.value; update(false); }; range.onchange = () => update(true);
      row.append(range); menu.append(row);
    }
    const remove = button(t.remove, () => {
      if (locked() || nodes.length <= 2) return;
      nodes.splice(i, 1); renderPoints(Math.min(i, nodes.length-1)); update(true);
    }, menu);
    remove.className = 'gradient-remove'; remove.disabled = nodes.length <= 2;
  }
  function openColor(n, i, input) {
    menu.querySelector('.tv-inline-color')?.remove();
    if (locked()) return;
    const set = c => { input.value = c; n.color = c; };
    const box = colorPicker({
      title: t.point(i+1), value: n.color, palette: palette(),
      preview: c => { if (locked()) return; set(c); update(false); },
      commit: c => { if (locked()) return; set(c); update(true); },
      close: () => { box.remove(); input.focus(); },
    });
    input.closest('label').after(box);
  }
  function renderPoints(selection = -1) {
    points.replaceChildren();
    nodes.forEach((n, i) => {
      const b = button('', () => select(i), points); b.className = 'gradient-point'; b.setAttribute('aria-label', t.point(i+1));
      let origin, moved = false;
      b.onpointerdown = e => {
        if (locked()) return;
        e.preventDefault(); setAdding(false); select(i); dragging = true; dragChanged = false; moved = false; origin = {x:e.clientX, y:e.clientY, nx:n.x, ny:n.y}; b.setPointerCapture(e.pointerId);
      };
      b.onpointermove = e => {
        if (!dragging || !b.hasPointerCapture(e.pointerId) || locked()) return;
        if (!moved && Math.hypot(e.clientX-origin.x, e.clientY-origin.y) < 3) return;
        moved = true; dragChanged = true;
        n.x = keep(origin.nx+(e.clientX-origin.x)/rect.width*100, origin.nx);
        n.y = keep(origin.ny+(e.clientY-origin.y)/rect.height*100, origin.ny); update(false);
      };
      const finish = e => {
        if (!dragging || !b.hasPointerCapture(e.pointerId)) return;
        dragging = false; b.releasePointerCapture(e.pointerId); if (moved) update(true);
      };
      b.onpointerup = finish; b.onpointercancel = finish;
      b.onkeydown = e => {
        const delta = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[e.key];
        if (!delta || locked()) return; e.preventDefault(); e.stopPropagation();
        n.x = keep(n.x+delta[0],n.x); n.y = keep(n.y+delta[1],n.y); update(true);
      };
    });
    addButton.disabled = nodes.length >= 8 || locked(); select(selection);
  }
  function preset(direction) {
    if (locked()) return;
    if (!nodes.length) nodes = initial();
    nodes.forEach((n,i) => { const p = i/(nodes.length-1)*100; n.x = direction === 'vertical' ? 50 : p; n.y = direction === 'horizontal' ? 50 : p; });
    setAdding(false); renderPoints(selected); update(true);
  }
  const initial = () => [{x:0,y:50,color:color(base),opacity:100,spread:100}, {x:100,y:50,color:'#205c8b',opacity:100,spread:100}];
  function decode(v) {
    ground = '';
    if (v === 'theme' && base === '--paper') { const theme = themeNodes(); if (theme) return theme; }
    const spots = [...v.matchAll(/radial-gradient\(ellipse (?:(\d+)% (\d+)% )?at (-?\d+)% (-?\d+)%, color-mix\(in srgb, (#[\da-f]{6}) (\d+)%, transparent\), transparent (\d+)%\)/gi)];
    if (spots.length) {
      ground = v.match(/linear-gradient\(\d+deg, #[\da-f]{6}(?: \d+%)?, #[\da-f]{6}(?: \d+%)?\)/i)?.[0] || '';
      return spots.map(m => ({...(m[1] && {w:+m[1],h:+m[2]}),x:+m[3],y:+m[4],color:m[5],opacity:+m[6],spread:+m[7]}));
    }
    const linear = v.match(/linear-gradient\((\d+)deg, var\(--(?:paper|header)\)(?: (\d+)%)?, (#[\da-f]{6})(?: (\d+)%)?\)/i);
    if (!linear) return initial();
    const rad = +linear[1]*Math.PI/180, ux = Math.sin(rad), uy = -Math.cos(rad), len = Math.abs(rect.width*ux)+Math.abs(rect.height*uy);
    return [+(linear[2] ?? 0), +(linear[4] ?? 100)].map((stop,i) => {
      const d = (stop/100-.5)*len;
      let x = clamp(d*ux, -rect.width/2, rect.width/2), y = Math.abs(uy) > .0001 ? (d-ux*x)/uy : 0;
      y = clamp(y, -rect.height/2, rect.height/2); if (Math.abs(ux) > .0001) x = (d-uy*y)/ux;
      return {x:clamp(50+x/rect.width*100,0,100),y:clamp(50+y/rect.height*100,0,100),color:i ? linear[3] : color(base),opacity:100,spread:100};
    });
  }
  // テーマの背景（表示中のページの計算後の値）を点に直す。点で表せない重ね方なら null
  function themeNodes() {
    const slide = editingDoc?.querySelector('#stage > .slide.active'); if (!slide) return null;
    const s = editingDoc.defaultView.getComputedStyle(slide);
    const layers = s.backgroundImage === 'none' ? [] : split(s.backgroundImage).filter(l => l !== 'none');
    const out = [], num = (v, a, b) => clamp(Math.round(+v), a, b);
    for (const [i, layer] of layers.entries()) {
      const radial = layer.match(/^radial-gradient\((.*)\)$/s);
      if (radial) {
        const args = split(radial[1]);
        const shape = args.length === 3 ? args.shift().match(/^(?:ellipse\s*)?(?:(-?[\d.]+)% (-?[\d.]+)%)?\s*(?:at (-?[\d.]+)% (-?[\d.]+)%)?$/) : [];
        const inner = args[0]?.match(/^(.*?)(?: 0(?:%|px))?$/s), outer = args[1]?.match(/^(.*) (-?[\d.]+)%$/s);
        const c = inner && rgba(inner[1]);
        if (!shape || args.length !== 2 || !c || !outer || rgba(outer[1])?.a !== 0) return null;
        out.push({...(shape[1] && {w:num(shape[1],1,200),h:num(shape[2],1,200)}), x:num(shape[3] ?? 50,-150,150), y:num(shape[4] ?? 50,-150,150), color:c.hex, opacity:num(c.a*100,0,100), spread:num(outer[2],1,150)});
        continue;
      }
      // 一番下の斜めの色だけは、点の下地として残す
      const linear = i === layers.length-1 && layer.match(/^linear-gradient\((.*)\)$/s);
      if (!linear) return null;
      const args = split(linear[1]), angle = /^-?[\d.]+deg$/.test(args[0]) ? Math.round(parseFloat(args.shift())) : 180;
      const stops = args.map(a => a.match(/^(.*?)(?: ([\d.]+)%)?$/s)).map(m => m && [rgba(m[1]), m[2]]);
      if (stops.length !== 2 || stops.some(([c]) => !c || c.a < 1)) return null;
      ground = `linear-gradient(${(angle%360+360)%360}deg, ${stops.map(([c, at]) => c.hex + (at ? ` ${num(at,0,100)}%` : '')).join(', ')})`;
    }
    if (!out.length || out.length > 8) { ground = ''; return null; }
    // テーマの地の色が背景の色と違えば（章扉を見出し色で塗るなど）、それも下地に残す
    const paper = rgba(s.backgroundColor);
    if (!ground && paper?.a === 1 && paper.hex !== color(base)) ground = `linear-gradient(180deg, ${paper.hex}, ${paper.hex})`;
    return out;
  }
  function refresh() {
    if (editor.hidden || dragging) return;
    const v = read(fill) || 'theme'; if (v === lastValue) return;
    lastValue = v; nodes = decode(v); setAdding(false); renderPoints();
  }
  function open(key) {
    close(); if (locked()) return;
    fill = key; base = key === '--header-fill' ? '--header' : '--paper'; page = target()?.index;
    editingDoc = target()?.win?.document; if (!editingDoc) return;
    const stage = editingDoc.querySelector('#stage'); oldInert = stage?.inert;
    rect = geometry(); if (!rect) { close(); return; }
    stage.inert = true;
    const headingElement = editingDoc.querySelector('#stage > .slide.active h2');
    originalHeadingInk = headingElement ? editingDoc.defaultView.getComputedStyle(headingElement).color : null;
    toolbar.replaceChildren(); showContent = false; selected = -1;
    const heading = document.createElement('div'); heading.className = 'gradient-heading';
    const title = document.createElement('strong'); title.textContent = base === '--paper' ? S.themes.background.title : S.themes.gradient.title; heading.append(title); toolbar.append(heading);
    const done = button('✓', close, heading); done.setAttribute('aria-label', t.done); done.title = t.done; done.className = 'gradient-done';
    const kinds = header?.(fill); if (kinds) toolbar.append(kinds);
    const modes = document.createElement('div'); modes.className = 'gradient-modes'; toolbar.append(modes);
    contentButtons = [t.backgroundOnly, t.withContent].map((label,i) => button(label, () => { showContent = !!i; content(); }, modes));
    const caption = document.createElement('span'); caption.className = 'gradient-section-title'; caption.textContent = t.presets; toolbar.append(caption);
    const presets = document.createElement('div'); presets.className = 'gradient-presets'; toolbar.append(presets);
    for (const k of ['horizontal','vertical','diagonal']) { const b = button(t[k], () => preset(k), presets); b.dataset.preset = k; }
    addButton = button(t.add, () => { if (!locked()) setAdding(!adding); }); addButton.className = 'gradient-add';
    hint = document.createElement('small'); hint.setAttribute('aria-live', 'polite'); toolbar.append(hint);
    const reset = button(t.original, () => { if (locked()) return; setAdding(false); lastValue = 'theme'; save(fill, 'theme'); ground = ''; nodes = (base === '--paper' && themeNodes()) || []; renderPoints(); }); reset.className = 'gradient-reset';
    lastValue = read(fill) || 'theme'; nodes = decode(lastValue);
    // 旧1点背景も開いただけでは書き換えない。最初の編集から2点で扱う。
    if (nodes.length === 1) nodes.push({...initial()[1], opacity:0});
    editor.hidden = false; overlay.hidden = false; host.scrollTop = 0; host.scrollLeft = 0; host.classList.add('gradient-editing'); setAdding(false); renderPoints(); content(); layout();
  }
  surface.onclick = e => {
    if (!adding) { select(-1); return; }
    if (locked() || nodes.length >= 8) return;
    if (!nodes.length) nodes = [initial()[0]];
    nodes.push({x:clamp((e.clientX-rect.left)/rect.width*100,0,100), y:clamp((e.clientY-rect.top)/rect.height*100,0,100), color:color(base), opacity:65, spread:70});
    setAdding(false); renderPoints(nodes.length-1); update(true);
  };
  function keydown(e) {
    if (editor.hidden || e.key !== 'Escape') return;
    if (e.target.closest?.('.tv-inline-color')) return; // 色の欄だけを閉じる
    e.preventDefault(); e.stopPropagation(); if (adding) setAdding(false); else close();
  }
  const outside = e => { if (!editor.hidden && !editor.contains(e.target) && !overlay.contains(e.target) && !e.target.closest('.tv-fill-open, #undo, #redo')) close(); };
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keydown, true);
  return { open, close, refresh, keydown, isOpen: () => !editor.hidden, destroy() { close(); editor.remove(); overlay.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown, true); } };
}
