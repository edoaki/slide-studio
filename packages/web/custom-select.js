// 選択欄（<studio-select>）。OS 標準の選択欄（select 要素）の代わりに使い、見た目とキー操作をアプリでそろえる。
// select 要素に近い使い方：value（読み書き）、options（[{ value, label, disabled }] の読み書き）、add({ value, label })、
// disabled、name（form に値を渡す）、change／input イベント、onchange。中の <option> は最初に読んで選択肢にする。
//   variant="segmented"：選択肢を横に並べたボタン（.seg）。2〜4 件の短い選択肢向け。それ以外は下に一覧を出す。
//   placeholder：どれも選んでいないときに出す文。付けると最初は未選択（value は ''）になる。
//   size="sm"：小さい欄（ツールバー向け）。
// 一覧は popover で最前面に出すので、ダイアログの中や overflow で切れる場所でも隠れない。入らなければ上に出す。
// キー：↑↓ Home End PageUp PageDown で移動、Enter・Space で決定、Esc で閉じる、文字を打つとその文字で始まる行へ。
import { svg } from './icons.js';

const SAFE = 8, GAP = 4, MAX_HEIGHT = 320, MAX_WIDTH = 420;
let serial = 0;
const zoom = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
const toOption = o => ({ value: String(o.value ?? ''), label: String(o.label ?? o.text ?? o.value ?? ''), disabled: !!o.disabled });

export class StudioSelect extends HTMLElement {
  static formAssociated = true;
  static observedAttributes = ['disabled', 'aria-label', 'placeholder', 'variant'];
  #internals = this.attachInternals();
  #options = []; #value = null; #initial = null; #ready = false; #formDisabled = false;
  #trigger = null; #text = null; #list = null; #group = null;
  #active = -1; #typed = ''; #typedAt = 0; #label = '';
  #id = `ss-${++serial}`;

