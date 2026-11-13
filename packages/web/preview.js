import { installExternalLinks } from './external-links.js';
import { api } from './api.js';
import {
  AgentClient,
  capabilityUrl,
  createGeneration,
  createNonce,
  registerFrameClient,
  requestPreviewCapability,
  requestThemeSampleCapability,
  themeSampleName,
  unregisterFrameClient,
} from './bridge/agent-client.js';

// スライドのプレビュー（設計書 §7.1）。サーバーが作ったプレビューの HTML を iframe で出す（GUI 側で描き直さない）。
// 描き直すときは新しい iframe を裏で読み込み、同じページ・step にしてから入れ替える（ちらつかせない）。
// フレームの中は frame-agent だけが読み書きする。ここから中の document/deck は触らない。
export class Preview {
  // url：発表のプレビューの代わりに読む HTML（テーマのタブの見本）
  constructor(box, deck, { onChange, onLoad, url, apiAdapter = api } = {}) {
    this.box = box; this.deck = deck; this.url = url; this.apiAdapter = apiAdapter;
    this.onChange = onChange || (() => {});
    this.onLoad = onLoad || (() => {});
    this.frame = null; this.pending = null; this.version = null;
    this.client = null; this.pendingClient = null;
    this.index = 0; this.step = 0;
    this.slides = [];
    this.error = null;
    this.loadSeq = 0;
    this.destroyed = false;
    this.failureReloads = 0;
    this.failureReloadAt = 0;
    this.failureTimer = 0;
    this.fitFrame = 0;
    this.editLayoutListeners = new Set();
    this.editIntentListeners = new Set();
    this.navigation = new Set();
    // 枠の大きさが変わったら、同じフレームのうちに中の縮尺も合わせる。
    // iframe の中の ResizeObserver だけだと1フレーム遅れ、広げた分が一瞬むき出しになる。
    // The bridge call is asynchronous now; coalesce to one resize per frame.
    this.fit = new ResizeObserver(() => {
      if (this.fitFrame) return;
      this.fitFrame = requestAnimationFrame(() => {
        this.fitFrame = 0;
        this.client?.api.resize().catch(() => {});
        this.pendingClient?.api.resize().catch(() => {});
      });
    });
    this.fit.observe(box);
  }
  // 移行済みでない直接編集の呼び出し元（blocks.js など）との互換用。
  // preview.js 自身はこの window から document/deck を読まない。
  get win() { return this.frame?.contentWindow; }
  // 移行済みの呼び出し元には、検証済みスナップショットのキャッシュだけを返す。
  get api() { return this.client?.api; }
  // Stage 2 edit API. All reads are parent-side caches validated by AgentClient.
  get edit() { return this.client?.api.edit ?? null; }
  get editLayout() { return this.client?.api.edit?.layout ?? null; }
  get sourceVersion() {
    return this.client?.api.edit?.sourceVersion
      ?? this.client?.snapshot?.sourceVersion
      ?? this.client?.identity?.version
      ?? this.version;
  }
  onEditLayout(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener is required');
    this.editLayoutListeners.add(listener);
    return () => this.editLayoutListeners.delete(listener);
  }
  onEditIntent(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener is required');
    this.editIntentListeners.add(listener);
    return () => this.editIntentListeners.delete(listener);
  }
  _emitEditLayout(layout) {
    for (const listener of this.editLayoutListeners) {
      try { listener(layout); } catch { /* an observer cannot break the bridge */ }
    }
  }
  _emitEditIntent(intent) {
    for (const listener of this.editIntentListeners) {
      try { listener(intent); } catch { /* an observer cannot break the bridge */ }
    }
  }

