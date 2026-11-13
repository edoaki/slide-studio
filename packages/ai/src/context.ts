import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { Workspace, figure_steps } from '../../core/src/legacy-workspace.js';
import { parse, type Doc } from '../../core/src/legacy-source.js';
import { TARGET_KEY, type Attachment } from '../../core/src/legacy-chat-store.js';
import { prompt_lines } from '../../core/src/legacy-materials.js';
import type { Mode } from '../../core/src/legacy-ai-roles.js';

export interface Item {
  key: string; text: string; label: string; page_title?: string;
  step?: {index: number; count: number | null; title: string};
}
function pageOf(doc: Doc, key: string) {
  return key.startsWith('@') ? doc.pages.find(p => p.index === Number(key.slice(1))) : doc.pages.find(p => p.id === key);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Resolve anonymous page titles before a run, so a reordered page is never edited accidentally. */
export function cleanItems(ws: Workspace, deck: string, mode: Mode, value: unknown): Item[] {
  const doc = parse(readFileSync(ws.qmd(deck), 'utf8'));
  const items: Item[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (!record(raw) || typeof raw.key !== 'string' || !TARGET_KEY.test(raw.key) || typeof raw.text !== 'string' || !raw.text.trim()) continue;
    const item: Item = {key: raw.key, text: raw.text.trim(), label: String(raw.label || raw.key).slice(0, 80)};
    if (mode === 'slides') {
      const page = pageOf(doc, item.key);
      if (item.key.startsWith('@')) {
        if (!page || page.id || typeof raw.page_title !== 'string' || page.title !== raw.page_title) {
          throw Error('ページの並びや見出しが変わっています。対象を選び直してください');
        }
        item.page_title = raw.page_title;
      }
      if (page) item.label = page.title;
      if (item.key.startsWith('fig:')) {
        const directory = ws.figure_dir(item.key.slice(4), deck);
        item.label = `図 ${item.key.split('/').at(-1)}`;
        if (raw.step !== undefined && raw.step !== null) {
          const names = figure_steps(directory);
          if (!Number.isInteger(raw.step) || Number(raw.step) < 0 || names.length && Number(raw.step) >= names.length) throw Error('図の step が見つかりません。対象を選び直してください');
          item.step = {index: Number(raw.step), count: names.length || null, title: names[Number(raw.step)] ?? ''};
        }
      }
    }
    items.push(item);
  }
  if (!items.length) throw Error('送信する指示がありません');
  if (mode !== 'slides' && (items.length !== 1 || items[0]!.key !== (mode === 'memo' ? 'memo' : 'theme'))) throw Error('依頼の対象が正しくありません');
  return items;
}

export function prompt(ws: Workspace, deck: string, mode: Mode, items: Item[], attach: Attachment[], talk = false) {
  const theme = ws.deck_theme(deck), qmd = `decks/${deck}/slides.qmd`;
  const lines = mode === 'memo' ? [
    'Slide Studio の「下書き」チャットからの依頼です（skill：slide-studio-memo）。',
    `[下書き] decks/${deck}/memo.md（変えてよいのはこのファイルだけ）`,
    `[原稿] ${qmd}（読むだけ。変えない）`,
  ] : mode === 'theme' ? [
    'Slide Studio の「テーマ」チャットからの依頼です（skill：slide-studio-theme）。',
    `[テーマ] themes/${theme}.css（変えてよいのはこのファイルだけ）`,
    `[使っている発表] ${ws.list_decks().filter(d => ws.deck_theme(d) === theme).join('、')}（同じテーマの他の発表も変わります）`,
  ] : [
    'Slide Studio のスライドのチャットからの依頼です（skill：slide-studio-slides）。',
    `[発表] ${qmd}（トピック: ${ws.deck_shelf(deck)}, テーマ: ${theme}）`,
    ...(existsSync(ws.memo(deck)) ? [`[下書き] decks/${deck}/memo.md`] : []),
    talk ? '[話し合い] ファイルを変えずに質問・相談に答える。分からないことは推測で埋めない。'
      : `[指示の数] ${items.length} 件。変えるのは各件の対象の範囲だけ。意図が不明・資料が不足する場合は推測で変えず、その件の ok を false にする。利用者への確認は questions に入れる。`,
  ];
  if (mode === 'slides' && !talk) lines.push('[HTML 編集のルール] 要素の名前・概念説明を除き、各 step に書く本文は基本的にメインメッセージ1文を1ブロックにまとめる。');
  lines.push(...prompt_lines(ws, deck));
  for (const attachment of attach) {
    const folder = attachment.kind === 'image' ? ws.asset_root(deck) : ws.deck_dir(deck);
    lines.push(`[添付] ${relative(ws.root, folder).replaceAll('\\', '/')}/${attachment.path}（${attachment.kind === 'image' ? '画像。使う場合はこのパスを参照する' : '参考資料。読むだけで変えない'}）`);
  }
  const text = readFileSync(ws.qmd(deck), 'utf8'), points = Array.from(text), doc = parse(text);
  items.forEach((item, index) => {
    lines.push('', `### ${index + 1}`, `[対象] ${item.key === 'deck' ? '発表全体' : item.label}（${item.key}）`);
    const page = mode === 'slides' ? pageOf(doc, item.key) : null;
    if (page) {
      const source = points.slice(page.start, page.end).join('');
      lines.push(`[対象の原文] ${qmd} の ${points.slice(0, page.start).join('').split('\n').length} 行目から`);
      if (Array.from(source).length <= 6000) lines.push('````markdown', source, '````');
    }
    if (item.key.startsWith('fig:')) {
      lines.push(`[図のフォルダー] ${relative(ws.root, ws.figure_dir(item.key.slice(4), deck)).replaceAll('\\', '/')}`);
      if (item.step) lines.push(`[step] ${item.step.index + 1}${item.step.count ? '/' + item.step.count : ''} ${item.step.title}`);
    }
    lines.push(`[${talk ? '発言' : '指示'}] ${item.text}`);
  });
  return lines.join('\n');
}
