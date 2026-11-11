export default {
  id: 'uses-svg-image', title: 'SVG の中で画像を使う図', steps: ['一'],
  renderStep() { return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><image href="photo.png" x="0" y="0" width="50" height="50"/></svg>`; },
};
