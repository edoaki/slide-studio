// スライド上のブロック操作（設計書 §10.4）。クリックした領域を選び、層はキー（WASD・QE）とパンくずでもたどる。
// 選んだブロックの上に小さなツールバー（元：ai-slide mock の .toolbar）、端に大きさ・余白のつまみを出す。
// 文字の編集中は、同じ場所に文字の書式バー（text-format.js）を出す。
// 並べ替え・追加・削除・大きさ・余白は原稿の文字列の上で計算し（block-ops.js）、描き直しを待たずに続けて操作できる。
import { api, toast } from './api.js';
import { svg } from './icons.js';
import { S } from './strings.js';
import * as op from './block-ops.js';
import * as nav from './block-nav.js';
import { structureOf } from './structure.js';
import { makeTextFormat, COLOR_CLASSES } from './text-format.js';
import { tip } from './tip.js';
import { decorationTools } from './decoration.js';
import { clearDecoration, DESIGN_VARS } from './block-design.js';
import { alignButton, stepTools } from './text-tools.js';
import { tableTools, clampSize } from './table-tools.js';
import { syncTitle } from './cover-form.js';
import { makeCoverAuthors } from './cover-authors.js';

const SYNC_DELAY = 300; // スライドで文字を打つ手が止まってから原稿へ反映するまで（ms）
const RUN = 1500; // この間隔で続けた並べ替えは ⌘Z の1回分にまとめる（ms）
const DIRS = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };
const HOLD = { KeyR: 'inner', KeyF: 'outer' };
const PAD_ICON = { inner: 'padInner', outer: 'padOuter', gap: 'padGap' };
// Stage 2 pushes this explicit keymap into the frame. Only plain navigation /
// padding keys are consumed synchronously; modified keys (source writes) stay
// in the parent and are not part of this lease.
const BRIDGE_KEYMAP = Object.freeze([
 ...['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','KeyR','KeyF','Escape','Enter','Delete','Backspace'].map(code=>({code,shift:false,alt:false,ctrl:false,meta:false,preventDefault:true})),
 ...['KeyW','KeyA','KeyS','KeyD'].flatMap(code=>[{code,shift:true,alt:false,ctrl:false,meta:false,preventDefault:true},{code,shift:false,alt:true,ctrl:false,meta:false,preventDefault:true}]),
 ...[true,false].flatMap(shift=>[{code:'KeyZ',shift,alt:false,ctrl:false,meta:true,preventDefault:true},{code:'KeyZ',shift,alt:false,ctrl:true,meta:false,preventDefault:true}]),
]);

