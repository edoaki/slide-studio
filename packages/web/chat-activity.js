import { esc } from './api.js';
import { S } from './strings.js';

const T = S.ai;

// 下書きのチャットの返事（Markdown）の一部だけを表示に使う：見出し・箇条書き・太字・コード。ほかは文字のまま
export function mdLite(text) {
  const inline = s => (s.includes(T.decisionMarker) ? `<span class="decision-needed">${format(s)}</span>` : format(s));
  const format = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = null;
  for (const line of String(text || '').split('\n')) {
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) { (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) out.push(`<p class="h">${inline(h[1])}</p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

function stepsHtml(steps, last) {
  const shown = last ? steps.slice(-last) : steps;
  return shown.map(s => `<div class="chat-step k-${esc(s.kind)}${s.exit ? ' bad' : ''}">${s.role ? esc(S.agents.names[s.role]) + '：' : ''}${esc(s.text)}</div>`).join('');
}
// 主の担当（チャット・テーマ編集・下書き）の返事には名前を付けない。HTML 実装や確認役の返事だけ誰のものか示す
const MAIN_ROLES = new Set(['chat', 'theme', 'draft']);
const replyHtml = s => `<div class="chat-reply">${s.role && !MAIN_ROLES.has(s.role) ? `<p class="h">${esc(S.agents.names[s.role])}</p>` : ''}${mdLite(s.text)}</div>`;
// 作業中：AI の返事はそのまま出し、その間の作業（コマンド・ファイル・考え）はまとめて畳む。最後の作業の新しい3行だけ見せる
// 終わった後：途中の返事も作業も1つにまとめて畳む（最後の返事と結果だけ見せる）
export function workHtml(r, active) {
  if (!active) {
    // 最後の返事（r.summary）と同じ文は、別に出すので重ねない
    const steps = r.steps.filter(s => s.kind !== 'message' || s.text !== r.summary);
    if (!steps.length) return '';
    const body = [];
    for (const s of steps) {
      if (s.kind === 'message') body.push(replyHtml(s));
      else if (typeof body[body.length - 1] === 'object') body[body.length - 1].push(s);
      else body.push([s]);
    }
    return `<details class="chat-log-steps chat-log-all" data-key="w"><summary data-tip="${esc(T.stepsTip)}">${T.steps(steps.length)}</summary>
      <div class="chat-log-body">${body.map(x => typeof x === 'string' ? x : `<div class="chat-steps">${stepsHtml(x)}</div>`).join('')}</div></details>`;
  }
  const out = [];
  let run = [];
  const flush = last => {
    if (!run.length) return;
    out.push(`<details class="chat-log-steps" data-key="w${out.length}"><summary data-tip="${esc(T.stepsTip)}">${T.steps(run.length)}</summary><div class="chat-steps">${stepsHtml(run)}</div></details>`
      + (active && last ? `<div class="chat-steps chat-tail">${stepsHtml(run, 3)}</div>` : ''));
    run = [];
  };
  for (const s of r.steps) {
    if (s.kind !== 'message') { run.push(s); continue; }
    flush(false);
    out.push(replyHtml(s));
  }
  flush(true);
  return out.join('');
}
