import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { atomicWriteFile } from '../../packages/renderer/src/output.js';
import { resolveExistingInside } from '../../packages/core/src/paths.js';
import { sha256 } from '../../packages/core/src/source.js';
import { Workspace, check_name, set_front, TEMPLATES } from '../../packages/core/src/legacy-workspace.js';
import { parse, ATTR_TOKEN } from '../../packages/core/src/legacy-source.js';
import { FONTS, read_vars, set_vars, restore } from '../../packages/core/src/legacy-theme-edit.js';
import type { LegacyFeatureRequest, LegacyFeatureResponse } from '../../packages/contracts/src/legacy.js';

function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}`;
  return JSON.stringify(value);
}

const decode = (bytes: Buffer) => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
export function reset_cover_positions(text: string): string {
  const doc = parse(text), points = Array.from(text), edits: Array<[number, number, string]> = [];
  for (const page of doc.pages) {
    if (!page.attrs.classes.includes('cover')) continue;
    for (const chunk of page.walk()) {
      if (!chunk.open || !chunk.attrs || !chunk.attrs.classes.some(k => k === 'cover-title' || k === 'cover-subtitle')) continue;
      const [a,b] = chunk.open;
      const opening = points.slice(a,b).join('').replace(new RegExp(ATTR_TOKEN.source, ATTR_TOKEN.flags), (...args: unknown[]) => {
        const [all,,,key,double,single,bare] = args as string[];
        if (key !== 'style') return all!;
        const parts = (double ?? single ?? bare ?? '').split(';');
        const kept = parts.filter(p => !['left','top','right','bottom','position','transform','translate'].includes(p.split(':',1)[0]!.trim().toLowerCase()));
        if (kept.length === parts.length) return all!;
        return kept.some(p => p.trim()) ? `style="${kept.join(';')}"` : '';
      });
      edits.push([a,b,opening]);
    }
  }
  const layout = doc.meta['cover-authors-layout'];
  if (layout && typeof layout === 'object' && !Array.isArray(layout) && ('x' in layout || 'y' in layout)) {
    const head = points.slice(0,doc.front[1]).join('');
    const match = /^cover-authors-layout[^\n]*\n(?:[ \t]+[^\n]*\n)*/mu.exec(head);
    if (match) {
      const start = Array.from(head.slice(0,match.index)).length;
      const remaining = Object.fromEntries(Object.entries(layout).filter(([key]) => key !== 'x' && key !== 'y'));
      const json = pythonJson(remaining);
      edits.push([start,start+Array.from(match[0]).length,`cover-authors-layout: ${json}\n`]);
    }
  }
  for (const [a,b,value] of edits.sort((a,b)=>b[0]-a[0])) points.splice(a,b-a,...Array.from(value));
  return points.join('');
}

export class LegacyThemes {
  #restores = new Map<string,string>();
  #locks = new Map<string,Promise<LegacyFeatureResponse>>();
  constructor(private readonly options: {
    contentOrigin: () => string;
    changed?: (ws: Workspace, name: string) => void;
    locked?: (ws: Workspace, name: string) => boolean;
  }) {}
  #css(ws: Workspace, name: string): string {
    const path = resolveExistingInside(ws.root, join(ws.themes,`${check_name(name,'テーマ')}.css`),'テーマ');
    return decode(readFileSync(path));
  }
  #shots(ws: Workspace, name: string, css: string): string[] {
    try {
      const stamp = sha256(css + readFileSync(join(TEMPLATES,'theme-sample.qmd'),'utf8'));
      const dir = join(ws.state,'themes',name);
      const index = JSON.parse(readFileSync(resolveExistingInside(ws.root,join(dir,'index.json'),'テーマ画像'),'utf8'));
      if (index.hash !== stamp || ![0,1,2,3].every(i=>existsSync(join(dir,`${i}.png`)))) return [];
      return [0,1,2,3].map(i=>`${this.options.contentOrigin()}/theme-shots/${encodeURIComponent(name)}/${i}.png?v=${stamp}`);
    } catch { return []; }
  }
  detail(ws: Workspace, name: string): Record<string,unknown> {
    const css = this.#css(ws,name), original = ws.theme_default(name);
    const decks = ws.list_decks().filter(deck=>ws.deck_theme(deck)===name);
    return { name, vars: read_vars(css), version: sha256(css), modified: original===null?null:css!==original,
      removable: name!=='default'&&!decks.length, shots:this.#shots(ws,name,css),locked:!!this.options.locked?.(ws,name),decks };
  }
  handle(ws: Workspace, request: LegacyFeatureRequest): Promise<LegacyFeatureResponse|null> {
    if (!/^\/api\/themes(?:\/[^/]+)?$/u.test(request.pathname)) return Promise.resolve(null);
    // Serializing theme mutations also makes base checks atomic across resets and creates.
    const key=ws.root;
    const result=(this.#locks.get(key)??Promise.resolve({})).catch(()=>({})).then(()=>this.#handle(ws,request));
    this.#locks.set(key,result);
    void result.finally(()=>{if(this.#locks.get(key)===result)this.#locks.delete(key)}).catch(()=>{});
    return result;
  }
  async #handle(ws: Workspace, request: LegacyFeatureRequest): Promise<LegacyFeatureResponse> {
    const body = request.body && typeof request.body==='object' && !Array.isArray(request.body) ? request.body as Record<string,unknown> : {};
    const method=request.method==='HEAD'?'GET':request.method;
    const conflict=()=>({status:409,body:{error:'テーマが外で変更されました'}});
    try {
      if(request.pathname==='/api/themes/select') {
        if(method!=='POST')return {status:405,body:{error:'method not allowed'}};
        const name=check_name(body.theme,'テーマ');
        if(!ws.themes_list().includes(name))throw new Error('テーマがありません');
        if(typeof body.text!=='string')throw new Error('原稿がありません');
        const recent=ws.prefs().recent_themes;
        ws.set_prefs({recent_themes:[name,...(Array.isArray(recent)?recent.filter(n=>n!==name):[])].slice(0,30)});
        const text=(parse(body.text).meta.theme||'default')!==name?reset_cover_positions(body.text):body.text;
        return {body:{text:set_front(text,{theme:name})}};
      }
      if(request.pathname==='/api/themes') {
        if(method==='GET')return {body:{themes:ws.themes_list().map(name=>this.detail(ws,name)),fonts:FONTS,recent:ws.prefs().recent_themes??[]}};
        if(method!=='POST')return {status:405,body:{error:'method not allowed'}};
        const name=check_name(body.name??'','テーマ'), origin=check_name(body.from??'','テーマ');
        const css=this.#css(ws,origin);
        if(body.base!==sha256(css))return conflict();
        if(existsSync(join(ws.themes,`${name}.css`)))return {status:409,body:{error:'同じ名前のテーマがあります'}};
        ws.register_theme(name,css);this.options.changed?.(ws,name);
        return {status:201,body:this.detail(ws,name)};
      }
      const name=check_name(decodeURIComponent(request.pathname.slice('/api/themes/'.length)),'テーマ');
      if(method==='GET')return {body:this.detail(ws,name)};
      if(method!=='DELETE'&&method!=='PUT')return {status:405,body:{error:'method not allowed'}};
      if(this.options.locked?.(ws,name))return {status:423,body:{error:method==='DELETE'?'AI の実行中は削除できません':'AI の実行中は編集できません'}};
      if(method==='DELETE') {const trash=ws.remove_theme(name);this.options.changed?.(ws,name);return {body:{trash:relative(ws.root,trash).replaceAll('\\','/')}};}
      const path=join(ws.themes,`${name}.css`),css=this.#css(ws,name),original=ws.theme_default(name);
      if(body.base!==sha256(css))return conflict();
      const restoreKey=`${ws.root}\0${name}`;
      let updated:string;
      if(body.reset) {if(original===null)throw new Error('このテーマにはデフォルトがありません');updated=original;}
      else if(Object.hasOwn(body,'css')) updated=typeof body.css==='string'&&(body.css===original||(css===original&&body.css===this.#restores.get(restoreKey)))?body.css:restore(css,body.css);
      else updated=set_vars(css,body.vars);
      if(body.reset) {
        if(Object.hasOwn(body,'save_as')) {const saved=check_name(body.save_as,'テーマ');if(existsSync(join(ws.themes,`${saved}.css`)))return {status:409,body:{error:'同じ名前のテーマがあります'}};ws.register_theme(saved,css);}
        this.#restores.set(restoreKey,css);
      }
      if(lstatSync(path).isSymbolicLink())throw new Error('テーマのリンクは編集できません');
      await atomicWriteFile(path,updated);
      this.options.changed?.(ws,name);
      return {body:{...this.detail(ws,name),before:css,css:updated}};
    }catch(error){const missing=error instanceof Error&&'code' in error&&['ENOENT','NOT_FOUND'].includes(String(error.code));return {status:missing?404:400,body:{error:missing?'テーマがありません':error instanceof Error?error.message:String(error)}};}
  }
}
