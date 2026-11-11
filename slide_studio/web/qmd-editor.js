// 原稿（qmd）のエディタ。元：ai-slide mock/gui/index.html の「原稿：すべての記法の表示」
// （textarea の後ろに色分けした pre を重ねる・ページの折りたたみ・::: の深さの色・閉じ忘れの警告）。
// ページの見出しは source.py と同じ規則（# と ##、コードと閉じた ::: の中を除く、直前が空行か見出し）。
import { esc } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { captureScroll, restoreScroll } from './scroll-anchor.js';

const DIV_RE = /^(\s*)(:{3,})(\s*)(.*?)(\s*)$/;
const BOX_CLASS = /(?:^|[\s{])\.(row|columns|column)(?=[\s}]|$)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// front matter の終わり（閉じの行の改行の後）。無ければ 0
export function frontEnd(text) {
  const m = text.match(/^---[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/);
  return m ? m[0].length : 0;
}
const qLayer = d => d <= 1 ? 'var(--l1)' : d === 2 ? 'var(--l2)' : 'var(--l3)';
const lineEnd = (lines, i) => lines.slice(0, i + 1).reduce((n, l) => n + l.length + 1, 0) - 1;
const lineStart = (lines, i) => lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);

// 文書を上から読み、::: の対応と深さ、コードの囲みを調べる（変換できない途中の状態でも色を付ける）
export function qmdScan(lines) {
  const divs = [], kind = [], stack = [];
  let code = null, math = false;
  lines.forEach((line, i) => {
    if (code) { kind[i] = code.test(line) ? (code = null, 'code-fence') : 'code'; return; }
    const cf = line.match(FENCE);
    if (cf) {
      const close = new RegExp(`^\\s{0,3}${cf[1][0] === '`' ? '`' : '~'}{${cf[1].length},}\\s*$`);
      // 閉じのない ``` は Pandoc では文字になる（囲みにしない）
      if (lines.slice(i + 1).some(l => close.test(l))) { code = close; kind[i] = 'code-fence'; return; }
    }
    if (/^\s*\$\$\s*$/.test(line)) { math = !math; kind[i] = 'math-fence'; return; }
    if (math) { kind[i] = 'math'; return; }
    const m = line.match(DIV_RE);
    if (!m) return;
    if (!m[4]) {
      const d = stack.pop();
      if (d) { d.close = i; kind[i] = { close: d }; } else kind[i] = { stray: true };
      return;
    }
    const cls = (m[4].match(BOX_CLASS) || [])[1] || null;
    const parent = [...stack].reverse().find(d => d.depth);
    const top = stack[stack.length - 1];
    const merged = cls === 'columns' && top && top.cls === 'column' && top.open === i - 1;
    const d = { open: i, close: null, cls, depth: (merged ? top.depth : (parent ? parent.depth : 0) + 1) };
    divs.push(d); stack.push(d); kind[i] = { open: d };
  });
  for (const d of stack) d.unclosed = true;
  return { divs, kind };
}

