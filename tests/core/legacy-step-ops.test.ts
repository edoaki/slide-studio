import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {parse} from '../../packages/core/src/legacy-source.js';
// Run the unchanged UI operations against the migrated parser; expectations come
// from legacy/python tests/e2e/test_step.py, not from generated snapshots.
const op=await import(pathToFileURL(resolve('packages/web/block-ops.js')).href);
const nav=await import(pathToFileURL(resolve('packages/web/block-nav.js')).href);
const st=(text:string)=>({...op.units(text,parse(text).to_json()),text});

test('legacy step wrapper combines padding, alignment and incremental options and unwraps losslessly',()=>{
 const original='## A {#a}\n\n- A\n- B\n\n本文。\n';let text=original,key='p0/0';
 const apply=(opts:object)=>{const r=op.setTextOptions(text,st(text),key,opts);text=r.text;key=op.keyAt(st(text),r.at,r.end);};
 apply({step:2,incremental:true});apply({align:'center'});
 let r=op.setPad(text,st(text),key,'8px');text=r.text;key=op.keyAt(st(text),r.at,r.end);
 assert.equal(text.split('::: {').length-1,1);for(const part of ['.incremental','data-step="2"','padding:8px','text-align:center'])assert.ok(text.includes(part));
 assert.equal(nav.trail(st(text),key).length,2);assert.equal(nav.upKey(st(text),key),null);
 r=op.setPad(text,st(text),key,null);text=r.text;key=op.keyAt(st(text),r.at,r.end);assert.ok(!text.includes('padding:'));assert.ok(text.includes('.incremental'));
 apply({step:0,incremental:false});apply({align:'left'});assert.equal(text,original);
});

test('legacy step numbering retains simultaneous figures lists and highlights',()=>{
 let text='## A {#a}\n\n{{< fig t/x >}}\n\n::: {data-step="1"}\nB\n:::\n\nC [x]{.highlight data-highlight-step="3"}\n\n::: {.incremental data-step="1"}\n- i\n- j\n  - k\n:::\n';
 const before=op.stepChoices(text,st(text),'p0/1.0');assert.deepEqual({...before,others:Object.fromEntries(before.others)},{step:1,incremental:false,count:1,max:4,others:{1:1,2:1,3:1},list:false});
 const fig=op.stepChoices(text,st(text),'p0/0');assert.equal(fig.step,0);assert.equal(fig.max,4);
 text=op.setStep(text,st(text),'p0/0',{step:1}).text;assert.ok(text.includes('{{< fig t/x step="1" >}}'));assert.ok(text.includes('data-highlight-step="3"'));
 text=op.setStep(text,st(text),'p0/1.0',{step:0}).text;assert.ok(!text.includes('data-step="1"}\nB'));assert.ok(text.includes('\nB\n'));assert.ok(text.includes('{{< fig t/x step="1" >}}'));assert.ok(text.includes('data-highlight-step="3"'));
});

test('legacy step removal compacts gaps in highlights and images',()=>{
 const text='## A {#a}\n\n::: {data-step="1"}\nA\n:::\n\nB [x]{.highlight data-highlight-step="2"}\n\n![](a.png){data-step="3"}\n';
 assert.equal(op.stepChoices(text,st(text),'p0/0.0').max,4);const result=op.setStep(text,st(text),'p0/0.0',{step:0}).text;
 assert.ok(result.includes('data-highlight-step="1"'));assert.ok(result.includes('![](a.png){data-step="2"}'));assert.ok(result.startsWith('## A {#a}\n\nA\n\nB'));
});

for(const kind of ['box','column','columns'])test(`legacy ${kind} step preserves children and compacts their sequence`,()=>{
 let attrs='#group style="padding:8px"',key='p0/0';let text=`## A {#a}\n\n:::: {${attrs}}\n::: {data-step="3"}\n子。\n:::\n\n[強調]{.highlight data-highlight-step="4"}\n::::\n\n::: {data-step="5"}\n後。\n:::\n`;
 if(kind!=='box'){text=text.replace(`:::: {${attrs}}`,':::::: {.columns}\n::::: {.column width="60%"}').replace('\n::::\n','\n:::::\n::::::\n');attrs=kind==='columns'?'.columns':'.column width="60%"';key=kind==='columns'?'p0/0':'p0/0.0';}
 assert.deepEqual(Object.fromEntries(op.stepChoices(text,st(text),key).others),{3:1,4:1,5:1});
 const added=op.setStep(text,st(text),key,{step:1}).text;assert.deepEqual(op.stepState(added,op.find(st(added),key).chunk),{step:1,incremental:false});
 for(const part of [`{${attrs} data-step="1"}`,'data-step="2"}\n子。','data-highlight-step="3"','data-step="4"}\n後。'])assert.ok(added.includes(part));
 assert.equal(op.setStep(added,st(added),key,{step:0}).text,text.replace('data-step="3"','data-step="1"').replace('data-highlight-step="4"','data-highlight-step="2"').replace('data-step="5"','data-step="3"'));
});
