// Source offsets supplied by structureOf are UTF-16; never normalize untouched QMD.
export const isPresentationNote = c => c?.attrs?.classes?.some(k => k === 'note' || k === 'notes');
export { noteText, replaceNote } from '../core/src/speaker-notes.js';
// 進捗に数えるスライド。章扉（level 1）・参考文献・自動生成のページ・発表しないページは数えない。
// count を省くと参考文献の手前まで、指定すると先頭から count ページ分（参考文献より後ろのページも対象）。
const referencesPage = pages => pages.find(p => p.generated === 'refs' || p.id === 'references' || /^(参考文献|文献|references|bibliography)$/i.test(p.title.trim()));
// 進捗に数えられるページ（原稿の順）
export function countablePages(pages) {
  const refs = referencesPage(pages);
  return pages.filter(p => p.level === 2 && !p.generated && !p.skipped && p !== refs);
}
export function countedSlides(slides, pages, count = null) {
  const refs = referencesPage(pages), countable = new Set(countablePages(pages));
  const counted = slides.filter(s => countable.has(pages[s.page]));
  if (count == null) return counted.filter(s => !refs || s.page < refs.index).map(s => s.index);
  const kept = new Set([...new Set(counted.map(s => s.page))].slice(0, Math.max(0, count)));
  return counted.filter(s => kept.has(s.page)).map(s => s.index);
}
// 発表の経過時間。一時停止している間は進めない
export class PresentationClock {
  constructor(now = () => performance.now()) { this.now = now; this.elapsed = 0; this.running = false; }
  tick() {
    if (!this.running) return;
    const current = this.now(); this.elapsed += Math.max(0, current - this.last); this.last = current;
  }
  start() { if (this.running) return; this.running = true; this.last = this.now(); }
  pause() { this.tick(); this.running = false; }
}

// Laser pointer shown on the projection window. Sizes are 1280x720 slide pixels.
export const POINTER_STYLES = Object.freeze(['dot', 'glow', 'highlight']);
export const POINTER_COLORS = Object.freeze({red:'#ff3b30', green:'#30d158', blue:'#0a84ff', yellow:'#ffd60a'});
export const POINTER_SIZES = Object.freeze(['small', 'medium', 'large']);
// 光（glow）は外側が透けて見た目が小さくなるぶん、点より大きく取る。マーカー（highlight）は下の文字が透ける広い丸
const POINTER_DIAMETER = Object.freeze({ dot:{small:10, medium:14, large:20}, glow:{small:14, medium:20, large:30}, highlight:{small:32, medium:48, large:68} });
export function pointerPrefs(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: v.enabled !== false,
    style: POINTER_STYLES.includes(v.style) ? v.style : 'dot',
    color: Object.hasOwn(POINTER_COLORS, v.color) ? v.color : 'red',
    size: POINTER_SIZES.includes(v.size) ? v.size : 'medium',
  };
}
export const pointerDiameter = prefs => POINTER_DIAMETER[prefs.style][prefs.size];
// ポインターの要素を、rect（ビューポート座標）に収まるスライドの上へ描く。投影画面と発表者ビューで同じ見た目にする
export function paintPointer(el, prefs, at, rect) {
  const show = prefs.enabled && at.visible && rect.width > 0 && rect.height > 0;
  el.hidden = !show;
  if (!show) return;
  const box = slideBox(rect.width, rect.height), size = pointerDiameter(prefs) * box.scale;
  el.dataset.style = prefs.style;
  el.style.setProperty('--pointer-color', POINTER_COLORS[prefs.color]);
  el.style.setProperty('--pointer-scale', String(box.scale));
  el.style.width = el.style.height = `${size}px`;
  el.style.transform = `translate(${rect.left + box.left + at.x * 1280 * box.scale - size / 2}px,${rect.top + box.top + at.y * 720 * box.scale - size / 2}px)`;
}
// Where the 1280x720 slide sits inside a box that letterboxes it (same fit as the player).
export function slideBox(width, height) {
  const scale = Math.max(0, Math.min(width / 1280, height / 720));
  return {scale, left:(width - 1280 * scale) / 2, top:(height - 720 * scale) / 2};
}
