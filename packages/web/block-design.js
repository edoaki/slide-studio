// 原稿は種類と影の有無だけ。色・線幅・角丸・影の強さはテーマが決める。
export const DESIGN_PROPERTIES = ['--block-design', 'border-top', 'border-left', 'border-radius', 'box-shadow'];
export const DECORATION_PROPERTIES = ['border', 'background-color', ...DESIGN_PROPERTIES, '--block-shadow'];
export const KINDS = ['plain', 'top', 'left', 'quote', 'bracket', 'fold'];
export const DESIGNS = { unframed: { regions: [] }, ...Object.fromEntries(KINDS.map(kind => [kind, { regions: [
  { name: kind === 'plain' ? 'frameColor' : kind === 'top' ? 'topColor' : kind === 'left' ? 'leftColor' : 'accentColor', var: kind === 'plain' ? '--block-border' : ['quote', 'fold'].includes(kind) ? `--block-${kind}-accent` : `--block-${kind}-line`, line: !['quote', 'fold'].includes(kind), accent: true },
  { name: 'fillColor', var: kind === 'plain' ? '--block-background' : `--block-${kind}-fill` },
  { name: 'textColor', var: `--block-${kind}-ink` },
] }])) };
export const DESIGN_VARS = ['--paper', ...Object.values(DESIGNS).flatMap(d => d.regions.map(r => r.var)),
  ...['unframed', ...KINDS].flatMap(k => [`--block-${k}-radius`, `--block-${k}-shadow`])];
export const designOf = values => Object.hasOwn(DESIGNS, values['--block-design']) ? values['--block-design']
  : !values.border || /^(none|hidden|theme)$/.test(values.border) || /^0(?:px)?\s/.test(values.border) ? 'unframed' : 'plain';
export const clearDecoration = () => Object.fromEntries(DECORATION_PROPERTIES.map(k => [k, null]));
export function designValues(kind) {
  const values = clearDecoration();
  if (kind !== 'unframed') values['--block-design'] = kind;
  return values;
}
export function parseRegion(value = '') {
  const m = value.match(/#([\da-f]{6})([\da-f]{2})?\b/i);
  return { color: m ? `#${m[1]}${m[2] || 'ff'}`.toLowerCase() : '#00000000', width: Math.max(1, parseFloat(value) || 3.5), style: value.match(/solid|dashed|dotted|double/)?.[0] || 'solid' };
}
export const regionValue = (region, { color, width, style = 'solid' }) => region.line ? `${width}px ${style} ${color}` : color;
