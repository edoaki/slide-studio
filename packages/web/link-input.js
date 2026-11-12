// 書式バーと挿入メニューで共用するリンクの小さな入力欄。
import { S } from './strings.js';
import { svg } from './icons.js';
import { tip } from './tip.js';

export function linkInput({ text = '', url = '', label = false, existing = false, done, cancel }) {
  const node = document.createElement('div'); node.className = 'link-input';
  const field = (name, value) => {
    const i = document.createElement('input'); i.type = 'text'; i.value = value;
    i.placeholder = name; i.setAttribute('aria-label', name); node.append(i); return i;
  };
  const title = label ? field(S.link.text, text) : null;
  const href = field(S.link.url, url);
  const button = (icon, name, keys, fn) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ibtn'; b.innerHTML = svg(icon);
    b.onmousedown = e => e.preventDefault(); b.onclick = fn; node.append(tip(b, name, keys));
  };
  const submit = () => { if (href.value.trim() && (!title || title.value.trim())) done(href.value.trim(), title?.value); };
  button('check', S.link.apply, 'Enter', submit);
  if (existing) button('ban', S.link.remove, '', () => done(null));
  button('x', S.link.cancel, 'Esc', cancel);
  node.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  return { node, submit, focus: () => { (title || href).focus(); (title || href).select(); } };
}

export const linkMd = (text, url) => `[${text.replace(/[\\`*_{}\[\]<>]/g, '\\$&')}](${url.replace(/[\s()<>\\]/g, c => encodeURIComponent(c).replace(/[()]/g, x => '%' + x.charCodeAt(0).toString(16)))})`;
