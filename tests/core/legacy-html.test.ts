import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyHtml } from '../../packages/core/src/legacy-html.js';

test('legacy parsing closes malformed formatting at its enclosing end tag',()=>{
 const $=legacyHtml('<div><p>before<div>inside</div>after</p><b>bold</div><p>plain</p>');
 assert.equal($('div').first().find('p > div').text(),'inside');
 assert.equal($('b').length,1);
 assert.equal($('b').text(),'bold');
 assert.equal($('p').last()[0]?.parent?.type,'root');
});

test('HTML tokenization keeps raw scripts, comments, void tags and decoded entities',()=>{
 const script='if (a < b) value = "<p>&amp;</p>";';
 const $=legacyHtml(`<SCRIPT>${script}</SCRIPT><!--keep--><DIV DATA-X="&quot;">A&nbsp;B<br>C<img src="x"><input disabled>D</DIV>`);
 assert.equal($('script').text(),script);
 assert.equal($('div').attr('data-x'),'"');
 assert.equal($('div').text(),'A\u00a0BCD');
 assert.equal($('div').children().length,3);
 assert.match($.html(),/<!--keep-->/);
});

test('template children stay nested until the browser parses the final document',()=>{
 const $=legacyHtml('<p><template><p>inside</p></template></p><svg viewBox="0 0 10 10"><text>字</text></svg>');
 assert.equal($('p').first().children().first()[0]?.tagName,'template');
 assert.equal($('template p').text(),'inside');
 assert.equal($('svg').attr('viewbox'),'0 0 10 10');
});
