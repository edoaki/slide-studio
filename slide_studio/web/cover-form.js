// 表紙の入力欄（原稿のブロック表示の表紙のページ）：タイトル・副題・発表者と所属。
// タイトルは ::: {.cover-title} の中身・表紙の見出し・front matter の title を一緒に直す。副題は ::: {.cover-subtitle}（空なら囲みごと消す）。
// 囲みの中はふつうの本文（スライドでほかのページと同じように直せる）。欄には書式の記法を除いた文字を出し、欄で直した所だけを書き換える。
// 発表者は front matter の author（Quarto と同じ name と affiliations）。表紙への差し込みと *1 の印は描画（cover.py）が行う。
import { toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';
import { headingLine, isCoverPart } from './block-ops.js';
import { frontEnd } from './qmd-editor.js';
import { structureOf } from './structure.js';

// ------------------------------------------------------------ 原稿の書き換え
// front matter の最上位のキーを書き換える。value は「key:」の後ろ（null で消す）。続く字下げ・- の行はそのキーの値として扱う
export function setFront(text, key, value) {
  const end = frontEnd(text);
  if (!end) return value == null ? text : `---\n${key}:${value}\n---\n\n${text}`;
  const lines = text.slice(0, end).split('\n');
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
  const pat = new RegExp(`^${key}[ \\t]*:`), at = lines.findIndex((l, i) => i > 0 && i < close && pat.test(l));
  const put = value == null ? [] : `${key}:${value}`.split('\n');
  if (at < 0) { if (value == null) return text; lines.splice(close, 0, ...put); }
  else {
    let stop = at + 1;
    while (stop < close && (/^[ \t]/.test(lines[stop]) || /^-([ \t]|$)/.test(lines[stop]) || !lines[stop].trim())) stop++;
    while (stop > at + 1 && !lines[stop - 1].trim()) stop--;
    lines.splice(at, stop - at, ...put);
  }
  return lines.join('\n') + text.slice(end);
}
// 表紙のページ（## … {… .cover …} から次の # ／ ## の前まで）
export function coverPage(text) {
  const from = frontEnd(text), rest = text.slice(from);
  const m = rest.match(/^##[ \t]+.*\{[^{}]*\.cover(?=[\s}])[^{}]*\}[ \t]*$/m);
  if (!m) return null;
  const headStart = from + m.index, headEnd = headStart + m[0].length;
  const next = text.slice(headEnd).match(/\n#{1,2}[ \t]/);
  return { headStart, headEnd, end: next ? headEnd + next.index + 1 : text.length };
}
// 表紙のページの ::: {.名前} … :::。body は中身（最後の改行を除く）
function coverDiv(text, pg, cls) {
  const part = text.slice(pg.headEnd, pg.end);
  const m = part.match(new RegExp(`^:{3,}[ \\t]*\\{\\.${cls}(?=[\\s}])[^{}]*\\}[ \\t]*\\n([\\s\\S]*?)^:{3,}[ \\t]*$`, 'm'));
  if (!m) return null;
  const start = pg.headEnd + m.index, bodyStart = start + m[0].indexOf('\n') + 1;
  return { start, end: start + m[0].length, bodyStart, bodyEnd: bodyStart + m[1].length, body: m[1].replace(/\n$/, '') };
}
const splice = (text, a, b, s) => text.slice(0, a) + s + text.slice(b);
// 原稿の中身 → 欄の文字と、欄の1文字ずつの原稿での範囲。行末の \ （と <br>・2つ以上の空白の改行）は欄の改行、ただの改行は空白。
// 書式の記法（[文字]{…}・[文字](…) の括弧と属性、* ）は欄に出さない
function plainOf(body) {
  const skip = new Set(), open = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') { i++; continue; }
    if (body[i] === '[') open.push(i);
    else if (body[i] === ']' && open.length) {
      const a = open.pop(), m = body.slice(i).match(/^\](\{[^{}]*\}|\([^()]*\))/);
      if (m) { skip.add(a); for (let k = i; k < i + m[0].length; k++) skip.add(k); i += m[0].length - 1; }
    }
  }
  let plain = '';
  const at = [];
  for (let i = 0; i < body.length; i++) {
    if (skip.has(i) || body[i] === '*') continue;
    const br = body.slice(i).match(/^(?:<br\s*\/?>\n?|\\\n| {2,}\n)/i);
    if (br) { at.push([i, i + br[0].length]); plain += '\n'; i += br[0].length - 1; }
    else if (body[i] === '\\' && i + 1 < body.length) { at.push([i, i + 2]); plain += body[++i]; }
    else { at.push([i, i + 1]); plain += body[i] === '\n' ? ' ' : body[i]; }
  }
  return { plain, at };
}
// 欄の改行は、ほかのページと同じ行末の \ で書く
const bodyOf = value => value.split('\n').join('\\\n');
// 欄の文字（value）にする。前後の同じ所は残し、変わった文字だけを入れ替える（スライドで付けた大きさ・色を消さない）
function edited(body, value) {
  value = value.replace(/\n+$/, '');
  const { plain, at } = plainOf(body);
  if (plain === value) return body;
  let a = 0, b = 0;
  while (a < plain.length && a < value.length && plain[a] === value[a]) a++;
  while (b < plain.length - a && b < value.length - a && plain.at(-1 - b) === value.at(-1 - b)) b++;
  const gone = at.slice(a, plain.length - b);
  const pos = gone.length ? gone[0][0] : a ? at[a - 1][1] : at.length ? at[0][0] : body.length;
  let out = body;
  for (const [s, e] of [...gone].reverse()) out = out.slice(0, s) + out.slice(e);
  out = out.slice(0, pos) + bodyOf(value.slice(a, value.length - b)) + out.slice(pos);
  return out.replace(/\[\]\{[^{}]*\}/g, '');
}
// 1行にする（日本語どうしの改行は詰め、英数字どうしは空白）
const oneLine = s => s.replace(/\n+/g, (m, i) => /[\x21-\x7e]/.test(s[i - 1] || '') && /[\x21-\x7e]/.test(s[i + m.length] || '') ? ' ' : '').trim();

export function readCover(text) {
  const pg = coverPage(text); if (!pg) return null;
  const t = coverDiv(text, pg, 'cover-title'), s = coverDiv(text, pg, 'cover-subtitle');
  return { title: t ? plainOf(t.body).plain : '', subtitle: s ? plainOf(s.body).plain : '' };
}
// 表紙の見出しと front matter の title を、表紙のタイトルの文字（書式を除いて1行）にそろえる
export function syncTitle(text) {
  const pg = coverPage(text), d = pg && coverDiv(text, pg, 'cover-title'); if (!d) return text;
  const title = oneLine(plainOf(d.body).plain);
  text = splice(text, pg.headStart, pg.headEnd, headingLine(text.slice(pg.headStart, pg.headEnd), title));
  return setFront(text, 'title', ` ${JSON.stringify(title)}`);
}
export function writeTitle(text, title) {
  const pg = coverPage(text); if (!pg) return text;
  const d = coverDiv(text, pg, 'cover-title'), body = d ? edited(d.body, title) : bodyOf(title.replace(/\n+$/, ''));
  text = d ? splice(text, d.bodyStart, d.bodyEnd, body ? body + '\n' : '')
    : splice(text, pg.headEnd, pg.headEnd, `\n\n::: {.cover-title}\n${body ? body + '\n' : ''}:::`);
  return syncTitle(text);
}
export function writeSubtitle(text, subtitle) {
  const pg = coverPage(text); if (!pg) return text;
  const d = coverDiv(text, pg, 'cover-subtitle');
  if (!subtitle) return d ? splice(text, text.slice(d.start - 2, d.start) === '\n\n' ? d.start - 2 : d.start, d.end, '') : text;
  if (d) return splice(text, d.bodyStart, d.bodyEnd, edited(d.body, subtitle) + '\n');
  const after = coverDiv(text, pg, 'cover-title')?.end ?? pg.headEnd;
  return splice(text, after, after, `\n\n::: {.cover-subtitle}\n${bodyOf(subtitle)}\n:::`);
}
// 名前の無い人は書かない（欄には残す）
export function writeAuthors(text, people) {
  const q = s => JSON.stringify(s);
  const list = people.filter(p => p.name.trim());
  return setFront(text, 'author', list.length ? list.map(p => `\n  - name: ${q(p.name.trim())}`
    + (p.affiliations.length ? '\n    affiliations:' + p.affiliations.map(a => `\n      - ${q(a)}`).join('') : '')).join('') : null);
}
// 所属の印（cover.py と同じ決め方）。2人以上が同じ所属を持ち、全員が同じではないときだけ { 所属: '*n' }
export function marks(people) {
  const list = people.filter(p => p.name.trim()), order = [];
  for (const p of list) for (const a of p.affiliations) if (!order.includes(a)) order.push(a);
  if (list.length > 1 && new Set(list.map(p => p.affiliations.join('\n'))).size === 1) return null;
  if (!order.some(a => list.filter(p => p.affiliations.includes(a)).length > 1)) return null;
  return Object.fromEntries(order.map((a, i) => [a, `*${i + 1}`]));
}

// ------------------------------------------------------------ 入力欄
const isMod = e => e.metaKey || e.ctrlKey;
const node = (tag, cls, attrs = {}) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, attrs);
const POSITIONS = ['bottom', 'right', 'left'];

