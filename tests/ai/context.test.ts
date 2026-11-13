import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Workspace} from '../../packages/core/src/legacy-workspace.js';
import {new_figure} from '../../packages/core/src/legacy-figures.js';
import {cleanItems,prompt} from '../../packages/ai/src/context.js';

test('HTML editing guidance reaches whole-deck, page and figure-step requests while preserving target scope',async t=>{
 const root=mkdtempSync(join(tmpdir(),'studio-context-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const ws=Workspace.open(root);ws.new_deck('talk','test');await new_figure(ws,'chart',ws.shelf_dir('test'));
 writeFileSync(ws.qmd('talk'),'---\ntitle: Test\ntopic: test\ntheme: default\n---\n\n## 本文 {#intro}\n\n本文。\n');
 const rule='要素の名前・概念説明を除き、各 step に書く本文は基本的にメインメッセージ1文を1ブロックにまとめる。';
 assert.ok(readFileSync(join(root,'.agents/skills/slide-studio-slides/SKILL.md'),'utf8').includes(rule));
 for(const item of [{key:'deck',text:'HTML を整理'}, {key:'intro',text:'図を整理'}, {key:'fig:test/chart',text:'このステップを整理',step:0}]){
  const items=cleanItems(ws,'talk','slides',[item]),text=prompt(ws,'talk','slides',items,[]);
  assert.ok(text.includes(rule));assert.ok(text.includes(item.text));assert.ok(text.includes(`（${item.key}）`));
  if(item.step===0){assert.match(text,/\[step\] 1\//);assert.match(text,/\[図のフォルダー\] topics\/test\/html\/chart/);}
 }
 for(const mode of ['memo','theme','slides'] as const){const items=cleanItems(ws,'talk',mode,[{key:mode==='slides'?'deck':mode,text:'相談'}]);assert.ok(!prompt(ws,'talk',mode,items,[],mode==='slides').includes(rule));}
});
