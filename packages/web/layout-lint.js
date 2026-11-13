// 編集中のレイアウトの検査の表示（設計書 §9.4）。測ってスライドの上に描くのはプレビューの中（inject/lint.js）で、
// ここではページの帯の印、上のバーの件数（押すと次の問題のページへ）、選んだブロックのツールバーの印を出す。色はすべて警告の黄色。
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';

export function makeLayoutLint(ctx) {
  let issues = [], off = null, sign = '';
  const badge = document.createElement('button');
  badge.type = 'button'; badge.className = 'ibtn lint-badge'; badge.hidden = true;
  ctx.root.querySelector('#barExtra').before(badge);
  // 選んだブロックとその中身の問題（キーは p<ページ>/<位置>、中身は「.」で続く）
  const forBlock = key => key ? issues.filter(x => x.slide === ctx.preview.index && x.block && (x.block === key || x.block.startsWith(key + '.'))) : [];
  const signOf = () => forBlock(ctx.blocks?.selected).map(x => x.message).join('\n');

  function mark(strip = ctx.root.querySelector('#pagestrip')) {
    strip.querySelectorAll('button').forEach(b => {
      b.querySelector('.mark')?.remove();
      if (issues.some(x => x.slide === Number(b.dataset.index))) b.append(Object.assign(document.createElement('span'), { className: 'mark warning' }));
    });
  }
  function showBadge() {
    badge.hidden = !issues.length;
    if (!issues.length) return;
    badge.innerHTML = `${svg('warn')}<span class="n">${issues.length}</span>`;
    tip(badge, S.lint.badge(issues.length));
  }
  function update(list) {
    issues = list;
    mark(); showBadge();
    // 選んでいるブロックの問題が変わったときだけツールバーを作り直す（説明を出している最中に消さない）
    const s = signOf();
    if (s !== sign) { sign = s; ctx.blocks?.redraw(); }
  }
  badge.onclick = () => {
    const pages = [...new Set(issues.map(x => x.slide))].sort((a, b) => a - b);
    const next = pages.find(i => i > ctx.preview.index) ?? pages[0];
    if (next != null) ctx.preview.go(next, 0);
  };
  const listen = () => {
    off?.();const client=ctx.preview.client;
    off=client?.on('edit.lint',data=>{if(client===ctx.preview.client&&data.sourceVersion===ctx.preview.sourceVersion)update(data.issues);})??null;
    client?.request('lint.inspect',{}).then(issues=>{if(client===ctx.preview.client)update(issues);}).catch(()=>{});
  };
  listen();

  return {
    previewLoaded: listen,
    stripRendered: strip => mark(strip),
    blockSelected() { sign = signOf(); },
    // 選んだブロックに問題があれば、ツールバーに印を出す（押す操作は無く、カーソルを合わせると内容が出る）
    blockTools(c) {
      const xs = forBlock(c.key);
      if (!xs.length) return [];
      const flag = document.createElement('span');
      flag.className = 'ibtn lint-flag'; flag.tabIndex = 0; flag.innerHTML = svg('warn');
      return [tip(flag, [...new Set(xs.map(x => x.short))].join('\n'))];
    },
    destroy() { off?.(); badge.remove(); },
  };
}