// write(text, typing)：原稿を書く。leave(next)：欄から焦点が外れた（next は移った先）
export function makeCoverForm(ctx, { write, leave }) {
  const el = node('div', 'cover-form');
  el.innerHTML = `
    <textarea class="cf-title" rows="1" spellcheck="false" data-field="title" placeholder="${S.cover.titlePh}" aria-label="${S.cover.title}"></textarea>
    <input class="cf-sub" spellcheck="false" data-field="subtitle" placeholder="${S.cover.subtitlePh}" aria-label="${S.cover.subtitle}">
    <div class="cf-head"><span class="cf-label">${S.cover.people}</span>
      <div class="cf-pos" role="group" aria-label="${S.coverAuthors.position}"><span class="aff-position-label">${S.coverAuthors.positionLabel}</span>${POSITIONS.map(p => `<button type="button" data-position="${p}" aria-label="${S.coverAuthors[p]}" data-tip="${S.coverAuthors.position}：${S.coverAuthors[p]}">${S.coverAuthors[p]}</button>`).join('')}</div>
      <button class="cf-add" type="button" data-field="add" aria-label="${S.cover.addPerson}">${svg('userPlus')}</button></div>
    <div class="cf-people"></div>
    <div class="cf-sugg" role="listbox" hidden></div>`;
  const titleEl = el.querySelector('.cf-title'), subEl = el.querySelector('.cf-sub'), peopleEl = el.querySelector('.cf-people'), sugg = el.querySelector('.cf-sugg');
  const posEls = [...el.querySelectorAll('.cf-pos button')];
  let people = [], busy = false, drag = null, pick = null; // pick：候補 { input, items, at }

  const save = typing => {
    if (ctx.locked) { toast(S.locked); return; }
    write(writeAuthors(ctx.text, people), typing);
  };
  const size = () => { titleEl.style.height = '0'; titleEl.style.height = `${titleEl.scrollHeight}px`; };
  const paintPosition = position => posEls.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.position === position)));
  // 所属の位置だけを変える（移動した位置・文字サイズは残す）
  async function setPosition(position) {
    if (ctx.locked) { toast(S.locked); return; }
    paintPosition(position);
    const text = ctx.text, st = await structureOf(text);
    if (ctx.text !== text) return setPosition(position);
    const layout = st.meta?.['cover-authors-layout'];
    write(setFront(text, 'cover-authors-layout', ` ${JSON.stringify({ ...(layout && typeof layout === 'object' ? layout : {}), position })}`), false);
  }

  // 全員の所属（最初に出てきた順）
  const allAffs = () => [...new Set(people.flatMap(p => p.affiliations))];
  function chips() {
    const m = marks(people);
    peopleEl.querySelectorAll('.cf-person').forEach((row, i) => {
      row.querySelectorAll('.cf-aff').forEach(c => c.remove());
      const input = row.querySelector('.cf-aff-input');
      for (const a of people[i].affiliations) {
        const c = node('span', 'cf-aff');
        if (m) { const sup = node('sup', '', { textContent: m[a] }); tip(sup, S.cover.marks); c.append(sup); }
        c.append(node('span', '', { textContent: a }));
        const x = node('button', 'cf-x', { type: 'button', innerHTML: svg('x') });
        x.setAttribute('aria-label', S.cover.removeAff(a)); x.dataset.aff = a;
        c.append(x); input.before(c);
      }
    });
  }
  function renderPeople(focus) {
    busy = true;
    const rows = people.map((p, i) => {
      const row = node('div', 'cf-person'); row.dataset.i = i;
      const grip = node('span', 'cf-grip', { innerHTML: svg('grip') });
      grip.setAttribute('role', 'button'); grip.setAttribute('aria-label', S.cover.move); grip.dataset.keys = S.cover.moveKeys;
      const name = node('input', 'cf-name', { value: p.name, spellcheck: false, placeholder: S.cover.namePh });
      name.dataset.field = `name:${i}`; name.setAttribute('aria-label', `${S.cover.namePh} ${i + 1}`);
      const affs = node('div', 'cf-affs');
      const input = node('input', 'cf-aff-input', { spellcheck: false, placeholder: S.cover.affPh });
      input.dataset.field = `aff:${i}`; input.setAttribute('aria-label', `${S.cover.affPh} ${i + 1}`);
      affs.append(input);
      const del = node('button', 'cf-remove', { type: 'button', innerHTML: svg('trash') });
      del.setAttribute('aria-label', S.cover.removePerson);
      row.append(grip, name, affs, del);
      return row;
    });
    peopleEl.replaceChildren(...rows);
    chips();
    if (focus) el.querySelector(`[data-field="${focus}"]`)?.focus({ preventScroll: true });
    busy = false;
  }

  // ---------------------------------------------------------- 所属の候補（ほかの人の所属）
  function openPick(input) {
    const i = +input.closest('.cf-person').dataset.i, q = input.value.trim().toLowerCase();
    const items = allAffs().filter(a => !people[i].affiliations.includes(a) && (!q || a.toLowerCase().includes(q)));
    if (!items.length) { closePick(); return; }
    pick = { input, items, at: pick?.input === input ? Math.min(pick.at, items.length - 1) : -1 };
    sugg.replaceChildren(...items.map((a, k) => {
      const b = node('button', 'cf-option', { type: 'button', textContent: a });
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(k === pick.at)); b.dataset.k = k;
      tip(b, S.cover.pick(a));
      return b;
    }));
    const r = input.getBoundingClientRect(), b = el.getBoundingClientRect();
    Object.assign(sugg.style, { left: `${r.left - b.left}px`, top: `${r.bottom - b.top + 4}px`, minWidth: `${r.width}px` });
    sugg.hidden = false;
  }
  function closePick() { pick = null; sugg.hidden = true; }
  function addAff(input, value) {
    const i = +input.closest('.cf-person').dataset.i, a = value.trim();
    input.value = '';
    if (a && !people[i].affiliations.includes(a)) { people[i].affiliations.push(a); chips(); save(false); }
    if (document.activeElement === input) openPick(input); else closePick();
  }
  sugg.addEventListener('pointerdown', e => {
    e.preventDefault(); // 入力欄から焦点を移さない
    const b = e.target.closest('.cf-option');
    if (b && pick) addAff(pick.input, pick.items[+b.dataset.k]);
  });

  // ---------------------------------------------------------- 入力
  titleEl.addEventListener('input', () => { if (ctx.locked) return toast(S.locked); write(writeTitle(ctx.text, titleEl.value), true); size(); });
  subEl.addEventListener('input', () => { if (ctx.locked) return toast(S.locked); write(writeSubtitle(ctx.text, subEl.value), true); });
  peopleEl.addEventListener('input', e => {
    const row = e.target.closest('.cf-person'); if (!row) return;
    if (e.target.matches('.cf-name')) { people[+row.dataset.i].name = e.target.value; chips(); save(true); }
    if (e.target.matches('.cf-aff-input')) openPick(e.target);
  });
  function move(i, d) {
    const j = i + d; if (j < 0 || j >= people.length) return;
    [people[i], people[j]] = [people[j], people[i]];
    renderPeople(`name:${j}`); save(false);
  }
  el.addEventListener('keydown', e => {
    const t = e.target;
    e.stopPropagation();
    if (isMod(e) && e.key.toLowerCase() === 'z') { e.preventDefault(); t.blur?.(); e.shiftKey ? ctx.redo() : ctx.undo(); return; }
    if (e.isComposing) return;
    const row = t.closest('.cf-person'), i = row ? +row.dataset.i : -1;
    if (t.matches('.cf-aff-input')) {
      if (pick && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        pick.at = Math.max(-1, Math.min(pick.items.length - 1, pick.at + (e.key === 'ArrowDown' ? 1 : -1)));
        sugg.querySelectorAll('.cf-option').forEach((b, k) => b.setAttribute('aria-selected', String(k === pick.at)));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (pick && pick.at >= 0) addAff(t, pick.items[pick.at]);
        else if (t.value.trim()) addAff(t, t.value);
        // 空で Enter：次の人の名前へ（最後の人なら人を足す）
        else if (i === people.length - 1) { people.push({ name: '', affiliations: [] }); renderPeople(`name:${i + 1}`); }
        else el.querySelector(`[data-field="name:${i + 1}"]`)?.focus();
        return;
      }
      if (e.key === 'Backspace' && !t.value && people[i].affiliations.length) { e.preventDefault(); people[i].affiliations.pop(); chips(); save(false); openPick(t); return; }
      if (e.key === 'Escape' && pick) { e.preventDefault(); closePick(); return; }
    }
    if (t.matches('.cf-name')) {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(i, e.key === 'ArrowUp' ? -1 : 1); return; }
      if (e.key === 'Enter') { e.preventDefault(); el.querySelector(`[data-field="aff:${i}"]`)?.focus(); return; }
    }
    if (t === subEl && e.key === 'Enter') { e.preventDefault(); (el.querySelector('[data-field="name:0"]') || el.querySelector('[data-field="add"]')).focus(); return; }
    if (e.key === 'Escape') { e.preventDefault(); t.blur?.(); }
  });
  // 押しても焦点を移さない（欄に焦点があると描き直さないため）
  el.querySelector('.cf-pos').addEventListener('mousedown', e => e.preventDefault());
  el.addEventListener('click', e => {
    const pos = e.target.closest('.cf-pos button');
    if (pos) { if (pos.getAttribute('aria-pressed') !== 'true') setPosition(pos.dataset.position); return; }
    const row = e.target.closest('.cf-person'), i = row ? +row.dataset.i : -1;
    const x = e.target.closest('.cf-x');
    if (x) {
      people[i].affiliations = people[i].affiliations.filter(a => a !== x.dataset.aff);
      el.querySelector(`[data-field="aff:${i}"]`)?.focus({ preventScroll: true });
      chips(); save(false); return;
    }
    if (e.target.closest('.cf-remove')) {
      people.splice(i, 1);
      renderPeople(people.length ? `name:${Math.min(i, people.length - 1)}` : 'add'); save(false); return;
    }
    if (e.target.closest('.cf-add')) { people.push({ name: '', affiliations: [] }); renderPeople(`name:${people.length - 1}`); return; }
    // 所属の欄の空いている所を押したら入力欄へ
    if (e.target.matches('.cf-affs')) e.target.querySelector('.cf-aff-input')?.focus();
  });
  el.addEventListener('focusin', e => { if (e.target.matches('.cf-aff-input')) openPick(e.target); });
  el.addEventListener('focusout', e => {
    const t = e.target, next = e.relatedTarget;
    // 所属の欄に書きかけがあれば、離れたときに加える
    if (t.matches?.('.cf-aff-input') && !busy) { if (t.value.trim()) addAff(t, t.value); if (pick?.input === t) closePick(); }
    if (busy || drag || (next && el.contains(next))) return;
    leave(next);
  });

  // ---------------------------------------------------------- 並べ替え（つまみをドラッグ）
  peopleEl.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.cf-grip'); if (!grip || e.button) return;
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const row = grip.closest('.cf-person');
    drag = { row, from: +row.dataset.i }; row.classList.add('dragging');
  });
  peopleEl.addEventListener('pointermove', e => {
    if (!drag) return;
    const rows = [...peopleEl.querySelectorAll('.cf-person')], at = rows.indexOf(drag.row);
    const to = rows.filter(r => r !== drag.row).findIndex(r => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    const j = to < 0 ? rows.length - 1 : to;
    if (j === at) return;
    const [p] = people.splice(at, 1); people.splice(j, 0, p);
    const others = rows.filter(r => r !== drag.row);
    peopleEl.insertBefore(drag.row, others[j] || null);
  });
  const endDrag = () => {
    if (!drag) return;
    const moved = [...peopleEl.querySelectorAll('.cf-person')].indexOf(drag.row) !== drag.from;
    drag = null; renderPeople();
    if (moved) save(false);
  };
  peopleEl.addEventListener('pointerup', endDrag); peopleEl.addEventListener('pointercancel', endDrag);

  return {
    el,
    // 入力中・ドラッグ中は描き直さない
    get active() { return busy || !!drag || el.contains(document.activeElement); },
    // 原稿の構造から欄を作り直す（構造が今の原稿より古いときは、手元の欄のまま）
    update(st) {
      if (st.text !== ctx.text) return;
      const c = readCover(st.text) || { title: '', subtitle: '' };
      titleEl.value = c.title; subEl.value = c.subtitle;
      people = (st.authors || []).map(a => ({ name: a.name, affiliations: [...a.affiliations] }));
      const position = st.meta?.['cover-authors-layout']?.position;
      paintPosition(POSITIONS.includes(position) ? position : 'bottom');
      renderPeople(); closePick();
      requestAnimationFrame(size);
    },
    focus(field) {
      const f = el.querySelector(`[data-field="${field}"]`) || titleEl;
      f.focus({ preventScroll: false });
      if (f === titleEl || f === subEl) f.setSelectionRange(f.value.length, f.value.length);
    },
    fieldAt: t => t.closest?.('[data-field]')?.dataset.field ?? 'title',
  };
}

// 表紙の入力欄で扱う囲み（ブロック表示には出さない）
export const ownsChunk = (source, c) => isCoverPart(c) || c.kind === 'opaque' && /^:{3,}[ \t]*\{\.cover-(title|subtitle)(?=[\s}])/.test(source.slice(c.start, c.end));
