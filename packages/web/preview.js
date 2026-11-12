import { installExternalLinks } from './external-links.js';
// iframe を外すと stylesheet の load/error が来ないため、差し替え待ちもここで終える。
const finishTheme = frame => frame?.contentDocument?.querySelector('#slide-studio-theme')?._resolveReplacement?.();
// スライドのプレビュー（設計書 §7.1）。サーバーが作ったプレビューの HTML を iframe で出す（GUI 側で描き直さない）。
// 描き直すときは新しい iframe を裏で読み込み、同じページ・step にしてから入れ替える（ちらつかせない）。
export class Preview {
  // url：発表のプレビューの代わりに読む HTML（テーマのタブの見本）
  constructor(box, deck, { onChange, onLoad, url } = {}) {
    this.box = box; this.deck = deck; this.url = url;
    this.onChange = onChange || (() => {});
    this.onLoad = onLoad || (() => {});
    this.frame = null; this.pending = null; this.version = null;
    this.index = 0; this.step = 0;
    this.slides = [];
    this.readyMessage = e => {
      if (e.source === this.pending?.contentWindow && e.data?.channel === 'slide-studio-deck' && e.data.type === 'ready') this.pendingReady?.();
    };
    addEventListener('message', this.readyMessage);
    // 枠の大きさが変わったら、同じフレームのうちに中の縮尺も合わせる。
    // iframe の中の ResizeObserver だけだと1フレーム遅れ、広げた分が一瞬むき出しになる。
    this.fit = new ResizeObserver(() => { for (const f of [this.frame, this.pending]) f?.contentWindow?.deck?.resize?.(); });
    this.fit.observe(box);
  }
  get win() { return this.frame?.contentWindow; }
  get api() { return this.win?.deck; }

  load(version) {
    if (this.defer) { this.deferredVersion = version; return; }
    if (this.pending) { finishTheme(this.pending); this.pending.remove(); }
    const f = document.createElement('iframe');
    f.className = this.frame ? 'loading' : '';
    f.title = 'スライド';
    const base = this.url?.() || `/files/decks/${encodeURIComponent(this.deck)}/__slide-studio_preview__.html`;
    f.src = `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(version || Date.now())}#${this.index + 1}/${this.step}`;
    this.pending = f;
    this.box.append(f);
    let starting = false;
    const connect = () => {
      const w = f.contentWindow;
      if (!w) return;
      const ready = async () => {
        if (this.pending !== f || starting) return;
        starting = true;
        // 読み込みを待つ間にユーザーが移ったページを引き継ぐ。
        await w.deck.go(this.index, this.step);
        if (this.pending !== f) return;
        const old = this.frame;
        this.frame = f; this.pending = null; this.version = version;
        f.classList.remove('loading');
        finishTheme(old); old?.remove();
        this.slides = [...w.document.querySelectorAll('#stage > .slide')].map((s, i) => ({
          index: i, page: s.dataset.page === '' || s.dataset.page == null ? null : Number(s.dataset.page),
          id: s.id, title: s.querySelector('h1,h2')?.textContent || '', chapter: s.classList.contains('section-slide'),
          group: s.dataset.group || '', sectionStart: s.dataset.sectionStart === 'true',
        }));
        this.backdrop();
        w.addEventListener('deckchange', e => { this.index = e.detail.index; this.step = e.detail.step; this.backdrop(); this.onChange(e.detail); });
        this.index = w.deck.index; this.step = w.deck.step;
        installExternalLinks(w.document);
        this.onLoad(w);
        this.onChange({ index: w.deck.index, step: w.deck.step, maxStep: w.deck.maxStep() });
      };
      if (w.deckReady) ready(); else w.addEventListener('deckready', ready, { once: true });
    };
    this.pendingReady = connect;
    f.addEventListener('load', connect);
  }
  setTheme(name, version) {
    const cacheVersion = version ?? Date.now();
    const loads = [this.frame, this.pending].map(frame => new Promise(resolve => {
      const doc = frame?.contentDocument, link = doc?.querySelector('#slide-studio-theme');
      if (!link) return resolve();
      // 新しい CSS が届くまで現在のシートを残し、読み込み完了時に入れ替える。
      const next = link.cloneNode(); next.removeAttribute('id'); next.media = 'not all';
      const previousResolve = link._resolveReplacement;
      const finish = () => { previousResolve?.(); resolve(); };
      link._replacement?.remove();
      link._replacement = next; link._resolveReplacement = finish;
      next.onload = () => {
        if (link._replacement !== next) return;
        // 読み込んだ link を移動するとシートが一瞬外れるため、その場で有効にする。
        next.onload = null; next.onerror = null;
        next.media = link.media; next.id = link.id; link.remove();
        frame.contentWindow?.slideStudioRefreshSpacing?.();
        this.backdrop(); finish();
      };
      next.onerror = () => { next.remove(); finish(); };
      next.href = `/files/themes/${encodeURIComponent(name)}.css?v=${encodeURIComponent(cacheVersion)}`;
      link.after(next);
    }));
    if (version != null) {
      this.version = version;
      if (this.win) this.win.__slideStudioVersion = version;
    }
    return Promise.all(loads);
  }

  // 枠の地を今のスライドの地の色にする（縮尺が追いつく前の一瞬や端の隙間が白く光らないように）
  backdrop() {
    const w = this.win, s = w?.document.querySelector('#stage > .slide.active');
    if (s) this.box.style.backgroundColor = w.getComputedStyle(s).backgroundColor;
  }
  go(index, step = 0) { return this.api?.go(index, step); }
  destroy() {
    removeEventListener('message', this.readyMessage);
    this.pendingReady = null;
    this.onChange = () => {}; this.onLoad = () => {};
    this.fit.disconnect();
    finishTheme(this.pending); finishTheme(this.frame);
    this.pending?.remove(); this.frame?.remove();
    this.pending = null; this.frame = null;
  }
  slideOfPage(page) { return this.slides.findIndex(s => s.page === page); }
  pageOfSlide(i) { return this.slides[i]?.page ?? null; }
}