export function makeBlocks(ctx) {
  const viewport = ctx.root.querySelector('#viewport'), stage = ctx.root.querySelector('#stage'), msg = ctx.root.querySelector('#hintMsg');
  const bar = document.createElement('div');
  bar.className = 'toolbar'; bar.id = 'blockTools'; bar.hidden = true;
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', S.blockTools);
  viewport.append(bar);
  // data：描いた表示の直接編集の可否（/chunks）。st：今の原稿の構造（描き直しを待たない）
  // follow：描き直した表示で選び直すブロック。want：原稿を書いたあと、新しい構造で選び直すブロック
  let data = null, st = null, selected = null, editing = false, busy = false, dead = false, generation = 0, follow = null, want = null;
  // session：スライドで文字を編集している間の状態。base・text は編集を始めた版、last は最後に反映した原稿
  let session = null;
  // armed：スライドでクリックして選んだ表。次のクリックでセルを直す（ほかの操作で選ばれたままの表は、まず表の選択に戻す）
  let armed = null;
  // hold：押している R・F の余白（§10.4）。peek：カーソルを合わせている余白のボタン
  let padSide = 'outer', padMode = false, padDone = null, hold = null, peek = null, writing = false, run = null, chain = Promise.resolve(), queued = 0;
  // avoid：装飾のメニューを重ねない所（選んだブロックとツールバー。親画面の座標）。changed：開け閉めしたとき
  const decorationState = { open: null, avoid: () => {
    const r = union(frameKey() ?? selected), fr = ctx.preview.frame?.getBoundingClientRect(), b = bar.getBoundingClientRect();
    if (!r || !fr) return null;
    return { left: Math.min(fr.left + r.left, b.left), top: Math.min(fr.top + r.top, b.top), right: Math.max(fr.left + r.right, b.right), bottom: Math.max(fr.top + r.bottom, b.bottom) };
  }, changed: () => designing() };
  const designing = () => bridgeDesigning(!!decorationState.open && !editing && !!selected);
  const memory = new Map(); // 外側のキー → 前に選んでいた子（E）
  const synced = new WeakSet(); // ⌘の状態を合わせるリスナーを付けたスライドの window
  const current = () => data?.structure.pages[ctx.preview.pageOfSlide(ctx.preview.index)] ?? st?.pages[ctx.preview.pageOfSlide(ctx.preview.index)];
  const fresh = () => !!st && st.text === ctx.text;
  const found = () => fresh() ? op.find(st, selected) : null;

  // ------------------------------------------------------------ bridge (Stage 2)
  const bridgeEdit = () => ctx.preview.edit || null;
  let textLease = null, textSnapshot = null, textSequence = 0, textClient = null, offText = null, finishingText = Promise.resolve();
  function attachText() {
    const client = ctx.preview.client;
    if (!client || client === textClient) return;
    offText?.(); textClient = client;
    client.on('text.heading',event=>{if(event.sourceVersion===frameSourceVersion()&&live())startHeading(event.point);});
    offText = client.on('text.state', event => {
      if (!session || event.lease !== textLease || event.sourceVersion !== frameSourceVersion() || event.sequence <= textSequence) return;
      textSequence = event.sequence; textSnapshot = event.state;
      if (event.kind === 'input') input(event.html);
      else if (event.kind === 'cell') { moveCell(event.cell); }
      else if (event.kind === 'finished') finishingText = finished(event.html, {created:event.created});
      else if (event.kind === 'link') format.openLink();
      format.update(); place();
    });
  }
  async function textCommand(action, value, text) {
    const result = await ctx.preview.client.request('text.command', {lease:textLease,action,value,text});
    if (action !== 'linkState') { textSnapshot = result; format.update(); }
    if (action === 'finish') await finishingText;
    return result;
  }
  function beginText(key, html, opts = {}) {
    attachText(); textLease = crypto.randomUUID(); textSequence = 0;
    return ctx.preview.client.request('text.begin', {lease:textLease,sourceVersion:frameSourceVersion(),key,html,...opts,cells:data?.chunks[key]?.cells}).then(state => {textSnapshot=state;format.update();place();}).catch(error => {endSession();toast(error.message);});
  }
  const remoteText = {
    start: (key,html,opts) => beginText(key,html,opts),
    startHeading: point => beginText(null,'',{heading:true,point}),
    cellAt: (key,point) => ctx.preview.client.request('text.cellAt',{key,point}),
    finish: () => textCommand('finish'), focus: () => textCommand('focus'),
    command: action => textCommand(action), color: value => textCommand('color',value),
    size: value => textCommand('size',Number(value)), stepSize: value => textCommand('stepSize',value),
    clearFormat: () => textCommand('clearFormat'), linkState: () => textCommand('linkState'),
    setLink: (value,text) => textCommand('setLink',value,text),
    formatState: () => textSnapshot?.format, align: () => textSnapshot?.align,
    colors: () => textSnapshot?.colors ?? {}, create: (key,where) => beginText(key,'',{create:where}),
  };
  const legacyEdit = () => ctx.preview.client ? remoteText : null;
  const frameSourceVersion = () => ctx.preview.edit?.sourceVersion ?? ctx.preview.sourceVersion ?? null;
  const knownKey = key => key == null ? null : (fresh() && op.find(st, key) ? key : null);
  let bridgeLayout = null;
  const bridgeGeometry = key => {
    if (key == null || !bridgeLayout || bridgeLayout.sourceVersion !== frameSourceVersion()) return null;
    return bridgeLayout.blocks.find(block => block.key === key) || null;
  };
  function bridgeUnion(key) {
    const geometry = bridgeGeometry(key);
    if (!geometry || !geometry.rects.length) return null;
    return {
      left: Math.min(...geometry.rects.map(r => r.left)),
      top: Math.min(...geometry.rects.map(r => r.top)),
      right: Math.max(...geometry.rects.map(r => r.right)),
      bottom: Math.max(...geometry.rects.map(r => r.bottom)),
    };
  }
  function bridgeSelectionRect() {
    if (!bridgeLayout || bridgeLayout.sourceVersion !== frameSourceVersion()) return null;
    return bridgeLayout.selection;
  }
  function layerMap() {
    const map = {};
    if (!fresh()) return map;
    for (const p of st.pages) for (const c of walk(p.chunks)) {
      const tone = nav.toneOf(st, op.inner(c).key).replace(/^l/, '');
      // The frozen SelectionCommand allows only the three numbered source
      // layers. html/image tones keep a stable source-layer colour until a
      // later contract revision exposes their own values.
      map[c.key] = tone === '1' || tone === '2' || tone === '3' ? tone : '3';
    }
    return map;
  }
  function bridgeConfiguration() {
    const edit = bridgeEdit();
    const sourceVersion = frameSourceVersion();
    if (!edit || sourceVersion == null) return null;
    const layers = layerMap();
    return {
      sourceVersion,
      keys: Object.keys(layers),
      layers,
      keymap: BRIDGE_KEYMAP,
      enabled: !readOnly && !editing && fresh(),
    };
  }
  function configureFrame() {
    const edit = bridgeEdit();
    const params = bridgeConfiguration();
    if (!edit || !params) return;
    edit.configure(params).catch(() => { /* stale configure is rejected by the frame */ });
  }
  function bridgeSelect() {
    const edit = bridgeEdit();
    if (!edit) return;
    edit.select(knownKey(selected), knownKey(frameKey())).catch(() => {});
  }
  function bridgeHover(key) {
    const edit = bridgeEdit();
    if (!edit) return;
    edit.hover(knownKey(key)).catch(() => {});
  }
  function bridgeDesigning(active) {
    const edit = bridgeEdit();
    if (!edit) return;
    edit.designing(active).catch(() => {});
  }
  function handleBridgeLayout(layout) {
    if (!layout || layout.sourceVersion !== frameSourceVersion()) return;
    bridgeLayout = layout;
    if (!editing && selected) place();
  }
  function handleBridgeIntent(intent) {
    if (dead || !intent || intent.sourceVersion !== frameSourceVersion()) return;
    switch (intent.kind) {
      case 'select': {
        if (readOnly || editing) return;
        if (intent.key != null && !knownKey(intent.key)) return;
        select(intent.key, {
          again: !!intent.again,
          text: !!intent.text,
          point: intent.point,
        });
        return;
      }
      case 'hover':
        if (intent.key != null && !knownKey(intent.key)) return;
        ctx.qmdBlocks?.hover(intent.key);
        return;
      case 'stepMenu':
        if (!intent.trusted || !knownKey(intent.key)) return;
        openStepMenu(intent.key);
        return;
      case 'blur':
        onBlur();
        return;
      case 'key':
        handleBridgeKey(intent);
        return;
      default:
        return;
    }
  }
  function handleBridgeKey(intent) {
    if(!intent.trusted||intent.isComposing||intent.sourceVersion!==frameSourceVersion())return;
    const event={...intent,shiftKey:intent.mods.shift,altKey:intent.mods.alt,ctrlKey:intent.mods.ctrl,metaKey:intent.mods.meta,target:document.body,preventDefault(){}};
    if(intent.type==='keyup'){holdKey(event);return;}
    if(!selected||editing||readOnly)return;
    const writingKey=intent.mods.alt||intent.mods.shift||intent.mods.meta||intent.mods.ctrl||['Delete','Backspace','Enter'].includes(intent.key);
    if(writingKey&&!live())return;
    keydown(event);
  }
  ctx.preview.onEditLayout?.(handleBridgeLayout);
  ctx.preview.onEditIntent?.(handleBridgeIntent);

  // 枠・つまみの色：原稿のブロック表示の線と同じ層の色（スライドの地は白なので --s-l1〜3）
  const layerColor = key => getComputedStyle(document.documentElement).getPropertyValue(`--s-${fresh() && key ? nav.toneOf(st, key) : 'l1'}`).trim();
  function paintLayers() {
    if (!fresh()) return;
    configureFrame();
  }
  // 揃えを書いていないときの揃え：包み（無ければ段落）の外側の要素の揃え
  const alignBaseOf = c => {
    const o = c && op.outer(c);
    return (o && bridgeGeometry(o.key)?.align) || 'left';
  };
  // 余白の包みの中の段落は、包みに枠を出す
  const frameKey = () => { const c = found()?.chunk, o = c && op.outer(c); return o && o !== c ? o.key : null; };
  let readOnly = false;
  const live = () => !readOnly && data && data.version === frameSourceVersion() && data.version === ctx.version && ctx.text === ctx.saved && !ctx.dirty && !ctx.conflict && !ctx.locked && ctx.renderOk;
  let blockClient=null, offBlock=null, blockSequence=0, configuredBlockVersion=null, lastDrop=null, dropSequence=0, blockGesture=false;
  let externalStrip=null;
  function outsideDrop(event) {
    externalStrip?.classList.remove('drop');externalStrip=null;
    if(event.phase==='cancel'||!knownKey(event.key))return;
    const frame=ctx.preview.frame?.getBoundingClientRect();if(!frame)return;
    const button=document.elementFromPoint(frame.left+event.point.x,frame.top+event.point.y)?.closest('#pagestrip button[data-index]');
    if(!button)return;
    const spec={pageEnd:ctx.preview.pageOfSlide(+button.dataset.index)};
    if(!validOperation('move',event.key,spec)||!op.moves(ctx.text,st,event.key,spec))return;
    if(event.phase==='drop')write(op.move(ctx.text,st,event.key,spec));
    else {externalStrip=button;button.classList.add('drop');}
  }
  function validOperation(name,key,value) {
    if(!knownKey(key))return false;
    if(name==='setSize')return value===null||Number.isFinite(value)&&value>=0&&value<=100000;
    if(name==='setPad'||name==='setSpace')return value===null||typeof value==='string'&&/^-?[0-9.]+px(?: -?[0-9.]+px){0,3}$/.test(value);
    if(name==='setColumnWidths')return value===null||Array.isArray(value)&&value.length<=1000&&value.every(v=>Number.isFinite(v)&&v>=0&&v<=100);
    if(name==='setCoverLayout')return value&&Object.entries(value).every(([k,v])=>['left','top','width','min-height'].includes(k)&&(v===null||typeof v==='string'&&/^-?[0-9.]+px$/.test(v)));
    if(name==='setTextOptions')return value&&Object.entries(value).every(([k,v])=>k==='--table-cols'&&(v===null||typeof v==='string'&&/^[0-9. ]{1,10000}$/.test(v)));
    if(name==='move')return value&&((knownKey(value.key)&&['before','after'].includes(value.side))||knownKey(value.into)||Number.isInteger(value.pageEnd)&&value.pageEnd>=0&&value.pageEnd<st.pages.length);
    return false;
  }
  function configureBlocks(on=true) {
    const client=ctx.preview.client;if(!client||!data||!st||data.version!==frameSourceVersion())return;
    if(client!==blockClient){offBlock?.();blockClient=client;configuredBlockVersion=null;blockSequence=0;blockGesture=false;offBlock=client.on('block.intent',event=>{
      if(!live()||!fresh()||event.sourceVersion!==frameSourceVersion()||event.sequence<=blockSequence)return;
      blockSequence=event.sequence;
      if(event.kind==='gesture')blockGesture=event.active;
      if(event.kind==='outside')outsideDrop(event);
      if(event.kind==='select'&&knownKey(event.key))select(event.key);
      if(event.kind==='operation'&&validOperation(event.name,event.key,event.value))write(op[event.name](ctx.text,st,event.key,event.value));
      if(event.kind==='padded')padded(event.padKind,event.value);
      if(event.kind==='layout')place();
    });}
    const sourceVersion=frameSourceVersion(),payload={sourceVersion,key:on?knownKey(selected):null,live:!!live()&&fresh()&&!editing,color:layerColor(selected)||'#2167a8',padMode:padNow()};
    if(configuredBlockVersion!==sourceVersion){payload.text=data.structure.text??ctx.saved;payload.structure=data.structure;}
    client.request('block.configure',payload).then(()=>{configuredBlockVersion=sourceVersion;}).catch(()=>{});
  }
  const handles={clear:()=>configureBlocks(false),get dragging(){return blockGesture;},destroy:()=>offBlock?.()};
  const format = makeTextFormat(() => null, value => {
    const s = session;
    if (!s || s.created) return;
    s.align = value; s.sent = null;
    textCommand('align',value).catch(error=>toast(error.message));
  }, remoteText);
  const drag = {
    get dragging(){return blockGesture;},
    attach:()=>configureBlocks(),
    cancel(){const was=blockGesture;blockGesture=false;externalStrip?.classList.remove('drop');externalStrip=null;ctx.preview.client?.request('block.cancel',{}).catch(()=>{});return was;},
    async newAt(x,y){
      const seq=++dropSequence,fr=ctx.preview.frame?.getBoundingClientRect();if(!fr||!live())return null;
      const button=document.elementFromPoint(x,y)?.closest('#pagestrip button[data-index]');
      if(button)return {spec:{pageEnd:ctx.preview.pageOfSlide(+button.dataset.index)}};
      if(x<fr.left||x>fr.right||y<fr.top||y>fr.bottom){this.clearNew();return null;}
      const target=await ctx.preview.client.request('block.dropAt',{x:x-fr.left,y:y-fr.top});
      if(seq!==dropSequence)return null;lastDrop=target;return target;
    },
    clearNew(){dropSequence++;lastDrop=null;ctx.preview.client?.request('block.clear',{}).catch(()=>{});},
    destroy(){this.clearNew();},
  };

  const coverAuthors = makeCoverAuthors(viewport, {
    ctx, live: () => !!live() && !busy && !editing,
    select: () => select(null), write: text => write({ text }),
  });

  async function load() {
    const ticket = ++generation;
    try {
      const d = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/chunks`);
      if (dead || ticket !== generation) return;
      data = d; attach();
      const key = follow ?? selected; follow = null;
      if (editing) draw(); else select(key);
    } catch (e) { toast(e.message); }
  }
  // 今の原稿の構造を取り、書いたあとのブロックを選び直す
  async function ensure() {
    for (;;) {
      const text = ctx.text, s = await structureOf(text);
      if (dead) return null;
      if (text !== ctx.text) continue;
      const first = st !== s;
      st = s;
      if (first) paintLayers();
      if (want) { const w = want; want = null; select(w.select ?? op.keyAt(st, w.at, w.end), { keep: true }); }
      else if (first && !editing) select(selected);
      return st;
    }
  }
  const refresh = () => ensure().catch(() => { /* 次の変更で取り直す */ });
  // 原稿を書く。r：block-ops の結果（text と、選び直す select か at・end）。続けた並べ替えは履歴を1つにまとめる
  function write(r, { merge = false, finishSession = false } = {}) {
    if (readOnly && !finishSession) return false;
    if (!r || r.error || r.text === ctx.text) return false;
    if (ctx.locked) { toast(S.locked); return false; }
    const join = merge && run && Date.now() < run.until && run.text === ctx.text;
    padDone = null; armed = null;
    writing = true;
    try { ctx.setText(r.text, join ? { history: false } : {}); } finally { writing = false; }
    run = merge ? { until: Date.now() + RUN, text: r.text } : null;
    want = r.select ? { select: r.select } : r.at != null ? { at: r.at, end: r.end } : { select: selected };
    refresh();
    return true;
  }
  // 押しっぱなしでも止まらないよう、前の操作の構造ができしだい次を計算する
  function queue(fn) {
    if (queued > 3) return;
    queued++;
    chain = chain.then(async () => { const s = await ensure(); if (s) await fn(s); }).catch(e => toast(e.message)).finally(() => { queued--; });
  }
  // 新しい表示を読み込んだらすぐにクリックを受け付ける（ブロックの情報は後から届いた時点で反映する）
  function attach() {
    attachText();
    ctx.preview.client?.request('edit.themeValues',{}).then(values=>{cachedTheme=values;draw();}).catch(()=>{});
    configureFrame();
    bridgeSelect();
    designing();
    // 押したままほかの画面へ移ると、離したのが伝わらない
    const win = ctx.preview.win;
    if (win && !synced.has(win)) {
      synced.add(win);
      try { win.addEventListener('blur', onBlur); } catch { /* cross-origin events are still available */ }
    }
    // Stage 3/4 still use their legacy direct frame code. Keep the call sites
    // intact until those stages are migrated; a cross-origin document throws,
    // which must not take Stage 2 selection down.
    try { drag.attach(win); } catch { /* Stage 3 remains direct-DOM */ }
    try { coverAuthors.attach(win); } catch { /* Stage 4 remains direct-DOM */ }
    // ready：表示とブロックの情報が同じ版になった（つまみ・持って動かすが使える）
    if (data && data.version === frameSourceVersion()) stage.dataset.blocks = 'ready'; else delete stage.dataset.blocks;
  }
  // text：文字の上をクリック。again：選択済みの段落を再クリック。クリック位置から編集する
  // keep：書いたあとに同じブロックを選び直すとき（［すべてに］を残す）
  function select(key, { again = false, text = false, point = null, keep = false } = {}) {
    if (key) coverAuthors.clear();
    if (readOnly) key = null;
    if (editing) return;
    const c = key && fresh() ? op.find(st, key)?.chunk : null;
    if (c && op.isPadWrap(c)) key = c.children[0].key;
    if ((text || point?.lineEnd) && again && key && key === selected && c?.kind === 'text') {
      const info = data?.chunks[key];
      if (info?.cells ? armed === key && point : info?.direct) { start(key, point); return; }
    }
    // 別のブロックへ移ったら余白のつまみはやめる（書いたあとに選び直すときは続ける）
    // 描き直したあとに選び直す予定（follow）より、押して選んだブロックを優先する
    if (key !== selected && !keep) { decorationState.open = null; decorationState.colorOpen = null; padDone = null; padMode = false; follow = null; }
    if (key !== selected) armed = null;
    selected = key;
    if (point && key) armed = key;
    if (key && fresh()) for (let k = key, p = nav.upKey(st, k); p; k = p, p = nav.upKey(st, p)) memory.set(p, k);
    const c2 = found()?.chunk;
    ctx.editor.mark = c2 ? { start: c2.start, end: c2.end } : null;
    ctx.editor.highlight(); ctx.qmdBlocks?.mark(); bridgeSelect(); draw();
    ctx.plugins.forEach(p => p.blockSelected?.());
  }
  async function openStepMenu(key) {
    if (readOnly) return;
    if (editing) await legacyEdit()?.finish?.();
    ctx.qmdBlocks?.input?.blur();
    select(key);
    bar.querySelector('.step-tools')?.openStepMenu();
  }
  async function action(action, extra = {}, next = null) {
    if (!live() || busy) { toast(S.blockWait); return false; }
    busy = true;
    const text = ctx.text, key = selected, base = data.version;
    try {
      const r = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/chunks`, { method: 'POST', body: { action, key, base, text, ...extra } });
      if (ctx.text !== text || ctx.locked || ctx.conflict) throw new Error(S.blockWait);
      ctx.setText(r.text); follow = next; return true;
    } catch (e) { toast(e.message); return false; }
    finally { busy = false; draw(); }
  }
  function startHeading(point) {
    const p = fresh() && st.pages[ctx.preview.pageOfSlide(ctx.preview.index)];
    const legacy = legacyEdit();
    if (editing || !live() || !p || p.generated || !legacy) return;
    select(null);
    editing = true; ctx.preview.defer = true;
    session = { heading: p, text: ctx.text, last: ctx.text, html: null, sent: null, timer: 0, running: null, failed: false };
    addEventListener('pointerdown', outside, true);
    legacy.startHeading(point); draw();
  }
  function start(key = selected, point = null) {
    if (editing || !live()) return;
    select(key);
    if (data.chunks[key]?.cells) { startCell(key, point); return; }
    if (!data.chunks[key]?.direct) { ctx.qmdBlocks?.editCover(key); return; }
    if (!legacyEdit()) return;
    editing = true; ctx.preview.defer = true;
    // 表紙のタイトル・副題は、太字・斜体・リンクを出さない
    const cover = !!op.coverPart(found()?.chunk);
    session = { key, base: data.version, text: ctx.text, last: ctx.text, mark: ctx.editor.mark, html: null, sent: null, timer: 0, running: null, failed: false, cover, alignBase: alignBaseOf(found()?.chunk) };
    addEventListener('pointerdown', outside, true);
    format.plain(cover); format.cell(false);
    legacyEdit()?.start(key, data.chunks[key].html, { plain: cover, point }); draw();
  }
  // 表はセルごとに直す。対応するセルがない場合は表の編集画面を開く
  async function startCell(key, point) {
    const w = legacyEdit(), at = point && await w?.cellAt(key, point);
    if (!at) return;
    const info = data.chunks[key].cells[at.r]?.[at.c];
    if (!info?.direct) { const f = found(); ctx.plugins.some(p => p.enterBlock?.(f.chunk, ctx.text.slice(f.chunk.start, f.chunk.end))); return; }
    editing = true; ctx.preview.defer = true;
    session = { key, base: data.version, text: ctx.text, last: ctx.text, html: null, sent: null, timer: 0, running: null, failed: false, cell: at, htmlCell: null, lastCell: null, moving: false, held: null };
    addEventListener('pointerdown', outside, true);
    format.plain(false); format.cell(true);
    w.start(key, info.html, { cell: at, point }); draw();
  }
  // 編集中に別のセルへ移る。移れるなら編集用の中身を返す。前のセルの分は送り終えるまで次の入力を待たせる
  function moveCell(at) {
    const s = session, info = s?.cell && data.chunks[s.key]?.cells?.[at.r]?.[at.c];
    if (!info?.direct) return null;
    if (s.html !== s.sent) {
      s.moving = true;
      sync(s).finally(() => { s.moving = false; if (s.held != null) { const h = s.held; s.held = null; input(h); } });
    }
    s.cell = at;
    return info.html;
  }
  // スライドの外（原稿・チャットなど）を押しても編集を終える
  function outside(e) { if (!bar.contains(e.target)) legacyEdit()?.finish?.(); }
  function input(html) {
    const s = session; if (!s || s.created) return;
    if (s.moving) { s.held = html; return; }
    s.html = html; s.htmlCell = s.cell; clearTimeout(s.timer);
    s.timer = setTimeout(() => sync(s), SYNC_DELAY);
    format.update(); place();
  }
  // 編集を始めた版の原稿に対して毎回変換し直すので、途中で描画が進んでもよく、何度送っても最後の内容になる。
  // 同時に送るのは1回だけ。送っている間の入力は、終わってから送る
  async function sync(s) {
    clearTimeout(s.timer); s.timer = 0;
    while (s.running) await s.running;
    if (s.html === s.sent) return !s.failed;
    const html = s.html, align = s.align, alignBase = s.alignBase, cell = s.htmlCell;
    s.running = (async () => {
      try {
        if (ctx.text !== s.last || ctx.locked || ctx.conflict) throw new Error(S.blockWait);
        if (s.heading) {
          const p = s.heading, doc = new DOMParser().parseFromString(html, 'text/html');
          const inner = doc.querySelector('h1,h2').innerHTML;
          const { markdown } = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/chunks`, { method: 'POST', body: { action: 'markdown', html: `<p>${inner}</p>`, original: p.title } });
          if (ctx.text !== s.last || ctx.locked || ctx.conflict) throw new Error(S.blockWait);
          const line = op.headingLine(s.text.slice(p.start, p.head_end), markdown);
          const text = s.text.slice(0, p.start) + line + s.text.slice(p.head_end);
          ctx.setText(text, { history: s.last === s.text }); s.last = text;
          s.failed = false; s.sent = html;
          return;
        }
        if (cell) {
          // 同じセルを続けて直す間は ⌘Z の1回分。セルが変わったら分ける
          const r = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/chunks`, { method: 'POST', body: { action: 'cell', key: s.key, text: s.last, row: cell.r, col: cell.c, html } });
          if (ctx.text !== s.last || ctx.locked || ctx.conflict) throw new Error(S.blockWait);
          const id = `${cell.r}/${cell.c}`, mark = ctx.editor.mark, grow = r.text.length - s.last.length;
          ctx.setText(r.text, { history: s.lastCell !== id }); s.last = r.text; s.lastCell = id; follow = s.key;
          if (mark) { ctx.editor.mark = { start: mark.start, end: mark.end + grow }; ctx.editor.highlight(); }
          s.failed = false; s.sent = html;
          return;
        }
        const r = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/chunks`, { method: 'POST', body: { action: 'html', key: s.key, base: s.base, text: s.text, html } });
        if (ctx.text !== s.last || ctx.locked || ctx.conflict) throw new Error(S.blockWait);
        // 1回の編集は ⌘Z の1回分にまとめる
        let text = r.text, key = s.key;
        if (align != null) {
          const structure = await structureOf(text), result = op.setTextOptions(text, structure, key, { align, alignBase });
          if (result) { text = result.text; key = op.keyAt(await structureOf(text), result.at, result.end); }
        }
        if (ctx.text !== s.last || ctx.locked || ctx.conflict) throw new Error(S.blockWait);
        // 表紙のタイトルを直したら、表紙の見出しと front matter の title も同じ文字にする（見出しは本文より前）
        const before = text.length;
        if (s.cover) text = syncTitle(text);
        const shift = text.length - before;
        ctx.setText(text, { history: s.last === s.text }); s.last = text; follow = key;
        if (s.mark) { ctx.editor.mark = { start: s.mark.start + shift, end: s.mark.end + shift + r.text.length - s.text.length }; ctx.editor.highlight(); }
        s.failed = false;
      } catch (e) { s.failed = true; toast(e.message); }
      s.sent = html;
    })();
    await s.running; s.running = null;
    return !s.failed;
  }
  function endSession() {
    removeEventListener('pointerdown', outside, true);
    session = null; editing = false; ctx.preview.defer = false; armed = null;
  }
  async function finished(html, { created = false } = {}) {
    const s = session;
    if (created) {
      // 足したブロックは、書いた時点で原稿に入れる。何も書かなければ原稿は変えない
      endSession();
      const v = ctx.preview.deferredVersion; ctx.preview.deferredVersion = null;
      if (html) {
        try {
          const { markdown } = await api(`/api/deck/${encodeURIComponent(ctx.deck)}/chunks`, { method: 'POST', body: { action: 'markdown', html } });
          const fresh = await ensure(), md = markdown.trim();
          if (md && fresh) write(s.make(md, fresh), { finishSession: true });
        } catch (e) { toast(e.message); }
      }
      if (v) ctx.preview.load(v);
      draw();
      return;
    }
    removeEventListener('pointerdown', outside, true);
    clearTimeout(s.timer);
    if (html !== null) { s.html = html; s.htmlCell = s.cell; }
    const ok = await sync(s);
    endSession();
    const v = ctx.preview.deferredVersion ?? (ok ? null : ctx.preview.version);
    ctx.preview.deferredVersion = null;
    if (v) ctx.preview.load(v);
    draw();
  }

  // ------------------------------------------------------------ キーの操作
  function moveSelection(dir) {
    if (!fresh()) return;
    const rect = key => live() ? union(key) : null;
    const k = dir === 'up' || dir === 'down' ? nav.verticalKey(st, selected, dir === 'up' ? -1 : 1)
      : nav.horizontalKey(st, selected, dir === 'left' ? -1 : 1, rect);
    if (k) select(k);
  }
  // 描き直した表示が今の原稿に追いつくまで待つ（書いた直後に続けて操作できるように）
  async function whenLive(ms = 5000) {
    for (const t0 = Date.now(); !(live() && fresh()); await new Promise(r => setTimeout(r, 40))) if (dead || Date.now() - t0 > ms) return false;
    return true;
  }
  // ⌥WASD：その向きに空のブロックを出して、すぐ文字の編集にする
  let adding = false;
  async function addBlock(dir) {
    if (adding || editing) return;
    adding = true;
    try { if (!await whenLive()) { toast(S.blockWait); return; } } finally { adding = false; }
    const f = found(), w = legacyEdit();
    if (!f || editing || !w || op.coverPart(f.chunk)) return;
    const key = selected, c = f.chunk, o = op.outer(c);
    let where, anchor, make;
    if (dir === 'up' || dir === 'down') {
      const into = c.kind === 'column' || c.kind === 'box', side = dir === 'up' ? 'before' : 'after';
      where = into ? (dir === 'up' ? 'start' : 'end') : side; anchor = into ? key : o.key;
      make = (md, s) => op.insertBlock(ctx.text, s, key, side, md);
    } else {
      const col = o.kind === 'column' ? o : op.columnOf(o), side = dir === 'left' ? 'left' : 'right';
      where = col ? (dir === 'left' ? 'col-before' : 'col-after') : (dir === 'left' ? 'wrap-left' : 'wrap-right');
      anchor = col ? col.key : o.key;
      make = (md, s) => op.addColumn(ctx.text, s, key, side, md);
    }
    editing = true; ctx.preview.defer = true;
    session = { created: true, make };
    await w.create(anchor, where);
    addEventListener('pointerdown', outside, true);
    draw();
  }
  function removeSelected() {
    const f = found(); if (!f) return;
    const o = op.outer(f.chunk), sibs = (o.parent ? o.parent.children : f.page.chunks).filter(x => x.kind !== 'def'), i = sibs.indexOf(o);
    const r = op.remove(ctx.text, st, selected); if (!r) return;
    const next = r.select ?? (sibs[i + 1] ? (op.isPadWrap(sibs[i + 1]) ? `${o.key}.0` : o.key) : sibs[i - 1] ? op.inner(sibs[i - 1]).key : nav.upKey(st, selected));
    write({ text: r.text, select: next });
  }
  function enter() {
    const f = found(); if (!f) return;
    if (ctx.plugins.some(p => p.enterBlock?.(f.chunk, ctx.text.slice(f.chunk.start, f.chunk.end)))) return;
    const child = nav.downKey(st, selected, new Map());
    if (child && f.chunk.children.length) select(child); else start();
  }
  function keydown(e) {
    if (readOnly) return false;
    holdKey(e);
    if (drag.dragging && e.key === 'Escape') { e.preventDefault(); drag.cancel(); return true; }
    if (selected && !editing && padMode && e.key === 'Escape' && !handles.dragging) {
      e.preventDefault(); padMode = false; hold = null; peek = null; draw(); return true;
    }
    if (!selected || editing || e.target.closest?.('input,textarea,select,button,.fmt-menu,[contenteditable=true]')) return false;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? ctx.redo() : ctx.undo(); return true; }
    if (e.metaKey || e.ctrlKey) return false;
    if (HOLD[e.code] && !e.altKey) { e.preventDefault(); return true; }
    const dir = DIRS[e.code];
    if (dir) {
      e.preventDefault();
      if (e.altKey) addBlock(dir);
      else if (e.shiftKey) queue(s => { if (selected) write(op.reorder(ctx.text, s, selected, dir), { merge: true }); });
      else moveSelection(dir);
      return true;
    }
    if (e.altKey) return false;
    if (e.code === 'KeyQ') { e.preventDefault(); const k = fresh() && nav.upKey(st, selected); if (k) select(k); return true; }
    if (e.code === 'KeyE') { e.preventDefault(); const k = fresh() && nav.downKey(st, selected, memory); if (k) select(k); return true; }
    if (e.key === 'Escape') { e.preventDefault(); select(null); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // 表示中の原稿を範囲選択しているときは、ブロック全体を削除しない。
      if (e.target.ownerDocument?.getSelection()?.isCollapsed === false) return false;
      e.preventDefault(); removeSelected(); return true;
    }
    if (e.key === 'Enter') { e.preventDefault(); enter(); return true; }
    return false;
  }
  // R・F を押している間は、辺のつまみが内側（横並びは列の間）・外側の余白のつまみになる。ブロックを選んでいるときだけ。
  // 動かしている途中で離しても、離すまでは同じ余白を変える（⇧ を足すと4辺をそろえる）
  function holdKey(e) {
    const side = HOLD[e.code]; if (!side) return;
    let next = hold;
    if (e.type === 'keyup') { if (hold === side) next = null; }
    else if (selected && !editing && !readOnly && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest?.('input,textarea,select,[contenteditable=true]')) next = side;
    setPad(() => { hold = next; });
  }
  // つまみの種類が変わったときだけ描き直す（作り直したボタンに、あとからカーソルが入ったと届くことがある）
  function setPad(change) {
    const before = padNow(); change();
    if (padNow() !== before && !handles.dragging) place();
  }
  const onKey = e => holdKey(e), onBlur = () => {
    if (hold) hold = null;
    peek = null;
    ctx.qmdBlocks?.hover(null);
    place();
  };
  addEventListener('keydown', onKey, true); addEventListener('keyup', onKey, true); addEventListener('blur', onBlur);

  // ------------------------------------------------------------ 余白の「すべてに」
  function padded(kind, value) { if (S.padKinds[kind]) { padDone = { kind, value }; draw(); } }
  async function padAll() {
    const d = padDone; if (!d) return;
    padDone = null;
    const vars = { [{ image: '--img-pad', fig: '--fig-pad', columns: '--gutter' }[d.kind]]: d.value };
    try {
      if (!await ctx.flush()) return;
      const s = await ensure();
      const r = s && op.setPad(ctx.text, s, selected, null);
      if (r?.error) return;
      await ctx.applyStyle(vars, r?.text ?? ctx.text);
    } catch (e) { toast(e.message); }
    draw();
  }

  // ------------------------------------------------------------ ツールバー・パンくず
  // ボタンには文字を書かず、操作名とキーはカーソルを合わせたときに出す（tip.js）
  function button(icon, label, fn, { disabled = false, cls = '', pressed, keys = '' } = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `ibtn ${cls}`; b.innerHTML = svg(icon); b.disabled = disabled; b.onclick = fn;
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
    return tip(b, label, keys);
  }
  const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });
  function trail() {
    const p = current();
    if (p?.raw_only) { ctx.hint(S.blockPageRaw); return; }
    const items = selected && fresh() ? nav.trail(st, selected) : [];
    if (!items.length) { msg.replaceChildren(); return; }
    const list = document.createElement('nav');
    list.className = 'crumbs'; list.setAttribute('aria-label', S.crumbs);
    items.forEach((it, i) => {
      if (i) list.append(Object.assign(document.createElement('span'), { className: 'crumb-sep', textContent: '›' }));
      const b = document.createElement(it.key ? 'button' : 'span');
      b.className = 'crumb'; b.textContent = it.label;
      if (it.key) { b.type = 'button'; b.onclick = () => select(it.key); b.dataset.tip = S.crumbSelect(it.label); }
      if (it.key === selected) b.setAttribute('aria-current', 'true');
      list.append(b);
    });
    msg.replaceChildren(list);
  }
  // mock のスライドのツールバーの並び：外側を選ぶ｜（画像は揃え）｜余白｜削除。文字は選んだ文字をもう一度クリックで編集
  function draw() {
    const p = current();
    designing();
    ctx.keys?.(session?.heading ? null : selected && !editing ? S.keysSelected : editing ? S.keysEditing : null);
    trail();
    // 文字の編集中は書式バー（終えるのは ✕・外を押す・Esc・⌘Enter、戻すのは ⌘Z）。打っている間に作り直さない
    if (editing) {
      handles.clear();
      if (session?.heading) { format.close(); bar.hidden = true; return; }
      if (bar.dataset.mode !== 'format') { format.close(); bar.replaceChildren(...format.nodes); bar.dataset.mode = 'format'; bar.setAttribute('aria-label', S.fmt.bar); }
      format.update(); place(); return;
    }
    if (bar.dataset.mode === 'format') { format.close(); delete bar.dataset.mode; bar.setAttribute('aria-label', S.blockTools); }
    bar.replaceChildren(); peek = null;
    const f = found();
    if (!p || p.raw_only || !f) { bar.hidden = true; handles.clear(); return; }
    const c = f.chunk, disabled = !live() || busy, up = nav.upKey(st, selected), down = nav.downKey(st, selected, memory);
    // 表紙のタイトル・副題は文字サイズ・揃え・余白（層の移動・段階表示・装飾・削除は出さない）
    const cover = !!op.coverPart(c);
    if (cover) {
      const size = document.createElement('input');
      size.type = 'number'; size.min = '8'; size.max = '200'; size.step = '1'; size.className = 'fmt-size';
      tip(size, S.fmt.size); size.disabled = disabled;
      const part = op.coverPart(c), shown = bridgeGeometry(part.key)?.fontSize;
      if (shown) size.value = String(Math.round(shown));
      const key = selected;
      const change = () => {
        if (!size.value || !size.checkValidity()) return;
        const value = `${size.valueAsNumber}px`;
        queue(s => write(op.setCoverLayout(ctx.text, s, key, { 'font-size': value })));
      };
      size.addEventListener('change', change);
      size.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); size.blur(); } });
      bar.append(size, sep());
    }
    if (!cover) bar.append(button('parent', S.blockParent, () => select(up), { disabled: !up, keys: 'Q' }),
      button('child', S.blockChild, () => select(down), { disabled: !down, keys: 'E' }));
    // 段階表示（本文・図・画像・囲み・列・横並び）。段にカーソルを合わせると、その段のものをスライドで示す
    if (op.canStep(c) && !cover) {
      const change = options => queue(s => write(op.setStep(ctx.text, s, selected, options)));
      const choices = op.stepChoices(ctx.text, st, selected);
      choices.number = k => ctx.preview.api?.stageNumber(k);
      bar.append(sep(), stepTools(button, choices, change, disabled, k => ctx.preview.client?.request('edit.markStep',{step:k??null}).catch(()=>{})));
    }
    if (c.kind === 'text') {
      const alignBase = alignBaseOf(c);
      bar.append(alignButton(button, op.textOptions(c, alignBase).align, align => queue(s => write(op.setTextOptions(ctx.text, s, selected, { align, alignBase }))), disabled));
    }
    if (op.isTable(ctx.text, c)) {
      const options = op.tableOptions(c), shown = bridgeGeometry(selected)?.fontSize ?? 0;
      const set = values => queue(s => write(op.setTextOptions(ctx.text, s, selected, values)));
      bar.append(sep(), tableTools(button, {
        size: parseFloat(options['--table-size']) || shown, bold: !!options['--table-weight'], custom: Object.keys(options).length > 0,
        disabled: busy || ctx.locked || ctx.conflict || !ctx.renderOk,
        // 続けて押しても、書いた値から数える（描き直しを待たない）
        step: d => queue(s => {
          const now = parseFloat(op.tableOptions(op.find(s, selected)?.chunk ?? c)['--table-size']) || shown;
          write(op.setTextOptions(ctx.text, s, selected, { '--table-size': `${clampSize(now + d)}px` }));
        }),
        setSize: px => set({ '--table-size': px == null ? null : `${px}px` }),
        setBold: on => set({ '--table-weight': on ? '700' : null }),
        reset: () => set(Object.fromEntries(op.TABLE_PROPS.map(k => [k, null]))),
      }));
    }
    if (c.kind === 'image') {
      const align = ctx.text.slice(c.start, c.end).match(/fig-align=["']?(left|center|right)/)?.[1] || 'center';
      bar.append(sep(), alignButton(button, align, value => action('image', { align: value }, selected), disabled, S.imageAlign));
    }
    if (op.canDecorate(c) && !cover) {
      const decoration = { ...clearDecoration(), ...op.decorationOf(ctx.text, c) };
      const key = selected;
      bar.append(decorationTools(button, decoration, values => queue(s => write(op.setDecoration(ctx.text, s, key, values))),
      // 装飾は最新の原稿だけで書き換えられる。プレビューの読み込み待ちで
      // 入力を毎回無効にして薄く表示したり、連続した変更を止めたりしない。
        busy || ctx.locked || ctx.conflict || !ctx.renderOk, decorationState, designTheme()));
    }
    if (!['opaque', 'def'].includes(c.kind)) {
      // 内側（横並びは列の間）・外側の余白。Esc で戻る。ホバー中はつまみだけを試しに出す。
      bar.append(sep());
      for (const side of (c.kind === 'columns' ? ['gap', 'outer'] : ['inner', 'outer'])) {
        const on = padMode && padSide === side;
        const b = button(PAD_ICON[side], S.spacing[side], () => { padMode = !on; padSide = side; padDone = null; draw(); }, { disabled, pressed: on, keys: S.spacingKeys[side] });
        b.onpointerenter = () => setPad(() => { peek = side; });
        b.onpointerleave = () => setPad(() => { if (peek === side) peek = null; });
        bar.append(b);
      }
      if (padDone) bar.append(button('copy', S.padAll(S.padKinds[padDone.kind]), padAll, { disabled, cls: 'primary' }));
    }
    // ほかの機能のボタン（数式・表を直すなど）
    for (const p of ctx.plugins) { const extra = p.blockTools?.(c, ctx.text.slice(c.start, c.end), { button, disabled }); if (extra?.length) bar.append(sep(), ...extra); }
    if (!cover) bar.append(sep(), button('trash', S.blockDelete, removeSelected, { disabled: !fresh(), cls: 'danger', keys: 'Delete' }));
    place();
  }
  // デザインの色と太さはテーマの変数。動かしている間はスライドの :root にだけ当て、確定するとテーマの CSS に書く
  const themeName = () => ctx.structure?.meta.theme || 'default';
  let themeSaving = Promise.resolve();
  let drawnTheme = '', cachedTheme = {};
  function designThemeValues() { return cachedTheme; }
  function designTheme() {
    const values = designThemeValues();
    drawnTheme = JSON.stringify(values);
    return {
      name: themeName(), locked: false,
      values,
      preview: updates => { cachedTheme = {...cachedTheme,...updates}; ctx.preview.client?.request('edit.themePreview',{values:updates}).catch(()=>{}); drawnTheme = JSON.stringify(cachedTheme); },
      save: updates => { themeSaving = themeSaving.then(() => saveTheme(updates)); },
    };
  }
  // 書いたテーマを読み直してから当てていた値を外す（色が一瞬戻らないように）
  async function putTheme(name, body) {
    const t = await api(`/api/themes/${encodeURIComponent(name)}`);
    if (t.locked) throw new Error(S.decoration.locked(name));
    const r = await api(`/api/themes/${encodeURIComponent(name)}`, { method: 'PUT', body: { ...body, base: t.version } });
    await ctx.preview.setTheme(name, r.version);
    return r;
  }
  async function saveTheme(updates) {
    const name = themeName(), clear = () => ctx.preview.client?.request('edit.themePreview',{values:Object.fromEntries(Object.keys(updates).map(k=>[k,null]))}).catch(()=>{});
    try {
      const r = await putTheme(name, { vars: updates });
      const at = css => async () => { await putTheme(name, { css }); draw(); };
      ctx.recordHistory({ undo: at(r.before), redo: at(r.css) });
    } catch (e) { toast(e.message); }
    clear(); draw();
  }
  // Stage 2 union rectangles come only from the cached, validated frame
  // geometry. They are content-frame CSS pixels; callers add the iframe offset.
  function union(key) {
    return bridgeUnion(key);
  }
  function editingRect() { return editing ? textSnapshot?.rect ?? null : null; }
  // 今のつまみ：押している R・F、カーソルを合わせたボタン、押したボタンの順
  function padNow() {
    const side = hold ?? peek ?? (padMode ? padSide : null);
    return side === 'inner' && found()?.chunk.kind === 'columns' ? 'gap' : side;
  }
  function drawHandles() { configureBlocks(!editing && !!selected); }
  // 選んだブロック（編集中はその文字）の上、入らなければ下に置く。座標はスライドの iframe の中から取る
  function place() {
    if (session?.heading) { bar.hidden = true; handles.clear(); return; }
    const frame = ctx.preview.frame;
    const r = editingRect() ?? union(frameKey() ?? selected) ?? bridgeSelectionRect();
    if (!r || !frame) { bar.hidden = true; handles.clear(); return; }
    bar.hidden = !editing && (padMode || !!hold || handles.dragging);
    if (bar.hidden) { drawHandles(); return; }
    const vr = viewport.getBoundingClientRect(), fr = frame.getBoundingClientRect();
    const top = fr.top - vr.top + Math.max(r.top, 0), bottom = fr.top - vr.top + Math.min(r.bottom, fr.height);
    const left = fr.left - vr.left + Math.max(r.left, 0);
    const h = bar.offsetHeight, wd = bar.offsetWidth;
    let y = top - h - 10;
    if (y < 4) y = Math.min(bottom + 10, vr.height - h - 4);
    bar.style.top = `${Math.max(4, y)}px`;
    bar.dataset.tipSide = y + h <= top ? 'above' : 'below';
    bar.style.left = `${Math.max(4, Math.min(left - 4, vr.width - wd - 4))}px`;
    for (const box of bar.querySelectorAll('.decoration-tool')) box.positionMenu?.();
    drawHandles();
  }
  const resize = new ResizeObserver(() => { if (!bar.hidden) place(); });
  // 原稿・ブロックの操作から離れたら、両側の選択枠とツールバーを閉じる。
  const keepsSelection = e => {
    const inside = selector => e.composedPath().some(node => node.matches?.(selector));
    if (inside('#editor, #blockTools, #undo, #redo, .bh-layer, .crumbs, dialog, [role="dialog"]')) return true;
    // HTML 図への指示入力と step の確認中は、チャットの対象図を保持する。
    return !!figOf(found()?.chunk) && inside('#chat, #chatToggle, #stepPrev, #stepNext');
  };
  // 操作部を押したあとに DOM や位置が変わると、click の宛先は viewport に
  // なることがある。押し始めた領域を保存し、一連の操作では選択を外さない。
  let pressOrigin = null;
  const rememberPress = e => { pressOrigin = { id: e.pointerId, keep: keepsSelection(e) }; };
  const cancelPress = () => { pressOrigin = null; };
  const away = e => {
    const press = pressOrigin; pressOrigin = null;
    if (!selected || editing) return;
    if (e.detail > 0 && press?.keep && (e.pointerId == null || e.pointerId === press.id)) return;
    if (keepsSelection(e)) return;
    select(null);
  };
  // ボタン本来のクリック処理が終わってから表示を更新する。
  addEventListener('pointerdown', rememberPress, true);
  addEventListener('pointercancel', cancelPress, true);
  addEventListener('click', away);
  resize.observe(viewport);

  const figOf = c => c?.kind === 'fig' ? op.figRef(ctx.text.slice(c.start, c.end)) : null;
  ctx.blocks = {
    setReadOnly(value) {
      readOnly = value;
      if (!value) { configureFrame(); return; }
      drag.cancel(); format.close(); coverAuthors.clear();
      follow = null; want = null; padDone = null; padMode = false;
      const done = legacyEdit()?.finish?.();
      configureFrame();
      bridgeSelect();
      bridgeHover(null);
      bar.hidden = true; handles.clear();
      select(null);
      Promise.resolve(done).then(() => { if (readOnly) select(null); });
    },
    select: key => select(key), openStepMenu, get selected() { return selected; }, get editing() { return editing; },
    // ツールバーを作り直す（ほかの機能の印が変わったとき。文字の編集中は書式バーのまま）
    redraw: () => { if (!editing) draw(); },
    // 原稿を書いて、書いたブロックを選ぶ（挿入。r は block-ops の結果）
    write: r => write(r),
    // 素材を持って動かしている間の置き場所（親画面の座標）。線を出して返す
    dropAt: (x, y) => drag.newAt(x, y), dropClear: () => drag.clearNew(),
    // 選んでいる図の参照（チャットの対象。§8.2）と、その図を置いた最初のブロック
    get figure() { return figOf(found()?.chunk); },
    figureAt(ref) {
      for (const page of fresh() ? st.pages : []) for (const c of walk(page.chunks)) if (figOf(c) === ref) return { key: c.key, page: page.index };
      return null;
    },
  };
  load(); refresh();
  return {
    previewLoaded() { attach(); load(); },
    // CSS だけの更新でも、読み込み後の色・線の種類で開いている装飾メニューを描き直す。
    previewThemed() {
      // A theme swap can commit a new sourceVersion. Reconfigure explicitly
      // after it; configure itself never advances the frame revision.
      configureFrame();
      // 自分の保存の通知で入力欄を作り直すと、次の入力中の値・フォーカスを失う。
      if (drawnTheme !== JSON.stringify(designThemeValues())) draw();
    },
    // 別のページへ移ったら選択を外す。同じページの step の移動では選んだまま、位置だけ合わせる
    slideChanged() {
      coverAuthors.refresh();
      if (editing) { legacyEdit()?.finish?.(); return; }
      if (found()?.page.index !== ctx.preview.pageOfSlide(ctx.preview.index)) select(null); else place();
    },
    textChanged() {
      refresh();
      if (writing) return;
      follow = null; want = null; run = null;
      if (!editing) select(null); else draw();
    },
    saved() { draw(); },
    // 保存待ちを確かめる前（AI に送る前など）に、スライドで打った分を原稿へ反映する
    flush() { return session && !session.created && sync(session); },
    caret() {
      if (editing || !fresh()) return;
      const pos = ctx.editor.caretOffset();
      const p = st.pages.find(p => p.start <= pos && pos < p.end);
      const c = p && [...walk(p.chunks)].filter(c => c.start <= pos && pos <= c.end && c.kind !== 'def').at(-1);
      select(c ? op.inner(c).key : null);
    }, keydown,
    destroy() {
      offText?.(); dead = true; clearTimeout(session?.timer); removeEventListener('pointerdown', outside, true);
      removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKey, true); removeEventListener('blur', onBlur);
      removeEventListener('pointerdown', rememberPress, true); removeEventListener('pointercancel', cancelPress, true);
      resize.disconnect(); removeEventListener('click', away); bar.remove(); coverAuthors.destroy(); handles.destroy(); drag.destroy(); format.destroy(); delete stage.dataset.blocks;
    },
  };
}
function* walk(cs) { for (const c of cs) { yield c; yield* walk(c.children); } }
