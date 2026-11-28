import { posix } from 'node:path';
import { text } from 'node:stream/consumers';
import { load, type Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { openPromise, type Entry } from 'yauzl';

const local = (name: string) => name.split(':').at(-1);
function children(parent: Cheerio<Element>, tag: string) {
  return parent.children().filter((_, el) => local(el.name) === tag);
}
function relationId(element: Element | undefined) {
  return Object.entries(element?.attribs ?? {}).find(([name]) => name.endsWith(':id'))?.[1];
}

/** Sample the first slide in presentation order, or the first master of an empty template. */
export async function powerpointDesign(file: string) {
  const archive = await openPromise(file, {lazyEntries: true, autoClose: false});
  try {
    if (archive.entryCount > 50000) throw Error('too many entries');
    const entries = new Map<string, Entry>();
    for await (const entry of archive.eachEntry()) {
      if (/\.(?:xml|rels|png)$/iu.test(entry.fileName)) entries.set(entry.fileName, entry);
    }
    async function xml(path: string) {
      const entry = entries.get(path);
      if (!entry || entry.uncompressedSize > 4 * 1024 * 1024) throw Error('unavailable XML part');
      const content = await text(await archive.openReadStreamPromise(entry));
      return load(content, {xml: true}).root().children().first();
    }
    const relations = new Map<string, Cheerio<Element>>();
    async function relatedPart(part: string, type: string, id?: string) {
      let root = relations.get(part);
      if (!root) {
        const path = posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
        if (!entries.has(path)) return;
        root = await xml(path);
        relations.set(part, root);
      }
      const rel = children(root, 'Relationship').filter((_, el) =>
        el.attribs.Type?.endsWith('/' + type) === true && (!id || el.attribs.Id === id)
        && el.attribs.TargetMode !== 'External').first().attr('Target');
      if (rel) return rel.startsWith('/') ? rel.slice(1) : posix.join(posix.dirname(part), rel);
    }
    async function target(part: string, type: string, id?: string) {
      const path = await relatedPart(part, type, id);
      if (!path) throw Error('missing relationship');
      return path;
    }
    const presentation = 'ppt/presentation.xml';
    const doc = await xml(presentation);
    const firstSlide = relationId(children(children(doc, 'sldIdLst'), 'sldId').get(0));
    let slide: string | undefined, layout: string | undefined, master: string;
    if (firstSlide) {
      slide = await target(presentation, 'slide', firstSlide);
      layout = await target(slide, 'slideLayout');
      master = await target(layout, 'slideMaster');
    } else {
      master = await target(presentation, 'slideMaster', relationId(children(children(doc, 'sldMasterIdLst'), 'sldMasterId').get(0)));
    }
    const theme = await target(master, 'theme');
    const elements = children(await xml(theme), 'themeElements');
    const colors: Record<string,string> = {};
    for (const slot of children(elements, 'clrScheme').children().toArray()) {
      const child = slot.children.find(el => el.type === 'tag');
      if (child?.type !== 'tag') continue;
      const value = local(child.name) === 'sysClr' ? child.attribs.lastClr : child.attribs.val;
      if (value && /^[0-9a-f]{6}$/iu.test(value)) colors[local(slot.name)!] = '#' + value;
    }
    const fonts = children(elements, 'fontScheme');
    function typefaces(role: string) {
      const font = children(fonts, role);
      const japanese = children(font, 'ea').attr('typeface') ||
        children(font, 'font').filter((_, el) => el.attribs.script === 'Jpan').attr('typeface');
      return {latin: children(font, 'latin').attr('typeface'), japanese};
    }
    const masterXml = await xml(master);
    const titleStyle = children(children(masterXml, 'txStyles'), 'titleStyle');
    const masterTitleAlignment = children(titleStyle, 'lvl1pPr').attr('algn');
    let background;
    for (const part of [slide, layout, master]) {
      if (!part) continue;
      const bg = children(children(part === master ? masterXml : await xml(part), 'cSld'), 'bg');
      if (!bg.length) continue;
      const fill = children(children(bg, 'bgPr'), 'solidFill').children().get(0);
      if (fill && !fill.children.some(node => node.type === 'tag')) {
        background = {part, type: local(fill.name), value: fill.attribs.lastClr ?? fill.attribs.val};
      }
      break;
    }
    // Keep image bytes out of chat. The theme author can copy the selected PNG straight
    // from its ZIP entry into the CSS. Record the owning part because rIds are local.
    const decorations: Array<Record<string,string | undefined>> = [];
    const inspected = new Set<string>();
    async function inspectShapes(part: string, root: Cheerio<Element>) {
      if (inspected.has(part)) return;
      inspected.add(part);
      const shapes = children(children(root, 'cSld'), 'spTree').children();
      for (let i = 0; i < shapes.length && decorations.length < 100; i++) {
        const shape = shapes.eq(i), kind = local(shape.get(0)!.name);
        if (!['pic', 'sp', 'cxnSp'].includes(kind!)) continue;
        const props = children(shape, 'spPr'), xfrm = children(props, 'xfrm');
        const offset = children(xfrm, 'off'), extent = children(xfrm, 'ext');
        const nv = shape.children().first(), name = children(nv, 'cNvPr').attr('name');
        const placeholder = children(children(nv, 'nvPr'), 'ph');
        let image;
        if (kind === 'pic') {
          const blip = children(children(shape, 'blipFill'), 'blip').get(0);
          const embed = Object.entries(blip?.attribs ?? {}).find(([key]) => key.endsWith(':embed'))?.[1];
          const path = embed && await relatedPart(part, 'image', embed);
          if (!path || !/\.png$/iu.test(path) || !entries.has(path)) continue;
          image = path;
        } else if (placeholder.length && !children(props, 'solidFill').length && !children(props, 'ln').length) continue;
        const fill = children(props, 'solidFill').children().first();
        const line = children(props, 'ln'), stroke = children(line, 'solidFill').children().first();
        decorations.push({part, name, kind, image, placeholder: placeholder.attr('type'), geometry: children(props, 'prstGeom').attr('prst'),
          x: offset.attr('x'), y: offset.attr('y'), cx: extent.attr('cx'), cy: extent.attr('cy'),
          fill: fill.attr('val'), stroke: stroke.attr('val'), lineWidth: line.attr('w')});
      }
    }
    const samples = [];
    const ids = children(children(doc, 'sldIdLst'), 'sldId').slice(0, 3).toArray();
    if (!ids.length) await inspectShapes(master, masterXml);
    for (const id of ids) {
      const page = await target(presentation, 'slide', relationId(id));
      const template = await target(page, 'slideLayout');
      const pageXml = await xml(page), templateXml = await xml(template);
      const showMaster = (node: Cheerio<Element>) => !['false', '0'].includes(node.attr('showMasterSp') ?? '');
      const source = await target(template, 'slideMaster');
      const showMasterShapes = showMaster(pageXml) && showMaster(templateXml);
      samples.push({slide: page, layout: template, master: source, showMasterShapes});
      if (showMasterShapes) await inspectShapes(source, source === master ? masterXml : await xml(source));
      await inspectShapes(template, templateXml);
      await inspectShapes(page, pageXml);
    }
    const size = children(doc, 'sldSz');
    return {slideSize: {cx: size.attr('cx'), cy: size.attr('cy')}, samples, decorations,
      slide, layout, master, theme, colors, background, masterTitleAlignment, heading: typefaces('majorFont'), body: typefaces('minorFont')};
  } finally { archive.close(); }
}