  connectedCallback() { this.#ensure(); }
  disconnectedCallback() { this.#close(false); }
  attributeChangedCallback(name) {
    if (!this.#ready) return;
    if (name === 'aria-label') { this.#takeLabel(); return; }
    if (name === 'variant') { this.#build(); return; }
    this.#render();
  }
  formDisabledCallback(disabled) { this.#formDisabled = disabled; if (this.#ready) this.#render(); }
  formResetCallback() { this.#value = this.#initial; if (this.#ready) this.#render(); }

  // ---------------------------------------------------------------- select 要素に近い API
  get value() { return this.#options[this.selectedIndex]?.value ?? ''; }
  set value(v) { this.#ensure(); this.#value = String(v ?? ''); this.#render(); }
  get options() { this.#ensure(); return this.#options.map(o => ({ ...o })); }
  set options(list) { this.#ensure(); this.#options = [...list].map(toOption); this.#render(); }
  add(option) { this.#ensure(); this.#options.push(toOption(option)); this.#render(); }
  get selectedIndex() {
    const o = this.#options;
    if (this.#value !== null) return o.findIndex(x => x.value === this.#value);
    if (this.hasAttribute('placeholder') || !o.length) return -1;
    return Math.max(0, o.findIndex(x => !x.disabled));
  }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { this.toggleAttribute('disabled', !!v); }
  get name() { return this.getAttribute('name') ?? ''; }
  set name(v) { this.setAttribute('name', v); }
  get type() { return this.#segmented ? 'select-segmented' : 'select-one'; }
  get open() { return !!this.#list?.matches(':popover-open'); }
  get form() { return this.#internals.form; }
  checkValidity() { return true; }
  reportValidity() { return true; }
  focus(options) { this.#ensure(); (this.#focusTarget() ?? this.#trigger)?.focus(options); }
  blur() { this.#focusTarget()?.blur(); }

  get #segmented() { return this.getAttribute('variant') === 'segmented'; }
  get #off() { return this.hasAttribute('disabled') || this.#formDisabled; }
  #focusTarget() { return this.#segmented ? this.#group?.querySelector('[tabindex="0"]') : this.#trigger; }

  // ---------------------------------------------------------------- 組み立て
  #ensure() {
    if (this.#ready) return;
    this.#ready = true;
    const given = [...this.querySelectorAll('option')];
    if (given.length) {
      this.#options = given.map(o => toOption({ value: o.value, label: o.label || o.textContent, disabled: o.disabled }));
      const chosen = given.find(o => o.hasAttribute('selected'));
      if (chosen) this.#value = chosen.value;
    }
    if (this.#value === null && this.hasAttribute('value')) this.#value = this.getAttribute('value');
    this.#initial = this.#value;
    // ラベル（<label>）を押したときは欄にフォーカスを移す。一覧の中の操作は、外の <label> に渡さない
    this.addEventListener('click', e => { if (e.target === this) this.focus(); });
    this.#build();
  }
  #build() {
    this.#close(false);
    this.replaceChildren(); this.#trigger = this.#text = this.#list = this.#group = null;
    if (this.#segmented) {
      const group = this.#group = document.createElement('div');
      group.className = 'seg ss-seg'; group.setAttribute('role', 'radiogroup');
      group.addEventListener('keydown', e => this.#segKey(e));
      group.addEventListener('click', e => {
        const b = e.target.closest('button[data-value]'); if (!b || b.disabled) return;
        this.#pick(b.dataset.value);
      });
      this.append(group);
    } else {
      const trigger = this.#trigger = document.createElement('button');
      trigger.type = 'button'; trigger.className = 'ss-trigger'; trigger.id = `${this.#id}-combo`;
      trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', `${this.#id}-list`);
      const text = this.#text = document.createElement('span'); text.className = 'ss-value';
      trigger.append(text); trigger.insertAdjacentHTML('beforeend', svg('chevD'));
      trigger.addEventListener('click', () => { if (this.open) this.#close(); else this.#show(); });
      trigger.addEventListener('keydown', e => this.#key(e));
      trigger.addEventListener('blur', () => this.#close(false));
      const list = this.#list = document.createElement('div');
      list.className = 'ss-list'; list.id = `${this.#id}-list`; list.setAttribute('popover', 'manual');
      list.setAttribute('role', 'listbox'); list.tabIndex = -1;
      // 押してもフォーカスを欄に残す（一覧の行はフォーカスしない。今の行は aria-activedescendant で示す）
      list.addEventListener('mousedown', e => e.preventDefault());
      list.addEventListener('pointermove', e => {
        const row = e.target.closest('[role=option]'); if (!row || row.getAttribute('aria-disabled') === 'true') return;
        this.#activate(+row.dataset.index, false);
      });
      list.addEventListener('click', e => {
        e.preventDefault(); // 外の <label> に押したことを渡さない
        const row = e.target.closest('[role=option]'); if (!row || row.getAttribute('aria-disabled') === 'true') return;
        this.#close(); this.#pick(row.dataset.value);
      });
      this.append(trigger, list);
    }
    this.#takeLabel();
    this.#render();
  }
  // aria-label は実際に操作する部品（combobox・radiogroup）へ移す。無ければ包む <label> の文を使う
  #takeLabel() {
    const own = this.getAttribute('aria-label');
    if (own !== null) { this.#label = own; this.removeAttribute('aria-label'); }
    if (!this.#label) {
      const label = this.#internals.labels?.[0];
      if (label) { const copy = label.cloneNode(true); copy.querySelectorAll('studio-select').forEach(n => n.remove()); this.#label = copy.textContent.trim(); }
    }
    const target = this.#trigger ?? this.#group;
    if (!target) return;
    if (this.#label) target.setAttribute('aria-label', this.#label); else target.removeAttribute('aria-label');
    if (this.#list) { if (this.#label) this.#list.setAttribute('aria-label', this.#label); else this.#list.removeAttribute('aria-label'); }
  }
  #render() {
    if (!this.#ready) return;
    const value = this.value, index = this.selectedIndex, off = this.#off;
    this.#internals.setFormValue(off ? null : value);
    if (this.#group) {
      const buttons = this.#options.map((o, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio');
        b.dataset.value = o.value; b.textContent = o.label; b.disabled = off || o.disabled;
        b.setAttribute('aria-checked', String(i === index)); b.tabIndex = -1;
        return b;
      });
      (buttons[index] && !buttons[index].disabled ? buttons[index] : buttons.find(b => !b.disabled))?.setAttribute('tabindex', '0');
      const had = this.#group.contains(document.activeElement);
      this.#group.replaceChildren(...buttons);
      if (had) this.#focusTarget()?.focus();
      return;
    }
    const chosen = this.#options[index];
    this.#text.textContent = chosen ? chosen.label : this.getAttribute('placeholder') ?? '';
    this.#text.classList.toggle('placeholder', !chosen);
    this.#trigger.disabled = off;
    if (off) this.#close(false);
    if (this.open) this.#fill();
  }
  #fill() {
    const chosen = this.selectedIndex;
    this.#list.replaceChildren(...this.#options.map((o, i) => {
      const row = document.createElement('div'); row.setAttribute('role', 'option'); row.className = 'ss-option';
      row.id = `${this.#id}-o${i}`; row.dataset.index = String(i); row.dataset.value = o.value;
      row.setAttribute('aria-selected', String(i === chosen));
      if (o.disabled) row.setAttribute('aria-disabled', 'true');
      row.innerHTML = svg('check');
      const label = document.createElement('span'); label.className = 'ss-label'; label.textContent = o.label;
      row.append(label);
      return row;
    }));
    this.#activate(this.#active, false);
  }

  // ---------------------------------------------------------------- 一覧の開け閉め
  #show(at = null) {
    if (this.#off || this.open || !this.#options.length) return;
    this.#list.showPopover();
    this.#trigger.setAttribute('aria-expanded', 'true'); this.setAttribute('open', '');
    const start = at ?? (this.selectedIndex >= 0 ? this.selectedIndex : this.#step(-1, 1));
    this.#active = start;
    this.#fill(); this.#place(); this.#reveal();
    addEventListener('pointerdown', this.#outside, true);
    addEventListener('scroll', this.#follow, true); addEventListener('resize', this.#follow);
    addEventListener('blur', this.#lost);
  }
  #close(focus = true) {
    if (!this.#list) return;
    removeEventListener('pointerdown', this.#outside, true);
    removeEventListener('scroll', this.#follow, true); removeEventListener('resize', this.#follow);
    removeEventListener('blur', this.#lost);
    this.#typed = '';
    const was = this.#trigger.getAttribute('aria-expanded') === 'true';
    if (this.open) this.#list.hidePopover();
    this.#trigger.setAttribute('aria-expanded', 'false'); this.#trigger.removeAttribute('aria-activedescendant');
    this.removeAttribute('open');
    if (was && focus && this.isConnected) this.#trigger.focus();
  }
  #outside = e => { if (!this.contains(e.target)) this.#close(false); };
  #lost = () => this.#close(false);
  #follow = e => {
    if (e?.target === this.#list) return;
    const r = this.#trigger.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > innerHeight) { this.#close(false); return; }
    this.#place();
  };
  // 欄のすぐ下に出す。下に入らず上の方が広ければ上に出し、左右は画面の中に収める
  #place() {
    const list = this.#list, z = zoom(), r = this.#trigger.getBoundingClientRect();
    const a = { left: r.left / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z };
    const vw = innerWidth / z, vh = innerHeight / z;
    list.style.minWidth = `${Math.min(a.width, vw - SAFE * 2)}px`;
    list.style.maxWidth = `${Math.min(Math.max(a.width, MAX_WIDTH), vw - SAFE * 2)}px`;
    list.style.maxHeight = 'none';
    const natural = Math.min(list.scrollHeight + (list.offsetHeight - list.clientHeight), MAX_HEIGHT);
    const below = vh - a.bottom - GAP - SAFE, above = a.top - GAP - SAFE;
    const down = natural <= below || below >= above;
    const height = Math.min(natural, Math.max(down ? below : above, 64));
    list.style.maxHeight = `${height}px`;
    list.style.top = `${Math.max(SAFE, down ? a.bottom + GAP : a.top - GAP - height)}px`;
    list.style.left = `${Math.max(SAFE, Math.min(a.left, vw - list.offsetWidth - SAFE))}px`;
    list.dataset.side = down ? 'below' : 'above';
  }
  #reveal() {
    const row = this.#list.children[this.#active]; if (!row) return;
    const list = this.#list;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 4;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 4;
  }
  #activate(i, reveal = true) {
    this.#active = i;
    for (const row of this.#list.children) row.classList.toggle('active', +row.dataset.index === i);
    const row = this.#list.children[i];
    if (row) this.#trigger.setAttribute('aria-activedescendant', row.id); else this.#trigger.removeAttribute('aria-activedescendant');
    if (reveal) this.#reveal();
  }
  // from から dir の向きに、選べる行を n 個先まで進める（端で止まる）
  #step(from, dir, n = 1) {
    const o = this.#options; let i = from, found = from;
    for (let left = n; left > 0;) {
      i += dir; if (i < 0 || i >= o.length) break;
      if (!o[i].disabled) { found = i; left--; }
    }
    return found;
  }
  #edge(dir) { return this.#step(dir > 0 ? -1 : this.#options.length, dir); }
  #pick(value) {
    if (this.selectedIndex >= 0 && value === this.value) { this.#render(); return; }
    this.#value = value; this.#render();
    this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // 文字を打つと、その文字で始まる選択肢へ移る（続けて打つと続きで探す）
  #typeahead(key) {
    const now = Date.now();
    this.#typed = now - this.#typedAt > 600 ? key : this.#typed + key; this.#typedAt = now;
    const o = this.#options, text = this.#typed.toLocaleLowerCase();
    const repeat = [...text].every(c => c === text[0]), want = repeat ? text[0] : text;
    const base = this.open ? this.#active : this.selectedIndex, start = base < 0 ? 0 : base + (repeat ? 1 : 0);
    for (let k = 0; k < o.length; k++) {
      const i = (start + k) % o.length;
      if (!o[i].disabled && o[i].label.toLocaleLowerCase().startsWith(want)) return i;
    }
    return -1;
  }
  #key(e) {
    if (e.isComposing || e.metaKey || e.ctrlKey) return;
    const open = this.open, k = e.key;
    if (k.length !== 1) this.#typed = '';
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { handled(); this.#show(); return; }
      if (k === 'Home' || k === 'End') { handled(); this.#show(this.#edge(k === 'Home' ? 1 : -1)); return; }
      if (k.length === 1 && !e.altKey) { handled(); const i = this.#typeahead(k); this.#show(i >= 0 ? i : null); }
      return;
    }
    if (k === 'Escape') { handled(); this.#close(); return; }
    if (k === 'Tab') { const o = this.#options[this.#active]; this.#close(false); if (o && !o.disabled) this.#pick(o.value); return; }
    if (k === 'Enter' || (k === ' ' && !(this.#typed && Date.now() - this.#typedAt < 600)) || (k === 'ArrowUp' && e.altKey)) {
      handled(); const o = this.#options[this.#active]; this.#close(); if (o && !o.disabled) this.#pick(o.value); return;
    }
    const moves = { ArrowDown: [1, 1], ArrowUp: [-1, 1], PageDown: [1, 10], PageUp: [-1, 10] };
    if (moves[k]) { handled(); const [dir, n] = moves[k]; this.#activate(this.#step(this.#active, dir, n)); return; }
    if (k === 'Home' || k === 'End') { handled(); this.#activate(this.#edge(k === 'Home' ? 1 : -1)); return; }
    if (k.length === 1 && !e.altKey) { handled(); const i = this.#typeahead(k); if (i >= 0) this.#activate(i); }
  }
  // 横並び：矢印で隣を選ぶ（ラジオボタンと同じ）
  #segKey(e) {
    const k = e.key, dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[k];
    if (!dir && k !== 'Home' && k !== 'End') return;
    e.preventDefault(); e.stopPropagation();
    const enabled = this.#options.map((o, i) => i).filter(i => !this.#options[i].disabled);
    if (!enabled.length || this.#off) return;
    const at = enabled.indexOf(this.selectedIndex);
    const next = k === 'Home' ? enabled[0] : k === 'End' ? enabled.at(-1) : enabled[(at + dir + enabled.length) % enabled.length];
    this.#pick(this.#options[next].value);
    this.#focusTarget()?.focus();
  }
}
if (!customElements.get('studio-select')) customElements.define('studio-select', StudioSelect);

// コードから作るとき：studioSelect({ label, options: [{ value, label, disabled }], value, placeholder, variant, size, name })
export function studioSelect({ label, options = [], value, placeholder, variant, size, name, className } = {}) {
  const el = document.createElement('studio-select');
  if (label) el.setAttribute('aria-label', label);
  if (placeholder !== undefined) el.setAttribute('placeholder', placeholder);
  if (variant) el.setAttribute('variant', variant);
  if (size) el.setAttribute('size', size);
  if (name) el.setAttribute('name', name);
  if (className) el.className = className;
  el.options = options;
  if (value !== undefined) el.value = value;
  return el;
}
