export default {
  id: 'uses-fetch', title: 'fetch を使う図', steps: ['一'],
  renderStep() { fetch('./data.json').catch(() => {}); return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="10" y="50" font-size="20">x</text></svg>`; },
};
