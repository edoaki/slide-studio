import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Workspace} from '../../packages/core/src/workspace.js';
import {new_figure} from '../../packages/core/src/figures.js';
import {cleanItems,prompt} from '../../packages/ai/src/context.js';

test('HTML editing guidance reaches whole-deck, page and figure-step requests while preserving target scope',async t=>{
 const root=mkdtempSync(join(tmpdir(),'studio-context-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const ws=Workspace.open(root);ws.new_deck('talk','test');await new_figure(ws,'chart',ws.shelf_dir('test'));
 writeFileSync(ws.qmd('talk'),'---\ntitle: Test\ntopic: test\ntheme: default\n---\n\n## 本文 {#intro}\n\n本文。\n');
 const rule='要素の名前・概念説明を除き、各 step に書く本文は基本的にメインメッセージ1文を1ブロックにまとめる。';
 assert.ok(readFileSync(join(root,'.agents/skills/slide-studio-slides/SKILL.md'),'utf8').includes(rule));
 for(const item of [{key:'deck',text:'HTML を整理'}, {key:'intro',text:'図を整理'}, {key:'fig:test/chart',text:'このステップを整理',step:0}]){
  const items=cleanItems(ws,'talk','slides',[item]),text=await prompt(ws,'talk','slides',items,[]);
  assert.ok(text.includes(rule));assert.ok(text.includes(item.text));assert.ok(text.includes(`（${item.key}）`));
  if(item.step===0){assert.match(text,/\[step\] 1\//);assert.match(text,/\[図のフォルダー\] topics\/test\/html\/chart/);}
 }
 for(const mode of ['memo','theme','slides'] as const){const items=cleanItems(ws,'talk',mode,[{key:mode==='slides'?'deck':mode,text:'相談'}]);assert.ok(!(await prompt(ws,'talk',mode,items,[],mode==='slides')).includes(rule));}
});

test('PowerPoint attachments supply the referenced slide design and preserve unreadable attachments', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-pptx-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const ws = Workspace.open(root);
  ws.new_deck('talk', 'test');
  const {add} = await import('../../packages/core/src/materials.js');
  const source = readFileSync(join(process.cwd(), 'tests/fixtures/powerpoint/active-theme.pptx'));
  for (const [name, bytes] of [['研究室.pptx', source], ['破損.potx', Buffer.from('PK')]] as const) {
    const {path} = add(ws, 'talk', name, bytes);
    const request = await prompt(ws, 'talk', 'theme', [{key:'theme', label:'テーマ', text:'雛形に合わせる'}],
      [{path:'materials/' + path, name, kind:'file'}]);
    assert.ok(request.includes(path));
    if (bytes !== source) { assert.match(request, /基本テーマを自動取得できません/); continue; }
    const line = request.split('\n').find(line => line.startsWith('[PowerPoint の参照元と基本テーマ] '));
    assert.ok(line);
    const design = JSON.parse(line.slice(line.indexOf('{')));
    assert.equal(design.theme, 'ppt/theme/active.xml');
    const [band, rule, logo] = design.decorations;
    assert.deepEqual(design.slideSize, {cx:'9144000', cy:'5143500'});
    assert.equal(band.fill, '19394A');
    assert.equal(rule.geometry, 'line');
    assert.equal(rule.stroke, '007D72');
    assert.equal(rule.lineWidth, '28575');
    assert.equal(logo.image, 'ppt/media/lab.png');
    assert.equal(logo.part, design.master);
    assert.equal(logo.x, '7600000');
    assert.equal(design.masterTitleAlignment, 'ctr');
    assert.equal(design.colors.accent1, '#007D72');
    assert.equal(design.background.value, 'F9F3DF');
    assert.equal(design.heading.japanese, 'Hiragino Mincho ProN');
    assert.equal(design.body.japanese, 'Hiragino Sans');
  }
});
