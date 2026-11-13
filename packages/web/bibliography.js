// 編集画面の文献タブ。トピック画面と同じ一覧・詳細を使う。
import { api, toast } from './api.js';
import { bibView } from './bib-view.js';
import { leftTabs } from './left-tabs.js';
import { S } from './strings.js';

export function makeBibliography(ctx) {
  const side = leftTabs(ctx), sec = document.createElement('section');
  sec.className = 'editor-bib topic-bib';
  ctx.root.querySelector('#editor').append(sec);
  const view = bibView(sec, {deck: ctx.deck, go: index => ctx.preview.go(index, 0), verify: async key => {
    await api(`/api/deck/${encodeURIComponent(ctx.deck)}/bib`, {method: 'POST', body: {key}});
    await refresh();
  }, save: async (key, fields, original) => {
    await api(`/api/deck/${encodeURIComponent(ctx.deck)}/bib`, {method: 'PATCH', body: {key, fields, original}});
    await refresh();
  }});
  let entries = [], dead = false, request = 0;
  function draw() {
    if (dead) return;
    const slides = ctx.preview.client?.snapshot?.slides || [];
    const bib = entries.map(e => {
      const pages = slides.flatMap((s, index) => s.cites?.includes(e.key)
        ? [{index, title: `${index + 1} · ${s.title || s.id}`}] : []);
      return {...e, pages, decks: pages.length ? [ctx.deck] : []};
    });
    view.update({bib, recent: []});
  }
  async function refresh() {
    const id = ++request;
    try {
      const data = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/bib?view=full`);
      if (dead || id !== request) return;
      entries = data.entries; draw();
    } catch (e) { if (!dead) toast(`${S.topic.bibError}：${e.message}`); }
  }
  side.add('bib', 'bookOpen', S.topic.bibTab, on => { if (on) { draw(); refresh(); } });
  ctx.bibliography = {async open(key) {
    if (document.body.classList.contains('editor-off')) ctx.root.querySelector('#editorToggle')?.click();
    side.show('bib'); await refresh();
    if (!dead) view.select(key);
  }};
  return {
    previewLoaded: draw,
    event(ev) { if (ev.type === 'files' && ev.paths?.some(p => p.endsWith('reference.bib'))) refresh(); },
    destroy() { dead = true; sec.remove(); delete ctx.bibliography; },
  };
}
