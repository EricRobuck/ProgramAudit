import { describe, expect, it } from 'vitest';
import { hasSubstantiveText, narrativePlainText, parseNarrative, sanitizeNarrative, wordCount } from '../src/lib/narrative.js';

describe('narrative sanitization and text rules', () => {
  it('strips scripts, attributes and disallowed tags but keeps formatting', () => {
    const html = sanitizeNarrative(
      '<p onclick="x()">Hello <b>bold</b> <i>it</i><script>alert(1)</script><img src=x onerror=y></p><a href="javascript:x">link</a><ul><li>one</li></ul>',
    );
    expect(html).toBe('<p>Hello <strong>bold</strong> <em>it</em></p>link<ul><li>one</li></ul>');
  });

  it('AT-08: blank, whitespace, markup-only and empty lists are not substantive', () => {
    for (const blank of ['', '   ', '<p></p>', '<p> </p><p>&nbsp;</p>', '<p><strong> </strong><br></p>', '<ul><li></li><li><p> </p></li></ul>', '<p>​</p>']) {
      expect(hasSubstantiveText(sanitizeNarrative(blank)), JSON.stringify(blank)).toBe(false);
    }
    expect(hasSubstantiveText('<p>x</p>')).toBe(true);
    expect(hasSubstantiveText('<ul><li>item</li></ul>')).toBe(true);
  });

  it('preserves paragraphs, lists and nesting in the block model', () => {
    const blocks = parseNarrative('<p>One <strong>two</strong></p><p>Three</p><ol><li><p>a</p><ul><li>b</li></ul></li><li>c</li></ol>');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'p', 'li', 'li', 'li']);
    expect(blocks[0].runs).toEqual([{ text: 'One ' }, { text: 'two', bold: true }]);
    expect(blocks[3]).toMatchObject({ type: 'li', ordered: false, level: 1 });
    expect(blocks[4]).toMatchObject({ type: 'li', ordered: true, level: 0, num: 2 });
    expect(narrativePlainText('<p>A</p><p>B</p>')).toBe('A\n\nB');
    expect(wordCount('<p>It’s a well-known fact.</p><ul><li>Two words</li></ul>')).toBe(6);
  });
});
