// Apply a source edit outside fenced code and inline code, retaining original bytes.
export function mapSourceProse(text, transform) {
  const inline = value => {
    let out = '', at = 0;
    for (const m of value.matchAll(/(`+)[\s\S]*?\1(?!`)/g)) {
      out += transform(value.slice(at, m.index)) + m[0]; at = m.index + m[0].length;
    }
    return out + transform(value.slice(at));
  };
  let out = '', at = 0, fence = null, start = 0;
  for (const m of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!m[0]) continue;
    const line = m[0].replace(/\r?\n$/, '');
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        const end = m.index + m[0].length;
        out += inline(text.slice(at, start)) + text.slice(start, end); at = end; fence = null;
      }
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) { fence = open[1]; start = m.index; }
    }
  }
  return out + (fence ? inline(text.slice(at, start)) + text.slice(start) : inline(text.slice(at)));
}
