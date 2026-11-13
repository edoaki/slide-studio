import { S } from '../strings.js';
import { DESIGN_VARS } from '../block-design.js';
export const THEME_KEYS=Object.freeze([...new Set([...Object.keys(S.themes.vars),...DESIGN_VARS,'--mark-line','--heading-mode','--heading-rule-style','--heading-rule-width','--heading-rule-inset'])]);
export const themeKey=value=>typeof value==='string'&&THEME_KEYS.includes(value);
export const themeValues=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=THEME_KEYS.length&&Object.entries(value).every(([k,v])=>themeKey(k)&&typeof v==='string'&&v.length<=4096&&!/[;{}\u0000-\u001f]|url\s*\(/i.test(v));