// ページの見出しの行（source.py と同じ規則）。levels[i] は 1 か 2、見出しでなければ 0
export function pageHeads(lines, scan = qmdScan(lines), offset = 0) {
  const inClosed = new Array(lines.length).fill(0);
  for (const d of scan.divs) if (d.close != null) for (let k = d.open + 1; k < d.close; k++) inClosed[k]++;
  // front matter は数えない
  let first = offset;
  if (lines[0] === '---' || /^---\s*$/.test(lines[0] || '')) {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) first = end + 1;
  }
  const heads = [];
  for (let i = first; i < lines.length; i++) {
    const k = scan.kind[i];
    if (k === 'code' || k === 'code-fence' || inClosed[i]) continue;
    const marker = scan.divs.find(d => d.open === i && d.close != null && /^:{3,}\s*\{#(?:toc|refs)(?:[\s}])/.test(lines[i]) && lines.slice(i + 1, d.close).every(l => !l.trim()));
    if (marker) {
      const previous = heads.at(-1);
      if (previous && /\{#(?:toc|references)\}/.test(lines[previous.line]) && lines.slice(previous.line + 1, i).every(l => !l.trim())) previous.generated = true;
      else heads.push({ line: i, level: 2, generated: true });
      continue;
    }
    const m = lines[i].match(/^(#{1,2})[ \t]+\S/);
    if (!m) continue;
    const prev = lines[i - 1];
    if (i === first || prev == null || !prev.trim() || heads.at(-1)?.line === i - 1) heads.push({ line: i, level: m[1].length });
  }
  return heads;
}

const qData = (k, v) => ` data-q="${esc(k)}"${v != null ? ` data-v="${esc(v)}"` : ''}`;
function qAttrHTML(s, lc) {
  const inner = s.replace(/^\{|\}$/g, ''), braced = s.startsWith('{');
  const body = inner.replace(/(\s+)|(\.(?:row|columns|column))(?=\s|$)|(\.[\w-]+|#[\w:.-]+)|([\w-]+)(=)("[^"]*"?|\S+)|(\S+)/g, (t, sp, box, other, k, eq, v, rest) =>
    sp ? sp : box ? `<span style="color:${lc}"${qData('cls', box.slice(1))}>${esc(box)}</span>`
      : other ? `<span class="q-m"${qData(other[0] === '#' ? 'id' : 'cls', other.slice(1))}>${esc(other)}</span>`
      : k ? `<span class="q-m"${qData('key', k)}>${esc(k)}${eq}</span><span class="q-v">${esc(v)}</span>`
      : `<span class="q-m"${braced ? '' : qData('cls', rest)}>${esc(rest)}</span>`);
  return braced ? `<span class="q-m">{</span>${body}${s.endsWith('}') ? '<span class="q-m">}</span>' : ''}` : body;
}
const SAFE_COLOR = /^[#\w(),.%\s-]+$/;
const INLINE_RE = /(`+)([^`]*?)\1|\{\{<(\s*)([\w-]+)([^>]*?)>\}\}|!\[([^\]]*)\]\(([^)\s]*)\)(\{[^}]*\})?|\[((?:[^\[\]\n]*?[\s;])?-?@[^\]\n]+)\](?![({])|\[([^\]]+)\]\{([^}]*)\}|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|\$([^$\s](?:[^$]*[^$\s])?)\$|\^\[((?:[^\[\]]|\[[^\[\]]*\])*)\]|(?<![\wÀ-￿@\]\\])(-?@[\wÀ-￿](?:[\wÀ-￿]|[:.#$%&+?<>~/-](?=[\wÀ-￿]))*)|<!--.*?-->|\\$/g;
export function qInline(s, ctx = {}) {
  const m = x => `<span class="q-m">${esc(x)}</span>`;
  let out = '', at = 0;
  for (const t of s.matchAll(INLINE_RE)) {
    out += esc(s.slice(at, t.index)); at = t.index + t[0].length;
    const [all, ticks, , sp, sc, args, alt, src, iattr, cite, stext, sattr, ltext, url, bold, ital, math, note, ncite] = t;
    const q = (k, v, html) => `<span${qData(k, v)}>${html}</span>`;
    if (ticks) out += `<span class="q-code"${qData('code')}>${esc(all)}</span>`;
    else if (sc) {
      const a = args.match(/^(\s*)("?[^\s"]+"?)?([\s\S]*)$/);
      const bad = sc !== 'fig';
      out += q('sc', sc, m(`{{<${sp}`) + `<span class="${bad ? 'q-m q-warn' : 'q-m'}">${esc(sc)}</span>` + m(a[1]) + (a[2] ? `<span class="q-name">${esc(a[2])}</span>` : '') + m(`${a[3]}>}}`));
    }
    else if (src != null) out += q('img', src, m('![') + esc(alt) + m(`](${src})${iattr || ''}`));
    else if (cite || ncite) {
      const keys = [...(cite || ncite).matchAll(/-?@([\wÀ-￿:.#$%&+?<>~/-]+)/g)].map(x => x[1].replace(/[.:]+$/, ''));
      const missing = ctx.bib && keys.some(k => !ctx.bib.has(k));
      const cls = `q-cite${missing ? ' q-err' : ''}`;
      out += cite ? `<span class="${cls}"${qData('cite', all)}>${m('[')}${esc(cite)}${m(']')}</span>` : `<span class="${cls}"${qData('cite', all)}>${esc(all)}</span>`;
    }
    else if (stext) {
      const c = (sattr.match(/color:\s*([^;"]+)/) || [])[1]?.trim();
      const text = c && SAFE_COLOR.test(c) ? `<span class="q-sw" style="text-decoration:underline 2px ${esc(c)}">${qInline(stext, ctx)}</span>` : qInline(stext, ctx);
      out += m('[') + text + `<span class="q-m"${qData('span', sattr)}>${esc(`]{${sattr}}`)}</span>`;
    }
    else if (ltext) out += m('[') + qInline(ltext, ctx) + `<span class="q-m"${qData('link', url)}>${esc(`](${url})`)}</span>`;
    else if (bold) out += `<span class="q-m"${qData('b')}>${esc(all.slice(0, 2))}</span><b>${qInline(bold, ctx)}</b>${m(all.slice(-2))}`;
    else if (ital) out += `<span class="q-m"${qData('i')}>*</span><i>${qInline(ital, ctx)}</i>${m('*')}`;
    else if (math) out += q('math', null, m('$') + esc(math) + m('$'));
    else if (note != null) out += `<span class="q-m"${qData('note')}>^[</span>${qInline(note, ctx)}${m(']')}`;
    else if (all.startsWith('<!--')) out += `<span class="q-m q-cmt"${qData('cmt')}>${esc(all)}</span>`;
    else out += `<span class="q-m"${qData('br')}>${esc(all)}</span>`;
  }
  return out + esc(s.slice(at));
}
function lineHTML(line, k, pair, isHead, ctx) {
  if (k === 'code-fence' || k === 'math-fence') return `<span class="q-m"${qData(k)}>${esc(line)}</span>`;
  if (k === 'code') return `<span class="q-codeblock">${esc(line)}</span>`;
  if (k === 'math') return esc(line);
  if (k && typeof k === 'object') {
    const d = k.open || k.close, m = line.match(DIV_RE);
    const lc = d && d.depth ? qLayer(d.depth) : 'var(--muted)';
    const warn = k.stray || (k.open && d.warn);
    const fence = `<span class="q-f${warn ? ' q-warn' : ''}${pair ? ' q-pair' : ''}" style="color:${lc}"${qData(k.close ? 'div-close' : 'div')}>${esc(m[2])}</span>`;
    const attr = m[4] ? qAttrHTML(m[4], d && d.depth ? lc : 'var(--muted)') : '';
    return esc(m[1]) + fence + esc(m[3]) + attr + esc(m[5]);
  }
  const h = isHead && line.match(/^(#{1,6})(\s+)(.*?)(\s+\{[^}]*\})?(\s*)$/);
  if (h) {
    const ha = h[4] ? h[4].match(/^(\s+)(.*)$/) : null;
    return `<span class="q-hm"${qData('h' + h[1].length)}>${h[1]}</span>${h[2]}<span class="q-ht">${qInline(h[3], ctx)}</span>${ha ? ha[1] + `<span class="q-m">${qAttrHTML(ha[2], 'var(--muted)')}</span>` : ''}${h[5]}`;
  }
  const li = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)([\s\S]*)$/);
  if (li) return `${li[1]}<span class="q-m"${qData(/\d/.test(li[2]) ? 'ol' : 'ul')}>${esc(li[2])}</span>${li[3]}${qInline(li[4], ctx)}`;
  return qInline(line, ctx);
}

export class QmdEditor {
  constructor(host, { onInput, onCaret, onFold, onLocked } = {}) {
    this.host = host;
    this.onInput = onInput || (() => {});
    this.onCaret = onCaret || (() => {});
    this.onFold = onFold || (() => {}); // 畳み方が変わったかもしれないとき（描き直すたび）
    this.onLocked = onLocked || (() => {}); // front matter を書き換えようとしたとき
    this.folds = []; // 畳んだページの本文：{at: 表示中の文字列での見出し行の末尾, body: そこへ戻す文字列（\n から始まる）}
    this.prev = '';
    this.page = 0;
    this.ctx = {};
    this.mark = null; // 強調する範囲（原文の文字位置）{start, end, color}
    host.innerHTML = `<div class="raw"><pre aria-hidden="true"></pre><textarea spellcheck="false" aria-label="qmd"></textarea><div class="raw-fold"></div></div>`;
    this.ta = host.querySelector('textarea');
    this.pre = host.querySelector('pre');
    this.foldBox = host.querySelector('.raw-fold');
    this.ta.addEventListener('input', e => {
      if (this.frontChanged(this.before)) { if (!e.isComposing) this.restore(this.before); return; }
      this.shiftFolds(); this.highlight(); this.onInput(this.text()); this.caret();
    });
    // front matter（--- から --- まで）は型が決まっているので直接は書き換えない（タイトル・発表者は表紙の欄、テーマはテーマのタブ）。
    // 触れる入力は止め、止められない入力（日本語の変換など）は確定したときに元へ戻す
    this.ta.addEventListener('beforeinput', e => {
      const ta = this.ta, s = ta.selectionStart, end = ta.selectionEnd, lock = frontEnd(ta.value);
      if (!e.isComposing) this.before = { value: ta.value, s, end };
      if (!lock) return;
      // 範囲の置き換え（全体の貼り直しなど）は、front matter が変わったときだけ入力の後で戻す
      const hit = s === end && (/Backward$/.test(e.inputType) ? s > 0 && s <= lock : s < lock);
      if (hit && e.cancelable) { e.preventDefault(); this.onLocked(); }
    });
    this.ta.addEventListener('compositionstart', () => { const ta = this.ta; this.before = { value: ta.value, s: ta.selectionStart, end: ta.selectionEnd }; });
    this.ta.addEventListener('compositionend', () => { if (this.frontChanged(this.before)) this.restore(this.before); });
    for (const ev of ['keyup', 'click', 'focus', 'blur']) this.ta.addEventListener(ev, () => { this.highlight(); this.caret(); });
    document.addEventListener('selectionchange', () => { if (document.activeElement === this.ta) this.caret(); });
  }

  frontChanged(before) {
    const lock = before && frontEnd(before.value);
    return !!lock && (frontEnd(this.ta.value) !== lock || this.ta.value.slice(0, lock) !== before.value.slice(0, lock));
  }
  restore(before) {
    this.ta.value = before.value; this.ta.setSelectionRange(before.s, before.end);
    this.highlight(); this.onLocked();
  }

  // ------------------------------------------------------------ 文字列
  text() {
    let t = this.ta.value;
    for (const f of [...this.folds].sort((a, b) => b.at - a.at)) t = t.slice(0, f.at) + f.body + t.slice(f.at);
    return t;
  }
  // 原文を入れ替える。畳んだページは見出しの行の文字で覚えて畳み直す。カーソルは原文の位置で残す
  setText(text, { caret } = {}) {
    const scroller = this.host.hidden ? null : this.host.closest('.ed-scroll');
    const anchor = scroller && captureScroll(scroller, this.scrollEntries(), this.text(), text);
    const folded = new Set(this.foldedHeads());
    const pos = caret ?? this.caretOffset();
    this.ta.value = text; this.folds = [];
    const allLines = text.split('\n'), allHeads = pageHeads(allLines);
    const ranges = frontEnd(text) ? [{ start: 0, end: frontEnd(text) }] : [];
    allHeads.forEach((h, i) => {
      if (h.generated || /\{[^}]*\.cover(?:[\s}])/.test(allLines[h.line])) ranges.push({ start: lineStart(allLines, h.line), end: allHeads[i + 1] ? lineStart(allLines, allHeads[i + 1].line) : text.length });
    });
    const merged = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (last && !text.slice(last.end, r.start).trim()) last.end = r.end;
      else merged.push({ ...r });
    }
    for (const r of merged.reverse()) {
      this.ta.value = this.ta.value.slice(0, r.start) + this.ta.value.slice(r.end);
      for (const f of this.folds) f.at -= r.end - r.start;
      this.folds.push({ at: r.start, body: text.slice(r.start, r.end), managed: true });
    }
    this.prev = this.ta.value;
    const lines = this.ta.value.split('\n'), heads = pageHeads(lines);
    for (let k = heads.length - 1; k >= 0; k--) if (folded.has(lines[heads[k].line])) this.toggle(k, false);
    this.setCaretOffset(Math.min(pos, text.length), false);
    this.highlight();
    if (anchor) restoreScroll(scroller, anchor, this.scrollEntries());
  }
  scrollEntries() {
    let pos = 0;
    const lines = this.ta.value.split('\n');
    return [...this.pre.children].map((el, i) => {
      const entry = { el, pos: this.toFull(pos) };
      pos += (lines[i]?.length ?? 0) + 1;
      return entry;
    });
  }
  foldedHeads() {
    const lines = this.ta.value.split('\n');
    return pageHeads(lines).filter(h => this.folds.some(f => !f.managed && f.at === lineEnd(lines, h.line))).map(h => lines[h.line]);
  }
  // 表示中の文字位置 ⇄ 原文の文字位置
  toFull(pos) { let x = pos; for (const f of this.folds) if (f.at < pos || (f.managed && f.at === pos)) x += f.body.length; return x; }
  toDisp(pos) {
    let shift = 0;
    for (const f of [...this.folds].sort((a, b) => a.at - b.at)) {
      const at = f.at + shift;
      if (pos <= at) break;
      if (pos <= at + f.body.length) return f.at;
      shift += f.body.length;
    }
    return pos - shift;
  }
  caretOffset() { return this.toFull(this.ta.selectionStart); }
  setCaretOffset(pos, focus = true) {
    this.unfoldAt(pos);
    const d = this.toDisp(pos);
    if (focus) this.ta.focus({ preventScroll: true });
    this.ta.setSelectionRange(d, d);
  }
  replaceRange(start, end, text) {
    // 打ち込んだのと同じ扱い（textarea の取り消しにも残る）
    this.unfoldAt(start); this.unfoldAt(end);
    const a = this.toDisp(start), b = this.toDisp(end);
    this.ta.focus({ preventScroll: true }); this.ta.setSelectionRange(a, b);
    if (!document.execCommand('insertText', false, text)) { this.ta.setRangeText(text, a, b, 'end'); this.ta.dispatchEvent(new Event('input')); }
  }
  setDisabled(v) { this.ta.disabled = v; }

  // ------------------------------------------------------------ ページ
  heads() { return pageHeads(this.text().split('\n')); }
  pageAtOffset(pos) {
    const full = this.text(), lines = full.split('\n'), heads = pageHeads(lines);
    const line = full.slice(0, pos).split('\n').length - 1;
    return Math.max(0, heads.filter(h => h.line <= line).length - 1);
  }
  caret() {
    const p = this.pageAtOffset(this.caretOffset());
    const pos = this.caretOffset();
    if (p !== this.page || pos !== this.lastPos) { this.lastPos = pos; this.page = p; this.onCaret(p, pos); this.highlight(); }
  }
  // ページの見出しの行を、スクロールの一番上に出す（カーソルは動かさない）
  revealPage(k, scroller) {
    this.page = k;
    const lines = this.ta.value.split('\n'), h = pageHeads(lines).find(h => this.pageAtOffset(this.toFull(lineStart(lines, h.line))) === k);
    this.highlight();
    if (!h) return;
    const el = this.pre.children[h.line];
    if (el && scroller) scroller.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: 'smooth' });
  }
  // ページの見出しの行の要素（表示切り替えで位置を合わせるのに使う）
  headEl(k) {
    const lines = this.ta.value.split('\n');
    const h = pageHeads(lines).find(h => this.pageAtOffset(this.toFull(lineStart(lines, h.line))) === k);
    return h ? this.pre.children[h.line] : null;
  }
  revealOffset(pos, scroller) {
    const d = this.toDisp(pos), line = this.ta.value.slice(0, d).split('\n').length - 1;
    const el = this.pre.children[line];
    if (el && scroller) {
      const top = el.offsetTop, view = scroller.clientHeight;
      if (top < scroller.scrollTop + 20 || top > scroller.scrollTop + view - 60) scroller.scrollTo({ top: Math.max(0, top - view / 3), behavior: 'smooth' });
    }
  }

  // ------------------------------------------------------------ 折りたたみ（mock の RF）
  toggle(k, render = true) {
    const ta = this.ta, v = ta.value, lines = v.split('\n'), heads = pageHeads(lines);
    const h = heads[k]?.line; if (h == null) return;
    const at = lineEnd(lines, h), open = this.folds.find(f => !f.managed && f.at === at);
    let a = ta.selectionStart, b = ta.selectionEnd;
    if (open) {
      this.folds = this.folds.filter(f => f !== open);
      for (const f of this.folds) if (f.at > at) f.at += open.body.length;
      if (a > at) a += open.body.length; if (b > at) b += open.body.length;
      ta.value = v.slice(0, at) + open.body + v.slice(at);
    } else {
      let e = (heads[k + 1]?.line ?? lines.length) - 1;
      while (e > h && !lines[e].trim()) e--;
      if (e === h) return;
      const end = lineEnd(lines, e), body = v.slice(at, end);
      for (const f of this.folds) if (f.at > at) f.at -= body.length;
      const fix = x => x <= at ? x : x < end ? at : x - body.length;
      a = fix(a); b = fix(b);
      ta.value = v.slice(0, at) + v.slice(end);
      this.folds.push({ at, body });
    }
    this.prev = ta.value;
    if (document.activeElement === ta) ta.setSelectionRange(a, b);
    if (render) this.highlight();
  }
  unfoldAt(pos) {
    // 原文の pos を含む畳んだ本文を開く
    for (;;) {
      const lines = this.ta.value.split('\n'), heads = pageHeads(lines);
      let shift = 0, hit = -1;
      const sorted = [...this.folds].sort((a, b) => a.at - b.at);
      for (const f of sorted) {
        const at = f.at + shift;
        if (!f.managed && pos > at && pos <= at + f.body.length) { hit = heads.findIndex(h => lineEnd(lines, h.line) === f.at); break; }
        shift += f.body.length;
      }
      if (hit < 0) return;
      this.toggle(hit, false);
    }
  }
  // 開いているページの数（本文の無いページは畳めないので数えない）
  openPages() {
    const lines = this.ta.value.split('\n'), heads = pageHeads(lines), ats = new Set(this.folds.map(f => f.at));
    return heads.filter((h, k) => {
      if (ats.has(lineEnd(lines, h.line))) return false;
      let e = (heads[k + 1]?.line ?? lines.length) - 1;
      while (e > h.line && !lines[e].trim()) e--;
      return e > h.line;
    }).length;
  }
  foldAll(others) {
    const n = pageHeads(this.ta.value.split('\n')).length;
    for (let k = n - 1; k >= 0; k--) {
      const lines = this.ta.value.split('\n'), h = pageHeads(lines)[k];
      if (!h) continue;
      const folded = this.folds.some(f => !f.managed && f.at === lineEnd(lines, h.line));
      if (folded !== (others && this.pageAtOffset(this.toFull(lineStart(lines, h.line))) !== this.page)) this.toggle(k, false);
    }
    this.highlight();
  }
  // 入力の前後の差から、畳んだ位置をずらす。畳んだ位置をまたいで消したら、隠れた本文も消す
  shiftFolds() {
    const v = this.ta.value, old = this.prev;
    if (v === old) return;
    let p = 0; const max = Math.min(v.length, old.length);
    while (p < max && v[p] === old[p]) p++;
    let q = 0; while (q < max - p && v[v.length - 1 - q] === old[old.length - 1 - q]) q++;
    const end0 = old.length - q, ins = v.length - q - p;
    this.folds = this.folds.filter(f => f.managed || !(f.at > p && f.at < end0));
    for (const f of this.folds) f.at = f.at < p || (f.managed && f.at === p) ? f.at : f.at > end0 ? f.at + ins - (end0 - p) : p + ins;
    this.prev = v;
  }

  // ------------------------------------------------------------ 色分け
  highlight() {
    const ta = this.ta, lines = ta.value.split('\n');
    const scan = qmdScan(lines), { divs, kind } = scan;
    const heads = pageHeads(lines, scan), headAt = new Map(heads.map((h, k) => [h.line, { ...h, k }]));
    const focused = document.activeElement === ta;
    const caretLine = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
    const end = d => d.close ?? lines.length - 1;
    const cur = focused ? divs.filter(d => d.depth && caretLine >= d.open && caretLine <= end(d)).pop() : null;
    const pair = focused ? divs.find(d => d.open === caretLine || d.close === caretLine) : null;
    // 閉じていない囲み（見出しのような行より前で閉じていないもの）
    const fixes = this.unclosed(lines, divs).filter(f => !(focused && caretLine >= f.from && caretLine < f.end));
    for (const f of fixes) for (const d of f.divs) d.warn = true;
    const foldLines = new Set(this.folds.map(f => lines.slice(0, lines.length).findIndex((l, i) => lineEnd(lines, i) === f.at)));
    let mark = null;
    if (this.mark) {
      const a = this.toDisp(this.mark.start), b = this.toDisp(this.mark.end);
      mark = { a: ta.value.slice(0, a).split('\n').length - 1, b: ta.value.slice(0, b).split('\n').length - 1, color: this.mark.color };
    }
    const rawFrom = this.rawOnlyFrom != null ? this.toDisp(this.rawOnlyFrom) : null;
    const rawLine = rawFrom != null ? ta.value.slice(0, rawFrom).split('\n').length - 1 : Infinity;
    let seen = false;
    const frontLines = ta.value.slice(0, frontEnd(ta.value)).split('\n').length - 1;
    this.pre.innerHTML = lines.map((l, i) => {
      const h = headAt.get(i);
      const cls = ['l'];
      if (h) { cls.push(h.level === 1 ? 'h1' : 'h2'); if (seen) cls.push('sep'); }
      if (l.trim()) seen = true;
      let bg = null;
      if (mark && i >= mark.a && i <= mark.b) { cls.push('sel'); }
      else if (cur && i >= cur.open && i <= end(cur)) bg = qLayer(cur.depth);
      if (bg) cls.push('hl');
      if (i >= rawLine) cls.push('rawonly');
      if (i < frontLines) cls.push('front');
      const p = pair && (i === pair.open || i === pair.close) && pair.close != null;
      const fold = foldLines.has(i) ? '<span class="q-fold">⋯</span>' : '';
      const isHead = !!h || !/^#{1,6}\s/.test(l) || kind[i] == null;
      return `<span class="${cls.join(' ')}"${bg ? ` style="--hc:${bg}"` : ''}>${lineHTML(l, kind[i], p, isHead, this.ctx) || ''}${fold}</span>`;
    }).join('');
    ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
    this.foldButtons(lines, heads, fixes);
    this.onFold();
  }
  unclosed(lines, divs) {
    const heads = lines.map((l, i) => /^#{1,2}\s/.test(l) && (i === 0 || !lines[i - 1].trim()) ? i : -1).filter(i => i >= 0);
    const out = [];
    for (const d of divs) {
      const endLine = heads.find(h => h > d.open) ?? lines.length;
      if (d.close != null && d.close < endLine) continue;
      let f = out.find(f => f.end === endLine);
      if (!f) {
        let at = endLine - 1; while (at > d.open && !lines[at].trim()) at--;
        out.push(f = { from: d.open, end: endLine, at, divs: [] });
      }
      f.divs.push(d);
    }
    return out;
  }
  closeDivs(f) {
    const lines = this.ta.value.split('\n'), pos = this.toFull(lineEnd(lines, f.at));
    const text = [...f.divs].sort((x, y) => y.open - x.open).map(d => '\n' + lines[d.open].match(DIV_RE)[2]).join('');
    this.replaceRange(pos, pos, text);
  }
  foldButtons(lines, heads, fixes) {
    const box = this.foldBox, els = this.pre.children;
    const ats = new Set(this.folds.map(f => f.at));
    box.textContent = '';
    heads.forEach((h, k) => {
      const el = els[h.line]; if (!el) return;
      const folded = ats.has(lineEnd(lines, h.line));
      const row = document.createElement('div');
      row.className = 'rf-row' + (folded ? ' folded' : '') + (this.pageAtOffset(this.toFull(lineStart(lines, h.line))) === this.page ? ' cur' : '');
      row.style.top = (el.offsetTop + (el.offsetHeight - 18) / 2) + 'px';
      const num = document.createElement('span'); num.className = 'rf-num'; num.textContent = this.pageAtOffset(this.toFull(lineStart(lines, h.line))) + 1;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'rf-chev';
      b.innerHTML = svg(folded ? 'chevR' : 'chevD');
      b.title = folded ? S.unfoldPage : S.foldPage;
      b.setAttribute('aria-expanded', String(!folded));
      b.addEventListener('pointerdown', e => e.preventDefault());
      b.addEventListener('click', () => this.toggle(k));
      row.append(num, b); box.append(row);
    });
    for (const f of fixes) {
      const el = els[f.divs[0].open], mark = els[f.at]; if (!el) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'rf-fix';
      b.style.top = (el.offsetTop + (el.offsetHeight - 20) / 2) + 'px';
      b.innerHTML = svg('alert'); b.title = S.closeDiv; b.setAttribute('aria-label', S.closeDiv);
      b.addEventListener('pointerdown', e => e.preventDefault());
      b.addEventListener('pointerenter', () => mark?.classList.add('fix-at'));
      b.addEventListener('pointerleave', () => mark?.classList.remove('fix-at'));
      b.addEventListener('click', () => this.closeDivs(f));
      box.append(b);
    }
  }
}

export { lineStart, lineEnd };
