export default {
  id: 'late-font', title: '遅れて読み込むフォント', steps: ['一'],
  renderStep() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300"><text data-key="a" x="40" y="160" font-size="64" font-family="SlideStudioTestFont">ABC</text></svg>`;
  },
};
