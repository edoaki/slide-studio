export default {
  id: 'uses-dynamic-import', title: '動的 import を使う図', steps: ['一'],
  renderStep() { import('./later.mjs').catch(() => {}); return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="10" y="50" font-size="20">x</text></svg>`; },
};
