import * as cheerio from 'cheerio';
import { DomHandler, Parser, Tokenizer } from 'htmlparser2';

const VOID = new Set('area base basefont bgsound br col command embed frame hr img input keygen link meta param source track wbr'.split(' '));

// The original renderer uses BeautifulSoup's html.parser: it closes a tag
// when its end tag arrives, without HTML5 adoption or implied paragraph ends.
// Keep HTML tokenization (raw script/style text and entities), but use the
// parser's non-repairing stack. Browser repair happens only on the final HTML.
class HtmlTokens extends Tokenizer {
  constructor(options: ConstructorParameters<typeof Tokenizer>[0], callbacks: ConstructorParameters<typeof Tokenizer>[1]) {
    super({...options, xmlMode:false}, callbacks);
  }
}
class LegacyParser extends Parser {
  protected override isVoidElement(name:string):boolean { return VOID.has(name); }
}

export function legacyHtml(html:string) {
  const handler=new DomHandler();
  new LegacyParser(handler, {
    xmlMode:true, lowerCaseTags:true, lowerCaseAttributeNames:true,
    decodeEntities:true, Tokenizer:HtmlTokens,
  }).end(html);
  return cheerio.load(handler.root, {xml:{xmlMode:false}}, false);
}
