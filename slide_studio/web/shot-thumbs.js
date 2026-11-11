// ページの縮小画像と step めくり（ページの帯・一覧で共通）。カーソルの横の位置で step を選ぶ（ホームの一覧のページめくりと同じ）。
// shots()：ページごとの各 step の画像の URL。restStep(i)：カーソルが乗っていないときに出す step。
// 画像はサーバーが描画のたびに裏で撮る（shots.py）。まだ無いページはページ名で出す。
export function shotThumbs(host, shots, restStep) {
  const urlsOf = b => shots()[+b.dataset.index] || [];
  function show(b, k) {
    const urls = urlsOf(b), img = b.querySelector('img.shot');
    if (!img) return;
    k = Math.max(0, Math.min(urls.length - 1, k));
    const url = urls[k] || urls[0];
    if (url && img.getAttribute('src') !== url) img.src = url;
    b.querySelectorAll('.steps i').forEach((t, j) => t.classList.toggle('on', j === k));
  }
  // ボタンに画像・step の目盛りを付ける（作り直したとき・画像が届いたとき）
  function decorate() {
    host.querySelectorAll('button[data-index]').forEach(b => {
      const urls = urlsOf(b), n = urls.length;
      let img = b.querySelector('img.shot');
      b.querySelector('.steps')?.remove();
      if (!urls.some(Boolean)) { img?.remove(); b.classList.remove('has-shot'); return; }
      if (!img) {
        img = Object.assign(document.createElement('img'), { className: 'shot', alt: '', draggable: false, decoding: 'async' });
        // 読み込めた画像だけを出す（届く前・読めないときはページ名のまま）
        img.onload = () => b.classList.add('has-shot');
        img.onerror = () => b.classList.remove('has-shot');
        b.prepend(img);
      }
      if (n > 1) b.insertAdjacentHTML('beforeend', `<span class="steps" aria-hidden="true">${'<i></i>'.repeat(n)}</span>`);
      show(b, b.dataset.step != null ? +b.dataset.step : restStep(+b.dataset.index));
    });
  }
  host.addEventListener('pointermove', e => {
    const b = e.target.closest('button[data-index]');
    if (!b) return;
    const n = urlsOf(b).length;
    if (n < 2) return;
    const r = b.getBoundingClientRect(), k = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left) / r.width * n)));
    b.dataset.step = k; show(b, k);
  });
  host.addEventListener('pointerover', e => {
    const b = e.target.closest('button[data-index]');
    if (b && !b.contains(e.relatedTarget)) urlsOf(b).forEach(u => { if (u) new Image().src = u; });
  });
  host.addEventListener('pointerout', e => {
    const b = e.target.closest('button[data-index]');
    if (!b || b.contains(e.relatedTarget)) return;
    delete b.dataset.step; show(b, restStep(+b.dataset.index));
  });
  return {
    decorate,
    // カーソルが乗っていないボタンを restStep にそろえる
    rest() { host.querySelectorAll('button[data-index]').forEach(b => { if (b.dataset.step == null) show(b, restStep(+b.dataset.index)); }); },
  };
}
