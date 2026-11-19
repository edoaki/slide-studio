import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UiSettingsStore, validateSettings } from '../../apps/server/ui-settings.js';
test('settings merge concurrent saves and survive a new store', async t => {
  const dir = await mkdtemp(join(tmpdir(),'studio-settings-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path = join(dir,'nested','settings.json'), store = new UiSettingsStore(path);
  await store.load();
  await Promise.all([store.save({zoom:125}),store.save({keyHints:false}),store.save({theme:'dark'})]);
  const restored = new UiSettingsStore(path); await restored.load();
  assert.equal(restored.value.zoom,125); assert.equal(restored.value.keyHints,false); assert.equal(restored.value.theme,'dark');
  assert.equal(restored.value.tooltips,true);
});
test('settings reject unknown keys, wrong types and unusable scales', () => {
  for(const value of [null,[],{zoom:0},{zoom:151},{zoom:'100'},{zoom:NaN},{keyHints:1},{theme:'other'},{arbitrary:true},{duration:-1}]) assert.throws(()=>validateSettings(value));
});
test('retiring presentation settings preserves existing appearance preferences', async t => {
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(),'studio-settings-migration-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path = join(dir,'settings.json');
  await writeFile(path,JSON.stringify({theme:'dark',zoom:125,keyHints:false,editorFontSize:22,speakerFontSize:32,duration:45}));
  const store = new UiSettingsStore(path); await store.load();
  assert.equal(store.value.theme,'dark'); assert.equal(store.value.zoom,125); assert.equal(store.value.keyHints,false);
  for (const key of ['editorFontSize','speakerFontSize','duration']) assert.equal(Object.hasOwn(store.value,key),false);
});
