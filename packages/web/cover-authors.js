// front matter から描画される名前と所属の選択・移動。
import { svg } from './icons.js';
import { S } from './strings.js';
import { setFront } from './cover-form.js';

export function makeCoverAuthors(host, { ctx, live, select, write }) {
  const bar = document.createElement('div');
  bar.className = 'toolbar cover-authors-tools'; bar.hidden = true;
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', S.coverAuthors.title);
  host.append(bar);
  let chosen=false, snapshot=null, client=null, off=null, sequence=0;
  const values = () => snapshot?.values ?? {};
  const save = patch => { if (live()) write(setFront(ctx.text, 'cover-authors-layout', ` ${JSON.stringify({ ...values(), ...patch })}`)); };
  function place() {
    if (!chosen) { bar.hidden = true; return; }
    if (!snapshot?.rect?.width) { bar.hidden = true; return; }
    const r = snapshot.rect, fr = ctx.preview.frame.getBoundingClientRect(), hr = host.getBoundingClientRect();
    bar.hidden = false;
    bar.style.left = `${Math.max(4, Math.min(fr.left - hr.left + r.left, hr.width - bar.offsetWidth - 4))}px`;
    bar.style.top = `${Math.max(4, fr.top - hr.top + r.top - bar.offsetHeight - 10)}px`;
  }
  function draw() {
    if (!snapshot) return clear();
    if (bar.contains(document.activeElement)) { place(); return; }
    client?.request('cover.select',{selected:chosen}).catch(()=>{});
    bar.replaceChildren();
    const positionLabel = document.createElement('span');
    positionLabel.className = 'aff-position-label'; positionLabel.textContent = S.coverAuthors.positionLabel;
    bar.append(positionLabel);
    for (const position of ['bottom', 'right', 'left']) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = S.coverAuthors[position]; b.setAttribute('aria-label', S.coverAuthors[position]); b.dataset.tip = `${S.coverAuthors.position}：${S.coverAuthors[position]}`;
      b.setAttribute('aria-pressed', String(values().position === position)); b.disabled = !live();
      b.onclick = () => save({ position }); bar.append(b);
    }
    for (const [key, selector] of [['size', '.cover-name,.cover-names'], ['affSize', '.cover-affiliation']]) {
      const group = document.createElement('div'); group.className = 'cover-author-format';
      const fontKey = key === 'size' ? 'font' : 'affFont', boldKey = key === 'size' ? 'bold' : 'affBold';
      const label = document.createElement('label'), input = document.createElement('input');
      label.innerHTML = svg(key === 'size' ? 'presenter' : 'affiliation'); label.dataset.tip = S.coverAuthors[key]; input.type = 'number'; input.className = 'fmt-size'; input.min = '1'; input.step = '1';
      input.setAttribute('aria-label', S.coverAuthors[key]); input.disabled = !live();
      input.value = Math.round(snapshot.formats[key].size);
      input.onchange = () => { if (input.value && input.checkValidity()) save({ [key]: input.valueAsNumber }); };
      label.append(input); group.append(label);
      const font = document.createElement('select'); font.setAttribute('aria-label', S.coverAuthors[fontKey]); font.disabled = !live();
      for (const value of ['', 'sans', 'serif', 'mono']) {
        const option = document.createElement('option'); option.value = value; option.textContent = S.coverAuthors.fonts[value]; font.append(option);
      }
      font.value = values()[fontKey] || '';
      font.onchange = () => save({ [fontKey]: font.value });
      const bold = document.createElement('button'); bold.type = 'button'; bold.className = 'btn sm'; bold.innerHTML = svg('bold');
      bold.setAttribute('aria-label', S.coverAuthors[boldKey]); bold.dataset.tip = S.coverAuthors[boldKey]; bold.disabled = !live();
      const isBold = snapshot.formats[key].bold;
      bold.setAttribute('aria-pressed', String(isBold)); bold.onclick = () => save({ [boldKey]: !isBold });
      group.append(font, bold); bar.append(group);
    }
    place();
  }
  function clear() { chosen=false; client?.request('cover.select',{selected:false}).catch(()=>{});bar.hidden=true; }
  function key(e) { if(chosen&&e.key==='Escape'){e.preventDefault();clear();} }
  const outside = e => { if (!bar.contains(e.target)) clear(); };
  host.addEventListener('pointerdown', outside);
  window.addEventListener('keydown', key, true);
  const resize = new ResizeObserver(place); resize.observe(host);
  return {
    clear,
    refresh() { if(chosen) client?.request('cover.inspect',{}).then(s=>{snapshot=s;draw();}).catch(()=>clear()); },
    attach() {
      const next=ctx.preview.client;if(!next)return;
      if(client!==next){off?.();client=next;sequence=0;off=client.on('cover.intent',event=>{
        if(!live()||event.sourceVersion!==ctx.preview.sourceVersion||event.sequence<=sequence)return;
        sequence=event.sequence;snapshot=event.state;
        if(event.kind==='select'){select();chosen=true;draw();}
        else if(event.kind==='layout')place();
        else if(event.kind==='commit')save({});
      });}
      client.request('cover.configure',{enabled:!!live()}).catch(()=>{});
      client.request('cover.inspect',{}).then(s=>{snapshot=s;if(chosen)draw();}).catch(()=>{});
    },
    destroy() { off?.();resize.disconnect();host.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',key,true);bar.remove(); },
  };
}
