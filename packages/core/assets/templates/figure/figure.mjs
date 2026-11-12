// 図の本体（設計書 §5.3）。renderStep(k) は k だけで決まる SVG を返す。
// 直接 k に飛んでも、順に進めても同じ表示にする（タイマー・シードなしの乱数は使わない）。
// 色はテーマの変数を既定値つきで使う：var(--theme-accent, #2167a8)
const W = 1000, H = 460;
const ACCENT = 'var(--theme-accent, #2167a8)', INK = 'var(--theme-ink, #233244)', LIGHT = '#e8edf1';
const labels = ['入力', '処理', '結果'];

export default {
  id: '{{NAME}}',
  title: '{{TITLE}}',
  steps: ['入力を表示', '処理を表示', '結果を表示'],
  renderStep(k) {
    const boxes = labels.map((label, i) => {
      const x = 80 + i * 300, on = i <= k;
      return `<g data-key="box-${i}" opacity="${on ? 1 : 0.15}">
        <rect x="${x}" y="170" width="240" height="120" rx="14" fill="${i === k ? ACCENT : LIGHT}"/>
        <text x="${x + 120}" y="240" font-size="34" text-anchor="middle" fill="${i === k ? '#fff' : INK}">${label}</text>
      </g>`;
    }).join('');
    const arrows = [0, 1].map(i => `<line data-key="arrow-${i}" x1="${330 + i * 300}" y1="230" x2="${370 + i * 300}" y2="230" stroke="${INK}" stroke-width="4" opacity="${i < k ? 1 : 0.15}"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${arrows}${boxes}</svg>`;
  },
};
