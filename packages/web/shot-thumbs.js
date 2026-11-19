// ページの縮小画像と step めくり（ページの帯・一覧で共通）。カーソルの横の位置で step を選ぶ（ホームの一覧のページめくりと同じ）。
// shots()：ページごとの各 step の画像の URL。restStep(i)：カーソルが乗っていないときに出す step。
// 画像はサーバーが描画のたびに裏で撮る。一度も読み込めていないページはページ名で出す。
export function shotThumbs(host, shots, restStep) {
  const urlsOf = b => shots()[+b.dataset.index] || [];
  const pending = new WeakMap(), failed = new WeakMap();
  function show(b, k) {
    const urls = urlsOf(b);
    k = Math.max(0, Math.min(urls.length - 1, k));
    const url = urls[k] || urls[0];
    // 再撮影中・取得失敗時も、表示できている画像を残す。
    if (!url || b.querySelector('img.shot')?.getAttribute('src') === url) {
      pending.delete(b);
    } else if (pending.get(b)?.url !== url && failed.get(b) !== url) {
      const img = Object.assign(new Image(), { className: 'shot', alt: '', draggable: false, decoding: 'async' });
      const request = { url, img };
      pending.set(b, request);
      img.src = url;
      // DOM に入れる前にデコードする。連続変更で後着した古い画像は出さない。
      img.decode().then(() => {
        if (pending.get(b) !== request || !host.contains(b)) return;
        pending.delete(b);
        const previous = b.querySelector('img.shot');
        if (previous) previous.replaceWith(img);
        else b.prepend(img);
        b.classList.add('has-shot');
      }).catch(() => {
        if (pending.get(b) === request) { pending.delete(b); failed.set(b, url); }
      });
    }
    b.querySelectorAll('.steps i').forEach((t, j) => t.classList.toggle('on', j === k));
  }
  // ボタンと読み込み済みの画像・step の目盛りを再利用する。
  function decorate() {
    host.querySelectorAll('button[data-index]').forEach(b => {
      const n = urlsOf(b).length;
      failed.delete(b);
      const steps = b.querySelector('.steps');
      if (n <= 1) steps?.remove();
      else if (steps?.children.length !== n) {
        steps?.remove();
        b.insertAdjacentHTML('beforeend', `<span class="steps" aria-hidden="true">${'<i></i>'.repeat(n)}</span>`);
      }
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
