// 参考資料（左の欄の［参考資料］タブ。設計書 §10.6）。
// 発表の decks/<発表>/materials/ を、VS Code のエクスプローラーと同じ操作の木で見せる（figures/・images/ と並ぶフォルダ）。
// 形式は問わない（実験結果のフォルダ・PowerPoint の雛形・PDF など）。スライドには入れず、AI への指示に場所と一覧が付く。
// - 上の帯にはボタンを置かない。木の上の［materials/］を押すとパソコンのフォルダの画面で開き、その右に［新しいフォルダ］［ファイルを追加］［フォルダを追加］
// - ファイル・フォルダそれぞれの追加ボタンから、1回のクリックでブラウザ標準の選択画面を開く
// - 押すと選ぶ（フォルダは開閉）。選んだファイルは欄の下に中身を出す（画像・PDF・テキスト）。ダブルクリックでパソコンの既定のアプリで開く
// - 新しいフォルダ・追加は選んでいるフォルダの中（ファイルならその隣）。新しいフォルダは名前をその場で打って作る
// - Enter／F2 で名前の変更、Delete／⌫ で削除（.slide-studio/trash/ へ移す）、↑↓ で選択、←→ で閉じる・開く
// - 行を持ってフォルダ（または空いている所）へ落とすと移す。パソコンのファイル・フォルダを落とすと、その場所に追加する
import { api, uploadFetch, esc, onEvent, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import { tip } from './tip.js';
import { leftTabs } from './left-tabs.js';

const M = S.mt;
const DRAG = 'application/x-slide-studio-material';
const parentOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const baseName = p => p.slice(p.lastIndexOf('/') + 1);
const join = (dir, name) => dir ? `${dir}/${name}` : name;
// 欄の下に中身を出せる形式。ほかは「表示できない」と出し、既定のアプリで開いてもらう
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i, PDF = /\.pdf$/i;
const TEXT = /\.(txt|md|markdown|qmd|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|log|tex|bib|xml|html?|css|js|mjs|ts|py|r|jl|m|sh|c|h|cpp|rs|go)$/i;
const TEXT_MAX = 1024 * 1024, TEXT_LINES = 1000;

export function makeMaterials(ctx) {
  const deck = encodeURIComponent(ctx.deck), panel = ctx.root.querySelector('#editor'), side = leftTabs(ctx);
  let data = null, dead = false, timer = 0, busy = 0;
  const pending = new Set();
  async function tracked(run) {
    const task = run(); pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  }
  let sel = null; // 選んでいる行の path
  let edit = null; // 名前を打っている所：{ mode: 'folder' | 'rename', dir, path }
  let dialog = null;
  const open = new Set(); // 開いているフォルダ

  const view = document.createElement('div');
  view.className = 'materials'; view.setAttribute('role', 'tabpanel'); view.setAttribute('aria-label', S.tabMaterials);
  // 選んだファイルの中身（木の下。木を描き直しても作り直さない）
  const pv = document.createElement('div');
  pv.className = 'mt-pv';
  panel.querySelector('#qscroll').after(view, pv);
  const shown = () => side.shown('materials');

  // ------------------------------------------------------------ 一覧
  async function load() {
    try { data = await api(`/api/deck/${deck}/materials`); } catch (e) { toast(`${M.listError}：${e.message}`); }
    const paths = new Set((data?.entries || []).map(e => e.path));
    if (sel && !paths.has(sel)) sel = null;
    for (const p of [...open]) if (!paths.has(p)) open.delete(p);
    render();
  }
  const entry = p => data?.entries.find(e => e.path === p);
  const isDir = p => !!entry(p)?.dir;
  const size = n => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;
  const visible = e => e.path.split('/').slice(0, -1).every((_, i, a) => open.has(a.slice(0, i + 1).join('/')));
  function tool(act, icon, name) {
    const b = tip(document.createElement('button'), name); b.type = 'button'; b.className = 'ibtn mt-tool'; b.dataset.act = act; b.innerHTML = svg(icon);
    return b;
  }
  function action(act, icon, name, keys) {
    const b = tip(document.createElement('button'), name, keys); b.type = 'button'; b.className = 'ibtn mt-act'; b.dataset.act = act; b.innerHTML = svg(icon); b.tabIndex = -1;
    return b;
  }
  function nameInput(value, depth, isFolder) {
    const r = document.createElement('div'); r.className = 'mt-row editing' + (isFolder ? ' dir' : ''); r.style.setProperty('--depth', depth);
    r.innerHTML = `<span class="tw"></span>${svg(isFolder ? 'folder' : 'file')}<input class="mt-name" spellcheck="false" aria-label="${esc(M.name)}">`;
    r.querySelector('input').value = value;
    return r;
  }
  function row(e) {
    const depth = e.path.split('/').length - 1;
    if (edit?.mode === 'rename' && edit.path === e.path) return nameInput(e.name, depth, e.dir);
    const r = document.createElement('div');
    r.className = 'mt-row' + (e.dir ? ' dir' : '') + (e.path === sel ? ' sel' : '');
    r.tabIndex = e.path === sel ? 0 : -1; r.dataset.path = e.path; r.draggable = true;
    r.setAttribute('role', 'treeitem'); r.setAttribute('aria-selected', String(e.path === sel));
    r.style.setProperty('--depth', depth);
    if (e.dir) r.setAttribute('aria-expanded', String(open.has(e.path)));
    r.innerHTML = `<span class="tw">${e.dir ? svg('chevR') : ''}</span>${svg(e.dir ? 'folder' : 'file')}<span class="nm"></span><span class="sz"></span>`;
    r.querySelector('.nm').textContent = e.name;
    r.querySelector('.sz').textContent = e.dir ? '' : size(e.size);
    r.append(action('rename', 'pencil', M.rename, 'Enter F2'), action('delete', 'trash', M.remove, 'Delete ⌫'));
    if (e.dir) r.append(action('revealDir', 'folderOpen', M.revealDir));
    return r;
  }
  function render() {
    if (dead) return;
    if (!shown() || !data) return;
    const keep = view.scrollTop, focused = view.contains(document.activeElement);
    // materials/（押すとパソコンのフォルダの画面で開く）・入る先・［新しいフォルダ］［ファイルを追加］［フォルダを追加］
    const top = document.createElement('div'); top.className = 'mt-top';
    const where = tip(document.createElement('button'), M.reveal); where.type = 'button'; where.className = 'mt-where'; where.dataset.act = 'reveal';
    where.innerHTML = `${svg('folder')}<span>materials/</span>`;
    const into = document.createElement('span'); into.className = 'mt-into';
    top.append(where, into, Object.assign(document.createElement('span'), { className: 'grow' }),
      tool('folder', 'folderPlus', M.newFolder), tool('files', 'upload', M.addFiles), tool('dir', 'folderUp', M.addFolder));
    const list = document.createElement('div'); list.className = 'mt-list'; list.setAttribute('role', 'tree');
    const creating = edit && edit.mode !== 'rename';
    // 新しく作るものは、そのフォルダの最初に名前の欄を出す（VS Code と同じ）
    const fresh = () => nameInput('', edit.dir ? edit.dir.split('/').length : 0, edit.mode === 'folder');
    if (creating && !edit.dir) list.append(fresh());
    for (const e of data.entries) {
      if (!visible(e)) continue;
      list.append(row(e));
      if (creating && edit.dir === e.path) list.append(fresh());
    }
    if (data.more) list.append(Object.assign(document.createElement('div'), { className: 'mt-more', textContent: M.more(data.more) }));
    const out = [top, list];
    if (!data.entries.length && !creating) {
      const drop = tip(document.createElement('button'), M.drop); drop.type = 'button'; drop.className = 'mt-drop'; drop.innerHTML = svg('upload');
      out.push(drop);
    }
    view.replaceChildren(...out);
    view.scrollTop = keep;
    const input = view.querySelector('.mt-name');
    if (input) {
      input.focus();
      // 名前の変更では拡張子の前までを選ぶ
      const dot = edit.mode === 'rename' && !isDir(edit.path) ? input.value.lastIndexOf('.') : -1;
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    } else if (focused) (view.querySelector('.mt-row.sel') || view).focus({ preventScroll: true });
    showInto(); preview();
  }
  // 新しいフォルダ・追加が入る先を materials/ の横に出す
  function showInto() { const d = targetDir(), el = view.querySelector('.mt-into'); if (el) el.textContent = d ? `→ ${d}/` : ''; }

  // ------------------------------------------------------------ 操作
  const rawOp = (name, body) => api(`/api/deck/${deck}/materials/${name}`, { method: 'POST', body });
  function rememberCreated(paths, effects = {}) {
    for (const path of paths) {
      let trash;
      ctx.recordHistory({
        undo: async () => { ({ trash } = await rawOp('delete', { path })); await effects.undo?.(); await load(); },
        redo: async () => { await rawOp('restore', { path, trash }); await effects.redo?.(); await load(); },
      });
    }
  }
  const op = (name, body) => tracked(async () => {
    const r = await rawOp(name, body);
    if (name === 'mkdir') rememberCreated([r.path]);
    if (name === 'move' && body.path !== r.path) ctx.recordHistory({
      undo: async () => { await rawOp('move', { path: r.path, to: body.path }); await load(); },
      redo: async () => { await rawOp('move', { path: body.path, to: r.path }); await load(); },
    });
    if (name === 'delete') {
      let trash = r.trash;
      ctx.recordHistory({
        undo: async () => { await rawOp('restore', { path: r.path, trash }); await load(); },
        redo: async () => { ({ trash } = await rawOp('delete', { path: r.path })); await load(); },
      });
    }
    return r;
  });
  // 新しいものを作る場所：選んでいるフォルダの中、ファイルならその隣
  const targetDir = () => !sel ? '' : isDir(sel) ? sel : parentOf(sel);
  function startNew(mode) {
    const dir = targetDir();
    if (dir) open.add(dir);
    edit = { mode, dir };
    render();
  }
  async function commit(name) {
    const e = edit; edit = null;
    name = name.trim();
    if (!e || !name || (e.mode === 'rename' && name === baseName(e.path))) { render(); return; }
    if (/[\\/]/.test(name) || name.startsWith('.')) { toast(M.badName); render(); return; }
    try {
      const r = e.mode === 'rename'
        ? await op('move', { path: e.path, to: join(parentOf(e.path), name) })
        : await op('mkdir', { path: join(e.dir, name) });
      if (e.mode === 'rename' && open.has(e.path)) { open.delete(e.path); open.add(r.path); }
      sel = r.path;
    } catch (err) { toast(err.message); }
    await load();
    view.querySelector('.mt-row.sel')?.focus({ preventScroll: true });
  }
  async function moveTo(path, dir) {
    if (path === dir || dir.startsWith(path + '/') || parentOf(path) === dir) return;
    try {
      const r = await op('move', { path, to: join(dir, baseName(path)) });
      if (dir) open.add(dir);
      sel = r.path;
    } catch (e) { toast(e.message); }
    await load();
  }
  function confirmDelete(path) {
    return new Promise(resolve => {
      dialog?.remove();
      dialog = document.createElement('div'); dialog.className = 'dialog-back';
      dialog.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(M.removeTitle)}">
        <div class="dh"><h3>${esc(M.removeTitle)}</h3></div><div class="chat-dialog-body"><p></p><p class="mt-hint">${esc(M.removeHint)}</p></div>
        <div class="df"><button class="btn" data-a="no">${S.cancel}</button><button class="btn primary" data-a="yes">${esc(M.remove)}</button></div></div>`;
      dialog.querySelector('p').textContent = M.removeText(path, isDir(path));
      document.body.append(dialog);
      const done = v => { dialog?.remove(); dialog = null; resolve(v); };
      dialog.onclick = e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) done(a === 'yes'); else if (e.target === dialog) done(false); };
      dialog.onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape') done(false); };
      dialog.querySelector('[data-a=yes]').focus();
    });
  }
  async function remove(path) {
    if (!await confirmDelete(path)) { view.querySelector('.mt-row.sel')?.focus({ preventScroll: true }); return; }
    // 消した後は、次（無ければ前）の行を選ぶ
    const rows = [...view.querySelectorAll('.mt-row[data-path]')].map(r => r.dataset.path).filter(p => p !== path && !p.startsWith(path + '/'));
    const i = [...view.querySelectorAll('.mt-row[data-path]')].findIndex(r => r.dataset.path === path);
    try { await op('delete', { path }); toast(M.removed); sel = rows[Math.min(i, rows.length - 1)] ?? null; } catch (e) { toast(e.message); }
    await load();
    view.querySelector('.mt-row.sel')?.focus({ preventScroll: true });
  }
  const reveal = (path = '') => op('open', { path }).catch(e => toast(e.message));
  // 選択は行を作り直さずに付け替える（作り直すとダブルクリックが届かない）
  function select(path, focus = true) {
    sel = path;
    for (const r of view.querySelectorAll('.mt-row[data-path]')) {
      const on = r.dataset.path === path;
      r.classList.toggle('sel', on); r.tabIndex = on ? 0 : -1; r.setAttribute('aria-selected', String(on));
    }
    if (focus) { const r = view.querySelector('.mt-row.sel'); r?.focus({ preventScroll: true }); r?.scrollIntoView({ block: 'nearest' }); }
    showInto(); preview();
  }
  function toggle(path, on = !open.has(path)) { on ? open.add(path) : open.delete(path); render(); }

  // ------------------------------------------------------------ 追加（ファイル・フォルダ。フォルダは中身を位置ごと送る）
  const upload = (items, dir = '') => tracked(async () => {
    if (!items.length) return;
    busy++; toast(M.uploading(items.length));
    const known = new Set((data?.entries || []).map(e => e.path));
    const created = new Set();
    let added = 0, reused = 0;
    for (const { file, path } of items) {
      try {
        const r = await uploadFetch(`/api/deck/${deck}/materials?path=${encodeURIComponent(join(dir, path))}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `${r.status}`);
        if (out.reused) reused++;
        else {
          added++;
          // フォルダごとの追加では、アップロードが作った親も一緒に戻す。
          const parts = out.path.split('/');
          const path = parts.map((_, i) => parts.slice(0, i + 1).join('/')).find(p => !known.has(p));
          if (path && ![...created].some(p => path === p || path.startsWith(p + '/'))) created.add(path);
        }
      } catch (e) { toast(`${path}：${e.message}`); }
    }
    rememberCreated([...created]);
    busy--;
    // 入れた先と、持ち込んだフォルダは開いておく
    if (dir) open.add(dir);
    for (const { path } of items) { const top = path.split('/')[0]; if (top !== path) open.add(join(dir, top)); }
    await load();
    if (added) toast(M.added(added)); else if (reused) toast(M.reused);
  });
  // ファイルとフォルダは、ブラウザ標準の選択画面で別々に選ぶ。
  async function addFromPc(folder = false) {
    const dir = targetDir();
    upload(await choose(folder), dir);
  }

  // ------------------------------------------------------------ 中身を見る（木の下。画像・PDF・テキスト）
  let shownKey = '';
  function preview() {
    const e = shown() && sel && !isDir(sel) ? entry(sel) : null;
    pv.classList.toggle('on', !!e);
    if (!e) { shownKey = ''; pv.replaceChildren(); return; }
    const key = `${e.path}@${e.modified}`;
    if (key === shownKey) return;
    shownKey = key;
    const url = e.url || `/files/decks/${deck}/materials/${e.path.split('/').map(encodeURIComponent).join('/')}?v=${e.modified}`;
    const head = document.createElement('div'); head.className = 'mt-pvh';
    head.innerHTML = `${svg('file')}<span class="nm"></span>`;
    head.querySelector('.nm').textContent = e.path;
    head.append(tool('openApp', 'external', M.openApp));
    const body = document.createElement('div'); body.className = 'mt-pvb';
    if (IMAGE.test(e.name)) body.append(Object.assign(document.createElement('img'), { src: url, alt: e.name }));
    else if (PDF.test(e.name)) body.append(Object.assign(document.createElement('iframe'), { src: url, title: e.name }));
    else if (TEXT.test(e.name) && e.size <= TEXT_MAX) { body.classList.add('text'); showText(body, `/api/deck/${deck}/materials/read?path=${encodeURIComponent(e.path)}`, key); }
    else { body.classList.add('none'); body.textContent = TEXT.test(e.name) ? M.tooBig : M.noPreview; }
    pv.replaceChildren(head, body);
  }
  async function showText(body, url, key) {
    try {
      const response = await uploadFetch(url);
      if (!response.ok) throw new Error((await response.json()).error || String(response.status));
      const buf = await response.arrayBuffer();
      // UTF-8 でなければ Shift_JIS（日本語の CSV に多い）として読む
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('shift_jis').decode(buf); }
      if (shownKey !== key) return;
      const lines = text.split('\n');
      const pre = document.createElement('pre'); pre.textContent = lines.slice(0, TEXT_LINES).join('\n');
      body.replaceChildren(pre);
      if (lines.length > TEXT_LINES) body.append(Object.assign(document.createElement('div'), { className: 'mt-pvmore', textContent: M.firstLines(TEXT_LINES) }));
    } catch (err) { if (shownKey === key) { body.classList.add('none'); body.textContent = err.message; } }
  }
  function choose(dir) {
    return new Promise(resolve => {
      const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true });
      if (dir) input.webkitdirectory = true;
      const end = fs => { input.remove(); resolve(fs); };
      input.addEventListener('change', () => end([...input.files].map(file => ({ file, path: file.webkitRelativePath || file.name }))));
      input.addEventListener('cancel', () => end([]));
      document.body.append(input);
      input.click();
    });
  }
  // 落としたフォルダをたどる（readEntries は少しずつ返すので空になるまで読む）
  async function walk(entry, prefix, out) {
    if (entry.name.startsWith('.')) return;
    if (entry.isFile) {
      out.push({ file: await new Promise((ok, ng) => entry.file(ok, ng)), path: prefix + entry.name });
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((ok, ng) => reader.readEntries(ok, ng));
      if (!batch.length) break;
      for (const e of batch) await walk(e, `${prefix}${entry.name}/`, out);
    }
  }
  async function dropped(dt) {
    const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...dt.files].map(file => ({ file, path: file.name }));
    const out = [];
    for (const e of entries) await walk(e, '', out);
    return out;
  }

  // ------------------------------------------------------------ 画面の操作
  view.addEventListener('click', e => {
    if (e.target.closest('.mt-name')) return;
    const top = e.target.closest('.mt-top [data-act]');
    if (top) {
      const act = top.dataset.act;
      if (act === 'reveal') reveal(); else if (act === 'folder') startNew('folder'); else if (act === 'files' || act === 'dir') addFromPc(act === 'dir');
      return;
    }
    if (e.target.closest('.mt-drop')) { addFromPc(); return; }
    const r = e.target.closest('.mt-row[data-path]');
    if (!r) { if (e.target === view || e.target.closest('.mt-top, .mt-list') === e.target) select(null, false); return; }
    const path = r.dataset.path, act = e.target.closest('.mt-act')?.dataset.act;
    if (act === 'rename') { sel = path; edit = { mode: 'rename', path }; render(); return; }
    if (act === 'delete') { sel = path; render(); remove(path); return; }
    if (act === 'revealDir') { reveal(path); return; }
    sel = path;
    if (r.classList.contains('dir')) toggle(path); else select(path);
  });
  pv.addEventListener('click', e => { if (e.target.closest('[data-act=openApp]') && sel) reveal(sel); });
  view.addEventListener('dblclick', e => {
    const r = e.target.closest('.mt-row[data-path]');
    if (r && !r.classList.contains('dir') && !e.target.closest('.mt-act')) reveal(r.dataset.path);
  });
  view.addEventListener('keydown', e => {
    // 名前の欄：Enter で決める、Esc でやめる
    if (e.target.matches('.mt-name')) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commit(e.target.value); }
      else if (e.key === 'Escape') { e.preventDefault(); edit = null; render(); view.querySelector('.mt-row.sel')?.focus(); }
      return;
    }
    // ツリーで押したキーはスライドへ渡さない（Mac の delete＝Backspace でブロックを消さない）。⌘Z などは渡す
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
    const rows = [...view.querySelectorAll('.mt-row[data-path]')].map(r => r.dataset.path);
    const i = rows.indexOf(sel);
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { handled(); if (rows.length) select(rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]); return; }
    if (!sel) return;
    if (e.key === 'ArrowRight') { handled(); if (isDir(sel)) { if (!open.has(sel)) toggle(sel, true); else if (rows[i + 1]?.startsWith(sel + '/')) select(rows[i + 1]); } return; }
    if (e.key === 'ArrowLeft') { handled(); if (isDir(sel) && open.has(sel)) toggle(sel, false); else if (parentOf(sel)) select(parentOf(sel)); return; }
    if ((e.key === 'Enter' && !e.metaKey) || e.key === 'F2') { handled(); edit = { mode: 'rename', path: sel }; render(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { handled(); remove(sel); return; }
    if (e.key === ' ' || (e.key === 'ArrowDown' && e.metaKey)) { handled(); if (isDir(sel)) toggle(sel); else reveal(sel); return; }
    if (e.key === 'Escape') { handled(); select(null, false); view.focus(); }
  });
  // 打っている途中で外を押したら、そのとき打ってある名前で決める（VS Code と同じ）
  view.addEventListener('focusout', e => { if (e.target.matches('.mt-name') && edit) commit(e.target.value); });

  // 持って動かす（中の行）と、パソコンからの追加（外のファイル）。落とす先はフォルダの行か、それ以外なら materials/ の直下
  let dragging = null;
  const dropDir = e => {
    const r = e.target.closest('.mt-row[data-path]');
    return !r ? '' : r.classList.contains('dir') ? r.dataset.path : parentOf(r.dataset.path);
  };
  const mark = dir => {
    view.querySelectorAll('.drop-into').forEach(n => n.classList.remove('drop-into'));
    view.classList.toggle('dropping', dir === '');
    if (dir) view.querySelector(`.mt-row[data-path="${CSS.escape(dir)}"]`)?.classList.add('drop-into');
  };
  view.addEventListener('dragstart', e => {
    const r = e.target.closest('.mt-row[data-path]'); if (!r) return;
    dragging = r.dataset.path;
    e.dataTransfer.setData(DRAG, dragging); e.dataTransfer.effectAllowed = 'move';
  });
  view.addEventListener('dragend', () => { dragging = null; mark(null); view.classList.remove('dropping'); });
  view.addEventListener('dragover', e => {
    const inner = e.dataTransfer.types.includes(DRAG);
    if (!inner && !e.dataTransfer.types.includes('Files')) return;
    const dir = dropDir(e);
    if (inner && dragging && (dir === dragging || dir.startsWith(dragging + '/'))) { mark(null); view.classList.remove('dropping'); return; }
    e.preventDefault(); e.dataTransfer.dropEffect = inner ? 'move' : 'copy'; mark(dir);
  });
  view.addEventListener('dragleave', e => { if (!view.contains(e.relatedTarget)) { mark(null); view.classList.remove('dropping'); } });
  view.addEventListener('drop', async e => {
    e.preventDefault();
    const dir = dropDir(e), path = e.dataTransfer.getData(DRAG);
    mark(null); view.classList.remove('dropping');
    if (path) moveTo(path, dir); else upload(await dropped(e.dataTransfer), dir);
  });

  // 参考資料のフォルダが変わったら取り直す（実験が書き続けていても、まとめて1回。名前を打っている間は待つ）
  const off = onEvent(ev => {
    if (ev.type !== 'files' || !ev.paths.some(p => p.startsWith(`decks/${ctx.deck}/materials/`))) return;
    clearTimeout(timer); timer = setTimeout(function again() { if (edit) { timer = setTimeout(again, 400); return; } if (!busy) load(); }, 400);
  });

  view.tabIndex = -1;
  side.add('materials', 'folder', S.tabMaterials, on => { if (on) { render(); load(); } });
  load();
  return { flush: () => Promise.all([...pending]), destroy() { dead = true; off(); clearTimeout(timer); dialog?.remove(); } };
}
