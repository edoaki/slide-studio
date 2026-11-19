// Shared source-only page scanning for the manuscript editor and search.
const DIV_RE = /^(\s*)(:{3,})(\s*)(.*?)(\s*)$/;
const BOX_CLASS = /(?:^|[\s{])\.(row|columns|column)(?=[\s}]|$)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

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