  async load(version) {
    if (this.destroyed) return;
    if (this.defer) { this.deferredVersion = version; return; }
    const token = ++this.loadSeq;
    if (this.pending) {
      this.pendingClient?.destroy();
      unregisterFrameClient(this.pending, this.pendingClient);
      this.pending.remove();
      this.pending = null; this.pendingClient = null;
    }
    const f = document.createElement('iframe');
    f.className = this.frame ? 'loading' : '';
    f.title = 'スライド';
    const generation = createGeneration();
    const nonce = createNonce();
    let capability;
    try {
      if (this.url) {
        const base = typeof this.url === 'function' ? this.url() : this.url;
        const name = themeSampleName(base);
        const sampleVersion = String(version ?? this.version ?? Date.now());
        capability = await requestThemeSampleCapability(this.apiAdapter, {
          name, version: sampleVersion, generation,
        });
        const sampleUrl = new URL(capability.url);
        if (!sampleUrl.searchParams.has('v')) sampleUrl.searchParams.set('v', capability.version);
        capability = { ...capability, url: sampleUrl.href };
      } else {
        capability = await requestPreviewCapability(this.apiAdapter, {
          deck: this.deck, version: version ?? this.version ?? '', mode: 'edit', generation,
        });
      }
    } catch (error) {
      if (token === this.loadSeq) this.error = error;
      return;
    }
    if (token !== this.loadSeq || this.destroyed) return;

    const frameVersion = String(capability.version ?? version);
    let client;
    try {
      client = new AgentClient({
        frame: f,
      deck: this.deck || '__theme-sample__',
      version: frameVersion,
      generation,
      adminOrigin: location.origin,
      contentOrigin: capability.origin,
      nonce,
      onSnapshot: (snapshot, event) => {
        if (this.client !== client) return;
        const changed = this.index !== snapshot.index || this.step !== snapshot.step
          || this._maxStep !== snapshot.maxStep;
        this.index = snapshot.index;
        this.step = snapshot.step;
        this._maxStep = snapshot.maxStep;
        this.slides = snapshot.slides;
        if (event === 'deckchange' || event === 'response') {
          this.backdrop();
          if (changed || event === 'deckchange') this._notifyChange({ index: snapshot.index, step: snapshot.step, maxStep: snapshot.maxStep });
        }
      },
        onFailure: error => this._handleFailure(client, error),
        onEditLayout: layout => this._emitEditLayout(layout),
        onEditIntent: intent => this._emitEditIntent(intent),
      });
    } catch (error) {
      if (token === this.loadSeq) this.error = error;
      return;
    }
    installExternalLinks(client);
    client.start();
    registerFrameClient(f, client);
    this.pending = f; this.pendingClient = client;
    f.src = capabilityUrl(capability.url, { index: this.index, step: this.step, nonce, mode: 'edit', generation });
    this.box.append(f);

    try {
      await client.ready;
      await client.api.resize();
      if (token !== this.loadSeq || this.pending !== f || this.destroyed) {
        client.destroy();
        unregisterFrameClient(f, client);
        f.remove();
        return;
      }
      // Drain commands sent to the visible frame before retiring it. A move
      // can be in flight even though its deckchange snapshot has not arrived.
      while (true) {
        await this.settleNavigation();
        const want = [this.index, this.step];
        await client.api.go(want[0], want[1]);
        await this.settleNavigation();
        if (token !== this.loadSeq || this.pending !== f || this.destroyed) {
          client.destroy();
          unregisterFrameClient(f, client);
          f.remove();
          return;
        }
        if (this.index === want[0] && this.step === want[1]) break;
      }
    } catch (error) {
      if (this.pending === f) this.error = error;
      if (token === this.loadSeq && this.pending === f) {
        client.destroy();
        unregisterFrameClient(f, client);
        f.remove();
        this.pending = null; this.pendingClient = null;
      }
      return;
    }

    const old = this.frame, oldClient = this.client;
    this.frame = f; this.pending = null;
    this.client = client; this.pendingClient = null;
    this.version = frameVersion;
    f.classList.remove('loading');
    if (oldClient) {
      oldClient.destroy();
      unregisterFrameClient(old, oldClient);
    }
    old?.remove();
    this.slides = client.api.slides;
    this.backdrop();
    this.index = client.api.index; this.step = client.api.step;
    this._maxStep = client.api.maxStep();
    this.failureReloads = 0;
    this.failureReloadAt = 0;
    try { this.onLoad(this.win); } catch (error) { this.error = error; }
    this._notifyChange({ index: client.api.index, step: client.api.step, maxStep: client.api.maxStep() });
  }

  setTheme(name, version, sourceVersion = version) {
    const cacheVersion = String(version ?? Date.now());
    const visibleClient = this.client;
    const committedVersion = sourceVersion == null ? undefined : String(sourceVersion);
    const visible = visibleClient
      ? visibleClient.themeSwap(name, cacheVersion, committedVersion).catch(() => null)
      : Promise.resolve(null);
    const pending = this.pendingClient
      ? this.pendingClient.themeSwap(name, cacheVersion).catch(() => null)
      : Promise.resolve(null);
    return Promise.all([visible, pending]).then(([result]) => {
      // Announce the committed source revision only after the visible frame
      // reports a successful swap. Pending frames never receive sourceVersion.
      if (this.client === visibleClient && result?.swapped && committedVersion != null) {
        this.version = committedVersion;
      }
      this.backdrop();
    });
  }

  _notifyChange(detail) {
    try { this.onChange(detail); } catch (error) { this.error = error; }
  }

  _handleFailure(client, error) {
    if (this.client !== client || this.destroyed || this.failureReloads >= 3) return;
    this.error = error;
    const wait = Math.max(0, 2000 - (Date.now() - this.failureReloadAt));
    if (this.failureTimer) clearTimeout(this.failureTimer);
    this.failureTimer = setTimeout(() => {
      this.failureTimer = 0;
      if (this.destroyed || this.client !== client || this.failureReloads >= 3) return;
      this.failureReloads += 1;
      this.failureReloadAt = Date.now();
      this.load(this.version ?? undefined);
    }, wait);
  }

  // 枠の地を今のスライドの地の色にする（縮尺が追いつく前の一瞬や端の隙間が白く光らないように）
  backdrop() {
    const background = this.client?.snapshot?.background;
    if (background) this.box.style.backgroundColor = background;
  }
  go(index, step = 0) {
    // Record the user's target before the asynchronous RPC so a pending reload
    // can carry the newest position across the swap.
    this.index = index; this.step = step;
    return this.navigate('go', index, step);
  }
  move(delta) { return this.navigate('move', delta); }
  jump(delta) { return this.navigate('jump', delta); }
  navigate(method, ...args) {
    const pending = this.api?.[method](...args);
    if (!pending) return pending;
    this.navigation.add(pending);
    const done = () => this.navigation.delete(pending);
    pending.then(done, done);
    return pending;
  }
  async settleNavigation() {
    while (this.navigation.size) await Promise.allSettled([...this.navigation]);
  }
  destroy() {
    this.destroyed = true;
    this.loadSeq += 1;
    this.onChange = () => {}; this.onLoad = () => {};
    if (this.failureTimer) clearTimeout(this.failureTimer);
    this.failureTimer = 0;
    if (this.fitFrame) cancelAnimationFrame(this.fitFrame);
    this.fitFrame = 0;
    this.fit.disconnect();
    for (const [frame, client] of [[this.pending, this.pendingClient], [this.frame, this.client]]) {
      client?.destroy();
      unregisterFrameClient(frame, client);
      frame?.remove();
    }
    this.pending = null; this.frame = null;
    this.pendingClient = null; this.client = null;
  }
  slideOfPage(page) { return this.slides.findIndex(s => s.page === page); }
  pageOfSlide(i) { return this.slides[i]?.page ?? null; }
}
