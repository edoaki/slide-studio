import {label, box} from './parts.mjs';
import './side.mjs';
export default {
  id: 'two-imports', title: 'import の2形式', steps: ['一', '二'],
  renderStep(k) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300">${box(40, 40, 300 + k * 200, 120, 'var(--theme-accent, #2167a8)')}<text data-key="a" x="60" y="230" font-size="32">${label(k)}・${globalThis.slideStudioSideEffect}</text></svg>`;
  },
};
